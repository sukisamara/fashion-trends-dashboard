"""
Fetches Google Trends data for the fashion brand list and writes a single
JSON file the dashboard reads.

Cross-brand comparability:
  pytrends normalises search interest within each request batch (0-100 across
  the brands in that batch). To make all 100 brands comparable in magnitude,
  we include a fixed BENCHMARK brand in every batch and rescale everyone
  relative to that benchmark's level.

Two metrics per brand:
  1. interest_over_time (12 months, weekly, worldwide)
  2. rising_queries (top 5 breakout related queries)
"""

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from pytrends.request import TrendReq

# ---------- config ----------
BENCHMARK = "Nike"             # used in every batch as reference
TIMEFRAME = "today 12-m"       # last 12 months
GEO = ""                       # empty string = worldwide
BATCH_SIZE = 4                 # 4 brands + 1 benchmark = 5 keywords (pytrends max)
BATCH_DELAY = 8                # seconds between successful batches
RETRY_DELAYS = [30, 60, 120]   # backoff schedule for 429s
# ----------------------------


def flatten_brands(brand_doc: dict) -> list[str]:
    """Pull every brand from the categories map into a single flat list."""
    out: list[str] = []
    for brands in brand_doc["categories"].values():
        out.extend(brands)
    # Deduplicate while preserving order
    seen, deduped = set(), []
    for b in out:
        if b not in seen:
            seen.add(b)
            deduped.append(b)
    return deduped


def chunk(seq, size):
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def fetch_with_retry(pytrends, kw_list, fn_name: str):
    """Run a build_payload + chosen call, retrying on 429-style errors."""
    last_err = None
    for delay in [0, *RETRY_DELAYS]:
        if delay:
            print(f"    backing off {delay}s...")
            time.sleep(delay)
        try:
            pytrends.build_payload(kw_list, timeframe=TIMEFRAME, geo=GEO)
            if fn_name == "interest_over_time":
                return pytrends.interest_over_time()
            elif fn_name == "related_queries":
                return pytrends.related_queries()
        except Exception as e:  # pytrends throws generic exceptions on 429
            last_err = e
            msg = str(e).lower()
            if "429" in msg or "too many" in msg or "rate" in msg:
                continue
            # Non-rate-limit error: don't keep hammering
            print(f"    error: {e}")
            return None
    print(f"    giving up after retries: {last_err}")
    return None


def fetch_interest_over_time(pytrends, brands: list[str]) -> dict:
    """
    Fetch IoT for every brand. Each batch contains BENCHMARK + up to 4 others.
    We rescale each brand relative to the benchmark's median in that batch
    so values are comparable across batches.

    Output: { brand: [ {date, value}, ... ] }
    """
    others = [b for b in brands if b != BENCHMARK]
    result: dict[str, list] = {}

    # First, run a dedicated query for the benchmark itself so we have its
    # raw 0-100 series unaffected by other brands.
    print(f"Fetching benchmark interest: {BENCHMARK}")
    df_bench = fetch_with_retry(pytrends, [BENCHMARK], "interest_over_time")
    if df_bench is None or df_bench.empty:
        raise RuntimeError("Failed to fetch benchmark series; aborting.")
    if "isPartial" in df_bench.columns:
        df_bench = df_bench.drop(columns=["isPartial"])
    bench_series = df_bench[BENCHMARK]
    result[BENCHMARK] = [
        {"date": d.strftime("%Y-%m-%d"), "value": int(v)}
        for d, v in bench_series.items()
    ]
    time.sleep(BATCH_DELAY)

    for i, batch in enumerate(chunk(others, BATCH_SIZE), start=1):
        kw_list = [BENCHMARK, *batch]
        print(f"[{i}] interest batch: {kw_list}")
        df = fetch_with_retry(pytrends, kw_list, "interest_over_time")
        time.sleep(BATCH_DELAY)
        if df is None or df.empty:
            for b in batch:
                result[b] = []
            continue
        if "isPartial" in df.columns:
            df = df.drop(columns=["isPartial"])

        # Compute the scale factor: how this batch's benchmark compares to
        # the dedicated benchmark fetch. If the benchmark in this batch has
        # median X and the dedicated fetch has median Y, multiply others by Y/X.
        try:
            x = df[BENCHMARK].replace(0, pd.NA).median()
            y = bench_series.replace(0, pd.NA).median()
            scale = float(y) / float(x) if x and not pd.isna(x) and x > 0 else 1.0
        except Exception:
            scale = 1.0

        for b in batch:
            if b not in df.columns:
                result[b] = []
                continue
            scaled = (df[b] * scale).clip(lower=0)
            result[b] = [
                {"date": d.strftime("%Y-%m-%d"), "value": int(round(v))}
                for d, v in scaled.items()
            ]

    return result


def fetch_rising_queries(pytrends, brands: list[str]) -> dict:
    """Fetch top 5 rising queries per brand (one request per brand)."""
    out: dict[str, list] = {}
    for i, brand in enumerate(brands, start=1):
        print(f"[{i}/{len(brands)}] rising queries: {brand}")
        related = fetch_with_retry(pytrends, [brand], "related_queries")
        time.sleep(BATCH_DELAY)
        if not related:
            out[brand] = []
            continue
        entry = related.get(brand, {}) or {}
        rising_df = entry.get("rising")
        if rising_df is None or rising_df.empty:
            out[brand] = []
            continue
        out[brand] = [
            {"query": str(row["query"]), "value": int(row["value"])}
            for _, row in rising_df.head(5).iterrows()
        ]
    return out


def summary_metric(series: list[dict]) -> dict:
    """Compute simple summary stats the dashboard uses for sorting/display."""
    if not series:
        return {"latest": 0, "avg": 0, "change_pct": 0}
    values = [p["value"] for p in series]
    latest = values[-1]
    avg = sum(values) / len(values)
    # Trend: last 4 weeks vs previous 4 weeks
    if len(values) >= 8:
        recent = sum(values[-4:]) / 4
        prior = sum(values[-8:-4]) / 4
        change_pct = ((recent - prior) / prior * 100) if prior > 0 else 0
    else:
        change_pct = 0
    return {
        "latest": int(latest),
        "avg": round(avg, 1),
        "change_pct": round(change_pct, 1),
    }


def main():
    repo_root = Path(__file__).resolve().parent.parent
    brands_path = repo_root / "brands.json"
    out_path = repo_root / "docs" / "data" / "trends.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    brand_doc = json.loads(brands_path.read_text())
    brands = flatten_brands(brand_doc)
    print(f"Loaded {len(brands)} brands.")

    pytrends = TrendReq(hl="en-US", tz=0, retries=2, backoff_factor=0.5)

    iot = fetch_interest_over_time(pytrends, brands)
    rising = fetch_rising_queries(pytrends, brands)

    # Build per-brand records with category mapping for the dashboard
    brand_to_category = {}
    for cat, blist in brand_doc["categories"].items():
        for b in blist:
            brand_to_category[b] = cat

    brand_records = []
    for b in brands:
        series = iot.get(b, [])
        brand_records.append({
            "name": b,
            "category": brand_to_category.get(b, "Other"),
            "series": series,
            "summary": summary_metric(series),
            "rising_queries": rising.get(b, []),
        })

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "geo": "worldwide",
        "timeframe": TIMEFRAME,
        "benchmark": BENCHMARK,
        "brands": brand_records,
    }
    out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))
    print(f"Wrote {out_path} ({out_path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
