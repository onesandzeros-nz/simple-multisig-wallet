#!/usr/bin/env bash
# Regenerates every PNG in assets/ from assets/logo/mark.svg with ImageMagick.
# Sizes follow the logo sheet: the mark sits on a dark 135° gradient
# (#444D5E → #282828) at ~56% of the icon width; the Android foreground keeps
# the mark inside the 66% adaptive-icon safe zone.
set -euo pipefail
cd "$(dirname "$0")/.."
SVG=assets/logo/mark.svg
GRADIENT='gradient:#444D5E-#282828'

# mark WIDTH OUT [FILL_OUTER FILL_MID] — render the mark at WIDTH px wide.
mark() {
  local w=$1 out=$2 outer=${3:-#ffffff} mid=${4:-#FF6D00}
  sed -e "s/#ffffff/$outer/g" -e "s/#FF6D00/$mid/g" "$SVG" > /tmp/mark-tmp.svg
  convert -background none -density 384 /tmp/mark-tmp.svg -resize "${w}x" "$out"
}

# gradient SIZE OUT — 135° dark gradient square.
gradient() {
  convert -size "$1x$1" -define gradient:angle=135 "$GRADIENT" -depth 8 "$2"
}

# compose BG MARK OUT — mark centred on BG.
compose() {
  convert "$1" "$2" -gravity center -composite -depth 8 "$3"
}

T=$(mktemp -d)

# App icon (iOS and fallback): 1024, no transparency.
gradient 1024 "$T/bg1024.png"; mark 574 "$T/m1024.png"
compose "$T/bg1024.png" "$T/m1024.png" assets/icon.png
convert assets/icon.png -alpha off assets/icon.png

# Android adaptive icon layers (512): background gradient, foreground mark
# within the safe zone, monochrome all-white mark.
gradient 512 assets/android-icon-background.png
mark 226 "$T/mfg.png"
convert -size 512x512 xc:none "$T/mfg.png" -gravity center -composite assets/android-icon-foreground.png
mark 190 "$T/mmono.png" '#ffffff' '#ffffff'
convert -size 432x432 xc:none "$T/mmono.png" -gravity center -composite assets/android-icon-monochrome.png

# Splash: transparent mark, shown on the brand dark background (see app.config.ts).
mark 1024 "$T/msplash.png"
convert -size 1024x1024 xc:none "$T/msplash.png" -gravity center -composite assets/splash-icon.png

# Web favicon: the plain (untoothed) variant — the teeth fill in below ~20px.
cat > "$T/plain.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 180">
  <rect x="15" y="6" width="130" height="44" fill="#ffffff"/>
  <rect x="55" y="68" width="130" height="44" fill="#FF6D00"/>
  <rect x="15" y="130" width="130" height="44" fill="#ffffff"/>
</svg>
SVG
gradient 48 "$T/bg48.png"
convert -background none -density 384 "$T/plain.svg" -resize 30x "$T/m48.png"
compose "$T/bg48.png" "$T/m48.png" assets/favicon.png

rm -rf "$T"
echo "done"
