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
  average is the raw forecast. Its target is the stock's normalised return
  minus the day's average across all stocks.

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
TRAIN_STRIDE = {1: 2, 5: 3, 21: 5, 63: 10}
TARGET = "zrank"  # "zrank": the cross-sectional rank of the relative return (robust); "zr": the return itself


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
    return HistGradientBoostingRegressor(
        loss="squared_error", learning_rate=0.03, max_iter=250, max_leaf_nodes=15,
        min_samples_leaf=300, l2_regularization=3.0, max_features=0.6,
        early_stopping=False, random_state=seed,
    )


def make_ridge():
    return make_pipeline(SimpleImputer(strategy="median"), QuantileClipper(), StandardScaler(), Ridge(alpha=50.0))


def _complete(panel: pd.DataFrame) -> pd.Series:
    """Rows whose slow features exist (a year of history), so the model never trains on half-empty rows."""
    return panel["ret252"].notna() & panel["sma200_gap"].notna()


def _training_rows(panel: pd.DataFrame, hzn: int, before_pos: int, dates: np.ndarray, stride: int = 1) -> pd.DataFrame:
    """Complete rows whose h-day target is fully known before `dates[before_pos]`, every `stride`-th date."""
    cutoff_pos = min(before_pos - hzn - 1, len(dates) - 1)
    if cutoff_pos < 0:
        return panel.iloc[0:0]
    keep_dates = dates[:cutoff_pos + 1][::-1][::stride]  # count back from the cutoff so the newest data is always in
    idx = panel.index.get_level_values("date")
    rows = panel[idx.isin(keep_dates)]
    rows = rows[rows[f"{TARGET}_{hzn}"].notna() & _complete(rows)]
    return rows


def _stride(panel: pd.DataFrame, hzn: int) -> int:
    """Thin out training dates only when the universe is big enough to afford it."""
    n_symbols = panel.index.get_level_values("symbol").nunique()
    return TRAIN_STRIDE[hzn] if n_symbols >= 100 else 1


def fit_learners(train: pd.DataFrame, features: list[str], hzn: int, seed: int = 0) -> dict:
    Xtr = train[features].to_numpy(dtype=np.float32)
    ytr = train[f"{TARGET}_{hzn}"].to_numpy(dtype=float)
    return {
        "gbm": make_gbm(seed).fit(Xtr, ytr),
        "ridge": make_ridge().fit(Xtr, ytr),
        # The market drift is a plain average return (not volatility-scaled: a
        # wilder stock doesn't earn more on average, it just moves more).
        "drift": DRIFT_SHRINK * float(np.nanmean(train[f"y_{hzn}"])),
        "n_train": int(len(train)),
    }


def predict_raw(learners: dict, X: np.ndarray) -> dict[str, np.ndarray]:
    g = learners["gbm"].predict(X)
    r = learners["ridge"].predict(X)
    return {"gbm": g, "ridge": r, "pred": ENSEMBLE_WEIGHTS["gbm"] * g + ENSEMBLE_WEIGHTS["ridge"] * r}


def walk_forward(panel: pd.DataFrame, features: list[str], min_train_days: int = 1000, step: int = 126,
                 max_folds: int | None = None) -> pd.DataFrame:
    """Out-of-sample predictions for every (date, symbol, horizon) the model never trained on."""
    dates = np.array(sorted(panel.index.get_level_values("date").unique()))
    starts = list(range(min_train_days, len(dates), step))
    if max_folds:
        starts = starts[-max_folds:]
    pieces = []
    t0 = time.time()
    idx_dates = panel.index.get_level_values("date")
    for k, start in enumerate(starts):
        test_dates = dates[start:start + step]
        test = panel[idx_dates.isin(test_dates) & _complete(panel)]
        Xte = test[features].to_numpy(dtype=np.float32)
        for hzn in HORIZONS:
            train = _training_rows(panel, hzn, start, dates, _stride(panel, hzn))
            if len(train) < 2000:
                continue
            learners = fit_learners(train, features, hzn, seed=k)
            p = predict_raw(learners, Xte)
            out = pd.DataFrame(index=test.index)
            out["pred_gbm"], out["pred_ridge"], out["pred"] = p["gbm"], p["ridge"], p["pred"]
            # The target is relative, so the forecasts must be too: remove each
            # day's average forecast (the model has no business taking a market view).
            for col in ("pred_gbm", "pred_ridge", "pred"):
                out[col] = out[col] - out.groupby(level="date")[col].transform("mean")
            out["h"] = hzn
            out["drift"] = learners["drift"]
            out["z_true"] = test[f"z_{hzn}"]
            out["zr_true"] = test[f"zr_{hzn}"]
            out["y_true"] = test[f"y_{hzn}"]
            out["sigma"] = test[f"sigma_{hzn}"]
            pieces.append(out.reset_index())
        log.info("fold %d/%d (%s → %s) done, %.0fs so far", k + 1, len(starts),
                 pd.Timestamp(test_dates[0]).date(), pd.Timestamp(test_dates[-1]).date(), time.time() - t0)
    return pd.concat(pieces, ignore_index=True)


def _spearman(a, b) -> float:
    if len(a) < 10:
        return float("nan")
    r = spearmanr(a, b).correlation
    return float(r) if np.isfinite(r) else float("nan")


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
        slope = cal[hzn]["slope"]
        d["rel_cal"] = d["pred"] * slope
        d["total"] = d["drift"] / d["sigma"] + d["rel_cal"]
        d["ret_pred"] = d["total"] * d["sigma"]
        y, z, zr, p = (d[c].to_numpy() for c in ("y_true", "z_true", "zr_true", "pred"))
        total = d["total"].to_numpy()

        # 1. Relative direction: does the stock beat the average tracked stock? Baseline: a coin flip.
        rel_hit = float(np.mean(np.sign(p) == np.sign(zr)))
        conf = np.abs(p) >= np.quantile(np.abs(p), 0.7)
        rel_hit_conf = float(np.mean(np.sign(p[conf]) == np.sign(zr[conf])))

        # 2. Absolute direction: does the price go up? Baseline: always saying "up".
        hit = float(np.mean(np.sign(total) == np.sign(y)))
        up_rate = float(np.mean(y > 0))

        # 3. Rank skill: Spearman correlation between forecast and outcome within each day
        daily = d.groupby("date").apply(lambda g: _spearman(g["pred"], g["zr_true"]) if len(g) >= 15 else np.nan,
                                        include_groups=False).dropna()
        ic_mean = float(daily.mean()) if len(daily) else float("nan")
        ic_t = float(daily.mean() / daily.std() * np.sqrt(len(daily) / hzn)) if len(daily) > 2 and daily.std() > 0 else float("nan")
        ic_pos_share = float(np.mean(daily > 0)) if len(daily) else float("nan")

        # 4. Long–short: the fifth of stocks the model likes most minus the fifth it likes least, per period
        def spread(g):
            if len(g) < 15:
                return np.nan
            q = g["pred"].rank(pct=True)
            return g.loc[q >= 0.8, "y_true"].mean() - g.loc[q <= 0.2, "y_true"].mean()
        ls = d.groupby("date").apply(spread, include_groups=False).dropna()
        ls_mean = float(ls.mean()) if len(ls) else float("nan")
        ls_t = float(ls.mean() / ls.std() * np.sqrt(len(ls) / hzn)) if len(ls) > 2 and ls.std() > 0 else float("nan")
        ls_annual = float(np.expm1(ls_mean * 252 / hzn)) if np.isfinite(ls_mean) else float("nan")

        # 4b. Each learner on its own, so the ensemble can be judged against its parts
        components = {
            name: {"rel_hit_rate": float(np.mean(np.sign(d[col].to_numpy()) == np.sign(zr))),
                   "ic_daily_mean": float(d.groupby("date").apply(
                       lambda g, c=col: _spearman(g[c], g["zr_true"]) if len(g) >= 15 else np.nan,
                       include_groups=False).dropna().mean())}
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
        by_year = []
        for yr, g in d.groupby("year"):
            gd = g.groupby("date").apply(lambda x: _spearman(x["pred"], x["zr_true"]) if len(x) >= 15 else np.nan,
                                         include_groups=False).dropna()
            gl = g.groupby("date").apply(spread, include_groups=False).dropna()
            by_year.append({
                "year": int(yr), "n": int(len(g)),
                "rel_hit": float(np.mean(np.sign(g["pred"]) == np.sign(g["zr_true"]))),
                "hit": float(np.mean(np.sign(g["total"]) == np.sign(g["y_true"]))),
                "up_rate": float(np.mean(g["y_true"] > 0)),
                "ic": float(gd.mean()) if len(gd) else float("nan"),
                "long_short": float(gl.mean()) if len(gl) else float("nan"),
            })

        report[str(hzn)] = {
            "n": int(len(d)), "days": int(len(daily)),
            "from": str(pd.Timestamp(d["date"].min()).date()),
            "to": str(pd.Timestamp(d["date"].max()).date()),
            "rel_hit_rate": rel_hit, "rel_hit_rate_confident": rel_hit_conf,
            "hit_rate": hit, "up_rate": up_rate,
            "ic_daily_mean": ic_mean, "ic_daily_t": ic_t, "ic_positive_share": ic_pos_share,
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
    dates = np.array(sorted(panel.index.get_level_values("date").unique()))
    for hzn in HORIZONS:
        train = _training_rows(panel, hzn, len(dates) + hzn + 1, dates, _stride(panel, hzn))
        learners = fit_learners(train, features, hzn, seed=hzn)
        learners["trained_through"] = str(pd.Timestamp(train.index.get_level_values("date").max()).date())
        final[hzn] = learners
    return final


def forecast_latest(panel: pd.DataFrame, features: list[str], final: dict[int, dict], cal: dict[int, dict],
                    symbols: list[str]) -> pd.DataFrame:
    """Calibrated forecasts, bands and probabilities for the latest row of the given symbols."""
    everyone = panel.groupby(level="symbol").tail(1)
    everyone = everyone[_complete(everyone)]
    keep = everyone.index.get_level_values("symbol").isin(symbols)
    latest = everyone[keep]
    X_all = everyone[features].to_numpy(dtype=np.float32)
    rows = []
    for hzn in HORIZONS:
        if hzn not in final or hzn not in cal:
            continue
        m, c = final[hzn], cal[hzn]
        p_all = predict_raw(m, X_all)
        # Relative to the whole training universe today, like in the backtest
        p = {k: (v - v.mean())[keep] for k, v in p_all.items()}
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
    imp = permutation_importance(final[hzn]["gbm"], X, y, n_repeats=3, random_state=0,
                                 scoring="neg_mean_squared_error")
    order = np.argsort(-imp.importances_mean)[:15]
    total = float(np.sum(np.clip(imp.importances_mean, 0, None))) or 1.0
    return [{"feature": features[i], "share": float(max(imp.importances_mean[i], 0) / total)} for i in order]
