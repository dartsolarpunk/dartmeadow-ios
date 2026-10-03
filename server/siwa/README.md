# Sign in with Apple token service

Revokes the app's Sign in with Apple grant when a player deletes their account
(App Store guideline 5.1.1(v)). Apple requires a `client_secret` signed with a
Sign in with Apple key, so this can't live in the app.

1. In developer.apple.com → Certificates, IDs & Profiles → Keys, create a key with
   **Sign in with Apple** enabled (primary App ID `com.dartmeadow.jots`) and download the `.p8`.
2. Deploy this folder to Vercel (`vercel deploy --prod` from `server/siwa`) and set the env vars
   `SIWA_TEAM_ID=L7AHWS9Q6V`, `SIWA_KEY_ID=<key id>`, `SIWA_PRIVATE_KEY=<.p8 contents>`.
3. Set `DM_SIWA_SERVICE_URL` in `project.yml` to `https://<deployment>/api` and ship a build.

Endpoints: `POST /api/token {code}` → `{refresh_token}`, `POST /api/revoke {token}` or `{code}`.
Nothing is stored or logged server-side.
