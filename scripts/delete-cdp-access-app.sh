#!/bin/bash
# Delete the OpenClaw-CDP Access application so moltbot-cdp is no longer behind Access.
# Requires: CLOUDFLARE_API_TOKEN with Zero Trust permissions
# Run: CLOUDFLARE_API_TOKEN=xxx ./scripts/delete-cdp-access-app.sh

set -e

: "${CLOUDFLARE_ACCOUNT_ID:=e94f8d1967cde96eaaa449480e79e3d1}"
: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"

# List applications to find OpenClaw-CDP
echo "Listing Access applications..."
APPS=$(curl -s "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json")

if ! echo "$APPS" | jq -e '.success == true' >/dev/null 2>&1; then
  echo "API error (check CLOUDFLARE_API_TOKEN and Zero Trust permissions):"
  echo "$APPS" | jq -r 'if .errors then (.errors[] | "  - \(.message // .) (code: \(.code // "n/a"))") else . end' 2>/dev/null
  echo ""
  echo "Token tips: use full token (40 chars), ensure it has 'Account - Access: Apps and Policies - Edit'"
  exit 1
fi

echo "$APPS" | jq '.result // [] | .[] | {id, name, domain}' 2>/dev/null || true

# Match by app name or domain containing moltbot-cdp
APP_ID=$(echo "$APPS" | jq -r '(.result // [])[] | select((.name | test("CDP"; "i")) or ((.domain // "") | tostring | test("moltbot-cdp"))) | .id' 2>/dev/null | head -1)
if [[ -z "$APP_ID" || "$APP_ID" == "null" ]]; then
  echo "No Access app found for moltbot-cdp/OpenClaw-CDP. moltbot-cdp is already not behind Access."
  echo "All apps:"
  echo "$APPS" | jq -r '(.result // [])[] | "  \(.name): \(.domain // .host // "n/a") (id: \(.id))"' 2>/dev/null || echo "  (none)"
  exit 0
fi

echo "Deleting Access application (ID: $APP_ID)..."
curl -s -X DELETE \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${APP_ID}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" | jq .

echo ""
echo "Done. Test with: curl -i https://moltbot-cdp.alex-94f.workers.dev/health"
