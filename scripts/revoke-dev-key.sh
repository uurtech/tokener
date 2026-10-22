#!/usr/bin/env bash
# Disable every token of a developer (soft revoke; history is kept).
# Usage: ./revoke-dev-key.sh <KEYS_TABLE> <developer-id>
set -euo pipefail
TABLE="${1:?keys table name}"; DEV="${2:?developer id}"
HASHES=$(aws dynamodb scan --table-name "$TABLE" \
  --filter-expression "developerId = :d" --expression-attribute-values "{\":d\":{\"S\":\"$DEV\"}}" \
  --projection-expression "keyHash" --query "Items[].keyHash.S" --output text)
[ -z "$HASHES" ] && { echo "no keys for $DEV"; exit 1; }
for H in $HASHES; do
  aws dynamodb update-item --table-name "$TABLE" --key "{\"keyHash\":{\"S\":\"$H\"}}" \
    --update-expression "SET enabled = :f, revokedAt = :t" \
    --expression-attribute-values "{\":f\":{\"BOOL\":false},\":t\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" >/dev/null
  echo "revoked ${H:0:12}..."
done
echo "Gateway caches keys for 60s; access ends within a minute."
