/*
 * DART Meadow iOS app bridge — injected at document end by the native shell
 * (App/GameViewController.swift). The game files in Web/ are an untouched
 * mirror of dartmeadow-space; everything app-specific lives here:
 *
 *   • window.DMNative.call(cmd, args) → native (Promise)
 *   • window.open → in-app Safari sheet (GitHub device sign-in, links),
 *     with a handle whose .close() closes that sheet like the web tab
 *   • clipboard writes go through UIPasteboard (sign-in code copy)
 *   • Sign in with Apple: buttons on the welcome card and the account modal,
 *     a pilot identity in the game's JOTS identity, credential checks on
 *     launch and when Apple revokes it
 */
try { (function () {
  'use strict';
  if (window.__dmIOSBridge) return;
  window.__dmIOSBridge = true;

  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dmNative;
  const DMNative = window.DMNative = {
    isApp: true,
    info: window.DM_IOS_APP || {},
    call(cmd, args) {
      if (!handler) return Promise.reject(new Error('native bridge unavailable'));
      return handler.postMessage(Object.assign({ cmd }, args || {}));
    },
  };
  document.documentElement.classList.add('dm-ios-app');
  try {
    const st = document.createElement('style');
    // the app is always full screen: the web's enter-fullscreen button has nothing to do
    st.textContent = '.dm-ios-app #fs-enter{display:none!important}';
    document.head.appendChild(st);
  } catch (e) {}

  // ── window.open → native Safari sheet ─────────────────────────────
  const origOpen = window.open;
  window.open = function (url, name, features) {
    let abs = '';
    try { abs = url ? new URL(String(url), location.href).href : ''; } catch (e) { abs = String(url || ''); }
    if (abs && !abs.startsWith(location.origin)) {
      DMNative.call('openExternal', { url: abs }).catch(() => {});
      const handle = {
        closed: false, opener: null, name: name || '',
        close() { if (!this.closed) { this.closed = true; DMNative.call('closeExternal').catch(() => {}); } },
        focus() {}, blur() {}, postMessage() {},
        location: {},
      };
      Object.defineProperty(handle.location, 'href', {
        get() { return abs; },
        set(u) { abs = String(u); DMNative.call('openExternal', { url: abs }).catch(() => {}); },
      });
      handle.location.replace = (u) => { handle.location.href = u; };
      handle.location.assign = (u) => { handle.location.href = u; };
      window.addEventListener('dmnative:externalClosed', () => { handle.closed = true; }, { once: true });
      return handle;
    }
    return origOpen ? origOpen.apply(window, arguments) : null;
  };

  // ── Clipboard (works without the web's user-gesture rules) ──────────
  try {
    const clip = navigator.clipboard || {};
    const nativeWrite = (text) => DMNative.call('copy', { text: String(text) }).then(() => undefined);
    if (navigator.clipboard) navigator.clipboard.writeText = nativeWrite;
    else Object.defineProperty(navigator, 'clipboard', { value: Object.assign(clip, { writeText: nativeWrite }) });
  } catch (e) {}

  // ── Sign in with Apple ───────────────────────────────────────────────
  const APPLE_LS = 'dm_apple_v1';
  const ID_LS = 'jots_identity_v1';
  const $ = (id) => document.getElementById(id);
  const J = () => window.JOTS;
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const say = (msg, ms) => { try { if (typeof window.toast === 'function') window.toast(msg, ms || 2600); } catch (e) {} };

  function appleAccount() { return lsGet(APPLE_LS); }
  function appleActive() { const j = J(); return !!(j && j.identity && j.identity.kind === 'apple' && appleAccount()); }

  async function tagFor(user, given) {
    let buf = null;
    try { buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user)); } catch (e) { buf = null; }
    const hex = buf ? Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('') : Array.from(String(user)).reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7).toString(16).padStart(8, '0');
    const base = String(given || 'Pilot').normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').slice(0, 14) || 'Pilot';
    return base + '-' + hex.slice(0, 4).toUpperCase();
  }

  function adoptAppleIdentity(acct) {
    const j = J(); if (!j) return;
    if (j.auth.signedIn) return;          // GitHub sign-in (cloud saves) stays the primary identity
    j.identity.kind = 'apple';
    j.identity.name = acct.name;
    j.identity.avatar = '';
    lsSet(ID_LS, j.identity);
    try { window.dispatchEvent(new CustomEvent('jots:auth', { detail: { signedIn: false, apple: true, name: acct.name } })); } catch (e) {}
  }

  async function appleSignIn(fromWelcome) {
    const btns = document.querySelectorAll('.dm-apple-btn');
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await DMNative.call('appleSignIn');
      const prev = appleAccount();
      const acct = {
        user: r.user,
        name: (prev && prev.user === r.user && prev.name) || await tagFor(r.user, r.givenName),
        given: r.givenName || '', email: r.email || '',
        ts: Date.now(),
      };
      lsSet(APPLE_LS, acct);
      try { J().consent.agree(); } catch (e) {}
      adoptAppleIdentity(acct);
      try { $('jots-welcome').classList.remove('show'); } catch (e) {}
      try { if (typeof window.closeAccountModal === 'function') window.closeAccountModal(); } catch (e) {}
      say('✓ Signed in with Apple as ' + acct.name + (J() && J().auth.signedIn ? '' : ' · saves stay on this device (link GitHub for cloud saves)'), 3600);
      try { J().analytics && J().analytics.track && J().analytics.track('signin', 'apple'); } catch (e) {}
      refreshAppleUI();
      if (fromWelcome) { try { if (typeof STATE !== 'undefined' && STATE.screen !== 'flight' && typeof goScreen === 'function') goScreen('menu'); } catch (e) {} }
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg !== 'canceled') say('⚠ ' + msg, 4200);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
      syncWelcomeDisabled();
    }
  }

  function appleSignOut(silent) {
    localStorage.removeItem(APPLE_LS);
    DMNative.call('appleSignOut').catch(() => {});
    const j = J();
    if (j && j.identity.kind === 'apple') { try { j.auth.guest(); } catch (e) {} }
    if (!silent) say('Signed out of Apple · playing as ' + (j ? j.identity.name : 'guest'), 2600);
    refreshAppleUI();
  }

  function makeAppleButton(cls, label) {
    const b = document.createElement('button');
    b.className = cls + ' dm-apple-btn';
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'background:#fff;color:#000;border:1px solid #fff;font-weight:600;letter-spacing:.04em;';
    return b;
  }

  function syncWelcomeDisabled() {
    const agree = $('jots-agree'), b = $('dm-apple-welcome');
    if (agree && b) b.disabled = !agree.checked;
  }

  function installButtons() {
    // Welcome card: next to SIGN IN WITH GITHUB
    const gh = $('jots-gh-btn');
    if (gh && !$('dm-apple-welcome')) {
      const b = makeAppleButton('jots-btn', '\uF8FF  SIGN IN WITH APPLE');
      b.id = 'dm-apple-welcome';
      b.onclick = () => appleSignIn(true);
      gh.parentNode.insertBefore(b, gh.nextSibling);
      const agree = $('jots-agree');
      if (agree) agree.addEventListener('change', syncWelcomeDisabled);
      syncWelcomeDisabled();
    }
    // Account modal: the game's own (hidden on the web) Apple button, now native
    const a = $('acct-apple-btn');
    if (a && !a.dataset.dmNative) {
      a.dataset.dmNative = '1';
      a.classList.add('dm-apple-btn');
      a.textContent = '\uF8FF Sign in with Apple';
      a.style.cssText = 'background:#fff;color:#000;border:1px solid #fff;font-weight:600;';
      a.onclick = (ev) => { ev.preventDefault(); appleSignIn(false); };
    }
    if (a) a.style.display = '';
  }

  // Chip + account modal for an Apple pilot (the game's own refreshChip only knows GitHub/guest)
  function refreshAppleUI() {
    installButtons();
    const j = J(); if (!j) return;
    const chip = $('account-chip');
    const so = $('acct-signed-out'), si = $('acct-signed-in');
    let row = $('dm-apple-row');
    if (appleActive()) {
      const acct = appleAccount();
      if (chip) { chip.textContent = '\uF8FF ' + j.identity.name; }
      if (so && si) { so.style.display = 'block'; si.style.display = 'none'; }
      const a = $('acct-apple-btn'); if (a) a.style.display = 'none';
      if (so && !row) {
        row = document.createElement('div'); row.id = 'dm-apple-row';
        row.style.cssText = 'margin:.4rem 0 .8rem;font-size:.7rem;line-height:1.6;';
        so.insertBefore(row, so.firstChild.nextSibling);
      }
      if (row) {
        row.innerHTML = '';
        const t = document.createElement('div');
        t.textContent = '\uF8FF Signed in with Apple as ' + j.identity.name + (acct && acct.email ? ' (' + acct.email + ')' : '');
        const o = document.createElement('button'); o.className = 'btn'; o.textContent = 'SIGN OUT OF APPLE'; o.style.cssText = 'width:100%;margin-top:.4rem;';
        o.onclick = () => appleSignOut(false);
        const n = document.createElement('div'); n.className = 'acct-guest-note';
        n.textContent = 'Your pilot name and saves stay on this device. Sign in with GitHub below to sync saves to your private jots repository.';
        row.append(t, o, n);
      }
    } else if (row) {
      row.remove();
    }
  }

  function whenReady(fn, tries) {
    if (window.JOTS && $('acct-signed-out')) return fn();
    if ((tries || 0) > 200) return;
    setTimeout(() => whenReady(fn, (tries || 0) + 1), 150);
  }

  whenReady(() => {
    installButtons();
    // the game's patchAccountModal runs on load and hides the Apple button: re-apply after it
    setTimeout(refreshAppleUI, 600);
    setTimeout(refreshAppleUI, 2500);
    window.addEventListener('jots:auth', () => setTimeout(refreshAppleUI, 0));
    window.addEventListener('jots:vault', () => setTimeout(refreshAppleUI, 0));
    const origOpenAcct = window.openAccountModal;
    if (typeof origOpenAcct === 'function') {
      window.openAccountModal = function () { const r = origOpenAcct.apply(this, arguments); refreshAppleUI(); return r; };
    }
    const origSignOut = window.signOutOfAccount;
    window.signOutOfAccount = function () {
      if (appleActive()) return appleSignOut(false);
      return origSignOut && origSignOut.apply(this, arguments);
    };
    // Is the Apple sign-in still valid? (revoked in Settings ▸ Apple Account ▸ Sign in with Apple)
    const check = () => DMNative.call('appleState').then((s) => {
      if (appleAccount() && s && (s.state === 'revoked' || s.state === 'notFound')) {
        appleSignOut(true);
        say('Apple sign-in was turned off in Settings · playing as a guest', 3200);
      }
    }).catch(() => {});
    setTimeout(check, 3000);
    window.addEventListener('dmnative:active', check);
    window.addEventListener('dmnative:appleRevoked', check);
  });


  // ── Support: Apple in-app purchases (replaces the web's Stripe buttons) ──
  const IAP = { donation: 'com.dartmeadow.jots.support.donation', monthly: 'com.dartmeadow.jots.support.monthly' };
  const iapState = { products: null, status: { subscribed: false }, busy: false };
  const THANKS_LS = 'dm_support_thanks_v1';

  function iapEl(tag, css, text) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }

  function renderSupport(msg) {
    const box = $('dm-iap-container'); if (!box) return;
    box.innerHTML = '';
    const ps = iapState.products || [];
    const byId = {}; ps.forEach((p) => { byId[p.id] = p; });
    const thanks = lsGet(THANKS_LS) || { donations: 0 };
    if (iapState.status.subscribed) {
      box.appendChild(iapEl('div', 'font-family:var(--font-hud);font-size:.62rem;letter-spacing:.1em;color:var(--gold);line-height:1.6;',
        '✓ THANK YOU — YOU\'RE A MONTHLY ALPHA SUPPORTER' + (iapState.status.willRenew === false ? ' (ends ' + String(iapState.status.expires || '').slice(0, 10) + ')' : ' · RENEWS MONTHLY')));
    }
    if (thanks.donations > 0) {
      box.appendChild(iapEl('div', 'font-family:var(--font-mono);font-size:.6rem;color:var(--cyan);', '❤ Thank you for ' + thanks.donations + ' donation' + (thanks.donations === 1 ? '' : 's') + '!'));
    }
    const mk = (id, label, color) => {
      const p = byId[id];
      const b = iapEl('button', 'width:100%;padding:.8rem 1rem;background:rgba(var(--hi-rgb),.10);border:1px solid ' + color + ';color:' + color +
        ';font-family:var(--font-hud);font-size:.62rem;letter-spacing:.12em;cursor:pointer;border-radius:3px;');
      b.textContent = label + (p ? ' — ' + p.displayPrice + (p.type === 'subscription' ? ' / ' + (p.period || 'month') : '') : '');
      b.disabled = !p || iapState.busy || (id === IAP.monthly && iapState.status.subscribed);
      if (!p) b.style.opacity = '.5';
      b.onclick = () => buy(id);
      return b;
    };
    box.appendChild(mk(IAP.donation, '🌟 SUPPORT EARLY ALPHA', 'var(--gold)'));
    box.appendChild(iapEl('div', 'font-family:var(--font-mono);font-size:.54rem;color:var(--text-dim);margin-top:-.6rem;', 'One-time support for early alpha development · give again any time'));
    box.appendChild(mk(IAP.monthly, '☄ MONTHLY ALPHA SUPPORTER', 'var(--cyan)'));
    box.appendChild(iapEl('div', 'font-family:var(--font-mono);font-size:.54rem;color:var(--text-dim);margin-top:-.6rem;', 'Monthly support for early alpha development · renews automatically until you cancel'));
    const row = iapEl('div', 'display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;');
    const restore = iapEl('button', 'background:none;border:1px solid var(--border);color:var(--text-dim);font-family:var(--font-hud);font-size:.52rem;letter-spacing:.1em;padding:.45rem .9rem;border-radius:2px;cursor:pointer;', 'RESTORE PURCHASES');
    restore.onclick = doRestore;
    row.appendChild(restore);
    if (iapState.status.subscribed) {
      const manage = iapEl('button', restore.style.cssText, 'MANAGE SUBSCRIPTION');
      manage.onclick = () => DMNative.call('iapManage').catch(() => {});
      row.appendChild(manage);
    }
    box.appendChild(row);
    const legal = iapEl('div', 'font-family:var(--font-mono);font-size:.54rem;color:var(--text-dim);');
    const link = (t, u) => { const a = iapEl('a', 'color:var(--cyan);text-decoration:underline;cursor:pointer;', t); a.onclick = (ev) => { ev.preventDefault(); window.open(u, '_blank'); }; return a; };
    legal.append(link('Privacy Policy', 'https://dartmeadow.space/privacy.html'), document.createTextNode(' · '),
                 link('Terms of Use (EULA)', 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/'));
    box.appendChild(legal);
    if (!ps.length) box.appendChild(iapEl('div', 'font-family:var(--font-mono);font-size:.56rem;color:var(--text-dim);', msg || 'Loading prices from the App Store…'));
    else if (msg) box.appendChild(iapEl('div', 'font-family:var(--font-mono);font-size:.56rem;color:var(--text-dim);', msg));
  }

  async function loadIAP() {
    try { iapState.products = await DMNative.call('iapProducts'); } catch (e) { iapState.products = []; renderSupport('The App Store isn\'t reachable right now — try again in a moment.'); }
    try { iapState.status = await DMNative.call('iapStatus'); } catch (e) {}
    renderSupport(iapState.products && !iapState.products.length ? 'Support options aren\'t available in this build yet.' : '');
  }

  async function buy(id) {
    if (iapState.busy) return;
    iapState.busy = true; renderSupport('Opening the App Store…');
    try {
      const r = await DMNative.call('iapPurchase', { id });
      if (r.status === 'success') {
        if (id === IAP.donation) { const t = lsGet(THANKS_LS) || { donations: 0 }; t.donations++; t.last = Date.now(); lsSet(THANKS_LS, t); }
        iapState.status = Object.assign(iapState.status, r);
        say(id === IAP.donation ? '❤ Thank you for supporting DART Meadow\'s early alpha!' : '☄ Thank you — you\'re a Monthly Alpha Supporter!', 4200);
        try { J().analytics.track('support', id === IAP.donation ? 'donation' : 'monthly'); } catch (e) {}
        iapState.busy = false; renderSupport('');
      } else {
        iapState.busy = false;
        renderSupport(r.status === 'cancelled' ? '' : (r.message || 'The purchase didn\'t go through.'));
      }
    } catch (e) { iapState.busy = false; renderSupport(String((e && e.message) || e)); }
  }

  async function doRestore() {
    renderSupport('Checking your purchases with the App Store…');
    try { iapState.status = await DMNative.call('iapRestore'); } catch (e) {}
    renderSupport(iapState.status.subscribed ? 'Supporter subscription restored.' : 'No active subscription found. (Donations are one-time and don\'t need restoring.)');
  }

  window.addEventListener('dmnative:iap', (e) => { if (e.detail) { iapState.status = Object.assign(iapState.status, e.detail); renderSupport(''); } });
  function hookSupport() {
    const orig = window.openSupport;
    if (typeof orig !== 'function' || orig.__dmIAP) return;
    const wrapped = function () { const r = orig.apply(this, arguments); renderSupport(); loadIAP(); return r; };
    wrapped.__dmIAP = true;
    window.openSupport = wrapped;
  }
  hookSupport(); setTimeout(hookSupport, 1500);

  window.dmAppleSignIn = appleSignIn;
  window.dmAppleSignOut = appleSignOut;
  console.log('[dm-ios] bridge ready');
})();
} catch (e) { console.error('[dm-ios] bridge failed: ' + (e && (e.stack || e.message) || e)); }
