/* DART Meadow — player safety and account deletion (App Store 1.2 / 5.1.1(v)).
 *
 * DMSafety.clean(text)      chat profanity filter: masks listed words (whole
 *                           words, with l33t spellings and stretched letters)
 *                           in chat shown here and in chat sent from here.
 * DMSafety.block(name)      hides that pilot everywhere: world chat, private
 *                           chat, friend requests, shared markers, their board
 *                           and name tag. Kept per device and, signed in with
 *                           GitHub, in blocks.json in the private jots-<you>
 *                           repository.
 * DMSafety.report({name,text,where})
 *                           a report card → the player's email app, addressed
 *                           to dartmeadow@gmail.com (mailto:, so nothing is
 *                           sent without the player seeing it), with a copy
 *                           button when no email app opens.
 * DMSafety.deleteAccount()  the typed-confirm delete flow (see runDelete).
 *
 * iOS (Sign in with Apple) contract — the native shell's existing bridge:
 *   window.webkit.messageHandlers.dmNative.postMessage(
 *     {cmd:'deleteAccount', type:'deleteAccount', provider:'apple', user:'<Apple user id>'})
 *   The handler replies (WKScriptMessageHandlerWithReply) with any value on
 *   success or an error string; no reply within 10 s counts as not handled.
 *   Native should revoke the Sign in with Apple token (Apple REST
 *   /auth/revoke) and forget the stored Apple user. Afterwards the page also
 *   sends the existing {cmd:'appleSignOut'}. A 'dm:deleteAccount' window event
 *   ({detail:{provider, user}}) fires first for any other listener.
 */
(function () {
  'use strict';
  const CONTACT = 'dartmeadow@gmail.com';
  const GH_APP = 'https://github.com/settings/connections/applications/Ov23li2K0njEqO1WTSdD';
  const KEY = 'jots_blocks_v1';
  const J = () => window.JOTS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = (n) => String(n || '').trim().toLowerCase();
  const toast = (m, ms) => { try { window.toast && window.toast(m, ms || 2400); } catch (e) {} };
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // ── profanity filter ───────────────────────────────────────────────────
  // Whole words only (so "class", "Scunthorpe", "cockpit" pass). STEMS also
  // catch longer words that start with them (fucking, shitty, bitches).
  const WORDS = ('anal anus arse arsehole ass asses asshole assholes bastard bastards bellend blowjob bollocks boner boob boobs ' +
    'buttplug chink clit coon cum cumshot dick dicks dildo dyke fag fags gook handjob jizz kike kyke milf nazi ' +
    'paki penis piss pissed porn porno prick pricks pube pussies pussy queef rape raped raping rapist retard retarded ' +
    'scrotum semen sex sexy spic spick tit tits titties tranny twat twats vagina wank wanker whore whores wetback').split(' ');
  const STEMS = ('fuck fuk fck motherfuck cunt shit bullshit dipshit horseshit bitch nigger nigga nigg faggot fagot cocksuck ' +
    'dickhead douchebag jackass dumbass slut whore wank retard').split(' ');
  const LEET = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '8': 'b', '+': 't' };
  const WSET = new Set(WORDS);
  const noDouble = (w) => !/(.)\1/.test(w);
  const W1 = new Set(WORDS.filter(noDouble)), S1 = STEMS.filter(noDouble);
  function isBad(tok) {
    const t = tok.toLowerCase().replace(/[01!34@5$78+]/g, (c) => LEET[c] || c);
    if (!/[a-z]/.test(t)) return false;
    const t2 = t.replace(/(.)\1{2,}/g, '$1');            // fuuuuck → fuck, keeps "ass"
    const t3 = t.replace(/(.)\1+/g, '$1');               // fuuck → fuck (only vs. words without double letters)
    if (WSET.has(t) || WSET.has(t2) || W1.has(t3)) return true;
    for (const s of STEMS) if (t.startsWith(s) || t2.startsWith(s)) return true;
    for (const s of S1) if (t3.startsWith(s)) return true;
    return false;
  }
  function clean(text) {
    return String(text == null ? '' : text).replace(/[\p{L}\p{N}@$!+]+/gu, (tok) => {
      // keep punctuation round a word: "shit!" → "****!"
      const m = tok.match(/^(.*?[\p{L}\p{N}@$].*?)([!+]*)$/u);
      const core = m ? m[1] : tok, tail = m ? m[2] : '';
      return isBad(core) ? '*'.repeat(core.length) + tail : tok;
    });
  }

  // ── block list ─────────────────────────────────────────────────────────
  const blank = () => ({ blocked: {}, unblocked: {} });
  let B = blank();
  try { B = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || 'null') || {}); } catch (e) {}
  let _vaultLast = '', _pushT = 0;
  function persist(fromAccount) {
    try { localStorage.setItem(KEY, JSON.stringify(B)); } catch (e) {}
    if (!fromAccount) { clearTimeout(_pushT); _pushT = setTimeout(pushVault, 1500); }
    refreshAll();
  }
  const vaultData = () => ({ kind: 'dartmeadow-blocks', v: 1, blocked: B.blocked, unblocked: B.unblocked });
  function pushVault() {
    const j = J(); if (!j || !j.vault || !j.vault.ready || _deleting) return;
    const d = vaultData(), txt = JSON.stringify(d); if (txt === _vaultLast) return;
    j.vault.putJSON('blocks.json', d, 'jots: blocks').then(() => { _vaultLast = txt; }).catch((e) => console.warn('[safety] save:', e));
  }
  window.addEventListener('jots:vault', async () => {
    try {
      const t = await J().vault.get('blocks.json');
      if (t) {
        const d = JSON.parse(t) || {};
        Object.entries(d.unblocked || {}).forEach(([k, ts]) => {
          if ((+ts || 0) > (B.unblocked[k] || 0)) B.unblocked[k] = +ts;
          if (B.blocked[k] && (B.blocked[k].ts || 0) <= +ts) delete B.blocked[k];
        });
        Object.entries(d.blocked || {}).forEach(([k, b]) => {
          if (!b || (B.unblocked[k] || 0) >= (+b.ts || 0)) return;
          if (!B.blocked[k] || (+b.ts || 0) > (B.blocked[k].ts || 0)) B.blocked[k] = { name: String(b.name || k).slice(0, 40), ts: +b.ts || Date.now() };
        });
        _vaultLast = JSON.stringify(vaultData());
        persist(true);
        Object.values(B.blocked).forEach((b) => announce(b.name));
      }
    } catch (e) { console.warn('[safety] load:', e); }
    pushVault();
  });
  const isBlocked = (n) => !!B.blocked[keyOf(n)];
  function announce(name) { try { window.dispatchEvent(new CustomEvent('dm:block', { detail: { name } })); } catch (e) {} }
  function block(name, quiet) {
    const k = keyOf(name); if (!k) return;
    const me = J() && J().identity && keyOf(J().identity.name); if (k === me) return;
    B.blocked[k] = { name: String(name).slice(0, 40), ts: Date.now() }; delete B.unblocked[k];
    persist();
    // world chat lines already on screen
    document.querySelectorAll('#jots-chat-log [data-n]').forEach((d) => { if (keyOf(d.dataset.n) === k) d.remove(); });
    announce(name);
    if (!quiet) toast('🚫 Blocked ' + name + ' — you won’t see their chat, tag or requests. Undo in PROFILE › SAFETY.', 3600);
  }
  function unblock(name) {
    const k = keyOf(name); if (!B.blocked[k]) return;
    delete B.blocked[k]; B.unblocked[k] = Date.now(); persist();
    toast('Unblocked ' + name, 2000);
  }

  // ── report ─────────────────────────────────────────────────────────────
  const REASONS = ['Harassment or bullying', 'Hate speech', 'Sexual content', 'Threats or violence', 'Spam or scam', 'Cheating', 'Other'];
  let rep = null;
  function gameVersion() { try { return (window.DM_IOS_APP ? 'iOS ' + (window.DM_IOS_APP.version || '') + ' (' + (window.DM_IOS_APP.build || '') + ')' : 'web') + ' · ' + location.host; } catch (e) { return 'web'; } }
  function reportText(o) {
    const j = J() || {};
    return 'DART Meadow report\n\n' +
      'Reported player: ' + (o.name || '(not given)') + '\n' +
      'Reason: ' + o.reason + '\n' +
      (o.text ? 'Message: "' + o.text + '"\n' : '') +
      (o.where ? 'Where: ' + o.where + '\n' : '') +
      (o.details ? '\nDetails:\n' + o.details + '\n' : '') +
      '\n—\nReported by: ' + ((j.identity && j.identity.name) || 'guest') + ' (' + ((j.identity && j.identity.kind) || 'guest') + ')\n' +
      'Session: ' + (j.sessionId || '-') + '\nTime: ' + new Date().toISOString() + '\nGame: ' + gameVersion() + '\n';
  }
  function report(o) {
    o = o || {};
    if (!rep) {
      rep = el('div', 'dms-ov'); rep.id = 'dms-report';
      rep.innerHTML = '<div class="dms-card" role="dialog" aria-modal="true" aria-labelledby="dms-rep-t">' +
        '<div class="dms-head"><span class="dms-t" id="dms-rep-t">⚑ REPORT</span><button class="dms-x" data-x>✕</button></div>' +
        '<label class="dms-lab">Player<input id="dms-rep-name" maxlength="40" autocomplete="off" placeholder="Pilot name (optional)"></label>' +
        '<div class="dms-quote" id="dms-rep-quote"></div>' +
        '<div class="dms-lab">What’s wrong?</div><div class="dms-chips" id="dms-rep-why"></div>' +
        '<textarea id="dms-rep-det" maxlength="1000" placeholder="Anything that helps us look into it (optional)"></textarea>' +
        '<label class="dms-chk" id="dms-rep-blk-row"><input type="checkbox" id="dms-rep-blk" checked> <span id="dms-rep-blk-t">Also block this player</span></label>' +
        '<div class="dms-note">Reports go to the DART Meadow team at <a href="mailto:' + CONTACT + '">' + CONTACT + '</a>. ' +
        'SEND opens your email app with the report filled in. We read every report and act on it.</div>' +
        '<div class="dms-status" id="dms-rep-st"></div>' +
        '<div class="dms-foot"><button class="dms-b" id="dms-rep-copy">⧉ COPY REPORT</button><button class="dms-b dms-go" id="dms-rep-send">⚑ SEND REPORT</button></div></div>';
      document.body.appendChild(rep);
      wireOverlay(rep);
      const why = $('dms-rep-why');
      why.innerHTML = REASONS.map((r, i) => '<button type="button" class="dms-chip' + (i ? '' : ' on') + '" data-r="' + esc(r) + '">' + esc(r) + '</button>').join('');
      why.onclick = (e) => { const b = e.target.closest('.dms-chip'); if (!b) return; why.querySelectorAll('.dms-chip').forEach((c) => c.classList.toggle('on', c === b)); };
      $('dms-rep-name').addEventListener('input', syncBlk);
    }
    rep._o = o;
    $('dms-rep-name').value = o.name || '';
    const q = $('dms-rep-quote');
    q.textContent = o.text ? '“' + clean(o.text) + '”' : ''; q.style.display = o.text ? '' : 'none';
    $('dms-rep-det').value = '';
    $('dms-rep-st').textContent = '';
    $('dms-rep-why').querySelectorAll('.dms-chip').forEach((c, i) => c.classList.toggle('on', i === 0));
    $('dms-rep-blk').checked = true;
    syncBlk();
    const collect = () => ({
      name: $('dms-rep-name').value.trim(), text: o.text || '', where: o.where || '',
      reason: ($('dms-rep-why').querySelector('.dms-chip.on') || {}).dataset.r || 'Other',
      details: $('dms-rep-det').value.trim(),
    });
    const after = (c) => { if (c.name && $('dms-rep-blk').checked && !isBlocked(c.name)) block(c.name, true); };
    $('dms-rep-send').onclick = () => {
      const c = collect();
      const href = 'mailto:' + CONTACT + '?subject=' + encodeURIComponent('DART Meadow report: ' + (c.name || 'player') + ' — ' + c.reason) + '&body=' + encodeURIComponent(reportText(c));
      after(c);
      try { window.location.href = href; } catch (e) {}
      $('dms-rep-st').innerHTML = '✉ Opening your email app… If nothing opens, tap COPY REPORT and email it to <b>' + CONTACT + '</b>.';
      try { J().analytics.track('report', c.reason); } catch (e) {}
    };
    $('dms-rep-copy').onclick = () => {
      const c = collect(), txt = 'To: ' + CONTACT + '\n' + reportText(c);
      after(c);
      const ok = () => { $('dms-rep-st').innerHTML = '⧉ Copied. Paste it into an email to <b>' + CONTACT + '</b>.'; };
      try { navigator.clipboard.writeText(txt).then(ok, () => fallbackCopy(txt) && ok()); } catch (e) { if (fallbackCopy(txt)) ok(); }
    };
    rep.classList.add('open');
  }
  function syncBlk() {
    const n = $('dms-rep-name').value.trim();
    $('dms-rep-blk-row').style.display = n ? '' : 'none';
    $('dms-rep-blk-t').textContent = 'Also block ' + (n || 'this player');
  }
  function fallbackCopy(t) {
    try { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
  }
  function wireOverlay(ov) {
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) ov.classList.remove('open'); });
    ov.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') ov.classList.remove('open'); });
    ov.addEventListener('keyup', (e) => e.stopPropagation());
    ov.querySelectorAll('[data-x]').forEach((b) => b.onclick = () => ov.classList.remove('open'));
  }

  // ── chat panel: per-line REPORT / BLOCK, and a footer ──────────────────
  let menu = null;
  function lineMenu(name, text, x, y) {
    if (!menu) {
      menu = el('div', 'dms-menu'); menu.id = 'dms-menu'; document.body.appendChild(menu);
      document.addEventListener('pointerdown', (e) => { if (menu.style.display !== 'none' && !menu.contains(e.target)) menu.style.display = 'none'; }, true);
    }
    menu.innerHTML = '<div class="dms-mn">' + esc(clean(name)) + '</div>' +
      '<button class="dms-b" data-a="rep">⚑ REPORT' + (text ? ' MESSAGE' : '') + '</button>' +
      '<button class="dms-b dms-bad" data-a="blk">🚫 BLOCK</button>';
    menu.style.display = 'block';
    const W = window.innerWidth, H = window.innerHeight;
    menu.style.left = Math.max(8, Math.min(W - 180, x - 60)) + 'px';
    menu.style.top = Math.max(8, Math.min(H - 110, y + 8)) + 'px';
    menu.querySelector('[data-a="rep"]').onclick = () => { menu.style.display = 'none'; report({ name, text, where: 'world chat' }); };
    menu.querySelector('[data-a="blk"]').onclick = () => { menu.style.display = 'none'; block(name); };
  }
  function buildChatBar() {
    const chat = $('jots-chat'), log = $('jots-chat-log');
    if (!chat || !log || $('dms-chatbar')) return !!$('dms-chatbar');
    log.addEventListener('click', (e) => {
      const d = e.target.closest('[data-n]'); if (!d || d.classList.contains('me')) return;
      lineMenu(d.dataset.n, d.dataset.raw || '', e.clientX, e.clientY);
    });
    const bar = el('div', 'dms-chatbar'); bar.id = 'dms-chatbar';
    bar.innerHTML = '<button type="button" class="dms-lk" id="dms-cb-rep" title="Report a player or message">⚑ REPORT</button>' +
      '<button type="button" class="dms-lk" id="dms-cb-blk" title="Players you’ve blocked">🚫 BLOCKED <span id="dms-cb-n">0</span></button>' +
      '<a class="dms-lk dms-mail" href="mailto:' + CONTACT + '" title="Contact the DART Meadow team">✉ ' + CONTACT + '</a>';
    chat.appendChild(bar);
    bar.addEventListener('keydown', (e) => e.stopPropagation());
    $('dms-cb-rep').onclick = () => report({ where: 'chat panel' });
    $('dms-cb-blk').onclick = () => openSafety();
    const tip = el('div', 'dms-tip', 'Tap a message to report or block its sender.'); tip.id = 'dms-cb-tip';
    chat.insertBefore(tip, bar);
    refreshAll();
    return true;
  }

  // ── safety section: settings + profile ─────────────────────────────────
  function section(host, compact) {
    if (!host) return;
    host.innerHTML = '';
    const s = el('div', 'dms-sec');
    const bl = Object.values(B.blocked).sort((a, b) => a.name.localeCompare(b.name));
    s.innerHTML = '<div class="dms-sh">SAFETY &amp; ACCOUNT</div>' +
      '<div class="dms-row"><div><div class="dms-rt">Report a player or a problem</div><div class="dms-rd">Goes to the DART Meadow team. You can also tap any chat message to report it.</div></div><button class="dms-b" data-a="rep">⚑ REPORT</button></div>' +
      '<div class="dms-row"><div><div class="dms-rt">Contact</div><div class="dms-rd"><a href="mailto:' + CONTACT + '">' + CONTACT + '</a></div></div></div>' +
      '<div class="dms-row"><div><div class="dms-rt">Chat filter</div><div class="dms-rd">Always on: swear words and slurs are masked in chat, names and shared markers — what you send and what you see.</div></div></div>' +
      '<div class="dms-rt" style="margin-top:6px">Blocked players · ' + bl.length + '</div>' +
      (bl.length ? '<div class="dms-bl">' + bl.map((b) => '<div class="dms-blr"><span>' + esc(b.name) + '</span><button class="dms-b" data-ub="' + esc(b.name) + '">UNBLOCK</button></div>').join('') + '</div>'
        : '<div class="dms-rd">Nobody. Blocking hides a player’s chat, name tag, friend requests and shared markers.</div>') +
      (compact ? '' : '<div class="dms-row dms-del"><div><div class="dms-rt">Delete account</div><div class="dms-rd">Erase your DART Meadow data, saves and sign-in.</div></div><button class="dms-b dms-bad" data-a="del">DELETE ACCOUNT</button></div>');
    host.appendChild(s);
    s.querySelector('[data-a="rep"]').onclick = () => report({ where: 'settings' });
    const d = s.querySelector('[data-a="del"]'); if (d) d.onclick = () => deleteAccount();
    s.querySelectorAll('[data-ub]').forEach((b) => b.onclick = () => unblock(b.dataset.ub));
  }
  function injectSettings() {
    const box = document.querySelector('#settings-modal .modal-box');
    if (!box || $('dms-settings')) return;
    const host = el('div'); host.id = 'dms-settings';
    const foot = box.querySelector('.modal-footer');
    box.insertBefore(host, foot || null);
    section(host);
  }
  function openSafety() {
    if (typeof window.openProfileMenu === 'function') { window.openProfileMenu(); setTimeout(() => { const s = $('pf-safety'); if (s) s.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 60); }
  }
  function refreshAll() {
    const n = $('dms-cb-n'); if (n) n.textContent = String(Object.keys(B.blocked).length);
    section($('dms-settings'));
    if ($('pf-safety')) section($('pf-safety'));
  }

  // ── account deletion ───────────────────────────────────────────────────
  let _deleting = false, dlg = null;
  function accountKinds() {
    const j = J() || {};
    let apple = null; try { apple = JSON.parse(localStorage.getItem('dm_apple_v1') || 'null'); } catch (e) {}
    return {
      github: !!(j.auth && j.auth.signedIn), name: (j.identity && j.identity.name) || 'Guest',
      repo: (j.vault && j.vault.repo) || '', apple: (j.identity && j.identity.kind === 'apple') || !!apple, appleUser: (apple && apple.user) || '',
      ios: !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dmNative),
    };
  }
  function deleteAccount() {
    const k = accountKinds();
    if (!dlg) {
      dlg = el('div', 'dms-ov'); dlg.id = 'dms-delete';
      dlg.innerHTML = '<div class="dms-card dms-wide" role="dialog" aria-modal="true" aria-labelledby="dms-del-t">' +
        '<div class="dms-head"><span class="dms-t dms-red" id="dms-del-t">DELETE ACCOUNT</span><button class="dms-x" data-x>✕</button></div>' +
        '<div id="dms-del-body"></div></div>';
      document.body.appendChild(dlg);
      wireOverlay(dlg);
    }
    const body = $('dms-del-body');
    const items = [];
    if (k.github) items.push('Everything the game keeps in your private <b>' + esc(k.repo) + '</b> repository on GitHub: saves and journeys, friends list, journal markers, block list, themes, graphics settings, chat logs and screenshots.');
    items.push('Your friends list — friends who are online now are told to remove you; others drop you when they next see you’re gone.');
    items.push('Everything stored on this device: saves, journal, settings, pilot name and sign-in.');
    if (k.apple) items.push('Your Sign in with Apple link to DART Meadow: the app asks iOS to revoke it.');
    body.innerHTML = '<div class="dms-p">This permanently deletes your DART Meadow account <b>' + esc(k.name) + '</b>:</div>' +
      '<ul class="dms-ul">' + items.map((i) => '<li>' + i + '</li>').join('') + '</ul>' +
      (k.github ? '<div class="dms-p dms-box"><b>Your GitHub account is not deleted.</b> Only the game’s data and its access to your account go. ' +
        'The game can’t withdraw its own GitHub authorization, so after deleting, tap <b>Revoke access on GitHub</b> (GitHub › Settings › Applications › DART Meadow › Revoke).</div>' : '') +
      (k.apple ? '<div class="dms-p dms-box"><b>Your Apple Account is not deleted.</b> Only DART Meadow’s Sign in with Apple link and its data go.</div>' : '') +
      (!k.github && !k.apple ? '<div class="dms-p dms-box">You’re playing as a guest, so all your data is on this device.</div>' : '') +
      '<label class="dms-lab">Type <b>DELETE</b> to confirm<input id="dms-del-in" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DELETE"></label>' +
      '<div class="dms-foot"><button class="dms-b" data-x2>CANCEL</button><button class="dms-b dms-bad" id="dms-del-go" disabled>DELETE MY ACCOUNT</button></div>';
    const inp = $('dms-del-in'), go = $('dms-del-go');
    inp.oninput = () => { go.disabled = inp.value.trim().toUpperCase() !== 'DELETE'; };
    body.querySelector('[data-x2]').onclick = () => dlg.classList.remove('open');
    go.onclick = () => { if (inp.value.trim().toUpperCase() === 'DELETE') runDelete(k); };
    dlg.classList.add('open');
    setTimeout(() => inp.focus(), 50);
  }
  function step(list, text) {
    const li = el('li', 'dms-step', '<i>…</i> ' + esc(text)); list.appendChild(li);
    return (ok, note) => { li.className = 'dms-step ' + (ok ? 'ok' : 'warn'); li.querySelector('i').textContent = ok ? '✓' : '⚠'; if (note) li.appendChild(el('div', 'dms-rd', note)); };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function nativeDelete(k) {
    const detail = { provider: 'apple', user: k.appleUser };
    try { window.dispatchEvent(new CustomEvent('dm:deleteAccount', { detail })); } catch (e) {}
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dmNative;
    if (!h) return { sent: false };
    let out;
    try {
      const r = h.postMessage({ cmd: 'deleteAccount', type: 'deleteAccount', provider: 'apple', user: k.appleUser });
      if (r && typeof r.then === 'function') {
        const v = await Promise.race([r, wait(10000).then(() => { throw new Error('no reply'); })]);
        out = { sent: true, ok: true, reply: v };
      } else out = { sent: true, ok: true, reply: null };
    } catch (e) { out = { sent: true, ok: false, error: String((e && e.message) || e) }; }
    try { const r2 = h.postMessage({ cmd: 'appleSignOut' }); if (r2 && r2.catch) r2.catch(() => {}); } catch (e) {}
    return out;
  }
  async function clearDevice() {
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
    try {
      if (window.indexedDB) {
        let names = [];
        if (indexedDB.databases) { try { names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean); } catch (e) {} }
        names = Array.from(new Set(names.concat(['dm-planets'])));   // the erosion cache (ui/dm-planet.js), for browsers without databases()
        await Promise.all(names.map((n) => new Promise((res) => { try { const r = indexedDB.deleteDatabase(n); r.onsuccess = r.onerror = r.onblocked = () => res(); } catch (e) { res(); } })));
      }
    } catch (e) {}
    try { if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((x) => caches.delete(x))); } } catch (e) {}
    try { if (navigator.serviceWorker) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map((r) => r.unregister())); } } catch (e) {}
  }
  async function runDelete(k) {
    if (_deleting) return;
    _deleting = true; window.DM_ACCOUNT_DELETING = true;
    const j = J() || {};
    const body = $('dms-del-body');
    dlg.querySelectorAll('[data-x]').forEach((b) => { b.style.visibility = 'hidden'; });
    body.innerHTML = '<div class="dms-p">Deleting your account…</div><ul class="dms-steps" id="dms-steps"></ul><div id="dms-done"></div>';
    const list = $('dms-steps');
    const links = [];
    // 1. friends + multiplayer
    let s = step(list, 'Removing you from friends and multiplayer');
    try {
      const told = window.DMFriends && window.DMFriends.wipe ? window.DMFriends.wipe() : 0;
      try { if (j.mp && j.mp.active) j.mp.stop(); } catch (e) {}
      try { j.presence && j.presence.stop(); } catch (e) {}
      try { j.nodeBus && j.nodeBus.bye(); } catch (e) {}
      s(true, told ? 'Told ' + told + ' online friend' + (told > 1 ? 's' : '') + ' to remove you.' : '');
    } catch (e) { s(false, String(e.message || e)); }
    // 2. GitHub repository
    if (k.github) {
      s = step(list, 'Erasing your ' + k.repo + ' repository on GitHub');
      try {
        const r = await j.vault.wipe();
        if (r.how === 'repo') s(true, 'Repository deleted.');
        else if (r.how === 'emptied') { s(true, 'All game files erased and their history replaced with a single note. To remove the empty repository too: Settings › Delete this repository.'); links.push(['Delete the empty repository on GitHub', r.url]); }
        else s(true, 'Nothing was stored there.');
      } catch (e) { s(false, 'GitHub didn’t accept it (' + (e.message || e) + '). Delete the repository yourself on GitHub, or email ' + CONTACT + '.'); links.push(['Open the repository settings on GitHub', 'https://github.com/' + encodeURIComponent(k.name) + '/' + encodeURIComponent(k.repo) + '/settings']); }
      links.push(['Revoke DART Meadow’s access on GitHub', GH_APP]);
    }
    // 3. Sign in with Apple (iOS app)
    if (k.apple) {
      s = step(list, 'Revoking Sign in with Apple');
      const r = await nativeDelete(k);
      if (r.sent && r.ok) s(true, 'The app revoked it.');
      else s(false, (r.sent ? 'The app didn’t confirm (' + r.error + '). ' : 'Not running in the iOS app. ') + 'You can finish it in iOS Settings › your name › Sign-In & Security › Sign in with Apple › DART Meadow › Stop Using.');
    }
    // 4. sign out
    s = step(list, 'Signing out');
    try { j.auth && j.auth.signOut(true); s(true); } catch (e) { s(false, String(e.message || e)); }
    // 5. this device
    s = step(list, 'Clearing this device');
    await clearDevice(); s(true);
    try { j.analytics && (j.analytics.queue = []); } catch (e) {}
    const done = $('dms-done');
    done.innerHTML = '<div class="dms-p" style="margin-top:8px"><b>Your DART Meadow account is deleted.</b></div>' +
      (links.length ? '<div class="dms-links">' + links.map(([t, u]) => '<a class="dms-b" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(t) + ' ↗</a>').join('') + '</div>' : '') +
      '<div class="dms-rd">Questions: <a href="mailto:' + CONTACT + '">' + CONTACT + '</a></div>' +
      '<div class="dms-foot"><button class="dms-b dms-go" id="dms-finish">FINISH</button></div>';
    const finish = async () => { await clearDevice(); try { const u = new URL(location.href); u.search = ''; u.searchParams.set('fresh', Date.now().toString(36)); location.replace(u.toString()); } catch (e) { location.reload(); } };
    $('dms-finish').onclick = finish;
    // anything the running game writes before FINISH goes too
    window.addEventListener('pagehide', () => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  }

  // ── boot ───────────────────────────────────────────────────────────────
  function init() {
    injectSettings();
    if (!buildChatBar()) { const t = setInterval(() => { if (buildChatBar()) clearInterval(t); }, 1000); setTimeout(() => clearInterval(t), 60000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0)); else setTimeout(init, 0);

  window.DMSafety = { CONTACT, clean, isBad, isBlocked, block, unblock, blocked: () => Object.values(B.blocked), report, lineMenu, section, openSafety, deleteAccount, get deleting() { return _deleting; } };
})();
