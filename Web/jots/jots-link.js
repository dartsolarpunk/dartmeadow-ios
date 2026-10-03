/*
 * JOTS Link — DART Meadow: Journey of the Skyboard's connection to the
 * LEATR framework (the private DART-Skyboard/leatr-ash repository and its
 * Apps Script bridge). This public file only transmits and receives; the
 * services it talks to are operated from leatr-ash.
 *
 *   • Sign in with GitHub (device flow through the same Apps Script bridge
 *     Autumn uses) or play as a guest.
 *   • Signed-in players get a private repository, jots-<username>, that
 *     keeps their saves (and their multiplayer chat) and loads them back
 *     automatically — the same pattern as Autumn's Autumn-Ash-<username>.
 *     Guests keep the existing local save / export / import.
 *   • Anonymous gameplay analytics (no names, ids, chat or positions) are
 *     batched into the LEATR live analytics maze, so the Session Cubes on
 *     dartmeadow.com, the Autumn apps and the Bird Temple show game activity.
 *   • Multiplayer: every player in multiplayer mode shares one world. State
 *     travels over the LEATR node bus, the same Apps Script writenode /
 *     readnodes presence bus that Autumn's real-time scene uses. Nothing
 *     goes through a public broker. A leatr-ash jots-relay
 *     (window.JOTS_RELAY_URL) or an MQTT broker (window.JOTS_MQTT_URL) can
 *     be switched in for lower latency, but only when one is configured.
 *
 * Nothing here holds a secret: the OAuth client id is public, the client
 * secret stays in the Apps Script project, and each player's GitHub token
 * stays in their own browser.
 */
(function () {
  'use strict';

  const CFG = {
    gas: 'https://script.google.com/macros/s/AKfycbyzkQxLR5miUXP6oDw-1AR1GIjgpzlw9iLw0gO_ZTeLfL849LWbNX7WVz_kf7yLWBKA_w/exec',
    clientId: 'Ov23li2K0njEqO1WTSdD',
    scopes: 'repo,read:user',
    repoPrefix: 'jots-',
    // GitHub web sign-in: the OAuth app's callback is leatr.xyz, whose
    // jots-auth.html forwards to this game's auth.html.
    authRedirect: 'https://leatr.xyz/jots-auth.html',
    relay: window.JOTS_RELAY_URL || '',
    mqtt: window.JOTS_MQTT_URL || '',             // opt-in only; default is the LEATR node bus
    nodePrefix: 'jots_',                          // our sids on the shared LEATR node bus
    nodeWriteMs: 2000,                            // multiplayer state write cadence
    nodeReadMs: 1800,                             // multiplayer read cadence
    presenceMs: 15000,                            // story-mode "online" heartbeat
    chatHoldMs: 20000,                            // how long a chat line rides along on our node
    dmHoldMs: 45000,                              // friend messages ride a little longer (they're for one reader)
    mqttLib: 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js',
    topic: 'dartmeadow/jots/v1',
    room: 'world',
    stateHz: 4,
    peerTimeoutMs: 12000,                         // relay / MQTT; the node bus uses nodeTimeoutMs
    nodeTimeoutMs: 22000,
    // Each analytics write is a GitHub commit made by the Apps Script bridge's
    // token (5,000 API calls/hour shared by every app), so batch generously.
    analyticsFlushMs: 300000,                     // every flush is ~3 GitHub writes through the shared bridge
    exportMinGapMs: 300000,
    vaultAutosaveMs: 120000,
  };
  const LS = {
    consent: 'jots_consent_v1',
    identity: 'jots_identity_v1',
    token: 'jots_gh_token_v1',
  };
  const ls = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n || 8))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const unb64 = (s) => decodeURIComponent(escape(atob(String(s).replace(/\n/g, ''))));
  const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent('jots:' + name, { detail })); } catch (e) {} };

  // ── Identity ────────────────────────────────────────────────────────
  // A random session id for multiplayer (never the GitHub id), and a name:
  // the GitHub login when signed in, otherwise Guest-xxxx.
  const identity = ls.get(LS.identity) || { kind: 'guest', name: 'Guest-' + rid(2).toUpperCase(), avatar: '' };
  const sessionId = rid(6);
  function saveIdentity() { ls.set(LS.identity, identity); }

  // ── GitHub API ──────────────────────────────────────────────────────
  let token = ls.get(LS.token);
  async function gh(method, path, body) {
    const r = await fetch('https://api.github.com' + path, {
      method,
      headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub ' + r.status);
    return r.status === 204 ? {} : r.json();
  }

  // ── Sign in: GitHub device flow via the Apps Script bridge ──────────
  const auth = {
    get signedIn() { return identity.kind === 'github' && !!token; },
    identity,
    async deviceCode() {
      // Direct first (form-encoded avoids a CORS preflight), bridge fallback.
      try {
        const r = await fetch('https://github.com/login/device/code', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'client_id=' + CFG.clientId + '&scope=' + encodeURIComponent(CFG.scopes),
        });
        const d = await r.json();
        if (d.device_code) return d;
      } catch (e) {}
      // The bridge can be slow or answer with a Google error page while it's
      // busy; retry a few times rather than failing on the first hiccup.
      let lastErr = null;
      for (let i = 0; i < 3; i++) {
        try {
          const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
          const r = await fetch(CFG.gas + '?action=devicecode&t=' + Date.now(), { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(to);
          const text = await r.text();
          let d = null; try { d = JSON.parse(text); } catch (e) {}
          if (d && d.device_code) return d;
          lastErr = new Error(d && d.error ? d.error : 'the sign-in service is busy');
        } catch (e) { lastErr = new Error(e && e.name === 'AbortError' ? 'the sign-in service took too long' : 'couldn’t reach the sign-in service'); }
        if (i < 2) await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
      }
      throw lastErr;
    },
    // ── Web sign-in (the usual "Authorize" screen, no code to type) ─────
    // webStart() returns the GitHub URL to open; auth.html (reached via
    // leatr.xyz) hands GitHub's one-time code back; webFinish() trades it
    // for a token through the bridge's existing `exchange` action.
    webStart() {
      const state = 'jots' + rid(8);
      ls.set('jots_oauth_state', { state, ts: Date.now() });
      return 'https://github.com/login/oauth/authorize?client_id=' + CFG.clientId +
        '&scope=' + encodeURIComponent(CFG.scopes) +
        '&redirect_uri=' + encodeURIComponent(CFG.authRedirect) +
        '&state=' + state;
    },
    // A result auth.html left for us (sign-in done in another tab, or this
    // tab came back from GitHub). Taken once.
    takeWebResult() {
      const r = ls.get('jots_oauth_result');
      if (!r) return null;
      ls.del('jots_oauth_result');
      return Date.now() - (r.t || 0) < 10 * 60 * 1000 ? r : null;
    },
    async webFinish(res, onBusy) {
      if (!res || !res.code) throw new Error(res && res.error === 'access_denied' ? 'Sign-in was cancelled on GitHub.' : 'GitHub didn’t send a sign-in code — try again.');
      const st = ls.get('jots_oauth_state');
      if (!st || st.state !== res.state) throw new Error('That sign-in didn’t start here — try again.');
      ls.del('jots_oauth_state');
      // GitHub's code lasts 10 minutes; ride out a busy bridge within that.
      const until = Date.now() + 9 * 60 * 1000;
      let wait = 2000;
      while (Date.now() < until) {
        let d = null;
        try {
          const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20000);
          const r = await fetch(CFG.gas + '?action=exchange&code=' + encodeURIComponent(res.code) + '&t=' + Date.now(), { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(to);
          d = JSON.parse(await r.text());
        } catch (e) { d = null; }
        if (d && d.access_token) return this.finish(d);
        const why = String((d && d.error) || 'busy');
        if (/bad_verification_code|incorrect|expired|redirect_uri_mismatch|No code/i.test(why)) throw new Error(why);
        if (onBusy) onBusy(why);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 1.6, 15000);
      }
      throw new Error('The sign-in took too long — try again.');
    },
    // Polls until GitHub hands back a token (or the code expires). Mobile
    // browsers freeze a background tab's timers and requests while you
    // approve in GitHub, so every check has its own timeout, and coming
    // back to the game (or tapping "I've approved it") checks right away.
    _wake: null, _ctl: null, _now: false,
    // Check right now: cuts short a check that's still hanging from before
    // the tab went to the background, and skips the wait.
    pollNow() { this._now = true; try { if (this._ctl) this._ctl.abort(); } catch (e) {} if (this._wake) this._wake(); },
    async waitForToken(dev, onTick, onBusy) {
      const until = Date.now() + (dev.expires_in || 900) * 1000;
      let wait = Math.max(5, dev.interval || 5) * 1000, last = 0;
      while (Date.now() < until) {
        if (!this._now) await new Promise((r) => { const t = setTimeout(r, Math.max(0, wait - (Date.now() - last))); this._wake = () => { clearTimeout(t); r(); }; });
        this._wake = null;
        const urgent = this._now; this._now = false;
        if (onTick) onTick();
        if (!urgent && Date.now() - last < 2500) continue;  // GitHub asks for ≥5 s between checks
        last = Date.now();
        let d;
        try {
          const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
          this._ctl = ctl;
          const r = await fetch(CFG.gas + '?action=devicepoll&device_code=' + encodeURIComponent(dev.device_code) + '&t=' + Date.now(), { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(to);
          d = JSON.parse(await r.text());
        } catch (e) { continue; }                          // busy / error page / cut short: ask again
        finally { this._ctl = null; }
        if (d && d.access_token) return d;
        if (d && d.error === 'slow_down') wait += 5000;
        else if (d && d.error === 'expired_token') throw new Error('The sign-in code expired — try again.');
        else if (d && d.error === 'access_denied') throw new Error('Sign-in was cancelled on GitHub.');
        else if (d && /incorrect_device_code|incorrect_client|unsupported_grant|device_flow_disabled/.test(d.error || '')) throw new Error(d.error);
        // Anything else (the bridge busy or at its daily GitHub limit, a
        // Google error page, a lookup that failed) is not the end of the
        // sign-in: the approval is still valid on GitHub, so keep asking
        // with the same code until it expires.
        else if (d && d.error && d.error !== 'authorization_pending' && onBusy) onBusy(String(d.error));
      }
      throw new Error('The sign-in code expired — try again.');
    },
    async finish(d) {
      token = d.access_token;
      identity.kind = 'github';
      identity.name = d.username;
      identity.avatar = d.avatar_url || '';
      saveIdentity();
      ls.set(LS.token, token);   // after the identity, so other game tabs can adopt both
      emit('auth', { signedIn: true, name: identity.name });
      try { await vault.ensure(); } catch (e) { console.warn('[JOTS] vault:', e); }
      return identity;
    },
    // Re-validate a stored token on load.
    async restore() {
      if (!token || identity.kind !== 'github') return false;
      try {
        const u = await gh('GET', '/user');
        if (!u || !u.login) throw new Error('bad token');
        identity.name = u.login; identity.avatar = u.avatar_url || ''; saveIdentity();
        emit('auth', { signedIn: true, name: identity.name });
        vault.ensure().catch(() => {});
        return true;
      } catch (e) { this.signOut(true); return false; }
    },
    // Another tab of the game finished signing in: pick up its token here too.
    adoptFromStorage() {
      const t = ls.get(LS.token), id = ls.get(LS.identity);
      if (!t || !id || id.kind !== 'github' || (t === token && identity.kind === 'github')) return false;
      token = t;
      identity.kind = 'github'; identity.name = id.name; identity.avatar = id.avatar || '';
      emit('auth', { signedIn: true, name: identity.name });
      vault.ensure().catch(() => {});
      return true;
    },
    guest() {
      identity.kind = 'guest';
      if (!/^Guest-/.test(identity.name)) identity.name = 'Guest-' + rid(2).toUpperCase();
      identity.avatar = '';
      saveIdentity();
      emit('auth', { signedIn: false, name: identity.name });
    },
    signOut(silent) {
      token = null; ls.del(LS.token);
      vault.ready = false;
      this.guest();
      if (!silent) emit('auth', { signedIn: false, name: identity.name });
    },
  };

  // ── Vault: the player's private jots-<username> repository ─────────
  const vault = {
    ready: false,
    shas: {},
    get repo() { return identity.name ? CFG.repoPrefix + identity.name : ''; },
    async ensure() {
      if (!auth.signedIn) return false;
      const full = '/repos/' + identity.name + '/' + this.repo;
      let repo = await gh('GET', full);
      if (!repo) {
        await gh('POST', '/user/repos', {
          name: this.repo, private: true, auto_init: true,
          description: 'DART Meadow · Journey of the Skyboard — your saves and game data (private) · LEATR',
        });
        await this.put('README.md', '# Journey of the Skyboard — game data\n\nKept automatically by DART Meadow for ' + identity.name +
          '.\n\n- `saves/` — your game saves (autosave + slots)\n- `profile.json` — your pilot profile\n- `themes.json` — your saved UI colour themes\n- `chat/` — your multiplayer chat log\n\nPrivate to you. Do not edit by hand while the game is open.\n');
        await this.putJSON('profile.json', { pilot: identity.name, created: new Date().toISOString(), game: 'jots' });
      }
      this.ready = true;
      emit('vault', { ready: true, repo: this.repo });
      return true;
    },
    async get(path) {
      const f = await gh('GET', '/repos/' + identity.name + '/' + this.repo + '/contents/' + path);
      if (!f) return null;
      this.shas[path] = f.sha;
      return unb64(f.content || '');
    },
    async put(path, text, message) {
      if (this.shas[path] === undefined) { try { await this.get(path); } catch (e) {} }
      const body = { message: message || 'jots: ' + path, content: b64(text) };
      if (this.shas[path]) body.sha = this.shas[path];
      const r = await gh('PUT', '/repos/' + identity.name + '/' + this.repo + '/contents/' + path, body);
      if (r && r.content) this.shas[path] = r.content.sha;
      return r;
    },
    putJSON(path, obj, message) { return this.put(path, JSON.stringify(obj, null, 1), message); },
    // a binary file (already base64) at a new path — screenshots and the like
    async putBase64(path, content, message) {
      const body = { message: message || 'jots: ' + path, content: content };
      if (this.shas[path]) body.sha = this.shas[path];
      const r = await gh('PUT', '/repos/' + identity.name + '/' + this.repo + '/contents/' + path, body);
      if (r && r.content) this.shas[path] = r.content.sha;
      return r;
    },
    async save(data, name) {
      if (!this.ready) return false;
      await this.putJSON('saves/' + (name || 'autosave') + '.json', data, 'jots: save ' + (name || 'autosave'));
      return true;
    },
    async load(name) {
      if (!this.ready) return null;
      const t = await this.get('saves/' + (name || 'autosave') + '.json');
      return t ? JSON.parse(t) : null;
    },
    async appendChat(lines) {
      if (!this.ready || !lines.length) return;
      const day = new Date().toISOString().slice(0, 10), path = 'chat/' + day + '.json';
      let log = [];
      try { const t = await this.get(path); if (t) log = JSON.parse(t); } catch (e) {}
      await this.putJSON(path, log.concat(lines), 'jots: chat ' + day);
    },
  };

  // ── Anonymous analytics → the LEATR live maze ───────────────────────
  // Gameplay events only (what happened, never who): category jots_game,
  // a short label and an optional coarse detail (a count or a place key).
  // Batched, appended to the live maze's current chunk, and merged into
  // its latest export so every Session Cube viewer picks them up.
  const analytics = {
    queue: [],
    lastExport: 0,
    busy: false,
    track(label, detail) {
      if (!consent.get()) return;
      const e = { category: 'jots_game', label: String(label).slice(0, 40), ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
      if (detail != null && detail !== '') e.detail = String(detail).slice(0, 40);
      this.queue.push(e);
      if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
      emit('analytics', e);
    },
    async read(path) {
      const r = await fetch(CFG.gas + '?action=ashread&path=' + encodeURIComponent(path) + '&t=' + Date.now(), { cache: 'no-store' });
      const b = await r.json();
      if (b == null) return null;
      if (b.ok === false) throw new Error(b.error || 'unread');
      return b.ok === true && 'content' in b ? b.content : b;
    },
    write(path, payload, append, message) {
      // text/plain keeps it a CORS "simple request" (no preflight), like Autumn.
      return fetch(CFG.gas, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'ashwrite', path, uid: 'jots-game', append: !!append, payload, message: message || 'jots analytics' }) });
    },
    async flush() {
      if (this.busy || !this.queue.length || !consent.get()) return;
      this.busy = true;
      const batch = this.queue.splice(0, this.queue.length);
      try {
        const cfg = await this.read('ashtree/analytics-live/config.json');
        if (!cfg || !cfg.enabled || !cfg.mazeId) return;           // live feed switched off: drop quietly
        const base = 'ashtree/analytics-live/' + cfg.mazeId + '/';
        await this.write(base + 'chunk-' + (cfg.currentChunkIndex || 0) + '.json', batch, true, 'jots: chunk');
        if (Date.now() - this.lastExport < CFG.exportMinGapMs) { this.pending = (this.pending || []).concat(batch); return; }
        const merged = (this.pending || []).concat(batch); this.pending = [];
        const exp = await this.read(base + 'latest-export.json');
        if (!exp || !exp.pathIndex || !exp.pathIndex[0]) return;
        const path = exp.pathIndex[0].path || [];
        if (!path.length) return;
        // Same bucketing the Autumn apps use: spread the most recent events
        // evenly along the walked path, oldest first.
        let events = [];
        path.slice().sort((a, b) => a.order - b.order).forEach((n) => (n.events || []).forEach((e) => events.push(e)));
        events = events.concat(merged).slice(-4000);
        path.forEach((n) => { n.events = []; });
        const ordered = path.slice().sort((a, b) => a.order - b.order);
        events.forEach((e, i) => { ordered[Math.min(ordered.length - 1, Math.floor((i * ordered.length) / Math.max(events.length, 1)))].events.push(e); });
        exp.totalEvents = events.length;
        exp.exportedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        await this.write(base + 'latest-export.json', exp, false, 'jots: live export');
        this.lastExport = Date.now();
      } catch (e) {
        this.queue = batch.concat(this.queue).slice(-400);           // keep for the next try
      } finally { this.busy = false; }
    },
  };
  setInterval(() => { if (!document.hidden) analytics.flush(); }, CFG.analyticsFlushMs);

  // ── Consent (privacy policy) ────────────────────────────────────────
  const consent = {
    get() { const c = ls.get(LS.consent); return !!(c && c.agreed); },
    agree() { ls.set(LS.consent, { agreed: true, v: 1, ts: new Date().toISOString() }); emit('consent', { agreed: true }); },
    revoke() { ls.del(LS.consent); emit('consent', { agreed: false }); },
  };

  // ── Multiplayer transport ───────────────────────────────────────────
  function loadScript(src) {
    return new Promise((res, rej) => {
      if (window.mqtt) return res();
      const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  // Relay transport (leatr-ash/services/jots-relay): plain JSON frames.
  function relayTransport(url, room, onMsg, onStatus) {
    let ws = null, closed = false, retry = 1000;
    const open = () => {
      if (closed) return;
      ws = new WebSocket(url);
      ws.onopen = () => { retry = 1000; ws.send(JSON.stringify({ t: 'join', room, id: sessionId })); onStatus('online'); };
      ws.onmessage = (ev) => { try { onMsg(JSON.parse(ev.data)); } catch (e) {} };
      ws.onclose = () => { onStatus('reconnecting'); if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 15000))); };
      ws.onerror = () => {};
    };
    open();
    return {
      send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      close() { closed = true; try { ws.close(); } catch (e) {} },
    };
  }
  // MQTT transport: one topic per player's state, one for chat, one for
  // leaves (the broker publishes our "last will" if we drop).
  async function mqttTransport(url, room, onMsg, onStatus) {
    await loadScript(CFG.mqttLib);
    const root = CFG.topic + '/' + room;
    const client = window.mqtt.connect(url, {
      clientId: 'jots_' + sessionId, clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 10000,
      will: { topic: root + '/leave', payload: JSON.stringify({ t: 'leave', id: sessionId }), qos: 0, retain: false },
    });
    client.on('connect', () => { onStatus('online'); client.subscribe(root + '/#'); });
    client.on('reconnect', () => onStatus('reconnecting'));
    client.on('offline', () => onStatus('offline'));
    client.on('message', (_t, buf) => { try { onMsg(JSON.parse(buf.toString())); } catch (e) {} });
    return {
      send(msg) { if (client.connected) client.publish(root + '/' + msg.t, JSON.stringify(msg), { qos: 0 }); },
      close() { try { client.publish(root + '/leave', JSON.stringify({ t: 'leave', id: sessionId })); client.end(true); } catch (e) {} },
    };
  }

  // LEATR node bus: the Apps Script writenode / readnodes actions (a 30 s
  // CacheService entry per session id, shared with Autumn). Each game
  // session writes one node, sid "jots_<session id>", whose bezier field
  // carries our packed state; everyone reads the jots_ nodes back. The
  // game's nodes sit at x=y=z=0 with shell "JOTS" so they never land in
  // Autumn's own scene as people.
  const nodeBus = {
    sid: CFG.nodePrefix + sessionId,
    write(payload, label, color) {
      const node = { x: 0, y: 0, z: 0, shell: 'JOTS', label: label || null, color: color || '#39ff9c', bezier: JSON.stringify(payload) };
      return fetch(CFG.gas, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true,
        body: JSON.stringify({ action: 'writenode', sid: this.sid, uid: this.sid, node }) });
    },
    // Best-effort goodbye that survives the page closing.
    bye(label) {
      const body = JSON.stringify({ action: 'writenode', sid: this.sid, uid: this.sid,
        node: { x: 0, y: 0, z: 0, shell: 'JOTS', label: label || null, bezier: JSON.stringify({ t: 'bye', ts: Date.now() }) } });
      try { if (navigator.sendBeacon && navigator.sendBeacon(CFG.gas, new Blob([body], { type: 'text/plain;charset=utf-8' }))) return; } catch (e) {}
      try { fetch(CFG.gas, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, keepalive: true }); } catch (e) {}
    },
    // → [{sid, id, label, payload, ts}] for every live game node but ours.
    async read() {
      const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
      try {
        const r = await fetch(CFG.gas + '?action=readnodes&scope=jots&t=' + Date.now(), { cache: 'no-store', signal: ac.signal });
        const b = await r.json();
        const out = [];
        for (const n of (b && b.nodes) || []) {
          if (!n || typeof n.sid !== 'string' || n.sid.indexOf(CFG.nodePrefix) !== 0) continue;
          let payload = null; try { payload = typeof n.bezier === 'string' ? JSON.parse(n.bezier) : n.bezier; } catch (e) {}
          if (!payload || typeof payload !== 'object') continue;
          out.push({ sid: n.sid, id: n.sid.slice(CFG.nodePrefix.length), label: n.label, payload, ts: n.ts });
        }
        return out;
      } finally { clearTimeout(to); }
    },
  };
  // Multiplayer over the node bus. send() only records what to say; a
  // single writer sends it every nodeWriteMs (sooner right after a chat
  // line) and a single reader polls, each waiting for its last request, so
  // a slow Apps Script response never piles requests up.
  function gasTransport(room, onMsg, onStatus) {
    let closed = false, state = null, chatK = 0, fails = 0, first = true;
    const chatOut = [];                          // [{k,text,ts,at}]
    // Friend messages travel in their own field, `dm`, addressed to one
    // pilot name; the world chat (`ch`) never carries them, so older game
    // versions on the bus never show them.
    const dmOut = [];                            // [{k,to,b,ts,at}]
    const dmSeen = new Set();
    const lastTs = new Map();                    // peer id → last state ts delivered
    const chatSeen = new Set();                  // peer id + ':' + k
    let wTimer = null, rTimer = null;
    const writeLoop = async () => {
      if (closed) return;
      const now = Date.now();
      while (chatOut.length && now - chatOut[0].at > CFG.chatHoldMs) chatOut.shift();
      while (dmOut.length && now - dmOut[0].at > CFG.dmHoldMs) dmOut.shift();
      if (state && !document.hidden) {
        const payload = Object.assign({}, state, { room, ts: now });
        if (chatOut.length) payload.ch = chatOut.map((c) => ({ k: c.k, text: c.text, ts: c.ts }));
        if (dmOut.length) payload.dm = dmOut.map((c) => ({ k: c.k, to: c.to, b: c.b, ts: c.ts }));
        try { const r = await nodeBus.write(payload, state.n, state.c); if (!r.ok) throw 0; fails = 0; onStatus('online'); }
        catch (e) { if (++fails >= 3) onStatus('reconnecting'); }
      }
      if (!closed) wTimer = setTimeout(writeLoop, CFG.nodeWriteMs);
    };
    const readLoop = async () => {
      if (closed) return;
      if (!document.hidden) {
        try {
          const nodes = await nodeBus.read();
          for (const nd of nodes) {
            if (nd.id === sessionId) continue;
            const m = nd.payload;
            if (m.t === 'bye') { onMsg({ t: 'leave', id: nd.id }); lastTs.delete(nd.id); continue; }
            if (m.t !== 'state' || (m.room && m.room !== room)) continue;
            m.id = nd.id;                          // the node's own id, never what the payload claims
            if (lastTs.get(nd.id) !== m.ts) { lastTs.set(nd.id, m.ts); onMsg(m); }
            for (const c of m.ch || []) {
              const key = nd.id + ':' + c.k;
              if (chatSeen.has(key)) continue;
              chatSeen.add(key);
              if (!first) onMsg({ t: 'chat', id: nd.id, n: m.n, text: c.text, ts: c.ts });
            }
            for (const c of Array.isArray(m.dm) ? m.dm : []) {
              if (!c || typeof c.to !== 'string') continue;
              const key = nd.id + ':' + c.k;
              if (dmSeen.has(key)) continue;
              dmSeen.add(key);
              onMsg({ t: 'dm', id: nd.id, n: m.n, kd: m.k, to: c.to, b: c.b, ts: c.ts });   // first read too: the friends side drops repeats
            }
          }
          if (chatSeen.size > 2000) chatSeen.clear();
          if (dmSeen.size > 2000) dmSeen.clear();
          first = false;
        } catch (e) {}
      }
      if (!closed) rTimer = setTimeout(readLoop, CFG.nodeReadMs);
    };
    writeLoop(); readLoop();
    return {
      nodeBus: true,
      send(msg) {
        if (msg.t === 'state') { state = msg; return; }
        if (msg.t === 'chat') {
          chatOut.push({ k: ++chatK, text: msg.text, ts: msg.ts, at: Date.now() });
          clearTimeout(wTimer); wTimer = setTimeout(writeLoop, 150);
        }
        if (msg.t === 'dm') {
          dmOut.push({ k: ++chatK, to: msg.to, b: msg.b, ts: msg.ts, at: Date.now() });
          while (dmOut.length > 12) dmOut.shift();
          clearTimeout(wTimer); wTimer = setTimeout(writeLoop, 150);
        }
      },
      close() { closed = true; clearTimeout(wTimer); clearTimeout(rTimer); nodeBus.bye(); },
    };
  }

  // ── Multiplayer session ─────────────────────────────────────────────
  // Shared world state stays deterministic on every client (seeded
  // galaxies and systems, planets from the real date); what travels is
  // each player's own ship state, chat, and — from one agreed player —
  // where the wandering Bird Temple is, so everyone meets it in one place.
  const mp = {
    active: false,
    status: 'offline',
    peers: new Map(),          // id → {id,name,kind,gal,sys,p,q,c,walk,ts,...}
    chat: [],
    chatLog: [],               // for the signed-in player's vault
    transport: null,
    _tick: null,
    getState: null,            // set by the game: () => {gal,sys,p:[..],q:[..],c,walk,bt?}
    async start() {
      if (this.active) return;
      this.active = true;
      this.setStatus('connecting');
      const onMsg = (m) => this.onMsg(m);
      const onStatus = (s) => this.setStatus(s);
      try {
        this.transport = CFG.relay ? relayTransport(CFG.relay, CFG.room, onMsg, onStatus)
                       : CFG.mqtt ? await mqttTransport(CFG.mqtt, CFG.room, onMsg, onStatus)
                       : gasTransport(CFG.room, onMsg, onStatus);
      } catch (e) { this.setStatus('offline'); console.warn('[JOTS] multiplayer:', e); return; }
      this._tick = setInterval(() => this.sendState(), 1000 / CFG.stateHz);
      this._sweep = setInterval(() => this.sweep(), 2000);
      this._chatSave = setInterval(() => this.saveChat(), 60000);
      analytics.track('mode', 'multiplayer');
    },
    stop() {
      if (!this.active) return;
      this.active = false;
      clearInterval(this._tick); clearInterval(this._sweep); clearInterval(this._chatSave);
      this.saveChat();
      try { this.transport && this.transport.close(); } catch (e) {}
      this.transport = null;
      this.peers.clear();
      emit('peers', { peers: [] });
      this.setStatus('offline');
    },
    setStatus(s) { this.status = s; emit('mpstatus', { status: s }); },
    sendState() {
      if (!this.transport || !this.getState || document.hidden) return;
      let st; try { st = this.getState(); } catch (e) { return; }
      if (!st) return;
      this.transport.send({ t: 'state', id: sessionId, n: identity.name, k: identity.kind === 'github' ? 'h' : 'g', ts: Date.now(), ...st });
    },
    sendChat(text) {
      text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text || !this.transport) return;
      const m = { t: 'chat', id: sessionId, n: identity.name, text, ts: Date.now() };
      this.transport.send(m);
      this.onMsg(m, true);
    },
    // A message for one pilot (friends: requests, private chat, shared
    // Journal markers). Addressed by pilot name; only that player's game
    // shows it. body: a small object, at most ~4 KB once packed.
    sendDirect(to, body) {
      to = String(to || '').slice(0, 40);
      if (!to || !this.transport || !body) return false;
      let packed; try { packed = JSON.stringify(body); } catch (e) { return false; }
      if (packed.length > 4500) return false;
      this.transport.send({ t: 'dm', id: sessionId, n: identity.name, kd: identity.kind === 'github' ? 'h' : 'g', to, b: body, ts: Date.now() });
      return true;
    },
    onMsg(m, self) {
      if (!m || !m.t) return;
      if (m.t === 'dm') {
        if (m.id === sessionId || typeof m.to !== 'string') return;
        if (m.to.toLowerCase() !== String(identity.name || '').toLowerCase()) return;
        if (!m.b || typeof m.b !== 'object') return;
        emit('dm', { from: String(m.n || '?').slice(0, 40), kind: m.kd === 'h' ? 'github' : 'guest', peer: m.id, body: m.b, ts: +m.ts || Date.now() });
        return;
      }
      if (m.t === 'state' && m.id !== sessionId) {
        const had = this.peers.has(m.id), prev = this.peers.get(m.id), now = Date.now();
        // Velocity from the last two samples (sender clock), so ghosts can
        // glide between the node bus's ~2 s updates instead of hopping.
        let v = null;
        if (prev && prev.p && m.p && m.ts > prev.ts) {
          const dt = (m.ts - prev.ts) / 1000;
          if (dt < 6) v = [(m.p[0] - prev.p[0]) / dt, (m.p[1] - prev.p[1]) / dt, (m.p[2] - prev.p[2]) / dt];
        }
        this.peers.set(m.id, { ...m, v, seen: now });
        if (!had) { emit('peers', { peers: [...this.peers.values()] }); analytics.track('players_online', this.peers.size + 1); }
      } else if (m.t === 'leave' && m.id !== sessionId) {
        if (this.peers.delete(m.id)) emit('peers', { peers: [...this.peers.values()] });
      } else if (m.t === 'chat') {
        if (!self && m.id === sessionId) return;
        const line = { n: String(m.n || '?').slice(0, 40), text: String(m.text || '').slice(0, 200), ts: m.ts || Date.now(), me: m.id === sessionId };
        this.chat.push(line); if (this.chat.length > 50) this.chat.shift();
        this.chatLog.push(line);
        emit('chat', line);
      }
    },
    sweep() {
      const now = Date.now(); let gone = false;
      const limit = this.transport && this.transport.nodeBus ? CFG.nodeTimeoutMs : CFG.peerTimeoutMs;
      for (const [id, p] of this.peers) if (now - p.seen > limit) { this.peers.delete(id); gone = true; }
      if (gone) emit('peers', { peers: [...this.peers.values()] });
    },
    async saveChat() {
      if (!this.chatLog.length || !vault.ready) return;
      const lines = this.chatLog.splice(0, this.chatLog.length);
      try { await vault.appendChat(lines); } catch (e) { this.chatLog = lines.concat(this.chatLog); }
    },
    // The Bird Temple's position comes from one agreed player: the lowest
    // session id among everyone in the home system (including us).
    templeAuthority(inSol) {
      if (!inSol) return null;
      let best = sessionId, bestPeer = null;
      for (const p of this.peers.values()) if (p.sys === 'Sol' && p.gal === 'milkyway' && p.id < best) { best = p.id; bestPeer = p; }
      return bestPeer ? bestPeer : 'me';
    },
  };

  // ── Presence: "a player is in the game" ──────────────────────────────
  // Every player who has agreed to the privacy policy sends a small
  // heartbeat every 15 s, in Story and Multiplayer alike, so dartmeadow.com's
  // Session Cube can show how many are playing. It carries the random
  // session id and the mode; the pilot name only in multiplayer (where it's
  // already shown to other players). It rides the LEATR node bus: in
  // multiplayer the multiplayer node itself is the heartbeat, in story a
  // tiny node with no name. (MQTT only if an MQTT broker is configured.)
  const presence = {
    client: null, root: CFG.topic + '/' + CFG.room, _t: null, on: false,
    async start() {
      if (this.on || !consent.get()) return;
      this.on = true;
      if (CFG.mqtt) {
        try { await loadScript(CFG.mqttLib); } catch (e) { return; }
        const c = window.mqtt.connect(CFG.mqtt, {
          clientId: 'jotsp_' + sessionId, clean: true, keepalive: 30, reconnectPeriod: 5000, connectTimeout: 10000,
          will: { topic: this.root + '/presence-leave', payload: JSON.stringify({ id: sessionId }), qos: 0, retain: false },
        });
        c.on('connect', () => this.beat());
        this.client = c;
      }
      this._t = setInterval(() => this.beat(), CFG.presenceMs);
      this.beat();
    },
    beat() {
      if (!this.on || !consent.get()) return;
      const mode = (window.JOTS && window.JOTS.mode) || 'story';
      if (this.client) {
        if (!this.client.connected) return;
        const m = { t: 'presence', id: sessionId, m: mode, ts: Date.now() };
        if (mode === 'multiplayer') m.n = identity.name;
        this.client.publish(this.root + '/presence', JSON.stringify(m));
        return;
      }
      if (document.hidden) return;
      if (mp.active && mp.transport && mp.transport.nodeBus) return;   // the multiplayer node already says we're here
      nodeBus.write({ t: 'presence', m: mode === 'multiplayer' ? 'multiplayer' : 'story', ts: Date.now() }).catch(() => {});
    },
    stop() {
      if (!this.on) return;
      this.on = false;
      clearInterval(this._t);
      if (this.client) { try { this.client.publish(this.root + '/presence-leave', JSON.stringify({ id: sessionId })); this.client.end(true); } catch (e) {} this.client = null; }
      else if (!(mp.active && mp.transport && mp.transport.nodeBus)) nodeBus.bye();
    },
  };
  window.addEventListener('jots:consent', (e) => { if (e.detail && e.detail.agreed) presence.start(); else presence.stop(); });
  window.addEventListener('jots:mpstatus', () => presence.beat());
  window.addEventListener('pagehide', () => { presence.stop(); try { if (mp.active) mp.stop(); } catch (e) {} });
  // Back from approving on GitHub → check the sign-in straight away.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) auth.pollNow(); });
  window.addEventListener('focus', () => auth.pollNow());

  window.JOTS = { CFG, sessionId, identity, auth, vault, analytics, consent, mp, presence, nodeBus, mode: 'story' };
  if (consent.get()) setTimeout(() => presence.start(), 2500);
  // Re-validate a stored sign-in once the page settles.
  setTimeout(() => { auth.restore(); }, 1500);
})();
