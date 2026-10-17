"""Free alternative data for the models, fetched politely and cached.

Three families, each behind a feature flag so the backtest can judge them:

* **fund** – point-in-time fundamentals from SEC EDGAR's XBRL "company facts"
  API (free, no key, 10 requests a second, a User-Agent that says who you are).
  Every value is taken as *first reported*, dated by the day it was filed, and
  only used from the next day on, so the model sees what an investor could have
  seen. Value, profitability, investment, accruals and fundamental-momentum
  features follow the factor literature (Fama-French 2015, Novy-Marx 2013,
  Sloan 1996). Only companies that file with the SEC are covered: the Milan
  listings get missing values.
* **earn** – the earnings calendar from Yahoo (up to a hundred past and future
  announcements per company with the consensus estimate, the reported figure
  and the surprise): days to and since the announcement, the last surprise and
  the market's reaction to it, the ingredients of post-earnings-announcement
  drift (Bernard & Thomas 1989).
* **ctx2** – extra market context with full history: the VIX term structure
  (^VIX9D, ^VIX3M), the SKEW index, the dollar index, and from FRED's keyless
  CSV endpoint the high-yield credit spread, the 2-year yield and the 10y–2y
  slope, each lagged a day because FRED publishes with a lag.
"""
from __future__ import annotations

import gzip
import io
import json
import logging
import os
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests

log = logging.getLogger("stocks.altdata")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(os.environ.get("STOCKS_CACHE", os.path.join(ROOT, "build", "cache")), "altdata")
UA = {"User-Agent": "domyb-stocks research contact: domenico.bencivenga03@gmail.com",
      "Accept-Encoding": "gzip, deflate"}
EDGAR_PAUSE = 0.12  # stay under SEC's 10 requests a second

FLOW_CONCEPTS = {
    "rev": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
            "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense", "Revenue"],
    "ni": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities", "CashFlowsFromUsedInOperatingActivities"],
}
STOCK_CONCEPTS = {
    "assets": ["Assets"],
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "Equity",
               "EquityAttributableToOwnersOfParent"],
}
FUND_FEATURES = ["ey", "bm", "sp", "cfy", "roa", "cfoa", "ag", "fmom", "accr", "filing_age"]
EARN_FEATURES = ["days_to_earn", "days_since_earn", "sue_last", "pead", "ear_ret"]
CTX2_YAHOO = {"vix3m": "^VIX3M", "vix9d": "^VIX9D", "skew": "^SKEW", "dxy": "DX-Y.NYB"}
CTX2_FRED = {"hy_oas": "BAMLH0A0HYM2", "dgs2": "DGS2", "t10y2y": "T10Y2Y"}


def _cache_path(*parts):
    os.makedirs(os.path.join(CACHE, *parts[:-1]), exist_ok=True)
    return os.path.join(CACHE, *parts)


def _age_days(path):
    return (time.time() - os.path.getmtime(path)) / 86400 if os.path.exists(path) else float("inf")


def _get(url, max_age_days, cache_name, binary=False):
    path = _cache_path(*cache_name)
    if _age_days(path) < max_age_days:
        with open(path, "rb") as fh:
            return fh.read()
    for attempt in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=60)
            if r.status_code == 200:
                with open(path, "wb") as fh:
                    fh.write(r.content)
                return r.content
            if r.status_code == 404:
                return None
            log.warning("%s answered %s (attempt %d)", url, r.status_code, attempt + 1)
        except requests.RequestException as exc:
            log.warning("%s failed: %s (attempt %d)", url, exc, attempt + 1)
        time.sleep(2 * (attempt + 1))
    if os.path.exists(path):  # stale is better than nothing
        with open(path, "rb") as fh:
            return fh.read()
    return None


# --- SEC EDGAR ------------------------------------------------------------------

def cik_map(max_age_days: float = 7) -> dict[str, int]:
    """Yahoo-style ticker -> CIK, from the SEC's own list."""
    raw = _get("https://www.sec.gov/files/company_tickers.json", max_age_days, ("edgar", "company_tickers.json"))
    if not raw:
        return {}
    out = {}
    for v in json.loads(raw).values():
        out[str(v["ticker"]).upper().replace(".", "-")] = int(v["cik_str"])
    return out


def company_facts(cik: int, max_age_days: float = 30) -> dict | None:
    raw = _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json", max_age_days, ("edgar", f"CIK{cik:010d}.json"))
    time.sleep(EDGAR_PAUSE)
    return json.loads(raw) if raw else None


def _series(facts: dict, concepts: list[str], flow: bool) -> list[dict]:
    """Every fact for the given concepts across us-gaap and ifrs-full (a company
    switches concept names over the years: Apple's revenue is SalesRevenueNet
    before 2018 and RevenueFromContractWithCustomer... after), in money or shares."""
    out = []
    for tax in ("us-gaap", "ifrs-full"):
        group = facts.get("facts", {}).get(tax, {})
        for concept in concepts:
            units = group.get(concept, {}).get("units", {})
            for unit, rows in units.items():
                if unit in ("USD", "EUR", "DKK", "GBP", "CHF", "JPY", "shares", "USD/shares"):
                    out.extend(rows)
    return out


def _first_reported(rows: list[dict], key) -> pd.DataFrame:
    """Keep each period's value as first filed (no restatements), with its filing date."""
    recs = {}
    for r in rows:
        if "val" not in r or "end" not in r or "filed" not in r:
            continue
        k = key(r)
        if k is None:
            continue
        if k not in recs or r["filed"] < recs[k]["filed"]:
            recs[k] = {"end": r["end"], "filed": r["filed"], "val": float(r["val"]),
                       "start": r.get("start"), "fy": r.get("fy"), "fp": r.get("fp")}
    df = pd.DataFrame(list(recs.values()))
    if df.empty:
        return df
    df["end"] = pd.to_datetime(df["end"]).astype("datetime64[ns]")
    df["filed"] = pd.to_datetime(df["filed"]).astype("datetime64[ns]")
    return df.sort_values(["end", "filed"]).reset_index(drop=True)


def _quarterly_flows(rows: list[dict]) -> pd.DataFrame:
    """Trailing-twelve-month values of a flow (revenue, income, cash flow) at each
    period end, dated by the filing that completed them. Three routes, in order:
    the annual figure itself; the year-to-date identity (this year's YTD plus
    last year's annual minus last year's same YTD, which is how cash-flow
    statements, reported only cumulatively, become trailing figures); and the
    sum of four consecutive 3-month figures."""
    df = _first_reported([r for r in rows if r.get("start")], lambda r: (r["start"], r["end"]))
    if df.empty:
        return pd.DataFrame(columns=["end", "filed", "ttm"])
    df["start"] = pd.to_datetime(df["start"]).astype("datetime64[ns]")
    df["days"] = (df["end"] - df["start"]).dt.days
    ttm: dict[pd.Timestamp, tuple] = {}
    annual = df[(df["days"] >= 350) & (df["days"] <= 380)]
    for row in annual.itertuples():
        ttm[row.end] = (row.val, row.filed)
    ytd = df[(df["days"] >= 80) & (df["days"] <= 300)]
    a_ends = annual["end"].to_numpy()
    for row in ytd.itertuples():
        if row.end in ttm:
            continue
        # last year's annual ends just before this period starts
        gap = (row.start - annual["end"]).dt.days
        cand = annual[(gap >= 1) & (gap <= 12)]
        prev = ytd[((ytd["start"] - (row.start - pd.Timedelta(days=365))).dt.days.abs() <= 10)
                   & ((ytd["end"] - (row.end - pd.Timedelta(days=365))).dt.days.abs() <= 10)]
        if len(cand) and len(prev):
            a, p = cand.iloc[0], prev.iloc[0]
            ttm[row.end] = (row.val + a["val"] - p["val"], max(row.filed, a["filed"], p["filed"]))
    quarters = {row.end: (row.val, row.filed) for row in ytd[(ytd["days"] >= 80) & (ytd["days"] <= 100)].itertuples()}
    ends = sorted(quarters)
    for i, e in enumerate(ends):
        if e not in ttm and i >= 3 and (e - ends[i - 3]).days <= 300:
            vals = [quarters[x] for x in ends[i - 3:i + 1]]
            ttm[e] = (sum(v[0] for v in vals), max(v[1] for v in vals))
    out = [{"end": e, "filed": f, "ttm": v} for e, (v, f) in ttm.items()]
    return pd.DataFrame(out).sort_values("end").reset_index(drop=True) if out else pd.DataFrame(columns=["end", "filed", "ttm"])


def _shares(facts: dict) -> pd.DataFrame:
    """Shares outstanding per period end: the cover-page count (classes added up),
    else the balance-sheet count, else the diluted weighted average."""
    dei = facts.get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding", {}).get("units", {}).get("shares", [])
    cover = _instants(dei, sum_same_filing=True)
    bs = _instants(facts.get("facts", {}).get("us-gaap", {}).get("CommonStockSharesOutstanding", {}).get("units", {}).get("shares", []))
    wad_rows = facts.get("facts", {}).get("us-gaap", {}).get("WeightedAverageNumberOfDilutedSharesOutstanding", {}).get("units", {}).get("shares", [])
    wad = _first_reported([dict(r, start=None) for r in wad_rows if r.get("start") and 80 <= (pd.Timestamp(r["end"]) - pd.Timestamp(r["start"])).days <= 100],
                          lambda r: r["end"])
    wad = wad[["end", "filed", "val"]] if not wad.empty else pd.DataFrame(columns=["end", "filed", "val"])
    parts = [p for p in (cover, bs, wad) if not p.empty]
    if not parts:
        return pd.DataFrame(columns=["end", "filed", "val"])
    # prefer the earlier sources: keep the first value seen within 45 days of a period end
    merged = []
    for p in parts:
        for row in p.sort_values("end").itertuples():
            if all(abs((row.end - m["end"]).days) > 45 for m in merged):
                merged.append({"end": row.end, "filed": row.filed, "val": row.val})
    return pd.DataFrame(merged).sort_values("end").reset_index(drop=True)


def _instants(rows: list[dict], sum_same_filing: bool = False) -> pd.DataFrame:
    if sum_same_filing:
        # Several share classes report separate figures on one cover page: add them up
        agg = {}
        for r in rows:
            if "val" not in r:
                continue
            k = (r["end"], r["filed"])
            agg[k] = agg.get(k, 0.0) + float(r["val"])
        rows = [{"end": e, "filed": f, "val": v} for (e, f), v in agg.items()]
    df = _first_reported([r for r in rows if not r.get("start")], lambda r: r["end"])
    return df[["end", "filed", "val"]] if not df.empty else pd.DataFrame(columns=["end", "filed", "val"])


def extract_fundamentals(facts: dict) -> pd.DataFrame:
    """One row per quarter end: filed date, TTM revenue/net income/operating cash
    flow, assets, equity and shares outstanding, each as first reported."""
    parts = []
    for name, concepts in FLOW_CONCEPTS.items():
        f = _quarterly_flows(_series(facts, concepts, flow=True)).rename(columns={"ttm": name, "filed": f"filed_{name}"})
        parts.append(f)
    for name, concepts in STOCK_CONCEPTS.items():
        s = _instants(_series(facts, concepts, flow=False)).rename(columns={"val": name, "filed": f"filed_{name}"})
        parts.append(s)
    sh = _shares(facts).rename(columns={"val": "shares", "filed": "filed_shares"})
    parts.append(sh)
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame()
    # One row per distinct period end (fiscal calendars put the same quarter a few
    # days apart across concepts: ends within 45 days collapse onto the first seen)
    ends = []
    for e in sorted(set(pd.concat([p["end"] for p in parts]))):
        if not ends or (e - ends[-1]).days > 45:
            ends.append(e)
    table = pd.DataFrame({"end": pd.to_datetime(ends).astype("datetime64[ns]")})
    for p in parts:
        table = pd.merge_asof(table, p.sort_values("end"), on="end", direction="nearest", tolerance=pd.Timedelta(days=45))
    filed_cols = [c for c in table.columns if c.startswith("filed_")]
    table["filed"] = table[filed_cols].max(axis=1)  # the row is complete once its last piece was filed
    keep = ["end", "filed"] + [c for c in ("rev", "ni", "ocf", "assets", "equity", "shares") if c in table.columns]
    table = table[keep].dropna(subset=["filed"]).sort_values("end").reset_index(drop=True)
    return table


def fundamentals_tables(symbols: list[str], max_age_days: float = 30) -> dict[str, pd.DataFrame]:
    """symbol -> compact point-in-time fundamentals table, for every symbol the SEC knows."""
    ciks = cik_map()
    out = {}
    for sym in symbols:
        cik = ciks.get(sym.upper())
        if not cik:
            continue
        facts = company_facts(cik, max_age_days)
        if not facts:
            continue
        table = extract_fundamentals(facts)
        if len(table):
            out[sym] = table
    log.info("fundamentals for %d of %d symbols", len(out), len(symbols))
    return out


def split_factors(symbol: str, max_age_days: float = 30) -> pd.Series:
    """Cumulative split factor to bring a historical share count into today's terms."""
    import yfinance as yf
    path = _cache_path("splits", f"{symbol}.json")
    if _age_days(path) < max_age_days:
        data = json.load(open(path))
    else:
        try:
            s = yf.Ticker(symbol).splits
            data = {str(k.date()): float(v) for k, v in s.items()} if s is not None and len(s) else {}
        except Exception as exc:  # the feature survives without it
            log.warning("splits for %s failed: %s", symbol, exc)
            data = {}
        json.dump(data, open(path, "w"))
    if not data:
        return pd.Series(dtype=float)
    s = pd.Series(data)
    s.index = pd.to_datetime(s.index)
    return s.sort_index()


def fundamental_daily(table: pd.DataFrame, prices: pd.DataFrame, splits: pd.Series | None) -> pd.DataFrame:
    """Daily point-in-time features for one stock: each day uses the latest row
    filed before that day, shares brought into today's terms, market value from
    the (split-adjusted) close."""
    idx = prices.index
    out = pd.DataFrame(index=idx)
    if table is None or table.empty:
        return out
    t = table.copy()
    t["avail"] = t["filed"] + pd.Timedelta(days=1)  # usable from the day after filing
    if splits is not None and len(splits):
        # a share count reported before a split must be multiplied by every later split
        later = []
        for filed in t["filed"]:
            later.append(float(np.prod(splits[splits.index > filed].to_numpy())) if (splits.index > filed).any() else 1.0)
        t["shares_now"] = t["shares"] * np.array(later) if "shares" in t else np.nan
    else:
        t["shares_now"] = t["shares"] if "shares" in t else np.nan
    # lagged references (four quarters earlier) for growth-type features
    t = t.sort_values("end")
    for col in ("assets", "ni"):
        if col in t:
            prev = pd.merge_asof(t[["end"]].assign(ref=t["end"] - pd.Timedelta(days=365)).sort_values("ref"),
                                 t[["end", col]].rename(columns={"end": "ref_end", col: f"{col}_prev"}).sort_values("ref_end"),
                                 left_on="ref", right_on="ref_end", direction="nearest", tolerance=pd.Timedelta(days=45))
            t[f"{col}_prev"] = prev.set_index("end").reindex(t["end"])[f"{col}_prev"].to_numpy()
    t = t.sort_values("avail").drop_duplicates("avail", keep="last")
    left = pd.DataFrame({"date": pd.DatetimeIndex(idx).astype("datetime64[ns]")})
    right = t.rename(columns={"avail": "date"}).sort_values("date")
    right["date"] = right["date"].astype("datetime64[ns]")
    daily = pd.merge_asof(left, right, on="date", direction="backward")
    daily.index = idx
    close = prices["close"]
    mcap = daily["shares_now"] * close
    if "equity" in daily:
        # A share count that cannot be right (several share classes added up, a
        # cover page in thousands) makes a market value far from the book value:
        # better no valuation ratio than a wrong one
        implausible = (mcap < 0.05 * daily["equity"].abs()) | (mcap > 200 * daily["equity"].abs())
        mcap = mcap.where(~implausible.fillna(False))
    def ratio(a, b):
        return (a / b.replace(0, np.nan)).replace([np.inf, -np.inf], np.nan)
    if "ni" in daily:
        out["ey"] = ratio(daily["ni"], mcap).clip(-1, 1)
    if "equity" in daily:
        out["bm"] = ratio(daily["equity"], mcap).clip(-2, 5)
    if "rev" in daily:
        out["sp"] = ratio(daily["rev"], mcap).clip(0, 20)
    if "ocf" in daily:
        out["cfy"] = ratio(daily["ocf"], mcap).clip(-1, 1)
    if "assets" in daily:
        if "ni" in daily:
            out["roa"] = ratio(daily["ni"], daily["assets"]).clip(-1, 1)
        if "ocf" in daily:
            out["cfoa"] = ratio(daily["ocf"], daily["assets"]).clip(-1, 1)
        if "assets_prev" in daily:
            out["ag"] = (ratio(daily["assets"], daily["assets_prev"]) - 1).clip(-0.8, 3)
        if "ni_prev" in daily and "ni" in daily:
            out["fmom"] = ratio(daily["ni"] - daily["ni_prev"], daily["assets"]).clip(-1, 1)
        if "ni" in daily and "ocf" in daily:
            out["accr"] = ratio(daily["ni"] - daily["ocf"], daily["assets"]).clip(-1, 1)
    out["filing_age"] = ((idx - daily["filed"]).dt.days / 365.0).clip(0, 2)
    return out


# --- earnings calendar -----------------------------------------------------------

def earnings_events(symbol: str, max_age_days: float = 7) -> pd.DataFrame:
    """Past and announced earnings dates with estimate, reported EPS and surprise,
    as Yahoo lists them; the date is the trading day the news could first be traded."""
    import yfinance as yf
    path = _cache_path("earnings", f"{symbol}.json")
    if _age_days(path) < max_age_days:
        raw = json.load(open(path))
    else:
        raw = []
        try:
            ed = yf.Ticker(symbol).get_earnings_dates(limit=100)
            if ed is not None and len(ed):
                for ts, row in ed.iterrows():
                    local = ts.tz_convert("America/New_York") if ts.tzinfo else ts
                    eff = local.normalize() + pd.Timedelta(days=1 if local.hour >= 16 else 0)
                    raw.append({"date": str(eff.date()), "announced": str(local.date()),
                                "est": None if pd.isna(row.get("EPS Estimate")) else float(row["EPS Estimate"]),
                                "rep": None if pd.isna(row.get("Reported EPS")) else float(row["Reported EPS"]),
                                "surprise": None if pd.isna(row.get("Surprise(%)")) else float(row["Surprise(%)"])})
        except Exception as exc:
            log.warning("earnings dates for %s failed: %s", symbol, exc)
        json.dump(raw, open(path, "w"))
        time.sleep(0.3)
    df = pd.DataFrame(raw)
    if df.empty:
        return pd.DataFrame(columns=["date", "est", "rep", "surprise"])
    df["date"] = pd.to_datetime(df["date"]).astype("datetime64[ns]")
    return df.drop_duplicates("date").sort_values("date").reset_index(drop=True)


def earnings_daily(events: pd.DataFrame, prices: pd.DataFrame) -> pd.DataFrame:
    """Daily features for one stock: days since the last announcement and to the
    next expected one (a quarter later; in trading days, capped at a quarter), the
    last surprise, the post-earnings drift signal and the market's two-day
    reaction to the last announcement."""
    idx = prices.index
    out = pd.DataFrame(index=idx)
    if events is None or events.empty:
        return out
    pos = pd.Series(np.arange(len(idx)), index=idx)
    ev = events.copy()
    ev["pos"] = idx.searchsorted(ev["date"].to_numpy())  # first trading day >= effective date
    ev = ev[(ev["pos"] >= 0) & (ev["pos"] < len(idx) + 70)]
    # Days since / to
    past_pos = np.full(len(idx), np.nan)
    sue = np.full(len(idx), np.nan)
    react = np.full(len(idx), np.nan)
    logc = np.log(prices["close"].to_numpy())
    order = ev.sort_values("pos")
    for row in order.itertuples():
        p = int(row.pos)
        if p >= len(idx):
            continue
        past_pos[p:] = p
        s = np.nan if row.surprise is None or pd.isna(row.surprise) else float(np.clip(row.surprise, -100, 100)) / 100.0
        sue[p:] = s
        # the reaction over the announcement window: close before the news to close after it
        if 1 <= p < len(idx) - 1:
            react[p + 1:] = logc[p + 1] - logc[p - 1]
        elif 1 <= p:
            react[p:] = np.nan
    # The next announcement is *expected* a quarter (63 trading days) after the
    # last one: a date known on every day, with no peeking at the calendar as it
    # was eventually published
    i_arr = np.arange(len(idx))
    next_pos = past_pos + 63
    out["days_to_earn"] = np.clip(next_pos - i_arr, 0, 63) / 63.0
    out["days_since_earn"] = np.clip(i_arr - past_pos, 0, 63) / 63.0
    out["sue_last"] = sue
    out["pead"] = np.where((i_arr - past_pos) <= 60, sue, 0.0)
    out["ear_ret"] = np.clip(react, -0.5, 0.5)
    out.loc[np.isnan(past_pos), ["days_to_earn", "days_since_earn", "sue_last", "pead", "ear_ret"]] = np.nan
    return out


# --- extra market context ------------------------------------------------------------

def fred_series(series_id: str, max_age_days: float = 1) -> pd.Series:
    raw = _get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}", max_age_days, ("fred", f"{series_id}.csv"))
    if not raw:
        return pd.Series(dtype=float)
    df = pd.read_csv(io.BytesIO(raw))
    df.columns = ["date", "value"]
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    s = df.dropna().set_index(pd.to_datetime(df.dropna()["date"]))["value"]
    s.index.name = "date"
    return s.sort_index()


def context_extra(prices: dict[str, pd.DataFrame]) -> dict[str, pd.Series]:
    """Series for the ctx2 pack: Yahoo ones from the downloaded prices, FRED ones fetched."""
    out = {}
    for name, sym in CTX2_YAHOO.items():
        if sym in prices:
            out[name] = prices[sym]["close"]
    for name, sid in CTX2_FRED.items():
        s = fred_series(sid)
        if len(s):
            out[name] = s
    return out


def context_extra_features(index: pd.DatetimeIndex, series: dict[str, pd.Series], vix: pd.Series | None) -> pd.DataFrame:
    """The ctx2 feature columns on the market's calendar. FRED series are lagged a day."""
    x = pd.DataFrame(index=index)
    def on(name, lag=0):
        s = series.get(name)
        if s is None:
            return None
        return s.reindex(index, method="ffill").shift(lag)
    v3, v9, sk, dx = on("vix3m"), on("vix9d"), on("skew"), on("dxy")
    if vix is not None and v3 is not None:
        x["vix_ts"] = vix.reindex(index).ffill() / v3 - 1          # >0: backwardation (stress)
    if vix is not None and v9 is not None:
        x["vix_ts9"] = v9 / vix.reindex(index).ffill() - 1
    if sk is not None:
        x["skew"] = (sk - 120) / 20
    if dx is not None:
        x["dxy_chg21"] = dx / dx.shift(21) - 1
        x["dxy_rel200"] = dx / dx.rolling(200).mean() - 1
    hy, d2, slope = on("hy_oas", 1), on("dgs2", 1), on("t10y2y", 1)
    if hy is not None:
        x["hy_oas"] = hy
        x["hy_chg21"] = hy - hy.shift(21)
    if d2 is not None:
        x["dgs2_chg21"] = d2 - d2.shift(21)
    if slope is not None:
        x["curve_slope"] = slope
    return x


# --- the production store ---------------------------------------------------------
# The pipeline runs on a fresh machine every time, so it can't keep a cache. It
# carries a compact store of what it fetched in its own output (altdata.json.gz),
# reads it back from the previous run and refreshes a slice of symbols each
# run: everything is at most a week old, a company is refreshed as soon as an
# earnings date has passed, and no run downloads more than a few dozen filings.

STORE_NAME = "altdata.json.gz"
REFRESH_DAYS = 7
REFRESH_BUDGET = 40
_COLS = ["end", "filed", "rev", "ni", "ocf", "assets", "equity", "shares"]


def load_store(prev_dir: str | None) -> dict:
    if prev_dir:
        path = os.path.join(prev_dir, STORE_NAME)
        if os.path.exists(path):
            try:
                with gzip.open(path, "rt", encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, ValueError) as exc:
                log.warning("could not read the previous %s: %s", STORE_NAME, exc)
    return {"fundamentals": {}, "earnings": {}, "splits": {}}


def dump_store(store: dict, out_dir: str):
    with gzip.open(os.path.join(out_dir, STORE_NAME), "wt", encoding="utf-8") as fh:
        json.dump(store, fh, separators=(",", ":"))


def _table_to_rows(table: pd.DataFrame) -> list:
    rows = []
    for r in table.itertuples(index=False):
        d = r._asdict()
        rows.append([str(d["end"].date()), str(d["filed"].date())] + [None if pd.isna(d.get(c, np.nan)) else float(d[c]) for c in _COLS[2:]])
    return rows


def _rows_to_table(rows: list) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame()
    t = pd.DataFrame(rows, columns=_COLS)
    t["end"] = pd.to_datetime(t["end"]).astype("datetime64[ns]")
    t["filed"] = pd.to_datetime(t["filed"]).astype("datetime64[ns]")
    return t


def refresh_store(store: dict, symbols: list[str], now: datetime, budget: int = REFRESH_BUDGET) -> dict:
    """Bring the store up to date for `symbols`: stale entries first (oldest), then
    anything whose announced earnings date has passed since it was fetched."""
    today = pd.Timestamp(now.date())
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    fund, earn, splits = store.setdefault("fundamentals", {}), store.setdefault("earnings", {}), store.setdefault("splits", {})
    ciks = cik_map()

    def age(entry):
        return (today - pd.Timestamp(entry["fetchedAt"][:10])).days if entry and entry.get("fetchedAt") else 10 ** 6

    due = []
    for sym in symbols:
        e = earn.get(sym)
        passed = bool(e and any(pd.Timestamp(ev["date"]) > pd.Timestamp(e["fetchedAt"][:10]) and pd.Timestamp(ev["date"]) <= today
                                for ev in e.get("events", [])))
        oldest = max(age(fund.get(sym)) if sym in ciks else 0, age(e))
        if passed or oldest >= REFRESH_DAYS:
            due.append((0 if passed else 1, -oldest, sym))
    due.sort()
    todo = [sym for _, _, sym in due[:budget]]
    log.info("altdata: %d symbols due for a refresh, doing %d", len(due), len(todo))
    for sym in todo:
        if sym in ciks:
            facts = company_facts(ciks[sym], max_age_days=0)
            if facts:
                table = extract_fundamentals(facts)
                fund[sym] = {"fetchedAt": stamp, "cik": ciks[sym], "rows": _table_to_rows(table) if len(table) else []}
        ev = earnings_events(sym, max_age_days=0)
        earn[sym] = {"fetchedAt": stamp, "events": [{"date": str(r.date.date()), "surprise": None if pd.isna(r.surprise) else float(r.surprise),
                                                     "est": None if pd.isna(r.est) else float(r.est), "rep": None if pd.isna(r.rep) else float(r.rep)}
                                                    for r in ev.itertuples()]}
        sp = split_factors(sym, max_age_days=0)
        splits[sym] = {str(k.date()): float(v) for k, v in sp.items()}
    return store


def frames_from_store(store: dict, prices: dict[str, pd.DataFrame], symbols: list[str], flags: set) -> dict[str, pd.DataFrame]:
    """Per-symbol daily frames for the fund and earn packs from the store."""
    out = {}
    for sym in symbols:
        if sym not in prices:
            continue
        frame = None
        if "fund" in flags and store.get("fundamentals", {}).get(sym, {}).get("rows"):
            sp = pd.Series(store.get("splits", {}).get(sym, {}), dtype=float)
            sp.index = pd.to_datetime(sp.index) if len(sp) else sp.index
            frame = fundamental_daily(_rows_to_table(store["fundamentals"][sym]["rows"]), prices[sym], sp.sort_index() if len(sp) else None)
        if "earn" in flags and store.get("earnings", {}).get(sym, {}).get("events"):
            ev = pd.DataFrame(store["earnings"][sym]["events"])
            ev["date"] = pd.to_datetime(ev["date"]).astype("datetime64[ns]")
            e = earnings_daily(ev, prices[sym])
            frame = e if frame is None else frame.join(e, how="outer")
        if frame is not None and len(frame.columns):
            out[sym] = frame
    return out
