/* DART Meadow — UI themes + colour picker
 *
 * DMTheme: preset themes, a custom theme and the player's own saved themes,
 * applied through the CSS variables the whole UI already uses (--cyan,
 * --gold, --acc-rgb …). Saved per browser; signed-in players' saved themes
 * also live in their account (see the JOTS block in index.html).
 *
 * DMColorPicker: a painter-style picker (hue ring + saturation/brightness
 * square, H/S/B sliders, hex, swatches, recent colours, eyedropper where the
 * browser has one). Every <input type="color"> in the page opens it instead
 * of the browser's basic picker, so the skyboard builder gets it too.
 */
(function () {
  'use strict';

  // ── colour helpers ───────────────────────────────────────────────────
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function hexToRgb(h) {
    h = String(h || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx];
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ── themes ───────────────────────────────────────────────────────────
  // acc = main accent (buttons, frames), hi = highlight (active/special),
  // panel = the dark base panels are tinted from.
  const PRESETS = [
    { id: 'nebula',   name: 'Sunset Nebula',  acc: '#5B7FFF', hi: '#FF4FA3', panel: '#000308' },
    { id: 'aurora',   name: 'Cyan Aurora',    acc: '#3FC8FF', hi: '#7CFFD0', panel: '#00060C' },
    { id: 'solar',    name: 'Solar Gold',     acc: '#FFB84D', hi: '#FF6A3C', panel: '#0A0602' },
    { id: 'emerald',  name: 'Emerald Grid',   acc: '#3CE6A0', hi: '#C4FF5A', panel: '#000806' },
    { id: 'crimson',  name: 'Crimson Pulse',  acc: '#FF5068', hi: '#FFAA50', panel: '#0A0204' },
    { id: 'violet',   name: 'Deep Violet',    acc: '#A57CFF', hi: '#FF7AE0', panel: '#05020C' },
    { id: 'mono',     name: 'Monochrome',     acc: '#C8D2E6', hi: '#FFFFFF', panel: '#040508' },
  ];
  const KEY = 'dm_theme_v1';
  const state = Object.assign({ id: 'nebula', ts: 0, custom: { acc: '#5B7FFF', hi: '#FF4FA3', panel: '#000308' } }, ls.get(KEY) || {});

  // The player's own themes: a named list they build from the custom colours.
  // Kept per browser, merged into their account (themes.json in their private
  // jots- repository) when signed in, carried in save files, and exportable
  // as a file. Deletions are remembered (with when) so a sync never brings a
  // deleted theme back.
  const LIB_KEY = 'dm_themes_saved_v1';
  const MAX_SAVED = 40;
  const lib = Object.assign({ saved: [], deleted: {} }, ls.get(LIB_KEY) || {});
  const cleanHex = (h) => { const rgb = hexToRgb(h); return rgb ? rgbToHex(...rgb).toUpperCase() : null; };
  function cleanTheme(t) {
    if (!t || typeof t !== 'object') return null;
    const acc = cleanHex(t.acc), hi = cleanHex(t.hi), panel = cleanHex(t.panel);
    if (!acc || !hi || !panel) return null;
    const id = /^u_[a-z0-9]{4,24}$/.test(String(t.id || '')) ? t.id : newId();
    const name = String(t.name || 'My theme').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || 'My theme';
    return { id, name, acc, hi, panel, ts: +t.ts || Date.now() };
  }
  function newId() { return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  const findSaved = (id) => lib.saved.find((t) => t.id === id);
  function persist(source) {
    ls.set(KEY, state); ls.set(LIB_KEY, lib);
    try { window.dispatchEvent(new CustomEvent('dm:themes', { detail: { source: source || 'local' } })); } catch (e) {}
  }

  function themeColors() {
    if (state.id === 'custom') return state.custom;
    return findSaved(state.id) || PRESETS.find((p) => p.id === state.id) || PRESETS[0];
  }
  function apply() {
    const t = themeColors();
    const acc = hexToRgb(t.acc) || [91, 127, 255];
    const hi = hexToRgb(t.hi) || [255, 79, 163];
    const panel = hexToRgb(t.panel) || [0, 3, 8];
    const pur = mix(acc, hi, 0.45).map((v) => v * 0.9);
    const text = mix([255, 255, 255], acc, 0.1);
    const c = (a) => a.map(Math.round).join(',');
    const r = document.documentElement.style;
    r.setProperty('--acc-rgb', c(acc));
    r.setProperty('--hi-rgb', c(hi));
    r.setProperty('--pur-rgb', c(pur));
    r.setProperty('--panel-rgb', c(panel));
    r.setProperty('--cyan', rgbToHex(...acc));
    r.setProperty('--gold', rgbToHex(...hi));
    r.setProperty('--purple', rgbToHex(...pur));
    r.setProperty('--text', rgbToHex(...text));
    r.setProperty('--text-dim', 'rgba(' + c(text) + ',0.5)');
    r.setProperty('--dim-cyan', 'rgba(' + c(acc) + ',0.14)');
    r.setProperty('--dim-gold', 'rgba(' + c(hi) + ',0.14)');
    r.setProperty('--border', 'rgba(' + c(acc) + ',0.22)');
    r.setProperty('--border2', 'rgba(' + c(acc) + ',0.08)');
    r.setProperty('--glow-sm', '0 0 8px rgba(' + c(acc) + ',0.55)');
    r.setProperty('--glow-md', '0 0 18px rgba(' + c(pur) + ',0.5)');
    try { window.dispatchEvent(new CustomEvent('dm:theme', { detail: { id: state.id, colors: t } })); } catch (e) {}
  }
  const known = (id) => id === 'custom' || PRESETS.some((p) => p.id === id) || !!findSaved(id);
  const DMTheme = {
    presets: PRESETS,
    get id() { return state.id; },
    get custom() { return Object.assign({}, state.custom); },
    get saved() { return lib.saved.map((t) => Object.assign({}, t)); },
    maxSaved: MAX_SAVED,
    colors: themeColors,
    use(id) { state.id = known(id) ? id : 'nebula'; state.ts = Date.now(); persist(); apply(); },
    setCustom(part) {
      Object.assign(state.custom, part);
      state.id = 'custom'; state.ts = Date.now(); persist(); apply();
    },
    // Save the colours on screen now as a new named theme and switch to it.
    saveCurrent(name) {
      if (lib.saved.length >= MAX_SAVED) return null;
      const c = themeColors();
      const t = cleanTheme({ name, acc: c.acc, hi: c.hi, panel: c.panel, ts: Date.now() });
      lib.saved.push(t);
      state.id = t.id; state.ts = Date.now(); persist(); apply();
      return Object.assign({}, t);
    },
    rename(id, name) {
      const t = findSaved(id); if (!t) return false;
      const c = cleanTheme(Object.assign({}, t, { name }));
      t.name = c.name; t.ts = Date.now(); persist(); return true;
    },
    remove(id) {
      const t = findSaved(id); if (!t) return false;
      lib.saved = lib.saved.filter((x) => x.id !== id);
      lib.deleted[id] = Date.now();
      if (state.id === id) { state.custom = { acc: t.acc, hi: t.hi, panel: t.panel }; state.id = 'custom'; state.ts = Date.now(); }
      persist(); apply(); return true;
    },
    // Everything about the player's themes, for their account, save files and export.
    exportData() {
      return { kind: 'dartmeadow-themes', v: 1, active: state.id, activeTs: state.ts || 0,
        custom: Object.assign({}, state.custom), saved: this.saved, deleted: Object.assign({}, lib.deleted) };
    },
    // Merge themes from the account, a save or an imported file. Newer edits
    // win; deletions stick. The active theme follows whichever side chose
    // more recently. Returns how many themes were added or updated.
    importData(data, source) {
      if (!data || typeof data !== 'object') return 0;
      if (data.themes && !data.saved) data = data.themes;          // a whole save file
      let n = 0;
      const del = data.deleted && typeof data.deleted === 'object' ? data.deleted : {};
      Object.keys(del).forEach((id) => {
        if (!/^u_[a-z0-9]{4,24}$/.test(id)) return;
        const when = +del[id] || 0;
        if (when > (lib.deleted[id] || 0)) lib.deleted[id] = when;
        const t = findSaved(id);
        if (t && t.ts <= when) { lib.saved = lib.saved.filter((x) => x.id !== id); n++; if (state.id === id) { state.custom = { acc: t.acc, hi: t.hi, panel: t.panel }; state.id = 'custom'; } }
      });
      (Array.isArray(data.saved) ? data.saved : []).forEach((raw) => {
        const t = cleanTheme(raw); if (!t) return;
        if ((lib.deleted[t.id] || 0) >= t.ts) return;
        const have = findSaved(t.id);
        if (have) { if (t.ts > have.ts) { Object.assign(have, t); n++; } }
        else if (lib.saved.length < MAX_SAVED) { lib.saved.push(t); n++; }
      });
      if (source !== 'file' && (+data.activeTs || 0) > (state.ts || 0)) {
        const cu = data.custom && cleanTheme(Object.assign({ name: 'c' }, data.custom));
        if (cu) state.custom = { acc: cu.acc, hi: cu.hi, panel: cu.panel };
        if (known(data.active)) { state.id = data.active; state.ts = +data.activeTs; }
      }
      if (!known(state.id)) state.id = 'custom';
      persist(source || 'import'); apply();
      return n;
    },
    apply,
    hexToRgb, rgbToHex,
  };
  window.DMTheme = DMTheme;
  apply();

  // ── colour picker ────────────────────────────────────────────────────
  const SWATCHES = ['#FFFFFF', '#C8D2E6', '#7A849A', '#1B2233', '#000000', '#FF3860', '#FF6B3D', '#FFB84D',
    '#F5E663', '#8FF0B8', '#3CE6A0', '#00E0A0', '#3FC8FF', '#5B7FFF', '#A57CFF', '#FF4FA3'];
  const RECENT_KEY = 'dm_recent_colors_v1';
  let pk = null;   // the one picker instance

  function css() {
    if (document.getElementById('dmcp-css')) return;
    const st = document.createElement('style'); st.id = 'dmcp-css';
    st.textContent = `
#dmcp{position:fixed;inset:0;z-index:9500;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);padding:16px;}
#dmcp.open{display:flex;}
#dmcp .cp{width:min(340px,100%);max-height:92vh;overflow-y:auto;background:rgba(var(--panel-rgb,0,3,8),.97);border:1px solid rgba(var(--acc-rgb,91,127,255),.35);
  border-radius:8px;padding:14px;color:var(--text,#E8DFFF);font-family:var(--font-body,sans-serif);box-shadow:0 0 30px rgba(var(--acc-rgb,91,127,255),.18);
  clip-path:polygon(14px 0,100% 0,100% calc(100% - 14px),calc(100% - 14px) 100%,0 100%,0 14px);}
#dmcp .cp-t{font-family:var(--font-hud,monospace);font-size:.6rem;letter-spacing:.18em;color:var(--cyan,#5B7FFF);margin-bottom:10px;}
#dmcp canvas{display:block;margin:0 auto;touch-action:none;cursor:crosshair;}
#dmcp .cp-row{display:flex;align-items:center;gap:8px;margin-top:9px;}
#dmcp .cp-l{width:14px;font-family:var(--font-hud,monospace);font-size:.55rem;color:var(--text-dim,#aaa);}
#dmcp input[type=range]{flex:1;-webkit-appearance:none;appearance:none;height:12px;border-radius:6px;border:1px solid rgba(255,255,255,.15);outline:none;}
#dmcp input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid #000;box-shadow:0 0 0 1px #fff;}
#dmcp input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid #000;}
#dmcp .cp-n{width:38px;text-align:right;font-family:var(--font-mono,monospace);font-size:.62rem;color:var(--text-dim,#aaa);}
#dmcp .cp-cmp{display:flex;height:34px;flex:0 0 96px;border-radius:4px;overflow:hidden;border:1px solid rgba(255,255,255,.18);}
#dmcp .cp-cmp div{flex:1;cursor:pointer;}
#dmcp .cp-hex{flex:1;min-width:0;background:rgba(0,0,0,.4);border:1px solid rgba(var(--acc-rgb,91,127,255),.35);color:var(--text,#fff);border-radius:3px;padding:7px 8px;font-family:var(--font-mono,monospace);font-size:.8rem;text-transform:uppercase;}
#dmcp .cp-sw{display:grid;grid-template-columns:repeat(8,1fr);gap:5px;margin-top:10px;}
#dmcp .cp-sw button{aspect-ratio:1;border-radius:4px;border:1px solid rgba(255,255,255,.18);cursor:pointer;padding:0;}
#dmcp .cp-sw button:hover{transform:scale(1.12);}
#dmcp .cp-sub{font-family:var(--font-hud,monospace);font-size:.48rem;letter-spacing:.16em;color:var(--text-dim,#aaa);margin-top:10px;}
#dmcp .cp-btns{display:flex;gap:8px;margin-top:12px;}
#dmcp .cp-btns button{flex:1;padding:9px;border-radius:3px;cursor:pointer;font-family:var(--font-hud,monospace);font-size:.55rem;letter-spacing:.14em;
  border:1px solid rgba(var(--acc-rgb,91,127,255),.45);background:rgba(var(--acc-rgb,91,127,255),.1);color:var(--cyan,#5B7FFF);}
#dmcp .cp-btns .ok{border-color:rgba(120,230,170,.6);background:rgba(90,220,150,.14);color:#8ff0b8;}
#dmcp .cp-eye{flex:0 0 auto;width:34px;height:34px;border-radius:4px;border:1px solid rgba(var(--acc-rgb,91,127,255),.4);background:rgba(var(--acc-rgb,91,127,255),.08);color:var(--cyan,#5B7FFF);cursor:pointer;font-size:.9rem;}
input[type=color]{-webkit-appearance:none;appearance:none;border:1px solid rgba(var(--acc-rgb,91,127,255),.45);border-radius:4px;padding:2px;background:transparent;cursor:pointer;min-width:30px;min-height:24px;}
input[type=color]::-webkit-color-swatch-wrapper{padding:0;}
input[type=color]::-webkit-color-swatch{border:none;border-radius:3px;}
input[type=color]::-moz-color-swatch{border:none;border-radius:3px;}`;
    document.head.appendChild(st);
  }

  function build() {
    css();
    const root = document.createElement('div'); root.id = 'dmcp';
    root.innerHTML = `<div class="cp" role="dialog" aria-modal="true" aria-label="Colour picker">
      <div class="cp-t" id="dmcp-title">COLOUR</div>
      <canvas id="dmcp-wheel" width="236" height="236"></canvas>
      <div class="cp-row"><span class="cp-l">H</span><input type="range" id="dmcp-h" min="0" max="360" step="1"><span class="cp-n" id="dmcp-hn"></span></div>
      <div class="cp-row"><span class="cp-l">S</span><input type="range" id="dmcp-s" min="0" max="100" step="1"><span class="cp-n" id="dmcp-sn"></span></div>
      <div class="cp-row"><span class="cp-l">B</span><input type="range" id="dmcp-v" min="0" max="100" step="1"><span class="cp-n" id="dmcp-vn"></span></div>
      <div class="cp-row">
        <div class="cp-cmp" title="Before / after — tap the left side to go back"><div id="dmcp-old"></div><div id="dmcp-new"></div></div>
        <input class="cp-hex" id="dmcp-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Hex colour">
        <button class="cp-eye" id="dmcp-eye" title="Pick a colour from the screen">⌖</button>
      </div>
      <div class="cp-sub">SWATCHES</div><div class="cp-sw" id="dmcp-sw"></div>
      <div class="cp-sub" id="dmcp-rt">RECENT</div><div class="cp-sw" id="dmcp-rc"></div>
      <div class="cp-btns"><button id="dmcp-cancel">CANCEL</button><button class="ok" id="dmcp-ok">APPLY</button></div>
    </div>`;
    document.body.appendChild(root);
    const $ = (id) => document.getElementById(id);
    const cv = $('dmcp-wheel'), g = cv.getContext('2d');
    const W = cv.width, C = W / 2, RO = W / 2 - 4, RI = RO - 20, SQ = Math.floor(RI * 1.28), SX = C - SQ / 2;
    // hue ring drawn once into an offscreen canvas
    const ring = document.createElement('canvas'); ring.width = ring.height = W;
    { const rg = ring.getContext('2d');
      for (let a = 0; a < 360; a += 0.5) {
        const a0 = (a - 90.6) * Math.PI / 180, a1 = (a - 89.4) * Math.PI / 180;
        rg.beginPath(); rg.arc(C, C, RO, a0, a1); rg.arc(C, C, RI, a1, a0, true); rg.closePath();
        rg.fillStyle = 'hsl(' + a + ',100%,50%)'; rg.fill();
      } }
    const P = { root, cv, g, h: 0, s: 1, v: 1, old: '#ffffff', opts: null, drag: null };
    function draw() {
      g.clearRect(0, 0, W, W);
      g.drawImage(ring, 0, 0);
      const hue = rgbToHex(...hsvToRgb(P.h, 1, 1));
      g.fillStyle = hue; g.fillRect(SX, SX, SQ, SQ);
      let gr = g.createLinearGradient(SX, 0, SX + SQ, 0); gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(SX, SX, SQ, SQ);
      gr = g.createLinearGradient(0, SX, 0, SX + SQ); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, '#000');
      g.fillStyle = gr; g.fillRect(SX, SX, SQ, SQ);
      // ring marker
      const a = (P.h - 90) * Math.PI / 180, rm = (RO + RI) / 2;
      g.lineWidth = 3; g.strokeStyle = '#fff'; g.beginPath(); g.arc(C + Math.cos(a) * rm, C + Math.sin(a) * rm, 9, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = '#000'; g.beginPath(); g.arc(C + Math.cos(a) * rm, C + Math.sin(a) * rm, 10.5, 0, Math.PI * 2); g.stroke();
      // square marker
      const mx = SX + P.s * SQ, my = SX + (1 - P.v) * SQ;
      g.lineWidth = 2.5; g.strokeStyle = P.v > 0.55 && P.s < 0.5 ? '#000' : '#fff'; g.beginPath(); g.arc(mx, my, 7, 0, Math.PI * 2); g.stroke();
    }
    function hex() { return rgbToHex(...hsvToRgb(P.h, P.s, P.v)); }
    function sync(fromHex) {
      const h = hex();
      $('dmcp-h').value = Math.round(P.h); $('dmcp-s').value = Math.round(P.s * 100); $('dmcp-v').value = Math.round(P.v * 100);
      $('dmcp-hn').textContent = Math.round(P.h) + '°'; $('dmcp-sn').textContent = Math.round(P.s * 100) + '%'; $('dmcp-vn').textContent = Math.round(P.v * 100) + '%';
      const full = rgbToHex(...hsvToRgb(P.h, 1, 1)), grey = rgbToHex(...hsvToRgb(P.h, 0, P.v)), bright = rgbToHex(...hsvToRgb(P.h, P.s, 1));
      $('dmcp-h').style.background = 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)';
      $('dmcp-s').style.background = 'linear-gradient(90deg,' + grey + ',' + rgbToHex(...hsvToRgb(P.h, 1, P.v)) + ')';
      $('dmcp-v').style.background = 'linear-gradient(90deg,#000,' + bright + ')';
      void full;
      $('dmcp-new').style.background = h;
      if (!fromHex) $('dmcp-hex').value = h.toUpperCase();
      draw();
      if (P.opts && P.opts.onChange) { try { P.opts.onChange(h); } catch (e) {} }
    }
    P.setHex = (hx, fromHex) => {
      const rgb = hexToRgb(hx); if (!rgb) return false;
      const [h, s, v] = rgbToHsv(...rgb);
      if (s > 0.001 && v > 0.001) P.h = h;
      P.s = s; P.v = v; sync(fromHex); return true;
    };
    function pick(e, start) {
      const r = cv.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width, y = (e.clientY - r.top) * W / r.height;
      const dx = x - C, dy = y - C, d = Math.hypot(dx, dy);
      if (start) P.drag = (x >= SX - 4 && x <= SX + SQ + 4 && y >= SX - 4 && y <= SX + SQ + 4) ? 'sq' : (d >= RI - 6 && d <= RO + 6 ? 'ring' : null);
      if (P.drag === 'ring') { P.h = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360; sync(); }
      else if (P.drag === 'sq') { P.s = clamp((x - SX) / SQ, 0, 1); P.v = clamp(1 - (y - SX) / SQ, 0, 1); sync(); }
    }
    cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pick(e, true); });
    cv.addEventListener('pointermove', (e) => { if (P.drag) pick(e, false); });
    cv.addEventListener('pointerup', () => { P.drag = null; });
    cv.addEventListener('pointercancel', () => { P.drag = null; });
    $('dmcp-h').oninput = (e) => { P.h = +e.target.value; sync(); };
    $('dmcp-s').oninput = (e) => { P.s = e.target.value / 100; sync(); };
    $('dmcp-v').oninput = (e) => { P.v = e.target.value / 100; sync(); };
    $('dmcp-hex').oninput = (e) => { let v = e.target.value.trim(); if (v && v[0] !== '#') v = '#' + v; if (/^#[0-9a-f]{6}$/i.test(v)) P.setHex(v, true); };
    $('dmcp-hex').onblur = () => { $('dmcp-hex').value = hex().toUpperCase(); };
    $('dmcp-old').onclick = () => P.setHex(P.old);
    const eye = $('dmcp-eye');
    if (!window.EyeDropper) eye.style.display = 'none';
    else eye.onclick = async () => { try { const r = await new window.EyeDropper().open(); if (r && r.sRGBHex) P.setHex(r.sRGBHex); } catch (e) {} };
    const sw = $('dmcp-sw');
    SWATCHES.forEach((c) => { const b = document.createElement('button'); b.style.background = c; b.title = c; b.onclick = () => P.setHex(c); sw.appendChild(b); });
    P.renderRecent = () => {
      const rc = $('dmcp-rc'); rc.textContent = '';
      const list = ls.get(RECENT_KEY) || [];
      $('dmcp-rt').style.display = rc.style.display = list.length ? '' : 'none';
      list.forEach((c) => { const b = document.createElement('button'); b.style.background = c; b.title = c; b.onclick = () => P.setHex(c); rc.appendChild(b); });
    };
    const close = (ok) => {
      root.classList.remove('open');
      const o = P.opts; P.opts = null;
      if (!o) return;
      if (ok) {
        const h = hex();
        const list = (ls.get(RECENT_KEY) || []).filter((c) => c.toLowerCase() !== h.toLowerCase());
        list.unshift(h); ls.set(RECENT_KEY, list.slice(0, 8));
        if (o.onDone) try { o.onDone(h); } catch (e) {}
      } else if (o.onCancel) try { o.onCancel(P.old); } catch (e) {}
    };
    $('dmcp-ok').onclick = () => close(true);
    $('dmcp-cancel').onclick = () => close(false);
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close(false); });
    document.addEventListener('keydown', (e) => {
      if (!root.classList.contains('open')) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      if (e.key === 'Enter' && e.target && e.target.id === 'dmcp-hex') close(true);
    }, true);
    return P;
  }

  const DMColorPicker = {
    // opts: {color, title, onChange(hex), onDone(hex), onCancel(originalHex)}
    open(opts) {
      if (!pk) pk = build();
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
      pk.opts = null;   // no callbacks while seeding
      pk.old = hexToRgb(opts.color) ? rgbToHex(...hexToRgb(opts.color)) : '#ffffff';
      document.getElementById('dmcp-title').textContent = (opts.title || 'Colour').toUpperCase();
      document.getElementById('dmcp-old').style.background = pk.old;
      pk.setHex(pk.old);
      pk.opts = opts;
      pk.renderRecent();
      pk.root.classList.add('open');
    },
  };
  window.DMColorPicker = DMColorPicker;

  // Every native colour input opens this picker instead (skyboard builder
  // hull/emissive/decal colours, part gradient stops, …). The input keeps
  // its value and fires the usual input/change events, so existing
  // handlers work unchanged.
  document.addEventListener('click', (e) => {
    const inp = e.target;
    if (!inp || inp.tagName !== 'INPUT' || inp.type !== 'color' || inp.disabled || inp.dataset.nativePicker) return;
    e.preventDefault();
    const orig = inp.value;
    const fire = (type) => { try { inp.dispatchEvent(new Event(type, { bubbles: true })); } catch (err) {} };
    const lab = inp.closest('.ctrl-row') && inp.closest('.ctrl-row').querySelector('label');
    DMColorPicker.open({
      color: orig,
      title: inp.getAttribute('aria-label') || (lab && lab.textContent) || 'Colour',
      onChange: (h) => { inp.value = h; fire('input'); },
      onDone: (h) => { inp.value = h; fire('input'); fire('change'); },
      onCancel: () => { inp.value = orig; fire('input'); },
    });
  }, true);
  css();
})();
