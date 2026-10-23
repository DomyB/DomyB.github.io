"""Experiment harness for the forecasting model (development only; the
pipeline never imports this).

    python tools/stocks/experiments.py --list
    python tools/stocks/experiments.py base momentum_pack --years 16

Each variant is a named set of overrides applied to models.py / features.py
before the walk-forward backtest runs. Prices and the feature panel are cached
on disk so a variant costs one backtest (~10 minutes on 4 cores), and every
report is split into a tune period (to 2020-12-31) and a confirm period
(2021 onwards): a change is accepted only if it helps in both.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import pickle
import sys
import time

import numpy as np
import pandas as pd
import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import features  # noqa: E402
import altdata  # noqa: E402
import models  # noqa: E402
from datafeed import CONTEXT_SYMBOLS, download_prices  # noqa: E402
import universe  # noqa: E402
from universe import SECTOR, SECTOR_ETFS  # noqa: E402

log = logging.getLogger("stocks.experiments")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.environ.get("STOCKS_CACHE", os.path.join(ROOT, "build", "cache"))
TUNE_END = "2020-12-31"

BLEND_A = {5: {1: 0.15, 5: 0.7, 21: 0.15}, 21: {5: 0.15, 21: 0.7, 63: 0.15}, 63: {21: 0.4, 63: 0.6}}
BLEND_B = {5: {1: 0.1, 5: 0.8, 21: 0.1}, 21: {5: 0.1, 21: 0.8, 63: 0.1}, 63: {21: 0.25, 63: 0.75}}

# name -> dict of overrides. Keys starting with "models." or "features." set
# module attributes; "feature_flags" is a set of optional feature groups.
VARIANTS: dict[str, dict] = {
    "base": {},
    # seed-noise floor: the same model with other random seeds
    "base_s1": {"models.SEED_OFFSET": 1000},
    "base_s2": {"models.SEED_OFFSET": 2000},
    # honesty: survivors only count once they joined the index
    "membership": {"feature_flags": {"membership"}},
    # feature blocks (judged as units)
    "resid_momshape": {"feature_flags": {"resid", "momshape"}},
    "sector": {"feature_flags": {"sector"}},
    "ohlcv_block": {"feature_flags": {"overnight", "seasonality", "liquidity"}},
    # label
    "beta_resid": {"beta_shrink": 0.5},
    "beta_resid2": {"beta_shrink": 0.5},  # the same, rebuilt with the reviewed code
    # Final round: everything already accepted (reference), plus the feature blocks on top
    "ref": {"beta_shrink": 0.5, "feature_flags": {"membership"},
            "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    # The same model trained on the whole S&P 500 (judged on the tracked symbols only)
    # --- the "most advanced model" round: other learners in the trees' slot, same features as production
    "adv_lgbm": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"}, "models.GBM_KIND": "lgbm",
                 "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "adv_lgbm_rank": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"}, "models.GBM_KIND": "lgbm_rank",
                      "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "adv_xgb": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"}, "models.GBM_KIND": "xgb",
                "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "adv_cat": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"}, "models.GBM_KIND": "cat",
                "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "adv_mlp": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"}, "models.GBM_KIND": "mlp",
                "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "adv_mlp_rank": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"}, "models.GBM_KIND": "mlp_rank",
                     "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "adv_bag3": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"}, "models.N_SEEDS": 3,
                 "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "ref_fund": {"beta_shrink": 0.5, "feature_flags": {"membership", "fund"},
                 "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "ref_fundlite": {"beta_shrink": 0.5, "feature_flags": {"membership", "fund", "fundlite"},
                     "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "ref_earn": {"beta_shrink": 0.5, "feature_flags": {"membership", "earn"},
                 "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "ref_ctx2": {"beta_shrink": 0.5, "feature_flags": {"membership", "ctx2"},
                 "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "ref_alt": {"beta_shrink": 0.5, "feature_flags": {"membership", "fund", "earn", "ctx2"},
                "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "ref500": {"beta_shrink": 0.5, "feature_flags": {"membership"}, "broad": True,
               "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "candA": {"beta_shrink": 0.5, "feature_flags": {"membership", "resid", "momshape"},
              "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "candB": {"beta_shrink": 0.5, "feature_flags": {"membership", "resid", "momshape", "sector", "overnight", "seasonality", "liquidity"},
              "models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}, "models.BLEND": {5: BLEND_A[5], 21: BLEND_A[21]}},
    # training-set construction
    "recency4y": {"models.RECENCY_HALFLIFE": 4 * 252},
    "recency8y": {"models.RECENCY_HALFLIFE": 8 * 252},
    "stride1_h1": {"models.TRAIN_STRIDE": {1: 1, 5: 3, 21: 5, 63: 10}},
    # learners
    "ridge_cs": {"feature_flags": {"cs_ranks"}, "models.RIDGE_CS": True},
    "bag_long": {"models.N_SEEDS": {1: 1, 5: 1, 21: 3, 63: 3}},
    "gbm_shallow": {"models.GBM_PARAMS": dict(loss="squared_error", learning_rate=0.05, max_iter=200, max_leaf_nodes=7,
                                              min_samples_leaf=1000, l2_regularization=10.0, max_features=0.6, early_stopping=False)},
}


def register(name: str, **overrides):
    VARIANTS[name] = overrides


def tracked_symbols() -> list[str]:
    with open(os.path.join(ROOT, "_data", "stocks.yml"), encoding="utf-8") as fh:
        return [str(e["symbol"]).upper() for e in yaml.safe_load(fh)]


def load_prices(years: int, broad: bool = False) -> dict[str, pd.DataFrame]:
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"prices_{years}y{'_broad' if broad else ''}.pkl")
    if os.path.exists(path):
        prices = pickle.load(open(path, "rb"))
        missing = [e for e in set(SECTOR_ETFS.values()) | set(altdata.CTX2_YAHOO.values()) if e not in prices]
        if missing:  # a cache from before these series were part of the download
            prices.update(download_prices(missing, years=years))
            pickle.dump(prices, open(path, "wb"))
        return prices
    tracked = tracked_symbols()
    training = [s for s in universe.training_symbols(broad) if s not in tracked]
    extra = sorted(set(SECTOR_ETFS.values()) | set(altdata.CTX2_YAHOO.values()))
    prices = download_prices(tracked + training + list(CONTEXT_SYMBOLS.values()) + extra, years=years)
    pickle.dump(prices, open(path, "wb"))
    return prices


NOT_UNIVERSE = set(CONTEXT_SYMBOLS.values()) - {"SPY"}
NOT_UNIVERSE |= set(SECTOR_ETFS.values()) - {"SPY"}
NOT_UNIVERSE |= set(altdata.CTX2_YAHOO.values())


def alt_frames(symbols: dict, flags: frozenset) -> dict[str, pd.DataFrame]:
    """Per-symbol point-in-time frames for the fund and earn packs (cached on disk by altdata)."""
    out = {}
    if "fund" in flags:
        tables = altdata.fundamentals_tables(list(symbols))
        for sym, df in symbols.items():
            if sym in tables:
                out[sym] = altdata.fundamental_daily(tables[sym], df, altdata.split_factors(sym))
    if "earn" in flags:
        for sym, df in symbols.items():
            e = altdata.earnings_daily(altdata.earnings_events(sym), df)
            out[sym] = out[sym].join(e, how="outer") if sym in out else e
    return out


def load_membership() -> dict:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "membership.csv")
    if not os.path.exists(path):
        return {}
    m = pd.read_csv(path)
    return {r.symbol: pd.Timestamp(r.from_date) for r in m.itertuples()}


def build_panel(prices: dict, years: int, flags: frozenset, beta_shrink: float = 0.0,
                feature_overrides: dict | None = None, broad: bool = False) -> tuple[pd.DataFrame, list[str]]:
    feature_overrides = feature_overrides or {}
    key = hashlib.sha1((f"{years}|" + "|".join(sorted(flags)) + f"|{beta_shrink}|" + features.FEATURE_VERSION
                        + "|" + repr(sorted(feature_overrides.items())) + ("|broad" if broad else "")).encode()).hexdigest()[:10]
    path = os.path.join(CACHE, f"panel_{key}.pkl")
    if os.path.exists(path):
        return pickle.load(open(path, "rb"))
    old = (features.FEATURE_FLAGS, features.BETA_SHRINK, features.MEMBERSHIP)
    saved = apply(feature_overrides)
    features.FEATURE_FLAGS = set(flags)
    features.BETA_SHRINK = beta_shrink
    features.MEMBERSHIP = load_membership() if "membership" in flags else {}
    try:
        ctx_extra = altdata.context_extra(prices) if "ctx2" in flags else None
        ctx = features.context_features(prices["SPY"], prices.get("^VIX"), prices.get("^TNX"), ctx_extra)
        wanted = set(tracked_symbols()) | set(universe.training_symbols(broad))
        symbols = {s: df for s, df in prices.items() if s in wanted and s not in NOT_UNIVERSE and not s.startswith("^")}
        sector_prices = {name: prices[etf] for name, etf in SECTOR_ETFS.items() if etf in prices}
        extra = alt_frames(symbols, flags) if flags & {"fund", "earn"} else None
        panel, feats = features.build_panel(symbols, ctx, sectors=SECTOR, sector_prices=sector_prices, extra=extra)
    finally:
        features.FEATURE_FLAGS, features.BETA_SHRINK, features.MEMBERSHIP = old
        restore(saved)
    pickle.dump((panel, feats), open(path, "wb"))
    return panel, feats


def apply(overrides: dict) -> dict:
    """Set module attributes from overrides; returns what to restore."""
    saved = {}
    for key, value in overrides.items():
        if key in ("feature_flags", "beta_shrink", "broad"):
            continue
        mod_name, attr = key.split(".", 1)
        mod = {"models": models, "features": features}[mod_name]
        saved[key] = getattr(mod, attr)
        setattr(mod, attr, value)
    return saved


def restore(saved: dict):
    for key, value in saved.items():
        mod_name, attr = key.split(".", 1)
        setattr({"models": models, "features": features}[mod_name], attr, value)


def postprocess(oos: pd.DataFrame, smooth: dict | None = None, blend: dict | None = None,
                scale_eq: bool = False) -> pd.DataFrame:
    """Post-hoc variants that need no retraining: equalising the two learners'
    scales, temporal smoothing of each stock's forecast, and blending
    neighbouring horizons' forecasts. Every step re-demeans per date."""
    oos = oos.copy()
    for col in ("pred", "pred_gbm", "pred_ridge"):
        oos[col] = oos[col].astype(np.float64)
    grp = ["date", "h"]
    if scale_eq:
        sg = oos.groupby(grp)["pred_gbm"].transform("std").replace(0, np.nan)
        sr = oos.groupby(grp)["pred_ridge"].transform("std").replace(0, np.nan)
        oos["pred"] = 0.5 * oos["pred_gbm"] / sg + 0.5 * oos["pred_ridge"] / sr
    if smooth:
        oos = oos.sort_values(["h", "symbol", "date"])
        for hzn, k in smooth.items():
            if k and k > 1:
                m = oos["h"] == hzn
                for col in ("pred", "pred_gbm", "pred_ridge"):
                    oos.loc[m, col] = oos[m].groupby("symbol")[col].transform(lambda v: v.rolling(k, min_periods=1).mean())
        for col in ("pred", "pred_gbm", "pred_ridge"):
            oos[col] = oos[col] - oos.groupby(grp)[col].transform("mean")
    if blend:
        z = oos["pred"] / oos.groupby(["date", "h"])["pred"].transform("std").replace(0, np.nan)
        wide = pd.DataFrame({"z": z.to_numpy(), "date": oos["date"].to_numpy(), "symbol": oos["symbol"].to_numpy(),
                             "h": oos["h"].to_numpy()}).pivot_table(index=["date", "symbol"], columns="h", values="z")
        mixed = {}
        for hzn, weights in blend.items():
            cols = [c for c in weights if c in wide.columns]
            if not cols:
                continue
            w = np.array([weights[c] for c in cols], dtype=float)
            vals = wide[cols].to_numpy()
            ok = np.isfinite(vals)
            num = np.nansum(vals * w, axis=1)
            den = (ok * w).sum(axis=1)
            mixed[hzn] = pd.Series(np.where(den > 0, num / np.where(den > 0, den, 1), np.nan), index=wide.index)
        for hzn, series in mixed.items():
            m = oos["h"] == hzn
            key = pd.MultiIndex.from_arrays([oos.loc[m, "date"], oos.loc[m, "symbol"]])
            new = series.reindex(key).to_numpy()
            old_vals = oos.loc[m, "pred"].to_numpy()
            oos.loc[m, "pred"] = np.where(np.isfinite(new), new, old_vals)
        oos["pred"] = oos["pred"] - oos.groupby(["date", "h"])["pred"].transform("mean")
    return oos


# Post-hoc variants: evaluated on another variant's saved predictions (pre-registered settings).
POSTHOC: dict[str, dict] = {
    "smooth3": {"base": "base", "smooth": {5: 2, 21: 3, 63: 5}},
    "smooth5": {"base": "base", "smooth": {5: 3, 21: 5, 63: 8}},
    "blend": {"base": "base", "blend": BLEND_A},
    "blend_light": {"base": "base", "blend": BLEND_B},
    "blend_5_21": {"base": "base", "blend": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "beta_blend_5_21": {"base": "beta_resid", "blend": {5: BLEND_A[5], 21: BLEND_A[21]}},
    "beta_blend": {"base": "beta_resid", "blend": BLEND_A},
    "scale_eq": {"base": "base", "scale_eq": True},
    "blend_smooth": {"base": "base", "smooth": {5: 2, 21: 3, 63: 5}, "blend": BLEND_A},
}


def run_posthoc(name: str) -> dict:
    spec = POSTHOC[name]
    oos = pd.read_pickle(os.path.join(CACHE, "preds", f"{spec['base']}.pkl"))
    oos = postprocess(oos, smooth=spec.get("smooth"), blend=spec.get("blend"), scale_eq=spec.get("scale_eq", False))
    report = split_report(oos)
    report["meta"] = {"variant": name, "posthoc": {k: v for k, v in spec.items()}}
    _save(name, oos, report)
    return report


def _save(name: str, oos: pd.DataFrame, report: dict):
    os.makedirs(os.path.join(CACHE, "reports"), exist_ok=True)
    os.makedirs(os.path.join(CACHE, "preds"), exist_ok=True)
    os.makedirs(os.path.join(CACHE, "daily"), exist_ok=True)
    with open(os.path.join(CACHE, "reports", f"{name}.json"), "w") as fh:
        json.dump(report, fh, indent=1, default=float)
    keep = ["date", "symbol", "h", "pred", "pred_gbm", "pred_ridge", "drift", "z_true", "zr_true", "y_true", "sigma"]
    oos[[c for c in keep if c in oos.columns]].to_pickle(os.path.join(CACHE, "preds", f"{name}.pkl"))
    models.daily_series(oos).to_pickle(os.path.join(CACHE, "daily", f"{name}.pkl"))
    # The same skill measured among the tracked symbols only: comparable across universes of different size
    os.makedirs(os.path.join(CACHE, "daily_tracked"), exist_ok=True)
    tracked = oos[oos["symbol"].isin(tracked_symbols())]
    old_min = models.MIN_CROSS_SECTION
    models.MIN_CROSS_SECTION = 20
    try:
        models.daily_series(tracked).to_pickle(os.path.join(CACHE, "daily_tracked", f"{name}.pkl"))
    finally:
        models.MIN_CROSS_SECTION = old_min


def split_report(oos: pd.DataFrame) -> dict:
    out = {}
    for name, mask in (("all", slice(None)), ("tune", oos["date"] <= TUNE_END), ("confirm", oos["date"] > TUNE_END)):
        part = oos if name == "all" else oos[mask]
        if len(part) < 1000:
            continue
        cal = models.calibrate(part)
        rep = models.evaluate(part, cal)
        out[name] = {h: {k: v for k, v in r.items() if k not in ("deciles", "by_year")} for h, r in rep.items()}
    return out


def run(name: str, years: int, step: int) -> dict:
    overrides = VARIANTS[name]
    flags = frozenset(overrides.get("feature_flags", ()))
    broad = bool(overrides.get("broad", False))
    prices = load_prices(years, broad)
    panel, feats = build_panel(prices, years, flags, overrides.get("beta_shrink", 0.0),
                               {k: v for k, v in overrides.items() if k.startswith("features.")}, broad)
    saved = apply({k: v for k, v in overrides.items() if not k.startswith("features.") and k not in ("broad",)})
    t0 = time.time()
    try:
        oos = models.walk_forward(panel, feats, step=step)
    finally:
        restore(saved)
    report = split_report(oos)
    report["meta"] = {"variant": name, "overrides": {k: (sorted(v) if isinstance(v, (set, frozenset)) else v) for k, v in overrides.items()},
                      "years": years, "rows": int(len(panel)), "features": len(feats), "seconds": round(time.time() - t0)}
    _save(name, oos, report)
    return report


def stack(names: list[str], base: str = "ref_ctx2", out: str | None = None) -> dict:
    """Stack the saved out-of-sample predictions of several variants: per horizon,
    a non-negative least-squares blend of their per-date-demeaned, standardised
    forecasts is fitted on the tune period only and applied everywhere, so the
    confirm period is a genuine test of the blend. Saves the result as a
    variant named `out` (default "stack_" + joined names)."""
    from scipy.optimize import nnls
    frames = {}
    for n in names:
        p = pd.read_pickle(os.path.join(CACHE, "preds", f"{n}.pkl"))[["date", "symbol", "h", "pred"]].rename(columns={"pred": n})
        frames[n] = p
    ref = pd.read_pickle(os.path.join(CACHE, "preds", f"{base}.pkl"))
    merged = ref[["date", "symbol", "h", "drift", "z_true", "zr_true", "y_true", "sigma"]]
    for n, p in frames.items():
        merged = merged.merge(p, on=["date", "symbol", "h"], how="inner")
    merged = merged.sort_values(["h", "date", "symbol"]).reset_index(drop=True)
    weights = {}
    merged["pred"] = 0.0
    for hzn in sorted(merged["h"].unique()):
        m = merged["h"] == hzn
        sub = merged.loc[m]
        X = np.column_stack([(sub[n] - sub.groupby("date")[n].transform("mean")).to_numpy() for n in names])
        X = X / (X.std(axis=0) + 1e-12)
        tune = (sub["date"] <= TUNE_END).to_numpy() & np.isfinite(sub["zr_true"].to_numpy())
        w, _ = nnls(X[tune], sub["zr_true"].to_numpy()[tune])
        if w.sum() <= 0:
            w = np.ones(len(names)) / len(names)
        w = w / w.sum()
        weights[int(hzn)] = {n: float(v) for n, v in zip(names, w)}
        merged.loc[m, "pred"] = X @ w
    name = out or ("stack_" + "+".join(names))
    report = split_report(merged)
    report["meta"] = {"variant": name, "stack_of": names, "base": base, "weights": weights}
    _save(name, merged, report)
    return report


def paired(names: list[str], base: str = "base", metric: str = "ic", scope: str = "all") -> pd.DataFrame:
    """Paired comparison of a daily metric against the baseline, per horizon and
    period (and pooled), with a Newey-West t-stat and the seed-noise floor.
    scope="tracked" compares the skill among the tracked symbols only."""
    rows = []
    folder = "daily" if scope == "all" else "daily_tracked"
    bpath = os.path.join(CACHE, folder, f"{base}.pkl")
    if not os.path.exists(bpath):
        return pd.DataFrame()
    b = pd.read_pickle(bpath)[["date", "h", metric]].rename(columns={metric: "m_base"})
    floor = noise_floor(base, metric) if scope == "all" else {}
    for name in names:
        path = os.path.join(CACHE, folder, f"{name}.pkl")
        if name == base or not os.path.exists(path):
            continue
        v = pd.read_pickle(path)[["date", "h", metric]].merge(b, on=["date", "h"])
        v["diff"] = v[metric] - v["m_base"]
        for period, mask in (("tune", v["date"] <= TUNE_END), ("confirm", v["date"] > TUNE_END), ("pooled", slice(None))):
            part = v if period == "pooled" else v[mask]
            for hzn, g in part.groupby("h"):
                d = float(g["diff"].mean())
                f = floor.get((int(hzn), period))
                rows.append({"variant": name, "period": period, "h": int(hzn), "dIC": d,
                             "t_nw": models.nw_t(g["diff"].to_numpy(), lags=max(int(hzn) - 1, 0)),
                             "x_floor": (abs(d) / f) if f else np.nan, "days": len(g)})
    return pd.DataFrame(rows)


def noise_floor(base: str = "base", metric: str = "ic") -> dict:
    """RMS over the seed reruns of their mean paired difference vs base: the size of a 'nothing' effect."""
    bpath = os.path.join(CACHE, "daily", f"{base}.pkl")
    reruns = [os.path.join(CACHE, "daily", f"{base}_s{k}.pkl") for k in (1, 2)]
    if not os.path.exists(bpath) or not all(os.path.exists(r) for r in reruns):
        return {}
    b = pd.read_pickle(bpath)[["date", "h", metric]].rename(columns={metric: "m_base"})
    acc: dict = {}
    for r in reruns:
        v = pd.read_pickle(r)[["date", "h", metric]].merge(b, on=["date", "h"])
        v["diff"] = v[metric] - v["m_base"]
        for period, mask in (("tune", v["date"] <= TUNE_END), ("confirm", v["date"] > TUNE_END), ("pooled", slice(None))):
            part = v if period == "pooled" else v[mask]
            for hzn, g in part.groupby("h"):
                acc.setdefault((int(hzn), period), []).append(float(g["diff"].mean()))
    return {k: float(np.sqrt(np.mean(np.square(v)))) for k, v in acc.items()}


def table(names: list[str]):
    rows = []
    for name in names:
        path = os.path.join(CACHE, "reports", f"{name}.json")
        if not os.path.exists(path):
            continue
        rep = json.load(open(path))
        for period in ("tune", "confirm"):
            for h, r in rep.get(period, {}).items():
                rows.append({"variant": name, "period": period, "h": int(h), "IC": r["ic_daily_mean"], "t": r["ic_daily_t"],
                             "relhit": r["rel_hit_rate"], "conf": r["rel_hit_rate_confident"], "LS/yr": r["long_short_annualised"],
                             "cov80": r["coverage80_out_of_time"], "slope": r["calibration_slope"]})
    if not rows:
        print("no reports yet")
        return
    df = pd.DataFrame(rows)
    pd.set_option("display.width", 200)
    piv = df.pivot_table(index=["h", "period"], columns="variant", values="IC").round(4)
    print("\n=== daily IC mean by horizon and period ===")
    print(piv.to_string())
    piv = df.pivot_table(index=["h", "period"], columns="variant", values="conf").round(4)
    print("\n=== confident relative hit rate ===")
    print(piv.to_string())
    piv = df.pivot_table(index=["h", "period"], columns="variant", values="LS/yr").round(3)
    print("\n=== long-short annualised ===")
    print(piv.to_string())
    for metric in ("ic", "ic_raw"):
        pr = paired(names, metric=metric)
        if len(pr):
            print(f"\n=== paired daily {metric} difference vs base (Newey-West t; x_floor = |d| / seed-noise floor) ===")
            print(pr.pivot_table(index=["h", "period"], columns="variant", values=["dIC", "t_nw", "x_floor"]).round(4).to_string())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("variants", nargs="*")
    ap.add_argument("--years", type=int, default=16)
    ap.add_argument("--step", type=int, default=126)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--table", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    if a.list:
        for k, v in VARIANTS.items():
            print(k, v)
    elif a.table:
        table(a.variants or list(VARIANTS))
    else:
        for name in a.variants:
            log.info("=== variant %s", name)
            rep = run_posthoc(name) if name in POSTHOC else run(name, a.years, a.step)
            for period in ("tune", "confirm"):
                for h, r in rep.get(period, {}).items():
                    log.info("%s %s h=%s IC=%.4f t=%.2f conf=%.4f LS=%+.3f cov=%.3f", name, period, h, r["ic_daily_mean"], r["ic_daily_t"], r["rel_hit_rate_confident"], r["long_short_annualised"], r["coverage80_out_of_time"])
        table(a.variants)
