# Network inventory: what the game calls and how it works in the app

The page runs at origin **`dartmeadow://localhost`**. WebKit treats it as a
secure context (`isSecureContext=true`, `navigator.gpu` present, confirmed
in the CI simulator smoke test). It sends that value as the `Origin` header on
cross-origin requests. Every endpoint below answers `Access-Control-Allow-Origin: *`,
so none of them needs a server-side allowlist change. All of them are HTTPS, so
no ATS exceptions are needed. CORS was checked on Oct 2, 2026 with
`curl -H "Origin: jots://app"`. That's a stand-in custom origin; the servers
answer `*` no matter which origin is sent.

| # | Endpoint | Used for | Method | In the app |
|---|---|---|---|---|
| 1 | `script.google.com/macros/s/AKfycbyz…/exec` (LEATR / Autumn Apps Script bridge; it redirects to `script.googleusercontent.com`) | GitHub device-code sign-in (`devicecode`, `devicepoll`, `exchange`), LEATR live-maze anonymous analytics (`ashread`/`ashwrite` under `ashtree/analytics-live/`), multiplayer and presence on the LEATR node bus (`writenode` / `readnodes&scope=jots`, plus `sendBeacon` on leave), Bird Temple Session Cubes live feed (`ashread`), feedback (`?action=feedback`) | GET and POST `text/plain` (a CORS "simple" request, so no preflight) | ✅ ACAO `*` on both the 302 and the 200. `readnodes` returned `{"nodes":[],…}` with a custom Origin |
| 2 | `api.github.com` | Player vault `jots-<user>` (create repo, read/write saves, profile, themes, journal, chat, screenshots), `/user` token check, soundtrack folder listing (`/repos/dartsolarpunk/dartmeadow-space/contents/music`) | GET/PUT/POST with `Authorization` | ✅ preflight allows `*` and Authorization/Content-Type. In the smoke test the music scan found 16 tracks |
| 3 | `github.com/login/device/code` | Direct device-code request (tried first) | POST form | ⚠ No CORS on GitHub's side, which is the same on the web. The game falls back to the bridge (#1) automatically |
| 4 | `github.com/login/device`, `github.com/login/oauth/authorize` | User approves the sign-in | opened by `window.open` | ✅ Opens in an in-app Safari sheet. Closing the sheet triggers an immediate token poll |
| 5 | `leatr.xyz/jots-auth.html` → `dartmeadow.space/auth.html` | GitHub *web* redirect sign-in (fallback UI only) | redirect | ⚠ The redirect lands on dartmeadow.space, not in the app. The app uses the device-code flow (the game's default), which works. Supporting the redirect route natively would need either an app callback URL on the OAuth app or universal links |
| 6 | `dartmeadow.space/static/admin/notes.json` | Admin notes tab | GET | ✅ Fetched live by the native scheme handler. The bundled copy is used when offline |
| 7 | `dartmeadow.space/<any path not in the bundle>` | e.g. a soundtrack added on the web after this build | GET | ✅ Native fallback fetch (no CORS involved) |
| 8 | `cdn.jsdelivr.net/npm/three@0.185.0/…` | three.js WebGPU/TSL + GLTFLoader/SkeletonUtils | module import | ✅ **Bundled** (`Web/vendor/three-0.185.0`) |
| 9 | `www.gstatic.com/firebasejs/12.15.0/…` | Legacy Firebase (Google/Apple web sign-in, hidden by the game) | module import | ✅ **Bundled** |
| 10 | `fonts.googleapis.com` / `fonts.gstatic.com` | Orbitron, Rajdhani, Share Tech Mono | CSS/woff2 | ✅ **Bundled** |
| 11 | `raw.githubusercontent.com/nvkelso/natural-earth-vector/…coastline.geojson` (+ `api.allorigins.win` fallback) | Earth coastlines | GET | ✅ **Bundled** first. The network fallback is still there |
| 12 | `cdn.jsdelivr.net/npm/eruda@3` | `?debug` console | script | ✅ **Bundled** |
| 13 | `cdn.jsdelivr.net/npm/mqtt@5.10.1` | Only if `window.JOTS_MQTT_URL` is set (it isn't) | script | ✅ Loads from the network if it's ever enabled (CORS `*`) |
| 14 | `JOTS_RELAY_URL` WebSocket | Only if set (it isn't) | wss | ✅ WKWebView allows `wss://`. Nothing to configure |
| 15 | `js.stripe.com/v3/buy-button.js` | Support/donate modal | script + iframes | ✅ Loads, and iframes are allowed. ⚠ **App Store review:** in-app tips or donations through Stripe go against guideline 3.1.1 (only approved nonprofits may take donations outside IAP). This is fine for TestFlight internal testing. Hide it or switch to IAP before App Store / external beta review |
| 16 | `cube.leatr.xyz`, `dartmeadow.com`, `youtu.be`, credits links | Links | navigation | ✅ Open in the in-app Safari sheet |
| 17 | Same-origin `HEAD /index.html` (dm-time clock sync) and the `index.html` fingerprint poll (update offer) | Server clock offset / "new version" banner | GET/HEAD | ℹ The scheme handler sends no `Date` header, so the device clock is used (iOS keeps it NTP-synced). The bundled page never changes, so no web "update" banner appears. App updates come through TestFlight |

Analytics stay anonymous exactly as on the web. The user agent ends in
`DARTMeadowApp/<version>` if the LEATR side ever wants to tell app sessions apart.
