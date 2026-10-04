/* ═══════════════════════════════════════════════════════════════════
   ZERO-GRAVITY LENS BUBBLE — flying into a star on the skyboard.
   The skyboard is zero gravity, so this is the black hole lens turned
   inside out: where the galaxy's black holes pull light IN to a dark
   core (_gsLensMat), the bubble pushes the star's light OUT. Within
   reach of a star's surface a soap-bubble window opens around the
   rider like a dilating pupil; the plasma it shoves aside piles up in
   a bright corona ring and swirls around the rim, and through the
   window you see dark space. Riders pass straight through the star
   (stars have no collision) and the bubble fades on the far side.

     lens    back faces of a sphere round the rider, so she and her
             board (nearer than its back wall) stay in front of it.
             Reverse lens: pixels just outside the bubble sample from
             closer in (outward displacement, compressed + swirled into
             the rim); inside it a deep-space window. Shares the black
             hole lens's ndc→uv step (_lensWarpUV).
     bubble  thin-film iridescent shell (fresnel → rainbow bands).
     plasma  the star's interior, seen only while the camera is inside
             it — the star's own boiling plasma (ui/dm-star.js) from within.
   Other players: every rider near a star gets a bubble (worked out
   from the positions multiplayer already sends — nothing extra on the
   bus); riders close together share one bubble.
   TSL node materials: one source for WebGPU and the WebGL2 fallback.
   Mobile: one texture read (three desktop for chromatic fringes), no
   loops or noise textures.
   ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const SB={a:0,pk:0,pkT:0,inStar:0,flame:0,lastH:null,star:null,built:false,failed:false,ghosts:new Map(),R:1.7};
  window.DMStarBubble=SB;
  const NEAR_IN=0.05, NEAR_OUT=0.14;            // activation band, × star radius above the surface
  const PEAK_S=1.8;                             // seconds of flare/flame after crossing the surface
  const GHOST_MAX=6;
  let V1,V2,V3,low=false;

  function lowTier(){ try{ return !!(GFX&&(GFX.preset==='low'||(GFX.isMobile&&GFX.preset!=='high'&&GFX.preset!=='ultra'))); /* a phone set to High/Ultra gets the full shaders */ }catch(e){ return false; } }

  /* ── materials ─────────────────────────────────────────────────── */
  function lensMat(T){
    const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthTest:true,depthWrite:false,side:THREE.BackSide});
    const u={c:T.uniform(new THREE.Vector2()),cw:T.uniform(new THREE.Vector3()),rw:T.uniform(1),a:T.uniform(0),pk:T.uniform(0),aspect:T.uniform(1)};
    const {float,vec2,vec3,vec4,sin,cos,exp,smoothstep,atan,fract,floor,dot,normalize,mix,time}=T;
    // this pixel's ndc, from the same matrices the CPU uses for the bubble centre
    const clip=T.varying(T.cameraProjectionMatrix.mul(T.modelViewMatrix).mul(vec4(T.positionLocal,1.0)));
    const ndc=clip.xy.div(clip.w);
    const p=ndc.mul(vec2(u.aspect,1.0));
    const v=p.sub(u.c), rv=v.length().max(1e-5), dir=v.div(rv);
    // q: this pixel's ray's closest pass to the bubble centre, in bubble
    // radii — exactly 1 on the bubble's silhouette from any angle (a
    // screen circle drifts off the sphere's outline away from centre).
    const D=normalize(T.positionWorld.sub(T.cameraPosition));
    const L=u.cw.sub(T.cameraPosition), tca=dot(L,D);
    const r=dot(L,L).sub(tca.mul(tca)).max(0.0).sqrt().div(u.rw.max(1e-4));
    const Rb=float(1.0), Rl=float(2.6);
    const t=r.sub(Rb).div(Rl.sub(Rb)).clamp(0.0,1.0), it=float(1).sub(t);
    // compression: [0.8, 2.6] radii of the scene squeezed into the rim [1, 2.6]
    const rs=mix(Rb.mul(0.8),Rl,t.pow(0.55)).div(r.max(1e-4));
    // swirl: rotate the sample tangentially, strongest at the rim
    const phi=it.mul(it).mul(sin(time.mul(0.8)).mul(0.4).add(1.2));
    const cs=cos(phi), sn=sin(phi);
    const rd=vec2(dir.x.mul(cs).sub(dir.y.mul(sn)),dir.x.mul(sn).add(dir.y.mul(cs)));
    const W=window._lensWarpUV;
    const at=k=>T.viewportTexture(W(T,ndc,u.c.add(rd.mul(rv.mul(rs).mul(k))).sub(p).mul(u.a),u.aspect));
    let col;
    if(low) col=at(1.0).rgb;
    else{ const ca=it.mul(0.014); col=vec3(at(ca.add(1.0)).r,at(1.0).g,at(float(1.0).sub(ca)).b); }
    // compressed light piles up: brighter toward the rim (bloom stand-in)
    col=col.mul(it.pow(3.0).mul(u.a.mul(0.9)).add(1.0));
    const out=r.sub(Rb).max(0.0);
    const ring=exp(out.div(Rb.mul(0.05)).negate()).mul(smoothstep(Rb.mul(0.985),Rb,r));
    const halo=exp(out.div(Rb.mul(0.35)).negate()).mul(smoothstep(Rb.mul(0.985),Rb,r));
    const ang=atan(dir.y,dir.x);
    const lr=r.max(1e-3).log();
    const st=sin(ang.mul(14.0).sub(lr.mul(9.0)).add(time.mul(2.2)).add(sin(ang.mul(3.0).sub(time.mul(0.5))).mul(3.0))).mul(0.5).add(0.5).max(0.0);
    const streak=st.pow(8.0).mul(it.pow(1.5)).mul(smoothstep(Rb,Rb.mul(1.03),r));
    // flares sweep in on crossing the surface and wrap the boundary
    const fr=Rb.mul(sin(ang.mul(2.0).add(time.mul(3.0))).mul(0.125).add(1.245));
    const fz=r.sub(fr).div(Rb.mul(0.035));
    const fl=exp(fz.mul(fz).negate()).mul(sin(ang.mul(3.0).sub(time.mul(4.0))).mul(0.5).add(0.5).max(0.0).pow(4.0));
    const fire=vec3(1.0,0.55,0.16), gold=vec3(1.0,0.8,0.42);
    col=col.add(fire.mul(ring.mul(1.5).add(halo.mul(0.2)).add(streak.mul(0.6))).mul(u.a))
           .add(gold.mul(fl.mul(u.pk).mul(1.8)));
    // the window: dark space, a little blue toward the middle, and stars
    const cell=floor(D.mul(420.0));
    const h=fract(sin(dot(cell,vec3(12.9898,78.233,37.719))).mul(43758.5453));
    const star=smoothstep(0.9955,1.0,h).mul(fract(h.mul(97.0)).mul(0.8).add(0.4));
    const q=r.div(Rb);
    const iris=cos(q.mul(14.0).add(vec3(0.0,2.07,4.14)).add(time.mul(0.6))).mul(0.5).add(0.5).mul(smoothstep(0.8,1.0,q)).mul(0.1);
    const space=vec3(0.004,0.008,0.022).add(vec3(0.01,0.025,0.07).mul(float(1).sub(q))).add(vec3(star)).add(iris);
    const inside=float(1).sub(smoothstep(Rb.mul(0.985),Rb,r));
    m.colorNode=mix(col,space,inside);
    m.opacityNode=u.a.mul(float(1).sub(smoothstep(Rl.mul(0.9),Rl,r))).clamp(0.0,1.0);
    m.toneMapped=false;
    m.userData.u=u;
    return m;
  }
  function bubbleMat(T){
    const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.FrontSide});
    const u={a:T.uniform(0),fire:T.uniform(0)};
    const {float,vec3,sin,cos,normalize,time,positionLocal}=T;
    const pl=positionLocal;
    // gentle soap-film wobble
    m.positionNode=pl.mul(sin(pl.x.mul(5.0).add(time.mul(2.0))).mul(sin(pl.y.mul(4.0).sub(time.mul(1.7)))).mul(0.025).add(1.0));
    const V=normalize(T.cameraPosition.sub(T.positionWorld));
    const fres=float(1).sub(T.normalWorld.dot(V).abs()).clamp(0.0,1.0);
    // film thickness drifts across the surface → moving rainbow bands
    const th=sin(pl.y.mul(6.0).add(time.mul(0.9))).mul(0.25).add(sin(pl.x.mul(9.0).sub(time.mul(1.3))).mul(0.15)).add(0.35);
    const film=cos(th.mul(2.2).add(fres.mul(1.2)).mul(6.2832).add(vec3(0.0,2.07,4.14))).mul(0.5).add(0.5);
    const glow=fres.pow(2.2).mul(1.6).add(0.12);
    const a=fres.pow(3.0).mul(0.75).add(0.06).mul(u.a);
    m.colorNode=film.mul(glow).add(vec3(1.0,0.5,0.15).mul(fres.pow(1.5).mul(u.fire))).mul(a);
    m.toneMapped=false;
    m.userData.u=u;
    return m;
  }
  function build(){
    const T=THREE.TSL;
    if(!T||!T.viewportTexture||!T.dFdx||!window._lensWarpUV||!THREE.MeshBasicNodeMaterial){ SB.failed=true; return; }
    low=lowTier();
    try{
      SB.lens=new THREE.Mesh(new THREE.SphereGeometry(1,32,16),lensMat(T));
      SB.lens.renderOrder=50; SB.lens.frustumCulled=false; SB.lens.visible=false; SB.lens.name='JOTS_StarBubbleLens';
      SB._bMat=bubbleMat(T);
      SB._bGeo=new THREE.SphereGeometry(1,low?32:48,low?20:32);
      SB.bubble=new THREE.Mesh(SB._bGeo,SB._bMat);
      SB.bubble.renderOrder=51; SB.bubble.frustumCulled=false; SB.bubble.visible=false; SB.bubble.name='JOTS_StarBubble';
      // inside the star: its own plasma (ui/dm-star.js), seen from within
      SB.plasma=new THREE.Mesh(new THREE.SphereGeometry(1,low?32:48,low?16:24));
      SB.plasma.visible=false; SB.plasma.name='JOTS_StarInterior';
      SB.plasma.renderOrder=3;   // after the opaque surface, so depth rejects it everywhere but the bubble's hole (no hidden full-screen plasma pass)
      SB.T=T; SB.built=true;
    }catch(e){ console.warn('[starbubble] build failed:',e); SB.failed=true; }
  }
  function attach(scene){
    for(const o of [SB.lens,SB.bubble,SB.plasma]) if(o.parent!==scene) scene.add(o);
  }

  // nearest star and its render radius
  function nearestStar(pos){
    let best=null,bh=Infinity;
    const list=(typeof celestialBodies!=='undefined'&&celestialBodies)||[];
    for(const b of list){
      if(!b||b.type!=='Star'||!b.mesh||!b.renderMesh) continue;
      const g=b.renderMesh.geometry, R=((g&&g.parameters&&g.parameters.radius)||160)*b.renderMesh.scale.x;
      b.mesh.getWorldPosition(V3);
      const h=pos.distanceTo(V3)-R;
      if(h<bh){ bh=h; best={b,R,c:V3.clone(),h}; }
    }
    return best;
  }
  const eob=x=>{ const c1=1.4,c3=c1+1; return 1+c3*Math.pow(x-1,3)+c1*Math.pow(x-1,2); };  // ease-out-back: the pupil overshoots open
  const appr=(v,t,up,dn,dt)=>v<t?Math.min(t,v+up*dt):Math.max(t,v-dn*dt);

  // the star's own body and glow shells: the shells fade as the camera
  // dives in (stacked, they'd wash the plasma white-orange) and, once
  // inside, the body is swapped for the interior plasma
  function shells(st,k,inside){
    if(inside&&!SB._hid){ SB._hid=[]; st.b.mesh.traverse(o=>{ if(o!==st.b.mesh&&!o.isLight&&o.visible&&o.parent===st.b.mesh){ o.visible=false; SB._hid.push(o); } }); }
    else if(!inside&&SB._hid){ for(const o of SB._hid) o.visible=true; SB._hid=null; }
    st.b.mesh.traverse(o=>{
      const m=o.material;
      if(!m||!m.transparent||o===st.b.renderMesh) return;
      if(m.userData.sbOp===undefined) m.userData.sbOp=m.opacity;
      m.opacity=m.userData.sbOp*k;
    });
  }

  function ghostBubble(i){
    let g=SB.ghosts.get(i);
    if(!g){
      const mat=bubbleMat(SB.T);
      g=new THREE.Mesh(SB._bGeo,mat); g.renderOrder=51; g.frustumCulled=false; g.name='JOTS_StarBubbleGhost';
      g.userData.a=0; SB.ghosts.set(i,g);
    }
    return g;
  }

  SB.frame=function(cam,scene,dt){
    if(SB.failed||typeof STATE==='undefined'||STATE.screen!=='flight'||!scene||!cam) return;
    const board=(typeof boardFlight!=='undefined')?boardFlight:null;
    if(!board) return;
    dt=dt>0?Math.min(dt,0.25):1/60;
    if(!V1){ V1=new THREE.Vector3(); V2=new THREE.Vector3(); V3=new THREE.Vector3(); }
    const pos=board.position;
    const st=nearestStar(pos);
    const ghosts=(typeof window.jotsGhostBoards==='function')?window.jotsGhostBoards():[];
    const anyGhostNear=st&&ghosts.some(b=>b.position.distanceTo(st.c)-st.R<st.R*NEAR_OUT);
    if(!st||(st.h>st.R*NEAR_OUT*1.5&&SB.a<=0&&!anyGhostNear&&!SB._shellDim)){ if(SB.built) hideAll(); return; }
    if(!SB.built){ build(); if(!SB.built) return; }
    attach(scene);
    SB.star=st.b.name;
    // crossing the surface either way sets off the flare/flame peak
    if(SB.lastH!==null&&(SB.lastH>0)!==(st.h>0)) SB.pkT=PEAK_S;
    SB.lastH=st.h;
    SB.pkT=Math.max(0,SB.pkT-dt);
    const tgt=1-smooth(st.R*NEAR_IN,st.R*NEAR_OUT,st.h);
    SB.a=appr(SB.a,tgt,1.1,0.7,dt);
    const x=SB.pkT/PEAK_S; SB.pk=x>0?Math.sin(Math.PI*(1-x)):0;
    SB.flame=SB.pk;
    // radius: snug round her board, grown to take in riders flying with her
    let R=1.2;
    for(const gb of ghosts){ const d=gb.position.distanceTo(pos); if(d<R*2.2) R=Math.max(R,d+1.2); }
    // never so big the follow camera ends up inside it
    const camD=cam.position.distanceTo(pos);
    R=Math.min(R,9,Math.max(1.2,camD*0.75));
    // and narrow enough to sit inside a portrait screen
    const tMin=Math.tan(THREE.MathUtils.degToRad(cam.fov||60)*0.5)*Math.min(1,cam.aspect||1);
    R=Math.min(R,Math.max(0.9,camD*Math.sin(Math.atan(0.92*tMin))));
    const open=SB.a>0?eob(Math.min(1,SB.a)):0;
    const Re=R*Math.max(0,open);
    SB.R=Re;
    // star interior: camera inside the photosphere
    const camH=cam.position.distanceTo(st.c)-st.R;
    SB.inStar=camH<0?1:0;
    const dim=1-smooth(-st.R*0.02,st.R*0.04,-camH);   // 1 outside, 0 once a little way in
    shells(st,dim,camH<0); SB._shellDim=dim<1||camH<0;
    // always drawn near a star (tiny, hidden in its core when we're outside)
    // so its shader is compiled before the moment we dive in
    const inMat=window.DMStar&&DMStar.interiorMaterial(st.b.mesh.userData.dmStar);
    if(inMat&&SB.plasma.material!==inMat) SB.plasma.material=inMat;
    SB.plasma.visible=!!inMat; SB.plasma.position.copy(st.c); SB.plasma.scale.setScalar(camH<0||SB.a>0.002?st.R*0.985:st.R*0.05);   // full size too while the bubble parts the surface
    const on=SB.a>0.002&&Re>0.01;
    if(window.DMStar) DMStar.setBubble(pos,on?Re:0);
    const camIn=camD<Re*1.05;
    SB.bubble.visible=on;
    if(on){
      SB.bubble.position.copy(pos); SB.bubble.scale.setScalar(Re);
      SB.bubble.material.side=camIn?THREE.BackSide:THREE.FrontSide;
      const u=SB._bMat.userData.u; u.a.value=SB.a; u.fire.value=0.35*SB.a+0.6*SB.pk;
    }
    // the lens needs the bubble in front of the camera and the camera outside it
    V1.copy(pos).project(cam);
    const lensOn=on&&!camIn&&V1.z<1&&V1.z>-1;
    SB.lens.visible=lensOn;
    if(lensOn){
      const asp=(cam.aspect||1);
      const u=SB.lens.material.userData.u;
      u.c.value.set(V1.x*asp,V1.y); u.aspect.value=asp;
      u.cw.value.copy(pos); u.rw.value=Re;
      u.a.value=SB.a; u.pk.value=SB.pk;
      // just big enough to hold the lens's 2.6-radius reach: the lens samples
      // the frame (a screen copy) and every pixel it covers runs the shader, so
      // keep it off the rest of the screen unless the camera is that close
      const ls=Re*2.75; SB.lens.position.copy(pos); SB.lens.scale.setScalar(ls<camD*0.9?ls:Math.max(Re*4,camD*1.2));
    }
    // other riders near a star but not in our bubble get their own
    let n=0;
    for(const gb of ghosts){
      if(n>=GHOST_MAX) break;
      const gh=gb.position.distanceTo(st.c)-st.R;
      const shared=on&&gb.position.distanceTo(pos)<Re*0.95;
      const g=ghostBubble(n++);
      const t=(shared?0:1-smooth(st.R*NEAR_IN,st.R*NEAR_OUT,gh));
      g.userData.a=appr(g.userData.a,t,1.1,0.7,dt);
      g.visible=g.userData.a>0.002;
      if(g.parent!==scene) scene.add(g);
      if(g.visible){
        g.position.copy(gb.position); g.scale.setScalar(1.2*eob(Math.min(1,g.userData.a)));
        const u=g.material.userData.u; u.a.value=g.userData.a; u.fire.value=0.9*g.userData.a;
      }
    }
    for(let i=n;i<SB.ghosts.size;i++){ const g=SB.ghosts.get(i); if(g) g.visible=false; }
  };
  function smooth(e0,e1,x){ const t=Math.max(0,Math.min(1,(x-e0)/(e1-e0))); return t*t*(3-2*t); }
  function hideAll(){
    if(window.DMStar) DMStar.setBubble(null,0);
    SB.a=0; SB.pk=0; SB.flame=0; SB.pkT=0; SB.lastH=null; SB.inStar=0;
    for(const o of [SB.lens,SB.bubble,SB.plasma]) if(o) o.visible=false;
    if(SB._hid){ for(const o of SB._hid) o.visible=true; SB._hid=null; }
    for(const g of SB.ghosts.values()) g.visible=false;
  }
})();
