#!/usr/bin/env bash
# Create a gateway token for one developer.
# Usage: ./create-dev-key.sh <KEYS_TABLE> <developer-id> [daily-budget-usd] [team] [daily-token-limit]
# 0 for a limit means "no cap". Token limit counts input + cache read + cache write + output per UTC day.
# The token is printed ONCE; only its sha256 is stored.
set -euo pipefail
TABLE="${1:?keys table name}"; DEV="${2:?developer id}"; BUDGET="${3:-25}"; TEAM="${4:-default}"; TOKENS="${5:-0}"
TOKEN="cgw_$(openssl rand -hex 24)"
HASH="$(printf %s "$TOKEN" | openssl dgst -sha256 | awk '{print $NF}')"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
aws dynamodb put-item --table-name "$TABLE" \
  --condition-expression "attribute_not_exists(keyHash)" \
  --item "{
    \"keyHash\":        {\"S\": \"$HASH\"},
    \"developerId\":    {\"S\": \"$DEV\"},
    \"team\":           {\"S\": \"$TEAM\"},
    \"dailyBudgetUsd\": {\"N\": \"$BUDGET\"},
    \"dailyTokenLimit\": {\"N\": \"$TOKENS\"},
    \"enabled\":        {\"BOOL\": true},
    \"createdAt\":      {\"S\": \"$NOW\"}
  }" >/dev/null
cat <<MSG

Developer : $DEV   (team: $TEAM, daily budget: \$$BUDGET, daily token limit: $TOKENS)
Token     : $TOKEN

Send the developer this settings snippet (~/.claude/settings.json):
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<GATEWAY_URL>",
    "ANTHROPIC_AUTH_TOKEN": "$TOKEN",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"
  }
}
MSG
