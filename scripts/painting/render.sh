#!/bin/sh
# Renders the four homepage background paintings into public/painting/.
# Needs a Chromium-based browser (set CHROME to override) and cwebp.
set -e
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Helium.app/Contents/MacOS/Helium}"
OUT=../../public/painting
TMP="$(mktemp -d)"
mkdir -p "$OUT"
for scene in morning day sunset night; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --user-data-dir="$TMP/profile" --window-size=2560,1600 \
    --screenshot="$TMP/$scene.png" "file://$PWD/paint.html?scene=$scene${SEED:+&seed=$SEED}" >/dev/null 2>&1
  cwebp -quiet -q "${QUALITY:-74}" "$TMP/$scene.png" -o "$OUT/$scene.webp"
  echo "$OUT/$scene.webp"
done
rm -rf "$TMP"
