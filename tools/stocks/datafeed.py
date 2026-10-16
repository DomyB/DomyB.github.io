"""Market data for the Stocks page: daily prices and company fundamentals.

Everything comes from Yahoo Finance through the `yfinance` library. Prices are
split- and dividend-adjusted so that indicators don't see fake jumps. The
functions here only fetch and tidy; the modelling lives in features.py,
models.py and fundamentals.py.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import yfinance as yf

log = logging.getLogger("stocks.datafeed")

# Series that describe the market as a whole. They become features for every
# stock (how the index is doing, how nervous options traders are, where
# interest rates stand) and are never shown as tracked symbols themselves.
CONTEXT_SYMBOLS = {"market": "SPY", "vix": "^VIX", "rates": "^TNX"}

# Fields copied from Yahoo's company profile. Missing fields are simply absent.
INFO_FIELDS = [
    "shortName", "longName", "sector", "industry", "currency", "quoteType",
    "exchange", "country", "website", "longBusinessSummary",
    "marketCap", "enterpriseValue", "sharesOutstanding", "beta",
    "currentPrice", "regularMarketPrice", "previousClose", "regularMarketPreviousClose",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow",
    "trailingPE", "forwardPE", "pegRatio", "trailingPegRatio", "priceToBook",
    "priceToSalesTrailing12Months", "enterpriseToEbitda", "enterpriseToRevenue",
    "trailingEps", "forwardEps", "bookValue", "totalRevenue", "ebitda",
    "revenueGrowth", "earningsGrowth", "earningsQuarterlyGrowth",
    "grossMargins", "operatingMargins", "profitMargins", "returnOnEquity", "returnOnAssets",
    "freeCashflow", "operatingCashflow", "totalCash", "totalDebt", "debtToEquity",
    "currentRatio", "quickRatio", "dividendYield", "dividendRate", "payoutRatio",
    "targetMeanPrice", "targetMedianPrice", "targetHighPrice", "targetLowPrice",
    "numberOfAnalystOpinions", "recommendationMean", "recommendationKey",
    "shortPercentOfFloat", "shortRatio", "heldPercentInstitutions", "heldPercentInsiders",
    "nextFiscalYearEnd", "lastFiscalYearEnd", "mostRecentQuarter",
]


def _retry(fn, attempts=3, wait=4.0, what="request"):
    last = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as exc:  # network hiccups, rate limits
            last = exc
            log.warning("%s failed (%d/%d): %s", what, i + 1, attempts, exc)
            time.sleep(wait * (i + 1))
    raise RuntimeError(f"{what} failed after {attempts} attempts: {last}")


def download_prices(symbols: list[str], years: int = 12) -> dict[str, pd.DataFrame]:
    """Daily adjusted OHLCV for every symbol, as {symbol: DataFrame}.

    Each frame has the columns open, high, low, close, volume and a tz-naive
    DatetimeIndex of trading days. Symbols Yahoo doesn't know are left out
    (and logged) instead of failing the whole run.
    """
    symbols = list(dict.fromkeys(symbols))
    raw = _retry(
        lambda: yf.download(
            symbols, period=f"{years}y", interval="1d", auto_adjust=True,
            group_by="ticker", threads=True, progress=False,
        ),
        what="price download",
    )
    out: dict[str, pd.DataFrame] = {}
    for sym in symbols:
        try:
            df = raw[sym] if isinstance(raw.columns, pd.MultiIndex) else raw
        except KeyError:
            log.warning("no price data for %s", sym)
            continue
        df = df.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].copy()
        df = df.dropna(subset=["close"])
        df = df[df["close"] > 0]
        if len(df) < 300:
            log.warning("too little history for %s (%d days): skipped", sym, len(df))
            continue
        df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
        df = df[~df.index.duplicated(keep="last")].sort_index()
        # Yahoo occasionally reports a zero or missing volume on the live bar.
        df["volume"] = df["volume"].replace(0, np.nan)
        out[sym] = df
    return out


def fetch_info(symbol: str) -> dict:
    """Company profile and fundamentals for one symbol (a subset of Yahoo's `info`)."""
    def get():
        info = yf.Ticker(symbol).info or {}
        if not info or ("regularMarketPrice" not in info and "currentPrice" not in info):
            raise RuntimeError("empty profile")
        # When Yahoo's crumb check fails, yfinance quietly returns only the price
        # module (a dozen keys, no sector, no ratios). Treat that as a failure
        # so it's retried, or replaced by the previous run's values.
        if info.get("quoteType", "EQUITY") == "EQUITY" and "sector" not in info:
            raise RuntimeError(f"incomplete profile ({len(info)} fields)")
        return info

    try:
        info = _retry(get, attempts=3, wait=3.0, what=f"profile for {symbol}")
    except RuntimeError as exc:
        log.warning("%s", exc)
        return {}
    picked = {k: info.get(k) for k in INFO_FIELDS if info.get(k) is not None}
    picked["fetchedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return picked


def fetch_all_info(symbols: list[str], pause: float = 0.35) -> dict[str, dict]:
    """Profiles for many symbols, politely spaced so Yahoo doesn't throttle us."""
    infos = {}
    for i, sym in enumerate(symbols):
        infos[sym] = fetch_info(sym)
        if i + 1 < len(symbols):
            time.sleep(pause)
    return infos


def market_session_state(now_utc: datetime | None = None) -> dict:
    """Whether the US and Milan markets are open right now (regular hours only).

    Used only for labelling ("live" vs "closed"); it ignores exchange holidays,
    which simply show up as a day without a new bar.
    """
    from zoneinfo import ZoneInfo

    now_utc = now_utc or datetime.now(timezone.utc)

    def state(tz, open_h, open_m, close_h, close_m):
        local = now_utc.astimezone(ZoneInfo(tz))
        if local.weekday() >= 5:
            return "closed"
        minutes = local.hour * 60 + local.minute
        return "open" if open_h * 60 + open_m <= minutes < close_h * 60 + close_m else "closed"

    return {
        "us": state("America/New_York", 9, 30, 16, 0),
        "milan": state("Europe/Rome", 9, 0, 17, 30),
    }
