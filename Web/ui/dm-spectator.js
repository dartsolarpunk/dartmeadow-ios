/* DART Meadow — Spectator free-fly camera + HUD hide toggle.
 * Two see-through icon buttons ride right after the screenshot camera in every
 * world view (ground, sky, space): SPECTATOR (a drone camera detached from her)
 * and HUD (hide every panel for a clean capture; only these three buttons stay,
 * faint, so you can bring it back). The game keeps running underneath.
 *
 * How the camera works: each render loop calls DMSpec.pre(cam) after the game
 * has placed its own camera, and DMSpec.post(cam) after drawing. pre() saves the
 * game's pose and swaps in the drone's; post() puts the game's pose straight
 * back, so the chase / orbit / first-person cameras never notice and leaving
 * spectator returns the view exactly as it was. Screenshots grab the frame the
 * instant it's drawn, so they show the drone's view.
 */
(function(){
  'use strict';
  const SVG_SPEC='<svg viewBox="0 0 28 24" width="22" height="19" aria-hidden="true">'+
    '<path d="M3.2 12C6 7.4 9.8 5.2 14 5.2s8 2.2 10.8 6.8C22 16.6 18.2 18.8 14 18.8S6 16.6 3.2 12z" fill="currentColor" fill-opacity=".2" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'+
    '<circle cx="14" cy="12" r="4.2" fill="currentColor" fill-opacity=".32" stroke="currentColor" stroke-width="1.4"/>'+
    '<circle cx="14" cy="12" r="1.9" fill="currentColor" fill-opacity=".7"/><circle cx="12.6" cy="10.6" r=".95" fill="#fff" fill-opacity=".85"/>'+
    '<path d="M2 3.4h4.2M2 3.4v3.4M26 3.4h-4.2M26 3.4v3.4M2 20.6h4.2M2 20.6v-3.4M26 20.6h-4.2M26 20.6v-3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-opacity=".8"/></svg>';
  const SVG_HUD='<svg viewBox="0 0 28 24" width="22" height="19" aria-hidden="true">'+
    '<path d="M14 3.4 25 8.6 14 13.8 3 8.6z" fill="currentColor" fill-opacity=".26" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'+
    '<path d="M5.6 12.6 3 13.8 14 19 25 13.8l-2.6-1.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-opacity=".75"/>'+
    '<path class="hud-slash" d="M4.4 21.6 23.6 2.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  const S={ on:false, mode:null, cam:null, pos:null, yaw:0, pitch:0, spd:1, keys:{}, mv:{x:0,y:0}, vert:0, look:{x:0,y:0},
    saved:null, last:0, inFrame:false, hud:true };
  const T=()=>window.THREE;
  const modeNow=()=>{
    try{ if(typeof surfaceActive!=='undefined'&&surfaceActive) return 'surf'; }catch(e){}
    try{ if(typeof atmoActive!=='undefined'&&atmoActive) return 'atmo'; }catch(e){}
    try{ if(typeof STATE!=='undefined'&&STATE.screen==='flight') return 'space'; }catch(e){}
    return null;
  };
  const camFor=m=>{ try{ return m==='surf'?surfCamera:m==='atmo'?atmoCamera:m==='space'?flightCamera:null; }catch(e){ return null; } };
  const overlayFor=m=>m==='surf'?document.getElementById('surface-overlay'):m==='atmo'?document.getElementById('atmo-overlay'):document.getElementById('screen-flight');
  const canvasFor=m=>{ try{ return m==='surf'?surfRenderer.domElement:m==='atmo'?atmoRenderer.domElement:flightRenderer.domElement; }catch(e){ return null; } };
  const SPEED_STEPS=[0.125,0.25,0.5,1,2,4,8,16,32,64];
  let spdIdx=3;
  // base speed per world, units/second at 1×: walking pace on the ground, a fast
  // glide in the sky; in space it scales with how far the nearest world is, so
  // you can creep up to a planet and still cross a solar system.
  function baseSpeed(){
    if(S.mode==='surf') return 12;
    if(S.mode==='atmo') return 160;
    let d=60;
    try{
      const p=S.pos, v=new (T().Vector3)();
      for(const b of celestialBodies){ if(!b||!b.mesh) continue; b.mesh.getWorldPosition(v);
        const r=b.collisionRadius||((b.mesh.geometry&&b.mesh.geometry.boundingSphere)?b.mesh.geometry.boundingSphere.radius*b.mesh.scale.x:2);
        const s=Math.max(0,p.distanceTo(v)-r); if(s<d) d=s; }
    }catch(e){}
    return Math.max(0.4,Math.min(4000,d*0.6));
  }
  function groundAt(x,z){
    try{ if(S.mode==='surf'&&typeof _surfHeight==='function'){ const g=_surfHeight(x,z); return isFinite(g)?g:null; } }catch(e){}
    try{ if(S.mode==='atmo'&&typeof _atmoHeight==='function'){ const g=_atmoHeight(x,z); return isFinite(g)?Math.max(0,g):null; } }catch(e){}
    return null;
  }

  // ── per-frame hooks, called from the three render loops ──────────────────
  function pre(cam){
    if(!S.on||!cam) return;
    const m=modeNow();
    if(m!==S.mode||cam!==S.cam){ if(m!==S.mode) setTimeout(()=>exit(true),0); return; }
    S.saved=S.saved||{p:new (T().Vector3)(),q:new (T().Quaternion)()};
    S.saved.p.copy(cam.position); S.saved.q.copy(cam.quaternion);
    const now=performance.now(), dt=Math.min(0.1,Math.max(0,(now-(S.last||now))/1000)); S.last=now;
    step(dt);
    cam.position.copy(S.pos);
    cam.quaternion.setFromEuler(new (T().Euler)(S.pitch,S.yaw,0,'YXZ'));
    cam.updateMatrixWorld(true);
    S.inFrame=true;
  }
  function post(cam){
    if(!S.inFrame||!cam||!S.saved) return;
    S.inFrame=false;
    cam.position.copy(S.saved.p); cam.quaternion.copy(S.saved.q); cam.updateMatrixWorld(true);
  }
  function step(dt){
    const K=S.keys;
    // look: right stick / drag (accumulated deltas) + arrow keys
    const lk=1.6*dt;
    if(K.ArrowLeft) S.yaw+=lk; if(K.ArrowRight) S.yaw-=lk;
    if(K.ArrowUp) S.pitch+=lk; if(K.ArrowDown) S.pitch-=lk;
    S.yaw-=S.look.x*2.4*dt; S.pitch-=S.look.y*2.0*dt;
    S.pitch=Math.max(-1.55,Math.min(1.55,S.pitch));
    // move: WASD / left stick on the view plane; Q/E, Space/Shift or the ▲▼ pads up/down
    let f=(K.KeyW?1:0)-(K.KeyS?1:0)-S.mv.y, r=(K.KeyD?1:0)-(K.KeyA?1:0)+S.mv.x;
    let u=((K.KeyE||K.Space)?1:0)-((K.KeyQ||K.ShiftLeft||K.ShiftRight)?1:0)+S.vert;
    const mag=Math.hypot(f,r,u); if(mag<0.02) return;
    if(mag>1){ f/=mag; r/=mag; u/=mag; }
    const v=baseSpeed()*SPEED_STEPS[spdIdx]*dt;
    const cy=Math.cos(S.yaw), sy=Math.sin(S.yaw), cp=Math.cos(S.pitch), sp=Math.sin(S.pitch);
    // forward follows where you look (fly-through), right stays level
    S.pos.x+=(-sy*cp*f+cy*r)*v; S.pos.y+=(sp*f+u)*v; S.pos.z+=(-cy*cp*f-sy*r)*v;
    const g=groundAt(S.pos.x,S.pos.z); if(g!=null&&S.pos.y<g+0.6) S.pos.y=g+0.6;
  }

  // ── enter / exit ─────────────────────────────────────────────────────────
  function enter(){
    const m=modeNow(), cam=camFor(m); if(!m||!cam||!T()) return;
    S.mode=m; S.cam=cam; S.on=true; S.last=0; S.saved=null;
    S.pos=cam.position.clone();
    const e=new (T().Euler)().setFromQuaternion(cam.quaternion,'YXZ'); S.yaw=e.y; S.pitch=e.x;
    S.mv.x=S.mv.y=0; S.vert=0; S.look.x=S.look.y=0; S.keys={};
    spdIdx=3;
    mountLayer(); document.body.classList.add('spec-on'); sync();
    try{ toast('🎥 Spectator — fly anywhere · tap the eye again to return',2200); }catch(e){}
  }
  function exit(silent){
    if(!S.on) return;
    S.on=false; S.inFrame=false; S.keys={}; S.mv.x=S.mv.y=0; S.vert=0; S.look.x=S.look.y=0;
    if(S.saved&&S.cam){ S.cam.position.copy(S.saved.p); S.cam.quaternion.copy(S.saved.q); }
    document.body.classList.remove('spec-on'); unmountLayer(); sync();
    if(!silent) try{ toast('🎥 Back with her',1200); }catch(e){}
  }
  function toggleSpectator(){ S.on?exit():enter(); }
  function setHud(show){
    S.hud=!!show;
    document.body.classList.toggle('hud-off',!S.hud);
    // keep the live 3-D view visible while everything else hides
    ['surf','atmo','space'].forEach(m=>{ const c=canvasFor(m); if(c) c.classList.add('dm-keep'); });
    sync();
  }
  function toggleHud(){ setHud(!S.hud); }

  // ── buttons: camera · spectator · HUD, side by side in every view ────────
  function mkBtn(cls,svg,title,fn){ const b=document.createElement('button'); b.type='button'; b.className='shot-btn '+cls; b.innerHTML=svg; b.title=title; b.setAttribute('aria-label',title);
    b.addEventListener('click',e=>{ e.stopPropagation(); fn(); }); return b; }
  function wire(){
    document.querySelectorAll('button.shot-btn:not(.spec-btn):not(.hudt-btn)').forEach(shot=>{
      let g=shot.parentNode;
      if(!g.classList||!g.classList.contains('shot-grp')){
        g=document.createElement('span'); g.className='shot-grp'; if(shot.id) g.id=shot.id+'-grp';
        shot.parentNode.insertBefore(g,shot); g.appendChild(shot);
      }
      if(!g.querySelector('.spec-btn')) g.appendChild(mkBtn('spec-btn',SVG_SPEC,'Spectator — free-fly camera to frame shots (C)',toggleSpectator));
      if(!g.querySelector('.hudt-btn')) g.appendChild(mkBtn('hudt-btn',SVG_HUD,'Hide / show the HUD for a clean view (H)',toggleHud));
    });
    sync();
  }
  function sync(){
    document.querySelectorAll('.spec-btn').forEach(b=>{ b.classList.toggle('on',S.on); b.setAttribute('aria-pressed',S.on?'true':'false'); });
    document.querySelectorAll('.hudt-btn').forEach(b=>{ b.classList.toggle('on',!S.hud); b.setAttribute('aria-pressed',!S.hud?'true':'false'); b.title=S.hud?'Hide the HUD for a clean view (H)':'Show the HUD again (H)'; });
    const sp=document.getElementById('spec-spd'); if(sp) sp.textContent=fmtSpd();
  }
  const fmtSpd=()=>{ const x=SPEED_STEPS[spdIdx]; return (x<1?('1/'+Math.round(1/x)):x)+'×'; };
  function speed(d){ spdIdx=Math.max(0,Math.min(SPEED_STEPS.length-1,spdIdx+d)); sync(); }

  // ── the drone's touch / mouse layer and its small control bar ─────────────
  let layer=null, bar=null;
  function mountLayer(){
    unmountLayer();
    const ov=overlayFor(S.mode), cv=canvasFor(S.mode); if(!ov) return;
    layer=document.createElement('section'); layer.id='spec-layer';   // not a div: the bars' CSS counts divs (…>div:nth-of-type(1))
    layer.innerHTML='<span class="spec-stick" id="spec-stick-l"><i></i></span><span class="spec-stick" id="spec-stick-r"><i></i></span>';
    // right after the 3-D canvas: every HUD control drawn later stays on top and usable
    if(cv&&cv.parentNode===ov) ov.insertBefore(layer,cv.nextSibling); else ov.insertBefore(layer,ov.firstChild);
    bar=document.createElement('nav'); bar.id='spec-bar';
    bar.innerHTML='<span class="spec-tag">🎥 SPECTATOR</span>'+
      '<button type="button" data-a="dn" title="Down (Q / Shift)">▼</button><button type="button" data-a="up" title="Up (E / Space)">▲</button>'+
      '<button type="button" data-a="slow" title="Slower (− or wheel)">−</button><span id="spec-spd" class="spec-spd"></span><button type="button" data-a="fast" title="Faster (+ or wheel)">+</button>'+
      '<button type="button" data-a="exit" class="spec-exit" title="Back to her (C / Esc)">✕</button>';
    ov.appendChild(bar);
    bar.addEventListener('pointerdown',e=>{ const b=e.target.closest('button'); if(!b) return; e.preventDefault(); e.stopPropagation();
      const a=b.dataset.a;
      if(a==='up'||a==='dn'){ S.vert=a==='up'?1:-1; b.classList.add('held'); try{ b.setPointerCapture(e.pointerId); }catch(er){}
        const rel=()=>{ S.vert=0; b.classList.remove('held'); b.removeEventListener('pointerup',rel); b.removeEventListener('pointercancel',rel); };
        b.addEventListener('pointerup',rel); b.addEventListener('pointercancel',rel); }
      else if(a==='slow') speed(-1); else if(a==='fast') speed(1); else if(a==='exit') exit();
    });
    bar.addEventListener('click',e=>e.stopPropagation());
    const ptrs=new Map(), sL=layer.querySelector('#spec-stick-l'), sR=layer.querySelector('#spec-stick-r');
    const R=48;
    const showStick=(el,x,y)=>{ el.style.display='block'; el.style.left=(x-R)+'px'; el.style.top=(y-R)+'px'; el.firstChild.style.transform='translate(0,0)'; };
    layer.addEventListener('pointerdown',e=>{
      e.preventDefault(); e.stopPropagation();
      const rc=layer.getBoundingClientRect(), x=e.clientX-rc.left, y=e.clientY-rc.top;
      const touch=e.pointerType!=='mouse';
      const kind=touch?(x<rc.width/2?'move':'look'):'drag';
      ptrs.set(e.pointerId,{kind,x0:e.clientX,y0:e.clientY,x:e.clientX,y:e.clientY,ox:x,oy:y});
      try{ layer.setPointerCapture(e.pointerId); }catch(er){}
      if(kind==='move') showStick(sL,x,y); else if(kind==='look') showStick(sR,x,y);
    });
    layer.addEventListener('pointermove',e=>{
      const p=ptrs.get(e.pointerId); if(!p) return; e.preventDefault(); e.stopPropagation();
      if(p.kind==='drag'){ // mouse: drag to look, 1:1-ish
        S.yaw-=(e.clientX-p.x)*0.0042; S.pitch=Math.max(-1.55,Math.min(1.55,S.pitch-(e.clientY-p.y)*0.0042));
        p.x=e.clientX; p.y=e.clientY; return; }
      let dx=e.clientX-p.x0, dy=e.clientY-p.y0; const d=Math.hypot(dx,dy); if(d>R){ dx*=R/d; dy*=R/d; }
      const el=p.kind==='move'?sL:sR; el.firstChild.style.transform='translate('+dx+'px,'+dy+'px)';
      const nx=dx/R, ny=dy/R;
      if(p.kind==='move'){ S.mv.x=nx; S.mv.y=ny; } else { S.look.x=nx*Math.abs(nx); S.look.y=ny*Math.abs(ny); }
    });
    const up=e=>{ const p=ptrs.get(e.pointerId); if(!p) return; ptrs.delete(e.pointerId);
      if(p.kind==='move'){ S.mv.x=S.mv.y=0; sL.style.display='none'; } else if(p.kind==='look'){ S.look.x=S.look.y=0; sR.style.display='none'; } };
    layer.addEventListener('pointerup',up); layer.addEventListener('pointercancel',up);
    layer.addEventListener('wheel',e=>{ e.preventDefault(); e.stopPropagation(); speed(e.deltaY<0?1:-1); },{passive:false});
    layer.addEventListener('contextmenu',e=>e.preventDefault());
    sync();
  }
  function unmountLayer(){ if(layer){ layer.remove(); layer=null; } if(bar){ bar.remove(); bar=null; } }

  // ── keyboard: the drone takes the movement keys while it's flying ────────
  const typing=e=>{ const t=e.target; return !!(t&&(/INPUT|TEXTAREA|SELECT/.test(t.tagName)||t.isContentEditable)); };
  const FLY=new Set(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','Space','ShiftLeft','ShiftRight','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
  window.addEventListener('keydown',e=>{
    if(typing(e)||e.ctrlKey||e.metaKey||e.altKey) return;
    if(e.code==='KeyC'&&!e.repeat&&modeNow()){ e.preventDefault(); e.stopImmediatePropagation(); toggleSpectator(); return; }
    if(e.code==='KeyH'&&!e.repeat&&modeNow()){ e.preventDefault(); e.stopImmediatePropagation(); toggleHud(); return; }
    if(!S.on) return;
    if(e.code==='Escape'){ e.preventDefault(); e.stopImmediatePropagation(); exit(); return; }
    if(e.key==='+'||e.key==='='||e.code==='NumpadAdd'){ speed(1); e.stopImmediatePropagation(); return; }
    if(e.key==='-'||e.key==='_'||e.code==='NumpadSubtract'){ speed(-1); e.stopImmediatePropagation(); return; }
    if(FLY.has(e.code)){ S.keys[e.code]=true; e.preventDefault(); e.stopImmediatePropagation(); }
  },true);
  window.addEventListener('keyup',e=>{ if(S.keys[e.code]){ S.keys[e.code]=false; } },true);   // keyup still reaches the game: nothing gets stuck
  window.addEventListener('blur',()=>{ S.keys={}; });

  // leave cleanly when the world changes (landing, lift-off, back to the menu)
  setInterval(()=>{
    wire();
    const m=modeNow();
    if(S.on&&m!==S.mode) exit(true);
    if(!S.hud&&!m) setHud(true);
  },700);

  window.DMSpec={ pre, post, toggleSpectator, toggleHud, setHud, enter, exit, wire, get on(){ return S.on; }, get hud(){ return S.hud; },
    // where the drone is (the ground streams round it while it flies)
    focusXZ(){ return (S.on&&S.mode==='surf'&&S.pos)?S.pos:null; }, _S:S };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',wire); else wire();
})();
