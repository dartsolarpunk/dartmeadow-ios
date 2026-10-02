/* DART Meadow — world styles: how each kind of planet is shaped, textured
 * and lit when you walk it or fly its sky. Our own technique, built for
 * this game (an RPG of very different worlds):
 *
 *   mesa      desert / red worlds — stepped tablelands with sheer risers,
 *             lone buttes and thin hoodoo spires; the cliffs carry layered
 *             rock strata, the flats wind-rippled sand.
 *   ice       frozen worlds — wind-carved sastrugi ridges, pressure ridges
 *             and smooth shelves; packed snow on top, glacial blue in the
 *             cuts.
 *   crater    airless rock — overlapping impact craters with raised rims,
 *             bright fresh rims and darker floors over grey regolith.
 *   volcanic  sharp basalt ridges over black rock; the lowlands glow.
 *   lush      the living worlds (unchanged base look).
 *
 * Every shape is written twice, once for the CPU (heightmap tiles,
 * collision, the sky's terrain) and once as a TSL node graph for the
 * WebGPU marching-cubes patch, from the same constants so they agree.
 */
(function () {
  'use strict';
  const sm = (a, b, v) => { const u = Math.min(1, Math.max(0, (v - a) / (b - a))); return u * u * (3 - 2 * u); };
  const hash2 = (i, j, s) => { const v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };

  const K = {
    mesa: { tier: 16, rise0: 0.78, rise1: 0.98, keep: 0.15, butteF: 0.012, butteT: 0.62, butteW: 0.06, butteH: 42, hoodF: 0.09, hoodT: 0.74, hoodW: 0.06, hoodH: 9, hoodH2: 14 },
    ice: { smooth: 0.7, sastF: 0.35, sastA: 1.6, prF: 0.01, prT: 0.9, prH: 14 },
    crater: { cell: 56, p: 0.55, r0: 8, r1: 22, depth: 0.38, rim: 0.14 },
    volcanic: { rF: 0.008, rA: 30, chF: 0.012, chT: 0.965, chD: 10 },
    // rolling dunes: long transverse ridges (gentle windward side, steep
    // slip face), warped and broken up so no two look alike
    dunes: { ang: 0.62, lam: 52, amp: 9, warpF: 0.0035, warpA: 70, crest: 0.8, keep: 0.22, fieldF: 0.0022, fieldT: 0.58 },
  };
  // Earth's sand seas (lat/lon boxes): Sahara + Arabia, Thar, Taklamakan +
  // Gobi, the Australian deserts, Kalahari/Namib, Atacama, the US southwest
  const EARTH_DESERTS = [[14, 33, -17, 58], [24, 30, 69, 75], [36, 46, 76, 112], [-32, -19, 116, 146], [-29, -17, 12, 25], [-27, -18, -71, -68], [31, 37, -117, -108]];
  function earthDesert(site) {
    if (!site || typeof site.lat !== 'number') return false;
    return EARTH_DESERTS.some(([a, b, c, d]) => site.lat >= a && site.lat <= b && site.lon >= c && site.lon <= d);
  }

  function styleFor(body, pal, site) {
    const n = body && body.name, t = body && body.type;
    if (n === 'Earth' && earthDesert(site)) return 'dunes';
    if (t === 'Desert') return 'dunes';
    if (n === 'Mars' || n === 'Venus') return 'mesa';
    if (t === 'Ice') return 'ice';
    if (t === 'Volcanic') return 'volcanic';
    if (n === 'Moon' || n === 'Mercury' || t === 'Rocky' || t === 'Barren Moon' || (pal && pal.atmos === false)) return 'crater';
    return 'lush';
  }

  // ── CPU shapes ─────────────────────────────────────────────────────────
  function duneH(x, z, seed, f) {
    const k = K.dunes, ca = Math.cos(k.ang), sa = Math.sin(k.ang);
    const w = (f(x * k.warpF + seed, z * k.warpF - seed, seed + 221, 3) - 0.5) * 2 * k.warpA;
    const u = (x * ca + z * sa + w) / k.lam, v = (-x * sa + z * ca) / k.lam;
    const t = u - Math.floor(u);
    const prof = t < k.crest ? Math.pow(t / k.crest, 1.6) : 1 - sm(0, 1, (t - k.crest) / (1 - k.crest));
    // crests rise and fall along their length, and some dunes are taller
    const along = 0.55 + 0.45 * Math.sin(v * 1.7 + w * 0.02);
    const big = 0.45 + f(x * 0.006 + 7, z * 0.006 - 7, seed + 231, 2) * 0.9;
    return prof * k.amp * along * big;
  }
  function duneT(x, z, seed, f) {   // 0 trough … 1 crest, and whether we're on the slip face
    const k = K.dunes, ca = Math.cos(k.ang), sa = Math.sin(k.ang);
    const w = (f(x * k.warpF + seed, z * k.warpF - seed, seed + 221, 3) - 0.5) * 2 * k.warpA;
    const u = (x * ca + z * sa + w) / k.lam, t = u - Math.floor(u);
    return { t, slip: t > k.crest };
  }
  // ── Mars (and the other red desert worlds) ─────────────────────────────
  // Read from the rover panoramas and orbital views: wide, nearly level
  // plains of red regolith that roll gently over kilometres; flat-topped
  // tablelands standing above them on worn escarpments (a talus apron at
  // the foot, a crisp lip at the top); impact craters at every size — big
  // shallow basins with low rims and the odd central peak, sharp bowls,
  // small pits; dark dune seas lying in the low ground; and only here and
  // there a broad, rounded massif. No terracing, no spires: the ground you
  // land on is ground you can walk.
  const MARS = {
    swellF: 0.0011, swellA: 34, undF: 0.006, undA: 4.5,
    regF: 0.00055,
    platF: 0.0011, plat1: 0.56, plat2: 0.675, platH1: 30, platH2: 18, edge: 0.03,
    craters: [
      { cell: 950, p: 0.42, r0: 90, r1: 230, depth: 0.11, rim: 0.035, peak: 0.05 },
      { cell: 280, p: 0.45, r0: 16, r1: 58, depth: 0.2, rim: 0.06, peak: 0 },
      { cell: 74, p: 0.32, r0: 3.5, r1: 10, depth: 0.24, rim: 0.08, peak: 0 },
    ],
    mtT0: 0.7, mtT1: 0.86, mtF: 0.0024, mtA: 85,
    duneAmp: 0.7, chF: 0.0007, chT: 0.982, chD: 8,
  };
  function marsCrater(x, z, seed, k, salt) {
    const ci = Math.floor(x / k.cell), cj = Math.floor(z / k.cell);
    let o = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di, j = cj + dj;
      if (hash2(i, j, seed + salt) > k.p) continue;
      const cx = (i + 0.25 + hash2(i + 7, j, seed + salt) * 0.5) * k.cell, cz = (j + 0.25 + hash2(i, j + 7, seed + salt) * 0.5) * k.cell;
      const R = k.r0 + Math.pow(hash2(i + 3, j + 5, seed + salt), 1.6) * k.r1;   // many small, few large
      const d = Math.hypot(x - cx, z - cz) / R;
      if (d > 2.4) continue;
      // the age of a crater softens it: old ones are shallow with worn rims
      const age = 0.45 + 0.55 * hash2(i + 11, j + 13, seed + salt);
      const D = R * k.depth * age, Rh = R * k.rim * age;
      let v;
      if (d < 1) {
        const w = sm(0.3, 1.0, d);
        v = -D + (D + Rh) * w * w;                                   // flat floor, curved wall, rim at the edge
        if (k.peak && R > 150) v += Math.exp(-Math.pow(d / 0.13, 2)) * R * k.peak * age;   // central peak
      } else {
        v = Rh * Math.pow(1 / d, 3) * (1 - sm(1.6, 2.4, d));        // ejecta blanket falling away
      }
      o += v;
    }
    return o;
  }
  function marsMask(x, z, seed, f) {   // where the dune seas lie (shared with the colouring)
    return sm(K.dunes.fieldT, K.dunes.fieldT + 0.12, f(x * K.dunes.fieldF + 31, z * K.dunes.fieldF - 31, seed + 241, 3));
  }
  function marsH(x, z, seed, f) {
    const k = MARS;
    let h = (f(x * k.swellF + 11, z * k.swellF - 5, seed + 301, 4) - 0.5) * 2 * k.swellA;   // the long swell of the plains
    h += (f(x * k.undF + 3, z * k.undF + 9, seed + 303, 3) - 0.5) * 2 * k.undA;           // a gentle undulation on top
    const reg = f(x * k.regF + seed * 0.37, z * k.regF - seed * 0.21, seed + 311, 3);      // regional character
    // tablelands: one or two flat-topped tiers, ragged edges, worn escarpment
    const pm = f(x * k.platF + 5, z * k.platF + 5, seed + 321, 4) + (f(x * 0.02, z * 0.02, seed + 323, 2) - 0.5) * k.edge * 2;
    const inPlat = sm(0.3, 0.5, reg);
    const t1 = sm(k.plat1, k.plat1 + 0.022, pm), t2 = sm(k.plat2, k.plat2 + 0.018, pm);
    const plat = (t1 * k.platH1 + t2 * k.platH2) * inPlat;
    h += plat;
    // a tableland's top stays level: the plains' undulation is damped up there
    // dune seas in the low ground off the tablelands
    const df = marsMask(x, z, seed, f) * (1 - t1 * inPlat);
    if (df > 0) h += duneH(x, z, seed, f) * k.duneAmp * df;
    // impact craters at three scales
    for (let c = 0; c < k.craters.length; c++) h += marsCrater(x, z, seed, k.craters[c], 401 + c * 17);
    // rare broad massifs, rounded by time
    const mt = sm(k.mtT0, k.mtT1, reg);
    if (mt > 0) {
      const r = 1 - Math.abs(f(x * k.mtF + 2, z * k.mtF - 2, seed + 331, 4) * 2 - 1);
      h += mt * (r * r * k.mtA + f(x * k.mtF * 2.3, z * k.mtF * 2.3, seed + 333, 3) * k.mtA * 0.35);
    }
    // the odd dry channel winding across the plain
    const chOn = 1 - sm(0.25, 0.42, reg);   // only out on the open plains
    if (chOn > 0) {
      const ch = 1 - Math.abs(f(x * k.chF + seed * 1.9, z * k.chF - seed * 1.3, seed + 341, 3) * 2 - 1);
      h -= sm(k.chT, 1, ch) * k.chD * chOn;
    }
    return h;
  }
  // f(x,z,seed,octaves) is the game's own _fbm (0..1).
  function shape(style, x, z, h, seed, f) {
    if (style === 'dunes') return h * K.dunes.keep + duneH(x, z, seed, f);
    if (style === 'mesa') return marsH(x, z, seed, f);
    if (style === 'mesa-legacy') {
      const k = K.mesa, t = h / k.tier, fl = Math.floor(t), fr = t - fl;
      let o = (fl + sm(k.rise0, k.rise1, fr)) * k.tier * (1 - k.keep) + h * k.keep;
      const b = f(x * k.butteF + seed * 1.7, z * k.butteF + seed * 1.7, seed + 141, 3);
      o += sm(k.butteT, k.butteT + k.butteW, b) * k.butteH;
      const s = f(x * k.hoodF + seed * 2.3, z * k.hoodF + seed * 2.3, seed + 151, 2);
      o += sm(k.hoodT, k.hoodT + k.hoodW, s) * (k.hoodH + k.hoodH2 * f(x * 0.02, z * 0.02, seed + 161, 2));
      // dune seas between the mesas
      const df = sm(K.dunes.fieldT, K.dunes.fieldT + 0.12, f(x * K.dunes.fieldF + 31, z * K.dunes.fieldF - 31, seed + 241, 3));
      if (df > 0) o = o * (1 - df) + (h * K.dunes.keep + duneH(x, z, seed, f)) * df;
      return o;
    }
    if (style === 'ice') {
      const k = K.ice;
      let o = h * k.smooth;
      const w = f(x * 0.01, z * 0.01, seed + 171, 2) * 6;
      const r = 1 - Math.abs(Math.sin((x * 0.8 + z * 0.35) * k.sastF + w));
      o += r * r * r * k.sastA;
      const pr = 1 - Math.abs(f(x * k.prF + seed, z * k.prF + seed, seed + 181, 3) * 2 - 1);
      o += Math.pow(sm(k.prT, 1, pr), 2) * k.prH;
      return o;
    }
    if (style === 'crater') return h * 0.8 + craters(x, z, seed);
    if (style === 'volcanic') {
      const k = K.volcanic;
      const r = 1 - Math.abs(f(x * k.rF + seed, z * k.rF + seed, seed + 191, 4) * 2 - 1);
      let o = h + r * r * r * k.rA;
      const ch = 1 - Math.abs(f(x * k.chF + seed * 3.3, z * k.chF + seed * 3.3, seed + 201, 3) * 2 - 1);
      o -= sm(k.chT, 1, ch) * k.chD;
      return o;
    }
    return h;
  }
  function craters(x, z, seed) {
    const k = K.crater, ci = Math.floor(x / k.cell), cj = Math.floor(z / k.cell);
    let o = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di, j = cj + dj;
      if (hash2(i, j, seed) > k.p) continue;
      const cx = (i + 0.2 + hash2(i + 7, j, seed) * 0.6) * k.cell, cz = (j + 0.2 + hash2(i, j + 7, seed) * 0.6) * k.cell;
      const R = k.r0 + hash2(i + 3, j + 5, seed) * k.r1;
      const d = Math.hypot(x - cx, z - cz) / R;
      if (d < 1) o -= (1 - d * d) * R * k.depth;
      const e = (d - 1) / 0.14; o += Math.exp(-e * e) * R * k.rim;
    }
    return o;
  }
  // how strongly a spot is a crater rim / floor (for texturing)
  function craterTint(x, z, seed) {
    const k = K.crater, ci = Math.floor(x / k.cell), cj = Math.floor(z / k.cell);
    let rim = 0, floor = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di, j = cj + dj;
      if (hash2(i, j, seed) > k.p) continue;
      const cx = (i + 0.2 + hash2(i + 7, j, seed) * 0.6) * k.cell, cz = (j + 0.2 + hash2(i, j + 7, seed) * 0.6) * k.cell;
      const R = k.r0 + hash2(i + 3, j + 5, seed) * k.r1;
      const d = Math.hypot(x - cx, z - cz) / R;
      floor = Math.max(floor, 1 - sm(0.55, 0.95, d));
      rim = Math.max(rim, Math.exp(-Math.pow((d - 1) / 0.18, 2)));
    }
    return { rim, floor };
  }

  // ── CPU texturing (vertex colours) ─────────────────────────────────────
  const C = (hex) => new (window.THREE.Color)(hex);
  function sandColor(x, z, h, slope, pal, seed, f, n, earth) {
    const d = duneT(x, z, seed, f);
    const base = earth ? C(0xecd2a2) : C(pal.ground || 0xcaa050);
    const c = base.lerp(C(earth ? 0xf8e6c2 : 0xe6c48c), 0.25 + n * 0.35);
    c.multiplyScalar(0.9 + sm(0.5, 0.95, d.t) * 0.14);          // crests catch the light
    if (d.slip) c.multiplyScalar(0.9);                          // slip faces a shade darker
    const rip = 0.5 + 0.5 * Math.sin((x * 1.9 + z * 0.8) + n * 5);
    c.multiplyScalar(0.97 + rip * 0.05);
    return c;
  }
  function color(style, x, z, h, slope, pal, seed, f, base) {
    const THREE = window.THREE;
    const n = f(x * 0.08 + seed, z * 0.08 + seed, seed + 81, 3) - 0.5;
    const fine = f(x * 0.6 + seed, z * 0.6 + seed, seed + 101, 2);
    if (style === 'dunes') return sandColor(x, z, h, slope, pal, seed, f, n, !pal.ground2 || (pal.water === true));
    if (style === 'mesa') {
      const sand = C(pal.ground || 0xcaa050).lerp(C(0xe6c48c), 0.25 + n * 0.3);
      // wind ripples on the flats
      const rip = 0.5 + 0.5 * Math.sin((x * 0.9 + z * 0.4) + n * 6);
      sand.multiplyScalar(0.94 + rip * 0.08);
      // strata: three tones banded by height, wobbling with noise
      const band = Math.sin(h * 0.55 + n * 3.0 + fine * 0.6);
      const r1 = C(pal.rock || 0xc08050), r2 = C(pal.ground2 || 0x8a4a2a), r3 = C(0xead2a8);
      const rock = band > 0 ? r1.lerp(r3, band * 0.62) : r1.lerp(r2.multiplyScalar(0.8), -band * 0.75);
      // desert varnish: darker streaks down the cliff faces
      rock.multiplyScalar(0.82 + 0.18 * f(x * 0.05, h * 0.3, seed + 211, 2));
      const w = sm(0.22, 0.55, slope);
      const df = sm(K.dunes.fieldT, K.dunes.fieldT + 0.12, f(x * K.dunes.fieldF + 31, z * K.dunes.fieldF - 31, seed + 241, 3));
      const ground = df > 0 ? sand.lerp(sandColor(x, z, h, slope, pal, seed, f, n, false), df) : sand;
      return ground.lerp(rock, w);
    }
    if (style === 'ice') {
      const snow = C(0xf2f6fb).lerp(C(0xdde9f4), 0.3 + n * 0.4);
      const glacier = C(0x8cc0e0).lerp(C(0x3f78a6), sm(0.4, 0.9, slope));
      const rock = C(0x5a6470).lerp(C(0x3a414a), fine);
      let c = snow.lerp(glacier, sm(0.18, 0.5, slope));
      if (slope > 0.62 && fine > 0.55) c = c.lerp(rock, 0.6);
      return c;
    }
    if (style === 'crater') {
      const t = craterTint(x, z, seed);
      const reg = C(pal.ground || 0x888888).lerp(C(pal.ground2 || 0x666666), 0.4 + n * 0.5);
      reg.multiplyScalar(0.92 + fine * 0.14);
      reg.lerp(C(0x3e3e42), t.floor * 0.6);
      reg.lerp(C(0xf0eee8), t.rim * 0.7);
      reg.lerp(C(pal.rock || 0x999999), sm(0.35, 0.7, slope) * 0.6);
      return reg;
    }
    if (style === 'volcanic') {
      const basalt = C(0x2c2420).lerp(C(0x45362e), 0.5 + n);
      const ash = C(0x6a564a);
      let c = basalt.lerp(ash, sm(0.1, 0.35, slope) * (1 - sm(0.5, 0.8, slope)) * 0.6);
      // lava runs along the channels and pools in the low ground
      const k = K.volcanic;
      const ch = 1 - Math.abs(f(x * k.chF + seed * 3.3, z * k.chF + seed * 3.3, seed + 201, 3) * 2 - 1);
      const lava = Math.max(sm(k.chT - 0.01, 0.995, ch), sm(4, -6, h)) * (0.6 + fine * 0.4);
      c = c.lerp(C(0xff8a3a), lava * 0.9);
      return c;
    }
    return base;
  }

  // ── Sky: the colours each style leans to (haze at the horizon, sun glow) ─
  function skyFor(style, pal) {
    const sky = pal.sky || [0x88bbff, 0x3a6ea5];
    const S = {
      mesa: { haze: 0xf0c890, sun: 0xfff0d0, glow: 0xffb070 },
      dunes: pal.water ? { haze: 0xe8dcc4, sun: 0xfff6e4, glow: 0xffd8a0 } : { haze: 0xf2d29c, sun: 0xfff4dc, glow: 0xffc080 },
      ice: { haze: 0xe4f0fa, sun: 0xffffff, glow: 0xbfe0ff },
      volcanic: { haze: 0xa8503a, sun: 0xffd0a0, glow: 0xff7040 },
      crater: { haze: 0x000000, sun: 0xffffff, glow: 0x777777 },
      lush: { haze: pal.fog || 0xbfd8f0, sun: 0xfff6e0, glow: 0xffe0b0 },
    }[style] || {};
    return Object.assign({ top: sky[1], bottom: sky[0] }, S);
  }

  // ── GPU (TSL) versions — built once per terrain patch ──────────────────
  // Return node graphs; `T` is window (the TSL functions live there).
  function tslSm(T, a, b, v) { return T.smoothstep(T.float(a), T.float(b), v); }
  function tslFbm01(T, p2, seedU, off, oct) {
    return T.mx_fractal_noise_float(T.vec3(p2.x, T.float(0), p2.y).add(seedU).add(T.vec3(off, 0, off * 0.37)), oct, 2.0, 0.5).mul(0.5).add(0.5);
  }
  function tslHash(T, i, j, seedU) { return T.fract(T.sin(i.mul(127.1).add(j.mul(311.7)).add(seedU.mul(74.7))).mul(43758.5453)); }
  function craterSumTSL(T, p, seedU) {
    const k = K.crater;
    const ci = T.floor(p.x.div(k.cell)), cj = T.floor(p.z.div(k.cell));
    let o = T.float(0);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const i = ci.add(di), j = cj.add(dj);
      const on = T.step(tslHash(T, i, j, seedU), T.float(k.p));          // 1 when a crater lives in this cell
      const cx = i.add(0.2).add(tslHash(T, i.add(7), j, seedU).mul(0.6)).mul(k.cell);
      const cz = j.add(0.2).add(tslHash(T, i, j.add(7), seedU).mul(0.6)).mul(k.cell);
      const R = tslHash(T, i.add(3), j.add(5), seedU).mul(k.r1).add(k.r0);
      const d = T.length(T.vec2(p.x.sub(cx), p.z.sub(cz))).div(R);
      const bowl = T.float(1).sub(d.mul(d)).max(0).mul(R).mul(k.depth);
      const e = d.sub(1).div(0.14);
      const rim = T.exp(e.mul(e).negate()).mul(R).mul(k.rim);
      o = o.add(rim.sub(bowl).mul(on));
    }
    return o;
  }
  function duneTSL(T, p, seedU, wantT) {
    const k = K.dunes, ca = Math.cos(k.ang), sa = Math.sin(k.ang);
    const w = tslFbm01(T, T.vec2(p.x, p.z).mul(k.warpF), seedU, 221, 3).sub(0.5).mul(2 * k.warpA);
    const u = p.x.mul(ca).add(p.z.mul(sa)).add(w).div(k.lam), v = p.x.mul(-sa).add(p.z.mul(ca)).div(k.lam);
    const t = T.fract(u);
    if (wantT) return t;
    const up = T.pow(t.div(k.crest), T.float(1.6));
    const down = T.float(1).sub(T.smoothstep(T.float(0), T.float(1), t.sub(k.crest).div(1 - k.crest)));
    const prof = T.select(t.lessThan(k.crest), up, down);
    const along = T.sin(v.mul(1.7).add(w.mul(0.02))).mul(0.45).add(0.55);
    const big = tslFbm01(T, T.vec2(p.x, p.z).mul(0.006), seedU, 231, 2).mul(0.9).add(0.45);
    return prof.mul(k.amp).mul(along).mul(big);
  }
  function shapeTSL(style, T, p, h, seedU) {
    const xz = T.vec2(p.x, p.z);
    if (style === 'dunes') return h.mul(K.dunes.keep).add(duneTSL(T, p, seedU));
    if (style === 'mesa') {
      const k = K.mesa, t = h.div(k.tier), fl = T.floor(t), fr = t.sub(fl);
      let o = fl.add(tslSm(T, k.rise0, k.rise1, fr)).mul(k.tier * (1 - k.keep)).add(h.mul(k.keep));
      const b = tslFbm01(T, xz.mul(k.butteF), seedU.mul(1.7), 141, 3);
      o = o.add(tslSm(T, k.butteT, k.butteT + k.butteW, b).mul(k.butteH));
      const s = tslFbm01(T, xz.mul(k.hoodF), seedU.mul(2.3), 151, 2);
      const hv = tslFbm01(T, xz.mul(0.02), seedU, 161, 2);
      o = o.add(tslSm(T, k.hoodT, k.hoodT + k.hoodW, s).mul(hv.mul(k.hoodH2).add(k.hoodH)));
      const df = tslSm(T, K.dunes.fieldT, K.dunes.fieldT + 0.12, tslFbm01(T, xz.mul(K.dunes.fieldF), seedU, 241, 3));
      return T.mix(o, h.mul(K.dunes.keep).add(duneTSL(T, p, seedU)), df);
    }
    if (style === 'ice') {
      const k = K.ice;
      let o = h.mul(k.smooth);
      const w = tslFbm01(T, xz.mul(0.01), seedU, 171, 2).mul(6);
      const r = T.float(1).sub(T.abs(T.sin(p.x.mul(0.8).add(p.z.mul(0.35)).mul(k.sastF).add(w))));
      o = o.add(r.mul(r).mul(r).mul(k.sastA));
      const pr = T.float(1).sub(T.abs(tslFbm01(T, xz.mul(k.prF), seedU, 181, 3).mul(2).sub(1)));
      const q = tslSm(T, k.prT, 1, pr);
      return o.add(q.mul(q).mul(k.prH));
    }
    if (style === 'crater') return h.mul(0.8).add(craterSumTSL(T, p, seedU));
    if (style === 'volcanic') {
      const k = K.volcanic;
      const r = T.float(1).sub(T.abs(tslFbm01(T, xz.mul(k.rF), seedU, 191, 4).mul(2).sub(1)));
      const ch = T.float(1).sub(T.abs(tslFbm01(T, xz.mul(k.chF), seedU.mul(3.3), 201, 3).mul(2).sub(1)));
      return h.add(r.mul(r).mul(r).mul(k.rA)).sub(tslSm(T, k.chT, 1, ch).mul(k.chD));
    }
    return h;
  }
  function colorTSL(style, T, v, nrm, height, seedU, pal, fallback) {
    const col = (hex) => { const c = new (window.THREE.Color)(hex); return T.vec3(c.r, c.g, c.b); };
    const slope = T.float(1).sub(nrm.y.clamp(0, 1));
    const xz = T.vec2(v.x, v.z);
    const n = tslFbm01(T, xz.mul(0.08), seedU, 81, 3).sub(0.5);
    const fine = tslFbm01(T, xz.mul(0.6), seedU, 101, 2);
    const sandTSL = (earth) => {
      const t = duneTSL(T, v, seedU, true);
      let c = T.mix(earth ? col(0xecd2a2) : col(pal.ground || 0xcaa050), earth ? col(0xf8e6c2) : col(0xe6c48c), n.mul(0.35).add(0.25));
      c = c.mul(tslSm(T, 0.5, 0.95, t).mul(0.14).add(0.9)).mul(T.select(t.greaterThan(K.dunes.crest), T.float(0.9), T.float(1)));
      const rip = T.sin(v.x.mul(1.9).add(v.z.mul(0.8)).add(n.mul(5))).mul(0.5).add(0.5);
      return c.mul(rip.mul(0.05).add(0.97));
    };
    if (style === 'dunes') return sandTSL(!!pal.water);
    if (style === 'mesa') {
      const rip = T.sin(v.x.mul(0.9).add(v.z.mul(0.4)).add(n.mul(6))).mul(0.5).add(0.5);
      const sand = T.mix(col(pal.ground || 0xcaa050), col(0xe6c48c), n.mul(0.3).add(0.25)).mul(rip.mul(0.08).add(0.94));
      const band = T.sin(v.y.mul(0.55).add(n.mul(3)).add(fine.mul(0.6)));
      const r1 = col(pal.rock || 0xc08050);
      const light = T.mix(r1, col(0xead2a8), band.max(0).mul(0.62));
      const dark = T.mix(r1, col(pal.ground2 || 0x8a4a2a).mul(0.8), band.negate().max(0).mul(0.75));
      const varn = tslFbm01(T, T.vec2(v.x.mul(0.05), v.y.mul(0.3)), seedU, 211, 2).mul(0.18).add(0.82);
      const rock = T.select(band.greaterThan(0), light, dark).mul(varn);
      const df = tslSm(T, K.dunes.fieldT, K.dunes.fieldT + 0.12, tslFbm01(T, xz.mul(K.dunes.fieldF), seedU, 241, 3));
      return T.mix(T.mix(sand, sandTSL(false), df), rock, tslSm(T, 0.22, 0.55, slope));
    }
    if (style === 'ice') {
      const snow = T.mix(col(0xf2f6fb), col(0xdde9f4), n.mul(0.4).add(0.3));
      const glacier = T.mix(col(0x8cc0e0), col(0x3f78a6), tslSm(T, 0.4, 0.9, slope));
      const c = T.mix(snow, glacier, tslSm(T, 0.18, 0.5, slope));
      const rocky = T.step(T.float(0.62), slope).mul(T.step(T.float(0.55), fine));
      return T.mix(c, col(0x4a535c), rocky.mul(0.6));
    }
    if (style === 'crater') {
      const reg = T.mix(col(pal.ground || 0x888888), col(pal.ground2 || 0x666666), n.mul(0.5).add(0.4)).mul(fine.mul(0.14).add(0.92));
      // the floor sits low, the rim high — shade by height relative to the plain
      const cs = craterSumTSL(T, v, seedU);
      const low = tslSm(T, -2, -10, cs), high = tslSm(T, 1.5, 5, cs);
      let c = T.mix(reg, col(0x3e3e42), low.mul(0.6));
      c = T.mix(c, col(0xf0eee8), high.mul(0.7));
      return T.mix(c, col(pal.rock || 0x999999), tslSm(T, 0.35, 0.7, slope).mul(0.6));
    }
    if (style === 'volcanic') {
      const basalt = T.mix(col(0x2c2420), col(0x45362e), n.add(0.5).clamp(0, 1));
      const c = T.mix(basalt, col(0x6a564a), tslSm(T, 0.1, 0.35, slope).mul(T.float(1).sub(tslSm(T, 0.5, 0.8, slope))).mul(0.6));
      const k = K.volcanic;
      const ch = T.float(1).sub(T.abs(tslFbm01(T, xz.mul(k.chF), seedU.mul(3.3), 201, 3).mul(2).sub(1)));
      const lava = T.max(tslSm(T, k.chT - 0.01, 0.995, ch), tslSm(T, 4, -6, height)).mul(fine.mul(0.4).add(0.6));
      return T.mix(c, col(0xff8a3a), lava.mul(0.9));
    }
    return fallback;
  }

  window.DMWorldStyle = { K, MARS, marsH, styleFor, shape, color, skyFor, shapeTSL, colorTSL, craters, duneH, earthDesert, isSand: (st) => st === 'dunes' || st === 'mesa' };
})();
