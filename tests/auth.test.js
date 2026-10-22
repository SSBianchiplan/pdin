/* Autenticação e gestão de usuários: exige API em PDIN_API ligada ao banco e as credenciais do master em
 * PDIN_MASTER_EMAIL / PDIN_MASTER_PASSWORD (senha atual do master; o teste troca e restaura).
 *   PDIN_MASTER_PASSWORD='...' node --test tests/auth.test.js */
'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const API=process.env.PDIN_API||'http://127.0.0.1:18380';
const MASTER=process.env.PDIN_MASTER_EMAIL||'contato@gplansis.com';
const MASTER_PWD=process.env.PDIN_MASTER_PASSWORD;

function client(){let cookie='';return async function call(method,path,body,headers={}){
 const r=await fetch(API+path,{method,redirect:'manual',headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
 const set=r.headers.get('set-cookie');if(set){const m=set.match(/pdin_session=([^;]*)/);cookie=m&&m[1]?'pdin_session='+m[1]:'';}
 let j=null;try{j=await r.json();}catch{}return {status:r.status,body:j,location:r.headers.get('location')};};}

test('login, perfis, master protegido, senha provisória e sessões',{skip:!MASTER_PWD&&'defina PDIN_MASTER_PASSWORD'},async()=>{
 const anon=client();
 assert.equal((await anon('GET','/api/projects')).status,401,'API fechada sem sessão');
 const root=await fetch(API+'/',{redirect:'manual'});assert.equal(root.status,200,'visitante vê a página pública');assert.match(await root.text(),/Solicitar demonstração/);
 const app=await anon('GET','/index.html');assert.equal(app.status,302);assert.match(app.location,/\/login\.html/,'o sistema continua atrás do login');
 assert.equal((await anon('GET','/api/leads')).status,401,'solicitações só para admin');
 const leadMail=`lead-${Date.now().toString(36)}@teste.local`;
 assert.equal((await anon('POST','/api/leads',{name:'Visitante Teste',company:'Empresa Teste',email:leadMail,interests:['mes','aps','invalido']})).status,201);
 assert.equal((await anon('POST','/api/leads',{name:'Robo',company:'Spam',email:'robo@spam.local',website:'http://spam'})).status,201,'isca: robô recebe sucesso falso');
 assert.equal((await anon('GET','/login.html')).status,200,'login é público');
 assert.equal((await anon('GET','/manifest.webmanifest')).status,200,'manifest é público (instalação do PWA)');
 assert.equal((await anon('POST','/api/auth/login',{email:MASTER,password:'errada'})).status,401);

 const admin=client();
 let r=await admin('POST','/api/auth/login',{email:MASTER.toUpperCase(),password:MASTER_PWD});
 assert.equal(r.status,200,'e-mail sem diferenciar maiúsculas');assert.equal(r.body.user.is_master,true);assert.equal(r.body.user.role,'admin');
 const masterId=r.body.user.id;
 if(r.body.user.must_change){assert.equal((await admin('POST','/api/projects/00000000-0000-0000-0000-000000000000/snapshot',{})).status,403,'senha provisória bloqueia escrita');}
 // troca e restaura para exercitar o fluxo sem mudar o estado final
 const tmp='Tmp-'+Date.now().toString(36)+'Aa1';
 assert.equal((await admin('POST','/api/auth/password',{current:MASTER_PWD,new:'fraca'})).status,422);
 assert.equal((await admin('POST','/api/auth/password',{current:MASTER_PWD,new:tmp})).status,200);
 assert.equal((await admin('POST','/api/auth/password',{current:tmp,new:MASTER_PWD})).status,200);
 assert.equal((await admin('GET','/api/projects')).status,200);

 // master não pode ser rebaixado, desativado nem removido
 assert.equal((await admin('PATCH','/api/users/'+masterId,{role:'leitor'})).status,400);
 assert.equal((await admin('PATCH','/api/users/'+masterId,{active:false})).status,400);
 assert.equal((await admin('DELETE','/api/users/'+masterId)).status,400);

 const tag=Date.now().toString(36);
 const mk=async(role)=>{const c=await admin('POST','/api/users',{email:`t-${role}-${tag}@teste.local`,name:`Teste ${role}`,role});assert.equal(c.status,201);assert.match(c.body.temporaryPassword,/^\w{4}-\w{4}-\w{4}$/);return c.body;};
 const leitor=await mk('leitor'),outroAdmin=await mk('admin');
 assert.equal((await admin('POST','/api/users',{email:leitor.user.email,name:'dup',role:'leitor'})).status,409,'e-mail único');

 // leitor: lê, não escreve; precisa trocar a provisória antes (troca é permitida)
 const l=client();r=await l('POST','/api/auth/login',{email:leitor.user.email,password:leitor.temporaryPassword});assert.equal(r.body.user.must_change,true);
 const lp='Leitor-'+tag+'X9';assert.equal((await l('POST','/api/auth/password',{current:leitor.temporaryPassword,new:lp})).status,200);
 assert.equal((await l('GET','/api/projects')).status,200);
 const proj=(await l('GET','/api/projects')).body[0];
 assert.equal((await l('POST',`/api/projects/${proj.id}/orders`,{client:'X',product:'P',qty:1,dueHours:10})).status,403,'leitor não cria ordem');
 assert.equal((await l('GET','/api/users')).status,403,'leitor não vê usuários');

 // admin comum não mexe em outro admin nem no master
 const a2=client();await a2('POST','/api/auth/login',{email:outroAdmin.user.email,password:outroAdmin.temporaryPassword});
 await a2('POST','/api/auth/password',{current:outroAdmin.temporaryPassword,new:'Admin2-'+tag+'Z7'});
 assert.equal((await a2('GET','/api/users')).status,200);
 assert.equal((await a2('POST','/api/users',{email:`x-${tag}@teste.local`,name:'Xis',role:'admin'})).status,403,'só o master cria admin');
 assert.equal((await a2('POST','/api/users/'+masterId+'/password',{})).status,403,'admin comum não redefine o master');
 assert.equal((await a2('PATCH','/api/users/'+leitor.user.id,{role:'operador'})).status,200,'admin comum gerencia não-admin');

 // mudança de perfil derruba a sessão do usuário; desativar também
 assert.equal((await l('GET','/api/auth/me')).status,401,'sessão encerrada ao mudar perfil');
 assert.equal((await admin('PATCH','/api/users/'+leitor.user.id,{active:false})).status,200);
 assert.equal((await client()('POST','/api/auth/login',{email:leitor.user.email,password:lp})).status,401,'inativo não entra');

 // limpeza
 assert.equal((await admin('DELETE','/api/users/'+leitor.user.id)).status,200);
 assert.equal((await admin('DELETE','/api/users/'+outroAdmin.user.id)).status,200);
 const leads=(await admin('GET','/api/leads')).body;const lead=leads.find(l=>l.email===leadMail);assert.ok(lead,'solicitação gravada');assert.deepEqual(lead.interests,['aps','mes'],'interesses filtrados');assert.ok(!leads.some(l=>l.email==='robo@spam.local'),'robô descartado');
 assert.equal((await admin('PATCH','/api/leads/'+lead.id,{status:'descartado'})).status,200);
 const ev=await admin('GET','/api/users/events?limit=50');assert.ok(ev.body.some(e=>e.action==='user_deleted'));
 assert.equal((await admin('POST','/api/auth/logout')).status,200);
 assert.equal((await admin('GET','/api/projects')).status,401,'logout encerra a sessão');
});
