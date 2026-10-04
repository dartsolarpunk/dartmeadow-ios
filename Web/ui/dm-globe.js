/* DART Meadow — the landing globe.
 * One round, collapsible globe docked at the left middle of the screen in
 * every world view: open space (it comes up by itself near a world you can
 * land on), on the ground and in the sky. It replaces the old LAND ON button,
 * the full-screen orbital approach and the flat land map.
 *
 *  • The globe is the world itself in miniature: the same whole-planet map the
 *    planet wears from orbit (worldMapFor: the very terrain you walk on, Earth's
 *    real continents), relief-shaded, drawn as a true sphere with a
 *    glowing latitude / meridian grid. It turns slowly on its own; drag to spin
 *    it, pinch or scroll to zoom, and it goes back to turning when left alone.
 *  • Real sunlight: the day side faces the star for this world at this moment on
 *    the shared world clock (DMTime — the same sun the ground and the sky use at
 *    every lat/lon), so a spot in daylight on the globe is in daylight when you
 *    land there; night is dim, with a soft dusk line between.
 *  • Tap it to plot a neon-green landing marker (tap again to move it).
 *  • Over the top, in every mode: ⟲ RESET VIEW (back to how it opened —
 *    centred on you on a world, zoom 1, turning again; in space it also
 *    clears the marker) and, up and left of it, ❚❚ PAUSE / ▶ PLAY the turntable: paused,
 *    the globe stays exactly where you left it after a drag or pinch.
 *  • The bubbles round its right side change with where you are:
 *      space  — LAND · SKY · ✦ MARK (save the plotted site) · INFO
 *      ground — FLY THERE (boards and auto-flies at M5) · SKY · ✦ MARK · ⌖ ME · ✕ CLEAR
 *      sky    — FLY THERE · LAND here · ◎ PICK (mark the ground near you) · ✦ MARK · Mach
 *               while auto-flying: CANCEL · IDLE · Mach · ✦ MARK · LAND here
 *  • On the ground and in the sky a ship's-compass halo rings it: N NE E SE S
 *    SW W NW and degree ticks, a marker that swings to the way you're looking
 *    (true north on this world), the nearest point lit, and the bearing in
 *    degrees at the marker when you're between points.
 *  • The small tab at the left edge folds it away and brings it back.
 */
(function(){
  'use strict';
  const D2R=Math.PI/180, R2D=180/Math.PI;
  const G={ el:null, cv:null, ctx:null, img:null, N:0, mode:null, body:null, spaceNear:null, bodyKey:'',
    lat0:15, lon0:0, zoom:1, target:null, lastUser:0, paused:false, drag:null, ptrs:new Map(), pinch0:0, zoom0:1,
    tex:null, texW:0, texH:0, hm:null, raf:0, lastT:0, collapsed:false, pref:null, D:120, B:34, H:0, hdg:null };
  try{ G.pref=JSON.parse(localStorage.getItem('dm_globe_v1')||'null'); }catch(e){}
  G.collapsed=!!(G.pref&&G.pref.collapsed);
  const $=id=>document.getElementById(id);
  const tst=(m,ms)=>{ try{ toast(m,ms||1800); }catch(e){} };
  const fmt=(lat,lon)=>{ try{ return _lmFmt(lat,lon); }catch(e){ return lat.toFixed(2)+','+lon.toFixed(2); } };
  const wrap=l=>((l+540)%360+360)%360-180;

  // ── where are we, and which world ──────────────────────────────────────
  function modeNow(){
    try{ if(typeof surfaceActive!=='undefined'&&surfaceActive&&typeof _surfBody!=='undefined'&&_surfBody) return 'surf'; }catch(e){}
    try{ if(typeof atmoActive!=='undefined'&&atmoActive&&typeof _atmoBody!=='undefined'&&_atmoBody) return 'atmo'; }catch(e){}
    try{ if(typeof STATE!=='undefined'&&STATE.screen==='flight'&&!(typeof SHIP_WALK!=='undefined'&&SHIP_WALK.active)) return 'space'; }catch(e){}
    return null;
  }
  function bodyFor(m){ return m==='surf'?_surfBody:m==='atmo'?_atmoBody:m==='space'?G.spaceNear:null; }
  function me(){ try{ return (G.mode==='surf'||G.mode==='atmo')?_lmMe():null; }catch(e){ return null; } }

  // ── the world's map, sampled into a small working copy ──────────────────
  const TW=512, TH=256;
  function loadBody(b){
    G.tex=null; G.hm=null; G.target=null; G.zoom=1;
    homeView();
    const take=src=>{ try{
        const c=document.createElement('canvas'); c.width=TW; c.height=TH; const x=c.getContext('2d',{willReadFrequently:true});
        x.drawImage(src,0,0,TW,TH); G.tex=x.getImageData(0,0,TW,TH).data; G.texW=TW; G.texH=TH;
      }catch(e){ console.warn('[globe] texture',e); } };
    const isEarth=b.name==='Earth';
    // Earth: the continent chart; everyone else starts on it and switches to the true ground map
    try{ const t=makeOrbitGlobeTexture(b); if(t&&t.image) take(t.image); }catch(e){}
    try{ worldMapFor(b,mp=>{ if(G.body!==b) return; G.hm={W:mp.W,H:mp.H,h:mp.heights}; if(!isEarth&&mp.tex&&mp.tex.image) take(mp.tex.image); }); }catch(e){ console.warn('[globe] worldmap',e); }
  }

  // how the globe opens: centred on you on a world, else a little north of the equator
  function homeView(){
    const m=me(); if(m){ G.lat0=Math.max(-60,Math.min(60,m.lat)); G.lon0=m.lon; } else { G.lat0=18; G.lon0=0; }
    G.zoom=1;
  }
  function resetView(){
    if(G.mode==='space') G.target=null;              // space's old RESET: the marker goes too
    homeView(); G.paused=false; G.lastUser=0; sync(); kick();
  }
  function toggleSpin(){
    G.paused=!G.paused; if(!G.paused) G.lastUser=0;   // play: turn again straight away
    tst(G.paused?'⏸ Globe held still — drag, pinch and zoom freely':'▶ Globe turning again',1300); kick();
  }

  // ── the star: where it stands over this world right now ────────────────
  // The subsolar point (lat = the sun's declination, lon = where it is local
  // noon), from DMTime — the clock and the formula the ground and sky scenes
  // light themselves with (DMSky → DMTime.sunDir), so the globe's day side is
  // exactly where the ground is in daylight. Same lat/lon as land coordinates.
  function sunVec(){
    const b=G.body; if(!b||!window.DMTime) return null;
    try{ const dec=DMTime.declination(b), lo=DMTime.subsolarLon(b)*D2R, cd=Math.cos(dec);
      return [cd*Math.cos(lo),Math.sin(dec),cd*Math.sin(lo)]; }catch(e){ return null; }
  }
  // how high the sun stands at a lat/lon (sin of its elevation); >0 is day
  function sunAt(lat,lon){ const S=sunVec(); if(!S) return null; const la=lat*D2R, lo=lon*D2R, cl=Math.cos(la);
    return cl*Math.cos(lo)*S[0]+Math.sin(la)*S[1]+cl*Math.sin(lo)*S[2]; }
  // the map's dark tones opened up a little so the sunlit side reads bright
  const LIFT=new Uint8Array(256); for(let i=0;i<256;i++) LIFT[i]=Math.round(255*Math.pow(i/255,0.75));
  // daylight 0..1 — the ground sky's own day ramp (ui/dm-sky.js)
  const dayRamp=mu=>Math.max(0,Math.min(1,(mu+0.1)/0.25));

  // ── drawing: a sunlit sphere, its grid, the markers ───────────────────
  function basis(){
    const la=G.lat0*D2R, lo=G.lon0*D2R, cl=Math.cos(la), sl=Math.sin(la), co=Math.cos(lo), so=Math.sin(lo);
    return { f:[cl*co,sl,cl*so], r:[-so,0,co], u:[-sl*co,cl,-sl*so] };
  }
  function proj(B,lat,lon,Rz,c){
    const la=lat*D2R, lo=lon*D2R, cl=Math.cos(la), P=[cl*Math.cos(lo),Math.sin(la),cl*Math.sin(lo)];
    const x=P[0]*B.r[0]+P[2]*B.r[2], y=P[0]*B.u[0]+P[1]*B.u[1]+P[2]*B.u[2], z=P[0]*B.f[0]+P[1]*B.f[1]+P[2]*B.f[2];
    return {x:c+x*Rz, y:c-y*Rz, z};
  }
  function unproj(px,py){
    const N=G.N, c=N/2, R0=c*0.94, Rz=R0*G.zoom, B=basis();
    if((px-c)**2+(py-c)**2>R0*R0) return null;
    const dx=(px-c)/Rz, dy=(c-py)/Rz, q=dx*dx+dy*dy; if(q>1) return null;
    const dz=Math.sqrt(1-q);
    const wx=dx*B.r[0]+dy*B.u[0]+dz*B.f[0], wy=dy*B.u[1]+dz*B.f[1], wz=dx*B.r[2]+dy*B.u[2]+dz*B.f[2];
    return {lat:Math.asin(Math.max(-1,Math.min(1,wy)))*R2D, lon:Math.atan2(wz,wx)*R2D};
  }
  function render(){
    const N=G.N, ctx=G.ctx; if(!N||!ctx) return;
    if(!G.img||G.img.width!==N) G.img=ctx.createImageData(N,N);
    const d=G.img.data, c=N/2, R0=c*0.94, Rz=R0*G.zoom, B=basis(), T=G.tex, hm=G.hm;
    const S=sunVec()||[B.f[0]*0.6-B.r[0]*0.5+B.u[0]*0.6,B.f[1]*0.6+B.u[1]*0.6,B.f[2]*0.6-B.r[2]*0.5+B.u[2]*0.6], R02=R0*R0;
    for(let py=0;py<N;py++){
      const dy=(c-py-0.5)/Rz, wy0=(py+0.5-c);
      for(let px=0;px<N;px++){
        const i=(py*N+px)*4, wx0=px+0.5-c;
        if(wx0*wx0+wy0*wy0>R02){ d[i+3]=0; continue; }
        const dx=(px+0.5-c)/Rz, q=dx*dx+dy*dy;
        if(q>1){ d[i]=2; d[i+1]=8; d[i+2]=18; d[i+3]=120; continue; }   // space behind the globe, inside the window
        const dz=Math.sqrt(1-q);
        const wx=dx*B.r[0]+dy*B.u[0]+dz*B.f[0], wy=dy*B.u[1]+dz*B.f[1], wz=dx*B.r[2]+dy*B.u[2]+dz*B.f[2];
        const lat=Math.asin(wy>1?1:wy<-1?-1:wy), lon=Math.atan2(wz,wx);
        const mu=wx*S[0]+wy*S[1]+wz*S[2], day=mu<-0.1?0:mu>0.15?1:(mu+0.1)/0.25;
        // night ~0.24 (still readable), full sun up to ~1.8, a soft dusk between
        const sq=Math.sqrt(mu>0?mu:0);
        let sh=0.22+day*(0.72+0.86*sq);
        let r=40,g=70,b=110;
        if(T){ const u=((lon/(2*Math.PI)+0.5)*TW)|0, v=((0.5-lat/Math.PI)*TH)|0, k=((v<0?0:v>=TH?TH-1:v)*TW+(u>=TW?TW-1:u))*4; r=LIFT[T[k]]; g=LIFT[T[k+1]]; b=LIFT[T[k+2]]; }
        if(hm){ // relief: the slope of the true ground, lit from the north-west
          const W=hm.W,H=hm.H, u=((lon/(2*Math.PI)+0.5)*W)|0, v=((0.5-lat/Math.PI)*H)|0, vv=v<1?1:v>H-2?H-2:v, uu=u>=W?W-1:u;
          const gx=hm.h[vv*W+(uu+1)%W]-hm.h[vv*W+(uu-1+W)%W], gy=hm.h[(vv-1)*W+uu]-hm.h[(vv+1)*W+uu];
          let k=(-gx*0.7+gy*0.7)*0.012*(0.35+0.65*day); k=k<-0.35?-0.35:k>0.35?0.35:k; sh*=1+k;
        }
        sh*=0.86+0.14*dz;                       // a little limb darkening
        let R=r*sh, Gc=g*sh, Bc=b*sh;
        if(day>0){ const w=day*0.1*(mu>0?mu:0), lum=(r*0.3+g*0.55+b*0.15), a=day*sq*(lum<160?1-lum/160:0);   // sunlit haze: dark seas read bright by day too
          R+=(255-R)*w+36*a; Gc+=(250-Gc)*w+58*a; Bc+=(235-Bc)*w+92*a; }
        if(day<1){ const n=1-day; R*=1-0.3*n; Gc*=1-0.2*n; Bc=Bc*(1+0.05*n)+10*n; }      // night: cool and dim
        const dusk=mu>-0.07&&mu<0.07?(1-Math.abs(mu)/0.07)*0.32:0;                        // the terminator, a warm soft line
        if(dusk){ R+=(255-R)*dusk; Gc+=(150-Gc)*dusk; Bc+=(70-Bc)*dusk; }
        d[i]=R>255?255:R; d[i+1]=Gc>255?255:Gc; d[i+2]=Bc>255?255:Bc; d[i+3]=255;
      }
    }
    ctx.putImageData(G.img,0,0);
    const dpr=N/G.D;
    ctx.save(); ctx.beginPath(); ctx.arc(c,c,R0,0,Math.PI*2); ctx.clip();
    // glowing latitude / meridian grid
    ctx.lineWidth=1.1*dpr; ctx.shadowColor='rgba(70,170,255,.95)'; ctx.shadowBlur=5*dpr;
    const line=(pts,eq)=>{ ctx.strokeStyle=eq?'rgba(140,215,255,.95)':'rgba(70,160,255,.62)'; ctx.beginPath(); let on=false;
      for(const p of pts){ if(p.z>0.02){ if(on) ctx.lineTo(p.x,p.y); else { ctx.moveTo(p.x,p.y); on=true; } } else on=false; } ctx.stroke(); };
    for(let la=-60;la<=60;la+=30){ const pts=[]; for(let lo=-180;lo<=180;lo+=4) pts.push(proj(B,la,lo,Rz,c)); line(pts,la===0); }
    for(let lo=-180;lo<180;lo+=30){ const pts=[]; for(let la=-88;la<=88;la+=4) pts.push(proj(B,la,lo,Rz,c)); line(pts,lo===0); }
    ctx.shadowBlur=0;
    // journal waypoints on this world
    try{ if(window.DMJournal&&G.body){ DMJournal.store.entries.forEach(e=>{ const p=e.place||{}; if(e.hidden||e.kind==='space'||p.body!==G.body.name||!p.site) return;
        let lat=p.site.lat, lon=p.site.lon; if(e.kind==='atmo'&&isFinite(p.x)){ lat=p.site.lat-p.z*ATMO_DEG_PER_UNIT; lon=wrap(p.site.lon+p.x*ATMO_DEG_PER_UNIT); }
        const s=proj(B,lat,lon,Rz,c); if(s.z<=0.05) return; const k=4*dpr;
        ctx.fillStyle=e.kind==='surface'?'#ffcc33':'#9fd8ff'; ctx.beginPath(); ctx.moveTo(s.x,s.y-k); ctx.lineTo(s.x+k*0.8,s.y); ctx.lineTo(s.x,s.y+k); ctx.lineTo(s.x-k*0.8,s.y); ctx.closePath(); ctx.fill(); }); } }catch(e){}
    const t=performance.now()/1000;
    // you: a cyan arrow pointing the way you face
    const m=me();
    if(m){ const s=proj(B,m.lat,m.lon,Rz,c); if(s.z>0.05){ let yaw=0; try{ yaw=_lmYaw(); }catch(e){}
        const a=proj(B,m.lat+Math.cos(yaw)*2,m.lon-Math.sin(yaw)*2/Math.max(0.2,Math.cos(m.lat*D2R)),Rz,c), ang=Math.atan2(a.x-s.x,-(a.y-s.y));
        ctx.save(); ctx.translate(s.x,s.y); ctx.rotate(ang); const k=dpr;
        ctx.fillStyle='rgba(0,229,255,.28)'; ctx.beginPath(); ctx.arc(0,0,(8+Math.sin(t*3)*1.5)*k,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#fff'; ctx.strokeStyle='#00e5ff'; ctx.lineWidth=1.3*k; ctx.beginPath(); ctx.moveTo(0,-6*k); ctx.lineTo(4.2*k,5*k); ctx.lineTo(0,2*k); ctx.lineTo(-4.2*k,5*k); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore(); } }
    // the landing marker: neon green, pulsing
    let tg=G.target; try{ if(!tg&&G.mode==='atmo'&&atmoState&&atmoState.auto) tg={lat:atmoState.auto.lat,lon:atmoState.auto.lon}; }catch(e){}
    if(tg){ const s=proj(B,tg.lat,tg.lon,Rz,c);
      if(s.z>0.02){ const k=dpr; ctx.shadowColor='#39ff6a'; ctx.shadowBlur=10*k;
        ctx.strokeStyle='#39ff6a'; ctx.lineWidth=2*k; ctx.beginPath(); ctx.arc(s.x,s.y,(7+Math.sin(t*4)*1.6)*k,0,Math.PI*2); ctx.stroke();
        ctx.fillStyle='#b9ffc9'; ctx.beginPath(); ctx.arc(s.x,s.y,3*k,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
        if(m){ const ms=proj(B,m.lat,m.lon,Rz,c); if(ms.z>0.05){ ctx.setLineDash([4*k,4*k]); ctx.strokeStyle='rgba(57,255,106,.55)'; ctx.lineWidth=1.2*k; ctx.beginPath(); ctx.moveTo(ms.x,ms.y); ctx.lineTo(s.x,s.y); ctx.stroke(); ctx.setLineDash([]); } } } }
    ctx.restore();
    // the atmosphere's rim glow and the window's edge
    if(Rz<R0*1.25){ const gr=ctx.createRadialGradient(c,c,Rz*0.9,c,c,Math.min(R0,Rz*1.08));
      gr.addColorStop(0,'rgba(120,200,255,0)'); gr.addColorStop(0.55,'rgba(150,215,255,.45)'); gr.addColorStop(1,'rgba(120,200,255,0)');
      ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(c,c,R0,0,Math.PI*2); ctx.fill(); }
    ctx.strokeStyle='rgba(140,210,255,.55)'; ctx.lineWidth=1.2*dpr; ctx.beginPath(); ctx.arc(c,c,R0,0,Math.PI*2); ctx.stroke();
  }
  // ── the compass halo ───────────────────────────────────────────────────
  // Bearing the camera looks along, clockwise from this world's north: the
  // ground and sky frames run x → east, −z → north (see _lmMe).
  const _hv={x:0,y:0,z:0};
  function heading(){
    let cam=null; try{ cam=G.mode==='surf'?surfCamera:G.mode==='atmo'?atmoCamera:null; }catch(e){}
    if(cam&&cam.matrixWorld){ const e=cam.matrixWorld.elements; _hv.x=-e[8]; _hv.z=-e[10];
      if(_hv.x*_hv.x+_hv.z*_hv.z>1e-6) return ((Math.atan2(_hv.x,-_hv.z)*R2D)%360+360)%360; }
    try{ return ((-_lmYaw()*R2D)%360+360)%360; }catch(e){ return null; }
  }
  const PTS=['N','NE','E','SE','S','SW','W','NW'];
  function halo(now){
    const cv=G.hcv; if(!cv||!G.H) return;
    const h=heading(); if(h==null) return;
    if(!G.hFont) G.hFont=(getComputedStyle(document.body).getPropertyValue('--font-hud')||'').trim()||'sans-serif';
    const dt=Math.min(0.1,(now-(G.hT||now))/1000); G.hT=now;
    if(G.hdg==null) G.hdg=h; else { const d=((h-G.hdg+540)%360)-180; G.hdg=(G.hdg+d*Math.min(1,dt*14)+360)%360; }   // smooth, the short way round
    const dpr=Math.min(2,window.devicePixelRatio||1), D=G.D, Hh=G.H, S=Math.round((D+2*Hh)*dpr);
    if(cv.width!==S){ cv.width=S; cv.height=S; }
    const x=cv.getContext('2d'), c=S/2, r0=(D/2+1)*dpr, r1=(D/2+Hh)*dpr, rm=(r0+r1)/2, small=D<110;
    x.clearRect(0,0,S,S);
    x.fillStyle='rgba(4,12,26,.55)'; x.beginPath(); x.arc(c,c,r1,0,Math.PI*2); x.arc(c,c,r0,0,Math.PI*2,true); x.fill();
    x.strokeStyle='rgba(110,190,255,.55)'; x.lineWidth=dpr; x.beginPath(); x.arc(c,c,r1-0.5*dpr,0,Math.PI*2); x.stroke();
    const hd=G.hdg, near=Math.round(hd/45)%8, off=Math.abs(((hd-near*45+540)%360)-180);
    // ticks: every 10° (every 15° on a small globe), longer at the eight points
    x.lineCap='round';
    x.strokeStyle='rgba(160,215,255,.5)'; x.lineWidth=dpr*0.9; x.beginPath();
    const tl=0.28*(r1-r0), ro=r1-1.5*dpr;
    for(let a=0;a<360;a+=small?15:10){ if(a%45===0) continue;
      const t=(a-90)*D2R, cs=Math.cos(t), sn=Math.sin(t); x.moveTo(c+cs*ro,c+sn*ro); x.lineTo(c+cs*(ro-tl),c+sn*(ro-tl)); }
    x.stroke();
    // the eight points
    x.textAlign='center'; x.textBaseline='middle';
    for(let i=0;i<8;i++){
      const t=(i*45-90)*D2R, lit=i===near, card=i%2===0;
      const fs=(card?0.72:0.56)*(r1-r0)*(lit?1.12:1);
      x.font=(lit||card?'700 ':'600 ')+fs.toFixed(1)+'px '+G.hFont;
      x.fillStyle=lit?'#39ff6a':i===0?'#ff7a7a':card?'rgba(225,242,255,.92)':'rgba(170,210,240,.75)';
      x.shadowColor=lit?'rgba(57,255,106,.9)':'rgba(0,0,0,0)'; x.shadowBlur=lit?6*dpr:0;
      x.fillText(PTS[i],c+Math.cos(t)*rm,c+Math.sin(t)*rm+0.5*dpr);
    }
    x.shadowBlur=0;
    // the marker: a bright notch across the band, pointing in at the globe
    const t=(hd-90)*D2R, ux=Math.cos(t), uy=Math.sin(t), px=-uy, py=ux, w=(r1-r0)*0.42;
    x.fillStyle='#eaffff'; x.shadowColor='rgba(120,230,255,.95)'; x.shadowBlur=7*dpr;
    x.beginPath(); x.moveTo(c+ux*(r0+1*dpr),c+uy*(r0+1*dpr)); x.lineTo(c+ux*r1+px*w,c+uy*r1+py*w); x.lineTo(c+ux*r1-px*w,c+uy*r1-py*w); x.closePath(); x.fill();
    x.shadowBlur=0;
    // between points: the bearing in degrees, just inside the rim at the marker
    const deg=G.el.querySelector('.dg-deg');
    if(deg){
      const show=off>6;
      if(show){ const tx=Math.round(hd)%360+'°'; if(deg.textContent!==tx) deg.textContent=tx;
        const rr=D/2-(small?10:12); deg.style.transform='translate(-50%,-50%) translate('+(ux*rr).toFixed(1)+'px,'+(uy*rr).toFixed(1)+'px)'; }
      deg.classList.toggle('on',show);
    }
  }
  function frame(now){
    G.raf=0;
    if(!G.el||G.el.style.display==='none'||G.collapsed||document.body.classList.contains('hud-off')) return;
    G.raf=requestAnimationFrame(frame);
    halo(now);
    if(now-G.lastT<33) return;                                // ~30 fps is plenty for a turning globe
    const dt=Math.min(0.1,(now-(G.lastT||now))/1000); G.lastT=now;
    if(!G.paused&&!G.drag&&G.ptrs.size===0&&now-G.lastUser>3500) G.lon0=wrap(G.lon0-7*dt);   // the turntable, eastward under you
    render(); readout();
  }
  const kick=()=>{ if(!G.raf) G.raf=requestAnimationFrame(frame); };

  // ── the bubbles ────────────────────────────────────────────────────────
  const ICON={land:'⬇',sky:'🛹',mark:'✦',info:'ⓘ',reset:'⟲',spin:'❚❚',fly:'⇢',me:'⌖',clear:'✕',pick:'◎',cancel:'✕',idle:'⏸',mach:'≋'};
  function machName(){ try{ return MACH_PRESETS[atmoPreset].name; }catch(e){ return 'M1'; } }
  // over the top in every mode (fixed angles: straight up, then up and left)
  const A_RESET=-90, A_SPIN=-126;
  function bubbleSet(){
    const top=[
      {k:'reset',t:'RESET',a:A_RESET,tip:G.mode==='space'?'Reset view — back to how the globe opened, turning again; clears the marker':'Reset view — back to how the globe opened (centred on you), turning again',on:resetView},
      {k:'spin',t:G.paused?'PLAY':'PAUSE',ic:G.paused?'▶\uFE0E':'❚❚',a:A_SPIN,lit:()=>G.paused,tip:G.paused?'Play — let the globe turn again':'Pause — stop the globe turning so you can look around it',on:toggleSpin}];
    return top.concat(modeBubbles());
  }
  function modeBubbles(){
    if(G.mode==='space') return [
      {k:'land',t:'LAND',tip:'Land and walk at the marker',need:true,on:()=>goSurface()},
      {k:'sky',t:'SKY',tip:'Fly the skyboard in the sky above the marker',need:true,on:()=>goSky()},
      {k:'mark',t:'MARK',tip:'Save the plotted site to your Journal',need:true,on:()=>markTarget()},
      {k:'info',t:'INFO',tip:'About this world',on:()=>info()}];
    if(G.mode==='surf') return [
      {k:'fly',t:'FLY',tip:'FLY THERE — board, lift off and auto-fly to the marker at '+(()=>{ try{ return MACH_PRESETS[MACH_AUTO_DEFAULT].name; }catch(e){ return 'M5'; } })(),need:true,on:()=>{ const t=G.target; try{ _lmWalkFly(t.lat,t.lon); }catch(e){} }},
      {k:'sky',t:'SKY',tip:'Board the skyboard and lift off from here',on:()=>{ try{ surfRemountSkyboard(); }catch(e){} }},
      {k:'mark',t:'MARK',tip:'Drop a Journal marker right here',on:()=>markHere()},
      {k:'me',t:'ME',tip:'Centre the globe on you',on:()=>centreMe()},
      {k:'clear',t:'CLEAR',tip:'Clear the landing marker',need:true,on:()=>{ G.target=null; sync(); }}];
    if(G.mode==='atmo'){
      let auto=false, landing=false; try{ auto=!!(atmoState&&atmoState.auto); landing=!!(atmoState&&atmoState.landing); }catch(e){}
      const land={k:'land',t:'LAND',tip:'Land right below the board',off:landing,on:()=>{ try{ atmoLandHere(); }catch(e){} }};
      const mach={k:'mach',t:machName(),tip:'Cruise speed — tap for the next Mach bubble',on:()=>{ try{ setAtmoPreset((atmoPreset+1)%MACH_PRESETS.length); }catch(e){} }};
      const mark={k:'mark',t:'MARK',tip:'Drop a Journal marker right here',on:()=>markHere()};
      if(auto) return [
        {k:'cancel',t:'CANCEL',tip:'Cancel the auto-flight — you have the board',on:()=>cancelAuto()},
        {k:'idle',t:'IDLE',tip:'IDLE — full stop & hover in place',lit:()=>{ try{ return !!atmoIdle; }catch(e){ return false; } },on:()=>{ try{ toggleAtmoIdle(); }catch(e){} }},
        mach, mark, land];
      return [
        {k:'fly',t:'FLY',tip:'FLY THERE — autopilot to the marker',need:true,off:landing,on:()=>{ const t=G.target; try{ atmoFlyTo(t.lat,t.lon); }catch(e){} }},
        land,
        {k:'pick',t:'PICK',tip:'Marker tool: tap the ground near you to land there',off:landing,on:()=>{ try{ startLandPick(); }catch(e){} }},
        mark, mach];
    }
    return [];
  }
  let _sig='';
  function sync(){
    if(!G.el) return;
    const set=bubbleSet(), box=G.el.querySelector('.dg-bubbles');
    const sig=G.mode+'|'+set.map(b=>b.k+':'+(b.a!=null?'':b.t)).join(',');
    if(sig!==_sig){ _sig=sig; box.innerHTML='';
      set.forEach((b,i)=>{ const e=document.createElement('button'); e.type='button'; e.className='dg-b dg-'+b.k; e.dataset.i=i;
        if(b.a!=null) e.dataset.a=b.a;
        e.innerHTML='<i>'+(b.ic||ICON[b.k])+'</i><span>'+b.t+'</span>'; e.title=b.tip; e.setAttribute('aria-label',b.tip);
        e.addEventListener('click',ev=>{ ev.stopPropagation(); const cur=bubbleSet()[+e.dataset.i]; if(!cur) return;
          if(cur.off) return; if(cur.need&&!G.target){ tst('Tap the globe to plot a spot first',1600); pulse(); return; } cur.on(); sync(); setTimeout(sync,60); });
        box.appendChild(e); });
      layout(); }
    box.querySelectorAll('.dg-b').forEach((e,i)=>{ const b=set[i]; if(!b) return;
      e.classList.toggle('dim',!!(b.off||(b.need&&!G.target))); e.classList.toggle('lit',!!(b.lit&&b.lit()));
      const sp=e.querySelector('span'); if(sp.textContent!==b.t) sp.textContent=b.t;
      const ic=e.querySelector('i'), it=b.ic||ICON[b.k]; if(ic.textContent!==it) ic.textContent=it;
      if(e.title!==b.tip){ e.title=b.tip; e.setAttribute('aria-label',b.tip); } });
  }
  const pulse=()=>{ const w=G.el&&G.el.querySelector('.dg-globe'); if(!w) return; w.classList.remove('nudge'); void w.offsetWidth; w.classList.add('nudge'); };

  // ── what the bubbles do ───────────────────────────────────────────────
  function goSurface(){ const b=G.body, t=G.target; if(!b||!t) return; try{ _clearLandPrompt(); }catch(e){} tst('⬇ Landing on '+b.name+' at '+fmt(t.lat,t.lon),1800); enterSurface(b,{lat:t.lat,lon:t.lon}); }
  function goSky(){ const b=G.body, t=G.target; if(!b||!t) return; try{ _clearLandPrompt(); }catch(e){} tst('🛹 Into the sky over '+b.name+' at '+fmt(t.lat,t.lon),1800); enterAtmosphericFlight(b,{lat:t.lat,lon:t.lon}); }
  function markTarget(){
    const b=G.body, t=G.target; if(!b||!t||!window.DMJournal) return;
    try{ const place=Object.assign(_jnSysRef(),{body:b.name,site:{lat:+t.lat.toFixed(4),lon:+t.lon.toFixed(4)},x:0,z:0,yaw:0});
      const e=DMJournal.store.add((b.name+' · '+_jnSiteText(place.site)).slice(0,48),'surface',place);
      tst(e?'✦ Saved to your Journal: '+e.label:'Journal is full — delete a waypoint first',2000); }catch(e){ console.warn('[globe] mark',e); }
  }
  function markHere(){
    try{ const h=_jnHere(); if(!h||!window.DMJournal){ tst('Nothing to mark here yet'); return; }
      const e=DMJournal.store.add(h.title||'Waypoint',h.kind,h.place); tst(e?'✦ Marked: '+e.label:'Journal is full — delete a waypoint first',1800); }catch(e){}
  }
  // a new marker mid auto-flight: the autopilot turns for it (same speed, same landing choice)
  function retarget(){
    try{ const a=G.mode==='atmo'&&atmoState&&atmoState.auto; if(a&&!atmoState.landing){ const t=G.target; atmoFlyTo(t.lat,t.lon,{cruise:a.cruise,land:a.land}); } }catch(e){}
  }
  function cancelAuto(){
    try{ if(atmoState&&atmoState.auto){ atmoState.auto=null; try{ _landMarkerClear(); }catch(e){} atmoThrottle=0; try{ $('atmo-throttle').value=0; }catch(e){} tst('Auto-flight cancelled — you have the board',1600); } }catch(e){}
  }
  function centreMe(){ const m=me(); if(!m) return; G.lat0=Math.max(-80,Math.min(80,m.lat)); G.lon0=m.lon; G.lastUser=performance.now(); kick(); }
  function info(){
    const b=G.body; if(!b) return; let g=''; try{ const p=getSurfacePalette(b); if(p&&p.grav) g=' · '+(+p.grav).toFixed(2)+' g'; }catch(e){}
    let t=''; if(G.target){ const c=clock(G.target.lat,G.target.lon); if(c) t=' · marker'+c; }
    tst('🪐 '+b.name.toUpperCase()+' · '+(b.type||'World')+g+t+' — the lit side is day right now: tap the globe to plot a landing site, then LAND or SKY',3600);
  }

  // ── build, place, show ─────────────────────────────────────────────────
  function build(){
    if(G.el) return;
    const r=document.createElement('div'); r.id='dm-globe'; r.style.display='none';
    r.innerHTML='<button type="button" class="dg-tab" title="Hide / show the landing globe" aria-label="Hide or show the landing globe"><span>‹</span></button>'+
      '<div class="dg-wrap"><canvas class="dg-halo" aria-hidden="true"></canvas><div class="dg-globe"><canvas class="dg-cv"></canvas><div class="dg-read"></div><div class="dg-deg"></div></div><div class="dg-bubbles"></div></div>';
    document.body.appendChild(r); G.el=r; G.cv=r.querySelector('.dg-cv'); G.ctx=G.cv.getContext('2d',{willReadFrequently:true}); G.hcv=r.querySelector('.dg-halo');   // CPU canvas: we write every pixel ourselves, and it can't be lost to GPU pressure
    r.querySelector('.dg-tab').addEventListener('click',e=>{ e.stopPropagation(); setCollapsed(!G.collapsed,true); });
    const cv=G.cv;
    cv.addEventListener('pointerdown',e=>{ e.preventDefault(); e.stopPropagation(); try{ cv.setPointerCapture(e.pointerId); }catch(er){}
      G.ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY}); G.lastUser=performance.now();
      if(G.ptrs.size===1) G.drag={x:e.clientX,y:e.clientY,x0:e.clientX,y0:e.clientY,moved:0};
      else if(G.ptrs.size===2){ const [a,b]=[...G.ptrs.values()]; G.pinch0=Math.hypot(a.x-b.x,a.y-b.y); G.zoom0=G.zoom; G.drag=null; } kick(); });
    cv.addEventListener('pointermove',e=>{ if(!G.ptrs.has(e.pointerId)) return; e.preventDefault(); G.ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY}); G.lastUser=performance.now();
      if(G.ptrs.size>=2&&G.pinch0){ const [a,b]=[...G.ptrs.values()]; G.zoom=Math.max(1,Math.min(8,G.zoom0*Math.hypot(a.x-b.x,a.y-b.y)/G.pinch0)); return; }
      const d=G.drag; if(!d) return; const Rz=(G.D/2*0.94)*G.zoom, dx=e.clientX-d.x, dy=e.clientY-d.y;
      d.moved=Math.max(d.moved,Math.hypot(e.clientX-d.x0,e.clientY-d.y0));
      G.lon0=wrap(G.lon0-dx/Rz*R2D); G.lat0=Math.max(-85,Math.min(85,G.lat0+dy/Rz*R2D)); d.x=e.clientX; d.y=e.clientY; });
    const up=e=>{ if(!G.ptrs.has(e.pointerId)) return; G.ptrs.delete(e.pointerId); G.lastUser=performance.now();
      const d=G.drag; if(G.ptrs.size<2) G.pinch0=0;
      if(d&&G.ptrs.size===0&&d.moved<6&&e.type==='pointerup'){ const rc=cv.getBoundingClientRect(), k=G.N/rc.width;
        const p=unproj((e.clientX-rc.left)*k,(e.clientY-rc.top)*k);
        if(p){ G.target={lat:+p.lat.toFixed(4),lon:+p.lon.toFixed(4)}; retarget(); tst('◎ Marker '+fmt(p.lat,p.lon),1300); sync(); kick(); } }
      if(G.ptrs.size===0) G.drag=null; };
    cv.addEventListener('pointerup',up); cv.addEventListener('pointercancel',up);
    cv.addEventListener('wheel',e=>{ e.preventDefault(); e.stopPropagation(); G.zoom=Math.max(1,Math.min(8,G.zoom*(e.deltaY<0?1.15:1/1.15))); G.lastUser=performance.now(); kick(); },{passive:false});
    ['keydown','keyup'].forEach(t=>r.addEventListener(t,e=>e.stopPropagation()));
  }
  function setCollapsed(v,user){
    G.collapsed=!!v; if(G.el) G.el.classList.toggle('collapsed',G.collapsed);
    if(user&&G.mode!=='space'){ try{ localStorage.setItem('dm_globe_v1',JSON.stringify({collapsed:G.collapsed})); }catch(e){} }
    if(!G.collapsed) kick();
  }
  function expand(){ setCollapsed(false,true); }
  // sizes, and a free stretch of the left edge to sit in (clear of the tabs, sticks and pads)
  function layout(){
    if(!G.el) return;
    const W=window.innerWidth, H=window.innerHeight, short=H<520, narrow=W<620;
    let D=narrow?100:short?86:124, B=narrow?30:short?27:34;
    const root=G.mode==='surf'?$('surface-overlay'):G.mode==='atmo'?$('atmo-overlay'):$('screen-flight');
    // every bubble's angle: the fixed pair over the top, the rest on the arc round the right
    const angs=bubbleAngles(); let S52=0, S122=0, CL=0;
    angs.forEach(a=>{ const sn=Math.sin(a*D2R), cs=Math.cos(a*D2R); S52=Math.max(S52,-sn); S122=Math.max(S122,sn); CL=Math.max(CL,-cs); });
    // how far the globe + its bubble arc reach from the globe's centre
    // the compass halo (ground and sky): a band round the globe; the bubbles move out past it
    const hal=G.mode==='surf'||G.mode==='atmo', hW=D=>hal?Math.round(Math.max(11,Math.min(15,D*0.115))):0;
    const ringR=(D,B)=>hal?D/2+hW(D)+B/2+3:D/2+B*0.78;
    const ext=(D,B)=>{ const ring=ringR(D,B); return {up:Math.max(D/2,ring*S52+B/2), dn:Math.max(D/2+16,ring*S122+B/2), w:D/2+ring+B/2+8, l:Math.max(0,ring*CL+B/2-D/2)}; };
    let topLim=8, botLim=H-8;
    const rects=[];
    if(root){ const hdr=G.mode==='space'?null:root.querySelector(':scope>div'); if(hdr){ const q=hdr.getBoundingClientRect(); if(q.height) topLim=Math.max(topLim,q.bottom+6); }
      root.querySelectorAll('button,.joystick-zone,#minimap,[id$="-zone"],#level-stack,#atmo-overlay>div,.world-music,#audio-player,.hud-c').forEach(e=>{
        if(e.closest('#dm-globe')) return; const cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden') return;
        const q=e.getBoundingClientRect(); if(!q.width||!q.height||q.width>W*0.6||q.height>H*0.6) return; rects.push(q); }); }
    ['fs-exit','fs-enter','jots-chat'].forEach(id=>{ const e=$(id); if(e&&getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'){ const q=e.getBoundingClientRect(); if(q.width) rects.push(q); } });
    const gapsIn=(x0,x1,lo,hi)=>{ const ob=rects.filter(q=>q.left<x1&&q.right>x0&&q.bottom>lo&&q.top<hi).map(q=>[q.top-6,q.bottom+6]).sort((a,b)=>a[0]-b[0]);
      const g=[]; let y=lo; for(const [a,b] of ob){ if(a>y) g.push([y,a]); y=Math.max(y,b); } if(hi>y) g.push([y,hi]); return g; };
    const X0=24+hW(D); let X=X0, e=ext(D,B), need=e.up+e.dn;
    // pick the gap down the left edge that fits, nearest the middle; else the biggest
    let gaps=gapsIn(0,X+e.w,topLim,botLim), fit=gaps.filter(g=>g[1]-g[0]>=need);
    const mid=g=>Math.abs((g[0]+g[1])/2-H/2);
    let best=fit.length?fit.sort((a,b)=>mid(a)-mid(b))[0]:gaps.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]))[0]||[topLim,botLim];
    if(best[1]-best[0]<need*0.74){
      // no room between the edge tabs: dock just right of the tab column instead
      const col=rects.filter(q=>q.left<30&&q.right<W*0.3&&q.top>Math.max(topLim,50)&&q.top<H*0.62);
      if(col.length) X=Math.round(Math.max(...col.map(q=>q.right))+8+e.l);
      gaps=gapsIn(X-e.l,X+e.w,topLim,botLim); fit=gaps.filter(g=>g[1]-g[0]>=need*0.74);
      best=(fit.length?fit.sort((a,b)=>mid(a)-mid(b))[0]:gaps.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]))[0])||[topLim,botLim];
    }
    const minD=Math.round(D*0.62), B0=B, D0=D;
    while(e.up+e.dn>best[1]-best[0]&&D>minD){ D-=2; B=Math.round(Math.max(24,B0*Math.max(0.8,D/D0))); e=ext(D,B); }
    const cy=Math.round(Math.max(best[0]+e.up,Math.min(best[1]-e.dn,(best[0]+e.up+best[1]-e.dn)/2)));
    G.D=D; G.B=B; G.H=hW(D);
    const s=G.el.style; s.setProperty('--dg-d',D+'px'); s.setProperty('--dg-b',B+'px'); s.setProperty('--dg-x',X+'px'); s.setProperty('--dg-tx',(X>X0?X-22-G.H:0)+'px'); s.setProperty('--dg-h',G.H+'px'); s.top=(cy-D/2)+'px';
    const dpr=Math.min(2,window.devicePixelRatio||1), N=Math.round(Math.min(260,D*dpr));
    if(G.cv.width!==N){ G.cv.width=N; G.cv.height=N; G.N=N; G.img=null; }
    // bubbles on an arc round the right side, from upper right to below
    const bs=[...G.el.querySelectorAll('.dg-b')], ring=ringR(D,B), angs2=bubbleAngles();
    bs.forEach((e,i)=>{ const a=angs2[i]*D2R; e.style.left=Math.round(D/2+Math.cos(a)*ring-B/2)+'px'; e.style.top=Math.round(D/2+Math.sin(a)*ring-B/2)+'px'; });
  }
  // degrees round from +x (screen y down): fixed ones as given, the others spread -52°…122°
  function bubbleAngles(){
    const bs=G.el?[...G.el.querySelectorAll('.dg-b')]:[];
    const arc=bs.filter(e=>e.dataset.a==null), n=arc.length;
    return bs.map(e=>{ if(e.dataset.a!=null) return +e.dataset.a; const i=arc.indexOf(e); return n<2?0:-52+174*i/(n-1); });
  }
  // local time and sun at a spot: ' · 14:05 ☀' (☾ at night, ◐ at dusk / dawn)
  function clock(lat,lon){
    try{ const c=DMTime.localTime(G.body,lon), mu=sunAt(lat,lon); if(mu==null) return '';
      return ' · '+String(c.h).padStart(2,'0')+':'+String(c.m).padStart(2,'0')+' '+(mu>0.05?'☀':mu<-0.05?'☾':'◐'); }catch(e){ return ''; }
  }
  function readout(){
    const r=G.el&&G.el.querySelector('.dg-read'); if(!r) return;
    let tx='';
    const m=me();
    if(G.target){ tx='◎ '+fmt(G.target.lat,G.target.lon); try{ if(m) tx+=' · '+_lmDist(m,G.target); }catch(e){} tx+=clock(G.target.lat,G.target.lon); }
    else if(m) tx=(G.body?G.body.name.toUpperCase():'')+clock(m.lat,m.lon);
    else tx=G.body?G.body.name.toUpperCase():'';
    if(r.textContent!==tx) r.textContent=tx;
  }
  let _lastMode=null, _lastLay='';
  function tick(){
    build();
    const m=modeNow(), b=m?bodyFor(m):null;
    if(!m||!b){ if(G.el.style.display!=='none'){ G.el.style.display='none'; } G.mode=m; G.body=null; _lastMode=m; return; }
    if(b!==G.body||m!==G.mode){
      if(b!==G.body){ G.body=b; G.mode=m; loadBody(b); }
      if(m==='space') setCollapsed(false,false);           // a new world close by: the globe comes up by itself
      else { try{ G.pref=JSON.parse(localStorage.getItem('dm_globe_v1')||'null'); }catch(e){} setCollapsed(!!(G.pref&&G.pref.collapsed),false); }
      _sig=''; }
    G.mode=m; _lastMode=m;
    G.el.className='g-'+m+(G.collapsed?' collapsed':'');
    if(G.el.style.display==='none'){ G.el.style.display=''; _lastLay=''; }
    const lay=m+'|'+window.innerWidth+'x'+window.innerHeight;
    if(lay!==_lastLay||(performance.now()%2000)<260){ _lastLay=lay; layout(); }
    sync(); kick();
  }
  setInterval(tick,250);
  window.addEventListener('resize',()=>{ _lastLay=''; setTimeout(tick,80); });

  window.DMGlobe={
    sunAt, dayAt:(lat,lon)=>{ const mu=sunAt(lat,lon); return mu==null?null:dayRamp(mu); },
    near(b){ if(G.spaceNear!==b){ G.spaceNear=b; } },
    sync(){ try{ sync(); }catch(e){} }, expand, collapse(){ setCollapsed(true,true); },
    get target(){ return G.target; }, set target(v){ G.target=v; sync(); },
    _G:G, _unproj:unproj, layout
  };
})();
