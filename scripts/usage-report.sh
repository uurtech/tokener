#!/usr/bin/env bash
# Per-developer usage for one day (default: today, UTC).
# Usage: ./usage-report.sh <USAGE_TABLE> [YYYY-MM-DD]
set -euo pipefail
TABLE="${1:?usage table name}"; DAY="${2:-$(date -u +%Y-%m-%d)}"
aws dynamodb scan --table-name "$TABLE" \
  --filter-expression "sk = :sk AND begins_with(pk, :p)" \
  --expression-attribute-values "{\":sk\":{\"S\":\"DAY#$DAY\"},\":p\":{\"S\":\"DEV#\"}}" \
  --output json | python3 -c '
import json,sys
rows=[]
for it in json.load(sys.stdin)["Items"]:
    g=lambda k: int(it.get(k,{}).get("N","0"))
    inp,cr,cw,out=g("inputTokens"),g("cacheReadTokens"),g("cacheWriteTokens"),g("outputTokens")
    tot=inp+cr+cw
    rows.append((g("costMicros")/1e6,it["pk"]["S"][4:],g("requests"),inp,cr,cw,out,(100*cr/tot) if tot else 0))
rows.sort(reverse=True)
print(f"{\"developer\":<20}{\"cost$\":>9}{\"reqs\":>7}{\"input\":>10}{\"cache_rd\":>11}{\"cache_wr\":>10}{\"output\":>9}{\"hit%\":>7}")
for c,d,r,i,cr,cw,o,h in rows:
    print(f"{d:<20}{c:>9.2f}{r:>7}{i:>10}{cr:>11}{cw:>10}{o:>9}{h:>7.1f}")
print(f"{\"TOTAL\":<20}{sum(r[0] for r in rows):>9.2f}")
'
