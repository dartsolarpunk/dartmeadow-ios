/* DART Engine — the real Earth.
 *
 * One global relief map, land and sea floor, from NOAA's ETOPO5 (5-arc-
 * minute global relief, public domain, U.S. National Geophysical Data
 * Center), resampled to 2048×1024 (≈0.18° per pixel) and stored as a
 * lossless PNG: height in metres + 11000, high byte in red, low in green.
 *
 * Sea level is 0 m — the water line of the game's oceans. (The geoid, the
 * true shape of mean sea level, departs from the ellipsoid by under ±110 m;
 * at the game's scale that is far below a pixel, so sea level is taken as
 * the 0 m surface of this map.)
 *
 *   DMEarth.ready             true once decoded
 *   DMEarth.whenReady(ms)     promise, resolves when ready (or after ms)
 *   DMEarth.metres(lat, lon)  bilinear height in metres (negative = sea floor)
 *   DMEarth.texture()         THREE.DataTexture of the land value, for GPU use
 */
(function () {
  'use strict';
  const URL = 'static/earth/earth-relief.png?v=1';
  const W = 2048, H = 1024;
  let data = null, readyResolve = null, tex = null;
  const readyP = new Promise((r) => { readyResolve = r; });
  const api = {
    ready: false,
    whenReady(ms) { return Promise.race([readyP, new Promise((r) => setTimeout(r, ms || 0))]); },
    metres(lat, lon) {
      if (!data) return 0;
      const fx = ((((lon + 180) / 360) % 1 + 1) % 1) * W - 0.5, fy = Math.max(0, Math.min(H - 1.001, (90 - lat) / 180 * H - 0.5));
      let x0 = Math.floor(fx); const y0 = Math.floor(fy), ux = fx - x0, uy = fy - y0;
      x0 = (x0 + W) % W; const x1 = (x0 + 1) % W, y1 = Math.min(H - 1, y0 + 1);
      const a = data[y0 * W + x0], b = data[y0 * W + x1], c = data[y1 * W + x0], d = data[y1 * W + x1];
      return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
    },
    // the game's land value: >0 land (rising with altitude), <0 sea (falling with depth)
    land(lat, lon) { const e = api.metres(lat, lon); return e > 0 ? 0.05 + Math.pow(e / 4000, 0.7) : Math.max(-1, e / 4000); },
    texture() {
      if (tex || !data || !window.THREE) return tex;
      // land value packed 0..255 over -1..1.6, row 0 = south pole (v = 0), column 0 = 180°W
      const px = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        const lat = -90 + (y + 0.5) / H * 180;
        for (let x = 0; x < W; x++) {
          const lon = -180 + (x + 0.5) / W * 360, v = api.land(lat, lon), i = (y * W + x) * 4;
          px[i] = Math.max(0, Math.min(255, Math.round((v + 1) / 2.6 * 255))); px[i + 3] = 255;
        }
      }
      tex = new THREE.DataTexture(px, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
      tex.needsUpdate = true;
      return tex;
    },
  };
  function decode(src) {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    cx.drawImage(src, 0, 0, W, H);
    const px = cx.getImageData(0, 0, W, H).data;
    data = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) data[i] = px[i * 4] * 256 + px[i * 4 + 1] - 11000;
    api.ready = true; readyResolve(true);
    try { window.dispatchEvent(new CustomEvent('dm:earth-ready')); } catch (e) {}
  }
  function load() {
    // decoded with colour management OFF: the bytes are heights, not colours
    if (window.fetch && window.createImageBitmap) {
      fetch(URL).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
        .then(decode)
        .catch((e) => { console.warn('[earth] relief map unavailable — procedural continents used', e); readyResolve(false); });
      return;
    }
    const img = new Image();
    img.onload = () => { try { decode(img); } catch (e) { readyResolve(false); } };
    img.onerror = () => readyResolve(false);
    img.src = URL;
  }
  load();
  window.DMEarth = api;
})();
