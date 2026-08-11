#!/usr/bin/env bash
# Copy the Backblaze B2 credential files into dist/.secrets so the published
# build artifact carries them.
#
# Why: the hosted live deployment (…ctonew.app, a CloudFront snapshot of dist/)
# cannot read the machine-local sibling dir (<site-parent>/.secrets) that
# b2-client.ts prefers. The build embeds the three files at dist/.secrets and
# b2-client.ts falls back to <site-root>/dist/.secrets at runtime.
#
# Runs AFTER vite build (package.json "build" = "vite build && bash …"), so a
# build that empties dist/ can never wipe the freshly copied creds.
#
# Non-fatal when the source files are absent: the runtime loadB2Config error
# ("Backblaze B2 is not configured") remains the honest signal, and a publish
# must never fail just because credentials are missing. Nothing here ever
# touches git — dist/ (and any .secrets dir) is gitignored.
set -u
SITE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$(dirname "$SITE_ROOT")/.secrets"
DEST_DIR="$SITE_ROOT/dist/.secrets"

mkdir -p "$DEST_DIR" || { echo "prepare-b2-secrets: cannot create $DEST_DIR — build continues without embedded B2 creds" >&2; exit 0; }

copied=0
for name in b2-key-id b2-application-key b2-bucket-name; do
  if [ -f "$SRC_DIR/$name" ]; then
    if cp "$SRC_DIR/$name" "$DEST_DIR/$name" 2>/dev/null; then
      copied=$((copied + 1))
    else
      echo "prepare-b2-secrets: could not copy $SRC_DIR/$name — build continues without embedded B2 creds" >&2
    fi
  else
    echo "prepare-b2-secrets: $SRC_DIR/$name missing — skipped (B2 will fail at runtime until configured)" >&2
  fi
done
echo "prepare-b2-secrets: copied $copied/3 B2 credential files into dist/.secrets" >&2
exit 0
