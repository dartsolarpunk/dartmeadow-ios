// POST {token, token_type_hint} or {code} → revokes the app's Sign in with Apple grant.
const { apple, handler } = require('./_apple');
module.exports = handler(async ({ token, token_type_hint, code }, res) => {
  let hint = token_type_hint || 'refresh_token';
  if (!token && code) {
    const t = await apple('token', { grant_type: 'authorization_code', code });
    if (t.status !== 200) return res.status(502).json({ error: t.json.error || ('apple ' + t.status) });
    token = t.json.refresh_token || t.json.access_token; hint = t.json.refresh_token ? 'refresh_token' : 'access_token';
  }
  if (!token) return res.status(400).json({ error: 'token or code required' });
  const r = await apple('revoke', { token, token_type_hint: hint });
  if (r.status !== 200) return res.status(502).json({ error: r.json.error || ('apple ' + r.status) });
  res.json({ revoked: true });
});
