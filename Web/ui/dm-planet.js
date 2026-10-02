/* DART Meadow — planets as real spheres: height field, erosion, cube-sphere LOD.
 *
 * Our own implementation of standard, published techniques (no third-party
 * code): improved gradient noise (K. Perlin, "Improving Noise", SIGGRAPH
 * 2002), particle hydraulic erosion (H. T. Beyer, "Implementation of a
 * method for hydraulic erosion", 2015; popularised by S. Lague's Coding
 * Adventure), and cube-sphere chunked LOD (T. Ulrich, "Chunked LOD").
 *
 *  PlanetField  height above sea level for any direction on the sphere:
 *               the game's terrain recipe (hills, mesas, ridged mountains,
 *               terraces, canyons, rivers) evaluated in 3-D so it wraps the
 *               whole planet, plus real geography where a world has it
 *               (Earth's continents, Mars's named features), plus an erosion
 *               map baked once per planet and cached.
 *  Frame        a local x/y/z frame at a site on the sphere (x east, z south,
 *               y up) — the coordinates walking and flying already use. It
 *               can re-centre as you travel (floating origin).
 *  PlanetLOD    cube-sphere quadtree: six faces split finer near the camera
 *               and coarser away from it, tiles built under a per-frame time
 *               budget, parents kept until children are ready (no holes),
 *               skirts hide cracks, oceans are curved sea tiles.
 */
(function () {
  'use strict';
  const PI = Math.PI;

  // ── improved gradient noise (Perlin 2002), seeded ─────────────────────
  function Noise3(seed) {
    const p = new Uint8Array(512), q = new Uint8Array(256);
    for (let i = 0; i < 256; i++) q[i] = i;
    let s = (seed >>> 0) || 1;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0, t = q[i]; q[i] = q[j]; q[j] = t; }
    for (let i = 0; i < 512; i++) p[i] = q[i & 255];
    this.p = p;
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function grad(h, x, y, z) {
    switch (h & 15) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x + z; case 5: return -x + z; case 6: return x - z; case 7: return -x - z;
      case 8: return y + z; case 9: return -y + z; case 10: return y - z; case 11: return -y - z;
      case 12: return x + y; case 13: return -y + z; case 14: return -x + y; default: return -y - z;
    }
  }
  Noise3.prototype.n = function (x, y, z) {          // ≈ -1..1
    const p = this.p;
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[xi] + yi, AA = p[A] + zi, AB = p[A + 1] + zi, B = p[xi + 1] + yi, BA = p[B] + zi, BB = p[B + 1] + zi;
    const l1 = grad(p[AA], x, y, z) + u * (grad(p[BA], x - 1, y, z) - grad(p[AA], x, y, z));
    const l2 = grad(p[AB], x, y - 1, z) + u * (grad(p[BB], x - 1, y - 1, z) - grad(p[AB], x, y - 1, z));
    const l3 = grad(p[AA + 1], x, y, z - 1) + u * (grad(p[BA + 1], x - 1, y, z - 1) - grad(p[AA + 1], x, y, z - 1));
    const l4 = grad(p[AB + 1], x, y - 1, z - 1) + u * (grad(p[BB + 1], x - 1, y - 1, z - 1) - grad(p[AB + 1], x, y - 1, z - 1));
    const m1 = l1 + v * (l2 - l1), m2 = l3 + v * (l4 - l3);
    return m1 + w * (m2 - m1);
  };
  // fractal sum mapped to ~0..1 with the same spread as the game's 2-D value
  // noise (_fbm), so its tuned thresholds (regions, ridges, canyons) carry over
  Noise3.prototype.fbm = function (x, y, z, oct) {
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { v += amp * this.n(x * f, y * f, z * f); norm += amp; amp *= 0.5; f *= 2; }
    return FBM_MID + (v / norm) * FBM_SPREAD;
  };
  Noise3.prototype.sfbm = function (x, y, z, oct) {    // signed, ~-1..1
    let v = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) { v += amp * this.n(x * f, y * f, z * f); norm += amp; amp *= 0.5; f *= 2; }
    return v / norm;
  };
  let FBM_SPREAD = 0.74, FBM_MID = 0.47;                // calibrated in tests against _fbm (sd ≈ 0.123, mean ≈ 0.47)

  // ── cube <-> sphere ────────────────────────────────────────────────────
  // face f, (u,v) in [-1,1] (or a little beyond, for padding) → unit direction
  function faceDir(f, u, v, out) {
    let x, y, z;
    switch (f) {
      case 0: x = 1; y = v; z = -u; break;   // +X
      case 1: x = -1; y = v; z = u; break;   // -X
      case 2: x = u; y = 1; z = -v; break;   // +Y
      case 3: x = u; y = -1; z = v; break;   // -Y
      case 4: x = u; y = v; z = 1; break;    // +Z
      default: x = -u; y = v; z = -1; break; // -Z
    }
    const l = 1 / Math.sqrt(x * x + y * y + z * z);
    out[0] = x * l; out[1] = y * l; out[2] = z * l; return out;
  }
  // direction → (u,v) on a given face (may lie outside [-1,1])
  function dirToFaceUV(f, x, y, z, out) {
    let u, v;
    switch (f) {
      case 0: u = -z / x; v = y / x; break;
      case 1: u = z / -x; v = y / -x; break;
      case 2: u = x / y; v = -z / y; break;
      case 3: u = x / -y; v = z / -y; break;
      case 4: u = x / z; v = y / z; break;
      default: u = -x / -z; v = y / -z; break;
    }
    out[0] = u; out[1] = v; return out;
  }
  function majorFace(x, y, z) {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    if (ax >= ay && ax >= az) return x > 0 ? 0 : 1;
    if (ay >= az) return y > 0 ? 2 : 3;
    return z > 0 ? 4 : 5;
  }

  // ── the planet's height field ──────────────────────────────────────────
  // o: {seed, R (units), geo: fn(lat,lon)->units | null, geoMix (detail
  //     weight where geo applies), sea: bool}
  function PlanetField(o) {
    this.seed = o.seed | 0; this.R = o.R; this.geo = o.geo || null; this.geoMix = o.geoMix != null ? o.geoMix : 0.55;
    this.sea = !!o.sea; this.noise = new Noise3(this.seed * 7919 + 17);
    this.ero = null;                                    // {N, P, faces:[Float32Array]} once baked
    this.eroScale = 1;
  }
  // the game's terrain recipe, in 3-D (p in units). `sp` = the sample
  // spacing it's being drawn at: octaves finer than that are skipped (a far
  // tile can't show them), so distant tiles cost a fraction of near ones.
  const oct = (f, max, sp) => { if (!sp) return max; const o = Math.floor(Math.log2(1 / (f * sp * 0.7))) + 1; return o < 1 ? 0 : (o > max ? max : o); };
  PlanetField.prototype.detail = function (px, py, pz, sp) {
    const N = this.noise, s = this.seed;
    let o = oct(0.012, 5, sp);
    let h = o ? N.fbm(px * 0.012 + 100, py * 0.012 + 37, pz * 0.012 + 100, o) * 22 : 0.47 * 22;
    o = oct(0.04, 3, sp); if (o) h += N.fbm(px * 0.04, py * 0.04 + 11, pz * 0.04, o) * 5; else h += 0.47 * 5;
    const m = N.fbm(px * 0.005 + 7, py * 0.005, pz * 0.005 + 7, Math.max(1, oct(0.005, 4, sp)));
    if (m > 0.6) h += (m - 0.6) * 120;
    const region = N.fbm(px * 0.0015 + s * 3.1, py * 0.0015 + 5, pz * 0.0015 + s * 3.1, 3);
    if (region > 0.35) {
      const mtWeight = Math.min(1, (region - 0.35) / 0.4);
      const r1 = 1 - Math.abs(N.fbm(px * 0.006 + 21, py * 0.006, pz * 0.006 + 21, Math.max(1, oct(0.006, 4, sp))) * 2 - 1);
      o = oct(0.018, 3, sp);
      const r2 = o ? 1 - Math.abs(N.fbm(px * 0.018 + 27, py * 0.018 + 3, pz * 0.018 + 27, o) * 2 - 1) : 0.6;
      const mountain = r1 * r1 * 180 + r2 * r2 * 40;
      const terrace = N.fbm(px * 0.003 + 33, py * 0.003 + 9, pz * 0.003 + 33, 3);
      const plateau = Math.floor(terrace * 6) * 28;
      h += mtWeight * (mountain * 0.65 + plateau * 0.55);
    }
    if (!sp || sp < 60) {          // canyons/rivers are narrow: only where they can be seen
      const canyon = 1 - Math.abs(N.fbm(px * 0.01 + s * 5.3, py * 0.01 + 61, pz * 0.01 + s * 5.3, 4) * 2 - 1);
      if (canyon > 0.99) h -= Math.pow((canyon - 0.99) / 0.01, 1.5) * 90;
      const river = 1 - Math.abs(N.fbm(px * 0.006 + s * 7.1, py * 0.006 + 71, pz * 0.006 + s * 7.1, 4) * 2 - 1);
      if (river > 0.97) h -= Math.pow((river - 0.97) / 0.03, 1.2) * 22;
    }
    return h;
  };
  // height before erosion
  PlanetField.prototype.base = function (dx, dy, dz, sp) {
    const R = this.R, d = this.detail(dx * R, dy * R, dz * R, sp);
    if (!this.geo) return d;
    const lat = Math.asin(Math.max(-1, Math.min(1, dy))) * 180 / PI, lon = Math.atan2(dz, dx) * 180 / PI;
    return d * this.geoMix + this.geo(lat, lon);
  };
  PlanetField.prototype.height = function (dx, dy, dz, sp) {
    const h = this.base(dx, dy, dz, sp);
    return this.ero ? h + this.erosionAt(dx, dy, dz) * this.eroScale : h;
  };
  // ── erosion map: padded cube faces, sampled with a cross-fade at the seams
  const _uv = [0, 0];
  PlanetField.prototype._eroFace = function (f, x, y, z) {
    const E = this.ero, N = E.N, P = E.P, W = N + 2 * P;
    dirToFaceUV(f, x, y, z, _uv);
    const gx = (_uv[0] + 1) * 0.5 * N + P - 0.5, gy = (_uv[1] + 1) * 0.5 * N + P - 0.5;
    if (gx < 0 || gy < 0 || gx > W - 1.001 || gy > W - 1.001) return null;
    const ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy, a = E.faces[f], k = iy * W + ix;
    return (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fy) + (a[k + W] * (1 - fx) + a[k + W + 1] * fx) * fy;
  };
  PlanetField.prototype.erosionAt = function (x, y, z) {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    // the two closest faces: blend across the seam band so it never shows
    let f1, f2, m1, m2;
    if (ax >= ay && ax >= az) { f1 = x > 0 ? 0 : 1; m1 = ax; if (ay >= az) { f2 = y > 0 ? 2 : 3; m2 = ay; } else { f2 = z > 0 ? 4 : 5; m2 = az; } }
    else if (ay >= az) { f1 = y > 0 ? 2 : 3; m1 = ay; if (ax >= az) { f2 = x > 0 ? 0 : 1; m2 = ax; } else { f2 = z > 0 ? 4 : 5; m2 = az; } }
    else { f1 = z > 0 ? 4 : 5; m1 = az; if (ax >= ay) { f2 = x > 0 ? 0 : 1; m2 = ax; } else { f2 = y > 0 ? 2 : 3; m2 = ay; } }
    const e1 = this._eroFace(f1, x, y, z);
    const band = (this.ero.P / this.ero.N) * 0.9;        // in u units (=m2/m1 distance from the edge)
    const t = 1 - m2 / m1;                               // 0 at the seam
    if (t >= band) return e1 || 0;
    const e2 = this._eroFace(f2, x, y, z);
    if (e1 == null) return e2 || 0; if (e2 == null) return e1;
    const w = 0.5 + 0.5 * (t / band);                    // 0.5 at the seam → 1 inside the face
    return e1 * w + e2 * (1 - w);
  };

  // Particle hydraulic erosion on one padded face grid (heights in texel
  // units). Droplets roll downhill, pick up sediment where water speeds up,
  // drop it where it slows, and evaporate; returns the change in height.
  function erodeGrid(h, W, droplets, seed, opt) {
    opt = opt || {};
    const inertia = opt.inertia != null ? opt.inertia : 0.05, capK = opt.capacity || 4, minCap = 0.01;
    const depK = opt.deposit != null ? opt.deposit : 0.3, eroK = opt.erode != null ? opt.erode : 0.3;
    const evap = opt.evaporate != null ? opt.evaporate : 0.015, grav = opt.gravity || 4, life = opt.life || 32, R = opt.radius || 3;
    const orig = Float32Array.from(h);
    // erosion brush (weights over a disc)
    const bOff = [], bW = []; let wsum = 0;
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) { const d = Math.sqrt(x * x + y * y); if (d < R) { bOff.push([x, y]); const w = 1 - d / R; bW.push(w); wsum += w; } }
    for (let i = 0; i < bW.length; i++) bW[i] /= wsum;
    let s = (seed >>> 0) || 7;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const hg = (px, py) => {                                  // height + gradient (bilinear)
      const x = px | 0, y = py | 0, u = px - x, v = py - y, k = y * W + x;
      const a = h[k], b = h[k + 1], c = h[k + W], d = h[k + W + 1];
      return [a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v, (b - a) * (1 - v) + (d - c) * v, (c - a) * (1 - u) + (d - b) * u];
    };
    for (let n = 0; n < droplets; n++) {
      let px = 1 + rnd() * (W - 3), py = 1 + rnd() * (W - 3), dx = 0, dy = 0, sp = 1, water = 1, sed = 0;
      for (let step = 0; step < life; step++) {
        const x0 = px | 0, y0 = py | 0, cu = px - x0, cv = py - y0;
        const g = hg(px, py);
        dx = dx * inertia - g[1] * (1 - inertia); dy = dy * inertia - g[2] * (1 - inertia);
        const len = Math.sqrt(dx * dx + dy * dy); if (len < 1e-9) break;
        dx /= len; dy /= len; px += dx; py += dy;
        if (px < 1 || py < 1 || px >= W - 2 || py >= W - 2) break;
        const dh = hg(px, py)[0] - g[0];
        const cap = Math.max(-dh * sp * water * capK, minCap);
        if (sed > cap || dh > 0) {                            // deposit (fill pits, slow water)
          const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * depK;
          sed -= amt; const k = y0 * W + x0;
          h[k] += amt * (1 - cu) * (1 - cv); h[k + 1] += amt * cu * (1 - cv); h[k + W] += amt * (1 - cu) * cv; h[k + W + 1] += amt * cu * cv;
        } else {                                              // erode with the brush
          const amt = Math.min((cap - sed) * eroK, -dh);
          for (let i = 0; i < bOff.length; i++) {
            const bx = x0 + bOff[i][0], by = y0 + bOff[i][1]; if (bx < 0 || by < 0 || bx >= W || by >= W) continue;
            const k = by * W + bx, e = amt * bW[i];
            h[k] -= e; sed += e;
          }
        }
        sp = Math.sqrt(Math.max(0, sp * sp + dh * grav)); water *= 1 - evap;
      }
    }
    const out = new Float32Array(h.length);
    for (let i = 0; i < h.length; i++) out[i] = h[i] - orig[i];
    return out;
  }
  // Bake the whole planet's erosion map. Yields between faces (await) so the
  // page stays responsive; `progress(f)` is called as faces finish.
  PlanetField.prototype.bakeErosion = async function (N, opt) {
    opt = opt || {};
    const P = opt.pad || Math.max(6, Math.round(N / 12)), W = N + 2 * P, R = this.R;
    const texel = (PI / 2 * R) / N, faces = [], dir = [0, 0, 0];
    const wasEro = this.ero; this.ero = null;
    for (let f = 0; f < 6; f++) {
      const h = new Float32Array(W * W);
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        const u = -1 + (i - P + 0.5) * (2 / N), v = -1 + (j - P + 0.5) * (2 / N);
        faceDir(f, u, v, dir);
        h[j * W + i] = this.base(dir[0], dir[1], dir[2], texel) / texel;   // texel units
      }
      const d = erodeGrid(h, W, Math.round(N * N * (opt.density || 0.6)), (this.seed * 131 + f * 977) >>> 0, opt);
      for (let i = 0; i < d.length; i++) d[i] *= texel;              // back to world units
      faces.push(d);
      if (opt.progress) try { opt.progress(f + 1); } catch (e) {}
      await new Promise((r) => setTimeout(r, 0));
    }
    this.ero = { N, P, faces }; void wasEro;
    return this.ero;
  };
  PlanetField.prototype.setErosion = function (e) { this.ero = e; };

  // ── local frame at a site (floating origin) ────────────────────────────
  // x = east, z = south, y = up; origin on the sea-level sphere under the site
  function Frame(R, lat, lon) { this.R = R; this.set(lat, lon); }
  Frame.prototype.set = function (lat, lon) {
    const la = lat * PI / 180, lo = lon * PI / 180;
    this.lat = lat; this.lon = lon;
    this.up = [Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)];
    this.east = [-Math.sin(lo), 0, Math.cos(lo)];
    const north = [-Math.sin(la) * Math.cos(lo), Math.cos(la), -Math.sin(la) * Math.sin(lo)];
    this.south = [-north[0], -north[1], -north[2]];
    if (Math.abs(Math.cos(la)) < 1e-6) { this.east = [0, 0, 1]; this.south = [1, 0, 0]; }
  };
  Frame.prototype.toPlanet = function (x, y, z, out) {
    const R = this.R, U = this.up, E = this.east, S = this.south;
    out = out || [0, 0, 0];
    out[0] = U[0] * (R + y) + E[0] * x + S[0] * z; out[1] = U[1] * (R + y) + E[1] * x + S[1] * z; out[2] = U[2] * (R + y) + E[2] * x + S[2] * z;
    return out;
  };
  Frame.prototype.toLocal = function (px, py, pz, out) {
    const R = this.R, U = this.up, E = this.east, S = this.south;
    const vx = px - U[0] * R, vy = py - U[1] * R, vz = pz - U[2] * R;
    out = out || [0, 0, 0];
    out[0] = vx * E[0] + vy * E[1] + vz * E[2]; out[1] = vx * U[0] + vy * U[1] + vz * U[2]; out[2] = vx * S[0] + vy * S[1] + vz * S[2];
    return out;
  };
  // ground height (local y) under local (x,z): the point of the planet's
  // surface whose local x/z are (x,z) — two fixed-point refinements
  const _p = [0, 0, 0], _l = [0, 0, 0];
  Frame.prototype.surfaceY = function (field, x, z, hfn) {
    let qx = x, qz = z, y = 0;
    for (let it = 0; it < 3; it++) {
      this.toPlanet(qx, 0, qz, _p);
      const l = Math.sqrt(_p[0] * _p[0] + _p[1] * _p[1] + _p[2] * _p[2]);
      const dx = _p[0] / l, dy = _p[1] / l, dz = _p[2] / l;
      const r = this.R + (hfn ? hfn(dx, dy, dz) : field.height(dx, dy, dz));
      this.toLocal(dx * r, dy * r, dz * r, _l);
      y = _l[1];
      qx += x - _l[0]; qz += z - _l[2];
    }
    return y;
  };
  Frame.prototype.seaY = function (x, z) {               // sea-level sphere, local y
    const R = this.R, d2 = x * x + z * z;
    return d2 < R * R ? Math.sqrt(R * R - d2) - R : -R;
  };
  Frame.prototype.latLonAt = function (x, z) {
    this.toPlanet(x, 0, z, _p);
    const l = Math.sqrt(_p[0] * _p[0] + _p[1] * _p[1] + _p[2] * _p[2]);
    return { lat: Math.asin(_p[1] / l) * 180 / PI, lon: Math.atan2(_p[2], _p[0]) * 180 / PI };
  };
  // A matrix (column-major 4x4 array) taking planet coords → local coords.
  Frame.prototype.planetToLocalMatrix = function () {
    const R = this.R, U = this.up, E = this.east, S = this.south;
    const tx = -R * (U[0] * E[0] + U[1] * E[1] + U[2] * E[2]), ty = -R, tz = -R * (U[0] * S[0] + U[1] * S[1] + U[2] * S[2]);
    return [E[0], U[0], S[0], 0, E[1], U[1], S[1], 0, E[2], U[2], S[2], 0, tx, ty, tz, 1];
  };

  // ── colours ────────────────────────────────────────────────────────────
  // biome by absolute height above sea level, slope, latitude and erosion
  function biome(out, h, slope, lat, ero, n, pal) {
    const sm = (e0, e1, v) => { const u = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return u * u * (3 - 2 * u); };
    const la = Math.abs(lat);
    const snowDrop = la > 55 ? Math.min(60, (la - 55) * 2) : (la > 30 ? (la - 30) * 0.6 : 0);
    const snowLine = 95 + n * 10 - snowDrop, rockLine = 62 + n * 10 - snowDrop * 0.3, dirtLine = 28 + n * 6;
    let wSnow = sm(snowLine - 8, snowLine + 8, h) * (1 - slope * 0.6);
    let wRock = Math.max(sm(rockLine - 10, rockLine + 10, h), sm(0.34, 0.7, slope)) * (1 - wSnow * 0.85);
    // carved channels show rock and gravel, deposits show soil and sand
    wRock = Math.min(1, wRock + Math.max(0, -ero) * 0.06);
    const wDirt = sm(dirtLine - 6, dirtLine + 8, h) * (1 - wRock) * (1 - wSnow) * 0.7 + Math.max(0, ero) * 0.03;
    const wSand = pal.water ? sm(5, -1, h) * (1 - wRock) * (1 - wSnow) : 0;
    const wGrass = Math.max(0, 1 - wSnow - wRock - wSand - Math.min(1, wDirt));
    const g1 = pal.ground, g2 = pal.ground2, rk = pal.rock;
    const t = 0.15 + n * 0.25;
    const gr = g1[0] + (g2[0] - g1[0]) * t, gg = g1[1] + (g2[1] - g1[1]) * t, gb = g1[2] + (g2[2] - g1[2]) * t;
    const rr = rk[0] * (1 + n * 0.15), rg = rk[1] * (1 + n * 0.15), rb = rk[2] * (1 + n * 0.15);
    const D = [0.42, 0.33, 0.25], SA = [0.8, 0.72, 0.48], SN = [0.95, 0.96, 0.98];
    const wd = Math.min(1, wDirt);
    out[0] = gr * wGrass + rr * wRock + D[0] * wd + SA[0] * wSand + SN[0] * wSnow;
    out[1] = gg * wGrass + rg * wRock + D[1] * wd + SA[1] * wSand + SN[1] * wSnow;
    out[2] = gb * wGrass + rb * wRock + D[2] * wd + SA[2] * wSand + SN[2] * wSnow;
    return out;
  }

  // ── cube-sphere quadtree LOD ───────────────────────────────────────────
  // o: {tier, pal:{ground,ground2,rock as [r,g,b] 0..1, water}, material,
  //     seaMaterial, budgetMs}
  const LOD_BY_TIER = {
    // finest vertex spacing near you ≈ (π/2·R / 2^maxDepth) / seg: on an
    // Earth-size world ~3 units (Low), 1.5 (Medium), 1 (High), 0.6 (Ultra)
    low: { seg: 16, k: 1.15, maxDepth: 8, budget: 3 },
    medium: { seg: 16, k: 1.35, maxDepth: 9, budget: 4 },
    high: { seg: 24, k: 1.5, maxDepth: 9, budget: 5 },
    ultra: { seg: 20, k: 1.7, maxDepth: 10, budget: 7 },
  };
  function PlanetLOD(THREE, parent, field, frame, o) {
    this.THREE = THREE; this.field = field; this.frame = frame; this.o = o;
    const t = LOD_BY_TIER[o.tier] || LOD_BY_TIER.medium;
    this.seg = t.seg; this.k = t.k; this.maxDepth = o.maxDepth || t.maxDepth; this.budget = o.budgetMs || t.budget;
    this.group = new THREE.Group(); this.group.name = 'JOTS_PlanetLOD'; this.group.matrixAutoUpdate = false;
    parent.add(this.group);
    this.mat = o.material; this.seaMat = o.seaMaterial || null;
    this.viewDist = o.viewDist || 1e9;                  // tiles further than this (fog) are hidden
    this.maxRelief = o.maxRelief || 400;                // tallest terrain: how far beyond the horizon peaks still show
    this.roots = []; this.queue = []; this.built = 0; this.live = 0;
    for (let f = 0; f < 6; f++) this.roots.push(this._node(f, -1, -1, 2, 0, null));
    this.applyFrame();
    this._cam = [0, 0, 0];
  }
  PlanetLOD.prototype._node = function (f, u0, v0, size, depth, parent) {
    const c = faceDir(f, u0 + size / 2, v0 + size / 2, [0, 0, 0]);
    // a face spans 90°, so a node is size·π/4 radians wide; arc = its half-diagonal
    const width = size * PI / 4, arc = width * 0.72;
    return { f, u0, v0, size, depth, parent, kids: null, mesh: null, sea: null, c, arc, width, want: false, pending: false, minH: 0, maxH: 0 };
  };
  PlanetLOD.prototype.applyFrame = function () {
    const m = this.frame.planetToLocalMatrix();
    this.group.matrix.fromArray(m); this.group.matrixWorldNeedsUpdate = true;
  };
  // camera in local frame coords → keep the tree refined around it
  PlanetLOD.prototype.update = function (camLocal) {
    const P = this.frame.toPlanet(camLocal.x, camLocal.y, camLocal.z, this._cam);
    const R = this.field.R, cl = Math.sqrt(P[0] * P[0] + P[1] * P[1] + P[2] * P[2]);
    const camAlt = Math.max(1, cl - R);
    // how far around the sphere you can see: your horizon plus how far
    // beyond it a peak of the tallest relief still pokes up
    const horizon = Math.acos(Math.min(1, R / (R + camAlt))) + Math.acos(R / (R + this.maxRelief)) + 0.01;
    const cd = [P[0] / cl, P[1] / cl, P[2] / cl];
    this.queue.length = 0;
    for (const r of this.roots) this._visit(r, P, cd, camAlt, horizon);
    // build what's wanted, nearest first, within the time budget
    this.queue.sort((a, b) => a._pri - b._pri);
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    for (let i = 0; i < this.queue.length; i++) {
      this._build(this.queue[i]);
      if ((typeof performance !== 'undefined' ? performance : Date).now() - t0 > this.budget) break;
    }
    for (const r of this.roots) this._show(r);
    return this.queue.length;
  };
  PlanetLOD.prototype._visit = function (n, P, cd, camAlt, horizon) {
    const R = this.field.R;
    const ang = Math.acos(Math.max(-1, Math.min(1, n.c[0] * cd[0] + n.c[1] * cd[1] + n.c[2] * cd[2])));
    const dist = Math.sqrt(Math.pow(Math.max(0, ang - n.arc) * R, 2) + camAlt * camAlt);
    const beyond = ang - n.arc > horizon || (dist > Math.max(this.viewDist, camAlt * 4) && n.depth > 0);
    n._pri = dist; n._hidden = beyond && n.depth > 0;
    const split = !beyond && n.depth < this.maxDepth && dist < n.width * R * this.k;
    if (split) {
      if (!n.kids) { const h = n.size / 2; n.kids = [this._node(n.f, n.u0, n.v0, h, n.depth + 1, n), this._node(n.f, n.u0 + h, n.v0, h, n.depth + 1, n), this._node(n.f, n.u0, n.v0 + h, h, n.depth + 1, n), this._node(n.f, n.u0 + h, n.v0 + h, h, n.depth + 1, n)]; }
      // a split tile only needs its own mesh when nothing coarser above it is
      // there to show while its children build
      if (!n.mesh && !this._hasFallback(n)) this.queue.push(n);
      for (const k of n.kids) this._visit(k, P, cd, camAlt, horizon);
    } else {
      if (n.kids) { this._drop(n.kids); n.kids = null; }
      if (!n.mesh && !n._hidden) this.queue.push(n);
    }
  };
  PlanetLOD.prototype._ready = function (n) { return n._hidden || (n.kids ? n.kids.every((k) => this._ready(k)) : !!n.mesh); };
  PlanetLOD.prototype._hasFallback = function (n) { for (let p = n.parent; p; p = p.parent) if (p.mesh) return true; return false; };
  PlanetLOD.prototype._show = function (n) {
    const useKids = n.kids && n.kids.every((k) => this._ready(k));
    const vis = !useKids && !n._hidden;
    if (n.mesh) { n.mesh.visible = vis; if (n.sea) n.sea.visible = vis; }
    if (n.kids) for (const k of n.kids) { if (useKids) this._show(k); else this._hide(k); }
  };
  PlanetLOD.prototype._hide = function (n) { if (n.mesh) n.mesh.visible = false; if (n.sea) n.sea.visible = false; if (n.kids) for (const k of n.kids) this._hide(k); };
  PlanetLOD.prototype._drop = function (list) {
    for (const n of list) {
      if (n.kids) this._drop(n.kids);
      for (const m of [n.mesh, n.sea]) if (m) { this.group.remove(m); m.geometry.dispose(); }
      if (n.mesh) this.live--;
      n.mesh = n.sea = null; n.kids = null;
    }
  };
  // one tile: (seg+1)² surface vertices + a skirt, positions relative to the
  // tile centre (planet coords) so float precision holds at planet scale
  PlanetLOD.prototype._build = function (n) {
    const THREE = this.THREE, F = this.field, R = F.R, seg = this.seg, S1 = seg + 1;
    const step = n.size / seg, dir = [0, 0, 0], spacing = step * R * 0.8;
    // heights on a grid with a one-cell border (for normals that match neighbours)
    const G = seg + 3, H = new Float32Array(G * G), D = new Float32Array(G * G * 3);
    let minH = 1e9, maxH = -1e9;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      faceDir(n.f, n.u0 + (i - 1) * step, n.v0 + (j - 1) * step, dir);
      const k = j * G + i, h = F.height(dir[0], dir[1], dir[2], spacing);
      H[k] = h; D[k * 3] = dir[0]; D[k * 3 + 1] = dir[1]; D[k * 3 + 2] = dir[2];
      if (i >= 1 && j >= 1 && i <= seg + 1 && j <= seg + 1) { if (h < minH) minH = h; if (h > maxH) maxH = h; }
    }
    n.minH = minH; n.maxH = maxH;
    const cx = n.c[0] * R, cy = n.c[1] * R, cz = n.c[2] * R;
    const nv = S1 * S1 + 4 * seg, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
    const P = (k, o) => { const r = R + H[k]; o[0] = D[k * 3] * r; o[1] = D[k * 3 + 1] * r; o[2] = D[k * 3 + 2] * r; return o; };
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0], q = [0, 0, 0], rgb = [0, 0, 0];
    const pal = this.o.pal, N3 = F.noise, skirt = Math.max(2, n.size * R * 0.004);
    for (let j = 0; j < S1; j++) for (let i = 0; i < S1; i++) {
      const k = (j + 1) * G + (i + 1), v = j * S1 + i;
      P(k, q);
      pos[v * 3] = q[0] - cx; pos[v * 3 + 1] = q[1] - cy; pos[v * 3 + 2] = q[2] - cz;
      P(k + 1, a); P(k - 1, b); P(k + G, c); P(k - G, d);
      let nx = (a[1] - b[1]) * (c[2] - d[2]) - (a[2] - b[2]) * (c[1] - d[1]);
      let ny = (a[2] - b[2]) * (c[0] - d[0]) - (a[0] - b[0]) * (c[2] - d[2]);
      let nz = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
      const dx = D[k * 3], dy = D[k * 3 + 1], dz = D[k * 3 + 2];
      if (nx * dx + ny * dy + nz * dz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
      const slope = 1 - Math.max(0, nx * dx + ny * dy + nz * dz);
      const lat = Math.asin(dy) * 180 / PI;
      const nn = spacing < 25 ? N3.fbm(q[0] * 0.08, q[1] * 0.08, q[2] * 0.08, 2) - 0.5 : N3.n(q[0] * 0.01, q[1] * 0.01, q[2] * 0.01) * 0.35;
      const ero = F.ero ? F.erosionAt(dx, dy, dz) : 0;
      biome(rgb, H[k], Math.min(1, slope * 2.2), lat, ero, nn, pal);
      col[v * 3] = rgb[0]; col[v * 3 + 1] = rgb[1]; col[v * 3 + 2] = rgb[2];
    }
    // skirt: the edge ring again, pulled down toward the planet centre
    let sv = S1 * S1;
    const edge = [];
    for (let i = 0; i < seg; i++) edge.push(i);                       // bottom row
    for (let j = 0; j < seg; j++) edge.push(j * S1 + seg);            // right col
    for (let i = seg; i > 0; i--) edge.push(seg * S1 + i);            // top row
    for (let j = seg; j > 0; j--) edge.push(j * S1);                  // left col
    for (let e = 0; e < edge.length; e++, sv++) {
      const v = edge[e];
      const px = pos[v * 3] + cx, py = pos[v * 3 + 1] + cy, pz = pos[v * 3 + 2] + cz, l = Math.sqrt(px * px + py * py + pz * pz);
      const s = (l - skirt) / l;
      pos[sv * 3] = px * s - cx; pos[sv * 3 + 1] = py * s - cy; pos[sv * 3 + 2] = pz * s - cz;
      nor[sv * 3] = nor[v * 3]; nor[sv * 3 + 1] = nor[v * 3 + 1]; nor[sv * 3 + 2] = nor[v * 3 + 2];
      col[sv * 3] = col[v * 3]; col[sv * 3 + 1] = col[v * 3 + 1]; col[sv * 3 + 2] = col[v * 3 + 2];
    }
    const idx = [];
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const v0 = j * S1 + i, v1 = v0 + 1, v2 = v0 + S1, v3 = v2 + 1;
      idx.push(v0, v2, v1, v1, v2, v3);
    }
    for (let e = 0; e < edge.length; e++) {
      const a0 = edge[e], a1 = edge[(e + 1) % edge.length], b0 = S1 * S1 + e, b1 = S1 * S1 + ((e + 1) % edge.length);
      idx.push(a0, b0, a1, a1, b0, b1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.position.set(cx, cy, cz); mesh.visible = false; mesh.userData.planetTile = true;
    if (this.o.shadows) { mesh.receiveShadow = true; }
    this.group.add(mesh); n.mesh = mesh; this.live++; this.built++;
    // ocean over any part of the tile below sea level: a curved sea tile
    if (F.sea && this.seaMat && minH < 0.5) {
      const ss = Math.max(4, seg >> 1), S2 = ss + 1, sp = new Float32Array(S2 * S2 * 3), sidx = [];
      for (let j = 0; j < S2; j++) for (let i = 0; i < S2; i++) {
        faceDir(n.f, n.u0 + i * n.size / ss, n.v0 + j * n.size / ss, dir);
        const v = j * S2 + i; sp[v * 3] = dir[0] * R - cx; sp[v * 3 + 1] = dir[1] * R - cy; sp[v * 3 + 2] = dir[2] * R - cz;
      }
      for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const v0 = j * S2 + i; sidx.push(v0, v0 + S2, v0 + 1, v0 + 1, v0 + S2, v0 + S2 + 1); }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setIndex(sidx); sg.computeVertexNormals(); sg.computeBoundingSphere();
      const sea = new THREE.Mesh(sg, this.seaMat); sea.position.set(cx, cy, cz); sea.visible = false; sea.renderOrder = 1; sea.userData.isWaterSurface = true;
      this.group.add(sea); n.sea = sea;
    }
  };
  PlanetLOD.prototype.dispose = function () {
    this._drop(this.roots); this.roots = [];
    if (this.group.parent) this.group.parent.remove(this.group);
  };
  PlanetLOD.prototype.stats = function () {
    let vis = 0, tri = 0, sea = 0; this.group.children.forEach((m) => { if (m.visible) { if (m.userData.planetTile) { vis++; tri += m.geometry.index ? m.geometry.index.count / 3 : 0; } else sea++; } });
    return { live: this.live, built: this.built, visible: vis, sea, triangles: tri, pending: this.queue.length };
  };

  // ── erosion cache (IndexedDB) ──────────────────────────────────────────
  const DB = 'dm-planets', STORE = 'erosion';
  function idb() {
    return new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function cacheGet(key) {
    try { const db = await idb(); return await new Promise((res) => { const t = db.transaction(STORE, 'readonly').objectStore(STORE).get(key); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }); } catch (e) { return null; }
  }
  async function cachePut(key, val) {
    try { const db = await idb(); await new Promise((res) => { const t = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key); t.onsuccess = () => res(); t.onerror = () => res(); }); } catch (e) {}
  }
  // erosion for a planet: from the cache, or baked once and stored
  async function erosionFor(field, key, N, opt) {
    const k = key + '|N' + N + '|v1';
    const hit = await cacheGet(k);
    if (hit && hit.N === N && hit.faces && hit.faces.length === 6) { field.setErosion(hit); return { cached: true, ero: hit }; }
    const ero = await field.bakeErosion(N, opt);
    cachePut(k, { N: ero.N, P: ero.P, faces: ero.faces });
    return { cached: false, ero };
  }

  const ERO_N_BY_TIER = { low: 96, medium: 128, high: 160, ultra: 192 };
  const api = { Noise3, PlanetField, Frame, PlanetLOD, erodeGrid, erosionFor, faceDir, dirToFaceUV, majorFace, biome, LOD_BY_TIER, ERO_N_BY_TIER,
    setSpread(s) { FBM_SPREAD = s; } };
  if (typeof window !== 'undefined') window.DMPlanet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
