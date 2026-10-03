/* ═══════════════════════════════════════════════════════════════════
   STARS — every star you can fly to, built by the world engine from its
   data (radius, surface temperature):
     surface      boiling plasma: two layers of flow-warped waves (a
                  curl-like fluid drift, like the planets' cloud decks)
                  over moving granulation, coloured from the star's
                  blackbody ramp, limb-darkened. Far away it drops to a
                  plain glowing sphere (one cheap material).
     corona       a shell round the star, ray-marched in a few steps
                  through a falling-off, streamer-modulated glow.
     prominences  loops of glowing particles riding magnetic arcs off the
                  surface; now and then one erupts as a flare. Only near.
   No fluid sim, no marching cubes: all of it is a handful of sines per
   pixel and a few hundred points, so it holds up on a phone.
   The zero-gravity bubble (ui/dm-starbubble.js) compresses this same
   surface/corona/prominence light round its rim, and inside the star it
   shows interiorMaterial() — the same plasma, seen from within.
   TSL node materials: one source for WebGPU and the WebGL2 fallback.
   ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const live=new Set();
  const lowTier=()=>{ try{ return !!(GFX&&(GFX.preset==='low'||GFX.isMobile)); }catch(e){ return false; } };

  // blackbody colour (sRGB 0..255) for a temperature in kelvin
  function kelvin(K){
    const t=Math.max(10,Math.min(400,K/100)); let r,g,b;
    if(t<=66){ r=255; g=99.4708025861*Math.log(t)-161.1195681661; b=t<=19?0:138.5177312231*Math.log(t-10)-305.0447927307; }
    else { r=329.698727446*Math.pow(t-60,-0.1332047592); g=288.1221695283*Math.pow(t-60,-0.0755148492); b=255; }
    const c=v=>Math.max(0,Math.min(255,v))/255;
    return new THREE.Color().setRGB(c(r),c(g),c(b),THREE.SRGBColorSpace);
  }
  // spectral class / catalogue label → surface temperature
  function tempFor(type){
    const s=String(type||'G');
    if(/O\/B|O\b|blue giant/i.test(s)) return 22000;
    if(/^B|blue/i.test(s)) return 15000;
    if(/^A|white$/i.test(s)&&!/yellow/i.test(s)) return 9000;
    if(/^F\/G|yellow-white/i.test(s)) return 6200;
    if(/^F/i.test(s)) return 6800;
    if(/red giant/i.test(s)) return 3600;
    if(/^K|orange/i.test(s)) return 4500;
    if(/^M|red/i.test(s)) return 3200;
    return 5600;
  }
  // deep → mid → hot → core, from the blackbody at falling temperatures
  // (the cooler, redder plasma sinking between the bright cells)
  function palette(K){
    const deep=kelvin(K*0.34).multiplyScalar(0.4), mid=kelvin(K*0.5), hot=kelvin(K*0.68), core=kelvin(K*0.95).lerp(new THREE.Color(1,1,1),0.2);
    return {deep,mid,hot,core};
  }

  /* the plasma: one function for the surface and the inside view */
  function plasma(T,U,d,detail){
    const {sin,mix,smoothstep,time}=T;
    const t=time.mul(U.speed);
    const p=d.mul(3.0).add(U.seed);
    // flow: the field advected through two rotated sine warps — reads as
    // slow fluid convection rather than a scrolling texture
    const q=p.add(sin(p.yzx.mul(1.7).add(t.mul(0.25))).mul(0.55));
    const q2=q.add(sin(q.zxy.mul(3.1).sub(t.mul(0.4))).mul(0.3));
    const big=sin(q2.x.mul(2.1).add(t.mul(0.3))).mul(sin(q2.y.mul(2.3).sub(t.mul(0.2)))).mul(sin(q2.z.mul(1.9).add(t.mul(0.25))));
    let g=big.mul(0.4).add(0.5);
    if(detail){
      // granulation: bright convection cells with darker lanes between,
      // two scales, the small one boiling faster and riding the big one
      const c=q2.mul(5.0);
      const g1=sin(c.x.add(t.mul(0.9))).add(sin(c.y.mul(1.1).sub(t.mul(0.8)))).add(sin(c.z.mul(0.9).add(t.mul(0.7)))).div(3.0);
      const c2=c.yzx.mul(2.05).add(g1.mul(1.5));
      const g2=sin(c2.x.sub(t.mul(1.6))).add(sin(c2.y.mul(1.13).add(t.mul(1.3)))).add(sin(c2.z.mul(0.87).sub(t.mul(1.4)))).div(3.0);
      const gr=smoothstep(-0.35,0.75,g1.mul(0.6).add(g2.mul(0.4)));
      g=g.mul(0.6).add(gr.mul(0.55)).sub(0.05);
      // fine boiling, faded in only when skimming the surface
      const c3=c2.zxy.mul(2.3).add(g2.mul(1.2));
      const g3=sin(c3.x.add(t.mul(2.2))).add(sin(c3.y.mul(1.09).sub(t.mul(1.9)))).add(sin(c3.z.mul(0.95).add(t.mul(2.0)))).div(3.0);
      g=g.add(smoothstep(-0.3,0.8,g3).sub(0.5).mul(U.fine.mul(0.3)));
    }
    g=g.clamp(0.0,1.0);
    let col=mix(U.deep,U.mid,smoothstep(0.12,0.5,g));
    col=mix(col,U.hot,smoothstep(0.5,0.78,g));
    col=mix(col,U.core,smoothstep(0.82,1.0,g));
    return col;
  }
  function uniforms(T,K,seed){
    const P=palette(K);
    return {deep:T.uniform(P.deep),mid:T.uniform(P.mid),hot:T.uniform(P.hot),core:T.uniform(P.core),
      seed:T.uniform(new THREE.Vector3(seed*1.7%9,seed*2.3%9,seed*3.1%9)),speed:T.uniform(1),fine:T.uniform(0)};
  }
  // the zero-g bubble (ui/dm-starbubble.js) parts the plasma round it
  let BU=null;
  function bubbleU(T){ return BU||(BU={c:T.uniform(new THREE.Vector3(0,0,0)),r:T.uniform(0)}); }
  function surfaceMat(T,U,near){
    const m=new THREE.MeshBasicNodeMaterial();
    const B=bubbleU(T);
    // cut along the line of sight: any surface between the camera and the
    // bubble, within its outline, is pushed aside (a rider just under the
    // photosphere is still seen in her window)
    const toP=T.positionWorld.sub(T.cameraPosition), D=T.normalize(toP), L=B.c.sub(T.cameraPosition);
    const tca=T.dot(L,D), d2=T.dot(L,L).sub(tca.mul(tca));
    const hole=d2.lessThan(B.r.mul(B.r)).and(toP.length().lessThan(tca.add(B.r)));
    m.opacityNode=hole.select(0.0,1.0);
    m.alphaTest=0.5;
    const d=T.normalize(T.positionLocal);
    const V=T.normalize(T.cameraPosition.sub(T.positionWorld));
    const ndv=T.normalWorld.dot(V).clamp(0.0,1.0);
    // limb darkening, redder toward the edge
    const limb=ndv.pow(0.45).mul(0.6).add(0.4);
    const base=near?plasma(T,U,d,true):T.mix(U.mid,U.core,ndv.pow(1.5).mul(0.6));
    m.colorNode=T.mix(U.deep.mul(1.4),base,limb).mul(limb.mul(0.5).add(0.75));
    m.toneMapped=false;
    return m;
  }
  function coronaMat(T,U,R,steps){
    const m=new THREE.MeshBasicNodeMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.BackSide});
    const {float,vec3,sin,exp,dot,normalize,max,time}=T;
    const C=T.uniform(new THREE.Vector3());
    const Rc=R*2.4, H=R*0.22;
    const ro=T.cameraPosition.sub(C), rd=normalize(T.positionWorld.sub(T.cameraPosition));
    const b=dot(ro,rd), c=dot(ro,ro).sub(Rc*Rc);
    const disc=b.mul(b).sub(c).max(0.0).sqrt();
    const t0=b.negate().sub(disc).max(0.0), t1=b.negate().add(disc);
    const dt=t1.sub(t0).div(steps);
    let acc=float(0);
    for(let i=0;i<steps;i++){
      const p=ro.add(rd.mul(t0.add(dt.mul(i+0.5))));
      const r=p.length();
      const n=p.div(r);
      // streamers: brighter fans along slowly turning great circles
      const s=sin(n.x.mul(5.0).add(time.mul(0.05))).mul(sin(n.y.mul(4.0).sub(time.mul(0.04)))).mul(sin(n.z.mul(6.0))).mul(0.5).add(0.5);
      acc=acc.add(exp(r.sub(R).div(H).negate()).mul(s.mul(0.7).add(0.3)).mul(r.greaterThan(R*0.99).select(1.0,0.0)));
    }
    // soft-saturating so a long path through it glows, never whites out
    const k=float(1).sub(exp(acc.mul(dt).div(R*1.4).negate()));
    m.colorNode=T.mix(U.mid,U.hot,k).mul(k.mul(0.6));
    m.toneMapped=false;
    m.userData.C=C;
    return m;
  }

  /* prominences: particles on magnetic arcs, now and then a flare */
  function prominences(R,col,low,seed){
    const A=low?6:10, N=low?30:44, tot=A*N;
    // camera-facing quads (WebGPU draws GL points one pixel wide, so no Points)
    let tex=null; try{ tex=makeCircleTex(32,'rgb(255,230,190)',1); }catch(e){}
    const m=new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});
    const pts=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),m,tot);
    pts.frustumCulled=false; pts.renderOrder=2; pts.name='JOTS_StarProminences';
    const pos=new Float32Array(tot*3), cols=new Float32Array(tot*3);
    const S=R*(low?0.034:0.026), M4=new THREE.Matrix4(), PV=new THREE.Vector3(), SC=new THREE.Vector3(), CL=new THREE.Color(), Q=new THREE.Quaternion();
    for(let i=0;i<tot;i++) pts.setColorAt(i,CL.setRGB(0,0,0));
    let rs=seed*9301+49297; const rnd=()=>{ rs=(rs*9301+49297)%233280; return rs/233280; };
    const V=THREE.Vector3;
    const arcs=[];
    function arc(a){
      const d0=new V(rnd()*2-1,rnd()*2-1,rnd()*2-1).normalize();
      const ax=new V().crossVectors(d0,new V(rnd()-0.5,rnd()-0.5,rnd()-0.5)).normalize();
      const d1=d0.clone().applyAxisAngle(ax,0.12+rnd()*0.18);
      a.d0=d0; a.d1=d1; a.h=R*(0.08+rnd()*0.2); a.life=6+rnd()*10; a.age=0; a.flare=rnd()<0.18; a.sp=0.12+rnd()*0.2;
      return a;
    }
    for(let i=0;i<A;i++){ const a=arc({}); a.age=rnd()*a.life; arcs.push(a); }
    const off=new Float32Array(tot); for(let i=0;i<tot;i++) off[i]=rnd();
    const jit=new Float32Array(tot*3); for(let i=0;i<tot*3;i++) jit[i]=(rnd()-0.5);
    const tmp=new V(), c=col.mid.clone(), cHot=col.hot.clone();   // reddish loops, hotter at the feet
    pts.userData.tick=function(dt,cam){
      for(let ai=0;ai<A;ai++){
        const a=arcs[ai]; a.age+=dt; if(a.age>a.life) arc(a);
        const env=Math.sin(Math.PI*Math.min(1,a.age/a.life));        // rises, holds, sinks back
        const er=a.flare?Math.max(0,(a.age/a.life-0.55)/0.45):0;      // flares tear loose late in life
        for(let j=0;j<N;j++){
          const i=ai*N+j;
          let s=(off[i]+a.age*a.sp)%1;
          tmp.copy(a.d0).lerp(a.d1,s).normalize();
          let h=a.h*env*Math.sin(Math.PI*s)*(1+er*3);
          if(er>0) h+=R*er*er*0.9*(0.5+off[i]);                       // ejected material flying out
          const r=R*1.005+h, jj=R*0.012*(1+er*2);
          pos[i*3]=tmp.x*r+jit[i*3]*jj; pos[i*3+1]=tmp.y*r+jit[i*3+1]*jj; pos[i*3+2]=tmp.z*r+jit[i*3+2]*jj;
          const k=env*(0.55+0.45*Math.sin(Math.PI*s))*(1-er*0.7);
          const cc=s<0.15||s>0.85?cHot:c;
          cols[i*3]=cc.r*k*1.5; cols[i*3+1]=cc.g*k*1.5; cols[i*3+2]=cc.b*k*1.5;
        }
      }
      // face the camera (in the star's frame)
      if(cam){ pts.parent.getWorldQuaternion(Q).invert().multiply(cam.quaternion); }
      for(let i=0;i<tot;i++){
        const k=Math.max(cols[i*3],cols[i*3+1],cols[i*3+2]);
        M4.compose(PV.set(pos[i*3],pos[i*3+1],pos[i*3+2]),Q,SC.setScalar(k>0.01?S*(0.6+k*0.6):1e-4));
        pts.setMatrixAt(i,M4); pts.setColorAt(i,CL.setRGB(cols[i*3],cols[i*3+1],cols[i*3+2]));
      }
      pts.instanceMatrix.needsUpdate=true; if(pts.instanceColor) pts.instanceColor.needsUpdate=true;
    };
    return pts;
  }

  function build(o){
    const T=THREE.TSL, R=o.radius, K=o.temp||5600, seed=o.seed||1, low=lowTier();
    const group=new THREE.Group(); group.name='JOTS_Star';
    const h={group,R,K,low,seed};
    if(!T||!THREE.MeshBasicNodeMaterial){
      // no node materials at all: a flat glowing sphere
      h.mesh=new THREE.Mesh(new THREE.SphereGeometry(R,32,24),new THREE.MeshBasicMaterial({color:kelvin(K*0.75)}));
      group.add(h.mesh); return h;
    }
    const U=uniforms(T,K,seed); h.U=U; h.T=T;
    h.matNear=surfaceMat(T,U,true); h.matFar=surfaceMat(T,U,false);
    h.mesh=new THREE.Mesh(new THREE.SphereGeometry(R,96,64),h.matFar);   // a smooth limb up close
    h.mesh.name='JOTS_StarSurface';
    group.add(h.mesh);
    try{
      h.corona=new THREE.Mesh(new THREE.SphereGeometry(R*2.4,32,20),coronaMat(T,U,R,low?4:6));
      h.corona.renderOrder=1; h.corona.frustumCulled=false; h.corona.name='JOTS_StarCorona';
      group.add(h.corona);
    }catch(e){ console.warn('[star] corona:',e); }
    try{
      h.prom=prominences(R,palette(K),low,seed); h.prom.visible=false; group.add(h.prom);
    }catch(e){ console.warn('[star] prominences:',e); }
    group.userData.dmStar=h;
    for(const o of live) if(!o.group.parent) live.delete(o);   // stars of systems we've left
    live.add(h);
    return h;
  }
  // the same plasma, seen from inside the star (the zero-g bubble's dive)
  function interiorMaterial(h){
    if(!h||!h.U) return null;
    if(h.matIn) return h.matIn;
    const T=h.T, m=new THREE.MeshBasicNodeMaterial({side:THREE.BackSide});
    m.colorNode=plasma(T,h.U,T.normalize(T.positionLocal),true).mul(0.85);
    m.toneMapped=false;
    return (h.matIn=m);
  }

  const _v=()=>new THREE.Vector3();
  let V1=null;
  // per frame: level of detail by how big the star is on screen; corona centre;
  // prominences only up close
  function frame(cam,dt){
    if(!cam) return;
    if(!V1) V1=_v();
    for(const h of live){
      if(!h.group.parent||!h.group.visible) continue;
      h.group.getWorldPosition(V1);
      const d=Math.max(1e-3,cam.position.distanceTo(V1));
      const ang=h.R/d;                                     // ~angular radius
      const near=ang>0.04;
      if(h.U) h.U.fine.value=Math.max(0,Math.min(1,(ang-0.3)/0.5));
      const m=near?h.matNear:h.matFar; if(h.mesh.material!==m) h.mesh.material=m;
      if(h.corona&&h.corona.material.userData.C) h.corona.material.userData.C.value.copy(V1);
      if(h.prom){ h.prom.visible=ang>0.12; if(h.prom.visible) h.prom.userData.tick(Math.min(0.1,dt||1/60),cam); }
    }
  }
  function setBubble(c,r){ if(!BU) return; if(c) BU.c.value.copy(c); BU.r.value=r>0?r:0; }
  window.DMStar={build,frame,interiorMaterial,setBubble,tempFor,kelvin,palette};
})();
