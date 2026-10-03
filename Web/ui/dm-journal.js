/* DART Meadow — the Journal: waypoints you set anywhere and travel back to.
 *
 * DMJournal.store   entries {id,label,kind:'space'|'atmo'|'surface',place,ts,updated}
 *                   kept per browser; merged with the account's journal.json,
 *                   save files and exported profiles (newer edits win,
 *                   deletions stick).
 * DMJournal.open()  the fold-out panel: mark this spot (with a label), search,
 *                   and the list — GO quick-travels to the exact spot.
 *
 * The game plugs in through DMJournal.init({here, go, describe}):
 *   here()        → {kind, place, title} of where the player is now, or null
 *   go(entry)     → travel there
 *   describe(e)   → one-line "where" text for an entry
 *   share(e)      → (ui/dm-friends.js) pick friends to send this waypoint to
 */
(function () {
  'use strict';
  const KEY = 'dm_journal_v1', MAX = 300;
  const ls = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} },
  };
  const lib = Object.assign({ entries: [], deleted: {} }, ls.get() || {});
  const newId = () => 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const cleanLabel = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 48);
  const KINDS = { space: 1, atmo: 1, surface: 1 };
  function cleanEntry(e) {
    if (!e || typeof e !== 'object' || !KINDS[e.kind] || !e.place || typeof e.place !== 'object') return null;
    const id = /^w_[a-z0-9]{4,24}$/.test(String(e.id || '')) ? e.id : newId();
    let place;
    try { place = JSON.parse(JSON.stringify(e.place)); } catch (x) { return null; }
    if (JSON.stringify(place).length > 4000) return null;
    return { id, label: cleanLabel(e.label) || 'Waypoint', kind: e.kind, place, ts: +e.ts || Date.now(), updated: +e.updated || +e.ts || Date.now(), hidden: !!e.hidden };
  }
  function persist(source) {
    ls.set(lib);
    try { window.dispatchEvent(new CustomEvent('dm:journal', { detail: { source: source || 'local' } })); } catch (e) {}
    if (ui.root && ui.root.classList.contains('open')) render();
  }
  const find = (id) => lib.entries.find((e) => e.id === id);

  const store = {
    get entries() { return lib.entries.slice().sort((a, b) => b.ts - a.ts); },
    add(label, kind, place) {
      if (lib.entries.length >= MAX) return null;
      const e = cleanEntry({ label, kind, place, ts: Date.now() });
      if (!e) return null;
      lib.entries.push(e); persist(); return e;
    },
    rename(id, label) { const e = find(id); if (!e) return false; e.label = cleanLabel(label) || e.label; e.updated = Date.now(); persist(); return true; },
    // hide or show a waypoint's marker in the world (it stays in the Journal)
    setHidden(id, h) { const e = find(id); if (!e) return false; e.hidden = !!h; e.updated = Date.now(); persist(); return true; },
    remove(id) { if (!find(id)) return false; lib.entries = lib.entries.filter((e) => e.id !== id); lib.deleted[id] = Date.now(); persist(); return true; },
    exportData() { return { kind: 'dartmeadow-journal', v: 1, entries: lib.entries.slice(), deleted: Object.assign({}, lib.deleted) }; },
    // merge from the account, a save or a file: newer edits win, deletions stick
    importData(d, source) {
      if (!d || typeof d !== 'object') return 0;
      if (d.journal && !d.entries) d = d.journal;
      let n = 0;
      const del = d.deleted && typeof d.deleted === 'object' ? d.deleted : {};
      Object.keys(del).forEach((id) => {
        if (!/^w_[a-z0-9]{4,24}$/.test(id)) return;
        const when = +del[id] || 0;
        if (when > (lib.deleted[id] || 0)) lib.deleted[id] = when;
        const e = find(id); if (e && e.updated <= when) { lib.entries = lib.entries.filter((x) => x.id !== id); n++; }
      });
      (Array.isArray(d.entries) ? d.entries : []).forEach((raw) => {
        const e = cleanEntry(raw); if (!e) return;
        if ((lib.deleted[e.id] || 0) >= e.updated) return;
        const have = find(e.id);
        if (have) { if (e.updated > have.updated) { Object.assign(have, e); n++; } }
        else if (lib.entries.length < MAX) { lib.entries.push(e); n++; }
      });
      persist(source || 'import');
      return n;
    },
  };

  // ── panel ──────────────────────────────────────────────────────────────
  const ui = { root: null, hooks: {}, filter: '', renaming: null };
  const ICON = { space: '✦', atmo: '☁', surface: '⛰' };
  // open eye = marker shown; shut eye with a slash = hidden
  const EYE = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M2 12s3.6 5 10 5 10-5 10-5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 15.5l-1.6 2M9 16.8l-.8 2.3M15 16.8l.8 2.3M19 15.5l1.6 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const KIND_NAME = { space: 'SPACE', atmo: 'SKY', surface: 'GROUND' };
  // share: a node with two branches (send this waypoint to friends)
  const SHARE = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="18" cy="5.5" r="2.6" fill="currentColor"/><circle cx="6" cy="12" r="2.6" fill="currentColor"/><circle cx="18" cy="18.5" r="2.6" fill="currentColor"/><path d="M8.3 10.8l7.4-4.1M8.3 13.2l7.4 4.1" stroke="currentColor" stroke-width="1.8"/></svg>';
  // the Journal's mark: a kite-shaped cover with a compass star over open pages
  const LOGO = '<svg class="jn-logo" viewBox="0 0 64 64" aria-hidden="true"><defs>' +
    '<linearGradient id="jn-g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" class="jn-s1"/><stop offset=".55" class="jn-s2"/><stop offset="1" class="jn-s3"/></linearGradient>' +
    '<radialGradient id="jn-r" cx=".5" cy=".46" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>' +
    '<path class="jn-kite" d="M4 31 L18 4 L62 30 L18 60 Z"/>' +
    '<path class="jn-page" d="M15 40 Q24 34 33 39 Q42 34 51 37 L51 42 Q42 39 33 44 Q24 39 15 45 Z"/>' +
    '<circle cx="32" cy="27" r="9" fill="url(#jn-r)" opacity=".35"/>' +
    '<path class="jn-star" d="M32 15 L34.2 25 L44 27 L34.2 29 L32 39 L29.8 29 L20 27 L29.8 25 Z"/>' +
    '<circle cx="32" cy="27" r="1.8" fill="#fff"/></svg>';
  const fmtDate = (t) => { try { const d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function build() {
    if (ui.root) return;
    const r = document.createElement('div');
    r.id = 'dm-journal'; r.setAttribute('role', 'dialog'); r.setAttribute('aria-label', 'Journal');
    r.innerHTML =
      '<div class="jn-panel dm-card">' +
        '<div class="jn-head">' + LOGO +
          '<div class="jn-title"><div class="jn-t1">JOURNAL</div><div class="jn-t2" id="jn-count">WAYPOINTS</div></div>' +
          '<button class="jn-x" id="jn-close" title="Close (J)">✕</button></div>' +
        '<div class="jn-here" id="jn-here"></div>' +
        '<div class="jn-mark"><input id="jn-label" maxlength="48" placeholder="Name this spot…" autocomplete="off" spellcheck="false">' +
          '<button class="jn-btn jn-go" id="jn-add">＋ MARK</button></div>' +
        '<div class="jn-search"><input id="jn-find" placeholder="Search your waypoints" autocomplete="off" spellcheck="false"></div>' +
        '<div class="jn-list" id="jn-list"></div>' +
        '<div class="jn-foot" id="jn-foot"></div>' +
      '</div>';
    document.body.appendChild(r);
    ui.root = r;
    const $ = (id) => r.querySelector('#' + id);
    const stop = (e) => e.stopPropagation();
    ['jn-label', 'jn-find'].forEach((id) => { $(id).addEventListener('keydown', stop); $(id).addEventListener('keyup', stop); });
    $('jn-close').onclick = close;
    $('jn-find').oninput = (e) => { ui.filter = e.target.value.trim().toLowerCase(); render(); };
    const mark = () => {
      const lab = $('jn-label');
      if (ui.renaming) {
        store.rename(ui.renaming, lab.value || ''); ui.renaming = null; lab.value = ''; $('jn-add').textContent = '＋ MARK'; render(); return;
      }
      const h = ui.hooks.here && ui.hooks.here();
      if (!h) { toast('Nothing to mark here yet'); return; }
      const e = store.add(lab.value.trim() || h.title || 'Waypoint', h.kind, h.place);
      if (!e) { toast('Journal is full — delete a waypoint first'); return; }
      lab.value = ''; toast('✦ Marked: ' + e.label);
      render();
    };
    $('jn-add').onclick = mark;
    $('jn-label').addEventListener('keydown', (e) => { if (e.key === 'Enter') mark(); if (e.key === 'Escape') close(); });
    r.addEventListener('pointerdown', (e) => { if (e.target === r) close(); });
  }
  function toast(m) { try { if (window.toast) window.toast(m, 2000); } catch (e) {} }

  function refreshHere() {
    if (!ui.root) return;
    const $ = (id) => ui.root.querySelector('#' + id);
    const h = ui.hooks.here && ui.hooks.here();
    const html = h ? '<span class="jn-dot jn-' + h.kind + '">' + ICON[h.kind] + '</span><span>You are here: <b>' + esc(h.title || '') + '</b></span>'
      : '<span class="jn-dim">Enter the game to mark a spot.</span>';
    if ($('jn-here').innerHTML !== html) $('jn-here').innerHTML = html;
    $('jn-add').disabled = !h && !ui.renaming;
    if (!ui.renaming) $('jn-label').placeholder = h ? 'Name this spot… (' + (h.title || '') + ')' : 'Name this spot…';
  }
  function render() {
    if (!ui.root) return;
    const $ = (id) => ui.root.querySelector('#' + id);
    refreshHere();
    const all = store.entries, f = ui.filter;
    const list = f ? all.filter((e) => (e.label + ' ' + (ui.hooks.describe ? ui.hooks.describe(e) : '')).toLowerCase().includes(f)) : all;
    $('jn-count').textContent = 'WAYPOINTS · ' + all.length;
    const L = $('jn-list'); L.textContent = '';
    if (!list.length) {
      const d = document.createElement('div'); d.className = 'jn-empty';
      d.textContent = all.length ? 'No waypoints match “' + f + '”.' : 'No waypoints yet. Name this spot and tap MARK — you can come back here any time.';
      L.appendChild(d);
    }
    list.forEach((e) => {
      const row = document.createElement('div'); row.className = 'jn-row jn-k-' + e.kind;
      row.innerHTML = '<span class="jn-dot jn-' + e.kind + '" title="' + KIND_NAME[e.kind] + '">' + ICON[e.kind] + '</span>' +
        '<div class="jn-main"><div class="jn-lab"></div><div class="jn-meta"></div></div>' +
        '<div class="jn-acts"><button class="jn-mini jn-eye' + (e.hidden ? ' off' : '') + '" title="' + (e.hidden ? 'Show this marker' : 'Hide this marker') + '" aria-pressed="' + (!e.hidden) + '">' + (e.hidden ? EYE_OFF : EYE) + '</button><button class="jn-btn jn-go" title="Quick travel here">GO ▸</button><button class="jn-mini jn-share" title="Share with friends">' + SHARE + '</button><button class="jn-mini" title="Rename">✎</button><button class="jn-mini" title="Delete">✕</button></div>';
      row.querySelector('.jn-lab').textContent = e.label;
      row.querySelector('.jn-meta').textContent = (ui.hooks.describe ? ui.hooks.describe(e) : KIND_NAME[e.kind]) + ' · ' + fmtDate(e.ts);
      const [eye, go, shr, ren, del] = row.querySelectorAll('button');
      shr.onclick = () => { if (ui.hooks.share) ui.hooks.share(e); else toast('Sharing needs the multiplayer link — try again in a moment'); };
      if (e.hidden) row.classList.add('jn-hidden');
      eye.onclick = () => { store.setHidden(e.id, !e.hidden); toast((e.hidden ? 'Marker shown: ' : 'Marker hidden: ') + e.label); };
      go.onclick = () => { close(); try { ui.hooks.go && ui.hooks.go(e); } catch (x) { console.warn('[journal] go', x); } };
      ren.onclick = () => { ui.renaming = e.id; const lab = $('jn-label'); lab.value = e.label; lab.focus(); lab.select(); $('jn-add').textContent = '✎ RENAME'; $('jn-add').disabled = false; };
      del.onclick = () => {
        if (del.dataset.armed) { store.remove(e.id); toast('Waypoint deleted: ' + e.label); return; }
        del.dataset.armed = '1'; del.textContent = 'DEL?'; setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = '✕'; } }, 2500);
      };
      L.appendChild(row);
    });
    $('jn-foot').textContent = ui.hooks.syncNote ? ui.hooks.syncNote() : '';
  }
  function open() {
    build(); render();
    const r = ui.root;
    r.classList.remove('closing'); r.classList.add('open');
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('dm:journal-open')); } catch (e) {}
  }
  function close() {
    const r = ui.root; if (!r || !r.classList.contains('open')) return;
    r.classList.add('closing');
    setTimeout(() => { r.classList.remove('open', 'closing'); }, 380);
    ui.renaming = null;
  }
  const isOpen = () => !!(ui.root && ui.root.classList.contains('open') && !ui.root.classList.contains('closing'));
  function toggle() { isOpen() ? close() : open(); }

  window.DMJournal = { store, open, close, toggle, isOpen, render, refreshHere, init(h) { Object.assign(ui.hooks, h || {}); } };
})();
