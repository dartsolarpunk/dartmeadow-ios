#!/usr/bin/env python3
"""Point the bundled game at its on-device copies of CDN files.

Runs after every sync (scripts/sync-web.sh). Only URL prefixes are swapped;
game logic is untouched. Each rewrite is listed in Web/IOS_PATCHES.json with
the number of hits, so a future upstream change that drops or moves one of
these URLs shows up as a 0 in that file (and a warning here).
"""
import json, os, sys

WEB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'Web')

REWRITES = [
    # three.js r185 import map (WebGPU + TSL builds and the addons folder)
    ('https://cdn.jsdelivr.net/npm/three@0.185.0/', './vendor/three-0.185.0/'),
    # Firebase modules (legacy Google/Apple web sign-in, kept for parity)
    ('https://www.gstatic.com/firebasejs/12.15.0/', './vendor/firebasejs/12.15.0/'),
    # UI fonts
    ('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700;900&family=Rajdhani:wght@300;400;500;600;700&family=Share+Tech+Mono&display=swap',
     './vendor/fonts/google-fonts.css'),
    # Earth coastlines: on-device first; the allorigins fallback entry stays as-is
    ("'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_coastline.geojson',",
     "'./vendor/natural-earth/ne_110m_coastline.geojson',"),
    # ?debug console
    ('https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js', './vendor/eruda/eruda.min.js'),
]
# Files to patch (relative to Web/)
TARGETS = ['index.html']

report = {}
for rel in TARGETS:
    p = os.path.join(WEB, rel)
    s = open(p, encoding='utf-8').read()
    for old, new in REWRITES:
        n = s.count(old)
        report.setdefault(old, 0)
        report[old] += n
        s = s.replace(old, new)
    open(p, 'w', encoding='utf-8').write(s)

json.dump({'targets': TARGETS, 'rewrites': [{'from': o, 'to': n, 'hits': report[o]} for o, n in REWRITES]},
          open(os.path.join(WEB, 'IOS_PATCHES.json'), 'w'), indent=1)
missing = [o for o, _ in REWRITES if report[o] == 0]
for o in missing:
    print('WARNING: patch target not found upstream (CDN URL changed?):', o[:90])
print('patched:', {o[:60]: n for o, n in report.items()})
