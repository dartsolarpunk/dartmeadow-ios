/* ============================================================================
   hair_strands.js  —  real-time individual-strand hair for the DART Meadow
   character (Ariel).  Self-contained ES module; the game loads it with ONE
   dynamic import after the character GLB finishes loading:

       import('./hair_strands.js').then(m=>m.attachHairStrands(CHAR,THREE,{url:...}))

   WHAT IT DOES (the same pipeline Unreal's groom framework uses, scaled to
   a web/WebGPU budget):
     1. ariel_hair_strands.bin holds the 5,665 evaluated strands exported from
        the Blender hair curves (Interpolate Hair Curves result), 10 control
        points each, stored in HEAD-BONE-LOCAL space.
     2. ~25 % of the strands are GUIDES that are physically simulated
        (position-based dynamics: verlet integration + distance constraints +
        a global shape-matching spring toward the groomed rest shape + capsule
        collision against head / neck / torso / shoulders + gravity + wind).
        The other ~75 % are CHILD strands that follow their nearest guide's
        deflection (this is exactly how Unreal/Blender-style guide-interpolated
        grooms run in real time).
     3. All strands are rendered as one camera-facing ribbon mesh whose
        positions are rewritten each frame.  The skinned hair-card mesh baked
        into the GLB (the "Ariel Hair" mesh) is hidden once strands are live;
        if this module or its data fails to load the cards simply stay visible.

   RUNTIME API (window.DART_HAIR after attach):
       HAIR.params   {gravity, damping, shapeStiffness, tipStiffness, wind:Vector3,
                      windGust, enabled, iterations}
       HAIR.addCollider({center:Vector3 (WORLD), radius, end?:Vector3}) -> handle
       HAIR.removeCollider(handle)
       HAIR.setEnabled(bool)       // false => cards come back
       HAIR.stats                  // {ms, strands, guides}
   Simulation is done in the character root's LOCAL (model-space) frame so it is
   precision-safe at planetary world coordinates; root motion is fed in as a
   clamped inertial shift so hair trails behind a moving / flying character.
   ========================================================================== */

export async function attachHairStrands(CHAR, THREE, opts = {}) {
  if (!CHAR || !CHAR.root) throw new Error('[hair] no character root');
  if (CHAR._hair) return CHAR._hair;
  const url = opts.url || 'characterassests/ariel_hair_strands.bin';
  const res = await fetch(url);
  if (!res.ok) throw new Error('[hair] fetch ' + url + ' -> ' + res.status);
  const buf = await res.arrayBuffer();
  const H = buildHair(CHAR, THREE, buf, opts);
  CHAR._hair = H;
  if (typeof window !== 'undefined') window.DART_HAIR = H;
  return H;
}

export function buildHair(CHAR, THREE, buf, opts = {}) {
  /* ---------------- parse ---------------- */
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'DHS1') throw new Error('[hair] bad magic ' + magic);
  const jl = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jl)));
  let off = 12 + jl;
  const N = meta.count, K = meta.points, G = meta.guides;
  const rest = new Float32Array(buf, off, N * K * 3); off += N * K * 12;
  const group = new Uint8Array(buf, off, N); off += (N + 3) & ~3;
  const guideOf = new Uint32Array(buf, off, N); off += N * 4;
  const guideStrand = new Uint32Array(buf, off, G);

  /* ---------------- guard: only attach to the matching character (has the hair-card mesh) ---------------- */
  const cardMeshes = [];
  CHAR.root.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && /Ariel.?Hair(?!Strands)/i.test(o.name)) cardMeshes.push(o); });
  if (!cardMeshes.length) throw new Error('[hair] character has no Ariel hair-card mesh (different character file) - strands not attached');

  /* ---------------- bones ---------------- */
  const root = CHAR.root;
  const findBone = (n) => (CHAR.bones && CHAR.bones[n]) || root.getObjectByName(n);
  const head = findBone(meta.headBone || 'Head');
  if (!head) throw new Error('[hair] Head bone not found');
  const cols = [];
  for (const c of meta.colliders || []) {
    const b = findBone(c.bone);
    if (b) cols.push({ bone: b, a: new THREE.Vector3(...c.a), b: new THREE.Vector3(...c.b), r: c.r,
                       wa: new THREE.Vector3(), wb: new THREE.Vector3() });
  }

  /* ---------------- auto body colliders (capsules along the skeleton) ----------------
     Strands stop at the arms, forearms, hands, chest/torso and shoulders instead of
     sliding through them. [bone, childBone|null, radius] - capsule runs bone -> child. */
  const BODY = [
    ['Spine01', 'Spine', 0.125], ['Spine', 'neck', 0.125], ['Spine02', 'Spine01', 0.125],
    ['LeftShoulder', 'LeftArm', 0.06], ['RightShoulder', 'RightArm', 0.06],
    ['LeftArm', 'LeftForeArm', 0.052], ['RightArm', 'RightForeArm', 0.052],
    ['LeftForeArm', 'LeftHand', 0.042], ['RightForeArm', 'RightHand', 0.042],
    ['LeftHand', null, 0.05], ['RightHand', null, 0.05],
    ['Hips', 'Spine02', 0.14],
  ];
  const autoCols = [];
  if (opts.params ? opts.params.bodyColliders !== false : true) {
    for (const [bn, cn, r] of BODY) {
      const b = findBone(bn); if (!b) continue;
      const a = new THREE.Vector3(0, 0, 0), e = new THREE.Vector3(0, 0, 0);
      if (cn) { const c = findBone(cn); if (!c) continue; e.copy(c.position); if (c.parent !== b) continue; }
      autoCols.push({ bone: b, a, b: e, r, wa: new THREE.Vector3(), wb: new THREE.Vector3() });
    }
    cols.push(...autoCols);
  }

  /* ---------------- params ---------------- */
  const P = {
    enabled: true, gravity: 6.0, damping: 0.965, shapeStiffness: 0.9, tipStiffness: 0.03,
    wind: new THREE.Vector3(0, 0, 0), windGust: 0.35, iterations: 3, hairRadius: 0.006,
    maxRootStep: 0.06, drag: 1.6, motionWind: 0.05, maxMotionWind: 14, teleportSpeed: 400, popSpeed: 22, bodyColliders: true, minGravityScale: 0.0, interleave: 1, autoQuality: true,
    widthRoot: 0.0046, widthTip: 0.0022,
    ...(opts.params || {})
  };

  /* ---------------- guide rest data + segment lengths ---------------- */
  const gRest = new Float32Array(G * K * 3);
  const segLen = new Float32Array(G * (K - 1));
  const gStiff = new Float32Array(G * K);
  for (let g = 0; g < G; g++) {
    const s = guideStrand[g];
    for (let k = 0; k < K * 3; k++) gRest[g * K * 3 + k] = rest[s * K * 3 + k];
    for (let k = 1; k < K; k++) {
      const a = (g * K + k - 1) * 3, b = (g * K + k) * 3;
      segLen[g * (K - 1) + k - 1] = Math.hypot(gRest[b] - gRest[a], gRest[b + 1] - gRest[a + 1], gRest[b + 2] - gRest[a + 2]);
    }
    // bangs (group 1) & sideburns (2) are short: hold their shape harder
    const gr = group[s], boost = gr === 1 ? 1.6 : gr === 2 ? 1.8 : 1.0;
    for (let k = 0; k < K; k++) {
      const t = k / (K - 1);
      gStiff[g * K + k] = Math.min(0.95, (P.tipStiffness + (P.shapeStiffness - P.tipStiffness) * Math.pow(1 - t, 4)) * boost);
    }
  }
  const sp = new Float32Array(G * K * 3);      // sim position (root-local)
  const sq = new Float32Array(G * K * 3);      // previous position
  const restM = new Float32Array(G * K * 3);   // guide rest in root-local (current head pose)
  let needInit = true;

  const SP = new Float32Array(K * 3);
  // static rest-pose radial direction (head-local) per point -> volumetric normals without per-frame sqrt
  const radial = new Float32Array(N * K * 3);
  { const hcL = cols.length && cols[0].bone === head ? cols[0].a : new THREE.Vector3(0, 0.11, -0.01);
    for (let i = 0; i < N * K; i++) { const o = i * 3; let x = rest[o] - hcL.x, y = rest[o + 1] - hcL.y, z = rest[o + 2] - hcL.z; const l = Math.hypot(x, y, z) || 1; radial[o] = x / l; radial[o + 1] = y / l; radial[o + 2] = z / l; } }

  /* ---------------- render mesh ---------------- */
  const VERTS = N * K * 2;
  const pos = new Float32Array(VERTS * 3);
  const nrm = new Float32Array(VERTS * 3);
  const idx = new Uint32Array(N * (K - 1) * 6);
  let ii = 0;
  for (let s = 0; s < N; s++) {
    for (let k = 0; k < K - 1; k++) {
      const a = (s * K + k) * 2, b = a + 1, c = a + 2, d = a + 3;
      idx[ii++] = a; idx[ii++] = b; idx[ii++] = c; idx[ii++] = b; idx[ii++] = d; idx[ii++] = c;
    }
  }
  const col = new Float32Array(VERTS * 3);
  const base = meta.color || [0.005, 0.005, 0.006];
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let s = 0; s < N; s++) {
    const v = 0.75 + rnd() * 0.9;
    for (let k = 0; k < K * 2; k++) { const o = (s * K * 2 + k) * 3; col[o] = base[0] * v; col[o + 1] = base[1] * v; col[o + 2] = base[2] * v; }
  }
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3); aPos.setUsage(THREE.DynamicDrawUsage);
  const aNrm = new THREE.BufferAttribute(nrm, 3); aNrm.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('normal', aNrm);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, color: 0xffffff, roughness: meta.roughness ?? 0.5, metalness: 0.15,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'ArielHairStrands';
  mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
  const camPos = new THREE.Vector3();
  let haveCam = false;
  mesh.onBeforeRender = function (renderer, scene, camera) { camera.getWorldPosition(camPos); haveCam = true; };
  root.add(mesh);

  /* ---------------- hide skinned cards while strands are live ---------------- */
  const setCards = (v) => cardMeshes.forEach((m) => { m.visible = v; });
  setCards(false);

  /* ---------------- scratch ---------------- */
  const M = new THREE.Matrix4(), rootInv = new THREE.Matrix4(), tmpM = new THREE.Matrix4();
  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), camL = new THREE.Vector3();
  const lastRootW = new THREE.Vector3(); let haveLast = false;
  let lhx = 0, lhy = 0, lhz = 0, haveHL = false;
  const gravL = new THREE.Vector3(), windL = new THREE.Vector3(), windW = new THREE.Vector3(), velS = new THREE.Vector3();
  let gScale = 1;
  const extra = [];   // user colliders
  let time = 0, frame = 0, ema = 2, cool = 0;
  const stats = { ms: 0, strands: N, guides: G };

  function capsuleCollide(i, ax, ay, az, bx, by, bz, r) {
    // push particle i (sp) out of capsule (a,b,r)
    const o = i * 3;
    const px = sp[o], py = sp[o + 1], pz = sp[o + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const ab2 = abx * abx + aby * aby + abz * abz;
    let t = ab2 > 1e-12 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
    let dx = px - cx, dy = py - cy, dz = pz - cz;
    const d2 = dx * dx + dy * dy + dz * dz, rr = r + P.hairRadius;
    if (d2 < rr * rr) {
      const d = Math.sqrt(d2) || 1e-6;
      const k = rr / d;
      sp[o] = cx + dx * k; sp[o + 1] = cy + dy * k; sp[o + 2] = cz + dz * k;
    }
  }

  function step(h, simTime) {
    const hh = h * h;
    const damp = Math.pow(P.damping, h * 60);
    const gx = gravL.x * P.gravity * hh, gy = gravL.y * P.gravity * hh, gz = gravL.z * P.gravity * hh;
    // wind + gust (low frequency pseudo noise, per guide phase)
    for (let g = 0; g < G; g++) {
      const gb = g * K * 3;
      // pin root
      sp[gb] = restM[gb]; sp[gb + 1] = restM[gb + 1]; sp[gb + 2] = restM[gb + 2];
      sq[gb] = sp[gb]; sq[gb + 1] = sp[gb + 1]; sq[gb + 2] = sp[gb + 2];
      const ph = g * 0.37;
      const gust = 1 + P.windGust * Math.sin(simTime * 2.1 + ph) * Math.sin(simTime * 0.7 + ph * 1.7);
      const wx = windL.x * P.drag * gust * hh, wy = windL.y * P.drag * gust * hh, wz = windL.z * P.drag * gust * hh;
      for (let k = 1; k < K; k++) {
        const o = gb + k * 3;
        const vx = (sp[o] - sq[o]) * damp, vy = (sp[o + 1] - sq[o + 1]) * damp, vz = (sp[o + 2] - sq[o + 2]) * damp;
        sq[o] = sp[o]; sq[o + 1] = sp[o + 1]; sq[o + 2] = sp[o + 2];
        let x = sp[o] + vx + gx + wx, y = sp[o + 1] + vy + gy + wy, z = sp[o + 2] + vz + gz + wz;
        const st = gStiff[g * K + k];
        x += (restM[o] - x) * st; y += (restM[o + 1] - y) * st; z += (restM[o + 2] - z) * st;
        sp[o] = x; sp[o + 1] = y; sp[o + 2] = z;
      }
    }
    for (let it = 0; it < P.iterations; it++) {
      for (let g = 0; g < G; g++) {
        const gb = g * K * 3, lb = g * (K - 1);
        for (let k = 1; k < K; k++) {
          const a = gb + (k - 1) * 3, b = gb + k * 3;
          const dx = sp[b] - sp[a], dy = sp[b + 1] - sp[a + 1], dz = sp[b + 2] - sp[a + 2];
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
          const diff = (len - segLen[lb + k - 1]) / len;
          if (k === 1) { sp[b] -= dx * diff; sp[b + 1] -= dy * diff; sp[b + 2] -= dz * diff; }
          else {
            const f = 0.5 * diff;
            sp[a] += dx * f; sp[a + 1] += dy * f; sp[a + 2] += dz * f;
            sp[b] -= dx * f; sp[b + 1] -= dy * f; sp[b + 2] -= dz * f;
          }
        }
        if (it === P.iterations - 1) for (let k = 1; k < K; k++) {
          const i = g * K + k;
          for (let c = 0; c < cols.length; c++) {
            const C = cols[c];
            capsuleCollide(i, C.wa.x, C.wa.y, C.wa.z, C.wb.x, C.wb.y, C.wb.z, C.r);
          }
          for (let c = 0; c < extra.length; c++) {
            const C = extra[c];
            capsuleCollide(i, C.la.x, C.la.y, C.la.z, C.lb.x, C.lb.y, C.lb.z, C.lr);
          }
        }
      }
    }
  }

  function update(dt) {
    if (!P.enabled || !(dt > 0) || !root.visible) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    root.updateWorldMatrix(true, false);
    head.updateWorldMatrix(true, false);
    rootInv.copy(root.matrixWorld).invert();
    M.multiplyMatrices(rootInv, head.matrixWorld);   // head bone in root-local space
    const me = M.elements;
    // animation pop (clip loop / teleport of the head relative to the body): re-seed instead of whipping
    let popped = false;
    if (haveHL && dt > 0 && dt < 0.25 && Math.hypot(me[12] - lhx, me[13] - lhy, me[14] - lhz) / dt > P.popSpeed) popped = true;
    lhx = me[12]; lhy = me[13]; lhz = me[14]; haveHL = true;

    // colliders -> root-local capsules
    for (const C of cols) {
      tmpM.multiplyMatrices(rootInv, C.bone.matrixWorld);
      C.wa.copy(C.a).applyMatrix4(tmpM); C.wb.copy(C.b).applyMatrix4(tmpM);
    }
    for (const C of extra) {
      C.la = (C.la || new THREE.Vector3()).copy(C.center).applyMatrix4(rootInv);
      C.lb = (C.lb || new THREE.Vector3()).copy(C.end || C.center).applyMatrix4(rootInv);
      C.lr = C.radius * Math.cbrt(Math.abs(rootInv.determinant()));
    }
    // guide rest pose in root-local
    for (let g = 0; g < G; g++) {
      for (let k = 0; k < K; k++) {
        const o = (g * K + k) * 3, x = gRest[o], y = gRest[o + 1], z = gRest[o + 2];
        restM[o] = me[0] * x + me[4] * y + me[8] * z + me[12];
        restM[o + 1] = me[1] * x + me[5] * y + me[9] * z + me[13];
        restM[o + 2] = me[2] * x + me[6] * y + me[10] * z + me[14];
      }
    }
    if (needInit) { sp.set(restM); sq.set(restM); needInit = false; }
    if (popped) { sp.set(restM); sq.set(restM); velS.set(0, 0, 0); haveLast = false; }

    // root world motion -> small clamped inertial shift + steady apparent wind.
    // A flying character drags the hair back through a smooth airflow rather than
    // whipping it by teleporting particles every frame.
    // track the HEAD bone (not just the root): jumps/steps move the head through the clip's
    // own hip motion, and the hair has to feel that or it snaps with the head.
    v3.setFromMatrixPosition((head && head.matrixWorld) ? head.matrixWorld : root.matrixWorld);
    const rs = Math.cbrt(Math.abs(root.matrixWorld.determinant())) || 1;
    let motionWind = 0;
    if (haveLast && dt < 0.25) {
      v3b.copy(v3).sub(lastRootW);
      const l = v3b.length();
      if (l / rs / dt > P.teleportSpeed) { velS.set(0, 0, 0); }   // origin re-centre / teleport: ignore
      else {
        velS.lerp(v3b.clone().multiplyScalar(1 / dt), 1 - Math.exp(-dt * 5));
        const maxStep = P.maxRootStep * rs;
        let lc = l;
        if (lc > maxStep) { v3b.multiplyScalar(maxStep / lc); lc = maxStep; }
        if (lc > 1e-9) {
          v3b.transformDirection(rootInv).multiplyScalar(lc / rs);
          const sx = -v3b.x, sy = -v3b.y, sz = -v3b.z;
          for (let i = 0; i < G * K; i++) {
            const o = i * 3;
            sp[o] += sx; sp[o + 1] += sy; sp[o + 2] += sz;
            sq[o] += sx; sq[o + 1] += sy; sq[o + 2] += sz;
          }
        }
      }
    } else if (dt >= 0.25) { sp.set(restM); sq.set(restM); velS.set(0, 0, 0); }
    lastRootW.copy(v3); haveLast = true;
    const spd = velS.length() / rs;                       // body-lengths-ish per second
    motionWind = Math.min(P.maxMotionWind, spd * P.motionWind);
    windW.copy(P.wind);
    if (spd > 1e-3) windW.addScaledVector(velS, -motionWind / (velS.length() || 1));

    // gravity / wind into root-local directions
    const up = opts.getDown ? opts.getDown() : null;   // optional: world-space "down" vector
    gravL.set(up ? up.x : 0, up ? up.y : -1, up ? up.z : 0).transformDirection(rootInv);
    const gsT = opts.getGravityScale ? opts.getGravityScale() : 1;
    gScale += (gsT - gScale) * (1 - Math.exp(-dt * 3));
    gravL.multiplyScalar(Math.max(P.minGravityScale, gScale));
    windL.copy(windW).transformDirection(rootInv).multiplyScalar(windW.length());

    time += dt;
    const n = Math.min(2, Math.max(1, Math.ceil(dt / (1 / 60))));
    const h = Math.min(dt, 1 / 30) / n;
    for (let s = 0; s < n; s++) step(h, time);
    const tSim = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    stats.simMs = tSim - t0;

    /* ---- write render ribbons ---- */
    if (haveCam) camL.copy(camPos).applyMatrix4(rootInv); else camL.set(0, 1.6, 3);
    // head sphere center (for volumetric normals) in root-local
    const wR = P.widthRoot, wT = P.widthTip;
    frame++;
    const il = P.interleave | 0 || 1;
    for (let s = frame % il; s < N; s += il) {
      const g = guideOf[s];
      const rb = s * K * 3, gb = g * K * 3;
      // compute all K points for this strand first (cache in small local arrays)
      for (let k = 0; k < K; k++) {
        const o = rb + k * 3, x = rest[o], y = rest[o + 1], z = rest[o + 2];
        const go = gb + k * 3;
        SP[k * 3] = me[0] * x + me[4] * y + me[8] * z + me[12] + (sp[go] - restM[go]);
        SP[k * 3 + 1] = me[1] * x + me[5] * y + me[9] * z + me[13] + (sp[go + 1] - restM[go + 1]);
        SP[k * 3 + 2] = me[2] * x + me[6] * y + me[10] * z + me[14] + (sp[go + 2] - restM[go + 2]);
      }
      // per-strand view vector (normalised once) for the volumetric normal
      let sx0 = camL.x - SP[0], sy0 = camL.y - SP[1], sz0 = camL.z - SP[2];
      const sl = Math.sqrt(sx0 * sx0 + sy0 * sy0 + sz0 * sz0) || 1e-9; sx0 /= sl; sy0 /= sl; sz0 /= sl;
      for (let k = 0; k < K; k++) {
        const k0 = k > 0 ? k - 1 : 0, k1 = k < K - 1 ? k + 1 : K - 1;
        const tx = SP[k1 * 3] - SP[k0 * 3], ty = SP[k1 * 3 + 1] - SP[k0 * 3 + 1], tz = SP[k1 * 3 + 2] - SP[k0 * 3 + 2];
        const px = SP[k * 3], py = SP[k * 3 + 1], pz = SP[k * 3 + 2];
        const vx = camL.x - px, vy = camL.y - py, vz = camL.z - pz;
        let wx = ty * vz - tz * vy, wy = tz * vx - tx * vz, wz = tx * vy - ty * vx;
        const wd = (wR + (wT - wR) * (k / (K - 1))) * 0.5 / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1e-9);
        wx *= wd; wy *= wd; wz *= wd;
        const ro = rb + k * 3, rx0 = radial[ro], ry0 = radial[ro + 1], rz0 = radial[ro + 2];
        const nx = sx0 * 0.55 + (me[0] * rx0 + me[4] * ry0 + me[8] * rz0) * 0.45;
        const ny = sy0 * 0.55 + (me[1] * rx0 + me[5] * ry0 + me[9] * rz0) * 0.45;
        const nz = sz0 * 0.55 + (me[2] * rx0 + me[6] * ry0 + me[10] * rz0) * 0.45;
        const vo = (s * K + k) * 6;
        pos[vo] = px - wx; pos[vo + 1] = py - wy; pos[vo + 2] = pz - wz;
        pos[vo + 3] = px + wx; pos[vo + 4] = py + wy; pos[vo + 5] = pz + wz;
        nrm[vo] = nx; nrm[vo + 1] = ny; nrm[vo + 2] = nz; nrm[vo + 3] = nx; nrm[vo + 4] = ny; nrm[vo + 5] = nz;
      }
    }
    aPos.needsUpdate = true; aNrm.needsUpdate = true;
    stats.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    // adaptive governor: trade ribbon refresh rate (interleave) for CPU time on slow devices
    ema += (stats.ms - ema) * 0.05;
    if (P.autoQuality && --cool <= 0) {
      if (ema > 3.5 && (P.interleave | 0 || 1) < 3) { P.interleave = (P.interleave | 0 || 1) + 1; cool = 90; }
      else if (ema < 1.4 && (P.interleave | 0 || 1) > 1) { P.interleave = (P.interleave | 0 || 1) - 1; cool = 240; }
    }
    stats.interleave = P.interleave | 0 || 1;
  }

  /* ---------------- hook: run after the character's mixer each frame ---------------- */
  let origUpdate = null;
  const hook = () => {
    if (!CHAR.mixer || CHAR.mixer.__hairHooked) return;
    origUpdate = CHAR.mixer.update.bind(CHAR.mixer);
    CHAR.mixer.update = function (dt) { const r = origUpdate(dt); try { update(dt); } catch (e) { if (!H._warned) { H._warned = 1; console.warn('[hair] update', e); } } return r; };
    CHAR.mixer.__hairHooked = true;
  };

  const H = {
    params: P, stats, mesh, update, meta,
    setEnabled(v) { P.enabled = !!v; mesh.visible = !!v; setCards(!v); if (v) needInit = true; },
    addCollider(c) { extra.push(c); return c; },
    removeCollider(c) { const i = extra.indexOf(c); if (i >= 0) extra.splice(i, 1); },
    reset() { needInit = true; haveLast = false; },
    dispose() { root.remove(mesh); geo.dispose(); mat.dispose(); setCards(true); if (CHAR.mixer && origUpdate) { CHAR.mixer.update = origUpdate; CHAR.mixer.__hairHooked = false; } }
  };
  if (!opts.manual) hook();
  H.hook = hook;
  return H;
}
