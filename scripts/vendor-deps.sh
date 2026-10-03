#!/usr/bin/env bash
# Download the game's CDN dependencies into Web/vendor/ so the app runs with
# no network: three.js r185 (WebGPU + TSL builds and the addons the game
# imports), the Google Fonts the UI
# uses, and the Natural Earth coastline the Earth globe draws.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
V="$ROOT/Web/vendor"
THREE=0.185.0; FB=12.15.0
mkdir -p "$V"

# three.js — from the npm tarball (byte-identical to cdn.jsdelivr.net/npm/three@$THREE)
if [ ! -f "$V/three-$THREE/build/three.webgpu.js" ]; then
  T="$(mktemp -d)"
  curl -fsSL "https://registry.npmjs.org/three/-/three-$THREE.tgz" | tar xz -C "$T"
  mkdir -p "$V/three-$THREE/build" "$V/three-$THREE/examples/jsm"
  cp "$T/package/build/three.core.js" "$T/package/build/three.webgpu.js" "$T/package/build/three.tsl.js" "$V/three-$THREE/build/"
  cp "$T/package/LICENSE" "$V/three-$THREE/"
  # addons the game imports, plus everything they import in turn
  python3 - "$T/package/examples/jsm" "$V/three-$THREE/examples/jsm" loaders/GLTFLoader.js utils/SkeletonUtils.js <<'PY'
import os, re, shutil, sys
src, dst, *todo = sys.argv[1:]
seen = set()
while todo:
    rel = os.path.normpath(todo.pop())
    if rel in seen: continue
    seen.add(rel)
    os.makedirs(os.path.dirname(os.path.join(dst, rel)), exist_ok=True)
    shutil.copy(os.path.join(src, rel), os.path.join(dst, rel))
    code = open(os.path.join(src, rel), encoding='utf-8').read()
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.S)  # skip examples in doc comments
    for m in re.finditer(r'''(?:from|import)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]''', code):
        todo.append(os.path.normpath(os.path.join(os.path.dirname(rel), m.group(1))))
print('three addons vendored:', sorted(seen))
PY
  rm -rf "$T"
fi

# (Firebase removed: the web dropped its legacy Google/Apple web sign-in in dartmeadow-space #121)
rm -rf "$V/firebasejs"

# Google Fonts (Orbitron, Rajdhani, Share Tech Mono) — woff2 files + rewritten CSS
mkdir -p "$V/fonts"
if [ ! -f "$V/fonts/google-fonts.css" ]; then
  UA="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
  curl -fsSL -A "$UA" "https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700;900&family=Rajdhani:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap" -o "$V/fonts/google-fonts.css.src"
  python3 - "$V/fonts" <<'PY'
import hashlib, os, re, sys, urllib.request
d = sys.argv[1]
css = open(os.path.join(d, 'google-fonts.css.src')).read()
def fetch(m):
    url = m.group(1)
    name = hashlib.sha1(url.encode()).hexdigest()[:12] + os.path.splitext(url)[1]
    p = os.path.join(d, name)
    if not os.path.exists(p):
        urllib.request.urlretrieve(url, p)
    return 'url(' + name + ')'
css = re.sub(r'url\((https://fonts\.gstatic\.com/[^)]+)\)', fetch, css)
open(os.path.join(d, 'google-fonts.css'), 'w').write(css)
os.remove(os.path.join(d, 'google-fonts.css.src'))
PY
fi

# Natural Earth 1:110m coastline (public domain) for the Earth globe
mkdir -p "$V/natural-earth"
[ -f "$V/natural-earth/ne_110m_coastline.geojson" ] || curl -fsSL \
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson \
  -o "$V/natural-earth/ne_110m_coastline.geojson"

# eruda (the ?debug on-device console)
mkdir -p "$V/eruda"
[ -f "$V/eruda/eruda.min.js" ] || curl -fsSL https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js -o "$V/eruda/eruda.min.js"
echo "→ vendor deps ready: $(du -sh "$V" | cut -f1)"
