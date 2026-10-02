/* DART Meadow — live water (SPH particles) around the pilot.
 *
 * A patch of smoothed-particle-hydrodynamics water that follows the player
 * on worlds with liquid. Her body is a moving rigid body in it (she pushes
 * water aside and drags it along as she swims), wind gusts ripple the
 * surface, the world's moons pull a slow tidal current, and fast, broken
 * water throws up foam and spray. Particle count follows the graphics tier.
 *
 * Simulation kernels and steps (density / near-density with spiky kernels,
 * shared-pressure force, Poly6 viscosity, predicted positions, trapped-air
 * foam rule) are ported from Sebastian Lague's Fluid-Sim, MIT licence,
 * github.com/SebLague/Fluid-Sim — as used by ArcLake (radicaldeepscale.com).
 * Foam/spray/bubbles after Ihmsen et al. 2012, "Unified spray, foam and
 * bubbles for particle-based fluids". See CREDITS.md.
 *
 * The patch is periodic in x/z (water leaving one side comes back on the
 * other, with neighbours found across the seam), so it reads as part of an
 * endless body of water, and it re-centres on the player in whole tiles.
 */
(function () {
  'use strict';
  const PI = Math.PI;

  // Particles per graphics tier. Spacing stays the same; the patch grows.
  const TIER_COUNT = { low: 700, medium: 1200, high: 1800, ultra: 2600 };

  // ── simulation core (no THREE; runs in Node for tests) ───────────────
  function Core(o) {
    this.s = o.spacing || 1.0;                 // rest spacing (world units)
    this.h = this.s * 2.0;                     // smoothing radius
    this.depth = o.depth || 3.0;               // simulated slab depth
    // whole layers only: a part-filled top layer would read as bumps on calm water
    const layers = Math.max(1, Math.round(this.depth / this.s)), per = Math.max(3, Math.round(Math.sqrt((o.count | 0) / layers)));
    const n = per * per * layers;
    this.n = n;
    this.restY = o.restY || 0;                 // where the slab's top settles
    this.g = o.gravity != null ? o.gravity : 16;
    this.floor = o.floor || (() => -1e9);
    this.substeps = o.substeps || 2;
    // patch footprint: square, sized so `count` particles fill the slab
    this.L = per * this.s;
    this.cx = o.cx || 0; this.cz = o.cz || 0;
    // kernels (Lague, 3-D)
    const h = this.h;
    this.kP2 = 15 / (2 * PI * Math.pow(h, 5));
    this.kP3 = 15 / (PI * Math.pow(h, 6));
    this.kP2g = 15 / (PI * Math.pow(h, 5));
    this.kP3g = 45 / (PI * Math.pow(h, 6));
    this.kPoly6 = 315 / (64 * PI * Math.pow(h, 9));
    this._buildBoundary();
    // stiffness ~ c², c ≈ 4·sqrt(g·depth): weakly compressible, stable at dt/substeps
    const c = 4 * Math.sqrt(this.g * this.depth);
    this.k = o.pressure || c * c;
    this.kNear = o.nearPressure || this.k * 0.013 * h;
    this.visc = o.viscosity != null ? o.viscosity : 0.3;
    this.damp = 0.6;
    this.pos = new Float32Array(n * 3);
    this.pred = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.dens = new Float32Array(n);
    this.near = new Float32Array(n);
    this.nbCount = new Uint16Array(n);
    this.trapped = new Float32Array(n);
    // grid (periodic in x/z)
    this.nxz = Math.max(3, Math.floor(this.L / h));
    this.cell = this.L / this.nxz;
    this.ny = 0; this.y0 = 0;
    this.cellStart = null; this.cellCount = null; this.sorted = new Int32Array(n); this.cellOf = new Int32Array(n);
    this.time = 0;
    this.floorFn = this.floor;
    this.dryY = this.restY - 0.25;            // a column whose ground is above this is shore / land
    this._buildFloor();
    this.floor = (x, z) => this._floorAt(x, z);
    this._spawn();
    this._relocateDry();
    this.rho0 = o.targetDensity || this._measureRest();
    this.bottom = this.restY - this.depth;
    // Let it settle (it compresses a little under gravity), then lift the
    // whole slab so its settled top sits just under restY (the water plane).
    if (o.settle !== false) {
      for (let k = 0; k < 90; k++) this._substep(1 / 60, [], {});
      const na = this.nAct; if (!na) return;
      const ys = []; for (let i = 0; i < na; i++) ys.push(this.pos[i * 3 + 1]);
      ys.sort((a, b) => b - a);
      const m = Math.max(1, Math.floor(na / 8)); let top = 0; for (let i = 0; i < m; i++) top += ys[i]; top /= m;
      const dy = (this.restY - 0.55 * this.s) - top;
      for (let i = 0; i < na; i++) { this.pos[i * 3 + 1] += dy; this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0; }
      this.bottom += dy; this.time = 0;
    }
  }
  // The slab is the top of deep water (or sits on the seabed in shallows), so
  // below its floor we count virtual water: a semi-infinite lattice whose
  // density, near-density and upward pressure push are tabulated by height
  // above the floor. Without it the bottom layer sees half a kernel and the
  // layer above sinks into it.
  Core.prototype._buildBoundary = function () {
    const s = this.s, h = this.h, B = 48, D = this.bD = new Float32Array(B + 1), DN = this.bDN = new Float32Array(B + 1);
    const FY = this.bFY = new Float32Array(B + 1), FNY = this.bFNY = new Float32Array(B + 1);
    const R = Math.ceil(h / s) + 1;
    for (let b = 0; b <= B; b++) {
      const d = (b / B) * h;
      let dd = 0, dn = 0, fy = 0, fny = 0, cnt = 0;
      // average over a few horizontal offsets of the particle against the lattice
      for (const [ox, oz] of [[0, 0], [0.5, 0], [0, 0.5], [0.5, 0.5]]) {
        cnt++;
        for (let ly = 0; ly < R; ly++) for (let lx = -R; lx <= R; lx++) for (let lz = -R; lz <= R; lz++) {
          const vx = (lx + ox) * s, vz = (lz + oz) * s, vy = -(ly + 0.5) * s - d;
          const r = Math.sqrt(vx * vx + vy * vy + vz * vz); if (r >= h || r < 1e-6) continue;
          const v = h - r, uy = vy / r;
          dd += v * v * this.kP2; dn += v * v * v * this.kP3;
          fy += uy * (-v * this.kP2g); fny += uy * (-v * v * this.kP3g);
        }
      }
      D[b] = dd / cnt; DN[b] = dn / cnt; FY[b] = fy / cnt; FNY[b] = fny / cnt;
    }
    this.bBins = B;
  };
  Core.prototype._bIdx = function (d) { const b = Math.round((d / this.h) * this.bBins); return b < 0 ? 0 : b > this.bBins ? -1 : b; };
  Core.prototype._spawn = function () {
    const n = this.n, s = this.s, L = this.L, per = Math.max(1, Math.round(L / s));
    let i = 0;
    for (let ly = 0; i < n; ly++) {
      for (let ix = 0; ix < per && i < n; ix++) for (let iz = 0; iz < per && i < n; iz++) {
        const x = this.cx - L / 2 + (ix + 0.5) * (L / per) + (ly % 2) * 0.25 * s;
        const z = this.cz - L / 2 + (iz + 0.5) * (L / per) + (ly % 2) * 0.25 * s;
        const y = this.restY - 0.5 * s - ly * s;
        this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
        i++;
      }
    }
  };
  // Ground under the patch, cached on a grid (the real height function can be
  // a raycast; once per re-centre is fine, once per particle per frame isn't).
  Core.prototype._buildFloor = function () {
    const nf = this.nf = Math.max(4, Math.ceil(this.L / this.s)), cs = this.L / nf, lo = this.cx - this.L / 2, lz = this.cz - this.L / 2;
    if (!this.fc || this.fc.length !== nf * nf) this.fc = new Float32Array(nf * nf);
    const wet = [];
    for (let iz = 0; iz < nf; iz++) for (let ix = 0; ix < nf; ix++) {
      let h = -1e9; try { h = this.floorFn(lo + (ix + 0.5) * cs, lz + (iz + 0.5) * cs); } catch (e) {}
      if (!isFinite(h)) h = -1e9;
      this.fc[iz * nf + ix] = h;
      if (h < this.dryY) wet.push(iz * nf + ix);
    }
    this.wetCells = wet; this.wetFrac = wet.length / (nf * nf);
  };
  Core.prototype._floorAt = function (x, z) {
    const nf = this.nf, cs = this.L / nf;
    let ix = Math.floor((x - (this.cx - this.L / 2)) / cs) % nf; if (ix < 0) ix += nf;
    let iz = Math.floor((z - (this.cz - this.L / 2)) / cs) % nf; if (iz < 0) iz += nf;
    return this.fc[iz * nf + ix];
  };
  // Only as many particles as the wet part of the patch holds are active
  // (the first nAct); the rest wait, parked, until more water comes into view.
  // Active particles over dry ground move to a random wet column.
  Core.prototype._relocateDry = function () {
    const W = this.wetCells, prev = this.nAct == null ? this.n : this.nAct;
    this.nAct = W && W.length ? Math.min(this.n, Math.round(this.n * Math.min(1, this.wetFrac * 1.02))) : 0;
    if (!this.nAct) return;
    const nf = this.nf, cs = this.L / nf, lo = this.cx - this.L / 2, lz = this.cz - this.L / 2;
    for (let i = 0; i < this.nAct; i++) {
      const x = this.pos[i * 3], z = this.pos[i * 3 + 2];
      if (i < prev && this._floorAt(x, z) < this.dryY) continue;
      const c = W[(Math.random() * W.length) | 0], ix = c % nf, iz = (c / nf) | 0;
      const nx = lo + (ix + Math.random()) * cs, nz = lz + (iz + Math.random()) * cs;
      const fl = this.fc[c], top = this.restY - 0.6 * this.s;
      this.pos[i * 3] = nx; this.pos[i * 3 + 2] = nz;
      this.pos[i * 3 + 1] = Math.max(fl + 0.3 * this.s, top - Math.random() * Math.max(0.1, Math.min(this.depth - this.s, top - fl)));
      this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
    }
  };
  Core.prototype._measureRest = function () {
    // density at a point inside an infinite lattice of this spacing
    const s = this.s, h = this.h, R = Math.ceil(h / s) + 1;
    let d = 0;
    for (let x = -R; x <= R; x++) for (let y = -R; y <= R; y++) for (let z = -R; z <= R; z++) {
      const r = Math.hypot(x, y, z) * s; if (r < h) { const v = h - r; d += v * v * this.kP2; }
    }
    return d;
  };
  // wrap a coordinate into the patch
  Core.prototype._wrap = function (v, c) { const L = this.L, lo = c - L / 2; v = (v - lo) % L; if (v < 0) v += L; return lo + v; };
  Core.prototype._dw = function (d) { const L = this.L; if (d > L / 2) d -= L; else if (d < -L / 2) d += L; return d; };
  // Bin predicted positions into a periodic grid, then build every
  // particle's neighbour list (index, distance, unit direction) once.
  Core.prototype._grid = function () {
    const n = this.nAct, P = this.pred, cs = this.cell, nxz = this.nxz, h = this.h, h2 = h * h, L = this.L, hL = L / 2;
    let ymin = 1e9, ymax = -1e9;
    for (let i = 0; i < n; i++) { const y = P[i * 3 + 1]; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    this.y0 = ymin - 1e-3; this.ny = Math.max(1, Math.min(64, Math.floor((ymax - this.y0) / h) + 1));
    const ny = this.ny, cells = nxz * nxz * ny;
    if (!this.cellCount || this.cellCount.length < cells) { this.cellCount = new Int32Array(cells); this.cellStart = new Int32Array(cells + 1); this._fill = new Int32Array(cells); }
    const cc = this.cellCount; cc.fill(0, 0, cells);
    const lo = this.cx - hL;
    const gxA = this._gx || (this._gx = new Int32Array(n)), gyA = this._gy || (this._gy = new Int32Array(n)), gzA = this._gz || (this._gz = new Int32Array(n));
    for (let i = 0; i < n; i++) {
      let gx = Math.floor((P[i * 3] - lo) / cs) % nxz; if (gx < 0) gx += nxz;
      let gz = Math.floor((P[i * 3 + 2] - lo) / cs) % nxz; if (gz < 0) gz += nxz;
      let gy = Math.floor((P[i * 3 + 1] - this.y0) / h); if (gy < 0) gy = 0; if (gy >= ny) gy = ny - 1;
      gxA[i] = gx; gyA[i] = gy; gzA[i] = gz;
      const c = (gy * nxz + gz) * nxz + gx; this.cellOf[i] = c; cc[c]++;
    }
    const st = this.cellStart; st[0] = 0;
    for (let c = 0; c < cells; c++) st[c + 1] = st[c] + cc[c];
    const fill = this._fill;
    for (let c = 0; c < cells; c++) fill[c] = st[c];
    for (let i = 0; i < n; i++) this.sorted[fill[this.cellOf[i]]++] = i;
    // neighbour lists
    const cap = this._nbCap || 0, want = n * 64;
    if (cap < want) { this._nbCap = want; this.nbJ = new Int32Array(want); this.nbR = new Float32Array(want); this.nbX = new Float32Array(want); this.nbY = new Float32Array(want); this.nbZ = new Float32Array(want); }
    if (!this.nbStart || this.nbStart.length < n + 1) this.nbStart = new Int32Array(n + 1);
    const NJ = this.nbJ, NR = this.nbR, NX = this.nbX, NY = this.nbY, NZ = this.nbZ, NS = this.nbStart, sorted = this.sorted;
    let w = 0;
    for (let i = 0; i < n; i++) {
      NS[i] = w;
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], gx = gxA[i], gy = gyA[i], gz = gzA[i];
      for (let oy = -1; oy <= 1; oy++) {
        const yy = gy + oy; if (yy < 0 || yy >= ny) continue;
        for (let oz = -1; oz <= 1; oz++) {
          let zz = gz + oz; if (zz < 0) zz += nxz; else if (zz >= nxz) zz -= nxz;
          for (let ox = -1; ox <= 1; ox++) {
            let xx = gx + ox; if (xx < 0) xx += nxz; else if (xx >= nxz) xx -= nxz;
            const c = (yy * nxz + zz) * nxz + xx;
            for (let k = st[c], e = st[c + 1]; k < e; k++) {
              const j = sorted[k];
              let dx = P[j * 3] - x; if (dx > hL) dx -= L; else if (dx < -hL) dx += L;
              const dy = P[j * 3 + 1] - y;
              let dz = P[j * 3 + 2] - z; if (dz > hL) dz -= L; else if (dz < -hL) dz += L;
              const r2 = dx * dx + dy * dy + dz * dz;
              if (r2 > h2 || w >= this._nbCap) continue;
              const r = Math.sqrt(r2);
              NJ[w] = j; NR[w] = r;
              if (r > 1e-6) { NX[w] = dx / r; NY[w] = dy / r; NZ[w] = dz / r; } else { NX[w] = 0; NY[w] = 1; NZ[w] = 0; }
              w++;
            }
          }
        }
      }
    }
    NS[n] = w;
  };
  Core.prototype._densities = function () {
    const h = this.h, kP2 = this.kP2, kP3 = this.kP3, NS = this.nbStart, NR = this.nbR;
    for (let i = 0; i < this.nAct; i++) {
      let d = 0, dn = 0;
      for (let k = NS[i], e = NS[i + 1]; k < e; k++) { const v = h - NR[k]; d += v * v * kP2; dn += v * v * v * kP3; }
      if (this.bD) {
        const y = this.pred[i * 3 + 1], fl = Math.max(this._floorAt(this.pred[i * 3], this.pred[i * 3 + 2]), this.bottom);
        const b = this._bIdx(y - fl); if (b >= 0) { d += this.bD[b]; dn += this.bDN[b]; }
      }
      this.dens[i] = d; this.near[i] = dn;
    }
  };
  // bodies: [{x,y,z,vx,vy,vz,r}], env: {wind:[x,z] air speed, gust 0..1, tide:[x,z] accel}
  Core.prototype.step = function (dt, bodies, env) {
    dt = Math.min(dt, 1 / 30);
    const sub = this.substeps, d = dt / sub;
    if (!this.nAct) return;
    for (let s = 0; s < sub; s++) this._substep(d, bodies || [], env || {});
  };
  Core.prototype._substep = function (dt, bodies, env) {
    const n = this.nAct; if (!n) return;
    const P = this.pos, Q = this.pred, V = this.vel, h = this.h;
    this.time += dt;
    const t = this.time, surf = this.restY - this.s * 1.2;
    const wx = env.wind ? env.wind[0] : 0, wz = env.wind ? env.wind[1] : 0, gust = env.gust || 0;
    const tx = env.tide ? env.tide[0] : 0, tz = env.tide ? env.tide[1] : 0;
    const wl = Math.hypot(wx, wz) || 1, kx = wx / wl, kz = wz / wl;
    // external forces + prediction
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      V[i3 + 1] -= this.g * dt;
      V[i3] += tx * dt; V[i3 + 2] += tz * dt;
      if (P[i3 + 1] > surf) {               // wind drags the top layer; a travelling gust field makes ripples
        const ph = (P[i3] * kx + P[i3 + 2] * kz) * 0.35 - t * 1.7;
        const f = 0.55 + 0.45 * Math.sin(ph) + gust * Math.sin(ph * 2.3 + 1.1);
        // air drags the water toward its own speed (bounded), with a little lift in the gust crests
        V[i3] += (wx * f - V[i3]) * 0.9 * dt; V[i3 + 2] += (wz * f - V[i3 + 2]) * 0.9 * dt;
        V[i3 + 1] += Math.max(0, Math.sin(ph)) * gust * wl * 0.35 * dt;
      }
      Q[i3] = P[i3] + V[i3] / 120; Q[i3 + 1] = P[i3 + 1] + V[i3 + 1] / 120; Q[i3 + 2] = P[i3 + 2] + V[i3 + 2] / 120;
    }
    this._grid();
    this._densities();
    // pressure (+ trapped air for foam)
    const kP2g = this.kP2g, kP3g = this.kP3g, rho0 = this.rho0, k = this.k, kN = this.kNear;
    const NS = this.nbStart, NJ = this.nbJ, NR = this.nbR, NX = this.nbX, NY = this.nbY, NZ = this.nbZ, D = this.dens, DN = this.near;
    for (let i = 0; i < n; i++) {
      // no negative pressure: a free surface held by gravity alone stays flat at rest
      const di = D[i], pi = di > rho0 ? (di - rho0) * k : 0, pni = DN[i] * kN;
      let fx = 0, fy = 0, fz = 0, cnt = 0, trap = 0;
      const vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2];
      for (let q = NS[i], e = NS[i + 1]; q < e; q++) {
        const j = NJ[q]; if (j === i) continue;
        const r = NR[q], ux = NX[q], uy = NY[q], uz = NZ[q], dj = D[j], dnj = DN[j];
        const sp = (pi + (dj > rho0 ? (dj - rho0) * k : 0)) * 0.5, snp = (pni + dnj * kN) * 0.5, v = h - r;
        const a = (-v * kP2g) * sp / (dj > 1e-6 ? dj : 1e-6) + (-v * v * kP3g) * snp / (dnj > 1e-6 ? dnj : 1e-6);
        fx += ux * a; fy += uy * a; fz += uz * a; cnt++;
        // Ihmsen trapped-air: relative speed of converging neighbours
        const rx = vx - V[j * 3], ry = vy - V[j * 3 + 1], rz = vz - V[j * 3 + 2], rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rl > 1e-6) trap += rl * (1 - (rx * -ux + ry * -uy + rz * -uz) / rl) * (1 - r / h);
      }
      if (this.bD) {                             // virtual water below pushes back up
        const y = Q[i * 3 + 1], fl = Math.max(this._floorAt(Q[i * 3], Q[i * 3 + 2]), this.bottom);
        const b = this._bIdx(y - fl);
        if (b >= 0) fy += this.bFY[b] * pi / rho0 + this.bFNY[b] * pni / (DN[i] > 1e-6 ? DN[i] : 1e-6);
      }
      const inv = 1 / (di > 1e-6 ? di : 1e-6);
      let nvx = vx + fx * inv * dt, nvy = vy + fy * inv * dt, nvz = vz + fz * inv * dt;
      if (cnt < 8) { const f = 1 - dt * 0.75; nvx *= f; nvy *= f; nvz *= f; }
      V[i * 3] = nvx; V[i * 3 + 1] = nvy; V[i * 3 + 2] = nvz;
      this.nbCount[i] = cnt; this.trapped[i] = trap;
    }
    // viscosity
    if (this.visc) {
      const kp = this.kPoly6, h2 = h * h, vs = this.visc;
      for (let i = 0; i < n; i++) {
        let ax = 0, ay = 0, az = 0; const vx = V[i * 3], vy = V[i * 3 + 1], vz = V[i * 3 + 2];
        for (let q = NS[i], e = NS[i + 1]; q < e; q++) {
          const j = NJ[q]; if (j === i) continue;
          const r = NR[q], w = h2 - r * r, kk = w * w * w * kp;
          ax += (V[j * 3] - vx) * kk; ay += (V[j * 3 + 1] - vy) * kk; az += (V[j * 3 + 2] - vz) * kk;
        }
        V[i * 3] += ax * vs * dt; V[i * 3 + 1] += ay * vs * dt; V[i * 3 + 2] += az * vs * dt;
      }
    }
    // integrate, rigid bodies, floor, periodic wrap
    const vmax = 30;
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let vx = V[i3], vy = V[i3 + 1], vz = V[i3 + 2];
      const sp = Math.hypot(vx, vy, vz); if (sp > vmax) { const f = vmax / sp; vx *= f; vy *= f; vz *= f; }
      let x = P[i3] + vx * dt, y = P[i3 + 1] + vy * dt, z = P[i3 + 2] + vz * dt;
      // the pilot (and anything else) as moving spheres: push out, carry along
      for (let b = 0; b < bodies.length; b++) {
        const B = bodies[b];
        const dx = this._dw(x - B.x), dy = y - B.y, dz = this._dw(z - B.z), r = Math.hypot(dx, dy, dz);
        if (r < B.r && r > 1e-6) {
          const nx = dx / r, ny = dy / r, nz = dz / r, push = B.r - r;
          x += nx * push; y += ny * push; z += nz * push;
          const vn = vx * nx + vy * ny + vz * nz, bn = (B.vx || 0) * nx + (B.vy || 0) * ny + (B.vz || 0) * nz;
          if (vn < bn) { vx += (bn - vn) * nx; vy += (bn - vn) * ny; vz += (bn - vn) * nz; }
          const drag = 0.35;                  // swirl: water near her picks up some of her motion
          vx += ((B.vx || 0) - vx) * drag * dt * 8; vy += ((B.vy || 0) - vy) * drag * dt * 8; vz += ((B.vz || 0) - vz) * drag * dt * 8;
        }
      }
      // shore: dry columns are walls, the water turns back
      if (this._floorAt(x, z) >= this.dryY) { x = P[i3]; z = P[i3 + 2]; vx *= -0.3; vz *= -0.3; }
      const fl = Math.max(this.floor(x, z), this.bottom);
      if (y < fl) { y = fl; if (vy < 0) vy = -vy * this.damp; vx *= 0.98; vz *= 0.98; }
      x = this._wrap(x, this.cx); z = this._wrap(z, this.cz);
      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z; V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
    }
  };
  // Soft follow: keep the player near the middle by sliding the window half a
  // patch at a time (particles outside wrap to the far side).
  Core.prototype.follow = function (px, pz) {
    const L = this.L, m = L * 0.25;
    let moved = false;
    if (px - this.cx > m) { this.cx += L * 0.5; moved = true; } else if (this.cx - px > m) { this.cx -= L * 0.5; moved = true; }
    if (pz - this.cz > m) { this.cz += L * 0.5; moved = true; } else if (this.cz - pz > m) { this.cz -= L * 0.5; moved = true; }
    if (moved) {
      for (let i = 0; i < this.nAct; i++) { this.pos[i * 3] = this._wrap(this.pos[i * 3], this.cx); this.pos[i * 3 + 2] = this._wrap(this.pos[i * 3 + 2], this.cz); }
      this._buildFloor(); this._relocateDry();
    }
    return moved;
  };

  // ── foam / spray (white particles) ───────────────────────────────────
  function Foam(max) {
    this.max = max; this.n = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.life = new Float32Array(max); this.l0 = new Float32Array(max);
  }
  Foam.prototype.spawn = function (x, y, z, vx, vy, vz, life) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz; this.life[i] = this.l0[i] = life;
  };
  Foam.prototype.step = function (dt, g, surfY) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      let l = this.life[i] - dt; if (l <= 0) continue;
      let x = this.p[i * 3], y = this.p[i * 3 + 1], z = this.p[i * 3 + 2], vx = this.v[i * 3], vy = this.v[i * 3 + 1], vz = this.v[i * 3 + 2];
      if (y > surfY) { vy -= g * dt; vx *= 1 - 0.6 * dt; vz *= 1 - 0.6 * dt; }           // spray: ballistic with drag
      else if (y > surfY - 0.6) { vy = (surfY - y) * 3; vx *= 1 - 2 * dt; vz *= 1 - 2 * dt; l -= dt; } // foam: rides the surface
      else { vy += g * 0.4 * dt; }                                                          // bubble: rises
      x += vx * dt; y += vy * dt; z += vz * dt;
      this.p[w * 3] = x; this.p[w * 3 + 1] = y; this.p[w * 3 + 2] = z; this.v[w * 3] = vx; this.v[w * 3 + 1] = vy; this.v[w * 3 + 2] = vz;
      this.life[w] = l; this.l0[w] = this.l0[i]; w++;
    }
    this.n = w;
  };

  // ── volumetric surface: marching cubes over the particle field ────────
  // Each particle adds a smooth kernel to a 3-D grid over the patch (periodic
  // in x/z like the sim); the iso-surface of that field is the water's skin,
  // so splashes are real blobs and sheets and she passes through the volume.
  const CELL_BY_TIER = { low: 0.9, medium: 0.7, high: 0.55, ultra: 0.45 };
  function Volume(core, tier, tables) {
    this.C = core; this.T = tables;
    const s = core.s, c = this.c = s * (CELL_BY_TIER[tier] || 0.7);
    this.nx = Math.max(6, Math.round(core.L / c)); this.cx_ = core.L / this.nx;   // exact fit (periodic)
    this.y0 = core.restY - 2.2 * s; this.ny = Math.max(4, Math.ceil((5.4 * s) / c)); this.cy = (5.4 * s) / this.ny;
    this.R = 1.5 * s; this.iso = 0.5;
    const n = this.nx, ny = this.ny;
    this.f = new Float32Array(n * (ny + 1) * n);     // x/z periodic: n points per axis; y: ny+1
    this.wrap = new Int32Array(n + 2); for (let i = -1; i <= n; i++) this.wrap[i + 1] = ((i % n) + n) % n;
    // normalise so the inside of a calm lattice reads ~1
    let w0 = 0; const RR = this.R * this.R, k = Math.ceil(this.R / s) + 1;
    for (let x = -k; x <= k; x++) for (let y = -k; y <= k; y++) for (let z = -k; z <= k; z++) { const r2 = (x * x + y * y + z * z) * s * s; if (r2 < RR) { const q = 1 - r2 / RR; w0 += q * q * q; } }
    this.w0 = w0;
    this.maxV = 60000;
    this.pos = new Float32Array(this.maxV * 3); this.nrm = new Float32Array(this.maxV * 3); this.col = new Float32Array(this.maxV * 4);
    this.nv = 0; this.offY = 0;
    // only the band around the surface is ever visible: mesh/splat just that
    this.yMin = core.restY - 1.0 * s;
    this.iyMin = Math.max(0, Math.floor((this.yMin - this.y0) / this.cy) - 1);
    // calibrate: where the calm skin sits, so it lands just under the water plane on every tier
    this.splat(); this.mesh(null, null, core.restY, 0.15, true);
    // (the calm skin has small lattice bumps: put their tops, not their middle, under the plane)
    const ys = [];
    for (let i = 0; i < this.nv; i++) if (this.nrm[i * 3 + 1] > 0.6) ys.push(this.pos[i * 3 + 1]);
    ys.sort((a, b) => a - b);
    this.offY = ys.length ? (core.restY - 0.04) - ys[Math.floor(ys.length * 0.97)] : 0;
    this.bump = ys.length ? ys[Math.floor(ys.length * 0.97)] - ys[Math.floor(ys.length * 0.5)] : 0;
  }
  Volume.prototype.splat = function () {
    const C = this.C, f = this.f, n = this.nx, ny = this.ny, c = this.cx_, cy = this.cy, R = this.R, RR = R * R, inv = 1 / this.w0;
    f.fill(0);
    const lo = C.cx - C.L / 2, lz = C.cz - C.L / 2, P = C.pos, rc = Math.ceil(R / c), ry = Math.ceil(R / cy), W = this.wrap, iyMin = this.iyMin;
    const pyMin = this.y0 + iyMin * cy - R;
    for (let i = 0; i < C.nAct; i++) {
      const py = P[i * 3 + 1]; if (py < pyMin) continue;      // too deep to reach the visible band
      const px = P[i * 3], pz = P[i * 3 + 2];
      const gx = (px - lo) / c, gy = (py - this.y0) / cy, gz = (pz - lz) / c;
      const ix0 = Math.floor(gx), iy0 = Math.floor(gy), iz0 = Math.floor(gz);
      for (let dy = -ry + 1; dy <= ry; dy++) {
        const iy = iy0 + dy; if (iy < iyMin || iy > ny) continue;
        const ey = (iy - gy) * cy, ey2 = ey * ey; if (ey2 >= RR) continue;
        for (let dz = -rc + 1; dz <= rc; dz++) {
          const ez = (iz0 + dz - gz) * c, ez2 = ez * ez; if (ey2 + ez2 >= RR) continue;
          let iz = iz0 + dz; iz = iz >= 0 && iz < n ? iz : ((iz % n) + n) % n;
          const rowBase = (iz * (ny + 1) + iy) * n;
          for (let dx = -rc + 1; dx <= rc; dx++) {
            const ex = (ix0 + dx - gx) * c, r2 = ex * ex + ey2 + ez2; if (r2 >= RR) continue;
            let ix = ix0 + dx; ix = ix >= 0 && ix < n ? ix : ((ix % n) + n) % n;
            const q = 1 - r2 / RR;
            f[rowBase + ix] += q * q * q * inv;
          }
        }
      }
    }
  };
  Volume.prototype.mesh = function (liquid, white, restY, fadeFrac, calib) {
    const T = this.T, EDGE = T.edge, TRI = T.tri, CO = T.corners, EC = T.edges;
    const f = this.f, n = this.nx, ny = this.ny, ny1 = ny + 1, c = this.cx_, cy = this.cy, iso = this.iso, C = this.C, W = this.wrap;
    const lo = -C.L / 2, P = this.pos, N = this.nrm, K = this.col, off = this.offY, L = C.L, s = C.s;
    const idx = (x, y, z) => (W[z + 1] * ny1 + y) * n + W[x + 1];
    let v = 0;
    const cv = new Float32Array(8), cp = new Float32Array(24), cg = new Float32Array(24);
    for (let z = 0; z < n; z++) for (let y = this.iyMin; y < ny; y++) for (let x = 0; x < n; x++) {
      let ci = 0;
      for (let k = 0; k < 8; k++) {
        const o = CO[k], X = x + o[0], Y = y + o[1], Z = z + o[2];
        const val = f[idx(X, Y, Z)]; cv[k] = val;
        if (val > iso) ci |= 1 << k;                      // inside = more water than the iso level
      }
      if (ci === 0 || ci === 255 || EDGE[ci] === 0) continue;
      for (let k = 0; k < 8; k++) {
        const o = CO[k], X = x + o[0], Y = y + o[1], Z = z + o[2];
        cp[k * 3] = lo + X * c; cp[k * 3 + 1] = this.y0 + Y * cy + off; cp[k * 3 + 2] = lo + Z * c;
        // field gradient → outward normal (points away from the water)
        cg[k * 3] = f[idx(X - 1, Y, Z)] - f[idx(X + 1, Y, Z)];
        cg[k * 3 + 1] = f[idx(X, Y > 0 ? Y - 1 : Y, Z)] - f[idx(X, Y < ny ? Y + 1 : Y, Z)];
        cg[k * 3 + 2] = f[idx(X, Y, Z - 1)] - f[idx(X, Y, Z + 1)];
      }
      const tri = TRI[ci];
      for (let t = 0; t < 15 && tri[t] !== -1; t++) {
        if (v >= this.maxV) break;
        const e = EC[tri[t]], a = e[0], b = e[1], va = cv[a], vb = cv[b];
        const mu = Math.abs(vb - va) < 1e-6 ? 0.5 : (iso - va) / (vb - va);
        const X = cp[a * 3] + mu * (cp[b * 3] - cp[a * 3]), Y = cp[a * 3 + 1] + mu * (cp[b * 3 + 1] - cp[a * 3 + 1]), Z = cp[a * 3 + 2] + mu * (cp[b * 3 + 2] - cp[a * 3 + 2]);
        const gx = cg[a * 3] + mu * (cg[b * 3] - cg[a * 3]), gy = cg[a * 3 + 1] + mu * (cg[b * 3 + 1] - cg[a * 3 + 1]), gz = cg[a * 3 + 2] + mu * (cg[b * 3 + 2] - cg[a * 3 + 2]);
        const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
        P[v * 3] = X; P[v * 3 + 1] = Y; P[v * 3 + 2] = Z; N[v * 3] = gx / gl; N[v * 3 + 1] = gy / gl; N[v * 3 + 2] = gz / gl;
        if (!calib) {
          // shown only above the water plane (calm water is the plane), fading at the patch edges
          const ex = 0.5 - Math.abs(X / L), ez = 0.5 - Math.abs(Z / L), edge = Math.min(1, Math.min(ex, ez) / fadeFrac);
          const up = Math.min(1, Math.max(0, (Y - (restY + 0.02)) / (0.3 * s)));
          const wv = Math.min(0.55, Math.max(0, Y - restY) * 0.25);
          K[v * 4] = liquid.r + (white.r - liquid.r) * wv; K[v * 4 + 1] = liquid.g + (white.g - liquid.g) * wv; K[v * 4 + 2] = liquid.b + (white.b - liquid.b) * wv;
          K[v * 4 + 3] = up * (edge > 0 ? edge : 0);
        }
        v++;
      }
    }
    this.nv = v;
    return v;
  };

  // ── in-game wrapper (THREE rendering + world hooks) ──────────────────
  // The water is drawn as a marching-cubes surface of the particle field
  // (o.mc carries the game's MC tables); without them, as a wave grid.
  // Plus droplets for lone water thrown into the air, and foam flecks.
  function Water(THREE, scene, o) {
    this.THREE = THREE; this.scene = scene;
    const tier = o.tier in TIER_COUNT ? o.tier : 'medium';
    this.tier = o.tier;                         // as requested (so a tier change can be spotted)
    this.core = new Core({ count: TIER_COUNT[tier], spacing: o.spacing || 1.0, depth: o.depth || 3.0, restY: o.restY || 0,
      gravity: o.gravity, floor: o.floor, cx: o.cx, cz: o.cz, substeps: (tier === 'low' || tier === 'medium') ? 1 : 2 });
    const C = this.core, s = C.s;
    this.foam = new Foam(tier === 'low' ? 160 : tier === 'ultra' ? 520 : 320);
    this.env = { wind: o.wind || [0, 0], gust: o.gust != null ? o.gust : 0.3, tide: [0, 0] };
    this.tideAmp = o.tide || 0; this.tidePeriod = 90;
    this.liquid = new THREE.Color(o.color != null ? o.color : 0x1a4a7a);
    this.restTop = C.restY - 0.55 * s + 0.5 * s;      // settled top of the particle slab
    const base = o.material;
    const mat = base && base.clone ? base.clone() : new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0.4 });
    mat.color = new THREE.Color(0xffffff); mat.vertexColors = true; mat.vertexAlphas = true; mat.transparent = true; mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    if (o.opacity != null) mat.opacity = o.opacity;
    if (o.mc && o.mc.tri && o.mc.edge) {
      this.vol = new Volume(C, tier, o.mc);
      const geo = new THREE.BufferGeometry();
      const V = this.vol;
      this._pa = new THREE.BufferAttribute(V.pos, 3); this._na = new THREE.BufferAttribute(V.nrm, 3); this._ca = new THREE.BufferAttribute(V.col, 4);
      [this._pa, this._na, this._ca].forEach((a) => a.setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('position', this._pa); geo.setAttribute('normal', this._na); geo.setAttribute('color', this._ca);
      geo.setDrawRange(0, 0);
      this.surf = new THREE.Mesh(geo, mat); this.surf.name = 'JOTS_FluidVolume';
    } else {
      const g = this.g = Math.max(8, Math.round(C.L / (s * 0.5)));
      const geo = new THREE.PlaneGeometry(C.L, C.L, g, g); geo.rotateX(-Math.PI / 2);
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((g + 1) * (g + 1) * 4), 4));
      this.surf = new THREE.Mesh(geo, mat); this.surf.name = 'JOTS_FluidSurface';
      this.hgt = new Float32Array((g + 1) * (g + 1)); this.spd = new Float32Array((g + 1) * (g + 1));
    }
    this.surf.frustumCulled = false; this.surf.userData.isWaterSurface = true;
    // droplets (airborne water) and foam flecks
    const dg = new THREE.IcosahedronGeometry(s * 0.28, 1);
    const dm = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.9 });
    this.drops = new THREE.InstancedMesh(dg, dm, C.n); this.drops.name = 'JOTS_FluidDrops'; this.drops.frustumCulled = false; this.drops.count = 0;
    const fg = new THREE.IcosahedronGeometry(s * 0.16, 0);
    const fm = new THREE.MeshBasicMaterial({ color: 0xf2fbff, transparent: true, opacity: 0.8, depthWrite: false });
    this.foamMesh = new THREE.InstancedMesh(fg, fm, this.foam.max); this.foamMesh.name = 'JOTS_FluidFoam'; this.foamMesh.frustumCulled = false; this.foamMesh.count = 0;
    scene.add(this.surf); scene.add(this.drops); scene.add(this.foamMesh);
    this._m = new THREE.Matrix4(); this._c = new THREE.Color(); this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._sc = new THREE.Vector3();
    this._white = new THREE.Color(0xeaf6ff);
    this._draw();
  }
  Water.prototype.update = function (dt, bodies, wind) {
    const C = this.core;
    if (wind) this.env.wind = wind;
    if (this.tideAmp) {                        // the moons' pull: a slow back-and-forth current
      const a = this.tideAmp * Math.sin(C.time * 2 * PI / this.tidePeriod);
      this.env.tide = [a, a * 0.4];
    }
    C.step(dt, bodies, this.env);
    // foam: fast, broken water near the surface throws up white particles
    const F = this.foam, surf = C.restY - C.s * 0.5, P = C.pos, V = C.vel;
    for (let i = 0; i < C.nAct; i++) {
      if (P[i * 3 + 1] < surf - C.s) continue;
      const ke = V[i * 3] * V[i * 3] + V[i * 3 + 1] * V[i * 3 + 1] + V[i * 3 + 2] * V[i * 3 + 2];
      // thresholds sit above what a steady breeze makes, so foam marks splashes and churn
      const ta = Math.min(1, Math.max(0, (C.trapped[i] - 7) / 18)), kf = Math.min(1, Math.max(0, (ke - 16) / 48));
      if (Math.random() < ta * kf * dt * 18) {
        const sp = C.s * 0.5;
        F.spawn(P[i * 3] + (Math.random() - 0.5) * sp, P[i * 3 + 1] + C.s * 0.3, P[i * 3 + 2] + (Math.random() - 0.5) * sp,
          V[i * 3] * 0.9, Math.abs(V[i * 3 + 1]) * 0.9 + 1.5, V[i * 3 + 2] * 0.9, 1.5 + Math.random() * 3);
      }
    }
    F.step(Math.min(dt, 1 / 30), C.g, C.restY);
    this._draw();
  };
  Water.prototype._draw = function () {
    if (this.vol) return this._drawVolume();
    const C = this.core, P = C.pos, V = C.vel, s = C.s, g = this.g, L = C.L, cs = L / g, lo = C.cx - L / 2, lz = C.cz - L / 2;
    const H = this.hgt, SP = this.spd, NEG = -1e9;
    H.fill(NEG); SP.fill(0);
    // each particle near the top lifts a small dome on the surface grid
    const rr = s * 1.1, rc = Math.ceil(rr / cs), lift = 0.5 * s, top0 = C.restY - 2.0 * s;
    let nd = 0;
    for (let i = 0; i < C.nAct; i++) {
      const y = P[i * 3 + 1]; if (y < top0) continue;
      const x = P[i * 3], z = P[i * 3 + 2], sp = Math.hypot(V[i * 3], V[i * 3 + 1], V[i * 3 + 2]);
      if (y > this.restTop + 0.9 * s) {        // thrown clear of the water: a droplet
        this._m.makeTranslation(x, y, z); this.drops.setMatrixAt(nd++, this._m); continue;
      }
      const fx = (x - lo) / cs, fz = (z - lz) / cs, ix = Math.round(fx), iz = Math.round(fz);
      for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) {
        let gx = ix + dx, gz = iz + dz;
        const ddx = (gx - fx) * cs, ddz = (gz - fz) * cs, d2 = ddx * ddx + ddz * ddz; if (d2 > rr * rr) continue;
        gx = ((gx % g) + g) % g; gz = ((gz % g) + g) % g;    // periodic, like the sim
        const k = gz * (g + 1) + gx, hv = y + lift * (1 - d2 / (rr * rr));
        if (hv > H[k]) H[k] = hv;
        if (sp > SP[k]) SP[k] = sp;
      }
    }
    this.drops.count = nd; this.drops.instanceMatrix.needsUpdate = true;
    // fill gaps with calm water, then smooth (periodic box blur, two passes) so crests roll
    const calm = this.restTop - 0.2 * s;
    for (let iz = 0; iz < g; iz++) for (let ix = 0; ix < g; ix++) { const k = iz * (g + 1) + ix; if (H[k] === NEG) H[k] = calm; }
    const T = this._tmp || (this._tmp = new Float32Array(H.length));
    for (let pass = 0; pass < 2; pass++) {
      for (let iz = 0; iz < g; iz++) for (let ix = 0; ix < g; ix++) {
        let sum = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) sum += H[(((iz + dz) % g + g) % g) * (g + 1) + (((ix + dx) % g + g) % g)];
        T[iz * (g + 1) + ix] = sum / 9;
      }
      for (let iz = 0; iz < g; iz++) for (let ix = 0; ix < g; ix++) H[iz * (g + 1) + ix] = T[iz * (g + 1) + ix];
    }
    // seam column/row mirror the first, then turn heights into the mesh
    for (let i = 0; i <= g; i++) { H[i * (g + 1) + g] = H[i * (g + 1)]; SP[i * (g + 1) + g] = SP[i * (g + 1)]; H[g * (g + 1) + i] = H[i]; SP[g * (g + 1) + i] = SP[i]; }
    const pos = this.surf.geometry.attributes.position, col = this.surf.geometry.attributes.color, c = this._c;
    for (let iz = 0; iz <= g; iz++) for (let ix = 0; ix <= g; ix++) {
      const k = iz * (g + 1) + ix;
      // calm water sits exactly at the plane; edges fade into it
      const ex = Math.min(ix, g - ix) / (g * 0.18), ez = Math.min(iz, g - iz) / (g * 0.18), fade = Math.min(1, ex, ez);
      // calm water sits just under the plane (only the plane shows); crests break through it
      let d = H[k] - this.restTop;
      d = Math.max(-0.6 * s, Math.min(1.1 * s, d)) * fade;
      pos.setY(k, C.restY - 0.08 + d);
      c.copy(this.liquid).lerp(this._white, Math.min(0.6, Math.max(0, SP[k] - 3.5) * 0.1));
      const a = Math.min(1, Math.max(0, (d - 0.04) / (0.25 * s)));
      col.setXYZW(k, c.r, c.g, c.b, a);
    }
    pos.needsUpdate = true; col.needsUpdate = true; this.surf.geometry.computeVertexNormals();
    this.surf.position.set(C.cx, 0, C.cz);
    // foam flecks
    const F = this.foam, m = this._m;
    for (let i = 0; i < F.n; i++) {
      const k = Math.max(0.15, F.life[i] / F.l0[i]);
      this._sc.setScalar(k);
      m.compose(this._v.set(F.p[i * 3], F.p[i * 3 + 1], F.p[i * 3 + 2]), this._q, this._sc);
      this.foamMesh.setMatrixAt(i, m);
    }
    this.foamMesh.count = F.n; this.foamMesh.instanceMatrix.needsUpdate = true;
  };
  Water.prototype._drawVolume = function () {
    const C = this.core, P = C.pos, V = this.vol;
    // lone water thrown clear of the rest: droplets (too thin for the iso-surface)
    let nd = 0;
    for (let i = 0; i < C.nAct; i++) {
      if (P[i * 3 + 1] > this.restTop + 0.9 * C.s && C.nbCount[i] < 4) { this._m.makeTranslation(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); this.drops.setMatrixAt(nd++, this._m); }
    }
    this.drops.count = nd; this.drops.instanceMatrix.needsUpdate = true;
    V.splat();
    const nv = V.mesh(this.liquid, this._white, C.restY, 0.15);
    this.surf.position.set(C.cx, 0, C.cz);
    this.surf.geometry.setDrawRange(0, nv);
    [this._pa, this._na, this._ca].forEach((a) => { a.needsUpdate = true; if (a.clearUpdateRanges) { a.clearUpdateRanges(); a.addUpdateRange(0, nv * a.itemSize); } });
    this._drawFoam();
  };
  Water.prototype._drawFoam = function () {
    const F = this.foam, m = this._m;
    for (let i = 0; i < F.n; i++) {
      const k = Math.max(0.15, F.life[i] / F.l0[i]);
      this._sc.setScalar(k);
      m.compose(this._v.set(F.p[i * 3], F.p[i * 3 + 1], F.p[i * 3 + 2]), this._q, this._sc);
      this.foamMesh.setMatrixAt(i, m);
    }
    this.foamMesh.count = F.n; this.foamMesh.instanceMatrix.needsUpdate = true;
  };
  Water.prototype.follow = function (x, z) { this.core.follow(x, z); };
  Water.prototype.dispose = function () {
    [this.surf, this.drops, this.foamMesh].forEach((o) => { try { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); } catch (e) {} });
  };

  const api = { Core, Foam, Volume, Water, TIER_COUNT };
  if (typeof window !== 'undefined') window.DMFluid = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
