/* GPlanSiS|PDIN · Detalhamento visual conceitual sobre a geometria original, com paleta por tema.
 * Não é projeto executivo. Tema escuro = GitHub dark gray industrial; claro = cinzas neutros. */
(function(){
if(!window.GPlanSIS)return;
const PALETTES={
 dark:{bg:0x0d1117,ground:0x0f141a,slab:0x1c2128,wall:0x30363d,room:0x21262d,zone:0x1a1f26,eq:0x3d444d,eqDark:0x262c34,panel:0x484f58,truck:0x545d68,person:0x8b949e,roof:0x2d333b,accent:0xf0883e,select:0x58a6ff,grid:0x30363d,gridOpacity:.3,flow:0xf0883e,edge:0x6e7681,edgeOpacity:.45,roomFill:0x21262d,zoneFill:0x1b2028,hemi:.8,sun:1.05,
  metal:0x6e7681,dark:0x161b22,copper:0xb78b56,teal:0x58a6ff,amber:0xd29922,screen:0x1f6feb,wood:0x6b5b46,label:'color:#c9d1d9;background:#161b22e6;border:1px solid #30363d'},
 light:{bg:0xf6f8fa,ground:0xeaeef2,slab:0xdfe4ea,wall:0xc8cfd6,room:0xe6eaee,zone:0xdce1e6,eq:0xb6bdc4,eqDark:0x8d959c,panel:0x9ba3aa,truck:0xc9cfd5,person:0x6c767e,roof:0xcfd5db,accent:0xbc4c00,select:0x0969da,grid:0xb2bac1,gridOpacity:.5,flow:0xbc4c00,edge:0x8e979f,edgeOpacity:.55,roomFill:0xe6eaee,zoneFill:0xdce1e6,hemi:.7,sun:1.1,
  metal:0x8d959c,dark:0x57606a,copper:0xb87333,teal:0x0969da,amber:0x9a6700,screen:0x218bff,wood:0x9c8a6e,label:'color:#1f2328;background:#ffffffe6;border:1px solid #d0d7de'}
};
const registry={};
function mat(kind,T,pal){const m=new T.MeshStandardMaterial({color:pal[kind],roughness:kind==='copper'?.35:.5,metalness:kind==='copper'?.6:kind==='wood'?0:.45});(registry[kind]=registry[kind]||[]).push(m);return m;}
function flat(kind,T,pal){const m=new T.MeshBasicMaterial({color:pal[kind]});(registry[kind]=registry[kind]||[]).push(m);return m;}
window.applyDemoTheme=function(theme){
 const pal=PALETTES[theme==='light'?'light':'dark'];
 ['ground','slab','wall','room','zone','eq','eqDark','panel','truck','person','roof','accent','select'].forEach(k=>{if(M[k]&&M[k].color)M[k].color.setHex(pal[k]).convertSRGBToLinear();});
 if(M.grid){M.grid.color.setHex(pal.grid).convertSRGBToLinear();M.grid.transparent=true;M.grid.opacity=pal.gridOpacity;}
 if(M.flowLine){M.flowLine.color.setHex(pal.flow).convertSRGBToLinear();M.flowLine.opacity=.75;}
 if(M.edge){M.edge.color.setHex(pal.edge).convertSRGBToLinear();M.edge.opacity=pal.edgeOpacity;}
 scene.background.setHex(pal.bg);scene.fog.color.setHex(pal.bg);
 AREAS.forEach(a=>{const r=areaByI[a.id];if(r&&r.fill)r.fill.material.color.setHex(a.t==='room'?pal.roomFill:pal.zoneFill).convertSRGBToLinear();});
 hemi.intensity=pal.hemi;sun.intensity=pal.sun;
 Object.keys(registry).forEach(k=>registry[k].forEach(m=>m.color.setHex(pal[k])));
 labels.forEach(l=>{l.el.style.cssText+=';font:8px Segoe UI,sans-serif;letter-spacing:1px;border-radius:3px;padding:4px 6px;'+pal.label;});
};
window.enhanceDemo=function(theme){
 const T=THREE,pal=PALETTES[theme==='light'?'light':'dark'];
 const overview={almox:'ALMOXARIFADO',carga:'DOCAS',mec:'MONTAGEM MECÂNICA',barr:'BARRAMENTOS',s2me:'MONTAGEM ELÉTRICA',s1id:'IDENTIFICAÇÃO',teste:'TESTES / TAF',comp:'COMPONENTES'};
 labels.forEach(l=>{l.el.style.display=overview[l.area]?'block':'none';if(overview[l.area])l.el.textContent=overview[l.area];});
 const detail=new T.Group();root.add(detail);
 const metal=mat('metal',T,pal),dark=mat('dark',T,pal),copper=mat('copper',T,pal),teal=flat('teal',T,pal),amber=flat('amber',T,pal),screen=flat('screen',T,pal),wood=mat('wood',T,pal);
 const cube=(parent,x,y,z,w,h,d,material)=>{const o=new T.Mesh(BOX,material);o.scale.set(w,h,d);o.position.set(x,y+h/2,z);o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;};
 AREAS.filter(a=>a.t==='hall').forEach(a=>{const r=areaByI[a.id];for(let z=r.z-r.d/2+4;z<r.z+r.d/2;z+=9){for(const x of [r.x-r.w/2+.45,r.x+r.w/2-.45]){cube(detail,x,SLAB_Y,z,.4,7,.4,metal);cube(detail,x,SLAB_Y+6.4,z,.12,.16,3,teal);}}cube(detail,r.x,SLAB_Y+.03,r.z-r.d/2+1,r.w-2,.035,.07,teal);});
 AREAS.filter(a=>a.eq==='panel').forEach(a=>{const r=areaByI[a.id];for(let row=0;row<Math.max(1,Math.floor(r.d/5));row++){for(let col=0;col<Math.max(1,Math.floor(r.w/4));col++){const x=r.x-r.w/2+2+col*4,z=r.z-r.d/2+2+row*5;const g=new T.Group();g.position.set(x,SLAB_Y,z);detail.add(g);cube(g,0,0,0,1.7,.16,1.15,dark);cube(g,-.77,.16,0,.12,2.65,.9,metal);cube(g,.77,.16,0,.12,2.65,.9,metal);cube(g,0,.16,-.4,1.5,2.65,.1,metal);cube(g,0,2.8,0,1.7,.12,.95,metal);for(let j=0;j<3;j++)cube(g,-.45+j*.45,.5,-.24,.07,1.9,.05,copper);for(let j=0;j<3;j++){cube(g,0,.55+j*.68,.08,1.1,.32,.32,dark);cube(g,-.35,.61+j*.68,.26,.06,.06,.02,teal);}cube(g,.87,2.05,.1,.12,.18,.12,teal);cube(g,.87,1.84,.1,.12,.18,.12,amber);}}});
 AREAS.filter(a=>a.eq==='bench').forEach(a=>{const r=areaByI[a.id];for(let z=r.z-r.d/2+1.5;z<r.z+r.d/2-.8;z+=3.2){cube(detail,r.x,SLAB_Y+.94,z-.1,1.0,.06,.6,metal);cube(detail,r.x,SLAB_Y+1,z-.3,.08,.5,.08,dark);cube(detail,r.x,SLAB_Y+1.2,z-.3,.7,.45,.06,screen);cube(detail,r.x+1.1,SLAB_Y+.9,z,.7,.25,.5,copper);}});
 const dock=areaByI.carga;for(let i=0;i<6;i++){const x=dock.x-dock.w/2+2+i*3.3,z=dock.z-2;cube(detail,x,SLAB_Y,z,1.7,.17,1.3,wood);cube(detail,x,SLAB_Y+.17,z,1.4,1.1,1.1,metal);cube(detail,x,SLAB_Y+.17,z,.07,1.13,1.12,teal);}
 const rackArea=areaByI.esp_almox;for(let k=0;k<2;k++){const x=rackArea.x-2+k*3;for(const dx of [-1,1])for(const dz of [-.6,.6])cube(detail,x+dx,SLAB_Y,rackArea.z+dz,.09,3.8,.09,metal);for(let y=0;y<4;y++){cube(detail,x,SLAB_Y+y*1.1,rackArea.z,2.15,.1,1.4,copper);for(let n=0;n<3;n++)cube(detail,x-.65+n*.65,SLAB_Y+y*1.1+.1,rackArea.z,.5,.55,.8,wood);}}
 window.applyDemoTheme(theme);
};
})();
