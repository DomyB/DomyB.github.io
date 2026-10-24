"""Fundamental analysis: fair value estimates and a 0–100 fundamental score.

This side of the page is deliberately rule-based and transparent. Fundamentals
move slowly, so they say little about next week, but they are the only thing
that says anything about the next year. The fair value comes from the valuation
toolkit in valuation.py, which applies the methods an investment bank's
football field is built from (trading comparables, a WACC-discounted cash
flow, residual income for banks, a leveraged-buyout floor, a control premium,
analyst targets) and blends the ones that estimate a fair value geometrically.
Every input, intermediate value and sub-score is written to the JSON so the
page can show exactly where a number came from.
"""
from __future__ import annotations

import math

import numpy as np

import valuation

FINANCIAL_SECTORS = {"Financial Services", "Financial"}


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _interp(x, points):
    """Piecewise-linear score: points is [(x0, s0), (x1, s1), ...] with x ascending."""
    if x is None:
        return None
    xs, ys = zip(*points)
    return float(np.interp(x, xs, ys))


def _mean(values):
    vals = [v for v in values if v is not None]
    return float(np.mean(vals)) if vals else None


def sector_medians(infos: dict[str, dict]) -> dict[str, dict[str, float]]:
    """Median valuation multiples across `infos`, per industry ("industry:<name>"),
    per sector and overall ("_all"); a group needs at least three members."""
    return valuation.medians_from(valuation.peer_groups(infos))


def _peer_multiple(info, medians, field, allow_all=True):
    """The closest peer group's median: the industry first, then the sector, then everyone."""
    keys = ["industry:" + info["industry"]] if info.get("industry") else []
    keys.append(info.get("sector") or "_")
    if allow_all:
        keys.append("_all")
    for key in keys:
        v = medians.get(key, {}).get(field)
        if v:
            return v
    return None


def fair_value(info: dict, price: float, peers: dict, risk_free: float | None = None, fx: dict | None = None,
               symbol: str | None = None) -> dict:
    """Fair value estimates for one stock: every method, the football field and the
    blend. `peers` is valuation.peer_groups(...)."""
    return valuation.valuation(info, price, peers or {}, risk_free, fx, symbol)


def fundamental_score(info: dict, price: float, medians: dict, fv: dict) -> dict:
    """Sub-scores (0–100) for valuation, quality, growth, safety and sentiment, and their weighted total."""
    if not info or info.get("quoteType") == "ETF":
        return {}
    sector = info.get("sector") or ""
    financial = sector in FINANCIAL_SECTORS
    f = lambda k: _num(info.get(k))  # noqa: E731

    # Valuation
    mos = fv.get("marginOfSafety")
    peer_pe = _peer_multiple(info, medians, "forwardPE")
    pe_rel = (f("forwardPE") / peer_pe) if f("forwardPE") and peer_pe else None
    peg = f("trailingPegRatio") or f("pegRatio")
    valuation = _mean([
        _interp(mos, [(-0.4, 5), (-0.15, 35), (0, 50), (0.15, 65), (0.4, 95)]),
        _interp(pe_rel, [(0.5, 85), (0.8, 65), (1.0, 50), (1.5, 25), (2.5, 5)]),
        _interp(peg, [(0.5, 90), (1.0, 70), (1.5, 50), (2.5, 30), (4.0, 10)]) if peg and peg > 0 else None,
    ])

    # Quality
    revenue = f("totalRevenue")
    fcf_margin = (f("freeCashflow") / revenue) if f("freeCashflow") is not None and revenue else None
    quality = _mean([
        _interp(f("returnOnEquity"), [(-0.1, 5), (0, 25), (0.10, 50), (0.20, 70), (0.35, 90)]),
        _interp(f("operatingMargins"), [(-0.1, 5), (0, 25), (0.10, 50), (0.25, 75), (0.40, 92)]),
        None if financial else _interp(fcf_margin, [(-0.05, 10), (0, 30), (0.08, 55), (0.18, 75), (0.30, 92)]),
        _interp(f("grossMargins"), [(0.1, 25), (0.3, 45), (0.5, 65), (0.7, 85)]),
    ])

    # Growth
    eps_growth = fv.get("inputs", {}).get("expectedGrowth")
    growth = _mean([
        _interp(f("revenueGrowth"), [(-0.15, 5), (-0.05, 25), (0, 38), (0.08, 55), (0.20, 78), (0.40, 95)]),
        _interp(f("earningsGrowth"), [(-0.3, 5), (-0.1, 25), (0, 40), (0.10, 55), (0.30, 78), (0.60, 95)]),
        _interp(eps_growth, [(-0.1, 10), (0, 40), (0.08, 55), (0.15, 70), (0.30, 92)]),
    ])

    # Safety
    safety = _mean([
        None if financial else _interp(f("debtToEquity"), [(0, 90), (50, 70), (100, 55), (200, 30), (400, 8)]),
        None if financial else _interp(f("currentRatio"), [(0.6, 15), (1.0, 40), (1.5, 65), (2.5, 85)]),
        _interp(f("beta"), [(0.5, 85), (0.8, 70), (1.0, 60), (1.5, 40), (2.2, 15)]),
        _interp(dividend_yield(info, price) * 100, [(0, 45), (1.5, 55), (3.5, 70), (6, 60)]),
    ])

    # Sentiment
    upside = (f("targetMeanPrice") / price - 1) if f("targetMeanPrice") and price else None
    sentiment = _mean([
        _interp(f("recommendationMean"), [(1.0, 92), (2.0, 72), (3.0, 48), (4.0, 25), (5.0, 8)]),
        _interp(upside, [(-0.25, 10), (-0.1, 30), (0, 50), (0.15, 70), (0.35, 90)]),
        _interp(f("shortPercentOfFloat"), [(0, 72), (0.02, 62), (0.05, 50), (0.10, 35), (0.20, 15)]),
    ])

    parts = {"valuation": valuation, "quality": quality, "growth": growth, "safety": safety, "sentiment": sentiment}
    weights = {"valuation": 0.35, "quality": 0.25, "growth": 0.20, "safety": 0.10, "sentiment": 0.10}
    avail = {k: v for k, v in parts.items() if v is not None}
    total = sum(weights[k] for k in avail)
    score = sum(weights[k] * v for k, v in avail.items()) / total if total else None
    return {"score": score, "parts": parts, "details": {
        "peRelativeToPeers": pe_rel, "peerForwardPE": peer_pe, "peg": peg, "fcfMargin": fcf_margin,
        "analystUpside": upside,
    }}


def dividend_yield(info: dict, price: float | None) -> float:
    """Dividend yield as a fraction. Yahoo reports `dividendYield` in percent in
    some versions and as a fraction in others, so the yearly dividend per share
    divided by the price is used whenever it exists."""
    rate = _num(info.get("dividendRate"))
    if rate is not None and price:
        return max(0.0, rate / price)
    dy = _num(info.get("dividendYield"))
    if dy is None:
        return 0.0
    return dy / 100.0 if dy > 0.3 else dy  # no stock yields 30%: above that it must be percent


def fundamental_view(fv: dict, info: dict, price: float | None = None) -> dict | None:
    """A 12-month expected return from the valuation gap: assume half of it closes in a year, plus dividends."""
    mos = fv.get("marginOfSafety")
    if mos is None:
        return None
    dy = dividend_yield(info, price)
    expected = float(np.clip(0.5 * mos, -0.35, 0.45)) + dy
    label = "undervalued" if mos > 0.15 else "overvalued" if mos < -0.15 else "fairly valued"
    return {"expectedReturn12m": expected, "label": label, "dividendYield": dy}
