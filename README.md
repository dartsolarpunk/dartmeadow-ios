# DART Meadow — Journey of the Skyboard (iOS)

Native iOS app for the [Journey of the Skyboard](https://dartmeadow.space) web game
([dartsolarpunk/dartmeadow-space](https://github.com/dartsolarpunk/dartmeadow-space)).
The **whole game ships inside the app** and runs on the device's own GPU — no game
download from a server at launch.

## How it works

| Piece | What it does |
|---|---|
| `Web/` | Exact mirror of a dartmeadow-space release (SHA in `WEB_VERSION`): splash plate, menus, world + game engines, LOD/marching-cubes terrain, galaxy, Earth relief, water, Ariel + boards, HUD/themes, journal, saves, multiplayer, soundtrack. Unused source assets (zips, FBX, Sentinel models, backups) are skipped — see `scripts/web-exclude.txt`. |
| `Web/vendor/` | On-device copies of every CDN dependency: three.js r185 (WebGPU + TSL + GLTFLoader/SkeletonUtils), Firebase 12.15.0, Google Fonts, Natural Earth coastlines, eruda. `scripts/patch-web.py` points `index.html` at them (listed in `Web/IOS_PATCHES.json`). |
| `App/BundleSchemeHandler.swift` | Serves `Web/` at `dartmeadow://localhost/` (same-origin ES modules/fetch, HTTP Range for video/audio). `static/admin/` notes come live from dartmeadow.space with the bundled copy offline; any file not in the bundle falls back to dartmeadow.space. |
| `App/GameViewController.swift` | Full-screen WKWebView: no bounce/zoom, inline autoplaying media, Safari user agent (so the game takes its iOS/Safari paths; WebGPU where iOS has it, WebGL fallback), external links + GitHub sign-in in an in-app Safari sheet, downloads → share sheet, alert/confirm/prompt, auto-recovery if iOS kills the web process. |
| `App/AppleSignInService.swift` + `App/Bridge/dm-ios-bridge.js` | Native **Sign in with Apple** (pattern from Autumn-iOS / Ash Tree IDE), wired into the game's welcome card and account modal next to GitHub sign-in. |

## Updating to a new web release

```sh
scripts/sync-web.sh            # latest dartmeadow-space main
scripts/sync-web.sh <sha>      # a specific release
git commit -am "Web: sync dartmeadow-space <sha>" && git push   # CI builds + TestFlight
```

## CI

Docs: [docs/NETWORK.md](docs/NETWORK.md) (every endpoint the game calls, verified from the app origin).

* **`ios.yml` simulator** (every push) — builds the app and boots the game in the iOS Simulator (screenshots + JS console log as artifacts).
* **`testflight.yml`** — registers the bundle ID `com.dartmeadow.jots` with Sign in with Apple, makes a fresh App Store profile,
  archives, uploads with `altool`, then waits until App Store Connect reports the build installable in TestFlight.
  Signing runs from **DART-Skyboard/ArcLake-iOS** (workflow "Build DART Meadow (dartmeadow-ios) for TestFlight"), which calls `testflight.yml` here and passes in its App Store Connect key + distribution certificate — the same automated setup that builds Arc Lake, Ash Tree IDE and DART.
