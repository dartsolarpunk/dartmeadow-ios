// DART Engine — world time.
//
// One clock for every player, tied to real UTC and running 30× faster, so
// an Earth day lasts 48 real minutes (the open-world standard). It never
// resets: whoever joins, whenever they join, sees the same hour, the same
// season and the same planets in the same places.
//
//   game time = anchor + (real UTC − anchor) × SCALE
//
// At the anchor the game clock read the real date and time; from there it
// runs at SCALE. Every client corrects its own clock against the server's
// Date header, so a phone set five minutes wrong still sees the right sky.
//
// Studied bodies use their real orbital elements (mean longitude and
// longitude of perihelion at J2000, sidereal period), real axial tilts and
// real solar days. Bodies the game generates take a seeded tilt and day
// length and a Kepler period from their orbit size, so they follow the
// same physics and look the same to everyone, every visit.
(function () {
  'use strict';
  const SCALE = 30;                              // 24 h → 48 min
  const ANCHOR = Date.UTC(2026, 8, 28);          // the world's epoch (also the old worldSeconds zero)
  const J2000 = Date.UTC(2000, 0, 1, 12);
  const DEG = Math.PI / 180;
  const OBLIQUITY = 23.44;

  // clock correction: server time − device time, in ms
  let offset = 0;
  try { const o = +sessionStorage.getItem('dm_time_off'); if (isFinite(o)) offset = o; } catch (e) {}
  function realNow() { return Date.now() + offset; }
  function sync() {
    if (!window.fetch || location.protocol === 'file:') return;
    const t0 = Date.now();
    fetch(location.pathname || '/', { method: 'HEAD', cache: 'no-store' }).then((r) => {
      const d = Date.parse(r.headers.get('date') || '');
      if (!isFinite(d)) return;
      const t1 = Date.now(), est = d + 500 + (t1 - t0) / 2;   // the header is whole seconds: aim mid-second
      const off = est - t1;
      if (Math.abs(off) > 1500) { offset = off; try { sessionStorage.setItem('dm_time_off', String(off)); } catch (e) {} }
    }).catch(() => {});
  }

  function gameMs() { return ANCHOR + (realNow() - ANCHOR) * SCALE; }
  function realSeconds() { return (realNow() - ANCHOR) / 1000; }   // real seconds since the epoch
  function days() { return (gameMs() - J2000) / 864e5; }           // game days since J2000

  // JPL approximate elements (Standish), J2000: mean longitude L0, longitude
  // of perihelion w (deg); P sidereal period (years); tilt (deg); solar day
  // (Earth days, negative = retrograde).
  const SOL = {
    Mercury: { e: 0.2056, L0: 252.25032, w: 77.45780, P: 0.2408467, tilt: 0.034, day: 175.94 },
    Venus:   { e: 0.0068, L0: 181.97910, w: 131.60247, P: 0.6151973, tilt: 177.36, day: -116.75 },
    Earth:   { e: 0.0167, L0: 100.46457, w: 102.93768, P: 1.0000174, tilt: 23.44, day: 1 },
    Mars:    { e: 0.0934, L0: 355.44657, w: 336.05637, P: 1.8808476, tilt: 25.19, day: 1.0275 },
    Jupiter: { e: 0.0489, L0: 34.39644, w: 14.72848, P: 11.862615, tilt: 3.13, day: 0.4135 },
    Saturn:  { e: 0.0565, L0: 49.95424, w: 92.59888, P: 29.447498, tilt: 26.73, day: 0.4440 },
    Uranus:  { e: 0.0457, L0: 313.23810, w: 170.95428, P: 84.016846, tilt: 97.77, day: -0.7183 },
    Neptune: { e: 0.0113, L0: 304.87997, w: 44.96476, P: 164.79132, tilt: 28.32, day: 0.6713 },
    Moon:    { tilt: 1.54, day: 29.530589, follows: 'Earth' },
  };

  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function frac(x) { return x - Math.floor(x); }
  const cache = {};
  // elements for any body: real when studied, seeded and Kepler-consistent otherwise
  function elements(body) {
    const name = typeof body === 'string' ? body : (body && body.name) || '?';
    if (SOL[name]) return SOL[name];
    if (cache[name]) return cache[name];
    const h = hash(name), r = (k) => frac(Math.sin((h % 9973) * 12.9898 + k * 78.233) * 43758.5453);
    const au = (window.AU_UNITS_FOR_TIME || 500);
    const a = body && (body.semiMajor || body.orbitR);
    const P = a ? Math.pow(a / au, 1.5) : 0.5 + r(1) * 4;
    // spin like the planets we know: most turn in a fraction of a day to a few days, a few are slow or tipped
    const slow = r(2) < 0.12, day = slow ? 20 + r(3) * 150 : 0.35 + r(3) * 2.6;
    const tilt = r(4) < 0.08 ? 60 + r(5) * 40 : r(5) * 32;
    return (cache[name] = { L0: r(6) * 360, w: r(7) * 360, P, tilt, day: r(8) < 0.06 ? -day : day, phase: r(9) });
  }
  function meanLongitude(el, d) { return (el.L0 + 360 / (el.P * 365.25) * d) % 360; }
  // the planet's own place: mean anomaly (rad) for Kepler's equation, and perihelion (rad)
  function orbit(body) {
    const el = elements(body), d = days();
    return { meanAnom: ((meanLongitude(el, d) - el.w) % 360) * DEG, peri: el.w * DEG };
  }
  // where the Sun is in this body's sky, as a fraction of its solar day at longitude 0
  // (0 = midnight, 0.5 = noon). For Earth this is real UTC, sped up.
  function dayFraction(body) {
    const name = typeof body === 'string' ? body : body && body.name;
    if (name === 'Earth') { const g = gameMs(); return frac(g / 864e5); }
    const el = elements(body);
    return frac(days() / el.day + (el.phase != null ? el.phase : frac(hash(name || '') / 4294967296)));
  }
  // the Sun's declination (seasons): its ecliptic longitude seen from the body, through the tilt
  function declination(body) {
    const name = typeof body === 'string' ? body : body && body.name;
    let el = elements(body);
    if (el.follows) el = SOL[el.follows];
    const d = days();
    const M = (meanLongitude(el, d) - el.w) * DEG;
    const helio = meanLongitude(el, d) * DEG + (2 * (el.e || 0.0167) * Math.sin(M));   // plus the equation of centre
    const tilt = (name === 'Earth' ? OBLIQUITY : elements(body).tilt) * DEG;
    return Math.asin(Math.sin(tilt) * Math.sin(helio + Math.PI));
  }
  // Sun direction in a local frame (east = +x, up = +y, north = −z) at lat/lon (deg)
  function sunDir(body, lat, lon, out) {
    const H = (frac(dayFraction(body) + (lon || 0) / 360) - 0.5) * 2 * Math.PI;   // hour angle, 0 at local noon
    const dec = declination(body), phi = (lat || 0) * DEG;
    const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
    const east = -Math.cos(dec) * Math.sin(H);
    const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(H);
    out = out || { x: 0, y: 0, z: 0 };
    if (out.set) out.set(east, up, -north); else { out.x = east; out.y = up; out.z = -north; }
    return out;
  }
  // longitude where it is noon right now (deg) — the planet's spin in flight is set from this,
  // so the side lit by the Sun from orbit is the side where it is day on the ground
  function subsolarLon(body) { return (0.5 - dayFraction(body)) * 360; }
  // local clock at a longitude on that body, as {h, m} of a 24-hour day
  function localTime(body, lon) {
    const f = frac(dayFraction(body) + (lon || 0) / 360) * 24;
    return { h: Math.floor(f), m: Math.floor((f % 1) * 60) };
  }
  // real seconds one local day lasts on that body
  function dayWallSeconds(body) { return Math.abs(elements(body).day) * 86400 / SCALE; }

  window.DMTime = { SCALE, ANCHOR, J2000, SOL, sync, realNow, realSeconds, gameMs, days, elements, orbit, dayFraction, declination, sunDir, subsolarLon, localTime, dayWallSeconds };
  sync();
  try { setInterval(sync, 10 * 60 * 1000); } catch (e) {}
})();
