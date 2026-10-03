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
# iOS only: Apple in-app purchase replaces the Stripe support buttons
# (App Store guideline 3.1.1). The native StoreKit UI is drawn into
# #dm-iap-container by App/Bridge/dm-ios-bridge.js.
import re
BLOCK_PATCHES = [
    ('stripe buy buttons → StoreKit container',
     re.compile(r'<!-- Stripe buy buttons render here -->.*?Payments are processed securely by Stripe\. DART Meadow never sees your card details\.\s*</div>', re.S),
     '<div id="dm-iap-container" style="display:flex;flex-direction:column;align-items:stretch;gap:1rem;min-height:48px;"></div>\n'
     '    <div style="font-family:var(--font-mono);font-size:0.52rem;color:var(--text-dim);margin-top:0.9rem;line-height:1.5;opacity:0.8;">\n'
     '      Purchases are handled by Apple and charged to your Apple Account. The monthly supporter subscription renews automatically until you cancel it in Settings ▸ Apple Account ▸ Subscriptions (at least 24 hours before renewal).\n'
     '    </div>'),
    ('support tiers text',
     re.compile(r'<div>☄ <strong style="color:var\(--cyan\);">\$5 / month</strong> — recurring supporter</div>\s*<div>🌟 <strong style="color:var\(--gold\);">\$20</strong> — one-time donation</div>'),
     '<div>🌟 <strong style="color:var(--gold);">Game Development Support</strong> — one-time donation</div>\n'
     '        <div>☄ <strong style="color:var(--cyan);">Game Development Supporter</strong> — monthly subscription</div>'),
    ('no js.stripe.com load',
     re.compile(r"    s\.src='https://js\.stripe\.com/v3/buy-button\.js';"),
     "    return; /* iOS app: Apple in-app purchase replaces Stripe */"),
    ('credits: Stripe → Apple IAP',
     re.compile(r"\{t:'Stripe',a:'Stripe, Inc\.',l:'Service terms',use:'service',u:\['https://stripe\.com/'\],w:'Support payments\.'\},"),
     "{t:'App Store In-App Purchase',a:'Apple Inc.',l:'Service terms',use:'service',u:['https://www.apple.com/legal/internet-services/itunes/'],w:'Support purchases in the iOS app.'},"),
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
    for label, rx, rep in BLOCK_PATCHES:
        s, n = rx.subn(rep, s)
        report[label] = report.get(label, 0) + n
    open(p, 'w', encoding='utf-8').write(s)

json.dump({'targets': TARGETS, 'rewrites': [{'from': o, 'to': n, 'hits': report[o]} for o, n in REWRITES],
           'blocks': [{'patch': l, 'hits': report[l]} for l, _, _ in BLOCK_PATCHES]},
          open(os.path.join(WEB, 'IOS_PATCHES.json'), 'w'), indent=1)
missing = [o for o, _ in REWRITES if report[o] == 0] + [l for l, _, _ in BLOCK_PATCHES if report[l] == 0]
for o in missing:
    print('WARNING: patch target not found upstream (CDN URL changed?):', o[:90])
print('patched:', {o[:60]: n for o, n in report.items()})
