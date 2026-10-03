/* DART Meadow — Friends: add a pilot from their name tag, a Friends tab in
 * the chat panel with private 1:1 chat, and Journal markers shared with
 * friends.
 *
 * Transport: JOTS.mp.sendDirect(to, body) — a message addressed to one pilot
 * name that rides the same multiplayer link as the world chat (the LEATR node
 * bus by default; the relay / MQTT when configured). Both players have to be
 * online in multiplayer; anything sent to a friend who's away waits here and
 * goes out the moment they're seen online again.
 *
 * Friends are kept per device (localStorage) and, signed in with GitHub, in
 * friends.json in the private jots-<you> repository (merged on sign-in, so
 * every device shares one list). Private chat lines also go into the
 * repository's chat/ log with the world chat.
 *
 * Model: a request → the other pilot accepts (or declines). Two pilots who
 * ask each other become friends straight away.
 *
 * Bodies: {type:'freq'} {type:'facc'} {type:'fdec'} {type:'unf'}
 *         {type:'msg',text} {type:'mark',entry:{label,kind,place},note}
 */
(function () {
  'use strict';
  const KEY = 'jots_friends_v1';
  const J = () => window.JOTS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = (n) => String(n || '').trim().toLowerCase();
  const toast = (m, ms) => { try { window.toast && window.toast(m, ms || 2200); } catch (e) {} };
  const cleanName = (n) => String(n || '').replace(/[^\w.\-]/g, '').slice(0, 40);

  // ── store ──────────────────────────────────────────────────────────────
  const blank = () => ({ friends: {}, deleted: {}, sent: {}, inbox: {}, msgs: {}, outbox: {}, seen: [], unread: {} });
  let S = blank();
  try { S = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || 'null') || {}); } catch (e) {}
  function save(fromAccount) {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    if (!fromAccount) { clearTimeout(save._t); save._t = setTimeout(pushVault, 2500); }
    render();
  }
  const isFriend = (n) => !!S.friends[keyOf(n)];
  function addFriend(name, kind) {
    const k = keyOf(name); if (!k) return;
    S.friends[k] = Object.assign(S.friends[k] || {}, { name: cleanName(name), kind: kind || (S.friends[k] && S.friends[k].kind) || 'guest', since: (S.friends[k] && S.friends[k].since) || Date.now(), updated: Date.now() });
    delete S.deleted[k]; delete S.sent[k]; delete S.inbox[k];
  }
  function dropFriend(name) {
    const k = keyOf(name); delete S.friends[k]; delete S.sent[k]; S.deleted[k] = Date.now();
  }
  function pushMsg(name, line) {
    const k = keyOf(name); const a = S.msgs[k] || (S.msgs[k] = []);
    a.push(line); if (a.length > 120) a.splice(0, a.length - 120);
  }
  function seenBefore(id) {
    if (S.seen.indexOf(id) >= 0) return true;
    S.seen.push(id); if (S.seen.length > 400) S.seen.splice(0, S.seen.length - 400);
    return false;
  }

  // ── account sync: friends.json in the private repository ────────────────
  let _vaultLast = '';
  function vaultData() { return { kind: 'dartmeadow-friends', v: 1, friends: S.friends, deleted: S.deleted }; }
  function pushVault() {
    const j = J(); if (!j || !j.vault || !j.vault.ready) return;
    const d = vaultData(), txt = JSON.stringify(d); if (txt === _vaultLast) return;
    j.vault.putJSON('friends.json', d, 'jots: friends').then(() => { _vaultLast = txt; }).catch((e) => console.warn('[friends] save:', e));
  }
  window.addEventListener('jots:vault', async () => {
    try {
      const t = await J().vault.get('friends.json');
      if (t) {
        const d = JSON.parse(t) || {};
        Object.entries(d.deleted || {}).forEach(([k, when]) => {
          if ((+when || 0) > (S.deleted[k] || 0)) S.deleted[k] = +when;
          const f = S.friends[k]; if (f && (f.updated || f.since || 0) <= +when) delete S.friends[k];
        });
        Object.entries(d.friends || {}).forEach(([k, f]) => {
          if (!f || !f.name || (S.deleted[k] || 0) >= (f.updated || f.since || 0)) return;
          const have = S.friends[k];
          if (!have || (f.updated || 0) > (have.updated || 0)) S.friends[k] = { name: cleanName(f.name), kind: f.kind || 'guest', since: +f.since || Date.now(), updated: +f.updated || Date.now() };
        });
        _vaultLast = JSON.stringify(vaultData());
        save(true);
      }
    } catch (e) { console.warn('[friends] load:', e); }
    pushVault();
  });

  // ── sending ──────────────────────────────────────────────────────────────
  const me = () => (J() && J().identity && J().identity.name) || '';
  function onlinePeer(name) {
    const j = J(); if (!j || !j.mp || !j.mp.active) return null;
    const k = keyOf(name);
    for (const p of j.mp.peers.values()) if (keyOf(p.n) === k) return p;
    return null;
  }
  // Out now if they're online, otherwise queued until they are.
  function send(name, body) {
    const j = J(); body.mid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (j && j.mp && j.mp.active && onlinePeer(name) && j.mp.sendDirect(name, body)) return 'sent';
    const k = keyOf(name); const q = S.outbox[k] || (S.outbox[k] = []);
    q.push(body); if (q.length > 30) q.splice(0, q.length - 30);
    return 'queued';
  }
  function flushOutbox() {
    const j = J(); if (!j || !j.mp || !j.mp.active) return;
    let changed = false;
    Object.keys(S.outbox).forEach((k) => {
      const q = S.outbox[k]; if (!q || !q.length) { delete S.outbox[k]; return; }
      const p = onlinePeer(k); if (!p) return;
      // a few at a time: each rides the node for ~45 s
      const batch = q.splice(0, 4);
      batch.forEach((b) => j.mp.sendDirect(p.n, b));
      if (!q.length) delete S.outbox[k];
      changed = true;
    });
    if (changed) save();
  }
  setInterval(flushOutbox, 4000);

  function requestFriend(name, kind) {
    name = cleanName(name); const k = keyOf(name);
    if (!k || k === keyOf(me())) return;
    if (isFriend(name)) { openThread(name); return; }
    if (S.inbox[k]) { acceptRequest(name); return; }          // they already asked: that's a yes
    S.sent[k] = { name, kind: kind || 'guest', ts: Date.now() };
    const how = send(name, { type: 'freq' });
    save();
    toast(how === 'sent' ? '➕ Friend request sent to ' + name : '➕ Friend request for ' + name + ' — goes out when they’re online', 2400);
  }
  function acceptRequest(name) {
    const k = keyOf(name), req = S.inbox[k];
    addFriend(req ? req.name : name, req && req.kind);
    send(name, { type: 'facc' });
    save(); toast('✓ ' + name + ' is your friend now', 2200);
  }
  function declineRequest(name) {
    delete S.inbox[keyOf(name)]; send(name, { type: 'fdec' }); save();
  }
  function unfriend(name) {
    dropFriend(name); send(name, { type: 'unf' }); save(); toast('Removed ' + name + ' from your friends', 2000);
    if (ui.thread && keyOf(ui.thread) === keyOf(name)) { ui.thread = null; render(); }
  }
  function sendText(name, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300); if (!text) return;
    const how = send(name, { type: 'msg', text });
    const line = { me: true, text, ts: Date.now(), q: how === 'queued' };
    pushMsg(name, line); logToVault(name, text, true);
    save();
  }
  // a Journal entry → one or more friends
  function shareMarker(entry, names, note) {
    if (!entry || !names || !names.length) return;
    const e = { label: String(entry.label || 'Waypoint').slice(0, 48), kind: entry.kind, place: entry.place };
    let sent = 0, queued = 0;
    names.forEach((n) => {
      const how = send(n, { type: 'mark', entry: e, note: String(note || '').slice(0, 140) });
      how === 'sent' ? sent++ : queued++;
      pushMsg(n, { me: true, text: 'Shared a marker: ' + e.label, mark: e, ts: Date.now(), q: how === 'queued' });
    });
    save();
    toast('✦ Shared “' + e.label + '” with ' + names.length + ' friend' + (names.length > 1 ? 's' : '') + (queued ? ' (' + queued + ' when they’re online)' : ''), 2800);
  }
  function logToVault(name, text, mine) {
    try { const mp = J().mp; mp.chatLog.push({ n: mine ? me() : name, to: mine ? name : me(), text, ts: Date.now(), me: !!mine, dm: true }); } catch (e) {}
  }

  // ── receiving ────────────────────────────────────────────────────────────
  window.addEventListener('jots:dm', (ev) => {
    const d = ev.detail || {}, b = d.body || {}, from = cleanName(d.from), k = keyOf(from);
    if (!k || k === keyOf(me())) return;
    if (seenBefore(k + ':' + (b.mid || d.ts))) return;
    switch (b.type) {
      case 'freq':
        if (isFriend(from)) { send(from, { type: 'facc' }); break; }      // already friends (their list was lost): just confirm
        if (S.sent[k]) { addFriend(from, d.kind); send(from, { type: 'facc' }); toast('✓ ' + from + ' is your friend now', 2400); break; }
        S.inbox[k] = { name: from, kind: d.kind, ts: Date.now() };
        toast('➕ ' + from + ' wants to be friends — open CHAT › FRIENDS', 3200);
        break;
      case 'facc':
        if (S.sent[k] || S.inbox[k] || isFriend(from)) { const was = isFriend(from); addFriend(from, d.kind); if (!was) toast('✓ ' + from + ' accepted — you’re friends', 2600); }
        break;
      case 'fdec': delete S.sent[k]; break;
      case 'unf': if (isFriend(from)) dropFriend(from); break;
      case 'msg': {
        if (!isFriend(from)) return;                                      // private chat is friends only
        const text = String(b.text || '').slice(0, 300); if (!text) return;
        pushMsg(from, { me: false, text, ts: d.ts });
        logToVault(from, text, false);
        if (!(ui.open && ui.tab === 'friends' && keyOf(ui.thread) === k)) { S.unread[k] = (S.unread[k] || 0) + 1; toast('💬 ' + from + ' (friend): ' + text.slice(0, 60), 2800); }
        break;
      }
      case 'mark': {
        if (!isFriend(from)) return;
        const e = b.entry; if (!e || !e.kind || !e.place) return;
        pushMsg(from, { me: false, text: 'Shared a marker: ' + String(e.label || 'Waypoint').slice(0, 48) + (b.note ? ' — ' + String(b.note).slice(0, 140) : ''), mark: e, ts: d.ts });
        if (!(ui.open && ui.tab === 'friends' && keyOf(ui.thread) === k)) S.unread[k] = (S.unread[k] || 0) + 1;
        toast('✦ ' + from + ' shared a marker: ' + String(e.label || 'Waypoint').slice(0, 40) + ' — add it from CHAT › FRIENDS', 3400);
        break;
      }
      default: return;
    }
    save();
  });
  function addMarkerToJournal(e, from) {
    if (!window.DMJournal) return false;
    const label = String(e.label || 'Waypoint').slice(0, 40) + (from ? ' · ' + from : '');
    const r = window.DMJournal.store.add(label.slice(0, 48), e.kind, e.place);
    toast(r ? '✦ Added to your Journal: ' + r.label : 'Couldn’t add it — your Journal may be full', 2400);
    return !!r;
  }

  // ── chat panel: WORLD | FRIENDS tabs ──────────────────────────────────────
  const ui = { built: false, tab: 'world', thread: null, open: false };
  function build() {
    if (ui.built) return;
    const chat = $('jots-chat'), log = $('jots-chat-log'), inp = $('jots-chat-in');
    if (!chat || !log || !inp) return;
    ui.built = true;
    const tabs = document.createElement('div'); tabs.className = 'fr-tabs'; tabs.id = 'fr-tabs';
    tabs.innerHTML = '<button type="button" data-t="world" class="on">WORLD</button><button type="button" data-t="friends">FRIENDS<span class="fr-badge" id="fr-badge"></span></button>';
    chat.insertBefore(tabs, chat.firstChild);
    const pane = document.createElement('div'); pane.id = 'fr-pane'; pane.className = 'fr-pane'; pane.style.display = 'none';
    chat.appendChild(pane);
    tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; setTab(b.dataset.t); });
    // the pane's own input mustn't fly the board
    pane.addEventListener('keydown', (e) => e.stopPropagation());
    pane.addEventListener('keyup', (e) => e.stopPropagation());
    // follow the panel being shown / hidden
    new MutationObserver(() => { ui.open = chat.style.display === 'flex'; if (ui.open) render(); }).observe(chat, { attributes: true, attributeFilter: ['style'] });
  }
  function setTab(t) {
    ui.tab = t;
    const tabs = $('fr-tabs'); if (!tabs) return;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    $('jots-chat-log').style.display = t === 'world' ? '' : 'none';
    $('jots-chat-in').style.display = t === 'world' ? '' : 'none';
    $('fr-pane').style.display = t === 'friends' ? '' : 'none';
    render();
  }
  function openThread(name) {
    build(); ui.thread = name;
    const chat = $('jots-chat'); if (chat && chat.style.display !== 'flex') chat.style.display = 'flex';
    setTab('friends');
    setTimeout(() => { const i = $('fr-in'); if (i) i.focus(); }, 30);
  }
  function openFriends() { build(); ui.thread = null; const chat = $('jots-chat'); if (chat) chat.style.display = 'flex'; setTab('friends'); }
  const fmtT = (t) => { try { return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  function render() {
    if (!ui.built) return;
    const unread = Object.values(S.unread).reduce((a, b) => a + b, 0) + Object.keys(S.inbox).length;
    const badge = $('fr-badge'); if (badge) { badge.textContent = unread ? String(unread) : ''; badge.style.display = unread ? '' : 'none'; }
    if (ui.tab !== 'friends') return;
    const pane = $('fr-pane'); if (!pane) return;
    const j = J(), online = !!(j && j.mp && j.mp.active);
    if (ui.thread) return renderThread(pane);
    let h = '';
    if (!online) h += '<div class="fr-note">Go online (🌐 chip) to see who’s here and chat with friends.</div>';
    const inb = Object.values(S.inbox);
    if (inb.length) {
      h += '<div class="fr-h">REQUESTS</div>';
      inb.forEach((r) => { h += '<div class="fr-row"><span class="fr-name">' + esc(r.name) + '</span><button class="fr-b fr-ok" data-acc="' + esc(r.name) + '">ACCEPT</button><button class="fr-b" data-dec="' + esc(r.name) + '">✕</button></div>'; });
    }
    const fr = Object.values(S.friends).sort((a, b) => (onlinePeer(b.name) ? 1 : 0) - (onlinePeer(a.name) ? 1 : 0) || a.name.localeCompare(b.name));
    h += '<div class="fr-h">FRIENDS · ' + fr.length + '</div>';
    if (!fr.length) h += '<div class="fr-note">No friends yet. Tap a pilot’s name tag in space (or + below) to add them.</div>';
    fr.forEach((f) => {
      const k = keyOf(f.name), on = !!onlinePeer(f.name), un = S.unread[k] || 0, q = (S.outbox[k] || []).length;
      h += '<div class="fr-row fr-friend" data-open="' + esc(f.name) + '"><span class="fr-dot' + (on ? ' on' : '') + '" title="' + (on ? 'Online' : 'Away') + '"></span><span class="fr-name">' + esc(f.name) + '</span>' +
        (un ? '<span class="fr-badge">' + un + '</span>' : '') + (q ? '<span class="fr-q" title="Waiting to send">⏳' + q + '</span>' : '') + '<span class="fr-go">💬</span></div>';
    });
    const sentL = Object.values(S.sent);
    if (sentL.length) { h += '<div class="fr-h">ASKED</div>'; sentL.forEach((r) => { h += '<div class="fr-row fr-dim"><span class="fr-name">' + esc(r.name) + '</span><span class="fr-q">waiting…</span><button class="fr-b" data-cancel="' + esc(r.name) + '">✕</button></div>'; }); }
    if (online) {
      const others = [...j.mp.peers.values()].filter((p) => p.n && !isFriend(p.n) && !S.sent[keyOf(p.n)] && !S.inbox[keyOf(p.n)]);
      if (others.length) {
        h += '<div class="fr-h">ONLINE NOW</div>';
        others.slice(0, 20).forEach((p) => { h += '<div class="fr-row"><span class="fr-dot on"></span><span class="fr-name">' + esc(p.n) + '</span><button class="fr-b fr-ok" data-add="' + esc(p.n) + '" data-kind="' + (p.k === 'h' ? 'github' : 'guest') + '">＋ ADD</button></div>'; });
      }
    }
    pane.innerHTML = h;
    pane.querySelectorAll('[data-acc]').forEach((b) => b.onclick = () => acceptRequest(b.dataset.acc));
    pane.querySelectorAll('[data-dec]').forEach((b) => b.onclick = () => declineRequest(b.dataset.dec));
    pane.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => requestFriend(b.dataset.add, b.dataset.kind));
    pane.querySelectorAll('[data-cancel]').forEach((b) => b.onclick = () => { delete S.sent[keyOf(b.dataset.cancel)]; save(); });
    pane.querySelectorAll('[data-open]').forEach((r) => r.onclick = () => openThread(r.dataset.open));
  }
  function renderThread(pane) {
    const name = ui.thread, k = keyOf(name);
    delete S.unread[k];
    const on = !!onlinePeer(name);
    const lines = S.msgs[k] || [];
    let h = '<div class="fr-th-head"><button class="fr-b" id="fr-back">‹ BACK</button><span class="fr-dot' + (on ? ' on' : '') + '"></span><span class="fr-name">' + esc(name) + '</span>' +
      '<button class="fr-b fr-un" id="fr-unf" title="Remove friend">REMOVE</button></div><div class="fr-log" id="fr-log">';
    if (!lines.length) h += '<div class="fr-note">Private chat with ' + esc(name) + '. Only the two of you see it here.</div>';
    lines.forEach((l, i) => {
      h += '<div class="fr-line' + (l.me ? ' me' : '') + '"><b>' + (l.me ? 'You' : esc(name)) + '</b> ' + esc(l.text) + (l.q ? ' <i class="fr-q">⏳</i>' : '') + '<span class="fr-t">' + fmtT(l.ts) + '</span>' +
        (l.mark && !l.me ? '<button class="fr-b fr-ok fr-addmk" data-mk="' + i + '">＋ ADD TO JOURNAL</button>' : '') + '</div>';
    });
    h += '</div><input id="fr-in" maxlength="300" autocomplete="off" placeholder="' + (on ? 'Message ' + esc(name) + '…' : esc(name) + ' is away — your message waits until they’re on') + '">';
    pane.innerHTML = h;
    const log = $('fr-log'); log.scrollTop = log.scrollHeight;
    $('fr-back').onclick = () => { ui.thread = null; render(); };
    const u = $('fr-unf'); u.onclick = () => { if (u.dataset.armed) { unfriend(name); return; } u.dataset.armed = '1'; u.textContent = 'SURE?'; setTimeout(() => { if (u.isConnected) { delete u.dataset.armed; u.textContent = 'REMOVE'; } }, 2500); };
    pane.querySelectorAll('[data-mk]').forEach((b) => b.onclick = () => { const l = lines[+b.dataset.mk]; if (l && l.mark && addMarkerToJournal(l.mark, name)) { b.disabled = true; b.textContent = '✓ IN JOURNAL'; } });
    const inp = $('fr-in');
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { sendText(name, inp.value); inp.value = ''; setTimeout(() => { const i = $('fr-in'); if (i) i.focus(); }, 0); }
      if (e.key === 'Escape') { inp.blur(); }
    });
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
  }
  // keep online dots fresh while the tab is up (but never while typing)
  setInterval(() => { if (ui.open && ui.tab === 'friends' && !(document.activeElement && document.activeElement.id === 'fr-in')) render(); }, 3000);
  window.addEventListener('jots:peers', () => { if (ui.open && ui.tab === 'friends' && !ui.thread) render(); });

  // ── tap a name tag → ADD FRIEND / MESSAGE ─────────────────────────────────
  let pop = null;
  function showTagPop(peer, x, y) {
    if (!pop) {
      pop = document.createElement('div'); pop.id = 'fr-tagpop'; pop.className = 'fr-tagpop';
      document.body.appendChild(pop);
      document.addEventListener('pointerdown', (e) => { if (pop.style.display !== 'none' && !pop.contains(e.target)) pop.style.display = 'none'; }, true);
    }
    const name = cleanName(peer.n), k = keyOf(name);
    const act = isFriend(name) ? '<button class="fr-b fr-ok" data-a="msg">💬 MESSAGE</button>'
      : S.sent[k] ? '<span class="fr-q">Request sent…</span>'
      : S.inbox[k] ? '<button class="fr-b fr-ok" data-a="acc">✓ ACCEPT FRIEND</button>'
      : '<button class="fr-b fr-ok" data-a="add">➕ ADD FRIEND</button>';
    pop.innerHTML = '<div class="fr-tp-name">' + esc(name) + (peer.k === 'h' ? ' <span class="fr-gh" title="Signed in with GitHub">⌥</span>' : '') + '</div>' + act;
    pop.style.display = 'block';
    const W = window.innerWidth, H = window.innerHeight;
    pop.style.left = Math.max(8, Math.min(W - 190, x - 80)) + 'px';
    pop.style.top = Math.max(8, Math.min(H - 90, y - 76)) + 'px';
    pop.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
      pop.style.display = 'none';
      if (b.dataset.a === 'add') requestFriend(name, peer.k === 'h' ? 'github' : 'guest');
      else if (b.dataset.a === 'acc') acceptRequest(name);
      else openThread(name);
    });
  }
  // a short tap (not a drag-look) on the 3D view, near a visible tag
  let down = null;
  document.addEventListener('pointerdown', (e) => { if (e.target && e.target.tagName === 'CANVAS') down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; }, true);
  document.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!d || d.id !== e.pointerId || !e.target || e.target.tagName !== 'CANVAS') return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 450) return;
    if (typeof window.jotsPickGhost !== 'function') return;
    let x = e.clientX, y = e.clientY;
    if (document.pointerLockElement) { x = window.innerWidth / 2; y = window.innerHeight / 2; }   // mouse-look: the crosshair
    const peer = window.jotsPickGhost(x, y);
    if (peer && peer.n) { if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (er) {} } showTagPop(peer, x, y); }
  }, true);

  // ── share picker: Journal marker → friends (multi-select) ─────────────────
  let pick = null;
  function openSharePicker(entry) {
    if (!entry) return;
    if (!pick) {
      pick = document.createElement('div'); pick.id = 'fr-share'; pick.className = 'fr-share';
      pick.innerHTML = '<div class="fr-sh-card dm-card"><div class="fr-sh-head"><span class="fr-sh-t">SHARE MARKER</span><button class="fr-b" id="fr-sh-x">✕</button></div>' +
        '<div class="fr-sh-lab" id="fr-sh-lab"></div><div class="fr-sh-list" id="fr-sh-list"></div>' +
        '<input id="fr-sh-note" maxlength="140" placeholder="Add a note (optional)" autocomplete="off">' +
        '<div class="fr-sh-foot"><button class="fr-b" id="fr-sh-all">ALL</button><button class="fr-b fr-ok" id="fr-sh-go" disabled>✦ SHARE</button></div></div>';
      document.body.appendChild(pick);
      pick.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closePick(); });
      pick.addEventListener('keyup', (e) => e.stopPropagation());
      pick.addEventListener('pointerdown', (e) => { if (e.target === pick) closePick(); });
      $('fr-sh-x').onclick = closePick;
    }
    const list = $('fr-sh-list'), fr = Object.values(S.friends).sort((a, b) => a.name.localeCompare(b.name));
    $('fr-sh-lab').textContent = '✦ ' + entry.label;
    $('fr-sh-note').value = '';
    list.innerHTML = fr.length ? fr.map((f) => '<label class="fr-sh-row"><input type="checkbox" value="' + esc(f.name) + '"><span class="fr-dot' + (onlinePeer(f.name) ? ' on' : '') + '"></span><span>' + esc(f.name) + '</span></label>').join('')
      : '<div class="fr-note">No friends yet. Go online, tap a pilot’s name tag and ADD FRIEND — then share markers with them here.</div>';
    const go = $('fr-sh-go');
    const sel = () => [...list.querySelectorAll('input:checked')].map((i) => i.value);
    list.onchange = () => { const n = sel().length; go.disabled = !n; go.textContent = n ? '✦ SHARE WITH ' + n : '✦ SHARE'; };
    $('fr-sh-all').onclick = () => { const all = list.querySelectorAll('input'); const on = [...all].some((i) => !i.checked); all.forEach((i) => i.checked = on); list.onchange(); };
    go.disabled = true; go.textContent = '✦ SHARE';
    go.onclick = () => { const names = sel(); if (!names.length) return; shareMarker(entry, names, $('fr-sh-note').value); closePick(); };
    pick.classList.add('open');
  }
  function closePick() { if (pick) pick.classList.remove('open'); }

  function init() {
    build();
    if (window.DMJournal && window.DMJournal.init) window.DMJournal.init({ share: openSharePicker });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0)); else setTimeout(init, 0);

  window.DMFriends = { request: requestFriend, accept: acceptRequest, unfriend, sendText, shareMarker, openSharePicker, openFriends, openThread, isFriend, list: () => Object.values(S.friends), _state: () => S };
})();
