// Sign in with Apple token service for the DART Meadow iOS app (com.dartmeadow.jots).
// Env: SIWA_TEAM_ID, SIWA_KEY_ID, SIWA_PRIVATE_KEY (contents of AuthKey_<id>.p8 for a key
// with "Sign in with Apple" enabled), SIWA_CLIENT_ID (default com.dartmeadow.jots).
const crypto = require('crypto');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const CLIENT = () => process.env.SIWA_CLIENT_ID || 'com.dartmeadow.jots';

function clientSecret() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: process.env.SIWA_KEY_ID }));
  const body = b64u(JSON.stringify({ iss: process.env.SIWA_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: CLIENT() }));
  const key = (process.env.SIWA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const sig = crypto.sign('SHA256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}

async function apple(path, params) {
  const r = await fetch('https://appleid.apple.com/auth/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: CLIENT(), client_secret: clientSecret() }, params)),
  });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text || '{}'); } catch (e) {}
  return { status: r.status, json };
}

function handler(fn) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!process.env.SIWA_KEY_ID || !process.env.SIWA_PRIVATE_KEY || !process.env.SIWA_TEAM_ID) return res.status(503).json({ error: 'service not configured' });
    try { const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); await fn(body, res); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  };
}
module.exports = { apple, handler };
