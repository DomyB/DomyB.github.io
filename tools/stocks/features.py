"""Technical features and forecast targets.

Every feature at date t is computed from prices up to and including t, never
from later data. Targets look forward (the return over the next h trading
days) and are only used for training and for the backtest.

The targets are *volatility-normalised*: instead of "will NVDA move 4%?" the
model learns "will this stock move more than usual?", which puts calm and
wild stocks on the same scale and makes the model far better behaved.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

HORIZONS = [1, 5, 21, 63]  # trading days: a day, a week, a month, a quarter
FEATURE_VERSION = "4"      # bump when features change, so cached experiment panels are rebuilt
# Optional feature groups. The experiment harness switches them on one at a
# time; production uses PRODUCTION_FLAGS (the ones that earned their place).
PRODUCTION_FLAGS: set[str] = {"membership", "ctx2"}  # ctx2: VIX term structure, SKEW, dollar, credit, curve (altdata.py)
FEATURE_FLAGS: set[str] = set()
HORIZON_LABELS = {1: "1 day", 5: "1 week", 21: "1 month", 63: "3 months"}

MIN_DAILY_VOL = 0.004  # 0.4% a day: stops the normalised target exploding on sleepy stocks
TARGET_CLIP = 4.0      # normalised targets are winsorised at ±4 sigma for training


def rsi(close: pd.Series, n: int) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0)
    down = -delta.clip(upper=0)
    avg_up = up.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    avg_down = down.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = avg_up / avg_down.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100).where(avg_down.notna() | avg_up.isna(), out)


def atr(high, low, close, n=14):
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def _slope(series: pd.Series, n: int) -> pd.Series:
    """Slope of a least-squares line through the last n points, per point."""
    t = np.arange(n) - (n - 1) / 2.0
    w = t / (t ** 2).sum()
    return series.rolling(n).apply(lambda y: float(np.dot(w, y)), raw=True)


def indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Indicator series for one stock (used both as features and for the charts)."""
    o, h, l, c, v = df["open"], df["high"], df["low"], df["close"], df["volume"]
    v = v.fillna(v.rolling(20, min_periods=1).mean())
    logc = np.log(c)
    r = logc.diff()
    x = pd.DataFrame(index=df.index)

    # Returns and momentum
    x["ret1"] = r
    for n in (5, 10, 21, 63, 126, 252):
        x[f"ret{n}"] = logc - logc.shift(n)
    x["mom12_1"] = x["ret252"] - x["ret21"]  # the classic "12 minus 1" momentum
    x["max_r21"] = r.rolling(21).max()
    x["min_r21"] = r.rolling(21).min()
    sign = np.sign(r).fillna(0)
    x["streak"] = sign * (sign.groupby((sign != sign.shift()).cumsum()).cumcount() + 1)

    # Volatility
    for n in (10, 21, 63):
        x[f"vol{n}"] = r.rolling(n).std() * np.sqrt(252)
    x["vol_ratio"] = x["vol10"] / x["vol63"]
    x["dvol63"] = r.clip(upper=0).rolling(63).std() * np.sqrt(252)
    x["skew63"] = r.rolling(63).skew()
    x["atr_pct"] = atr(h, l, c, 14) / c

    # Trend
    sma20, sma50, sma200 = c.rolling(20).mean(), c.rolling(50).mean(), c.rolling(200).mean()
    x["sma20"], x["sma50"], x["sma200"] = sma20, sma50, sma200
    x["sma20_gap"] = c / sma20 - 1
    x["sma50_gap"] = c / sma50 - 1
    x["sma200_gap"] = c / sma200 - 1
    x["sma50_200"] = sma50 / sma200 - 1
    x["slope20"] = _slope(logc, 20)
    x["slope63"] = _slope(logc, 63)
    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    x["macd"] = macd / c
    x["macd_hist"] = (macd - signal) / c
    x["macd_hist_chg"] = x["macd_hist"].diff(3)

    # Oscillators and ranges
    x["rsi14"] = rsi(c, 14)
    x["rsi2"] = rsi(c, 2)
    low14, high14 = l.rolling(14).min(), h.rolling(14).max()
    x["stoch_k"] = (c - low14) / (high14 - low14).replace(0, np.nan) * 100
    std20 = c.rolling(20).std()
    x["bb_upper"] = sma20 + 2 * std20
    x["bb_lower"] = sma20 - 2 * std20
    x["bb_pctb"] = (c - x["bb_lower"]) / (4 * std20).replace(0, np.nan)
    x["bb_width"] = 4 * std20 / sma20
    hi252, lo252 = c.rolling(252).max(), c.rolling(252).min()
    x["pos52"] = (c - lo252) / (hi252 - lo252).replace(0, np.nan)
    x["dd252"] = c / hi252 - 1
    x["days_since_high"] = c.rolling(252).apply(lambda y: (len(y) - 1 - int(np.argmax(y))) / 252.0, raw=True)

    # Volume and liquidity
    vs20 = v.rolling(20).mean()
    x["vol_rel20"] = v / vs20 - 1
    x["vol_rel5_63"] = v.rolling(5).mean() / v.rolling(63).mean() - 1
    x["dollar_vol"] = np.log((c * v).rolling(21).mean())
    obv = (sign * v).cumsum()
    x["obv_slope"] = (obv - obv.shift(20)) / (vs20 * 20)
    x["updown_vol"] = (v.where(r > 0, 0).rolling(21).sum() / v.rolling(21).sum()) - 0.5

    # Today's candle
    x["intraday"] = c / o - 1
    x["gap"] = o / c.shift(1) - 1
    x["range_pct"] = (h - l) / c
    x["close_pos"] = (c - l) / (h - l).replace(0, np.nan)

    # --- Optional packs (switched on by FEATURE_FLAGS) --------------------------
    if "overnight" in FEATURE_FLAGS:
        # Overnight (close to open) versus intraday (open to close) returns: the
        # two halves of a day's move carry different information.
        o_ok = o.notna() & (o > 0)
        on = np.log(o / c.shift(1)).where(o_ok).clip(-0.2, 0.2)
        if float((o == c.shift(1)).mean()) > 0.3:  # exchange reports fake opens
            on[:] = np.nan
        io = r - on
        for n in (5, 21, 63):
            x[f"on{n}"] = on.rolling(n).sum()
        x["on_mom12_1"] = on.rolling(252).sum() - x["on21"]
        x["io21"] = io.rolling(21).sum()
        x["on_share"] = on.abs().rolling(63).sum() / r.abs().rolling(63).sum().replace(0, np.nan)
    if "momshape" in FEATURE_FLAGS:
        # The shape of momentum: where in the year it came from, how smooth it
        # was (frog-in-the-pan) and how much came from a few big days.
        x["mom12_7"] = x["ret252"] - x["ret126"]
        x["mom6_1"] = x["ret126"] - x["ret21"]
        up = (r > 0).astype(float)
        down = (r < 0).astype(float)
        x["fip"] = np.sign(x["mom12_1"]) * (down.rolling(231).mean().shift(21) - up.rolling(231).mean().shift(21))
        x["mom_vol_adj"] = x["mom12_1"] / (r.rolling(252).std() * np.sqrt(252)).replace(0, np.nan)
    if "seasonality" in FEATURE_FLAGS:
        # Same-calendar-window returns in the previous five years (Heston-Sadka).
        for n, name in ((21, "seas21"), (63, "seas63")):
            lags = pd.concat([logc.shift(252 * k - n) - logc.shift(252 * k) for k in range(1, 6)], axis=1)
            x[name] = lags.mean(axis=1).where(lags.notna().sum(axis=1) >= 2)
    if "liquidity" in FEATURE_FLAGS:
        # Amihud illiquidity and its shocks, abnormal dollar volume, volume-conditioned reversal.
        dv = c * v
        illiq = (r.abs() / dv.replace(0, np.nan)).replace(np.inf, np.nan)
        x["amihud21"] = np.log(illiq.rolling(21, min_periods=15).mean() * 1e6)
        amihud63 = np.log(illiq.rolling(63, min_periods=40).mean() * 1e6)
        x["amihud_shock"] = x["amihud21"] - amihud63
        x["dvol_abn"] = np.log(dv.rolling(21).mean()) - np.log(dv.rolling(252).mean())
        x["turn_cv63"] = v.rolling(63).std() / v.rolling(63).mean().replace(0, np.nan)
        x["rev_hi_vol"] = x["ret5"] * (x["vol_rel5_63"] > 0.25).astype(float)
        x["rev_lo_vol"] = x["ret5"] * (x["vol_rel5_63"] < -0.25).astype(float)
    if "announce" in FEATURE_FLAGS:
        # Earnings announcements leave a footprint: a volume spike with a big
        # move. Days since the last one and the reaction to it (drift effects).
        med63 = v.rolling(63, min_periods=40).median().shift(1)
        sd63 = r.rolling(63, min_periods=40).std().shift(1)
        spike = (v > 2.5 * med63) & (r.abs() > 2.0 * sd63)
        pos = pd.Series(np.where(spike, np.arange(len(r)), np.nan), index=r.index).ffill()
        x["days_since_ann"] = (np.arange(len(r)) - pos).clip(upper=130) / 130.0
        x["ann_ret"] = (logc - logc.shift(2)).where(spike).ffill().where(x["days_since_ann"] < 0.5)
        x["ann_vol_ratio"] = (v / med63).where(spike).ffill().where(x["days_since_ann"] < 0.5)
    return x


# Indicator columns that are only there for the charts, not for the model.
CHART_ONLY = {"sma20", "sma50", "sma200", "bb_upper", "bb_lower"}


def context_features(market: pd.DataFrame, vix: pd.DataFrame | None, rates: pd.DataFrame | None,
                     extra: dict[str, pd.DataFrame] | None = None) -> pd.DataFrame:
    """Market-wide features, indexed by date (forward-filled onto other calendars later)."""
    c = market["close"]
    logc = np.log(c)
    r = logc.diff()
    x = pd.DataFrame(index=market.index)
    x["mkt_ret1"] = r
    x["mkt_ret5"] = logc - logc.shift(5)
    x["mkt_ret21"] = logc - logc.shift(21)
    x["mkt_ret63"] = logc - logc.shift(63)
    x["mkt_vol21"] = r.rolling(21).std() * np.sqrt(252)
    x["mkt_sma200_gap"] = c / c.rolling(200).mean() - 1
    x["mkt_rsi14"] = rsi(c, 14)
    x["mkt_dd252"] = c / c.rolling(252).max() - 1
    if vix is not None:
        vc = vix["close"].reindex(x.index).ffill()
        x["vix"] = vc
        x["vix_chg5"] = vc / vc.shift(5) - 1
        x["vix_rel63"] = vc / vc.rolling(63).mean() - 1
    if rates is not None:
        tc = rates["close"].reindex(x.index).ffill()
        x["tnx"] = tc
        x["tnx_chg21"] = tc - tc.shift(21)
    if "ctx2" in FEATURE_FLAGS and extra:
        # VIX term structure, SKEW, the dollar, credit spreads and the curve (altdata.py)
        import altdata
        x = x.join(altdata.context_extra_features(x.index, extra, vix["close"] if vix is not None else None), how="left")
    x["_mkt_r"] = r  # helper for betas, dropped later
    return x


# Exchanges that close before New York: on their trading day t the US session's
# close isn't known yet, so the US context must be lagged by one day for them.
EARLY_CLOSE_SUFFIXES = (".MI", ".PA", ".DE", ".AS", ".MC", ".SW", ".L", ".T", ".HK")


def build_panel(prices: dict[str, pd.DataFrame], context: pd.DataFrame,
                partial: set[str] | None = None, sectors: dict[str, str] | None = None,
                sector_prices: dict[str, pd.DataFrame] | None = None,
                extra: dict[str, pd.DataFrame] | None = None) -> tuple[pd.DataFrame, list[str]]:
    """One row per (symbol, date) with every feature and target.

    `partial` names the symbols whose last bar is today's unfinished session:
    their last row is kept for forecasting, but no training target may use its
    (not yet final) close. `sectors` maps symbols to sector names and
    `sector_prices` sector names to a price frame (an ETF), for the sector
    pack. `extra` maps a symbol to a frame of dated, already point-in-time
    features (the fund and earn packs from altdata.py), joined on the stock's own
    calendar. Returns the panel and the feature column names.
    """
    frames = []
    ctx = context.copy()
    partial = partial or set()
    sectors = sectors or {}
    sector_ctx = {}
    if "sector" in FEATURE_FLAGS and sector_prices:
        for name, sdf in sector_prices.items():
            lc = np.log(sdf["close"])
            sector_ctx[name] = pd.DataFrame({
                "sec_ret5": lc - lc.shift(5), "sec_ret21": lc - lc.shift(21), "sec_ret63": lc - lc.shift(63),
                "sec_mom12_1": (lc - lc.shift(252)) - (lc - lc.shift(21)),
            })
    for sym, df in prices.items():
        x = indicators(df)
        x["symbol"] = sym
        x["close"] = df["close"]
        if sym.endswith(EARLY_CLOSE_SUFFIXES):
            # The last US close known at the previous local session (so a US
            # holiday doesn't push the context back an extra day)
            ctx_sym = ctx.reindex(x.index, method="ffill").shift(1)
        else:
            ctx_sym = ctx.reindex(x.index).ffill()
        joined = x.join(ctx_sym, how="left")
        # Relative strength and rolling beta against the market
        mr = joined["_mkt_r"]
        joined["rs21"] = joined["ret21"] - joined["mkt_ret21"]
        joined["rs63"] = joined["ret63"] - joined["mkt_ret63"]
        cov = joined["ret1"].rolling(63).cov(mr)
        var = mr.rolling(63).var()
        joined["beta63"] = cov / var.replace(0, np.nan)
        joined["corr63"] = joined["ret1"].rolling(63).corr(mr)
        if "resid" in FEATURE_FLAGS:
            # Returns net of the market: residual reversal and momentum, and
            # idiosyncratic volatility, which are cleaner than their raw versions.
            cov252 = joined["ret1"].rolling(252, min_periods=126).cov(mr)
            var252 = mr.rolling(252, min_periods=126).var()
            beta252 = (cov252 / var252.replace(0, np.nan)).clip(-1, 4)
            e = joined["ret1"] - beta252.shift(1).fillna(1.0) * mr
            joined["beta252"] = beta252
            joined["ivol21"] = e.rolling(21).std() * np.sqrt(252)
            joined["ivol63"] = e.rolling(63).std() * np.sqrt(252)
            joined["ivol_ratio"] = joined["ivol21"] / joined["ivol63"].replace(0, np.nan)
            joined["resrev5"] = e.rolling(5).sum()
            joined["resrev21"] = e.rolling(21).sum()
            e_std = e.rolling(252, min_periods=126).std().replace(0, np.nan)
            joined["resmom12_1"] = (e.rolling(252, min_periods=200).sum() - e.rolling(21).sum()) / e_std
        if sector_ctx:
            sec = sectors.get(sym)
            sc = sector_ctx.get(sec)
            if sc is not None:
                if sym.endswith(EARLY_CLOSE_SUFFIXES):
                    sc_sym = sc.reindex(joined.index, method="ffill").shift(1)
                else:
                    sc_sym = sc.reindex(joined.index).ffill()
                joined = joined.join(sc_sym, how="left")
            else:
                for col in ("sec_ret5", "sec_ret21", "sec_ret63", "sec_mom12_1"):
                    joined[col] = np.nan
            joined["sec_rs21"] = joined["sec_ret21"] - joined["mkt_ret21"]
            joined["sec_rs63"] = joined["sec_ret63"] - joined["mkt_ret63"]
            joined["vs_sec5"] = joined["ret5"] - joined["sec_ret5"]
            joined["vs_sec21"] = joined["ret21"] - joined["sec_ret21"]
            joined["vs_sec_mom"] = joined["mom12_1"] - joined["sec_mom12_1"]
            joined = joined.drop(columns=["sec_ret63"])
        # Targets: forward log return over h days, raw and volatility-normalised
        logc = np.log(df["close"])
        daily_vol = joined["ret1"].rolling(21).std().clip(lower=MIN_DAILY_VOL)
        for hzn in HORIZONS:
            fwd = logc.shift(-hzn) - logc
            sigma = daily_vol * np.sqrt(hzn)
            joined[f"sigma_{hzn}"] = sigma
            joined[f"y_{hzn}"] = fwd
            joined[f"z_{hzn}"] = (fwd / sigma).clip(-TARGET_CLIP, TARGET_CLIP)
            if sym in partial:
                joined.iloc[-(hzn + 1):, joined.columns.get_indexer([f"y_{hzn}", f"z_{hzn}"])] = np.nan
        if extra and sym in extra and len(extra[sym].columns):
            joined = joined.join(extra[sym].reindex(joined.index, method="ffill"), how="left")
        if "membership" in FEATURE_FLAGS and sym in MEMBERSHIP:
            # Before a stock joined the index nobody would have had it in this
            # universe: drop those rows so they never shape the cross-section
            # (after the targets, so the first weeks keep their volatility scale).
            joined = joined[joined.index >= MEMBERSHIP[sym]]
        frames.append(joined)

    panel = pd.concat(frames)
    panel.index.name = "date"
    panel = panel.reset_index().set_index(["date", "symbol"]).sort_index()
    panel = panel.drop(columns=["_mkt_r"])

    by_date = panel.groupby(level="date")
    # Cross-sectional ranks: how a stock compares with the others on the same day
    ranked = list(RANKED)
    for flag, cols in RANKED_OPTIONAL.items():
        if flag in FEATURE_FLAGS:
            ranked += [c for c in cols if c in panel.columns]
    if "cs_ranks" in FEATURE_FLAGS:
        ranked += [c for c in RANKED_EXTRA if c in panel.columns and c not in ranked]
    for col in ranked:
        panel[f"rank_{col}"] = by_date[col].rank(pct=True) - 0.5
    if "sector" in FEATURE_FLAGS and sectors:
        # Peer-group means from the panel itself (leave-one-out, so a stock never
        # sees its own return) and ranks within the sector; only for groups
        # with enough members on the day.
        sec_key = panel.index.get_level_values("symbol").map(lambda s: sectors.get(s))
        panel["_sec"] = np.asarray(sec_key, dtype=object)
        by_sec = panel.groupby([panel.index.get_level_values("date"), panel["_sec"]], dropna=True)
        size = by_sec["ret1"].transform("count").reindex(panel.index)
        ok = (size >= 8).fillna(False)
        for col in ("ret1", "ret5", "ret21", "mom12_1"):
            total = by_sec[col].transform("sum").reindex(panel.index)
            n = by_sec[col].transform("count").reindex(panel.index)
            own = panel[col].notna()
            loo = (total - panel[col].fillna(0)) / (n - own.astype(int)).replace(0, np.nan)
            panel[f"peer_{col}"] = loo.where(ok)
            panel[f"vs_peer_{col}"] = (panel[col] - loo).where(ok)
        for col in ("mom12_1", "ret5", "ret21", "vol21"):
            panel[f"secrank_{col}"] = (by_sec[col].rank(pct=True) - 0.5).reindex(panel.index).where(ok)
        panel = panel.drop(columns=["_sec", "peer_mom12_1"])
    # Relative targets: the stock's normalised return minus the day's average
    # across all stocks. This is what the model learns, because which stocks
    # beat the others is predictable in a way that the market's level isn't.
    if BETA_SHRINK > 0:
        # Take out each stock's (shrunk) beta times the universe move before
        # ranking, so the label rewards stock picking rather than a beta tilt.
        beta_s = BETA_SHRINK * panel["beta63"].clip(0, 2.5).fillna(1.0) + (1 - BETA_SHRINK)
    for hzn in HORIZONS:
        if BETA_SHRINK > 0:
            mkt = by_date[f"y_{hzn}"].transform("mean")
            zb = ((panel[f"y_{hzn}"] - beta_s * mkt) / panel[f"sigma_{hzn}"]).clip(-TARGET_CLIP, TARGET_CLIP)
        else:
            zb = panel[f"z_{hzn}"]
        panel[f"zr_{hzn}"] = zb - zb.groupby(level="date").transform("mean")
        panel[f"zrank_{hzn}"] = zb.groupby(level="date").rank(pct=True) - 0.5

    if "fundlite" in FEATURE_FLAGS and "rank_ey" in panel.columns:
        # Three composites instead of seventeen quarterly columns: the trees were
        # drowning in slow-moving, mostly-missing features. Value, quality and
        # fundamental momentum, each the average of its ranks.
        panel["fund_value"] = panel[["rank_ey", "rank_bm", "rank_cfy"]].mean(axis=1)
        panel["fund_quality"] = pd.concat([panel["rank_roa"], -panel["rank_ag"], -panel["rank_accr"]], axis=1).mean(axis=1)
        panel["fund_mom"] = panel["rank_fmom"]
        drop = [c for c in panel.columns if c in ("ey", "bm", "sp", "cfy", "roa", "cfoa", "ag", "fmom", "accr", "filing_age")
                or c in ("rank_ey", "rank_bm", "rank_cfy", "rank_roa", "rank_ag", "rank_fmom", "rank_accr")]
        panel = panel.drop(columns=drop)
    panel = panel.copy()  # defragment after the many column inserts
    skip = CHART_ONLY | {"close"}
    skip |= {c for c in panel.columns if c.startswith(("y_", "z_", "zr_", "zrank_", "sigma_"))}
    if "cs_ranks" in FEATURE_FLAGS:
        skip |= {f"rank_{c}" for c in RANKED_EXTRA}  # for the rank-on-rank ridge only, not the trees
    features = [c for c in panel.columns if c not in skip]
    # float32 halves memory for the big panel without affecting the models
    panel[features] = panel[features].astype("float32")
    return panel, features


RANKED = ("ret1", "ret5", "ret10", "ret21", "ret63", "mom12_1", "vol21", "vol_ratio", "rsi2", "rsi14",
          "bb_pctb", "sma50_gap", "sma200_gap", "dd252", "pos52", "vol_rel20", "updown_vol", "skew63",
          "dvol63", "beta63", "dollar_vol", "max_r21", "min_r21", "macd_hist", "slope63")
# Ranks added with each optional pack, and the extra ranks a rank-on-rank ridge can use
RANKED_OPTIONAL = {"resid": ("resrev21", "resmom12_1", "ivol21"), "momshape": ("fip", "mom12_7"),
                   "fund": ("ey", "bm", "cfy", "roa", "ag", "fmom", "accr"), "earn": ("sue_last", "ear_ret"),
                   "overnight": ("on21",), "seasonality": ("seas63",), "liquidity": ("dvol_abn", "amihud21")}
RANKED_EXTRA = ("ret126", "ret252", "streak", "vol10", "vol63", "atr_pct", "sma20_gap", "sma50_200", "slope20", "macd",
                "macd_hist_chg", "stoch_k", "bb_width", "days_since_high", "vol_rel5_63", "obv_slope", "intraday", "gap",
                "range_pct", "close_pos", "rs21", "rs63", "corr63")
BETA_SHRINK = 0.5  # 0 keeps the plain vol-normalised target; 0.5 = shrunk-beta residual target (production)
MEMBERSHIP: dict[str, pd.Timestamp] = {}  # symbol -> first date it belongs to the cross-section (see build_membership.py)
