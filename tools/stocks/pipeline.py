#!/usr/bin/env python3
"""Build the data behind the Stocks page (https://domyb.github.io/stocks/).

    python tools/stocks/pipeline.py --out build/stocks [--prev <previous output>] [--full]

Steps, in order:

1. Read the tracked symbols from _data/stocks.yml and download twelve years of
   daily prices for them, for the extra training symbols and for the market
   context series (S&P 500, VIX, 10-year yield).
2. Compute technical features and forecast targets for every stock and day.
3. Backtest the model walk-forward (reused from the previous run when nothing
   new has closed since), calibrate it and measure how good it really is.
4. Fit the final model and forecast every tracked stock over four horizons.
5. Fetch fundamentals, estimate fair values and score each company.
6. Record today's forecasts in the ledger and grade the old ones that have
   come due, so the page can show a live track record.
7. Write summary.json, backtest.json, ledger.json.gz and tickers/<SYMBOL>.json.

Options:
  --prev DIR   previous output (the stock-data branch): ledger, backtest and
               fundamentals are carried forward from it.
  --full       run the backtest even if the previous one is still current.
  --limit N    only the first N symbols of each list (for quick tests).
  --years N    years of history (default 16).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import math
import os
import sys
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import models  # noqa: E402
import features  # noqa: E402
from datafeed import CONTEXT_SYMBOLS, download_prices, fetch_all_info, market_session_state  # noqa: E402
from features import HORIZON_LABELS, HORIZONS, build_panel, context_features, indicators  # noqa: E402
from fundamentals import fair_value, fundamental_score, fundamental_view, sector_medians  # noqa: E402
from signals import technical_readings, technical_score  # noqa: E402
from universe import SECTOR, SECTOR_ETFS, TRAINING_ONLY  # noqa: E402

log = logging.getLogger("stocks")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VERSION = 2
RECENT_FROM = "2021-01-01"  # the "recent years" window the page leads with
HISTORY_BARS = 504        # two years of daily bars in each ticker file
SPARK_BARS = 60           # closes in the overview sparkline
LEDGER_KEEP_DAYS = 3 * 365

# Regular trading hours by symbol suffix (Yahoo style), for spotting a bar that is still live.
EXCHANGE_HOURS = {
    "": ("America/New_York", 16 * 60),
    ".MI": ("Europe/Rome", 17 * 60 + 30), ".PA": ("Europe/Paris", 17 * 60 + 30), ".DE": ("Europe/Berlin", 17 * 60 + 30),
    ".AS": ("Europe/Amsterdam", 17 * 60 + 30), ".MC": ("Europe/Madrid", 17 * 60 + 30), ".SW": ("Europe/Zurich", 17 * 60 + 30),
    ".L": ("Europe/London", 16 * 60 + 30), ".T": ("Asia/Tokyo", 15 * 60 + 30), ".HK": ("Asia/Hong_Kong", 16 * 60),
    ".TO": ("America/Toronto", 16 * 60),
}


# --- small helpers ------------------------------------------------------------

def clean(obj):
    """Make an object JSON-safe: numpy scalars to Python, NaN/inf to null, Timestamps to dates."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        return float(obj) if math.isfinite(float(obj)) else None
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.strftime("%Y-%m-%d")
    if isinstance(obj, np.ndarray):
        return clean(obj.tolist())
    return obj


def dump(obj, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(clean(obj), fh, separators=(",", ":"), ensure_ascii=False)


def rprice(x):
    if x is None or not math.isfinite(x):
        return None
    return round(float(x), 2 if abs(x) >= 10 else 4)


def r4(x):
    return None if x is None or not math.isfinite(float(x)) else round(float(x), 4)


def exchange_for(symbol: str):
    for suffix, hours in EXCHANGE_HOURS.items():
        if suffix and symbol.endswith(suffix):
            return hours
    return EXCHANGE_HOURS[""]


def is_partial(symbol: str, last_bar: pd.Timestamp, now_utc: datetime) -> bool:
    tz, close_min = exchange_for(symbol)
    local = now_utc.astimezone(ZoneInfo(tz))
    if last_bar.date() != local.date():
        return False
    return local.hour * 60 + local.minute < close_min + 20  # a little slack for the closing print


def load_universe(limit: int | None):
    with open(os.path.join(ROOT, "_data", "stocks.yml"), encoding="utf-8") as fh:
        entries = yaml.safe_load(fh) or []
    tracked, names = [], {}
    for e in entries:
        if isinstance(e, str):
            e = {"symbol": e}
        sym = str(e.get("symbol", "")).strip().upper()
        if not sym or sym in tracked:
            continue
        tracked.append(sym)
        if e.get("name"):
            names[sym] = str(e["name"])
    training = [s for s in TRAINING_ONLY if s not in tracked]
    if limit:
        tracked, training = tracked[:limit], training[:limit]
    return tracked, training, names


def load_membership() -> dict:
    """symbol -> first date it counts in the cross-section (tools/stocks/data/membership.csv)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "membership.csv")
    if not os.path.exists(path):
        return {}
    m = pd.read_csv(path)
    return {r.symbol: pd.Timestamp(r.from_date) for r in m.itertuples()}


def read_prev(prev_dir: str | None, name: str):
    if not prev_dir:
        return None
    path = os.path.join(prev_dir, name)
    if not os.path.exists(path):
        return None
    try:
        if name.endswith(".gz"):
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                return json.load(fh)
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        log.warning("could not read previous %s: %s", name, exc)
        return None


# --- scores ------------------------------------------------------------------

CONVICTION_WEIGHTS = {1: 0.35, 5: 0.25, 21: 0.2, 63: 0.2}  # weighted towards the horizons where the backtest shows skill


def model_score(forecasts: dict[int, dict]) -> float | None:
    """0–100 from the model's calibrated conviction across horizons (50 = no view)."""
    num = den = 0.0
    for hzn, w in CONVICTION_WEIGHTS.items():
        f = forecasts.get(hzn)
        if f and f.get("conviction") is not None and math.isfinite(f["conviction"]):
            num += w * f["conviction"]
            den += w
    if not den:
        return None
    return float(np.clip(50 + 22 * (num / den), 5, 95))


def overall_score(model: float | None, technical: float | None, fundamental: float | None) -> float | None:
    parts = [(model, 0.45), (technical, 0.20), (fundamental, 0.35)]
    avail = [(v, w) for v, w in parts if v is not None]
    total = sum(w for _, w in avail)
    return float(sum(v * w for v, w in avail) / total) if total else None


def outlook_label(score: float | None) -> str | None:
    if score is None:
        return None
    return "positive" if score >= 62 else "negative" if score <= 38 else "neutral"


# --- the ledger ---------------------------------------------------------------

def update_ledger(entries: list[dict], forecasts: pd.DataFrame, prices: dict[str, pd.DataFrame],
                  partial: set[str], tracked: list[str]) -> list[dict]:
    """Add today's forecasts (replacing an earlier intraday record of the same day) and grade due ones."""
    by_id = {e["id"]: e for e in entries}
    for row in forecasts.itertuples():
        date = row.date.strftime("%Y-%m-%d")
        eid = f"{row.symbol}|{date}|{row.h}"
        old = by_id.get(eid)
        if old and not old.get("partial"):
            continue  # a forecast made on the final close is never rewritten
        by_id[eid] = {
            "id": eid, "symbol": row.symbol, "date": date, "h": int(row.h),
            "price": rprice(prices[row.symbol]["close"].iloc[-1]),
            "ret": r4(row.ret), "relRet": r4(row.rel_ret), "p10": r4(row.p10), "p90": r4(row.p90),
            "pUp": r4(row.p_up), "partial": row.symbol in partial, "resolved": False,
        }
    entries = list(by_id.values())

    # Grade entries whose horizon has passed
    for e in entries:
        if e.get("resolved") or e["symbol"] not in prices:
            continue
        df = prices[e["symbol"]]
        pos = df.index.get_indexer([pd.Timestamp(e["date"])])[0]
        if pos < 0:
            continue
        due = pos + e["h"]
        if due >= len(df) or (e["symbol"] in partial and due == len(df) - 1):
            continue
        real = float(df["close"].iloc[due] / df["close"].iloc[pos] - 1)
        e.update({
            "resolved": True, "resolvedOn": df.index[due].strftime("%Y-%m-%d"), "real": r4(real),
            "hit": bool((e["ret"] or 0) >= 0) == bool(real >= 0),
            "inBand": bool(e["p10"] is not None and e["p90"] is not None and e["p10"] <= real <= e["p90"]),
        })

    # Relative outcome: against the average of the tracked stocks forecast the same day
    groups: dict[tuple, list] = {}
    for e in entries:
        if e.get("resolved") and e["symbol"] in tracked:
            groups.setdefault((e["date"], e["h"]), []).append(e)
    for members in groups.values():
        if len(members) < 8:
            continue
        mean_real = float(np.mean([m["real"] for m in members]))
        for m in members:
            rel_real = m["real"] - mean_real
            m["relReal"] = r4(rel_real)
            m["relHit"] = bool((m.get("relRet") or 0) >= 0) == bool(rel_real >= 0)

    # Forget very old graded entries
    cutoff = (datetime.now(timezone.utc) - pd.Timedelta(days=LEDGER_KEEP_DAYS)).strftime("%Y-%m-%d")
    entries = [e for e in entries if not e.get("resolved") or e["date"] >= cutoff]
    entries.sort(key=lambda e: (e["date"], e["symbol"], e["h"]))
    return entries


def ledger_stats(entries: list[dict], tracked: list[str]) -> dict:
    stats = {}
    for hzn in HORIZONS:
        done = [e for e in entries if e.get("resolved") and e["h"] == hzn and e["symbol"] in tracked]
        if not done:
            stats[str(hzn)] = {"n": 0}
            continue
        rel = [e for e in done if "relHit" in e]
        preds = np.array([e["ret"] for e in done], dtype=float)
        reals = np.array([e["real"] for e in done], dtype=float)
        stats[str(hzn)] = {
            "n": len(done),
            "from": min(e["date"] for e in done), "to": max(e["date"] for e in done),
            "hit_rate": float(np.mean([e["hit"] for e in done])),
            "up_rate": float(np.mean(reals > 0)),
            "rel_hit_rate": float(np.mean([e["relHit"] for e in rel])) if rel else None,
            "rel_n": len(rel),
            "coverage80": float(np.mean([e["inBand"] for e in done])),
            "mae_model": float(np.mean(np.abs(reals - preds))),
            "mae_zero": float(np.mean(np.abs(reals))),
            "ic_pooled": models._spearman(preds, reals) if len(done) >= 10 else None,
        }
    pending = [e for e in entries if not e.get("resolved")]
    return {"horizons": stats, "pending": len(pending),
            "since": min((e["date"] for e in entries), default=None)}


# --- main --------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev")
    ap.add_argument("--full", action="store_true")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--years", type=int, default=16)
    ap.add_argument("--skip-fundamentals", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    t_start = time.time()
    now = datetime.now(timezone.utc)

    # 1. Universe and prices
    tracked, training, names = load_universe(args.limit)
    log.info("%d tracked symbols, %d extra training symbols", len(tracked), len(training))
    features.FEATURE_FLAGS = set(features.PRODUCTION_FLAGS)
    sector_etfs = sorted(set(SECTOR_ETFS.values())) if "sector" in features.FEATURE_FLAGS else []
    prices = download_prices(tracked + training + list(CONTEXT_SYMBOLS.values()) + sector_etfs, years=args.years)
    tracked = [s for s in tracked if s in prices]
    training = [s for s in training if s in prices]
    if "membership" in features.FEATURE_FLAGS:
        features.MEMBERSHIP = load_membership()
    market = prices.get(CONTEXT_SYMBOLS["market"])
    if market is None:
        raise SystemExit("no market data (SPY): giving up")

    partial = {s for s in tracked + training if is_partial(s, prices[s].index[-1], now)}
    for s in partial:
        prices[s].iloc[-1, prices[s].columns.get_loc("volume")] = np.nan  # a half day's volume says nothing
    market_last_complete = market.index[-2] if CONTEXT_SYMBOLS["market"] in partial else market.index[-1]
    log.info("prices downloaded; %d symbols have a live (unfinished) bar; last complete market day %s",
             len(partial), market_last_complete.date())

    # 2. Features
    ctx = context_features(market, prices.get(CONTEXT_SYMBOLS["vix"]), prices.get(CONTEXT_SYMBOLS["rates"]))
    universe = {s: prices[s] for s in tracked + training}
    sector_prices = {name: prices[etf] for name, etf in SECTOR_ETFS.items() if etf in prices} if sector_etfs else None
    panel, feature_names = build_panel(universe, ctx, partial, sectors=SECTOR, sector_prices=sector_prices)
    # A "real" cross-section needs 30 names; with a small test universe, settle for half of it
    models.MIN_CROSS_SECTION = min(30, max(10, len(universe) // 2))
    log.info("panel: %d rows × %d features", len(panel), len(feature_names))

    # 3. Backtest (reused when nothing new has closed since the previous one)
    membership_sig = hashlib.sha1(repr(sorted((k, str(v.date())) for k, v in features.MEMBERSHIP.items())).encode()).hexdigest()[:8]
    knobs = repr((models.TARGET, models.SMOOTH_DAYS, models.BLEND, models.RIDGE_CS, models.RIDGE_ALPHA, models.GBM_PARAMS,
                  models.N_SEEDS, models.SEED_OFFSET, models.TRAIN_STRIDE, models.TRAIN_WINDOW_DAYS, models.RECENCY_HALFLIFE,
                  models.ENSEMBLE_WEIGHTS, models.DRIFT_SHRINK, models.MIN_CROSS_SECTION, features.BETA_SHRINK,
                  features.FEATURE_VERSION, VERSION, membership_sig))
    universe_hash = hashlib.sha1(("|".join(sorted(universe)) + "|" + "|".join(feature_names) + "|" + knobs).encode()).hexdigest()[:12]
    prev_bt = read_prev(args.prev, "backtest.json")
    reuse = (not args.full and prev_bt and prev_bt.get("universeHash") == universe_hash
             and prev_bt.get("trainedThrough") == market_last_complete.strftime("%Y-%m-%d")
             and all(str(h) in prev_bt.get("calibration", {}) for h in HORIZONS))
    if reuse:
        log.info("backtest from %s is still current: reusing it", prev_bt["generatedAt"])
        backtest = prev_bt
        cal = {int(h): c for h, c in prev_bt["calibration"].items()}
    else:
        log.info("running the walk-forward backtest")
        oos = models.walk_forward(panel, feature_names)
        cal = models.calibrate(oos)
        report = models.evaluate(oos, cal)
        # The same numbers for the recent years only (the headline the page leads
        # with, so early high-skill years can't flatter it) and for the tracked
        # symbols only (noisier: fewer names per day)
        recent = oos[oos["date"] >= RECENT_FROM]
        report_recent = models.evaluate(recent, cal) if len(recent) > 20000 else {}
        tracked_rows = oos[oos["symbol"].isin(tracked)]
        report_tracked = models.evaluate(tracked_rows, cal) if len(tracked_rows) > 20000 else {}
        backtest = {
            "version": VERSION, "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "trainedThrough": market_last_complete.strftime("%Y-%m-%d"), "universeHash": universe_hash,
            "universeSize": len(universe), "trackedSize": len(tracked), "features": len(feature_names),
            "featureNames": feature_names, "horizons": HORIZONS, "target": models.TARGET,
            "flags": sorted(features.FEATURE_FLAGS), "smoothDays": models.SMOOTH_DAYS, "blend": models.BLEND,
            "oosRows": int(len(oos)), "report": report, "reportRecent": report_recent, "reportTracked": report_tracked,
            "recentFrom": RECENT_FROM,
            "calibration": {str(h): {k: v for k, v in c.items()} for h, c in cal.items()},
        }
        del oos

    # 4. Final model and forecasts
    final = models.fit_final(panel, feature_names)
    fc = models.forecast_latest(panel, feature_names, final, cal, tracked)
    if not reuse or "importance" not in backtest:
        try:
            backtest["importance"] = models.feature_importance(final, panel, feature_names, hzn=21)
        except Exception as exc:  # purely informative
            log.warning("feature importance failed: %s", exc)
            backtest["importance"] = []
    drift = {str(h): final[h]["drift"] for h in HORIZONS}
    log.info("forecasts ready (%d rows) in %.0fs", len(fc), time.time() - t_start)

    # 5. Fundamentals
    prev_summary = read_prev(args.prev, "summary.json") or {}
    prev_tickers = {t["symbol"]: t for t in prev_summary.get("tickers", [])}
    infos = {} if args.skip_fundamentals else fetch_all_info(tracked)
    for sym in tracked:
        if not infos.get(sym):
            # Yahoo throttles the profile endpoint now and then: keep the previous
            # run's values (and keep looking back while they are themselves incomplete).
            prev_file = read_prev(args.prev, os.path.join("tickers", f"{sym}.json")) or {}
            prev_info = prev_file.get("fundamentals", {}).get("info") or {}
            if prev_info and ("sector" in prev_info or prev_info.get("quoteType") == "ETF"):
                infos[sym] = dict(prev_info, stale=True)
                log.info("using previous fundamentals for %s", sym)
            elif prev_info:
                infos[sym] = dict(prev_info, stale=True, incomplete=True)
                log.warning("only an incomplete profile is available for %s", sym)
    medians = sector_medians(infos)

    # 6. Ledger
    ledger = (read_prev(args.prev, "ledger.json.gz") or {}).get("entries", [])
    ledger = update_ledger(ledger, fc, prices, partial, tracked)
    lstats = ledger_stats(ledger, tracked)

    # 7. Per-ticker files and the summary
    os.makedirs(os.path.join(args.out, "tickers"), exist_ok=True)
    latest_rows = panel.groupby(level="symbol").tail(1)
    latest_rows.index = latest_rows.index.get_level_values("symbol")
    summary_tickers = []
    breadth_above200 = breadth_up = 0
    for sym in tracked:
        df = prices[sym]
        info = infos.get(sym) or {}
        row = latest_rows.loc[sym].to_dict() if sym in latest_rows.index else {}
        ind = indicators(df)
        close = float(df["close"].iloc[-1])
        prev_close = float(df["close"].iloc[-2]) if len(df) > 1 else None
        quote_type = info.get("quoteType") or ("ETF" if sym in ("SPY", "QQQ", "IWM", "GLD", "TLT", "DIA") else "EQUITY")
        name = names.get(sym) or info.get("shortName") or info.get("longName") or sym
        currency = info.get("currency") or ("EUR" if sym.endswith(".MI") else "USD")

        fcs = {}
        for r in fc[fc["symbol"] == sym].itertuples():
            fcs[int(r.h)] = {"ret": r.ret, "relRet": r.rel_ret, "p10": r.p10, "p25": r.p25, "p75": r.p75,
                             "p90": r.p90, "pUp": r.p_up, "conviction": r.conviction, "sigma": r.sigma,
                             "drift": r.drift, "z": r.z}
        readings, parts = technical_readings(row)
        tscore = technical_score(parts)
        fv = fair_value(info, close, medians) if quote_type != "ETF" else {"methods": {}, "inputs": {}}
        fscore = fundamental_score(info, close, medians, fv) if quote_type != "ETF" else {}
        view = fundamental_view(fv, info, close) if fv.get("value") else None
        mscore = model_score(fcs)
        oscore = overall_score(mscore, tscore, fscore.get("score"))
        if row.get("sma200_gap") is not None and row["sma200_gap"] > 0:
            breadth_above200 += 1
        if fcs.get(21, {}).get("pUp", 0.5) > 0.5:
            breadth_up += 1

        hist = df.tail(HISTORY_BARS)
        ind_h = ind.loc[hist.index]
        macd_px = ind_h["macd"] * hist["close"]
        year_start = df[df.index.year == df.index[-1].year]
        stats = {
            "high52": rprice(df["high"].tail(252).max()), "low52": rprice(df["low"].tail(252).min()),
            "avgVolume20": int(np.nan_to_num(df["volume"].tail(20).mean())),
            "vol21": r4(row.get("vol21")), "beta63": r4(row.get("beta63")),
            "ytd": r4(close / float(year_start["close"].iloc[0]) - 1) if len(year_start) > 1 else None,
            "ret1y": r4(close / float(df["close"].iloc[-253]) - 1) if len(df) > 253 else None,
            "ret1m": r4(close / float(df["close"].iloc[-22]) - 1) if len(df) > 22 else None,
            "maxDrawdown1y": r4(float((df["close"].tail(252) / df["close"].tail(252).cummax() - 1).min())),
        }
        sym_ledger = [e for e in ledger if e["symbol"] == sym]
        header = {
            "symbol": sym, "name": name, "sector": info.get("sector"), "industry": info.get("industry"),
            "type": quote_type, "currency": currency, "exchange": info.get("exchange"),
            "price": rprice(close), "prevClose": rprice(prev_close),
            "change": rprice(close - prev_close) if prev_close else None,
            "changePct": r4(close / prev_close - 1) if prev_close else None,
            "open": rprice(df["open"].iloc[-1]), "dayHigh": rprice(df["high"].iloc[-1]), "dayLow": rprice(df["low"].iloc[-1]),
            "volume": int(np.nan_to_num(df["volume"].iloc[-1])) or None,
            "asOf": df.index[-1].strftime("%Y-%m-%d"), "live": sym in partial,
            "marketCap": info.get("marketCap"),
            "scores": {"model": mscore, "technical": tscore, "fundamental": fscore.get("score"), "overall": oscore,
                       "outlook": outlook_label(oscore)},
            "forecasts": {str(h): {k: r4(v) for k, v in f.items()} for h, f in fcs.items()},
            "fairValue": ({"value": rprice(fv["value"]), "marginOfSafety": r4(fv["marginOfSafety"]),
                           "label": view["label"] if view else None} if fv.get("value") else None),
            "view12m": {k: (r4(v) if isinstance(v, float) else v) for k, v in view.items()} if view else None,
        }
        summary_tickers.append({**header, "spark": [rprice(v) for v in df["close"].tail(SPARK_BARS)],
                                "stances": {g: _group_stance(readings, g) for g in ("trend", "momentum", "oscillators", "volume")}})
        dump({
            **header, "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "description": (info.get("longBusinessSummary") or "")[:600],
            "website": info.get("website"), "country": info.get("country"),
            "history": {
                "dates": [d.strftime("%Y-%m-%d") for d in hist.index],
                "open": [rprice(v) for v in hist["open"]], "high": [rprice(v) for v in hist["high"]],
                "low": [rprice(v) for v in hist["low"]], "close": [rprice(v) for v in hist["close"]],
                "volume": [int(v) if math.isfinite(v) else None for v in hist["volume"]],
            },
            "indicators": {
                "sma20": [rprice(v) for v in ind_h["sma20"]], "sma50": [rprice(v) for v in ind_h["sma50"]],
                "sma200": [rprice(v) for v in ind_h["sma200"]],
                "bbUpper": [rprice(v) for v in ind_h["bb_upper"]], "bbLower": [rprice(v) for v in ind_h["bb_lower"]],
                "rsi14": [r4(v) for v in ind_h["rsi14"]],
                "macd": [rprice(v) for v in macd_px],
                "macdSignal": [rprice(v) for v in (macd_px - ind_h["macd_hist"] * hist["close"])],
                "macdHist": [rprice(v) for v in (ind_h["macd_hist"] * hist["close"])],
            },
            "stats": stats,
            "technical": {"score": tscore, "parts": parts, "readings": readings,
                          "raw": {k: r4(row.get(k)) for k in ("rsi14", "rsi2", "bb_pctb", "sma50_gap", "sma200_gap",
                                                              "mom12_1", "vol21", "vol_ratio", "atr_pct", "beta63",
                                                              "rank_mom12_1", "rank_ret21", "rank_vol21")}},
            "fundamentals": {"info": info, "fairValue": fv, "score": fscore, "view12m": view,
                             "peers": {"sector": info.get("sector"), "medians": medians.get(info.get("sector") or "_", {}),
                                       "all": medians.get("_all", {})}},
            "ledger": {"resolved": [e for e in sym_ledger if e.get("resolved")][-400:],
                       "pending": [e for e in sym_ledger if not e.get("resolved")]},
        }, os.path.join(args.out, "tickers", f"{sym}.json"))

    sess = market_session_state(now)
    vix = prices.get(CONTEXT_SYMBOLS["vix"])
    tnx = prices.get(CONTEXT_SYMBOLS["rates"])
    summary = {
        "version": VERSION, "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "asOf": max(t["asOf"] for t in summary_tickers), "session": sess,
        "horizons": HORIZONS, "horizonLabels": {str(h): l for h, l in HORIZON_LABELS.items()},
        "model": {"trainedThrough": final[21]["trained_through"], "nTrain": {str(h): final[h]["n_train"] for h in HORIZONS},
                  "universeSize": len(universe), "trackedSize": len(tracked), "features": len(feature_names),
                  "drift": drift, "backtestGeneratedAt": backtest.get("generatedAt"), "flags": sorted(features.FEATURE_FLAGS),
                  "calibration": {str(h): {"slope": cal[h]["slope"]} for h in HORIZONS if h in cal}},
        "backtest": backtest.get("report", {}),
        "backtestRecent": backtest.get("reportRecent", {}),
        "backtestTracked": backtest.get("reportTracked", {}),
        "recentFrom": backtest.get("recentFrom"),
        "importance": backtest.get("importance", []),
        "ledger": lstats,
        "market": {
            "vix": rprice(vix["close"].iloc[-1]) if vix is not None else None,
            "vixChange5d": r4(vix["close"].iloc[-1] / vix["close"].iloc[-6] - 1) if vix is not None and len(vix) > 6 else None,
            "tnx": rprice(tnx["close"].iloc[-1]) if tnx is not None else None,
            "breadthAbove200": breadth_above200 / max(len(tracked), 1),
            "breadthUp1m": breadth_up / max(len(tracked), 1),
            "sp500Ret1m": r4(market["close"].iloc[-1] / market["close"].iloc[-22] - 1) if len(market) > 22 else None,
            "sp500Ytd": r4(market["close"].iloc[-1] / market[market.index.year == market.index[-1].year]["close"].iloc[0] - 1),
        },
        "tickers": summary_tickers,
    }
    dump(summary, os.path.join(args.out, "summary.json"))
    dump(backtest, os.path.join(args.out, "backtest.json"))
    with gzip.open(os.path.join(args.out, "ledger.json.gz"), "wt", encoding="utf-8") as fh:
        json.dump(clean({"entries": ledger}), fh, separators=(",", ":"))
    log.info("wrote %d tickers to %s in %.0fs", len(summary_tickers), args.out, time.time() - t_start)


def _group_stance(readings, group):
    votes = [r["stance"] for r in readings if r["group"] == group]
    if not votes:
        return None
    score = sum(1 if v == "bullish" else -1 if v == "bearish" else 0 for v in votes)
    return "bullish" if score > 0 else "bearish" if score < 0 else "neutral"


if __name__ == "__main__":
    main()
