#!/usr/bin/env bash
# Builds the App Store creative assets (product page header and search
# results artwork) in store/apple/promo/ with ImageMagick, from the logo mark
# and one screenshot, so they can be regenerated when either changes.
#
# Apple's sizes (App Store Connect > creative assets specifications):
#   universal 16:9  5244×2950 PNG   header.png, search.png (either slot)
#   header   21:9   3840×1646       header-21x9.png
#   search    3:2   3840×2560       search-3x2.png
# No alpha channel. The focal elements sit inside the centre so the 16:9
# files survive Apple cropping them to 21:9 (header) or 3:2 (search).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=store/apple/promo
SVG=assets/logo/mark.svg
SHOT=store/apple/screenshots/iphone-6.9/02-wallet.png
W=5244; H=2950
BOLD=Noto-Sans-Bold; REG=Noto-Sans-Regular
mkdir -p "$OUT"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

# mark WIDTH OUT — the logo mark rendered WIDTH px wide on transparency.
mark() { magick -background none -density 384 "$SVG" -resize "$1x" "$2"; }

# textw FONT POINTSIZE TEXT — rendered width in px.
textw() { magick -font "$1" -pointsize "$2" label:"$3" -format '%w' info:; }

# background OUT GLOWX GLOWY — the icon's 135° gradient plus a soft orange glow.
background() {
  magick -size ${W}x${H} -define gradient:angle=135 'gradient:#444D5E-#282828' \
    \( -size ${W}x${H} -define gradient:center=$2,$3 -define gradient:radii=1500,1500 \
       'radial-gradient:rgba(255,109,0,0.22)-rgba(255,109,0,0)' \) \
    -compose over -composite "$1"
}

# tile SIZE OUT — the app icon look: rounded gradient square with the mark.
tile() {
  local s=$1
  local r=$((s * 22 / 100)) m=$((s * 56 / 100))
  mark "$m" "$T/tile-mark-$s.png"
  magick -size ${s}x${s} -define gradient:angle=135 'gradient:#4C5567-#2A2B2E' -alpha set \
    \( -size ${s}x${s} xc:none -fill white -draw "roundrectangle 0,0 $((s - 1)),$((s - 1)) $r,$r" \) \
    -compose DstIn -composite \
    -fill none -stroke 'rgba(255,255,255,0.16)' -strokewidth 3 \
    -draw "roundrectangle 1,1 $((s - 2)),$((s - 2)) $r,$r" \
    "$T/tile-mark-$s.png" -gravity center -compose over -composite "$2"
}

# Header: the Play feature graphic, scaled up — icon tile, name, tagline.
header() {
  local ts=1000 gap=240 p1=350 p2=140
  local l1='SMS: Simple' l2='MultiSig Wallet'
  local s1='Shared bitcoin custody for a household,'
  local s2='a business or a group. The keys stay yours.'
  local w tw=0
  for t in "$BOLD $p1 $l1" "$BOLD $p1 $l2" "$REG $p2 $s1" "$REG $p2 $s2"; do
    set -- $t; w=$(textw "$1" "$2" "${*:3}"); (( w > tw )) && tw=$w
  done
  local x=$(( (W - (ts + gap + tw)) / 2 )) tx lh1=$((p1 * 112 / 100)) lh2=$((p2 * 140 / 100))
  tx=$(( x + ts + gap ))
  local th=$(( lh1 * 2 + 110 + lh2 * 2 )) ty
  ty=$(( (H - th) / 2 ))
  tile $ts "$T/tile.png"
  background "$T/bg.png" $(( x + ts / 2 )) $(( H / 2 ))
  magick "$T/bg.png" \
    "$T/tile.png" -geometry +${x}+$(( (H - ts) / 2 )) -composite \
    -gravity NorthWest -font $BOLD -pointsize $p1 -fill '#FFFFFF' \
      -annotate +${tx}+${ty} "$l1" -annotate +${tx}+$(( ty + lh1 )) "$l2" \
    -font $REG -pointsize $p2 -fill '#C9CDD4' \
      -annotate +${tx}+$(( ty + lh1 * 2 + 110 )) "$s1" \
      -annotate +${tx}+$(( ty + lh1 * 2 + 110 + lh2 )) "$s2" \
    -alpha off -depth 8 PNG24:"$OUT/header.png"
}

# Search results: purpose stated plainly on the left, the wallet screen on
# the right (Apple: "state the obvious", "showcase the firsthand experience").
search() {
  local p1=310 p2=132 p3=118
  local l1='Shared bitcoin' l2='custody.'
  local s1='A wallet where spending takes' s2='more than one key.'
  local brand='SMS: Simple MultiSig Wallet'
  # Phone: screenshot with rounded corners inside a dark bezel, bleeding off
  # the bottom edge. Right edge stays inside the 3:2 crop (x < 4834).
  local pw=1500 bez=54 r=250 ph fw fh px=3230 py=430
  ph=$(( pw * 2868 / 1320 )); fw=$(( pw + 2 * bez )); fh=$(( ph + 2 * bez ))
  magick -size ${pw}x${ph} xc:none -fill white \
    -draw "roundrectangle 0,0 $((pw - 1)),$((ph - 1)) $((r - bez)),$((r - bez))" "$T/mask.png"
  magick "$SHOT" -resize ${pw}x -alpha set "$T/mask.png" -compose DstIn -composite "$T/shot.png"
  magick -size ${fw}x${fh} xc:none -fill '#15171A' -stroke 'rgba(255,255,255,0.22)' -strokewidth 4 \
    -draw "roundrectangle 2,2 $((fw - 3)),$((fh - 3)) $r,$r" \
    "$T/shot.png" -geometry +${bez}+${bez} -compose over -composite "$T/phone.png"
  local pad=300
  magick -size $((fw + 2 * pad))x$((fh + 2 * pad)) xc:none -fill 'rgba(0,0,0,0.55)' \
    -draw "roundrectangle $pad,$pad $((pad + fw - 1)),$((pad + fh - 1)) $r,$r" -blur 0x70 "$T/shadow.png"
  # Text block, vertically centred.
  local lh1=$((p1 * 112 / 100)) lh2=$((p2 * 140 / 100)) bt=300 x=560 ty
  local th=$(( lh1 * 2 + 100 + lh2 * 2 + 190 + bt ))
  ty=$(( (H - th) / 2 ))
  tile $bt "$T/tile-small.png"
  local by=$(( ty + lh1 * 2 + 100 + lh2 * 2 + 190 ))
  background "$T/bg.png" $(( px + fw / 2 )) $(( py + 900 ))
  magick "$T/bg.png" \
    "$T/shadow.png" -geometry +$((px - pad))+$((py - pad + 60)) -composite \
    "$T/phone.png" -geometry +${px}+${py} -composite \
    "$T/tile-small.png" -geometry +${x}+${by} -composite \
    -gravity NorthWest -font $BOLD -pointsize $p1 -fill '#FFFFFF' \
      -annotate +${x}+${ty} "$l1" -annotate +${x}+$(( ty + lh1 )) "$l2" \
    -font $REG -pointsize $p2 -fill '#C9CDD4' \
      -annotate +${x}+$(( ty + lh1 * 2 + 100 )) "$s1" \
      -annotate +${x}+$(( ty + lh1 * 2 + 100 + lh2 )) "$s2" \
    -font $BOLD -pointsize $p3 -fill '#FFFFFF' \
      -annotate +$(( x + bt + 70 ))+$(( by + (bt - p3 * 136 / 100) / 2 )) "$brand" \
    -alpha off -depth 8 PNG24:"$OUT/search.png"
}

header
search
# Dedicated-ratio variants, cropped from the centre of the universal files.
magick "$OUT/header.png" -gravity center -crop 5244x2247+0+0 +repage -resize '3840x1646!' \
  -alpha off -depth 8 PNG24:"$OUT/header-21x9.png"
magick "$OUT/search.png" -gravity center -crop 4425x2950+0+0 +repage -resize '3840x2560!' \
  -alpha off -depth 8 PNG24:"$OUT/search-3x2.png"
magick identify -format '%f %wx%h %[channels]\n' "$OUT"/*.png
