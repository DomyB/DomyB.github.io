"""The forecasting model, its walk-forward backtest and its uncertainty bands.

What is predictable about stocks, and what isn't
------------------------------------------------
Nobody can reliably predict whether the market as a whole goes up or down
next month, and a model that pretends to just adds noise. What *is* mildly
predictable is which stocks will do better or worse than the others: the
well-documented momentum, short-term reversal and low-volatility effects.
So the forecast is built in two parts:

    forecast = market drift  +  relative forecast

* The **market drift** is the historical average (volatility-normalised)
  return in the training data, halved to stay conservative. It is the same
  for every stock on a given day.
* The **relative forecast** is learned. Two learners are trained on the whole
  panel of stocks at once, one per horizon: a gradient-boosted tree ensemble
  (non-linear, finds interactions such as "oversold *and* in an uptrend")
  and a ridge regression on standardised features (linear, stable). Their
  average is the raw forecast. Its target is the cross-sectional rank of the
  stock's volatility-normalised return after taking out its (shrunk) beta
  times the universe's move, so the model learns stock picking rather than a
  beta tilt. Stocks only enter the cross-section once they joined the S&P 500,
  which keeps survivorship bias out of the ranks.

The relative forecast is then *calibrated*: the backtest measures how much of
a predicted relative move actually materialises on average, and the forecast
is scaled by that factor, so the numbers shown are neither over- nor
under-confident. Uncertainty bands come from the backtest's own errors
(conformal prediction): an "80% band" really did contain about 80% of the
outcomes out of sample.

The backtest is strictly walk-forward: the model that predicts a period only
ever saw data that ended before that period began, with a gap of one horizon
so that no training target overlaps the test window.
"""
from __future__ import annotations

import logging
import time

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import HORIZONS

log = logging.getLogger("stocks.models")

ENSEMBLE_WEIGHTS = {"gbm": 0.5, "ridge": 0.5}
BAND_QUANTILES = (0.1, 0.25, 0.75, 0.9)
DRIFT_SHRINK = 0.5  # use half of the historical average return as the market drift
# Targets over h days overlap heavily from one day to the next, so training on
# every k-th day loses almost nothing and makes the backtest many times faster.
TRAIN_STRIDE = {1: 1, 5: 3, 21: 5, 63: 10}  # the 1-day model uses every day: it measurably helps
TARGET = "zrank"  # "zrank": the cross-sectional rank of the relative return (robust); "zr": the return itself

# Knobs the experiment harness (experiments.py) turns; the defaults are the production settings.
GBM_PARAMS = dict(loss="squared_error", learning_rate=0.03, max_iter=250, max_leaf_nodes=15,
                  min_samples_leaf=300, l2_regularization=3.0, max_features=0.6, early_stopping=False)
RIDGE_ALPHA = 50.0
N_SEEDS = 1                 # average this many boosted models with different seeds (bagging); may be a per-horizon dict
SEED_OFFSET = 0             # shifts every random seed (used to measure seed noise)
RIDGE_CS = False            # True: the ridge sees only cross-sectional rank features (rank-on-rank)
MIN_CROSS_SECTION = 30      # a date with fewer complete symbols (a US holiday) is neither trained on nor scored
TRAIN_WINDOW_DAYS = None    # None: expanding window; else only the last N trading days are used
RECENCY_HALFLIFE = None     # None: equal weights; else sample weights halve every N trading days
SMOOTH_DAYS = 1             # average each stock's raw forecast over its last N days (1: no smoothing); may be a per-horizon dict
# Mix the 1-week and 1-month forecasts with their neighbours' (standardised) forecasts:
# the signal is shared across horizons, the noise isn't. The 3-month horizon is left alone
# (blending it hurt in the first half of the backtest).
BLEND = {5: {1: 0.15, 5: 0.7, 21: 0.15}, 21: {5: 0.15, 21: 0.7, 63: 0.15}}


class QuantileClipper(BaseEstimator, TransformerMixin):
    """Clips every column to its training 1st–99th percentile (tames outliers for the ridge)."""

    def __init__(self, low=0.01, high=0.99):
        self.low, self.high = low, high

    def fit(self, X, y=None):
        X = np.asarray(X, dtype=float)
        self.lo_ = np.nanquantile(X, self.low, axis=0)
        self.hi_ = np.nanquantile(X, self.high, axis=0)
        return self

    def transform(self, X):
        return np.clip(np.asarray(X, dtype=float), self.lo_, self.hi_)


def make_gbm(seed: int = 0) -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(random_state=seed, **GBM_PARAMS)


def make_ridge():
    return make_pipeline(SimpleImputer(strategy="median"), QuantileClipper(), StandardScaler(), Ridge(alpha=RIDGE_ALPHA))


class SeedBag:
    """The average of several boosted models that differ only by random seed."""

    def __init__(self, models):
        self.models = models

    def predict(self, X):
        return np.mean([m.predict(X) for m in self.models], axis=0)


def _sample_weights(train: pd.DataFrame) -> np.ndarray | None:
    if not RECENCY_HALFLIFE:
        return None
    dates = train.index.get_level_values("date")
    age = (dates.max() - dates).days * (252 / 365.25)  # calendar days to trading days, roughly
    return np.power(0.5, age.to_numpy(dtype=float) / RECENCY_HALFLIFE)


def _complete(panel: pd.DataFrame) -> pd.Series:
    """Rows whose slow features exist (a year of history), so the model never trains on half-empty rows."""
    return panel["ret252"].notna() & panel["sma200_gap"].notna()


def _training_rows(panel: pd.DataFrame, hzn: int, before_pos: int, dates: np.ndarray, stride: int = 1) -> pd.DataFrame:
    """Complete rows whose h-day target is fully known before `dates[before_pos]`, every `stride`-th date."""
    cutoff_pos = min(before_pos - hzn - 1, len(dates) - 1)
    if cutoff_pos < 0:
        return panel.iloc[0:0]
    first_pos = max(0, cutoff_pos + 1 - TRAIN_WINDOW_DAYS) if TRAIN_WINDOW_DAYS else 0
    keep_dates = dates[first_pos:cutoff_pos + 1][::-1][::stride]  # count back from the cutoff so the newest data is always in
    idx = panel.index.get_level_values("date")
    rows = panel[idx.isin(keep_dates)]
    rows = rows[rows[f"{TARGET}_{hzn}"].notna() & _complete(rows)]
    return rows


def good_dates(panel: pd.DataFrame) -> np.ndarray:
    """Dates with a real cross-section (not a US holiday when only a handful of foreign listings trade)."""
    counts = panel[_complete(panel)].groupby(level="date").size()
    return np.array(sorted(counts.index[counts >= MIN_CROSS_SECTION]))


def _stride(panel: pd.DataFrame, hzn: int) -> int:
    """Thin out training dates only when the universe is big enough to afford it."""
    n_symbols = panel.index.get_level_values("symbol").nunique()
    return TRAIN_STRIDE[hzn] if n_symbols >= 100 else 1


def ridge_features(frame: pd.DataFrame, features: list[str]) -> list[str]:
    if RIDGE_CS:
        return [c for c in frame.columns if c.startswith(("rank_", "secrank_"))]
    return list(features)


def make_ridge_cs():
    """Rank-on-rank ridge: the inputs are already bounded percentiles, so no clipping or scaling."""
    return make_pipeline(SimpleImputer(strategy="constant", fill_value=0.0), Ridge(alpha=RIDGE_ALPHA))


def fit_learners(train: pd.DataFrame, features: list[str], hzn: int, seed: int = 0) -> dict:
    Xtr = train[features].to_numpy(dtype=np.float32)
    ytr = train[f"{TARGET}_{hzn}"].to_numpy(dtype=float)
    w = _sample_weights(train)
    n_seeds = N_SEEDS[hzn] if isinstance(N_SEEDS, dict) else N_SEEDS
    seed += SEED_OFFSET
    if w is None:
        gbms = [make_gbm(seed * 100 + k).fit(Xtr, ytr) for k in range(n_seeds)]
    else:
        # Boosted trees with sample weights re-bin every feature by weighted
        # percentiles, which is very slow in scikit-learn; a weighted subsample
        # (keep each row with probability = its weight) has the same expected
        # effect and is faster still.
        gbms = []
        for k in range(n_seeds):
            keep = np.random.default_rng(seed * 100 + k).random(len(w)) < w
            gbms.append(make_gbm(seed * 100 + k).fit(Xtr[keep], ytr[keep]))
    rf = ridge_features(train, features)
    ridge = make_ridge_cs() if RIDGE_CS else make_ridge()
    ridge.fit(train[rf].to_numpy(dtype=np.float32), ytr, **({"ridge__sample_weight": w} if w is not None else {}))
    y = train[f"y_{hzn}"].to_numpy(dtype=float)
    ok = np.isfinite(y)
    drift = float(np.average(y[ok], weights=None if w is None else w[ok])) if ok.any() else 0.0
    return {
        "gbm": gbms[0] if len(gbms) == 1 else SeedBag(gbms),
        "ridge": ridge, "ridge_features": rf, "features": list(features),
        # The market drift is a plain average return (not volatility-scaled: a
        # wilder stock doesn't earn more on average, it just moves more).
        "drift": DRIFT_SHRINK * drift,
        "n_train": int(len(train)),
    }


def predict_raw(learners: dict, rows: pd.DataFrame) -> dict[str, np.ndarray]:
    g = learners["gbm"].predict(rows[learners["features"]].to_numpy(dtype=np.float32)).astype(np.float64)
    r = learners["ridge"].predict(rows[learners["ridge_features"]].to_numpy(dtype=np.float32)).astype(np.float64)
    return {"gbm": g, "ridge": r, "pred": ENSEMBLE_WEIGHTS["gbm"] * g + ENSEMBLE_WEIGHTS["ridge"] * r}


def walk_forward(panel: pd.DataFrame, features: list[str], min_train_days: int = 1000, step: int = 126,
                 max_folds: int | None = None) -> pd.DataFrame:
    """Out-of-sample predictions for every (date, symbol, horizon) the model never trained on."""
    dates = good_dates(panel)
    starts = list(range(min_train_days, len(dates), step))
    if max_folds:
        starts = starts[-max_folds:]
    pieces = []
    t0 = time.time()
    idx_dates = panel.index.get_level_values("date")
    for k, start in enumerate(starts):
        test_dates = dates[start:start + step]
        test = panel[idx_dates.isin(test_dates) & _complete(panel)]
        fold_pieces = []
        for hzn in HORIZONS:
            train = _training_rows(panel, hzn, start, dates, _stride(panel, hzn))
            if len(train) < 2000:
                continue
            learners = fit_learners(train, features, hzn, seed=k)
            p = predict_raw(learners, test)
            out = pd.DataFrame(index=test.index)
            out["pred_gbm"], out["pred_ridge"], out["pred"] = p["gbm"], p["ridge"], p["pred"]
            # Naive rules, carried along so the report can show what they would score
            for name, col, sign in (("f_negvol", "vol21", -1), ("f_negsize", "dollar_vol", -1), ("f_mom", "mom12_1", 1), ("f_rev", "ret5", -1)):
                out[name] = (sign * test[col]).astype(np.float32)
            # The target is relative, so the forecasts must be too: remove each
            # day's average forecast (the model has no business taking a market view).
            for col in ("pred_gbm", "pred_ridge", "pred"):
                out[col] = out[col] - out.groupby(level="date")[col].transform("mean")
            k_smooth = SMOOTH_DAYS.get(hzn, 1) if isinstance(SMOOTH_DAYS, dict) else SMOOTH_DAYS
            if k_smooth > 1:
                # Average each stock's forecast over its last few days (all from this
                # fold's model): the signal persists, the day-to-day noise doesn't.
                out = out.sort_index()
                for col in ("pred_gbm", "pred_ridge", "pred"):
                    out[col] = out.groupby(level="symbol")[col].transform(
                        lambda v: v.rolling(k_smooth, min_periods=1).mean())
                    out[col] = out[col] - out.groupby(level="date")[col].transform("mean")
            out["h"] = hzn
            out["drift"] = learners["drift"]
            out["z_true"] = test[f"z_{hzn}"]
            out["zr_true"] = test[f"zr_{hzn}"]
            out["y_true"] = test[f"y_{hzn}"]
            out["sigma"] = test[f"sigma_{hzn}"]
            fold_pieces.append(out.reset_index())
        if not fold_pieces:
            continue
        if BLEND and len(fold_pieces) > 1:
            fold_pieces = [blend_horizons(pd.concat(fold_pieces, ignore_index=True))]
        pieces.extend(fold_pieces)
        log.info("fold %d/%d (%s → %s) done, %.0fs so far", k + 1, len(starts),
                 pd.Timestamp(test_dates[0]).date(), pd.Timestamp(test_dates[-1]).date(), time.time() - t0)
    if not pieces:
        raise RuntimeError("the walk-forward backtest produced no folds: too little history or too few symbols "
                           f"per date (need {MIN_CROSS_SECTION} complete symbols on at least {min_train_days} dates)")
    return pd.concat(pieces, ignore_index=True)


def blend_horizons(oos: pd.DataFrame) -> pd.DataFrame:
    """Mix each horizon's forecast with its neighbours' (per-date standardised), per BLEND."""
    oos = oos.copy()
    scale = oos.groupby(["date", "h"])["pred"].transform("std").replace(0, np.nan)
    z = oos["pred"] / scale
    wide = pd.DataFrame({"z": z.to_numpy(), "date": oos["date"].to_numpy(), "symbol": oos["symbol"].to_numpy(),
                         "h": oos["h"].to_numpy()}).pivot_table(index=["date", "symbol"], columns="h", values="z")
    for hzn, weights in BLEND.items():
        cols = [c for c in weights if c in wide.columns]
        if not cols:
            continue
        w = np.array([weights[c] for c in cols], dtype=float)
        vals = wide[cols].to_numpy()
        ok = np.isfinite(vals)
        den = (ok * w).sum(axis=1)
        mixed = pd.Series(np.where(den > 0, np.nansum(vals * w, axis=1) / np.where(den > 0, den, 1), np.nan), index=wide.index)
        m = oos["h"] == hzn
        key = pd.MultiIndex.from_arrays([oos.loc[m, "date"], oos.loc[m, "symbol"]])
        # Back to this horizon's own scale, so the calibration fitted on it applies live too
        new = mixed.reindex(key).to_numpy() * scale[m].to_numpy()
        old_vals = oos.loc[m, "pred"].to_numpy()
        oos.loc[m, "pred"] = np.where(np.isfinite(new), new, old_vals)
    oos["pred"] = oos["pred"] - oos.groupby(["date", "h"])["pred"].transform("mean")
    return oos


def _spearman(a, b) -> float:
    if len(a) < 10:
        return float("nan")
    r = spearmanr(a, b).correlation
    return float(r) if np.isfinite(r) else float("nan")


def nw_t(x: np.ndarray, lags: int) -> float:
    """t-statistic of the mean of a serially correlated series (Newey-West, Bartlett weights)."""
    x = np.asarray(x, dtype=float)
    x = x[np.isfinite(x)]
    n = len(x)
    if n < 10:
        return float("nan")
    e = x - x.mean()
    var = float(np.dot(e, e)) / n
    for lag in range(1, min(lags, n - 1) + 1):
        w = 1.0 - lag / (lags + 1.0)
        var += 2.0 * w * float(np.dot(e[lag:], e[:-lag])) / n
    return float(x.mean() / np.sqrt(max(var, 1e-18) / n))


def _group_spearman(frame: pd.DataFrame, keys: list[str], a: str, b: str, min_n: int) -> pd.Series:
    """Spearman correlation of a and b within each group, vectorised (ranks, then Pearson from group sums)."""
    frame = frame[frame[a].notna() & frame[b].notna()]
    g = frame.groupby(keys, sort=True)
    ra = g[a].rank().to_numpy()
    rb = g[b].rank().to_numpy()
    tmp = pd.DataFrame({"x": ra, "y": rb, "xy": ra * rb, "xx": ra * ra, "yy": rb * rb, "n": 1.0},
                       index=frame.index)
    for k in keys:
        tmp[k] = frame[k].to_numpy()
    agg = tmp.groupby(keys, sort=True).sum()
    n = agg["n"]
    cov = agg["xy"] / n - (agg["x"] / n) * (agg["y"] / n)
    vx = agg["xx"] / n - (agg["x"] / n) ** 2
    vy = agg["yy"] / n - (agg["y"] / n) ** 2
    r = cov / np.sqrt((vx * vy).clip(lower=1e-18))
    return r.where(n >= min_n)


def daily_series(oos: pd.DataFrame, col: str = "pred") -> pd.DataFrame:
    """Per-date cross-sectional skill of `col`, per horizon: Spearman IC against the
    relative outcome (ic), against the raw forward return (ic_raw) and the
    top-minus-bottom quintile spread in return units (ls). Vectorised."""
    d = oos[oos["zr_true"].notna() & oos[col].notna()][["date", "h", col, "zr_true", "y_true"]]
    keys = ["h", "date"]
    ic = _group_spearman(d, keys, col, "zr_true", MIN_CROSS_SECTION)
    ic_raw = _group_spearman(d, keys, col, "y_true", MIN_CROSS_SECTION)
    q = d.groupby(keys)[col].rank(pct=True)
    top = d.assign(v=d["y_true"].where(q >= 0.8)).groupby(keys)["v"].mean()
    bot = d.assign(v=d["y_true"].where(q <= 0.2)).groupby(keys)["v"].mean()
    out = pd.DataFrame({"ic": ic, "ic_raw": ic_raw, "ls": top - bot}).reset_index()
    out["h"] = out["h"].astype(int)
    return out.dropna(subset=["ic"])[["date", "h", "ic", "ic_raw", "ls"]]


def calibrate(oos: pd.DataFrame) -> dict[int, dict]:
    """Per-horizon calibration slope and residual distribution, from out-of-sample rows only."""
    cal = {}
    for hzn in HORIZONS:
        d = oos[(oos["h"] == hzn) & oos["zr_true"].notna()]
        if len(d) < 500:
            continue
        p, zr = d["pred"].to_numpy(), d["zr_true"].to_numpy()
        # How much of a predicted relative move comes true, on average (slope through the origin)
        slope = float(np.clip(np.dot(p, zr) / max(np.dot(p, p), 1e-12), 0.0, 5.0))
        total = d["drift"].to_numpy() / d["sigma"].to_numpy() + slope * p
        resid = d["z_true"].to_numpy() - total
        cal[hzn] = {
            "slope": slope,
            "resid_quantiles": {str(q): float(np.quantile(resid, q)) for q in BAND_QUANTILES},
            # The residual distribution as 199 quantiles: enough to turn a forecast into a probability
            "resid_grid": [float(v) for v in np.quantile(resid, RESID_GRID)],
            "pred_rel_scale": float(np.std(p)),
        }
    return cal


RESID_GRID = np.round(np.arange(0.005, 0.9951, 0.005), 3)


def prob_up(total_z: np.ndarray, cal: dict) -> np.ndarray:
    """P(return > 0) = P(residual > -forecast) under the out-of-sample residual distribution."""
    grid = np.asarray(cal["resid_grid"], dtype=float)
    cdf_at = np.interp(-np.asarray(total_z, dtype=float), grid, RESID_GRID, left=0.0, right=1.0)
    return np.clip(1.0 - cdf_at, 0.02, 0.98)


def evaluate(oos: pd.DataFrame, cal: dict[int, dict]) -> dict:
    """Honest backtest metrics per horizon, each next to the naive baseline it has to beat."""
    report = {}
    for hzn in HORIZONS:
        if hzn not in cal:
            continue
        d = oos[(oos["h"] == hzn) & oos["zr_true"].notna()].copy()
        d = d[d.groupby("date")["pred"].transform("size") >= MIN_CROSS_SECTION]
        slope = cal[hzn]["slope"]
        d["rel_cal"] = d["pred"] * slope
        d["total"] = d["drift"] / d["sigma"] + d["rel_cal"]
        d["ret_pred"] = d["total"] * d["sigma"]
        y, z, zr, p = (d[c].to_numpy() for c in ("y_true", "z_true", "zr_true", "pred"))
        total = d["total"].to_numpy()

        # 1. Relative direction: does the stock beat the average tracked stock? Baseline: a coin flip.
        rel_hit = float(np.mean(np.sign(p) == np.sign(zr)))
        conf = (d["pred"].abs().groupby(d["date"]).rank(pct=True) >= 0.7).to_numpy()  # top 30% within each day
        rel_hit_conf = float(np.mean(np.sign(p[conf]) == np.sign(zr[conf])))

        # 2. Absolute direction: does the price go up? Baseline: always saying "up".
        hit = float(np.mean(np.sign(total) == np.sign(y)))
        up_rate = float(np.mean(y > 0))

        # 3. Rank skill: Spearman correlation between forecast and outcome within each day
        series = daily_series(d)
        series = series[series["h"] == hzn]
        daily = series.set_index("date")["ic"]
        ic_raw = float(series["ic_raw"].mean()) if len(series) else float("nan")
        baselines = {}
        for name in ("f_negvol", "f_negsize", "f_mom", "f_rev"):
            if name in d.columns and d[name].notna().any():
                feat = d[name].fillna(d[name].median())
                feat = feat - feat.groupby(d["date"]).transform("mean")  # a relative rule, like the forecast
                bs = daily_series(d.assign(**{name: feat}), col=name)
                baselines[name] = {"ic": float(bs["ic"].mean()), "ic_raw": float(bs["ic_raw"].mean()),
                                   "rel_hit_rate": float(np.mean(np.sign(feat.to_numpy()) == np.sign(zr)))}
        ic_mean = float(daily.mean()) if len(daily) else float("nan")
        ic_t = float(daily.mean() / daily.std() * np.sqrt(len(daily) / hzn)) if len(daily) > 2 and daily.std() > 0 else float("nan")
        ic_t_nw = nw_t(daily.to_numpy(), lags=max(hzn - 1, 0))
        ic_pos_share = float(np.mean(daily > 0)) if len(daily) else float("nan")

        # 4. Long–short: the fifth of stocks the model likes most minus the fifth it likes least, per period
        ls = series.set_index("date")["ls"].dropna()
        ls_mean = float(ls.mean()) if len(ls) else float("nan")
        ls_t = float(ls.mean() / ls.std() * np.sqrt(len(ls) / hzn)) if len(ls) > 2 and ls.std() > 0 else float("nan")
        ls_annual = float(np.expm1(ls_mean * 252 / hzn)) if np.isfinite(ls_mean) else float("nan")

        # 4b. Each learner on its own, so the ensemble can be judged against its parts
        components = {
            name: {"rel_hit_rate": float(np.mean(np.sign(d[col].to_numpy()) == np.sign(zr))),
                   "ic_daily_mean": float(_group_spearman(d, ["date"], col, "zr_true", MIN_CROSS_SECTION).mean())}
            for name, col in (("gbm", "pred_gbm"), ("ridge", "pred_ridge"), ("ensemble", "pred"))
        }

        # 5. Size of the error against naive forecasts (in return units)
        mae_model = float(np.mean(np.abs(y - d["ret_pred"].to_numpy())))
        mae_zero = float(np.mean(np.abs(y)))
        mae_drift = float(np.mean(np.abs(y - d["drift"].to_numpy())))

        # 6. Bands, checked out of time: quantiles from the first 70% of the test
        #    period, coverage measured on the last 30%
        d = d.sort_values("date")
        split = int(len(d) * 0.7)
        early, late = d.iloc[:split], d.iloc[split:]
        coverage80 = float("nan")
        if len(late) > 200:
            res_early = early["z_true"] - early["total"]
            q10, q90 = np.quantile(res_early, 0.1), np.quantile(res_early, 0.9)
            res_late = late["z_true"] - late["total"]
            coverage80 = float(np.mean((res_late >= q10) & (res_late <= q90)))

        # 7. Calibration by decile of the relative forecast: predicted vs realised relative return
        d["decile"] = pd.qcut(d["pred"].rank(method="first"), 10, labels=False)
        d["rel_ret_pred"] = d["rel_cal"] * d["sigma"]
        d["rel_ret_real"] = d["zr_true"] * d["sigma"]
        dec = d.groupby("decile").agg(pred=("rel_ret_pred", "mean"), real=("rel_ret_real", "mean"), n=("y_true", "size"))
        deciles = [{"pred": float(r.pred), "real": float(r.real), "n": int(r.n)} for r in dec.itertuples()]

        # 8. Year by year, so one lucky year can't hide a bad model
        d["year"] = pd.to_datetime(d["date"]).dt.year
        syear = series.assign(year=pd.to_datetime(series["date"]).dt.year).groupby("year")[["ic", "ls"]].mean()
        by_year = []
        for yr, g in d.groupby("year"):
            by_year.append({
                "year": int(yr), "n": int(len(g)),
                "rel_hit": float(np.mean(np.sign(g["pred"]) == np.sign(g["zr_true"]))),
                "hit": float(np.mean(np.sign(g["total"]) == np.sign(g["y_true"]))),
                "up_rate": float(np.mean(g["y_true"] > 0)),
                "ic": float(syear.loc[yr, "ic"]) if yr in syear.index else float("nan"),
                "long_short": float(syear.loc[yr, "ls"]) if yr in syear.index else float("nan"),
            })

        report[str(hzn)] = {
            "n": int(len(d)), "days": int(len(daily)),
            "from": str(pd.Timestamp(d["date"].min()).date()),
            "to": str(pd.Timestamp(d["date"].max()).date()),
            "rel_hit_rate": rel_hit, "rel_hit_rate_confident": rel_hit_conf,
            "hit_rate": hit, "up_rate": up_rate,
            "ic_daily_mean": ic_mean, "ic_daily_t": ic_t, "ic_daily_t_nw": ic_t_nw, "ic_positive_share": ic_pos_share,
            "ic_raw_daily_mean": ic_raw, "baselines": baselines,
            "long_short_spread": ls_mean, "long_short_t": ls_t, "long_short_annualised": ls_annual,
            "mae_model": mae_model, "mae_zero": mae_zero, "mae_drift": mae_drift,
            "coverage80_out_of_time": coverage80,
            "calibration_slope": slope,
            "deciles": deciles,
            "by_year": by_year,
            "components": components,
        }
    return report


def fit_final(panel: pd.DataFrame, features: list[str]) -> dict[int, dict]:
    """Fit both learners per horizon on every complete row, for today's forecast."""
    final = {}
    dates = good_dates(panel)
    for hzn in HORIZONS:
        train = _training_rows(panel, hzn, len(dates) + hzn + 1, dates, _stride(panel, hzn))
        learners = fit_learners(train, features, hzn, seed=hzn)
        learners["trained_through"] = str(pd.Timestamp(train.index.get_level_values("date").max()).date())
        final[hzn] = learners
    return final


def forecast_latest(panel: pd.DataFrame, features: list[str], final: dict[int, dict], cal: dict[int, dict],
                    symbols: list[str]) -> pd.DataFrame:
    """Calibrated forecasts, bands and probabilities for the latest row of the given symbols."""
    max_k = max(SMOOTH_DAYS.values()) if isinstance(SMOOTH_DAYS, dict) else SMOOTH_DAYS
    recent = panel.groupby(level="symbol").tail(max_k)
    recent = recent[_complete(recent)]
    everyone = recent.groupby(level="symbol").tail(1)
    keep = everyone.index.get_level_values("symbol").isin(symbols)
    latest = everyone[keep]
    raw = {}
    for hzn in HORIZONS:
        if hzn not in final or hzn not in cal:
            continue
        k_smooth = SMOOTH_DAYS.get(hzn, 1) if isinstance(SMOOTH_DAYS, dict) else SMOOTH_DAYS
        p_all = predict_raw(final[hzn], recent)
        frame = pd.DataFrame(p_all, index=recent.index)
        # Relative to the whole training universe each day, like in the backtest.
        # A date with only a handful of rows (a US holiday when Milan trades) borrows
        # the mean of the last date that had a full cross-section.
        by_date = frame.groupby(level="date")
        means = by_date.mean().where(by_date.size() >= MIN_CROSS_SECTION).ffill().bfill()
        frame = frame - means.reindex(frame.index.get_level_values("date")).to_numpy()
        if k_smooth > 1:
            frame = frame.groupby(level="symbol").tail(k_smooth).groupby(level="symbol").mean()
        else:
            frame = frame.groupby(level="symbol").tail(1).droplevel("date")
        frame = frame - frame.mean()
        raw[hzn] = frame.reindex(everyone.index.get_level_values("symbol"))
    if BLEND:
        std = {h: float(f["pred"].std()) or 1.0 for h, f in raw.items()}
        blended = {}
        for hzn, weights in BLEND.items():
            if hzn not in raw:
                continue
            parts = [(w, raw[h]["pred"] / std[h]) for h, w in weights.items() if h in raw]
            total_w = sum(w for w, _ in parts)
            mix = sum(w * v for w, v in parts) / total_w
            blended[hzn] = mix * std[hzn]  # back to this horizon's own scale
        for hzn, mix in blended.items():
            raw[hzn] = raw[hzn].assign(pred=(mix - mix.mean()).to_numpy())
    rows = []
    for hzn in HORIZONS:
        if hzn not in raw:
            continue
        m, c = final[hzn], cal[hzn]
        p = {k: raw[hzn][k].to_numpy()[keep] for k in ("gbm", "ridge", "pred")}
        rel = p["pred"] * c["slope"]
        sigma = latest[f"sigma_{hzn}"].to_numpy(dtype=float)
        total = m["drift"] / sigma + rel
        p_up = prob_up(total, c)
        q = c["resid_quantiles"]
        # Conviction: the expected relative return measured in units of a typical
        # stock's volatility, so a calm index fund and a wild chip maker are
        # scored on what they are expected to earn, not on how steady they are.
        sigma_typical = float(np.nanmedian(sigma)) or 1.0
        unit = max(c["pred_rel_scale"] * c["slope"], 1e-9)
        for i, (date, sym) in enumerate(latest.index):
            s = float(sigma[i])
            rows.append({
                "symbol": sym, "date": pd.Timestamp(date), "h": hzn,
                "z": float(total[i]), "z_rel": float(rel[i]), "z_rel_raw": float(p["pred"][i]),
                "drift": float(m["drift"]), "sigma": s,
                "ret": float(np.expm1(total[i] * s)),
                "rel_ret": float(np.expm1(rel[i] * s)),
                "p10": float(np.expm1((total[i] + q["0.1"]) * s)),
                "p25": float(np.expm1((total[i] + q["0.25"]) * s)),
                "p75": float(np.expm1((total[i] + q["0.75"]) * s)),
                "p90": float(np.expm1((total[i] + q["0.9"]) * s)),
                "p_up": float(np.clip(p_up[i], 0.02, 0.98)),
                "conviction": float(rel[i] * (s / sigma_typical) / unit),
            })
    return pd.DataFrame(rows)


def feature_importance(final: dict[int, dict], panel: pd.DataFrame, features: list[str], hzn: int = 21,
                       n: int = 6000) -> list[dict]:
    """Permutation importance of the boosted model on a recent sample, for the methodology panel."""
    from sklearn.inspection import permutation_importance

    recent = panel[panel[f"{TARGET}_{hzn}"].notna() & _complete(panel)].tail(n)
    if len(recent) < 500 or hzn not in final:
        return []
    X = recent[features].to_numpy(dtype=np.float32)
    y = recent[f"{TARGET}_{hzn}"].to_numpy(dtype=float)
    gbm = final[hzn]["gbm"]
    if isinstance(gbm, SeedBag):
        gbm = gbm.models[0]
    imp = permutation_importance(gbm, X, y, n_repeats=3, random_state=0, scoring="neg_mean_squared_error")
    order = np.argsort(-imp.importances_mean)[:15]
    total = float(np.sum(np.clip(imp.importances_mean, 0, None))) or 1.0
    return [{"feature": features[i], "share": float(max(imp.importances_mean[i], 0) / total)} for i in order]
