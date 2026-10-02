/* DART Meadow — the sky seen from the ground and from sky flight.
 *
 * A day/night cycle on the shared world clock (DMTime — real UTC, 30× faster,
 * real tilts and seasons): the local sun (coloured by
 * its star type) rises and sets with the site's latitude/longitude. By day
 * the atmosphere scatters it (blue on Earth, butterscotch on Mars, …) with
 * a hazy horizon and warm sunsets; at night the atmosphere thins almost to
 * nothing and the interstellar sky shows through — the star field, the
 * band of the galaxy, and the brightest stars, which still show faintly by
 * day. Comets drift across now and then (day or night) and meteors burn
 * up at night. Airless worlds keep a black sky with the stars always out.
 *
 *   const sky = DMSky.create(scene, {pal, body, style, radius, atmos, starType})
 *   sky.update(camera, dt, lat, lon)   — each frame
 *   sky.sunDir                         — THREE.Vector3 toward the sun
 *   sky.day                            — 0 night … 1 day
 */
(function () {
  'use strict';
  const T = () => window;               // the TSL functions live on window
  const DAY_WALL_SEC = 24 * 60;         // one game day = 24 minutes on the shared clock
  const BODY_DAY = { Earth: 1, Mars: 1.03, Moon: 2.5, Mercury: 3, Venus: 4 };
  function starColor(starType) {
    const c = String(starType || 'G').trim().toUpperCase()[0];
    return ({ O: 0x9db4ff, B: 0xaabfff, A: 0xcad7ff, F: 0xf8f7ff, G: 0xfff1d8, K: 0xffd2a1, M: 0xffb27a })[c] || 0xfff1d8;
  }
  const rnd = (s) => () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };

  function create(scene, o) {
    const THREE = window.THREE, W = T();
    const R = o.radius || 1000, atmos = o.atmos !== false;
    const sk = (window.DMWorldStyle && o.pal) ? DMWorldStyle.skyFor(o.style || 'lush', o.pal) : { top: 0x3a6ea5, bottom: 0x88bbff, haze: 0xbfd8f0, glow: 0xffe0b0 };
    const sunCol = new THREE.Color(starColor(o.starType));
    const sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    const U = {
      top: W.uniform(new THREE.Color(sk.top)), bot: W.uniform(new THREE.Color(sk.bottom)), haze: W.uniform(new THREE.Color(sk.haze != null ? sk.haze : sk.bottom)),
      glow: W.uniform(new THREE.Color(sk.glow != null ? sk.glow : 0xffe0b0)), sun: W.uniform(sunCol.clone()),
      dir: W.uniform(sunDir.clone()), day: W.uniform(1), atm: W.uniform(atmos ? 1 : 0),
    };
    // ── the dome ──
    const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    mat.fog = false; mat.depthWrite = false;
    mat.colorNode = W.Fn(() => {
      const d = W.normalize(W.positionLocal), h = d.y;
      const sunUp = U.dir.y;
      // day sky: gradient + horizon haze
      let day = W.mix(U.bot, U.top, W.smoothstep(W.float(-0.05), W.float(0.65), h));
      day = W.mix(day, U.haze, W.exp(h.max(0).mul(-7)).mul(0.8));
      // sunset: the horizon on the sun's side warms as it gets low
      const az = W.dot(W.normalize(W.vec3(d.x, 0, d.z)), W.normalize(W.vec3(U.dir.x, 0.0001, U.dir.z))).max(0);
      const low = W.smoothstep(W.float(0.35), W.float(0.02), sunUp).mul(W.smoothstep(W.float(-0.18), W.float(0.0), sunUp));
      const warm = W.vec3(1.0, 0.45, 0.18);
      day = W.mix(day, warm, low.mul(W.pow(az, W.float(3))).mul(W.exp(h.max(0).mul(-5))).mul(0.85));
      // night: almost clear — a deep blue that fades to black overhead
      const night = W.mix(U.haze.mul(0.06), W.vec3(0.004, 0.008, 0.02), W.smoothstep(W.float(0), W.float(0.5), h));
      let c = W.mix(night, day, U.day).mul(U.atm).add(W.vec3(0, 0, 0));
      // the sun: halo through the air, and its disc (the disc shows on airless worlds too)
      const sd = W.dot(d, U.dir).max(0);
      const halo = W.pow(sd, W.float(48)).mul(0.55).add(W.pow(sd, W.float(6)).mul(0.22)).mul(U.atm).mul(W.smoothstep(W.float(-0.1), W.float(0.05), sunUp));
      c = c.add(U.glow.mul(halo));
      const disc = W.smoothstep(W.float(0.99935), W.float(0.9997), sd).mul(W.smoothstep(W.float(-0.02), W.float(0.01), h));
      c = c.add(U.sun.mul(disc.mul(2.5)));
      // below the horizon
      return W.mix(c, U.haze.mul(U.day.mul(0.8).add(0.05)).mul(U.atm), W.smoothstep(W.float(0), W.float(-0.25), h));
    })();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 24), mat);
    dome.renderOrder = -10; dome.frustumCulled = false; dome.raycast = () => {};
    scene.add(dome);

    // ── stars: a faint field, the galaxy band, and a few bright ones ──
    const seed = rnd(1234567 + Math.round(((o.lat || 0) + 90) * 7));
    const starR = R * 0.92;
    const mkPoints = (n, band, size, col) => {
      const p = new Float32Array(n * 3), cc = new Float32Array(n * 3);
      const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.05, 0.3, 0.4));
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        if (band) { // concentrated toward a great circle (the galaxy's disc)
          const a = seed() * Math.PI * 2, off = (seed() + seed() + seed() - 1.5) * 0.18;
          v.set(Math.cos(a), off, Math.sin(a)).normalize().applyQuaternion(tilt);
        } else { const z = seed() * 2 - 1, a = seed() * Math.PI * 2, r = Math.sqrt(1 - z * z); v.set(r * Math.cos(a), z, r * Math.sin(a)); }
        p.set([v.x * starR, v.y * starR, v.z * starR], i * 3);
        const b = 0.45 + seed() * 0.55, warm = seed();
        const c = new THREE.Color(col || 0xffffff).lerp(new THREE.Color(warm > 0.7 ? 0xffd8b0 : (warm < 0.25 ? 0xb8ccff : 0xffffff)), 0.6).multiplyScalar(b);
        cc.set([c.r, c.g, c.b], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      const m = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = -9; pts.raycast = () => {};
      return pts;
    };
    const field = mkPoints(1800, false, 1.6), galaxy = mkPoints(2600, true, 1.2, 0xc8d4ff);
    const stars = new THREE.Group(); stars.add(field, galaxy);
    // bright stars: small glowing sprites (visible faintly even by day)
    const glowTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,.85)'); g.addColorStop(0.5, 'rgba(255,255,255,.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const bright = [];
    for (let i = 0; i < 14; i++) {
      const z = seed() * 1.6 - 0.6, a = seed() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      const col = [0xffffff, 0xcfe0ff, 0xffe6c0, 0xbcd0ff][i % 4];
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      s.position.set(r * Math.cos(a) * starR * 0.99, z * starR * 0.99, r * Math.sin(a) * starR * 0.99);
      const k = (i < 3 ? 22 : 12) * (R / 1000); s.scale.set(k, k, 1); s.renderOrder = -8; s.userData.base = i < 3 ? 1 : 0.7; s.raycast = () => {};
      stars.add(s); bright.push(s);
    }
    scene.add(stars);

    // ── comets and meteors ──
    const fx = new THREE.Group(); fx.renderOrder = -7; scene.add(fx);
    const streakTex = (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 16; const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 256, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.85, 'rgba(255,250,235,.55)'); g.addColorStop(1, 'rgba(255,255,255,1)');
      x.fillStyle = g; x.fillRect(0, 4, 256, 8); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const live = [];
    // events come from the shared world clock: every player under this sky
    // sees the same comet (and the same meteors) at the same moment
    function spawn(kind, id, age) {
      const r = rnd((id * 2654435761 % 2147483647 + (kind === 'comet' ? 7 : 3)) % 2147483646 + 1);
      r(); r();
      const Math = { random: r, PI: window.Math.PI, cos: window.Math.cos, sin: window.Math.sin };
      const len = kind === 'comet' ? R * (0.22 + Math.random() * 0.12) : R * (0.05 + Math.random() * 0.06);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, kind === 'comet' ? len * 0.06 : len * 0.02),
        new THREE.MeshBasicMaterial({ map: streakTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, color: kind === 'comet' ? 0xd8f0ff : 0xfff2d0, side: THREE.DoubleSide }));
      m.raycast = () => {}; m.frustumCulled = false;
      // a start point high in the sky and a direction across it
      const el = 0.35 + Math.random() * 0.5, az = Math.random() * Math.PI * 2;
      const start = new THREE.Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(R * 0.85);
      const dir = new THREE.Vector3(Math.random() - 0.5, -0.25 - Math.random() * 0.4, Math.random() - 0.5).normalize();
      const head = kind === 'comet' ? new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xe8f6ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })) : null;
      if (head) { const k = 26 * R / 1000; head.scale.set(k, k, 1); fx.add(head); }
      fx.add(m);
      live.push({ m, head, kind, t: age || 0, life: kind === 'comet' ? 40 + Math.random() * 30 : 0.7 + Math.random() * 0.8, start, dir, speed: kind === 'comet' ? R * 0.004 : R * 0.45, len });
    }
    const COMET_SLOT = 240, METEOR_SLOT = 6;   // a comet window every 4 minutes, a meteor chance every 6 s
    let lastComet = null, lastMeteor = null;
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), M4 = new THREE.Matrix4(), SUNSET = new THREE.Color(0xff9a5a);

    const ctl = {
      dome, stars, sunDir, day: 1, sunLight: o.sunLight || null,
      update(camera, dt, lat, lon) {
        if (!camera) return;
        dt = Math.min(0.1, dt || 0.016);
        // local time of day on the shared world clock (same for everyone)
        const t = (typeof window.worldSeconds === 'function') ? window.worldSeconds() : Date.now() / 1000;
        let H, phi = (lat || 0) * Math.PI / 180;
        if (window.DMTime && o.body) {
          // the real sky: hour angle from the body's own solar day on the world
          // clock (UTC on Earth), declination from its tilt and place in its year
          DMTime.sunDir(o.body, lat, lon, sunDir); sunDir.normalize();
          H = (((DMTime.dayFraction(o.body) + (lon || 0) / 360) % 1 + 1) % 1 - 0.5) * Math.PI * 2;
        } else {
          const len = DAY_WALL_SEC * (BODY_DAY[o.body && o.body.name] || 1);
          const frac = (((t / len) + (lon || 0) / 360) % 1 + 1) % 1;
          H = (frac - 0.5) * Math.PI * 2;
          // sun on a simple equatorial path, seen from this latitude (east = +x, north = -z)
          sunDir.set(-Math.sin(H), Math.cos(H) * Math.cos(phi), Math.cos(H) * Math.sin(phi)).normalize();
        }
        if (sunDir.y < -0.999) sunDir.y = -0.999;
        const day = Math.max(0, Math.min(1, (sunDir.y + 0.1) / 0.25));
        ctl.day = day; U.day.value = day; U.dir.value.copy(sunDir);
        dome.position.copy(camera.position); stars.position.copy(camera.position); fx.position.copy(camera.position);
        // the sky turns overhead with the day
        stars.rotation.y = -H * 0.9; stars.rotation.x = phi * 0.5;
        const vis = atmos ? Math.pow(1 - day, 1.5) : 1;
        field.visible = galaxy.visible = vis > 0.03;
        field.material.opacity = vis; galaxy.material.opacity = vis;
        field.material.color.setScalar(vis); galaxy.material.color.setScalar(vis);
        bright.forEach((s) => { s.material.opacity = s.userData.base * Math.max(atmos ? 0.22 : 1, vis); });
        // meteors at night, comets now and then
        const cs = Math.floor(t / COMET_SLOT), ms = Math.floor(t / METEOR_SLOT);
        if (cs !== lastComet) {
          if (lastComet !== null || (t - cs * COMET_SLOT) < 70) {
            // about one window in two has a comet; it starts a seeded moment into the window
            const h = ((cs * 2654435761) >>> 0) / 4294967296, start = cs * COMET_SLOT + h * 60;
            if (h < 0.55 && t >= start && t - start < 70) spawn('comet', cs, t - start);
          }
          lastComet = cs;
        }
        if (ms !== lastMeteor) {
          lastMeteor = ms;
          const h = ((ms * 2246822519) >>> 0) / 4294967296;
          if (h < 0.45 && vis > 0.35) spawn('meteor', ms, 0);
        }
        for (let i = live.length - 1; i >= 0; i--) {
          const L = live[i]; L.t += dt;
          const a = L.t / L.life;
          if (a >= 1) { fx.remove(L.m); L.m.geometry.dispose(); L.m.material.dispose(); if (L.head) { fx.remove(L.head); L.head.material.dispose(); } live.splice(i, 1); continue; }
          const p = v1.copy(L.start).addScaledVector(L.dir, L.speed * L.t);
          L.m.position.copy(p).addScaledVector(L.dir, -L.len * 0.5);
          // lie along its path, facing the viewer
          const toCam = v2.copy(p).negate().normalize();
          const side = v3.crossVectors(L.dir, toCam).normalize();
          const up = v4.crossVectors(side, L.dir);
          M4.makeBasis(L.dir, side, up); L.m.quaternion.setFromRotationMatrix(M4);
          const fade = Math.sin(Math.PI * a);
          const bright0 = L.kind === 'comet' ? (0.35 + 0.65 * vis) : vis;
          L.m.material.opacity = fade * bright0;
          if (L.head) { L.head.position.copy(p); L.head.material.opacity = fade * bright0; }
        }
        // the lights follow the sun: bright by day, cool starlight at night
        if (o.sunLight) {
          o.sunLight.intensity = (o.sunBase || 2) * (atmos ? (0.08 + 0.92 * day) : (sunDir.y > -0.05 ? 1 : 0.06));
          o.sunLight.color.copy(sunCol).lerp(SUNSET, atmos ? (1 - day) * Math.max(0, 1 - Math.abs(sunDir.y) * 6) * 0.7 : 0);
        }
        (o.fill || []).forEach((l) => { if (l.userData._base == null) l.userData._base = l.intensity; l.intensity = l.userData._base * (0.35 + 0.65 * day); });
        if (scene.fog && atmos) { if (!ctl._fogDay) ctl._fogDay = scene.fog.color.clone(); scene.fog.color.copy(ctl._fogDay).multiplyScalar(0.12 + 0.88 * day); }
        if (scene.background && scene.background.isColor && atmos) { if (!ctl._bgDay) ctl._bgDay = scene.background.clone(); scene.background.copy(ctl._bgDay).multiplyScalar(0.05 + 0.95 * day); }
      },
    };
    scene.userData.sky = ctl; scene.userData.skyDome = dome;
    return ctl;
  }
  window.DMSky = { create, starColor, DAY_WALL_SEC };
})();
