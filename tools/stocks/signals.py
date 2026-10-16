"""Plain-language technical readings and a 0–100 technical score.

The machine-learned forecast says *what* the model expects; this module says
*what the chart looks like* in terms a reader knows: trend, momentum,
overbought/oversold, volume and volatility. Each reading carries a stance
(bullish, bearish or neutral) and the score weighs them together.
"""
from __future__ import annotations

import math

import numpy as np


def _f(row, key):
    v = row.get(key)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _pct(x, digits=1):
    return f"{x * 100:+.{digits}f}%"


def technical_readings(row: dict) -> tuple[list[dict], dict]:
    """Readings for the latest row of indicators. Returns (readings, part scores)."""
    readings: list[dict] = []
    parts: dict[str, float] = {}

    def add(group, name, value, detail, stance):
        readings.append({"group": group, "name": name, "value": value, "detail": detail, "stance": stance})

    # --- Trend ---------------------------------------------------------------
    g50, g200, cross = _f(row, "sma50_gap"), _f(row, "sma200_gap"), _f(row, "sma50_200")
    slope = _f(row, "slope63")
    trend_pts = []
    if g50 is not None and g200 is not None:
        if g50 > 0 and g200 > 0:
            add("trend", "Moving averages", "Above the 50- and 200-day averages",
                f"{_pct(g50)} vs the 50-day, {_pct(g200)} vs the 200-day.", "bullish")
            trend_pts.append(80)
        elif g50 < 0 and g200 < 0:
            add("trend", "Moving averages", "Below the 50- and 200-day averages",
                f"{_pct(g50)} vs the 50-day, {_pct(g200)} vs the 200-day.", "bearish")
            trend_pts.append(20)
        else:
            add("trend", "Moving averages", "Between the 50- and 200-day averages",
                f"{_pct(g50)} vs the 50-day, {_pct(g200)} vs the 200-day.", "neutral")
            trend_pts.append(50)
    if cross is not None:
        if cross > 0.01:
            add("trend", "Golden cross", "50-day average above the 200-day", f"By {_pct(cross)}.", "bullish")
            trend_pts.append(70)
        elif cross < -0.01:
            add("trend", "Death cross", "50-day average below the 200-day", f"By {_pct(cross)}.", "bearish")
            trend_pts.append(30)
        else:
            add("trend", "Average crossover", "50- and 200-day averages are touching", "A trend change may be under way.", "neutral")
            trend_pts.append(50)
    if slope is not None:
        annual = math.expm1(slope * 252)
        stance = "bullish" if slope > 0.0004 else "bearish" if slope < -0.0004 else "neutral"
        add("trend", "3-month slope", f"{_pct(annual, 0)} a year at this pace",
            "The slope of a straight line through the last 63 closes.", stance)
        trend_pts.append(float(np.clip(50 + slope * 25000, 10, 90)))
    if trend_pts:
        parts["trend"] = float(np.mean(trend_pts))

    # --- Momentum ------------------------------------------------------------
    mom, r21, r63 = _f(row, "mom12_1"), _f(row, "ret21"), _f(row, "ret63")
    rank_mom = _f(row, "rank_mom12_1")
    hist, hist_chg = _f(row, "macd_hist"), _f(row, "macd_hist_chg")
    mom_pts = []
    if mom is not None:
        simple = math.expm1(mom)
        if rank_mom is not None:
            pct = (rank_mom + 0.5) * 100
            where = f"Stronger than {pct:.0f}% of the tracked stocks."
            stance = "bullish" if pct >= 65 else "bearish" if pct <= 35 else "neutral"
            mom_pts.append(float(np.clip(pct, 5, 95)))
        else:
            where, stance = "", "bullish" if simple > 0.1 else "bearish" if simple < -0.1 else "neutral"
            mom_pts.append(float(np.clip(50 + simple * 100, 5, 95)))
        add("momentum", "12-month momentum", _pct(simple, 0),
            f"Return over the past year, skipping the last month. {where}".strip(), stance)
    if r21 is not None and r63 is not None:
        add("momentum", "Recent returns", f"{_pct(math.expm1(r21))} in a month, {_pct(math.expm1(r63))} in three",
            "Short-term momentum tends to persist over a few months, but a very large one-month jump often gives some back.",
            "bullish" if r63 > 0.03 else "bearish" if r63 < -0.03 else "neutral")
        mom_pts.append(float(np.clip(50 + r63 * 200, 10, 90)))
    if hist is not None:
        rising = hist_chg is not None and hist_chg > 0
        if hist > 0:
            add("momentum", "MACD", "Positive" + (" and rising" if rising else " but fading"),
                "The 12-day average is pulling away from the 26-day one." if rising else "The gap between the 12- and 26-day averages is closing.",
                "bullish" if rising else "neutral")
            mom_pts.append(70 if rising else 55)
        else:
            add("momentum", "MACD", "Negative" + (" but improving" if rising else " and falling"),
                "The 12-day average is below the 26-day one.", "neutral" if rising else "bearish")
            mom_pts.append(45 if rising else 30)
    if mom_pts:
        parts["momentum"] = float(np.mean(mom_pts))

    # --- Overbought / oversold ----------------------------------------------
    rsi, rsi2, pctb = _f(row, "rsi14"), _f(row, "rsi2"), _f(row, "bb_pctb")
    pos52, dd = _f(row, "pos52"), _f(row, "dd252")
    osc_pts = []
    if rsi is not None:
        if rsi >= 75:
            add("oscillators", "RSI (14 days)", f"{rsi:.0f}: overbought", "Strong buying, but stretched; pullbacks are common from here.", "bearish")
            osc_pts.append(35)
        elif rsi >= 55:
            add("oscillators", "RSI (14 days)", f"{rsi:.0f}: healthy", "In the zone that goes with a steady uptrend.", "bullish")
            osc_pts.append(70)
        elif rsi > 30:
            add("oscillators", "RSI (14 days)", f"{rsi:.0f}: soft", "Sellers have had the upper hand lately.", "neutral")
            osc_pts.append(42)
        else:
            add("oscillators", "RSI (14 days)", f"{rsi:.0f}: oversold", "Heavily sold; short-term bounces often start here.", "bullish")
            osc_pts.append(55)
    if pctb is not None:
        if pctb > 1:
            add("oscillators", "Bollinger bands", "Above the upper band", "The price is more than two standard deviations above its 20-day average.", "bearish")
            osc_pts.append(35)
        elif pctb < 0:
            add("oscillators", "Bollinger bands", "Below the lower band", "The price is more than two standard deviations below its 20-day average.", "bullish")
            osc_pts.append(60)
        else:
            add("oscillators", "Bollinger bands", f"{pctb * 100:.0f}% of the way from lower to upper band", "Inside the bands.", "neutral")
            osc_pts.append(50)
    if rsi2 is not None:
        if rsi2 < 10:
            add("oscillators", "Short-term reversal", f"2-day RSI {rsi2:.0f}", "Very oversold over the last two days; the next few days tend to be better than average.", "bullish")
        elif rsi2 > 90:
            add("oscillators", "Short-term reversal", f"2-day RSI {rsi2:.0f}", "Very overbought over the last two days; the next few days tend to be weaker than average.", "bearish")
    if pos52 is not None and dd is not None:
        if dd > -0.03:
            add("oscillators", "52-week range", "At or near the 52-week high", f"{_pct(dd)} from the high.", "bullish")
        elif pos52 < 0.2:
            add("oscillators", "52-week range", "Near the 52-week low", f"{_pct(dd)} from the high.", "bearish")
        else:
            add("oscillators", "52-week range", f"{pos52 * 100:.0f}% of the way from low to high", f"{_pct(dd)} from the 52-week high.", "neutral")
    if osc_pts:
        parts["oscillators"] = float(np.mean(osc_pts))

    # --- Volume --------------------------------------------------------------
    updown, obv, vrel = _f(row, "updown_vol"), _f(row, "obv_slope"), _f(row, "vol_rel5_63")
    vol_pts = []
    if updown is not None:
        share = (updown + 0.5) * 100
        stance = "bullish" if share >= 56 else "bearish" if share <= 44 else "neutral"
        add("volume", "Up-day volume", f"{share:.0f}% of the last month's volume traded on up days",
            "Volume on rising days versus falling days.", stance)
        vol_pts.append(float(np.clip(share, 10, 90)))
    if obv is not None:
        stance = "bullish" if obv > 0.5 else "bearish" if obv < -0.5 else "neutral"
        add("volume", "On-balance volume", "Rising" if obv > 0.5 else "Falling" if obv < -0.5 else "Flat",
            "Whether volume is flowing in or out over the last 20 days.", stance)
        vol_pts.append(float(np.clip(50 + obv * 15, 15, 85)))
    if vrel is not None:
        add("volume", "Activity", f"{_pct(vrel, 0)} vs the 3-month average",
            "Volume over the last five days compared with the last three months.", "neutral")
    if vol_pts:
        parts["volume"] = float(np.mean(vol_pts))

    # --- Volatility ----------------------------------------------------------
    v21, vratio = _f(row, "vol21"), _f(row, "vol_ratio")
    if v21 is not None:
        add("volatility", "Volatility", f"{v21 * 100:.0f}% a year",
            "Annualised standard deviation of daily moves over the last month." +
            ("" if vratio is None else f" The last two weeks were {'calmer' if vratio < 0.85 else 'wilder' if vratio > 1.2 else 'about as volatile'} as the last three months."),
            "neutral")
        parts["volatility"] = float(np.clip(70 - (vratio - 1) * 40, 20, 80)) if vratio is not None else 50.0

    return readings, parts


def technical_score(parts: dict) -> float | None:
    weights = {"trend": 0.30, "momentum": 0.30, "oscillators": 0.15, "volume": 0.15, "volatility": 0.10}
    avail = {k: v for k, v in parts.items() if v is not None}
    total = sum(weights[k] for k in avail)
    return float(sum(weights[k] * v for k, v in avail.items()) / total) if total else None
