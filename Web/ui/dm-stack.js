/* DART Meadow — the right-hand stack, the same in every world view:
 *   top bar → ONLINE · CHAT / INITIALIZE PROGRESS / EXIT row → ORBIT (and on
 *   the ground 1ST PERSON; in the sky the Mach bubbles, then ORBIT) → the chat
 *   panel. The chat panel opens under whatever is showing there, never on top
 *   of it, and stops above the thumbstick / IDLE controls. If there isn't room
 *   under the column (short landscape phones in the sky), it opens beside the
 *   column instead. */
(function(){
  'use strict';
  const vis=e=>{ if(!e) return false; const cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden') return false; const r=e.getBoundingClientRect(); return r.width>0&&r.height>0; };
  const mode=()=>{
    const s=document.getElementById('surface-overlay'), a=document.getElementById('atmo-overlay');
    if(s&&s.style.display&&s.style.display!=='none') return 'surf';
    if(a&&a.style.display&&a.style.display!=='none') return 'atmo';
    try{ if(typeof STATE!=='undefined'&&STATE.screen==='flight') return 'space'; }catch(e){}
    return null;
  };
  const q=(root,sel)=>root?[...root.querySelectorAll(sel)].filter(vis):[];
  const setImp=(el,prop,val)=>{ if(el.style.getPropertyValue(prop)!==val||el.style.getPropertyPriority(prop)!=='important') el.style.setProperty(prop,val,'important'); };
  function layout(){
    const m=mode(); if(!m) return;
    const ov=m==='surf'?document.getElementById('surface-overlay'):m==='atmo'?document.getElementById('atmo-overlay'):document.getElementById('screen-flight');
    const W=window.innerWidth, H=window.innerHeight;
    // in the sky ORBIT sits right under the Mach bubbles, docked like the other edge tabs
    if(m==='atmo'){
      const mp=document.getElementById('atmo-presets'), ob=ov.querySelector('.orbit-skyboard-btn');
      if(ob&&mp&&vis(mp)){ const r=mp.getBoundingClientRect(), o=ov.getBoundingClientRect(); setImp(ob,'top',Math.round(r.bottom-o.top+10)+'px'); setImp(ob,'right','0px'); }
    }
    const chat=document.getElementById('jots-chat');
    if(!chat||chat.style.display!=='flex') return;
    const rail=q(ov,m==='space'?'.hud-r-row':'.world-rail')[0];
    // the rail counts only where it sits up top (portrait phones on a world carry it at the bottom)
    const hdr=m==='space'?null:ov.querySelector(':scope>div');
    let railB=hdr&&vis(hdr)?hdr.getBoundingClientRect().bottom:56;
    if(rail){ const rr=rail.getBoundingClientRect(); if(rr.top<H*0.4) railB=Math.max(railB,rr.bottom); }
    // the column under the rail on the right edge
    const col=[...q(ov,'.orbit-skyboard-btn,#orbit-skyboard-btn,#surf-view-btn'),...(m==='atmo'?q(ov,'#atmo-presets'):[])]
      .map(e=>e.getBoundingClientRect()).filter(r=>r.right>W*0.55&&r.top>=railB-4&&r.top<H*0.7);
    const colB=col.reduce((b,r)=>Math.max(b,r.bottom),railB), colL=col.reduce((l,r)=>Math.min(l,r.left),W);
    const cw=Math.min(300,W*0.7);
    // what the panel must stay above: sticks, IDLE / assist pads, the throttle
    const lows=[...q(ov,'#surf-look-zone,#surf-move-zone,#surf-jump-btn,#surf-climb-btn,#atmo-climb-zone,#atmo-steer-zone,#atmo-overlay .side-pad,#joysticks .joystick-zone,#assist-row,#screen-flight .side-pad,#atmo-throttle,#spec-bar')]
      .map(e=>e.getBoundingClientRect()).filter(r=>r.top>H*0.25);
    const kite=[...q(ov,'.mini-kite,#screen-flight .hud-c')].map(e=>e.getBoundingClientRect());
    const obst=[...col,...lows,...kite];
    // free height for the panel at (left..right, from top): -1 if something sits right there
    const roomAt=(left,right,top)=>{ let f=H-8;
      for(const r of obst){ if(r.right<=left||r.left>=right) continue;
        if(r.top<=top&&r.bottom>top) return -1;
        if(r.top>top) f=Math.min(f,r.top-8); }
      return f-top; };
    const fixed=chat.getBoundingClientRect().height>0?[...chat.children].filter(c=>c.id!=='jots-chat-log'&&!c.classList.contains('fr-pane')&&vis(c)).reduce((h,c)=>h+c.getBoundingClientRect().height+5,0):60;
    // preference: right edge under the column (as in space), then beside the column,
    // then clear of the right-hand thumb controls too
    const lowL=lows.filter(r=>r.left>W*0.5).reduce((l,r)=>Math.min(l,r.left),W);
    const cands=[[12,colB+8],[Math.max(12,W-colL+8),railB+8],[Math.max(12,W-Math.min(colL,lowL)+8),railB+8]];
    let top=colB+8, right=12, room=-1;
    for(const [rt,tp] of cands){ const rm=roomAt(W-rt-cw,W-rt,tp); if(rm>=110){ top=tp; right=rt; room=rm; break; } if(rm>room){ top=tp; right=rt; room=rm; } }
    if(room<0) room=120;
    const par=chat.offsetParent||document.body, pr=par.getBoundingClientRect();
    setImp(chat,'top',Math.round(top-pr.top)+'px');
    setImp(chat,'right',Math.round(pr.right-(W-right))+'px');
    const body=Math.max(48,Math.round(room-fixed));
    const log=document.getElementById('jots-chat-log'), pane=document.getElementById('fr-pane');
    if(log) setImp(log,'max-height',Math.min(body,H*0.34|0)+'px');
    if(pane) setImp(pane,'max-height',Math.min(body,H*0.4|0)+'px');
  }
  setInterval(layout,400);
  window.addEventListener('resize',()=>setTimeout(layout,60));
  window.DMStack={layout};
})();
