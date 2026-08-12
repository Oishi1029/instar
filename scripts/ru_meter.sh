#!/usr/bin/env bash
# Read the cluster's cumulative Request Unit consumption.
#
# There is no SQL meter on a Basic cluster: crdb_internal.tenant_usage_details
# exists but returns ZERO rows (verified 2026-08-12), and reading it at all
# requires `SET allow_unsafe_internals = true`. The usable source is the
# billing invoice, which reports RU as a line item.
#
# Usage:  scripts/ru_meter.sh          -> prints total RU consumed
#         scripts/ru_meter.sh --json   -> full line item
set -euo pipefail

RAW="$(ccloud billing invoice list -o json 2>/dev/null \
       | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -v Retrieving)"

python3 - "$RAW" "${1:-}" <<'PY'
import json, sys
raw, mode = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""
dec = json.JSONDecoder()
i, total, items = raw.find('{'), 0, []
# the CLI emits several concatenated JSON objects, one invoice each
while i >= 0 and i < len(raw):
    try:
        obj, end = dec.raw_decode(raw[i:])
    except ValueError:
        break
    for inv_item in obj.get('invoice_items', []):
        for li in inv_item.get('line_items', []):
            if li.get('quantity_unit') == 'REQUEST_UNITS':
                total += int(li.get('quantity', 0))
                items.append(li)
    nxt = raw.find('{', i + end)
    i = nxt
if mode == '--json':
    print(json.dumps(items, indent=1))
else:
    print(total)
PY
