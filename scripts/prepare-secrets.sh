#!/usr/bin/env bash
# Copy the deployment secrets into dist/.secrets so the published build
# artifact carries them. Consumers:
#   b2-key-id / b2-application-key / b2-bucket-name  → b2-client.ts (photo storage)
#   tomtom.key                                      → ai-dispatcher.ts resolveTomtomKey (ETA routing)
#   push-vapid-public.key / push-vapid-private.key  → push-core.ts (assigned-offer web push)
#   gmail-address / gmail-app-password              → club-mail.ts loadGmailConfig (claims agent + payment-engine scans)
#   square-access-token / square-application-id /
#     square-location-id                            → square-client.ts loadSquareConfig (payment engine + tips)
#   towbook.key                                     → towbook-key.ts loadSessionKey (Towbook session encryption —
#                                                     survives a clean dist wipe, no reconnect needed)
#
# Why: the hosted live deployment (…ctonew.app, a CloudFront snapshot of dist/)
# cannot read the machine-local sibling dir (<site-parent>/.secrets) that
# b2-client.ts, the TomTom key resolver, club-mail.ts, square-client.ts,
# push-core.ts and towbook-key.ts prefer. The build embeds the files at
# dist/.secrets and the runtime falls back to <site-root>/dist/.secrets.
#
# Runs AFTER vite build (package.json "build" = "vite build && bash …"), so a
# build that empties dist/ can never wipe the freshly copied creds.
#
# Non-fatal when the source files are absent: the runtime resolution (B2/Gmail/
# Square "not configured" errors, the ETA router falling back to OSRM static
# with tomtomKeyConfigured=false, web push staying unregistered) remains the
# honest signal, and a publish must never fail just because credentials are
# missing. Nothing here ever touches git — dist/ (and any .secrets dir) is
# gitignored, and secret VALUES are never committed.
set -u
SITE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$(dirname "$SITE_ROOT")/.secrets"
DEST_DIR="$SITE_ROOT/dist/.secrets"

mkdir -p "$DEST_DIR" || { echo "prepare-secrets: cannot create $DEST_DIR — build continues without embedded creds" >&2; exit 0; }

# name -> which runtime consumer needs it (for the log line only)
names=(b2-key-id b2-application-key b2-bucket-name tomtom.key push-vapid-public.key push-vapid-private.key gmail-address gmail-app-password square-access-token square-application-id square-location-id towbook.key)
copied=0
missing=0
for name in "${names[@]}"; do
  if [ -f "$SRC_DIR/$name" ]; then
    if cp "$SRC_DIR/$name" "$DEST_DIR/$name" 2>/dev/null; then
      copied=$((copied + 1))
    else
      echo "prepare-secrets: could not copy $SRC_DIR/$name — build continues without embedded creds" >&2
    fi
  else
    missing=$((missing + 1))
    echo "prepare-secrets: $SRC_DIR/$name missing — skipped (consumer degrades at runtime until configured)" >&2
  fi
done
echo "prepare-secrets: copied $copied/${#names[@]} credential files into dist/.secrets ($missing absent — non-fatal)" >&2
exit 0
