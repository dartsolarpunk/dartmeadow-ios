// POST {code} → {refresh_token}. The app keeps the refresh token in its Keychain only.
const { apple, handler } = require('./_apple');
module.exports = handler(async ({ code }, res) => {
  if (!code) return res.status(400).json({ error: 'code required' });
  const r = await apple('token', { grant_type: 'authorization_code', code });
  if (r.status !== 200) return res.status(502).json({ error: r.json.error || ('apple ' + r.status) });
  res.json({ refresh_token: r.json.refresh_token || '' });   // tokens are never logged or stored here
});
