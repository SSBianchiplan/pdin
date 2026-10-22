/* GPlanSiS|PDIN · Sessão do usuário, troca de senha, gestão de usuários (admin) e menu lateral no celular.
 * Carregado depois de app.js: usa App, MODULES, TITLES, Modules, navigate, toast, esc e api. */
'use strict';
const Users=(()=>{
const ROLE={admin:['Administrador','accent'],operador:['Operador','info'],leitor:['Leitor','']};
const ACTION={lead_novo:'Solicitação reaberta',lead_contatado:'Solicitação contatada',lead_descartado:'Solicitação descartada',login:'Entrou',login_failed:'Senha inválida',login_inactive:'Tentativa em conta inativa',password_changed:'Trocou a própria senha',password_reset:'Senha redefinida',user_created:'Usuário criado',user_updated:'Usuário alterado',user_deleted:'Usuário removido',bootstrap_master:'Master criado'};
let list=[],events=[],leads=[],search='';
const INTEREST={supervisorio:'Supervisório 3D',mes:'MES',aps:'APS',plm:'PLM',pcp:'PCP',almoxarifado:'Almoxarifado'};
const when=v=>v?new Date(v).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}):'nunca';
const initials=n=>String(n||'?').split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('');
const isMaster=()=>!!App.user?.is_master;

/* ---------------- sessão */
async function loadMe(){
 const r=await fetch('/api/auth/me',{credentials:'same-origin'});
 if(r.status===401){location.replace('/login.html?next='+encodeURIComponent(location.pathname+location.hash));return null;}
 if(!r.ok)return null;
 return r.json();
}
async function logout(){try{if(App.dirty)await saveNow();}catch{}await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});location.replace('/login.html');}
function renderChip(){
 const u=App.user,el=document.querySelector('.side-bottom .avatar');if(!u||!el)return;
 el.outerHTML=`<div class="user-chip"><button type="button" class="avatar" id="user-menu-btn" aria-haspopup="true" aria-expanded="false" title="${esc(u.email)}"><b>${esc(initials(u.name))}</b><span>${esc(u.name)}<small>${ROLE[u.role][0]}${u.is_master?' · master':''}</small></span></button>
  <div class="popover-menu user-menu" id="user-menu" role="menu" hidden><div class="user-menu-head"><b>${esc(u.name)}</b><small>${esc(u.email)}</small></div>${u.role==='admin'?'<a role="menuitem" href="#users">◉ Gestão de usuários</a>':''}<button role="menuitem" type="button" data-user-action="password">⚿ Trocar senha</button><button role="menuitem" type="button" data-user-action="logout">⎋ Sair</button></div></div>`;
 const btn=document.getElementById('user-menu-btn'),menu=document.getElementById('user-menu');
 btn.addEventListener('click',e=>{e.stopPropagation();const open=menu.hidden;menu.hidden=!open;btn.setAttribute('aria-expanded',String(open));});
 document.addEventListener('click',e=>{if(!menu.hidden&&!menu.contains(e.target)){menu.hidden=true;btn.setAttribute('aria-expanded','false');}});
 menu.addEventListener('click',e=>{const a=e.target.closest('[data-user-action],a');if(!a)return;menu.hidden=true;if(a.dataset.userAction==='logout')logout();else if(a.dataset.userAction==='password')openPassword(false);});
}
function applyRole(){
 const u=App.user;document.body.classList.toggle('role-leitor',u.role==='leitor');document.body.classList.toggle('role-admin',u.role==='admin');
 App.readOnly=u.role==='leitor';
 if(u.role==='admin'&&!MODULES.some(m=>m[0]==='users')){MODULES.push(['users','◉','Usuários']);TITLES.users=['Gestão de usuários','Contas, perfis de acesso, senhas provisórias e trilha de acesso.'];}
 const eb=()=>{if(App.current==='users')$('page-eyebrow').textContent='Administração';};window.addEventListener('hashchange',()=>setTimeout(eb));setTimeout(eb,0);
 if(App.readOnly)$('side-note').textContent='Perfil leitor: consulta a operação em tempo real, sem apontar nem alterar dados.';
 navigate(location.hash.slice(1)||App.current);
}

/* ---------------- troca de senha (própria) */
function openPassword(forced){
 const d=$('password-dialog'),f=$('password-form');f.reset();$('password-error').textContent='';
 d.querySelector('[data-close]').hidden=forced;$('password-forced').hidden=!forced;d.dataset.forced=forced?'1':'';
 d.showModal();f.current.focus();
}
function bindPassword(){
 const d=$('password-dialog');
 d.addEventListener('cancel',e=>{if(d.dataset.forced)e.preventDefault();});
 $('password-form').addEventListener('submit',async e=>{e.preventDefault();const f=e.target;$('password-error').textContent='';
  if(f.new.value!==f.confirm.value){$('password-error').textContent='As senhas não conferem.';return;}
  try{await api('POST','/api/auth/password',{current:f.current.value,new:f.new.value});App.user.must_change=false;d.dataset.forced='';d.close();toast('Senha alterada. As outras sessões desta conta foram encerradas.');}
  catch(x){$('password-error').textContent=x.message;}});
}

/* ---------------- gestão de usuários */
async function refresh(){
 try{[list,events,leads]=await Promise.all([api('GET','/api/users'),api('GET','/api/users/events?limit=40'),api('GET','/api/leads?limit=100')]);}catch(x){toast(x.message,true);}
 draw();
}
function canEdit(u){if(u.is_master)return isMaster();if(u.role==='admin')return isMaster();return true;}
function row(u){
 const me=u.id===App.user.id,ed=canEdit(u),lockRole=u.is_master||me||!ed,lockActive=u.is_master||me||!ed;
 const locked=u.locked_until&&new Date(u.locked_until)>new Date();
 const roles=Object.entries(ROLE).filter(([k])=>k!=='admin'||isMaster()||u.role==='admin');
 return `<div class="user-row ${u.active?'':'inactive'}" data-uid="${u.id}">
  <div class="user-id"><b class="user-avatar">${esc(initials(u.name))}</b><div><div class="user-name">${esc(u.name)} ${u.is_master?'<span class="badge accent">MASTER</span>':''}${me?' <span class="badge">você</span>':''}${u.must_change?' <span class="badge warn" title="Precisa trocar a senha provisória no próximo acesso">senha provisória</span>':''}${locked?' <span class="badge alarm">bloqueado</span>':''}</div><small class="mono">${esc(u.email)}</small></div></div>
  <label class="user-field"><span>Perfil</span><select data-user-role ${lockRole?'disabled':''} aria-label="Perfil de ${esc(u.name)}">${roles.map(([k,v])=>`<option value="${k}" ${u.role===k?'selected':''}>${v[0]}</option>`).join('')}</select></label>
  <label class="user-field user-active"><span>Ativo</span><input type="checkbox" data-user-active ${u.active?'checked':''} ${lockActive?'disabled':''} aria-label="Conta ativa"></label>
  <div class="user-field"><span>Último acesso</span><small>${when(u.last_login_at)}${u.sessions?` · ${u.sessions} sessão(ões)`:''}</small></div>
  <div class="user-actions">${ed&&!me?`<button type="button" class="small" data-user-reset>⚿ Redefinir senha</button>`:''}${ed&&!me&&!u.is_master?`<button type="button" class="small danger" data-user-delete>Remover</button>`:''}${me?'<button type="button" class="small" data-user-self>⚿ Trocar minha senha</button>':''}</div>
 </div>`;
}
function draw(){
 const v=$('view-users');if(!v)return;
 const q=search.trim().toLowerCase(),rows=list.filter(u=>!q||u.name.toLowerCase().includes(q)||u.email.includes(q));
 const count=r=>list.filter(u=>u.role===r&&u.active).length;
 v.innerHTML=`<div class="grid-2 split-2-1"><div class="panel"><div class="panel-title"><h2>Usuários <span class="tag">${list.filter(u=>u.active).length} ativos</span></h2><button class="primary" type="button" data-user-new>＋ Novo usuário</button></div>
  <div class="toolbar"><input type="search" id="user-search" placeholder="Buscar por nome ou e-mail…" value="${esc(search)}" aria-label="Buscar usuário"></div>
  <div class="user-list">${rows.map(row).join('')||'<p class="muted">Nenhum usuário encontrado.</p>'}</div></div>
  <div class="stack"><div class="panel"><div class="panel-title"><h2>Perfis de acesso</h2></div>
   <ul class="role-help"><li><span class="badge accent">Administrador</span> <b>${count('admin')}</b> Opera tudo e gerencia usuários. ${isMaster()?'Você é o master: só você cria ou altera administradores.':'Só o master cria ou altera administradores.'}</li><li><span class="badge info">Operador</span> <b>${count('operador')}</b> Aponta, planeja, movimenta estoque, cria ordens, projetos e revisões.</li><li><span class="badge">Leitor</span> <b>${count('leitor')}</b> Consulta todos os módulos e o gêmeo 3D, sem alterar nada.</li></ul></div>
  <div class="panel"><div class="panel-title"><h2>Solicitações de demonstração</h2><span class="tag ${leads.some(l=>l.status==='novo')?'accent':''}">${leads.filter(l=>l.status==='novo').length} novas</span></div><div class="auth-events">${leads.map(l=>`<div class="auth-event lead ${l.status}" data-lead="${l.id}"><span><b>${esc(l.name)}</b> · ${esc(l.company)}</span><small><a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.phone?' · '+esc(l.phone):''}${l.role?' · '+esc(l.role):''}</small>${(l.interests||[]).length?`<small>${l.interests.map(i=>esc(INTEREST[i]||i)).join(' · ')}</small>`:''}${l.message?`<small class="lead-msg">${esc(l.message)}</small>`:''}<small class="mono">${when(l.at)} · <select data-lead-status aria-label="Situação da solicitação">${['novo','contatado','descartado'].map(x=>`<option value="${x}" ${l.status===x?'selected':''}>${x}</option>`).join('')}</select></small></div>`).join('')||'<p class="muted">Nenhuma solicitação pela página pública ainda.</p>'}</div></div>
  <div class="panel"><div class="panel-title"><h2>Trilha de acesso</h2><span class="muted">últimos 40</span></div><div class="auth-events">${events.map(e=>`<div class="auth-event"><span class="${/failed|inactive/.test(e.action)?'danger':''}">${esc(ACTION[e.action]||e.action)}</span><small>${esc(e.target||'')}${e.actor&&e.actor!==e.target?' · por '+esc(e.actor):''}</small><small class="mono">${when(e.at)} · ${esc(e.ip||'')}</small></div>`).join('')||'<p class="muted">Sem eventos.</p>'}</div></div></div></div>`;
}
async function patch(uid,body){try{await api('PATCH','/api/users/'+uid,body);toast('Usuário atualizado.');}catch(x){toast(x.message,true);}refresh();}
function showSecret(title,email,pwd){
 const d=$('user-dialog');$('user-form').hidden=true;const box=$('user-secret');box.hidden=false;
 box.innerHTML=`<div class="panel-title"><h2>${esc(title)}</h2><button type="button" class="close" data-close aria-label="Fechar">×</button></div><p>Entregue a senha provisória a <b>${esc(email)}</b> por um canal seguro. Ela aparece <b>só agora</b> e precisa ser trocada no primeiro acesso.</p><div class="secret"><code id="secret-value">${esc(pwd)}</code><button type="button" data-copy>Copiar</button></div><button type="button" class="primary" data-close style="margin-top:16px">Concluído</button>`;
 box.querySelector('[data-copy]').addEventListener('click',async e=>{try{await navigator.clipboard.writeText(pwd);e.target.textContent='Copiado ✓';}catch{getSelection().selectAllChildren($('secret-value'));}});
 if(!d.open)d.showModal();
}
function openNew(){
 const d=$('user-dialog'),f=$('user-form');f.reset();f.hidden=false;$('user-secret').hidden=true;$('user-error').textContent='';
 f.role.querySelector('[value=admin]').disabled=!isMaster();f.password.closest('label').hidden=true;d.showModal();f.name.focus();
}
function bind(){
 document.addEventListener('click',async e=>{
  const v=e.target.closest('#view-users');if(!v)return;
  if(e.target.closest('[data-user-new]'))return openNew();
  if(e.target.closest('[data-user-self]'))return openPassword(false);
  const r=e.target.closest('[data-uid]');if(!r)return;const u=list.find(x=>x.id===+r.dataset.uid);if(!u)return;
  if(e.target.closest('[data-user-reset]')){if(!confirm(`Gerar uma senha provisória para ${u.name}? As sessões abertas dessa conta serão encerradas.`))return;
   try{const res=await api('POST',`/api/users/${u.id}/password`,{});showSecret('Senha redefinida',u.email,res.temporaryPassword);}catch(x){toast(x.message,true);}refresh();}
  if(e.target.closest('[data-user-delete]')){if(!confirm(`Remover ${u.name} (${u.email})? Esta ação não pode ser desfeita. Para suspender o acesso sem apagar, desmarque "Ativo".`))return;
   try{await api('DELETE','/api/users/'+u.id);toast('Usuário removido.');}catch(x){toast(x.message,true);}refresh();}
 });
 document.addEventListener('change',async e=>{
  const ld=e.target.closest('#view-users [data-lead]');if(ld&&e.target.matches('[data-lead-status]')){try{await api('PATCH','/api/leads/'+ld.dataset.lead,{status:e.target.value});toast('Solicitação marcada como '+e.target.value+'.');}catch(x){toast(x.message,true);}refresh();return;}
  const r=e.target.closest('#view-users [data-uid]');if(!r)return;const uid=+r.dataset.uid;
  if(e.target.matches('[data-user-role]'))patch(uid,{role:e.target.value});
  if(e.target.matches('[data-user-active]')){const u=list.find(x=>x.id===uid);if(!e.target.checked&&!confirm(`Desativar ${u.name}? As sessões abertas serão encerradas.`)){e.target.checked=true;return;}patch(uid,{active:e.target.checked});}
 });
 document.addEventListener('input',e=>{if(e.target.id==='user-search'){search=e.target.value;const pos=e.target.selectionStart;draw();const s=$('user-search');s.focus();s.setSelectionRange(pos,pos);}});
 const f=$('user-form');
 f.mode.addEventListener('change',()=>{f.password.closest('label').hidden=f.mode.value!=='set';});
 f.addEventListener('submit',async e=>{e.preventDefault();$('user-error').textContent='';
  const body={name:f.name.value.trim(),email:f.email.value.trim(),role:f.role.value};if(f.mode.value==='set')body.password=f.password.value;
  try{const res=await api('POST','/api/users',body);if(res.temporaryPassword)showSecret('Usuário criado',res.user.email,res.temporaryPassword);else{$('user-dialog').close();toast('Usuário criado. A senha deverá ser trocada no primeiro acesso.');}refresh();}
  catch(x){$('user-error').textContent=x.message;}});
}

/* ---------------- menu lateral no celular */
function bindSidebar(){
 const open=v=>{document.body.classList.toggle('nav-open',v);$('nav-toggle').setAttribute('aria-expanded',String(v));};
 $('nav-toggle').addEventListener('click',()=>open(!document.body.classList.contains('nav-open')));
 $('nav-backdrop').addEventListener('click',()=>open(false));
 document.querySelector('.sidebar').addEventListener('click',e=>{if(e.target.closest('nav a,.brand,[data-user-action],.user-menu a'))open(false);});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('nav-open'))open(false);});
 $('project-select').addEventListener('change',()=>open(false));
}

(async function init(){
 bindSidebar();bindPassword();bind();
 Modules.users={render(force){if(force)refresh();}};
 const u=await loadMe();if(!u)return;App.user=u;renderChip();applyRole();
 if(u.must_change)openPassword(true);
})();
return {refresh,logout};
})();

if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
