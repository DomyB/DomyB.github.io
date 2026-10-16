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
    return x


# Indicator columns that are only there for the charts, not for the model.
CHART_ONLY = {"sma20", "sma50", "sma200", "bb_upper", "bb_lower"}


def context_features(market: pd.DataFrame, vix: pd.DataFrame | None, rates: pd.DataFrame | None) -> pd.DataFrame:
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
    x["_mkt_r"] = r  # helper for betas, dropped later
    return x


def build_panel(prices: dict[str, pd.DataFrame], context: pd.DataFrame,
                partial: set[str] | None = None) -> tuple[pd.DataFrame, list[str]]:
    """One row per (symbol, date) with every feature and target.

    `partial` names the symbols whose last bar is today's unfinished session:
    their last row is kept for forecasting, but no training target may use its
    (not yet final) close. Returns the panel and the feature column names.
    """
    frames = []
    ctx = context.copy()
    partial = partial or set()
    for sym, df in prices.items():
        x = indicators(df)
        x["symbol"] = sym
        x["close"] = df["close"]
        joined = x.join(ctx.reindex(x.index).ffill(), how="left")
        # Relative strength and rolling beta against the market
        mr = joined["_mkt_r"]
        joined["rs21"] = joined["ret21"] - joined["mkt_ret21"]
        joined["rs63"] = joined["ret63"] - joined["mkt_ret63"]
        cov = joined["ret1"].rolling(63).cov(mr)
        var = mr.rolling(63).var()
        joined["beta63"] = cov / var.replace(0, np.nan)
        joined["corr63"] = joined["ret1"].rolling(63).corr(mr)
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
        frames.append(joined)

    panel = pd.concat(frames)
    panel.index.name = "date"
    panel = panel.reset_index().set_index(["date", "symbol"]).sort_index()
    panel = panel.drop(columns=["_mkt_r"])

    by_date = panel.groupby(level="date")
    # Cross-sectional ranks: how a stock compares with the others on the same day
    for col in RANKED:
        panel[f"rank_{col}"] = by_date[col].rank(pct=True) - 0.5
    # Relative targets: the stock's normalised return minus the day's average
    # across all stocks. This is what the model learns, because which stocks
    # beat the others is predictable in a way that the market's level isn't.
    for hzn in HORIZONS:
        panel[f"zr_{hzn}"] = panel[f"z_{hzn}"] - by_date[f"z_{hzn}"].transform("mean")
        panel[f"zrank_{hzn}"] = by_date[f"z_{hzn}"].rank(pct=True) - 0.5

    skip = CHART_ONLY | {"close"}
    skip |= {c for c in panel.columns if c.startswith(("y_", "z_", "zr_", "zrank_", "sigma_"))}
    features = [c for c in panel.columns if c not in skip]
    # float32 halves memory for the big panel without affecting the models
    panel[features] = panel[features].astype("float32")
    return panel, features


RANKED = ("ret1", "ret5", "ret10", "ret21", "ret63", "mom12_1", "vol21", "vol_ratio", "rsi2", "rsi14",
          "bb_pctb", "sma50_gap", "sma200_gap", "dd252", "pos52", "vol_rel20", "updown_vol", "skew63",
          "dvol63", "beta63", "dollar_vol", "max_r21", "min_r21", "macd_hist", "slope63")
