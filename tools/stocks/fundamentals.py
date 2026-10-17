"""Fundamental analysis: fair value estimates and a 0–100 fundamental score.

This side of the page is deliberately rule-based and transparent. Fundamentals
move slowly, so they say little about next week, but they are the only thing
that says anything about the next year. Three classic valuation methods are
blended:

* **Earnings power** – next year's expected earnings per share times a
  justified price/earnings ratio (half from what the market pays for the
  company's sector peers, half from the company's own expected growth).
* **Discounted cash flow** – ten years of free cash flow, growing at the
  recent revenue growth rate and fading to 2.5%, discounted at a rate that
  rises with the stock's beta, plus net cash.
* **Analyst consensus** – the mean 12-month target when enough analysts cover
  the stock.

Every input, intermediate value and sub-score is written to the JSON so the
page can show exactly where a number came from.
"""
from __future__ import annotations

import math

import numpy as np

RISK_FREE = 0.042       # 10-year Treasury yield used in the discount rate
EQUITY_PREMIUM = 0.05   # extra return demanded for holding stocks
TERMINAL_GROWTH = 0.025
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
    """Median valuation multiples across the tracked stocks, per industry (key
    "industry:<name>"), per sector and overall ("_all"). A group needs at least
    three members to count, so a lone company is never its own peer."""
    fields = ["forwardPE", "trailingPE", "enterpriseToEbitda", "priceToBook", "priceToSalesTrailing12Months"]
    buckets: dict[str, dict[str, list]] = {}
    for info in infos.values():
        if info.get("quoteType") == "ETF":
            continue
        keys = [info.get("sector") or "_", "_all"]
        if info.get("industry"):
            keys.append("industry:" + info["industry"])
        for key in keys:
            b = buckets.setdefault(key, {f: [] for f in fields})
            for f in fields:
                v = _num(info.get(f))
                if v is not None and 0 < v < 200:
                    b[f].append(v)
    out = {}
    for key, b in buckets.items():
        out[key] = {f: float(np.median(v)) for f, v in b.items() if len(v) >= (3 if key != "_all" else 1)}
    return out


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


def fair_value(info: dict, price: float, medians: dict) -> dict:
    """Fair value estimates for one stock. Returns inputs, each method's value and the blend."""
    out = {"methods": {}, "inputs": {}}
    if not info or info.get("quoteType") == "ETF" or not price:
        return out

    eps_f = _num(info.get("forwardEps"))
    eps_t = _num(info.get("trailingEps"))
    shares = _num(info.get("sharesOutstanding"))
    fcf = _num(info.get("freeCashflow"))
    cash = _num(info.get("totalCash")) or 0.0
    debt = _num(info.get("totalDebt")) or 0.0
    beta = _num(info.get("beta"))
    rev_growth = _num(info.get("revenueGrowth"))
    earn_growth = _num(info.get("earningsGrowth"))
    book = _num(info.get("bookValue"))
    sector = info.get("sector") or ""
    financial = sector in FINANCIAL_SECTORS

    # Expected earnings growth: forward vs trailing EPS, else reported growth, capped to sane values
    growth = None
    if eps_f and eps_t and eps_t > 0:
        growth = eps_f / eps_t - 1
    elif earn_growth is not None:
        growth = earn_growth
    if growth is not None:
        # Earnings can't outgrow revenue by much for long: a one-year EPS rebound
        # (after a write-down, say) must not buy a growth stock's multiple
        if rev_growth is not None:
            growth = min(growth, max(rev_growth, 0.0) + 0.10)
        growth = float(np.clip(growth, -0.10, 0.30))
    out["inputs"].update({
        "forwardEps": eps_f, "trailingEps": eps_t, "expectedGrowth": growth, "beta": beta,
        "revenueGrowth": rev_growth, "freeCashflow": fcf, "totalCash": cash, "totalDebt": debt,
        "sharesOutstanding": shares, "bookValue": book,
    })

    # 1. Earnings power
    peer_pe = _peer_multiple(info, medians, "forwardPE", allow_all=not financial)
    if eps_f and eps_f > 0:
        growth_pe = 8.0 + 1.2 * (growth * 100 if growth is not None else 6.0)  # a damped Graham formula
        hi = 18.0 if financial else 40.0  # banks and insurers never trade like software companies
        growth_pe = float(np.clip(growth_pe, 7.0, hi))
        justified = float(np.clip(peer_pe, 7.0, hi)) if peer_pe else growth_pe
        pe_used = 0.5 * justified + 0.5 * growth_pe
        out["methods"]["earnings"] = {
            "value": eps_f * pe_used, "peerPE": peer_pe, "growthPE": growth_pe, "justifiedPE": pe_used,
            "label": "Earnings power",
        }

    # 2. Discounted cash flow (not for banks and insurers, whose cash flow isn't comparable)
    if not financial and fcf and fcf > 0 and shares and shares > 0:
        b = float(np.clip(beta if beta is not None else 1.0, 0.5, 2.0))
        rate = float(np.clip(RISK_FREE + b * EQUITY_PREMIUM, 0.07, 0.13))
        g1 = float(np.clip(rev_growth if rev_growth is not None else 0.04, -0.05, 0.20))
        pv, cf = 0.0, fcf
        for year in range(1, 11):
            g = g1 if year <= 5 else g1 + (TERMINAL_GROWTH - g1) * (year - 5) / 5.0
            cf *= 1 + g
            pv += cf / (1 + rate) ** year
        terminal = cf * (1 + TERMINAL_GROWTH) / (rate - TERMINAL_GROWTH) / (1 + rate) ** 10
        equity = pv + terminal + cash - debt
        out["methods"]["dcf"] = {
            "value": equity / shares, "discountRate": rate, "growth5y": g1, "terminalGrowth": TERMINAL_GROWTH,
            "label": "Discounted cash flow",
        }

    # 2b. Book value for financials (peers from the same industry or sector only: a
    #     payments network's price-to-book says nothing about a bank)
    if financial and book and book > 0:
        peer_pb = _peer_multiple(info, medians, "priceToBook", allow_all=False)
        if peer_pb:
            out["methods"]["book"] = {"value": book * float(np.clip(peer_pb, 0.5, 2.5)), "peerPB": peer_pb,
                                      "label": "Book value × peer multiple"}

    # 3. Analyst consensus
    target = _num(info.get("targetMeanPrice"))
    n_analysts = _num(info.get("numberOfAnalystOpinions")) or 0
    if target and n_analysts >= 4:
        out["methods"]["analysts"] = {"value": target, "analysts": int(n_analysts), "label": "Analyst consensus"}

    weights = {"earnings": 0.4, "dcf": 0.35, "book": 0.35, "analysts": 0.25}
    # Sanity rule before blending: a method more than 5× away from the price is a
    # data error or a method that doesn't apply, not an opinion (Yahoo reports
    # Berkshire's book value per Class A share; a simple cash-flow model says
    # nothing about a company spending all its cash flow on data centres): drop
    # it, and say so. Once anything was dropped, one survivor isn't enough.
    dropped = {}
    for k, m in out["methods"].items():
        if not (price / 5.0 <= m["value"] <= price * 5.0):
            dropped[k] = "implausible"
    kept = {k: m for k, m in out["methods"].items() if k not in dropped}
    for k, why in dropped.items():
        out["methods"][k]["dropped"] = why
    if kept and (not dropped or len(kept) >= 2):
        # A weighted geometric mean: 3× too high and 3× too low then cancel out,
        # and one generous method can't drag the blend the way an average lets it
        total = sum(weights[k] for k in kept)
        blended = math.exp(sum(weights[k] * math.log(m["value"]) for k, m in kept.items()) / total)
        # Never let one wild method dominate: cap the blend within 0.3×–3× the price
        blended = float(np.clip(blended, 0.3 * price, 3.0 * price))
        out["value"] = blended
        out["marginOfSafety"] = blended / price - 1
    elif out["methods"]:
        out["note"] = "The valuation methods disagree too much to give one number."
    return out


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
