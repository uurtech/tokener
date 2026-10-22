#!/usr/bin/env bash
# Usage: ./list-dev-keys.sh <KEYS_TABLE>
set -euo pipefail
aws dynamodb scan --table-name "${1:?keys table name}" \
  --projection-expression "developerId, team, dailyBudgetUsd, dailyTokenLimit, enabled, createdAt" \
  --query "sort_by(Items, &developerId.S)[].[developerId.S, team.S, dailyBudgetUsd.N, dailyTokenLimit.N, to_string(enabled.BOOL), createdAt.S]" \
  --output table
