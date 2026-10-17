"""The markets model: indices, commodities, currency pairs and cryptocurrencies.

These instruments have no peers to be ranked against, so the stock model's
cross-sectional ranking does not apply to them. Instead one pooled *trend
model* learns, across every instrument and year at once, how an instrument's
own recent behaviour (returns over many windows, volatility, trend and
oscillator readings, the state of the US market) relates to its
volatility-scaled return over the next day, week, month and quarter. That is
the time-series momentum effect documented for futures and currencies, plus
whatever else the data support, and no more.

Two honesty rules carry over from the stock model. The drift (what to expect
with no signal at all) is half the historical average return for equity
indices, as for stocks, and zero for everything else: there is no reliable
risk premium to assume for a currency pair, a barrel of oil or a coin.
Forecasts are calibrated on out-of-sample errors and the backtest is
walk-forward, with every training target fully known before the test period.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

import models
from features import CHART_ONLY, HORIZONS, MIN_DAILY_VOL, TARGET_CLIP, indicators

log = logging.getLogger("stocks.markets")

VERSION = 4
CLASSES = ("index", "commodity", "currency", "crypto")
CLASS_LABEL = {"index": "Index", "commodity": "Commodity", "currency": "Currency", "crypto": "Crypto"}
CLASS_PLURAL = {"index": "Indices", "commodity": "Commodities", "currency": "Currencies", "crypto": "Crypto"}
QUOTE_TYPE = {"index": "INDEX", "commodity": "FUTURE", "currency": "CURRENCY", "crypto": "CRYPTOCURRENCY"}
DRIFT_CLASSES = {"index"}      # only equity indices get a (halved) historical drift
# The ridge alone: boosted trees overfit this smaller, noisier, pooled data set
# (their out-of-sample signal is negative beyond a week; the ridge's is flat)
ENSEMBLE_WEIGHTS = {"gbm": 0.0, "ridge": 1.0}
TRAIN_STRIDE = {1: 1, 5: 2, 21: 3, 63: 5}
MIN_TRAIN_ROWS = 2000
# Volume-driven indicators stay out of the model: currency pairs report no volume
# and an index's volume is whatever Yahoo adds up that day. They are still
# computed, so the chart readings can use them where they exist.
VOLUME_FEATURES = {"vol_rel20", "vol_rel5_63", "dollar_vol", "obv_slope", "updown_vol"}
# Anything built from the open, high or low stays out too. Yahoo's daily bars for
# currency pairs and futures assemble those fields from a different window than
# the close: where the close sits in the day's range "predicts" the next day with
# a correlation of -0.7 for EUR/USD, which is a bookkeeping artefact, not a
# signal. Only closes are trusted; the chart readings still use the rest.
OHLC_FEATURES = {"intraday", "gap", "range_pct", "close_pos", "stoch_k", "atr_pct"}
# Exchanges that close before New York, so the US context must be lagged a day
EARLY_CLOSE = {"FTSEMIB.MI", "^GDAXI", "^STOXX50E", "^FTSE", "^FCHI", "^N225", "^HSI"}
# When an instrument's daily bar is final: time zone and closing minute of the day
SESSIONS = {
    "^GSPC": ("America/New_York", 16 * 60), "^NDX": ("America/New_York", 16 * 60), "^DJI": ("America/New_York", 16 * 60),
    "^RUT": ("America/New_York", 16 * 60), "FTSEMIB.MI": ("Europe/Rome", 17 * 60 + 35), "^GDAXI": ("Europe/Berlin", 17 * 60 + 35),
    "^STOXX50E": ("Europe/Berlin", 17 * 60 + 35), "^FTSE": ("Europe/London", 16 * 60 + 35), "^FCHI": ("Europe/Paris", 17 * 60 + 35),
    "^N225": ("Asia/Tokyo", 15 * 60 + 30), "^HSI": ("Asia/Hong_Kong", 16 * 60 + 10),
}
CLASS_SESSIONS = {"commodity": ("America/New_York", 17 * 60), "currency": ("UTC", 24 * 60), "crypto": ("UTC", 24 * 60),
                  "index": ("America/New_York", 16 * 60)}


def session_for(symbol: str, cls: str) -> tuple[str, int]:
    return SESSIONS.get(symbol) or CLASS_SESSIONS.get(cls) or CLASS_SESSIONS["index"]


def is_partial(symbol: str, cls: str, last_bar: pd.Timestamp, now_utc: datetime) -> bool:
    """Is the instrument's last daily bar still being traded?"""
    tz, close_min = session_for(symbol, cls)
    local = now_utc.astimezone(ZoneInfo(tz))
    if last_bar.date() != local.date():
        return False
    return local.hour * 60 + local.minute < close_min + 20


def normalise_prices(prices: dict[str, pd.DataFrame], classes: dict[str, str]) -> dict[str, pd.DataFrame]:
    """Put every instrument on a calendar the rest of the site can be compared with.

    * Currency pairs: Yahoo dates an FX bar by the London morning that *starts*
      it, so the bar labelled D closes around 00:00 UTC on D, before the US
      session of D. Left alone, the US context of D would sit inside the 1-day
      target (SPY's return on D correlates with the FX return labelled D+1 at
      +0.2 to +0.3, and with the one labelled D at zero). The bars are relabelled
      a day earlier, so the close of D-1 is the price at the end of D-1.
    * Crypto trades every day; only weekday bars are kept, so a "1 week" or
      "3 months" horizon spans the same calendar time as for everything else
      (the weekend's move is folded into Monday's bar).
    """
    out = {}
    for sym, df in prices.items():
        cls = classes.get(sym)
        if cls == "currency":
            df = df.copy()
            df.index = df.index - pd.Timedelta(days=1)
        elif cls == "crypto":
            df = df[df.index.dayofweek < 5].copy()
        out[sym] = df
    return out


# --- the panel ----------------------------------------------------------------

def build_market_panel(prices: dict[str, pd.DataFrame], context: pd.DataFrame, classes: dict[str, str],
                       partial: set[str] | None = None) -> tuple[pd.DataFrame, list[str]]:
    """One row per (symbol, date) with the instrument's own indicators, the US
    market context, the asset class and the targets. Returns (panel, features)."""
    partial = partial or set()
    frames = []
    for sym, df in prices.items():
        x = indicators(df).drop(columns=list(CHART_ONLY))
        x["symbol"] = sym
        x["close"] = df["close"]
        if sym in EARLY_CLOSE:
            ctx_sym = context.reindex(x.index, method="ffill").shift(1)
        else:
            ctx_sym = context.reindex(x.index, method="ffill")  # weekend crypto rows see Friday's US close
        joined = x.join(ctx_sym, how="left")
        mr = joined["_mkt_r"]
        joined["rs21"] = joined["ret21"] - joined["mkt_ret21"]
        joined["rs63"] = joined["ret63"] - joined["mkt_ret63"]
        joined["beta63"] = joined["ret1"].rolling(63).cov(mr) / mr.rolling(63).var().replace(0, np.nan)
        joined["corr63"] = joined["ret1"].rolling(63).corr(mr)
        cls = classes.get(sym, "index")
        for c in CLASSES:
            joined[f"is_{c}"] = 1.0 if cls == c else 0.0
        joined["_class"] = cls
        logc = np.log(df["close"])
        daily_vol = joined["ret1"].rolling(21).std().clip(lower=MIN_DAILY_VOL)
        due_dates = pd.Series(df.index, index=df.index)
        for hzn in HORIZONS:
            fwd = logc.shift(-hzn) - logc
            sigma = daily_vol * np.sqrt(hzn)
            joined[f"sigma_{hzn}"] = sigma
            joined[f"y_{hzn}"] = fwd
            joined[f"z_{hzn}"] = (fwd / sigma).clip(-TARGET_CLIP, TARGET_CLIP)
            joined[f"due_{hzn}"] = due_dates.shift(-hzn)  # the day this target becomes known
            if sym in partial:
                joined.iloc[-(hzn + 1):, joined.columns.get_indexer([f"y_{hzn}", f"z_{hzn}"])] = np.nan
        frames.append(joined)
    panel = pd.concat(frames)
    panel.index.name = "date"
    panel = panel.reset_index().set_index(["symbol", "date"]).sort_index()
    panel = panel.drop(columns=["_mkt_r"])
    skip = {"close", "_class"} | VOLUME_FEATURES | OHLC_FEATURES
    features = [c for c in panel.columns if c not in skip and not c.startswith(("y_", "z_", "sigma_", "due_"))]
    return panel.copy(), features


def _complete(panel: pd.DataFrame) -> pd.Series:
    return panel["ret252"].notna() & panel["sma200_gap"].notna()


def _drift_by_class(train: pd.DataFrame, hzn: int) -> dict[str, float]:
    out = {}
    for cls in CLASSES:
        if cls in DRIFT_CLASSES:
            y = train.loc[train["_class"] == cls, f"y_{hzn}"].dropna()
            out[cls] = models.DRIFT_SHRINK * float(y.mean()) if len(y) else 0.0
        else:
            out[cls] = 0.0
    return out


def _target(frame: pd.DataFrame, hzn: int, drift: dict[str, float]) -> np.ndarray:
    """Volatility-scaled return net of the class drift, winsorised for training."""
    d = frame["_class"].map(drift).to_numpy(dtype=float)
    z = frame[f"z_{hzn}"].to_numpy(dtype=float) - d / frame[f"sigma_{hzn}"].to_numpy(dtype=float)
    return np.clip(z, -TARGET_CLIP, TARGET_CLIP)


def _fit(train: pd.DataFrame, features: list[str], hzn: int, seed: int) -> dict:
    drift = _drift_by_class(train, hzn)
    X = train[features].to_numpy(dtype=np.float32)
    y = _target(train, hzn, drift)
    gbm = models.make_gbm(seed).fit(X, y)
    ridge = models.make_ridge().fit(X, y)
    return {"gbm": gbm, "ridge": ridge, "features": list(features), "drift": drift, "n_train": int(len(train))}


def _predict(learners: dict, rows: pd.DataFrame) -> dict[str, np.ndarray]:
    X = rows[learners["features"]].to_numpy(dtype=np.float32)
    g = learners["gbm"].predict(X).astype(np.float64)
    r = learners["ridge"].predict(X).astype(np.float64)
    return {"gbm": g, "ridge": r, "pred": ENSEMBLE_WEIGHTS["gbm"] * g + ENSEMBLE_WEIGHTS["ridge"] * r}


def _training_rows(panel: pd.DataFrame, hzn: int, before: pd.Timestamp, dates: np.ndarray, stride: int) -> pd.DataFrame:
    """Complete rows whose h-bar target is known before `before`, thinned to every stride-th date."""
    rows = panel[(panel[f"due_{hzn}"] < before) & panel[f"z_{hzn}"].notna() & _complete(panel)]
    if stride > 1:
        keep = set(dates[dates < before][::-1][::stride])
        rows = rows[rows.index.get_level_values("date").isin(keep)]
    return rows


def _dates(panel: pd.DataFrame) -> np.ndarray:
    """Dates with a handful of complete instruments (all of them, in a small test run)."""
    need = min(5, panel.index.get_level_values("symbol").nunique())
    counts = panel[_complete(panel)].groupby(level="date").size()
    return np.array(sorted(counts.index[counts >= need]))


def walk_forward(panel: pd.DataFrame, features: list[str], min_train_days: int = 1000, step: int = 150) -> pd.DataFrame:
    """Out-of-sample forecasts for every (date, instrument, horizon) the model never trained on."""
    dates = _dates(panel)
    starts = list(range(min_train_days, len(dates), step))
    idx_dates = panel.index.get_level_values("date")
    pieces = []
    t0 = time.time()
    for k, start in enumerate(starts):
        test_dates = dates[start:start + step]
        test_start = pd.Timestamp(test_dates[0])
        test = panel[idx_dates.isin(test_dates) & _complete(panel)]
        for hzn in HORIZONS:
            train = _training_rows(panel, hzn, test_start, dates, TRAIN_STRIDE[hzn])
            if len(train) < MIN_TRAIN_ROWS:
                continue
            learners = _fit(train, features, hzn, seed=k)
            p = _predict(learners, test)
            out = pd.DataFrame(index=test.index)
            out["pred_gbm"], out["pred_ridge"], out["pred"] = p["gbm"], p["ridge"], p["pred"]
            out["h"] = hzn
            out["class"] = test["_class"].to_numpy()
            out["drift"] = test["_class"].map(learners["drift"]).to_numpy(dtype=float)
            out["sigma"] = test[f"sigma_{hzn}"]
            out["z_true"] = test[f"z_{hzn}"]
            out["y_true"] = test[f"y_{hzn}"]
            out["zr_true"] = (out["z_true"] - out["drift"] / out["sigma"]).clip(-TARGET_CLIP, TARGET_CLIP)
            # Naive rules the model has to beat: 12-month trend, 1-month trend, 1-week reversal
            out["f_trend12"] = test["mom12_1"].to_numpy(dtype=np.float32)
            out["f_trend1"] = test["ret21"].to_numpy(dtype=np.float32)
            out["f_rev"] = (-test["ret5"]).to_numpy(dtype=np.float32)
            pieces.append(out.reset_index())
        log.info("markets fold %d/%d (%s → %s) done, %.0fs so far", k + 1, len(starts),
                 pd.Timestamp(test_dates[0]).date(), pd.Timestamp(test_dates[-1]).date(), time.time() - t0)
    if not pieces:
        raise RuntimeError("the markets backtest produced no folds: too little history")
    return pd.concat(pieces, ignore_index=True)


def calibrate(oos: pd.DataFrame) -> dict[int, dict]:
    """The stock calibration (one slope per horizon, from every instrument), plus the
    residual distribution of each asset class: a currency pair's bands and odds
    must come from currency pairs, not from a pool that includes Bitcoin."""
    cal = models.calibrate(oos)
    for hzn, c in cal.items():
        d = oos[(oos["h"] == hzn) & oos["zr_true"].notna()]
        total = d["drift"].to_numpy() / d["sigma"].to_numpy() + c["slope"] * d["pred"].to_numpy()
        resid = d["z_true"].to_numpy() - total
        by_class = {}
        for cls in CLASSES:
            mask = (d["class"] == cls).to_numpy()
            if mask.sum() < 500:
                continue
            by_class[cls] = {
                "resid_quantiles": {str(q): float(np.quantile(resid[mask], q)) for q in models.BAND_QUANTILES},
                "resid_grid": [float(v) for v in np.quantile(resid[mask], models.RESID_GRID)],
            }
        c["by_class"] = by_class
    return cal


def class_cal(cal_h: dict, cls: str) -> dict:
    """The residual distribution for an instrument of `cls`: its own class's, else the pooled one."""
    return (cal_h.get("by_class") or {}).get(cls) or cal_h


# --- evaluation ----------------------------------------------------------------

def _signal_t(d: pd.DataFrame, col: str, hzn: int) -> tuple[float, float]:
    """Mean and Newey-West t of the per-date average of standardised signal × outcome:
    positive and significant means the signal reliably points the right way."""
    s = d[col].to_numpy(dtype=float)
    sd = float(np.nanstd(s)) or 1.0
    prod = pd.Series(s / sd * d["zr_true"].to_numpy(dtype=float), index=d.index)
    daily = prod.groupby(d["date"]).mean().dropna()
    if len(daily) < 10:
        return float("nan"), float("nan")
    return float(daily.mean()), models.nw_t(daily.to_numpy(), lags=hzn)


def _hit(forecast: np.ndarray, outcome: np.ndarray) -> float:
    """Share of right calls; a forecast of exactly zero counts as "up", as the ledger grades it."""
    return float(np.mean((np.asarray(forecast, dtype=float) >= 0) == (np.asarray(outcome, dtype=float) >= 0)))


def evaluate(oos: pd.DataFrame, cal: dict[int, dict]) -> dict:
    report = {}
    for hzn in HORIZONS:
        if hzn not in cal:
            continue
        d = oos[(oos["h"] == hzn) & oos["zr_true"].notna()].copy()
        slope = cal[hzn]["slope"]
        d["total"] = d["drift"] / d["sigma"] + slope * d["pred"]
        y, zr, p, total = (d[c].to_numpy(dtype=float) for c in ("y_true", "zr_true", "pred", "total"))
        sig_mean, sig_t = _signal_t(d, "pred", hzn)
        baselines = {}
        for name in ("f_trend12", "f_trend1", "f_rev"):
            f = d[name].to_numpy(dtype=float)
            ok = np.isfinite(f)
            bm, bt = _signal_t(d[ok], name, hzn)
            baselines[name] = {"signal_hit_rate": _hit(f[ok], zr[ok]),
                               "ic_pooled": models._spearman(f[ok], zr[ok]), "signal_t": bt}
        by_class = {}
        for cls, g in d.groupby("class"):
            cm, ct = _signal_t(g, "pred", hzn)
            by_class[cls] = {
                "n": int(len(g)),
                "hit_rate": _hit(g["total"].to_numpy(), g["y_true"].to_numpy()),
                "up_rate": float(np.mean(g["y_true"] > 0)),
                "signal_hit_rate": _hit(g["pred"].to_numpy(), g["zr_true"].to_numpy()),
                "ic_pooled": models._spearman(g["pred"].to_numpy(), g["zr_true"].to_numpy()),
                "signal_t": ct,
            }
        d = d.sort_values("date")
        split = int(len(d) * 0.7)
        early, late = d.iloc[:split], d.iloc[split:]
        coverage80 = float("nan")
        if len(late) > 200:
            res_early = early["z_true"] - early["total"]
            q10, q90 = np.quantile(res_early, 0.1), np.quantile(res_early, 0.9)
            res_late = late["z_true"] - late["total"]
            coverage80 = float(np.mean((res_late >= q10) & (res_late <= q90)))
        d["decile"] = pd.qcut(d["pred"].rank(method="first"), 10, labels=False)
        dec = d.assign(pr=d["pred"] * slope * d["sigma"], re=d["zr_true"] * d["sigma"]).groupby("decile").agg(
            pred=("pr", "mean"), real=("re", "mean"), n=("y_true", "size"))
        d["year"] = pd.to_datetime(d["date"]).dt.year
        by_year = [{"year": int(yr), "n": int(len(g)),
                    "hit": _hit(g["total"].to_numpy(), g["y_true"].to_numpy()),
                    "signal_hit": _hit(g["pred"].to_numpy(), g["zr_true"].to_numpy()),
                    "ic": models._spearman(g["pred"].to_numpy(), g["zr_true"].to_numpy())}
                   for yr, g in d.groupby("year")]
        report[str(hzn)] = {
            "n": int(len(d)), "instruments": int(d["symbol"].nunique()),
            "from": str(pd.Timestamp(d["date"].min()).date()), "to": str(pd.Timestamp(d["date"].max()).date()),
            "hit_rate": _hit(total, y), "up_rate": float(np.mean(y > 0)),
            "signal_hit_rate": _hit(p, zr),
            "ic_pooled": models._spearman(p, zr), "ic_raw_pooled": models._spearman(total, y),
            "signal_mean": sig_mean, "signal_t": sig_t,
            "baselines": baselines, "by_class": by_class,
            "coverage80_out_of_time": coverage80, "calibration_slope": slope,
            "components": {name: {"ic_pooled": models._spearman(d[col].to_numpy(), zr), "signal_t": _signal_t(d, col, hzn)[1]}
                           for name, col in (("gbm", "pred_gbm"), ("ridge", "pred_ridge"), ("ensemble", "pred"))},
            "deciles": [{"pred": float(r.pred), "real": float(r.real), "n": int(r.n)} for r in dec.itertuples()],
            "by_year": by_year,
        }
    return report


# --- the live forecast -----------------------------------------------------------

def fit_final(panel: pd.DataFrame, features: list[str]) -> dict[int, dict]:
    final = {}
    dates = _dates(panel)
    horizon_end = pd.Timestamp.max
    for hzn in HORIZONS:
        train = _training_rows(panel, hzn, horizon_end, dates, TRAIN_STRIDE[hzn])
        learners = _fit(train, features, hzn, seed=hzn)
        learners["trained_through"] = str(pd.Timestamp(train.index.get_level_values("date").max()).date())
        final[hzn] = learners
    return final


def forecast_latest(panel: pd.DataFrame, features: list[str], final: dict[int, dict], cal: dict[int, dict]) -> pd.DataFrame:
    """Calibrated forecasts, bands and probabilities for every instrument's latest complete row."""
    latest = panel[_complete(panel)].groupby(level="symbol").tail(1)
    rows = []
    for hzn in HORIZONS:
        if hzn not in final or hzn not in cal:
            continue
        m, c = final[hzn], cal[hzn]
        p = _predict(m, latest)
        rel = p["pred"] * c["slope"]
        sigma = latest[f"sigma_{hzn}"].to_numpy(dtype=float)
        classes = latest["_class"].to_numpy()
        drift = latest["_class"].map(m["drift"]).to_numpy(dtype=float)
        total = drift / sigma + rel
        unit = max(c["pred_rel_scale"] * c["slope"], 1e-9)
        for i, (sym, date) in enumerate(latest.index):
            s = float(sigma[i])
            cc = class_cal(c, classes[i])
            q = cc["resid_quantiles"]
            p_up = models.prob_up(total[i:i + 1], cc)
            rows.append({
                "symbol": sym, "date": pd.Timestamp(date), "h": hzn,
                "z": float(total[i]), "z_rel": float(rel[i]), "z_rel_raw": float(p["pred"][i]),
                "drift": float(drift[i]), "sigma": s,
                "ret": float(np.expm1(total[i] * s)),
                "rel_ret": float("nan"),  # nothing to be relative to
                "p10": float(np.expm1((total[i] + q["0.1"]) * s)),
                "p25": float(np.expm1((total[i] + q["0.25"]) * s)),
                "p75": float(np.expm1((total[i] + q["0.75"]) * s)),
                "p90": float(np.expm1((total[i] + q["0.9"]) * s)),
                "p_up": float(np.clip(p_up[0], 0.02, 0.98)),
                "conviction": float(rel[i] / unit),
            })
    return pd.DataFrame(rows)
