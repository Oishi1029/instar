#!/usr/bin/env python3
"""Measure the REAL Request-Unit cost of a vector-indexed insert.

Why this exists: CockroachDB documents ~10-25 RU for a typical INSERT, but that
band is for an ORDINARY insert. A vector insert additionally performs a
partition search and can trigger partition splits that rewrite existing entries.
Bulk-loading into a fresh C-SPANN index triggers splits repeatedly. Sizing the
whole ingest off "25" is guesswork; this measures it.

Method: read the billing meter, insert N rows row-at-a-time (CockroachDB's docs
say explicitly NOT to batch vector inserts), read the meter again, divide.

Random unit vectors are used deliberately -- the RU cost lives in the database
write, not in the embedding, so this needs no Bedrock spend to calibrate.

Usage:  python3 scripts/calibrate_ru.py [--rows 500] [--cleanup]
"""
import argparse, math, os, random, subprocess, sys, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
DBURL = open(os.path.expanduser("~/.instar/dburl_instar")).read().strip()
SLOT_PREFIX = "calib:"


def ru() -> int:
    out = subprocess.run([os.path.join(HERE, "ru_meter.sh")],
                         capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def sql(stmt: str, fmt: str = "csv") -> str:
    r = subprocess.run(["cockroach-sql", "--url", DBURL, f"--format={fmt}", "-e", stmt],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:400])
    return r.stdout


def unit_vec(dims: int = 256) -> str:
    v = [random.gauss(0, 1) for _ in range(dims)]
    n = math.sqrt(sum(x * x for x in v))
    return "[" + ",".join(f"{x/n:.6f}" for x in v) + "]"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=500)
    ap.add_argument("--cleanup", action="store_true",
                    help="delete calibration rows and measure the delete cost too")
    args = ap.parse_args()

    tid = sql("SELECT tenant_id FROM tenant WHERE slug='demo';").strip().splitlines()[-1]
    print(f"tenant   : {tid}")
    print(f"rows     : {args.rows}")

    before = ru()
    print(f"RU before: {before:,}")
    t0 = time.time()

    # Row at a time, exactly as the docs require for vector inserts.
    # One statement per row keeps the measurement honest -- a multi-VALUES
    # insert would amortise costs the real ingest will not get.
    for i in range(args.rows):
        h = f"calib-{uuid.uuid4()}"
        sql(
            "INSERT INTO lesson (tenant_id,slot,polarity,body,trigger_text,"
            "embedding,status,content_hash,is_synthetic) VALUES "
            f"('{tid}','{SLOT_PREFIX}{i}',1,'calibration row {i}',"
            f"'calibration trigger {i}','{unit_vec()}','candidate','{h}',true);"
        )
        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{args.rows}  ({time.time()-t0:.0f}s)")

    elapsed = time.time() - t0
    print(f"inserted in {elapsed:.0f}s ({args.rows/elapsed:.1f} rows/s)")

    # The invoice meter is not real-time. Poll until it moves, then settle.
    print("waiting for the billing meter to catch up...")
    after = before
    for attempt in range(30):
        time.sleep(20)
        after = ru()
        print(f"  t+{(attempt+1)*20:>4}s  RU={after:,}  (delta {after-before:,})")
        if after > before and attempt >= 2:
            break

    delta = after - before
    if delta <= 0:
        print("\nMETER DID NOT MOVE. Billing lag is longer than this window.")
        print("Re-run scripts/ru_meter.sh later and divide by hand.")
        return 2

    per_row = delta / args.rows
    print("\n" + "=" * 58)
    print(f"  RU delta        : {delta:,}")
    print(f"  RU PER ROW      : {per_row:.1f}")
    print(f"  vs docs' 10-25  : {per_row/25:.1f}x the top of the ordinary-insert band")
    print("=" * 58)

    for label, n in [("2,164 (full real corpus)", 2164), ("one re-run", 2164),
                     ("20 build-week re-runs", 2164 * 20)]:
        cost = n * per_row
        print(f"  {label:<26} {cost:>12,.0f} RU  = {cost/50_000_000*100:5.2f}% of cap")

    if args.cleanup:
        print("\ncleaning up...")
        sql(f"DELETE FROM lesson WHERE slot LIKE '{SLOT_PREFIX}%';")
        print("calibration rows deleted")
    else:
        print(f"\nrows left in place; remove with:"
              f"\n  DELETE FROM lesson WHERE slot LIKE '{SLOT_PREFIX}%';")
    return 0


if __name__ == "__main__":
    sys.exit(main())
