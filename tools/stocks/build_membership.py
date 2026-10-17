#!/usr/bin/env python3
"""Write tools/stocks/data/membership.csv: the date each tracked or training
symbol joined the S&P 500, from Wikipedia's constituents table.

A stock's rows before it joined the index are excluded from the model's
cross-section, so that today's survivors don't teach the model "what later
winners looked like" before anyone could have picked them (survivorship
bias). Run by hand now and then; the CSV is committed.

    pip install lxml   # once
    python tools/stocks/build_membership.py
"""
from __future__ import annotations

import os
import sys

import pandas as pd
import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from universe import TRAINING_ONLY  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "membership.csv")


def main(source: str = URL):
    tables = pd.read_html(source)
    table = tables[0]
    table.columns = [str(c).strip() for c in table.columns]
    sym_col = next(c for c in table.columns if c.lower().startswith("symbol"))
    date_col = next(c for c in table.columns if "added" in c.lower())
    with open(os.path.join(ROOT, "_data", "stocks.yml"), encoding="utf-8") as fh:
        tracked = [str(e["symbol"]).upper() for e in yaml.safe_load(fh)]
    wanted = set(tracked) | set(TRAINING_ONLY)
    rows = []
    for sym, added in zip(table[sym_col], table[date_col]):
        sym = str(sym).strip().upper().replace(".", "-")
        if sym not in wanted:
            continue
        date = pd.to_datetime(str(added)[:10], errors="coerce")
        if pd.isna(date):
            continue
        rows.append({"symbol": sym, "from_date": date.strftime("%Y-%m-%d")})
    out = pd.DataFrame(rows).sort_values("symbol")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.to_csv(OUT, index=False)
    print(f"{len(out)} symbols with an entry date written to {OUT}; "
          f"{len([s for s in wanted if s not in set(out.symbol)])} universe symbols are not S&P 500 members")
    late = out[out.from_date >= "2011-01-01"]
    print(f"{len(late)} joined after 2010:", ", ".join(f"{r.symbol} {r.from_date}" for r in late.itertuples()))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else URL)
