#!/usr/bin/env bash
# Copy the deployment secrets into dist/.secrets so the published build
# artifact carries them: Backblaze B2 credentials (b2-client.ts) + the TomTom
# Routing API key (ai-dispatcher.ts resolveTomtomKey).
#
# Why: the hosted live deployment (…ctonew.app, a CloudFront snapshot of dist/)
# cannot read the machine-local sibling dir (<site-parent>/.secrets) that
# b2-client.ts and the TomTom key resolver prefer. The build embeds the files
# at dist/.secrets and the runtime falls back to <site-root>/dist/.secrets.
#
# Runs AFTER vite build (package.json "build" = "vite build && bash …"), so a
# build that empties dist/ can never wipe the freshly copied creds.
#
# Non-fatal when the source files are absent: the runtime resolution (B2
# "not configured" error, or the ETA router falling back to OSRM static with
# tomtomKeyConfigured=false) remains the honest signal, and a publish must
# never fail just because credentials are missing. Nothing here ever touches
# git — dist/ (and any .secrets dir) is gitignored.
set -u
SITE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$(dirname "$SITE_ROOT")/.secrets"
DEST_DIR="$SITE_ROOT/dist/.secrets"

mkdir -p "$DEST_DIR" || { echo "prepare-secrets: cannot create $DEST_DIR — build continues without embedded creds" >&2; exit 0; }

# name -> which runtime consumer needs it (for the log line only)
copied=0
missing=0
for name in b2-key-id b2-application-key b2-bucket-name tomtom.key; do
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
echo "prepare-secrets: copied $copied/4 credential files into dist/.secrets ($missing absent — non-fatal)" >&2
exit 0
