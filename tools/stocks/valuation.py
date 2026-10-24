"""The valuation toolkit an investment bank's football field is built from.

Every method here is the textbook one, applied to Yahoo's company profile
(the only free, broad source) and written out in full so the page can show
each input, each intermediate number and each assumption:

* **Trading comparables** – what the market pays for the closest peers
  (industry first, then sector) per unit of forward earnings, EBITDA, sales
  or book value, applied to this company's own numbers. The quartiles of the
  peer group give the range, the median the point.
* **Discounted cash flow** – this year's unlevered free cash flow (the average
  of EBIT less tax plus depreciation less capital spending, and operating
  cash flow less capital spending and stock-based pay plus after-tax
  interest, all from the trailing twelve months of the statements), projected ten years with
  revenue growth fading to the terminal rate, capital spending above
  depreciation fading to depreciation plus growth, 3% of each year's extra
  revenue tied up in working capital, and
  discounted mid-year at a WACC assembled from the current 10-year Treasury
  yield, a Blume-adjusted beta, an equity risk premium, a credit spread that
  rises with leverage, the company's own tax rate and the market-value
  capital structure; a perpetuity-growth terminal value cross-checked with
  an exit multiple, and a WACC × growth sensitivity grid for the range.
* **Residual income** (banks, insurers and other lenders: the financial-sector
  names Yahoo reports no EBITDA for) – book value plus
  the present value of the excess of return on equity over the cost of
  equity, with the excess fading as competition catches up. A **dividend
  discount model** is shown next to it as a cross-check.
* **Leveraged buyout** – the most a financial buyer could pay and still earn
  a 20–25% annual return after five years, funding the deal with debt sized
  on EBITDA. A floor, not a fair value, and never blended.
* **Precedent transactions** – there is no free database of deal multiples,
  so the control premium acquirers typically pay (20–40%) is applied to the
  trading-comps value as a takeover reference. Display only.
* **Analyst targets** – the mean target is the third method in the blend;
  the analysts' low–high range and the **52-week range** are reference bars.

The point estimate blends comparables, the cash-flow (or residual-income)
model and the analysts geometrically, with the same sanity rules as before:
a method more than five times away from the price is a data error or a
method that doesn't apply, and is set aside.

Everything is in the stock's trading currency. Statement amounts reported in
another currency (an ADR whose accounts are in euros) are converted at the
current rate when one is known, otherwise the absolute-amount methods are
skipped and the page says so.
"""
from __future__ import annotations

import math

import numpy as np

RISK_FREE_DEFAULT = 0.042   # used when the pipeline has no fresh 10-year yield
EQUITY_PREMIUM = 0.05       # extra return demanded for holding stocks over Treasuries
TERMINAL_GROWTH = 0.025     # long-run nominal growth: roughly inflation plus a little
TAX_RATE = 0.23             # marginal rate on operating profit (US federal + state; Italy's IRES is 24%)
PROJECTION_YEARS = 10
NWC_PCT_OF_GROWTH = 0.03    # working capital tied up per unit of extra revenue
LBO_YEARS = 5
LBO_LEVERAGE = 5.5          # debt a sponsor can raise, as a multiple of EBITDA
LBO_MAX_DEBT_SHARE = 0.70   # ...and never more than this share of the purchase price
LBO_LOAN_SPREAD = 0.045     # leveraged-loan spread over the risk-free rate
LBO_IRRS = (0.25, 0.225, 0.20)   # low, mid, high price (a higher required return buys less)
CONTROL_PREMIUM = (0.20, 0.30, 0.40)
RI_BOOK_GROWTH_CAP = 0.08   # book value per share can't compound faster for a decade (buybacks eat the rest)
RI_PERSISTENCE = 0.6        # share of the year-ten excess return that survives into the terminal
BLEND_WEIGHTS = {"comps": 0.40, "dcf": 0.35, "residual": 0.35, "analysts": 0.25}
FINANCIAL_SECTORS = {"Financial Services", "Financial"}
EUR_PEGS = {"DKK": 7.4604, "BGN": 1.9558}   # currencies fixed to the euro

MULTIPLES = {
    # field in Yahoo's profile: (label, upper bound beyond which a value is noise)
    "forwardPE": ("Forward P/E", 100.0),
    "trailingPE": ("Trailing P/E", 150.0),
    "enterpriseToEbitda": ("EV / EBITDA", 80.0),
    "enterpriseToRevenue": ("EV / Sales", 40.0),
    "priceToBook": ("Price / book", 40.0),
    "priceToSalesTrailing12Months": ("Price / sales", 40.0),
}


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _clip(x, lo, hi):
    return float(min(max(x, lo), hi))


def _r(x, nd=4):
    return None if x is None else round(float(x), nd)


# --------------------------------------------------------------------------- peers

MIN_PEERS = 4   # a group needs this many members besides the company itself


def _company_key(info: dict, sym: str) -> str:
    """Share classes of one company (GOOG/GOOGL, FOX/FOXA) count once."""
    name = (info.get("longName") or info.get("shortName") or sym).lower()
    name = name.replace(",", "").replace(".", "")
    for suffix in (" inc", " corporation", " corp", " plc", " ltd", " co", " company", " class a", " class b", " class c"):
        name = name.replace(suffix, "")
    return name.strip() or sym


def peer_groups(infos: dict[str, dict]) -> dict[str, dict[str, list]]:
    """Every tracked and stored company's multiples, grouped per industry (key
    "industry:<name>"), per sector and overall ("_all"), as lists of
    [symbol, value] so a company can be left out of its own peer group."""
    buckets: dict[str, dict[str, list]] = {}
    seen = set()
    for sym, info in infos.items():
        if not info or info.get("quoteType") == "ETF":
            continue
        ck = _company_key(info, sym)
        if ck in seen:
            continue
        seen.add(ck)
        keys = [str(info.get("sector") or "_"), "_all"]
        if info.get("industry"):
            keys.append("industry:" + str(info["industry"]))
        # Yahoo's enterprise value for a foreign listing mixes the market value in one
        # currency with debt in another, so its EV multiples are noise there
        foreign = info.get("financialCurrency") and info.get("currency") and info["financialCurrency"] != info["currency"]
        for key in keys:
            b = buckets.setdefault(key, {f: [] for f in MULTIPLES})
            for f, (_, cap) in MULTIPLES.items():
                if foreign and f.startswith("enterpriseTo"):
                    continue
                v = _num(info.get(f))
                if v is not None and 0 < v < cap:
                    b[f].append([sym, v, ck])
    return buckets


def group_stats(members: list, exclude: str | None = None, need: int = MIN_PEERS) -> dict | None:
    """Quartiles of a group's multiple, leaving the company itself (any share class) out:
    `exclude` is a (symbol, company key) pair or a bare symbol."""
    sym_x, key_x = (exclude if isinstance(exclude, tuple) else (exclude, None))
    vals = [m[1] for m in members if m[0] != sym_x and (key_x is None or len(m) < 3 or m[2] != key_x)]
    if len(vals) < need:
        return None
    q = np.percentile(vals, [25, 50, 75])
    return {"p25": float(q[0]), "median": float(q[1]), "p75": float(q[2]), "n": len(vals)}


def peer_stats(info: dict, peers: dict, field: str, allow_all: bool = True, exclude: str | None = None):
    """The closest peer group's quartiles for one multiple, without the company
    itself, and a label naming the group: the industry first (at least
    MIN_PEERS others), then the sector, then the whole universe."""
    cands = []
    if info.get("industry"):
        cands.append(("industry:" + str(info["industry"]), str(info["industry"])))
    cands.append((str(info.get("sector") or "_"), str(info.get("sector") or "other") + " sector"))
    if allow_all:
        cands.append(("_all", "S&P 500 and FTSE MIB"))
    who = (exclude, _company_key(info, exclude)) if exclude else None
    for key, label in cands:
        members = peers.get(key, {}).get(field)
        if not members:
            continue
        s = group_stats(members, who)
        if s and s.get("median"):
            return s, f"{label} ({s['n']})"
    return None, None


def medians_from(peers: dict) -> dict[str, dict[str, float]]:
    """The flat shape ({group: {multiple: median}}, every member counted) for the score and the page."""
    out = {}
    for key, fields in peers.items():
        need = 1 if key == "_all" else 3
        out[key] = {f: float(np.median([x[1] for x in m])) for f, m in fields.items() if len(m) >= need}
    return out


def peer_summary(info: dict, peers: dict, medians: dict) -> dict:
    """What the page shows next to a stock's own multiples."""
    sector, industry = info.get("sector"), info.get("industry")
    ikey = "industry:" + str(industry) if industry else None
    size = lambda key: len(peers.get(key, {}).get("forwardPE", [])) if key else None  # noqa: E731
    return {"sector": sector, "industry": industry,
            "medians": medians.get(str(sector or "_"), {}),
            "industryMedians": medians.get(ikey, {}) if ikey else {},
            "industryN": size(ikey), "sectorN": size(str(sector or "_")), "all": medians.get("_all", {})}


# --------------------------------------------------------------------------- inputs

def fx_rate(from_ccy: str | None, to_ccy: str | None, fx: dict | None) -> float | None:
    """How many units of to_ccy one unit of from_ccy buys, from the pairs the
    pipeline already downloads (EURUSD, GBPUSD, USDJPY, USDCHF, EURGBP) and the
    euro pegs. None when unknown."""
    if not from_ccy or not to_ccy or from_ccy == to_ccy:
        return 1.0
    fx = fx or {}
    peg_from = EUR_PEGS.get(from_ccy)
    peg_to = EUR_PEGS.get(to_ccy)
    if peg_from:   # DKK -> EUR -> target
        r = fx_rate("EUR", to_ccy, fx)
        return r / peg_from if r else None
    if peg_to:
        r = fx_rate(from_ccy, "EUR", fx)
        return r * peg_to if r else None
    direct = fx.get(from_ccy + to_ccy)
    if direct:
        return float(direct)
    inverse = fx.get(to_ccy + from_ccy)
    if inverse:
        return 1.0 / float(inverse)
    if from_ccy != "USD" and to_ccy != "USD":   # cross through the dollar
        a, b = fx_rate(from_ccy, "USD", fx), fx_rate("USD", to_ccy, fx)
        return a * b if a and b else None
    return None


def is_financial(info: dict) -> bool:
    """A balance-sheet business (bank, insurer, lender), to be valued on book value
    and dividends rather than cash flow. The tell is that Yahoo reports no EBITDA
    for it: a payment network or an asset manager sit in the same sector but
    have real operating cash flow and are valued like any company; insurers,
    Berkshire included, are financials."""
    if (info.get("sector") or "") not in FINANCIAL_SECTORS:
        return False
    industry = str(info.get("industry") or "").lower()
    if "insurance" in industry and "broker" not in industry:
        return True
    ebitda = _num(info.get("ebitda"))
    return not (ebitda and ebitda > 0)


def company_inputs(info: dict, price: float, fx: dict | None = None) -> dict:
    """Everything the methods need, in the trading currency. Statement figures
    (capital spending, depreciation, interest, taxes) come from the trailing
    twelve months of the cash-flow and income statements when the feed has
    them; the profile's ratios are the fallback. The diluted share count is the
    market value over the profile's own price (Yahoo's share count omits a
    second share class for Alphabet, Meta or Berkshire)."""
    f = lambda k: _num(info.get(k))  # noqa: E731
    st = info.get("statements") or {}
    g = lambda k: _num(st.get(k))  # noqa: E731
    ccy = info.get("currency")
    fin_ccy = info.get("financialCurrency") or ccy
    rate = fx_rate(fin_ccy, ccy, fx)
    mcap = f("marketCap")
    shares_listed = f("sharesOutstanding")
    quote_px = f("currentPrice") or f("regularMarketPrice") or price
    shares = (mcap / quote_px) if mcap and quote_px else shares_listed
    conv = (lambda v: None if v is None or rate is None else v * rate)
    rev = conv(g("revenue") if g("revenue") and g("revenue") > 0 else f("totalRevenue"))
    op_margin = f("operatingMargins")
    ebit = conv(g("operatingIncome")) if g("operatingIncome") is not None else (rev * op_margin if rev is not None and op_margin is not None else None)
    da = conv(g("da")) if g("da") is not None and g("da") >= 0 else None
    ebitda = (ebit + da) if ebit is not None and da is not None else conv(f("ebitda"))
    if da is None and ebitda is not None and ebit is not None:
        da = max(ebitda - ebit, 0.0)
    capex = conv(g("capex")) if g("capex") is not None else None   # the profile has no capex figure worth the name
    capex_assumed = capex is None
    if capex is None and da is not None:
        capex = da   # maintenance spending: what it takes to stand still
    ocf = conv(g("operatingCashFlow")) if g("operatingCashFlow") is not None else conv(f("operatingCashflow"))
    fcf = (ocf - capex) if ocf is not None and capex is not None and not capex_assumed else None
    interest = g("interestExpense")
    if interest is None or interest < 0:
        interest = g("interestPaid")
    interest = conv(interest) if interest is not None and interest >= 0 else None
    tax_rate = None
    if g("pretaxIncome") and g("pretaxIncome") > 0 and g("taxProvision") is not None:
        tax_rate = _clip(g("taxProvision") / g("pretaxIncome"), 0.05, 0.40)
    debt, cash = conv(f("totalDebt")), conv(f("totalCash"))
    book = f("bookValue")
    if book and price and book > 20 * price:
        book = None   # Yahoo quotes Berkshire's book value per Class A share against the Class B price
    out = {
        "currency": ccy, "financialCurrency": fin_ccy, "fxRate": rate, "price": price,
        "marketCap": mcap, "shares": shares, "sharesListed": shares_listed,
        "revenue": rev, "ebitda": ebitda, "ebit": ebit, "da": da, "capex": capex, "capexAssumed": capex_assumed,
        "operatingCashflow": ocf, "freeCashflow": fcf, "leveredFcfProfile": conv(f("freeCashflow")),
        "interestExpense": interest, "taxRate": tax_rate, "stockComp": conv(g("stockComp")),
        "statementsBasis": st.get("basis"), "statementsAsOf": st.get("asOf"),
        "debt": debt or 0.0, "cash": cash or 0.0,
        "forwardEps": f("forwardEps"), "trailingEps": f("trailingEps"), "bookValue": book,
        "roe": f("returnOnEquity"), "payoutRatio": f("payoutRatio"), "dividendRate": f("dividendRate"),
        "beta": f("beta"), "revenueGrowth": f("revenueGrowth"), "earningsGrowth": f("earningsGrowth"),
        "operatingMargins": op_margin,
        "targetMean": f("targetMeanPrice"), "targetLow": f("targetLowPrice"), "targetHigh": f("targetHighPrice"),
        "analysts": int(f("numberOfAnalystOpinions") or 0),
        "week52Low": f("fiftyTwoWeekLow"), "week52High": f("fiftyTwoWeekHigh"),
        "financial": is_financial(info),
    }
    out["enterpriseValue"] = (mcap + out["debt"] - out["cash"]) if mcap else None
    out["netDebtToEbitda"] = ((out["debt"] - out["cash"]) / ebitda) if ebitda and ebitda > 0 else None
    return out


def expected_growth(inp: dict) -> float | None:
    """Expected earnings growth: forward vs trailing EPS, else reported growth,
    capped so a one-year rebound can't buy a growth stock's multiple."""
    eps_f, eps_t, rev_g, earn_g = inp["forwardEps"], inp["trailingEps"], inp["revenueGrowth"], inp["earningsGrowth"]
    growth = None
    if eps_f and eps_t and eps_t > 0:
        growth = eps_f / eps_t - 1
        # A trailing figure swollen by one-off gains says earnings will fall while
        # revenue and reported earnings growth say the opposite: trust those
        if growth < 0 and (rev_g or 0) > 0 and (earn_g or 0) > 0:
            growth = earn_g
    elif earn_g is not None:
        growth = earn_g
    if growth is None:
        return None
    if rev_g is not None:
        growth = min(growth, max(rev_g, 0.0) + 0.10)
    return _clip(growth, -0.10, 0.30)


# --------------------------------------------------------------------------- cost of capital

def cost_of_capital(inp: dict, risk_free: float | None) -> dict:
    """WACC the way a bank builds it: CAPM cost of equity on a Blume-adjusted beta,
    cost of debt as the risk-free rate plus a spread that widens with leverage,
    the tax shield, and market-value weights."""
    rf = _clip(risk_free if risk_free else RISK_FREE_DEFAULT, 0.01, 0.08)
    beta_raw = _clip(inp["beta"] if inp["beta"] is not None else 1.0, 0.3, 2.5)
    beta_adj = 0.67 * beta_raw + 0.33          # betas drift toward 1 over time (Blume)
    ke = _clip(rf + beta_adj * EQUITY_PREMIUM, 0.06, 0.16)
    lev = (inp["debt"] / inp["ebitda"]) if inp["ebitda"] and inp["ebitda"] > 0 else None
    if lev is None:
        spread = 0.02
    elif lev <= 1.0:
        spread = 0.01
    elif lev <= 2.5:
        spread = 0.015
    elif lev <= 4.0:
        spread = 0.025
    else:
        spread = 0.04
    kd = rf + spread
    tax = inp["taxRate"] if inp.get("taxRate") is not None else TAX_RATE
    kd_after = kd * (1 - tax)
    e = inp["marketCap"] or ((inp["sharesListed"] or 0.0) * (inp["price"] or 0.0))
    d = inp["debt"]
    w_e = e / (e + d) if e > 0 and (e + d) > 0 else 1.0   # unknown equity value: the cost of equity, not 100% debt
    raw_wacc = w_e * ke + (1 - w_e) * kd_after
    wacc = _clip(raw_wacc, 0.06, 0.14)
    out = {"riskFree": rf, "betaRaw": beta_raw, "betaAdjusted": beta_adj, "equityPremium": EQUITY_PREMIUM,
           "costOfEquity": ke, "creditSpread": spread, "costOfDebt": kd, "costOfDebtAfterTax": kd_after,
           "taxRate": tax, "taxRateSource": "statements" if inp.get("taxRate") is not None else "assumed",
           "debtToEbitda": lev, "equityWeight": w_e, "debtWeight": 1 - w_e, "wacc": wacc,
           "waccClipped": wacc != raw_wacc, "terminalGrowth": TERMINAL_GROWTH, "financial": inp["financial"]}
    if inp["financial"]:
        # A bank's deposits are its raw material, not financing: only the cost of equity is meaningful
        out.update({"wacc": None, "costOfDebt": None, "costOfDebtAfterTax": None, "creditSpread": None,
                    "equityWeight": None, "debtWeight": None, "debtToEbitda": None})
    return out


# --------------------------------------------------------------------------- methods

def _ev_to_price(ev: float, inp: dict) -> float | None:
    """Enterprise value to a price per share: subtract debt, add cash, divide by the diluted shares."""
    if not inp["shares"] or inp["shares"] <= 0:
        return None
    return (ev - inp["debt"] + inp["cash"]) / inp["shares"]


def trading_comps(info: dict, inp: dict, peers: dict, symbol: str | None = None) -> dict | None:
    """Peer multiples applied to this company's numbers. Forward P/E and EV/EBITDA
    carry most of the weight (what buyers actually quote); EV/Sales carries 20%
    and is the only leg left for a loss-maker with no EBITDA; price-to-book is
    for financials, whose EV means nothing."""
    legs = {}
    fin = inp["financial"]
    convertible = inp["fxRate"] is not None

    def leg(key, field, label, base, to_price, weight, allow_all):
        if base is None or base <= 0:
            return
        s, group = peer_stats(info, peers, field, allow_all, exclude=symbol)
        if not s:
            return
        vals = [to_price(base * s[q]) for q in ("p25", "median", "p75")]
        if any(v is None or v <= 0 for v in vals):
            return
        legs[key] = {"label": label, "multiple": field, "peerGroup": group, "n": s["n"],
                     "peerP25": s["p25"], "peerMedian": s["median"], "peerP75": s["p75"],
                     "base": base, "low": vals[0], "mid": vals[1], "high": vals[2], "weight": weight}

    ident = lambda v: v  # noqa: E731
    ev = lambda v: _ev_to_price(v, inp)  # noqa: E731
    leg("pe", "forwardPE", "Forward P/E × next year's EPS", inp["forwardEps"], ident, 0.5 if fin else 0.4, not fin)
    if fin:
        leg("pb", "priceToBook", "Price / book × book value per share", inp["bookValue"], ident, 0.5, False)
    elif convertible:
        leg("ebitda", "enterpriseToEbitda", "EV / EBITDA × EBITDA, less net debt", inp["ebitda"], ev, 0.4, True)
        leg("sales", "enterpriseToRevenue", "EV / Sales × revenue, less net debt", inp["revenue"], ev, 0.2, True)
    if not legs:
        return None
    # EV/Sales alone (a loss-maker with no EBITDA) is a thin basis: say so
    total = sum(l["weight"] for l in legs.values())
    geo = lambda q: math.exp(sum(l["weight"] * math.log(l[q]) for l in legs.values()) / total)  # noqa: E731
    out = {"label": "Trading comparables", "value": geo("mid"), "low": geo("low"), "high": geo("high"), "legs": legs}
    if set(legs) == {"sales"}:
        out["caveat"] = "only a sales multiple applies: no positive earnings or EBITDA to compare"
    return out


def growth_rate(inp: dict, lo: float, hi: float) -> float:
    """Near-term growth for the projections: recent revenue growth, but no more
    than ten points above the analysts' expected earnings growth (a quarter's
    revenue jump after an acquisition or an oil spike must not compound for
    years) and never cut below half of it, clipped."""
    g, e = inp["revenueGrowth"], expected_growth(inp)
    if g is None:
        g = e if e is not None else 0.04
    elif e is not None:
        g = min(g, max(e + 0.10, 0.5 * g))
    return _clip(g, lo, hi)


def dcf(inp: dict, cost: dict, exit_multiple: float | None) -> dict | None:
    """Unlevered DCF: this year's free cash flow to the firm, projected ten years
    with revenue growth fading to the terminal rate at a constant cash margin,
    discounted mid-year at the WACC, plus a perpetuity-growth terminal value
    (cross-checked with an exit multiple). Not for financials."""
    if inp["financial"] or inp["fxRate"] is None or not inp["shares"]:
        return None
    rev0, ebit0, da0, capex0 = inp["revenue"], inp["ebit"], inp["da"], inp["capex"]
    wacc, g_inf, t = cost["wacc"], TERMINAL_GROWTH, cost["taxRate"]
    if not rev0 or rev0 <= 0:
        return None
    # Two readings of this year's unlevered free cash flow: built up from operating
    # profit (EBIT less tax, plus depreciation, less capital spending), and read
    # off the cash-flow statement (free cash flow plus the after-tax interest the
    # firm pays, which equity holders never see). They differ by cash taxes,
    # stock-based pay, one-off charges and working capital. The operating build-up
    # is the banker's convention and the cash-flow reading the investor's. With
    # stock-based pay charged in both, what separates them is one-off charges
    # and working-capital swings, so the two are averaged (a one-off counts
    # half); when a write-off wipes one out the other stands in.
    from_ebit = (ebit0 * (1 - t) + (da0 or 0.0) - (capex0 or 0.0)) if ebit0 is not None else None
    modelled = cost["costOfDebt"] * inp["debt"]
    # Yahoo's "interest expense" sometimes bundles other financial charges (ENI
    # reports 16% of its debt), so the add-back is capped near the modelled cost
    interest = min(inp["interestExpense"], 1.5 * modelled) if inp["interestExpense"] is not None else modelled
    sbc = inp["stockComp"] or 0.0   # a cost in both readings: shares handed to staff are owners' money
    fcf = inp["freeCashflow"]
    if fcf is None and inp["capexAssumed"] and inp["leveredFcfProfile"] is not None:
        fcf = inp["leveredFcfProfile"]   # no statements: the profile's levered figure is the only cash reading
    from_fcf = (fcf - sbc + interest * (1 - t)) if fcf is not None else None
    readings = [b for b in (from_ebit, from_fcf) if b is not None]
    if not readings:
        return None
    if (ebit0 or 0.0) <= 0:
        return {"label": "Discounted cash flow", "skipped": "no operating profit to discount", "ufcfFromEbit": from_ebit, "ufcfFromFcf": from_fcf}
    positive = [b for b in readings if b > 0]
    # Capital spending above depreciation is growth investment: it is assumed to
    # fade to depreciation plus terminal growth by year ten, the standard
    # terminal-year normalisation, which is what lets a company in a build-out
    # (today's free cash flow near zero or negative) be valued at all
    da_pct = (da0 or 0.0) / rev0
    capex_pct0 = (capex0 or 0.0) / rev0
    capex_pct_end = min(capex_pct0, da_pct * (1 + g_inf))
    normalising = capex_pct0 - capex_pct_end
    if positive:
        ufcf0 = float(np.mean(positive))
        basis = "both" if len(positive) == 2 else ("ebit" if from_ebit in positive else "fcf")
    else:
        ufcf0 = float(np.mean(readings))   # negative today: the fade has to carry the value
        basis = "negative"
    if ufcf0 + normalising * rev0 <= 0:
        return {"label": "Discounted cash flow", "skipped": "it is spending more on growth than it earns, and even with that spending back at depreciation the cash flow stays negative",
                "ufcfFromEbit": from_ebit, "ufcfFromFcf": from_fcf}
    readings_disagree = len(positive) == 2 and max(positive) > 2.0 * min(positive)
    cash_margin = ufcf0 / rev0
    # Three years at the near-term growth rate (capped at 15%: nothing this size
    # compounds faster for a decade), then a straight fade to the terminal rate
    g1 = growth_rate(inp, -0.05, 0.15)

    def project(w, g_end):
        rev, pv, flows = rev0, 0.0, []
        for year in range(1, PROJECTION_YEARS + 1):
            g = g1 if year <= 3 else g1 + (g_end - g1) * (year - 3) / (PROJECTION_YEARS - 3)
            rev_prev, rev = rev, rev * (1 + g)
            margin = cash_margin + normalising * year / PROJECTION_YEARS
            ufcf = rev * margin - NWC_PCT_OF_GROWTH * (rev - rev_prev)
            pv += ufcf / (1 + w) ** (year - 0.5)
            flows.append({"year": year, "growth": g, "revenue": rev, "ufcf": ufcf})
        last = flows[-1]
        tv = last["ufcf"] * (1 + g_end) / max(w - g_end, 0.02)
        pv_tv = tv / (1 + w) ** (PROJECTION_YEARS - 0.5)   # mid-year convention, like the flows
        return pv, pv_tv, flows

    pv, pv_tv, flows = project(wacc, g_inf)
    ev = pv + pv_tv
    value = _ev_to_price(ev, inp)
    if value is None or value <= 0:
        return {"label": "Discounted cash flow", "skipped": "the cash flows are too thin against the debt: the value hinges on cash flows that don't exist yet",
                "ufcfFromEbit": from_ebit, "ufcfFromFcf": from_fcf}
    grid = []
    for w in (wacc - 0.01, wacc, wacc + 0.01):
        row = []
        for g in (g_inf - 0.005, g_inf, g_inf + 0.005):
            p, ptv, _ = project(w, g)
            v = _ev_to_price(p + ptv, inp)
            row.append(v if v is not None and v > 0 else None)
        grid.append(row)
    vals = [v for row in grid for v in row if v is not None]
    if not vals:
        return {"label": "Discounted cash flow", "skipped": "the cash flows are too thin against the debt: the value hinges on cash flows that don't exist yet"}
    out = {
        "label": "Discounted cash flow", "value": value, "low": min(vals), "high": max(vals),
        "basis": basis, "ufcf0": ufcf0, "ufcfFromEbit": from_ebit, "ufcfFromFcf": from_fcf, "cashMargin": cash_margin,
        "cashMarginEnd": cash_margin + normalising, "capexPct": capex_pct0, "capexPctEnd": capex_pct_end, "daPct": da_pct,
        "taxRate": t, "interest": interest, "capexAssumed": inp["capexAssumed"], "statementsBasis": inp["statementsBasis"],
        "readingsDisagree": readings_disagree,
        "growth3y": g1, "terminalGrowth": g_inf, "discountRate": wacc,
        "pvFlows": pv, "pvTerminal": pv_tv, "terminalShare": pv_tv / ev if ev else None,
        "enterpriseValue": ev, "equityValue": ev - inp["debt"] + inp["cash"],
        "flows": [{"year": f["year"], "growth": _r(f["growth"]), "revenue": _r(f["revenue"], 0), "ufcf": _r(f["ufcf"], 0)} for f in flows],
        "sensitivity": {"wacc": [wacc - 0.01, wacc, wacc + 0.01], "growth": [g_inf - 0.005, g_inf, g_inf + 0.005],
                        "values": grid},
    }
    # Exit-multiple cross-check: sell the business in year ten at the peers' EV/EBITDA
    if exit_multiple and inp["ebitda"] and inp["ebitda"] > 0:
        ebitda10 = flows[-1]["revenue"] * inp["ebitda"] / rev0
        pv_exit = exit_multiple * ebitda10 / (1 + wacc) ** PROJECTION_YEARS
        exit_value = _ev_to_price(pv + pv_exit, inp)
        if exit_value is not None and exit_value > 0:
            out["exitMultiple"] = exit_multiple
            out["exitValue"] = exit_value
    lev = inp["netDebtToEbitda"]
    if lev is not None and lev > 4:
        out["caveat"] = ("net debt is over four times EBITDA, which usually means a financing arm (dealer or "
                         "customer loans) whose debt a bank would value separately, as a sum of the parts")
    return out


def residual_income(inp: dict, cost: dict) -> dict | None:
    """Book value plus the present value of returns above the cost of equity, with
    half the excess competed away over ten years and part of the rest capitalised."""
    b0, roe0, ke = inp["bookValue"], inp["roe"], cost["costOfEquity"]
    if not inp["financial"] or not b0 or b0 <= 0 or roe0 is None:
        return None
    roe0 = _clip(roe0, -0.10, 0.35)
    payout = _clip(inp["payoutRatio"] if inp["payoutRatio"] is not None else 0.30, 0.0, 0.90)
    roe_end = ke + 0.5 * (roe0 - ke)

    # Book value per share grows with retained earnings, but banks return most of
    # what they don't pay out through buybacks, so the growth is capped
    g_book = _clip(roe0 * (1 - payout), 0.0, RI_BOOK_GROWTH_CAP)

    def project(k):
        b, pv, last_ri = b0, 0.0, 0.0
        for year in range(1, PROJECTION_YEARS + 1):
            roe = roe0 + (roe_end - roe0) * year / PROJECTION_YEARS
            ri = (roe - k) * b
            pv += ri / (1 + k) ** year
            b *= 1 + g_book
            last_ri = ri
        # only part of the year-ten excess return persists: franchises fade
        tv = RI_PERSISTENCE * last_ri * (1 + TERMINAL_GROWTH) / max(k - TERMINAL_GROWTH, 0.02) if last_ri > 0 else 0.0
        return b0 + pv + tv / (1 + k) ** PROJECTION_YEARS, pv, tv / (1 + k) ** PROJECTION_YEARS

    value, pv_ri, pv_tv = project(ke)
    lo, _, _ = project(ke + 0.01)
    hi, _, _ = project(ke - 0.01)
    if value <= 0:
        return {"label": "Residual income", "skipped": "returns below the cost of equity leave nothing above book"}
    return {"label": "Residual income", "value": value, "low": min(lo, hi), "high": max(lo, hi),
            "bookValue": b0, "roe": roe0, "roeEnd": roe_end, "payout": payout, "bookGrowth": g_book,
            "persistence": RI_PERSISTENCE, "costOfEquity": ke, "pvResidual": pv_ri, "pvTerminal": pv_tv}


def dividend_model(inp: dict, cost: dict) -> dict | None:
    """Two-stage dividend discount model for companies whose dividend reflects their
    earnings power (payout of at least 35%): five years of growth at the
    sustainable rate (ROE × retention), then a Gordon tail. A cross-check, never blended."""
    d0, ke = inp["dividendRate"], cost["costOfEquity"]
    if not d0 or d0 <= 0 or inp["payoutRatio"] is None or inp["payoutRatio"] < 0.35:
        return None
    payout = _clip(inp["payoutRatio"], 0.0, 0.95)
    roe = _clip(inp["roe"] if inp["roe"] is not None else 0.10, 0.0, 0.35)
    g1 = _clip(roe * (1 - payout), 0.0, 0.10)
    g_inf = min(TERMINAL_GROWTH, ke - 0.02)

    def project(k):
        d, pv = d0, 0.0
        for year in range(1, 6):
            d *= 1 + g1
            pv += d / (1 + k) ** year
        tv = d * (1 + g_inf) / max(k - g_inf, 0.02)
        return pv + tv / (1 + k) ** 5

    value = project(ke)
    lo, hi = project(ke + 0.01), project(ke - 0.01)
    return {"label": "Dividend discount", "value": value, "low": min(lo, hi), "high": max(lo, hi),
            "dividend": d0, "growth5y": g1, "terminalGrowth": g_inf, "costOfEquity": ke}


def lbo(inp: dict, cost: dict, exit_multiple: float | None) -> dict | None:
    """What a private-equity buyer could pay: fund the purchase with LBO_LEVERAGE ×
    EBITDA of debt, run the company five years paying the debt down from cash
    flow, sell at the exit multiple, and back out the entry price that returns
    20–25% a year on the sponsor's equity."""
    if inp["financial"] or inp["fxRate"] is None or not inp["shares"]:
        return None
    rev0, ebitda0, da0, capex0 = inp["revenue"], inp["ebitda"], inp["da"], inp["capex"]
    if not rev0 or rev0 <= 0 or not ebitda0 or ebitda0 <= 0:
        return None
    own_multiple = inp["enterpriseValue"] / ebitda0 if inp["enterpriseValue"] else None
    cands = [m for m in (exit_multiple, own_multiple) if m and m > 0]
    if not cands:
        return None
    exit_mult = _clip(min(cands), 4.0, 20.0)   # sell at the lower of today's and the peers' multiple
    if inp["debt"] / ebitda0 > LBO_LEVERAGE:
        return {"label": "Leveraged buyout", "skipped": "already carries more debt than a buyout could add"}
    margin = ebitda0 / rev0
    da_pct = _clip((da0 or 0.0) / rev0, 0.0, 0.40)
    capex_pct = _clip((capex0 if capex0 is not None else (da0 or 0.0)) / rev0, 0.0, 0.60)
    g = growth_rate(inp, 0.0, 0.10)
    rate = cost["riskFree"] + LBO_LOAN_SPREAD

    tax = cost["taxRate"]

    def run(debt_new):
        rev, debt, cash, short = rev0, debt_new, 0.0, False
        for _ in range(LBO_YEARS):
            rev_prev, rev = rev, rev * (1 + g)
            ebitda = rev * margin
            interest = debt * rate
            taxes = max(ebitda - rev * da_pct - interest, 0.0) * tax
            cf = ebitda - rev * capex_pct - interest - taxes - NWC_PCT_OF_GROWTH * (rev - rev_prev)
            if cf >= 0:
                paid = min(cf, debt)
                debt -= paid
                cash += cf - paid
            else:
                short = True   # the company can't service the buyout debt from its own cash flow
                debt -= cf
        ebitda5 = rev * margin
        return ebitda5 * exit_mult - debt + cash, ebitda5, debt, short

    debt_new = LBO_LEVERAGE * ebitda0
    for _ in range(4):   # leverage is also capped at a share of the price, which depends on leverage
        exit_equity, _, _, _ = run(debt_new)
        ev_mid = exit_equity / (1 + LBO_IRRS[1]) ** LBO_YEARS + debt_new
        if exit_equity <= 0 or debt_new <= LBO_MAX_DEBT_SHARE * ev_mid:
            break
        debt_new = LBO_MAX_DEBT_SHARE * ev_mid
    exit_equity, ebitda5, debt_end, short = run(debt_new)   # the figures shown belong to the final debt
    if exit_equity <= 0 or short or debt_end > debt_new:
        return {"label": "Leveraged buyout", "skipped": "the business couldn't service the buyout debt from its cash flow"}
    prices = []
    for irr in LBO_IRRS:
        equity_in = exit_equity / (1 + irr) ** LBO_YEARS
        prices.append(_ev_to_price(equity_in + debt_new, inp))
    if any(p is None or p <= 0 for p in prices):
        return {"label": "Leveraged buyout", "skipped": "the business couldn't service the buyout debt from its cash flow"}
    out = {"label": "Leveraged buyout", "value": prices[1], "low": min(prices), "high": max(prices),
           "irrs": list(LBO_IRRS), "leverage": debt_new / ebitda0, "newDebt": debt_new, "exitMultiple": exit_mult,
           "ebitdaExit": ebitda5, "debtAtExit": debt_end, "exitEquity": exit_equity, "growth": g,
           "loanRate": rate, "years": LBO_YEARS}
    # ...and the return a buyer would earn paying today's price
    if inp["enterpriseValue"]:
        equity_today = inp["enterpriseValue"] - debt_new
        if equity_today > 0:
            out["irrAtPrice"] = (exit_equity / equity_today) ** (1.0 / LBO_YEARS) - 1
    return out


def precedents(comps: dict | None) -> dict | None:
    """Takeover reference: the control premium acquirers typically pay over the
    trading value. No free database of deal multiples exists, so this is the
    premium applied to the comparables, not actual precedent transactions."""
    if not comps or not comps.get("value"):
        return None
    v = comps["value"]
    return {"label": "Precedent transactions (control premium)", "value": v * (1 + CONTROL_PREMIUM[1]),
            "low": v * (1 + CONTROL_PREMIUM[0]), "high": v * (1 + CONTROL_PREMIUM[2]), "premiums": list(CONTROL_PREMIUM)}


def analyst_targets(inp: dict) -> dict | None:
    if not inp["targetMean"] or inp["analysts"] < 4:
        return None
    return {"label": "Analyst targets", "value": inp["targetMean"], "low": inp["targetLow"] or inp["targetMean"],
            "high": inp["targetHigh"] or inp["targetMean"], "analysts": inp["analysts"]}


# --------------------------------------------------------------------------- the whole picture

def valuation(info: dict, price: float, peers: dict, risk_free: float | None = None, fx: dict | None = None,
              symbol: str | None = None) -> dict:
    """Every method, the football field and the blended point estimate for one stock."""
    out: dict = {"methods": {}, "inputs": {}, "field": []}
    price = _num(price)
    if not info or info.get("quoteType") == "ETF" or not price or price <= 0:
        return out
    fx = {k: v for k, v in (fx or {}).items() if _num(v) and _num(v) > 0}
    inp = company_inputs(info, price, fx)
    cost = cost_of_capital(inp, risk_free)
    growth = expected_growth(inp)
    out["inputs"] = {
        "forwardEps": inp["forwardEps"], "trailingEps": inp["trailingEps"], "expectedGrowth": growth,
        "beta": inp["beta"], "revenueGrowth": inp["revenueGrowth"], "freeCashflow": inp["freeCashflow"],
        "totalCash": inp["cash"], "totalDebt": inp["debt"], "sharesOutstanding": inp["sharesListed"],
        "dilutedShares": inp["shares"], "bookValue": inp["bookValue"], "revenue": inp["revenue"],
        "ebitda": inp["ebitda"], "ebit": inp["ebit"], "da": inp["da"], "capex": inp["capex"],
        "enterpriseValue": inp["enterpriseValue"], "netDebtToEbitda": inp["netDebtToEbitda"],
        "financialCurrency": inp["financialCurrency"], "fxRate": inp["fxRate"], "financial": inp["financial"],
        "interestExpense": inp["interestExpense"], "taxRate": inp["taxRate"], "capexAssumed": inp["capexAssumed"],
        "statementsBasis": inp["statementsBasis"], "statementsAsOf": inp["statementsAsOf"],
    }
    out["costOfCapital"] = cost
    if inp["fxRate"] is None:
        out["currencyNote"] = (f"The accounts are reported in {inp['financialCurrency']} and no rate to "
                               f"{inp['currency']} is available, so the methods that need whole-company amounts are skipped.")

    exit_stats, _ = peer_stats(info, peers, "enterpriseToEbitda", True, exclude=symbol)
    exit_multiple = exit_stats["median"] if exit_stats else None
    m = out["methods"]
    comps = trading_comps(info, inp, peers, symbol)
    if comps:
        m["comps"] = comps
    for key, res in (("dcf", dcf(inp, cost, exit_multiple)), ("residual", residual_income(inp, cost)),
                     ("ddm", dividend_model(inp, cost)), ("lbo", lbo(inp, cost, exit_multiple)),
                     ("precedent", precedents(comps)), ("analysts", analyst_targets(inp))):
        if res:
            m[key] = res
    for key, res in m.items():
        res["inBlend"] = key in BLEND_WEIGHTS and "value" in res

    # Blend: comparables, the intrinsic model and the analysts, geometrically, after the sanity rules
    cands = {k: v for k, v in m.items() if k in BLEND_WEIGHTS and v.get("value")}
    dropped = {k for k, v in cands.items() if not (price / 5.0 <= v["value"] <= price * 5.0)}
    for k in dropped:
        m[k]["dropped"] = "implausible"
        m[k]["inBlend"] = False
    kept = {k: v for k, v in cands.items() if k not in dropped}
    if inp["financial"] and "residual" not in kept and "pb" not in (comps or {}).get("legs", {}):
        # A balance-sheet business with no usable book value per share (Yahoo quotes
        # Berkshire's per Class A share) can't be valued on an earnings multiple
        # alone: a bank would do a sum of the parts, which needs segment data
        kept = {}
        out["note"] = ("No book value per share to work from: a bank would value this as a sum of its parts, "
                       "which needs segment accounts. Only the reference bars are shown.")
    if kept and (not dropped or len(kept) >= 2):
        total = sum(BLEND_WEIGHTS[k] for k in kept)
        blended = math.exp(sum(BLEND_WEIGHTS[k] * math.log(v["value"]) for k, v in kept.items()) / total)
        blended = _clip(blended, 0.3 * price, 3.0 * price)
        out["value"] = blended
        out["marginOfSafety"] = blended / price - 1
        for k in kept:
            m[k]["weight"] = BLEND_WEIGHTS[k] / total
    else:
        if cands and "note" not in out:
            out["note"] = "The valuation methods disagree too much to give one number."
        for res in m.values():
            res["inBlend"] = False   # nothing was blended

    # The football field: one bar per method, low–high, with the point marked
    order = [("week52", "52-week range"), ("analysts", None), ("comps", None), ("precedent", None),
             ("dcf", None), ("residual", None), ("ddm", None), ("lbo", None)]
    for key, label in order:
        if key == "week52":
            if inp["week52Low"] and inp["week52High"]:
                out["field"].append({"key": key, "label": label, "low": inp["week52Low"], "high": inp["week52High"],
                                     "mid": None, "inBlend": False})
            continue
        res = m.get(key)
        if not res or "value" not in res:
            continue
        out["field"].append({"key": key, "label": res["label"], "low": res.get("low", res["value"]),
                             "high": res.get("high", res["value"]), "mid": res["value"],
                             "inBlend": bool(res.get("inBlend")), "dropped": res.get("dropped")})
    # Per-multiple comps legs as their own bars, so the reader sees which multiple says what
    if comps:
        for k, leg in comps["legs"].items():
            out["field"].append({"key": "comps_" + k, "label": leg["label"].split(" ×")[0] + " (peers)", "low": leg["low"],
                                 "high": leg["high"], "mid": leg["mid"], "inBlend": False, "leg": True})
    return out


# --------------------------------------------------------------------------- the peer universe

PEER_STORE = "peers.json.gz"
PEER_REFRESH_DAYS = 10
PEER_BUDGET = 60
PEER_FIELDS = ["shortName", "longName", "sector", "industry", "currency", "financialCurrency", "quoteType", "marketCap"] + list(MULTIPLES)
# The FTSE MIB, so the Italian names have European peers next to the S&P 500 ones
PEER_EXTRA = [
    "A2A.MI", "AMP.MI", "AZM.MI", "BAMI.MI", "BGN.MI", "BMED.MI", "BMPS.MI", "BPE.MI", "BZU.MI", "CPR.MI",
    "DIA.MI", "ENEL.MI", "ENI.MI", "ERG.MI", "FBK.MI", "G.MI", "HER.MI", "IG.MI", "INW.MI", "IP.MI",
    "ISP.MI", "IVG.MI", "LDO.MI", "MB.MI", "MONC.MI", "NEXI.MI", "PIRC.MI", "PRY.MI", "PST.MI", "RACE.MI",
    "REC.MI", "SPM.MI", "SRG.MI", "STLAM.MI", "STMMI.MI", "TEN.MI", "TIT.MI", "TRN.MI", "UCG.MI", "UNI.MI",
]


def peer_universe(membership_csv: str, tracked: list[str]) -> list[str]:
    """Every current S&P 500 member plus the FTSE MIB, less the tracked stocks
    (whose profiles the pipeline fetches fresh every run anyway)."""
    import csv
    syms = []
    try:
        with open(membership_csv, newline="") as fh:
            syms = [r["symbol"] for r in csv.DictReader(fh) if r.get("symbol")]
    except OSError:
        pass
    seen, out = set(tracked), []
    for s in syms + PEER_EXTRA:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def load_peer_store(prev_dir: str | None) -> dict:
    import gzip
    import json
    import os
    if prev_dir:
        path = os.path.join(prev_dir, PEER_STORE)
        if os.path.exists(path):
            try:
                with gzip.open(path, "rt", encoding="utf-8") as fh:
                    store = json.load(fh)
                if isinstance(store.get("symbols"), dict):
                    return store
            except (OSError, ValueError):
                pass
    return {"version": 1, "symbols": {}}


def dump_peer_store(store: dict, out_dir: str):
    import gzip
    import json
    import os
    with gzip.open(os.path.join(out_dir, PEER_STORE), "wt", encoding="utf-8") as fh:
        json.dump(store, fh, separators=(",", ":"))


def refresh_peer_store(store: dict, symbols: list[str], now, fetch, budget: int = PEER_BUDGET) -> dict:
    """Fetch the profiles that are missing or older than PEER_REFRESH_DAYS, oldest
    first, up to `budget` per run: the whole universe cycles through in a day of
    scheduled runs. `fetch(symbol)` returns Yahoo's profile dict (or {})."""
    import datetime as dt
    entries = store.setdefault("symbols", {})
    today = now.date() if hasattr(now, "date") else now
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    def age(sym):
        e = entries.get(sym)
        if not e or not e.get("fetchedAt"):
            return 10 ** 6
        return (today - dt.date.fromisoformat(e["fetchedAt"][:10])).days

    due = sorted((s for s in symbols if age(s) >= PEER_REFRESH_DAYS), key=lambda s: -age(s))[:budget]
    for sym in due:
        info = fetch(sym) or {}
        slim = {k: info[k] for k in PEER_FIELDS if info.get(k) is not None}
        if slim.get("sector") or slim.get("quoteType") == "ETF":
            entries[sym] = {"fetchedAt": stamp, "info": slim}
        elif sym in entries:
            entries[sym]["fetchedAt"] = stamp   # keep the old profile, don't hammer a dead symbol
        else:
            entries[sym] = {"fetchedAt": stamp, "info": {}}
    for sym in [s for s in entries if s not in symbols]:   # left the index
        del entries[sym]
    store["refreshed"] = len(due)
    return store


def peer_infos(store: dict) -> dict[str, dict]:
    return {s: e["info"] for s, e in store.get("symbols", {}).items() if e.get("info", {}).get("sector")}
