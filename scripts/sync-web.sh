#!/usr/bin/env bash
# Pull a dartmeadow-space release into Web/ (the game bundled inside the app).
#
#   scripts/sync-web.sh            # latest main
#   scripts/sync-web.sh 08cd439    # a specific commit / tag / branch
#
# Steps: shallow-fetch that ref, copy every runtime file into Web/ (minus the
# patterns in scripts/web-exclude.txt), re-apply the iOS patches
# (scripts/patch-web.py: CDN → on-device vendor copies), refresh the vendored
# CDN dependencies (scripts/vendor-deps.sh), and record the SHA in WEB_VERSION.
set -euo pipefail
REF="${1:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_URL="${DM_WEB_REPO:-https://github.com/dartsolarpunk/dartmeadow-space.git}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "→ fetching $REPO_URL @ $REF"
git clone -q --filter=blob:none --no-checkout "$REPO_URL" "$TMP/src"
git -C "$TMP/src" checkout -q "$REF"
SHA="$(git -C "$TMP/src" rev-parse HEAD)"
SUBJECT="$(git -C "$TMP/src" log -1 --format=%s)"
DATE="$(git -C "$TMP/src" log -1 --format=%cI)"
echo "→ $SHA  $SUBJECT"

# Keep our vendored deps across the sync; everything else mirrors upstream.
mkdir -p "$ROOT/Web"
rsync -a --delete \
  --exclude-from="$ROOT/scripts/web-exclude.txt" \
  --exclude='/vendor/' --exclude='/IOS_PATCHES.json' \
  "$TMP/src/" "$ROOT/Web/"

"$ROOT/scripts/vendor-deps.sh"
python3 "$ROOT/scripts/patch-web.py" "$ROOT/Web"

cat > "$ROOT/WEB_VERSION" <<V
sha=$SHA
date=$DATE
subject=$SUBJECT
source=$REPO_URL
V
echo "→ Web/ now mirrors dartmeadow-space @ ${SHA:0:7}"
du -sh "$ROOT/Web"
# GitHub rejects files over 100 MB
find "$ROOT/Web" -type f -size +95M -print | sed 's/^/!! too big for GitHub: /' || true
