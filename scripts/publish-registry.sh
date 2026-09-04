#!/usr/bin/env bash
#
# Publishes server.json to the official MCP Registry using DNS-based auth.
#
# Ownership is proven by a TXT record on oliverkiss.com, not by a financial
# account — which is the whole reason this route was chosen over Coinbase's.
#
# Prerequisites:
#   1. ~/.mcp-registry/key.pem exists (see KEY SETUP below)
#   2. This TXT record is live on the APEX of oliverkiss.com:
#        v=MCPv1; k=ed25519; p=<base64 public key>
#
# KEY SETUP (one time):
#   openssl genpkey -algorithm Ed25519 -out ~/.mcp-registry/key.pem
#   openssl pkey -in ~/.mcp-registry/key.pem -pubout -outform DER \
#     | tail -c 32 | base64
#
set -euo pipefail

DOMAIN="${MCP_REGISTRY_DOMAIN:-oliverkiss.com}"
KEY="${MCP_REGISTRY_KEY:-$HOME/.mcp-registry/key.pem}"
REGISTRY="https://registry.modelcontextprotocol.io"
MANIFEST="$(dirname "$0")/../server.json"

# macOS ships LibreSSL, which cannot sign raw Ed25519 messages (-rawin).
OSSL="$(ls /opt/homebrew/opt/openssl@3/bin/openssl 2>/dev/null || command -v openssl)"
if ! "$OSSL" version | grep -q "^OpenSSL 3"; then
  echo "Need OpenSSL 3 (LibreSSL cannot sign with -rawin). Try: brew install openssl@3" >&2
  exit 1
fi

[ -f "$KEY" ] || { echo "Missing signing key at $KEY — see KEY SETUP in this script." >&2; exit 1; }

echo "==> Validating manifest"
validation="$(curl -sS -X POST "$REGISTRY/v0.1/validate" \
  -H "Content-Type: application/json" --data-binary @"$MANIFEST")"

if ! echo "$validation" | grep -q '"valid":true'; then
  echo "Manifest rejected: $validation" >&2
  exit 1
fi
echo "    ok"

echo "==> Checking the DNS TXT record is visible"
expected_pub="$("$OSSL" pkey -in "$KEY" -pubout -outform DER | tail -c 32 | base64)"
if ! dig +short TXT "$DOMAIN" | grep -qF "$expected_pub"; then
  echo "No TXT record on $DOMAIN matching this key." >&2
  echo "Expected content: v=MCPv1; k=ed25519; p=$expected_pub" >&2
  echo "It must be on the APEX (name '@'), not a subdomain, and DNS may take a few minutes." >&2
  exit 1
fi
echo "    ok"

# The signed message is the raw RFC3339 timestamp, and the registry rejects
# anything more than 15 seconds off its own clock — so sign immediately before
# the exchange rather than earlier in the script.
echo "==> Exchanging a signed timestamp for a registry token"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

printf '%s' "$TS" > "$TMP/ts.txt"
"$OSSL" pkeyutl -sign -inkey "$KEY" -rawin -in "$TMP/ts.txt" -out "$TMP/sig.bin"
SIG="$(xxd -p -c 999 "$TMP/sig.bin")"

auth="$(curl -sS -X POST "$REGISTRY/v0.1/auth/dns" -H "Content-Type: application/json" \
  -d "{\"domain\":\"$DOMAIN\",\"timestamp\":\"$TS\",\"signed_timestamp\":\"$SIG\"}")"

TOKEN="$(echo "$auth" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("registry_token",""))' 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "Auth failed: $auth" >&2
  exit 1
fi
echo "    ok"

echo "==> Publishing"
result="$(curl -sS -w '\n%{http_code}' -X POST "$REGISTRY/v0.1/publish" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @"$MANIFEST")"

status="$(echo "$result" | tail -n1)"
body="$(echo "$result" | sed '$d')"

if [ "$status" != "200" ] && [ "$status" != "201" ]; then
  echo "Publish failed (HTTP $status): $body" >&2
  exit 1
fi

name="$(python3 -c 'import json;print(json.load(open("'"$MANIFEST"'"))["name"])')"
echo "    published as $name"
echo
echo "Verify: curl -s '$REGISTRY/v0.1/servers?search=agentic-endpoints' | python3 -m json.tool"
