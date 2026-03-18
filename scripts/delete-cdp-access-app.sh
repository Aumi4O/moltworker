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
echo "$APPS" | jq '.result[] | {id, name, domain}'

# Match by app name or domain containing moltbot-cdp
APP_ID=$(echo "$APPS" | jq -r '.result[]? | select((.name | test("CDP"; "i")) or ((.domain // "") | tostring | test("moltbot-cdp"))) | .id' 2>/dev/null | head -1)
if [[ -z "$APP_ID" || "$APP_ID" == "null" ]]; then
  echo "No Access app found for moltbot-cdp/OpenClaw-CDP. All apps:"
  echo "$APPS" | jq -r '.result[]? | "\(.name): \(.domain // .host // "n/a") (id: \(.id))"'
  exit 1
fi

echo "Deleting Access application (ID: $APP_ID)..."
curl -s -X DELETE \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${APP_ID}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" | jq .

echo ""
echo "Done. Test with: curl -i https://moltbot-cdp.alex-94f.workers.dev/health"
