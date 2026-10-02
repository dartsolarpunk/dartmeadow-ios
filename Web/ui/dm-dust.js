/* DART Engine — wind-blown dust (and spindrift on ice worlds).
 *
 * Each particle is a single grain cloud far smaller than a pixel. It is drawn
 * as one pixel whose brightness is the share of that pixel it would really
 * cover, (projected size)², added on top of whatever is already there. One
 * grain is invisible; where many overlap along the line of sight, their
 * coverage sums and the pixel lights up. That is how real fine dust reads: a
 * faint shimmer off a ridge close by, and a solid-looking smoky column far
 * away where thousands of grains line up.
 *
 *   - The wind comes from the world clock, so everyone feels the same gusts.
 *   - Grains lift off dune crests (high ground with a drop on the lee side),
 *     drift on the wind with drag, settle under gravity, and land again.
 *   - Dust devils wander downwind in the distance: grains spiral up a
 *     widening funnel. They are placed from the world clock and map cell,
 *     so players in the same place see the same ones.
 *
 *   const d = DMDust.create(scene, { height:(x,z)=>y, color, amount, quality, seed })
 *   d.update(dt, camera, cx, cz, day)   — each frame
 *   d.dispose()
 */
(function () {
  'use strict';
  const fract = (x) => x - Math.floor(x);
  const h1 = (n) => fract(Math.sin(n * 127.1 + 311.7) * 43758.5453);

  function create(scene, o) {
    const THREE = window.THREE;
    const q = o.quality || 'medium', amount = o.amount == null ? 1 : o.amount;
    const NA = Math.round((q === 'high' ? 14000 : q === 'low' ? 4000 : 8000) * amount);   // ridge dust
    const ND = q === 'high' ? 3 : q === 'low' ? 1 : 2, PD = q === 'high' ? 4500 : 3000;    // devils × grains each
    const N = NA + ND * PD;
    const H = o.height, seed = o.seed || 1;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const vel = new Float32Array(N * 3), life = new Float32Array(N), age = new Float32Array(N), sz = new Float32Array(N);
    const dev = new Float32Array(N * 3);   // devil grains: angle, height, radius jitter
    const base = new THREE.Color(o.color != null ? o.color : 0xd8b878).lerp(new THREE.Color(0xffffff), 0.3);   // lit fine dust reads paler than the sand
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3), ca = new THREE.BufferAttribute(col, 3);
    pa.setUsage(THREE.DynamicDrawUsage); ca.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa); geo.setAttribute('color', ca);
    const mat = new THREE.PointsMaterial({ size: 1, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; pts.raycast = () => {}; pts.renderOrder = 3;
    scene.add(pts);

    let rs = (seed * 9301 + 49297) % 233280 || 1;
    const rnd = () => { rs = (rs * 16807) % 2147483647; return (rs - 1) / 2147483646; };
    const R = 70;                       // ridge dust lives within this radius of the player
    const wind = { x: 1, z: 0, s: 5 };
    const devils = [];
    for (let k = 0; k < ND; k++) devils.push({ x: 0, z: 0, y: 0, a: 0, top: 30, r0: 0.6, slot: -1 });
    const t0 = performance.now();

    function worldT() { return (window.worldSeconds ? window.worldSeconds() : (performance.now() - t0) / 1000); }
    function windAt(t) {
      const a = h1(seed) * 6.283 + 0.8 * Math.sin(t / 173) + 0.35 * Math.sin(t / 61 + 1.3);
      const gust = Math.max(0, Math.sin(t / 7.3) * Math.sin(t / 3.1 + 0.7));
      wind.x = Math.cos(a); wind.z = Math.sin(a);
      wind.s = 4.2 + 2.2 * Math.sin(t / 37) ** 2 + 3.5 * gust;
    }
    // a crest: higher than the ground upwind of it, with a drop just downwind
    function spawnRidge(i, cx, cz, scatter) {
      let bx = 0, bz = 0, by = 0, best = -1e9;
      for (let k = 0; k < 6; k++) {
        const a = rnd() * 6.283, r = Math.sqrt(rnd()) * R;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, y = H(x, z);
        const up = H(x - wind.x * 1.6, z - wind.z * 1.6), dn = H(x + wind.x * 1.6, z + wind.z * 1.6);
        const score = (y - up) + (y - dn) * 0.6 + rnd() * 0.05;
        if (score > best) { best = score; bx = x; bz = z; by = y; }
      }
      const j = i * 3;
      pos[j] = bx; pos[j + 1] = by + 0.05 + rnd() * 0.25; pos[j + 2] = bz;
      const s = wind.s * (0.5 + rnd() * 0.6);
      vel[j] = wind.x * s; vel[j + 1] = 0.4 + rnd() * 1.2 * Math.max(0, best) + rnd() * 0.3; vel[j + 2] = wind.z * s;
      life[i] = 2.5 + rnd() * 5; age[i] = scatter ? rnd() * life[i] : 0;
      sz[i] = 0.035 + rnd() * 0.05;      // a grain cloud an inch or two across
    }
    function placeDevil(d, k, t, cx, cz) {
      // one devil window per ~100 s per slot, seeded by the map cell so nearby players share it
      const slot = Math.floor(t / 100 + k * 0.37), cell = Math.floor(cx / 500) * 7919 + Math.floor(cz / 500) * 104729;
      if (slot === d.slot) return;
      d.slot = slot;
      const r = (n) => h1(slot * 13.7 + k * 91.1 + cell * 0.001 + n * 7.31 + seed);
      d.on = r(1) < 0.75;
      const a = r(2) * 6.283, dist = 60 + r(3) * 140;
      d.x = cx + Math.cos(a) * dist; d.z = cz + Math.sin(a) * dist;
      d.top = 18 + r(4) * 30; d.r0 = 0.5 + r(5) * 1.2; d.spin = (r(6) < 0.5 ? -1 : 1) * (1.6 + r(7) * 1.4);
      d.born = slot * 100 - k * 37;
    }
    function spawnDevil(i, d) {
      const j = i * 3;
      dev[j] = rnd() * 6.283; dev[j + 1] = rnd() * rnd() * d.top; dev[j + 2] = 0.6 + rnd() * 0.8;
      sz[i] = 0.22 + rnd() * 0.25; life[i] = 1; age[i] = 0;
    }
    for (let i = 0; i < NA; i++) spawnRidge(i, 0, 0, true);
    for (let k = 0; k < ND; k++) for (let i = 0; i < PD; i++) spawnDevil(NA + k * PD + i, devils[k]);

    let frame = 0;
    const cp = new THREE.Vector3();
    const ctl = {
      points: pts,
      update(dt, camera, cx, cz, day) {
        if (!camera) return;
        dt = Math.min(0.05, dt || 0.016); frame++;
        const t = worldT(); windAt(t);
        cp.copy(camera.position);
        // pixel scale: a 1-unit object at distance D covers f/D pixels
        const f = (window.innerHeight || 600) * 0.5 / Math.tan((camera.fov || 60) * Math.PI / 360) * ((window.devicePixelRatio || 1) > 1.5 ? 1.5 : 1);
        const lit = 0.18 + 0.82 * (day == null ? 1 : day);
        const br = base.r * lit, bg = base.g * lit, bb = base.b * lit;
        const g = 2.2, drag = 1.6;
        // ridge dust
        for (let i = 0; i < NA; i++) {
          const j = i * 3;
          age[i] += dt;
          let dx = pos[j] - cx, dz = pos[j + 2] - cz;
          if (age[i] > life[i] || dx * dx + dz * dz > R * R * 1.3) { spawnRidge(i, cx, cz, false); continue; }
          // swirl: a little curl in the wind so streams twist instead of marching
          const sw = Math.sin(pos[j] * 0.21 + t * 0.7) * Math.cos(pos[j + 2] * 0.17 - t * 0.5) * 1.4;
          vel[j] += ((wind.x * wind.s - wind.z * sw) - vel[j]) * drag * dt;
          vel[j + 2] += ((wind.z * wind.s + wind.x * sw) - vel[j + 2]) * drag * dt;
          vel[j + 1] += (-g * 0.35 - vel[j + 1] * 0.6) * dt;
          pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt;
          if (((i + frame) & 7) === 0) { const gy = H(pos[j], pos[j + 2]); if (pos[j + 1] < gy) { spawnRidge(i, cx, cz, false); continue; } }
          const a = age[i] / life[i], fade = Math.min(1, a * 5) * Math.min(1, (1 - a) * 3);
          const ex = pos[j] - cp.x, ey = pos[j + 1] - cp.y, ez = pos[j + 2] - cp.z;
          const px = sz[i] * f / Math.max(0.3, Math.sqrt(ex * ex + ey * ey + ez * ez));
          const cov = Math.min(1, px * px) * fade * 0.6;
          col[j] = br * cov; col[j + 1] = bg * cov; col[j + 2] = bb * cov;
        }
        // dust devils
        for (let k = 0; k < ND; k++) {
          const d = devils[k];
          placeDevil(d, k, t, cx, cz);
          const tl = t - d.born, env = d.on ? Math.max(0, Math.min(1, tl / 8, (95 - tl) / 10)) : 0;
          const ox = d.x + wind.x * wind.s * 0.45 * tl, oz = d.z + wind.z * wind.s * 0.45 * tl;
          if ((frame & 15) === k) d.y = H(ox, oz);
          for (let n = 0; n < PD; n++) {
            const i = NA + k * PD + n, j = i * 3;
            if (env <= 0) { col[j] = col[j + 1] = col[j + 2] = 0; continue; }
            let a = dev[j], hgt = dev[j + 1];
            const rad = (d.r0 + hgt * 0.22) * dev[j + 2];
            a += d.spin * dt * (2.2 / (0.6 + rad * 0.25)); hgt += (1.2 + hgt * 0.05) * dt;
            if (hgt > d.top) { spawnDevil(i, d); continue; }
            dev[j] = a; dev[j + 1] = hgt;
            // the funnel leans downwind as it rises
            const lean = hgt * 0.12;
            pos[j] = ox + Math.cos(a) * rad + wind.x * lean; pos[j + 1] = d.y + hgt; pos[j + 2] = oz + Math.sin(a) * rad + wind.z * lean;
            const ex = pos[j] - cp.x, ey = pos[j + 1] - cp.y, ez = pos[j + 2] - cp.z;
            const px = sz[i] * f / Math.max(0.3, Math.sqrt(ex * ex + ey * ey + ez * ez));
            const thin = 1 - hgt / d.top;
            const cov = Math.min(1, px * px) * env * (0.12 + 0.28 * thin);   // thousands overlap here: each adds a little
            col[j] = br * 0.9 * cov; col[j + 1] = bg * 0.82 * cov; col[j + 2] = bb * 0.7 * cov;
          }
        }
        pa.needsUpdate = true; ca.needsUpdate = true;
      },
      wind,
      dispose() { scene.remove(pts); geo.dispose(); mat.dispose(); },
    };
    return ctl;
  }

  // how much dust a world raises, and of what colour
  function forStyle(style, pal) {
    if (!pal || !pal.atmos) return null;
    const g = pal.ground != null ? pal.ground : 0xc8a070;
    if (style === 'dunes') return { amount: 1, color: g, lift: 1 };
    if (style === 'mesa') return { amount: 0.55, color: g, lift: 1 };
    if (style === 'crater') return { amount: 0.3, color: g, lift: 1 };
    if (style === 'volcanic') return { amount: 0.35, color: 0x6a625c, lift: 1 };
    if (style === 'ice') return { amount: 0.6, color: 0xeef4ff, lift: 1 };   // spindrift off the snow ridges
    return null;
  }

  window.DMDust = { create, forStyle };
})();
