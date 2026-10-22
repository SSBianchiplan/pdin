/* Teste de integração (modo operacional): exige API em PDIN_API (padrão http://127.0.0.1:18380) ligada ao banco demo.
 * Cria um projeto descartável, reconstrói o estado, aponta operações reais, importa BOM e verifica a reconciliação relacional. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const F=require('../simulation.js');
const T=require('../templates.js');
const API=process.env.PDIN_API||'http://127.0.0.1:18380';
/* Sessão: PDIN_USER/PDIN_PASSWORD (padrão: master em PDIN_MASTER_EMAIL/PDIN_MASTER_PASSWORD). */
const USER=process.env.PDIN_USER||process.env.PDIN_MASTER_EMAIL||'contato@gplansis.com',PASS=process.env.PDIN_PASSWORD||process.env.PDIN_MASTER_PASSWORD||'';let cookie='';
async function login(){const r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:USER,password:PASS})});if(!r.ok)throw Error('login '+r.status+' (defina PDIN_PASSWORD)');cookie=(r.headers.get('set-cookie')||'').split(';')[0];}
async function call(method,path,body){if(!cookie)await login();const r=await fetch(API+path,{method,headers:{'content-type':'application/json',cookie},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>null);if(!r.ok)throw Error(method+' '+path+' → '+r.status+' '+JSON.stringify(j));return j;}

test('ciclo operacional: projeto → estado → apontamentos → picking → BOM importada → reconciliação',async()=>{
 const h=await call('GET','/api/health');assert.equal(h.database,true,'banco indisponível');assert.ok(h.migration>=4);
 const spec=JSON.parse(JSON.stringify(T.get('USI-CNC-02')));const tag=Date.now().toString(36).toUpperCase();
 spec.code='TST-'+tag;spec.name='Teste automatizado '+tag;spec.kind='demo';spec.orders=spec.orders.slice(0,6);
 spec.items=spec.items.map(i=>({...i,code:'T'+tag+'-'+i.code}));
 spec.products=spec.products.map(p=>({...p,code:'T'+tag+'-'+p.code,bom:Object.fromEntries(Object.entries(p.bom).map(([k,v])=>['T'+tag+'-'+k,v]))}));
 spec.orders=spec.orders.map(o=>({...o,product:'T'+tag+'-'+o.product}));
 const project=await call('POST','/api/projects',spec);
 const st=await call('GET','/api/projects/'+project.id+'/state');assert.equal(st.state,null);assert.equal(st.definition.orders.length,6);
 const s=F.create(st.definition);assert.equal(s.orders.length,6);assert.ok(s.orders.some(o=>o.status==='running'),'seed deveria ter ordem em produção');
 let r=await call('PUT','/api/projects/'+project.id+'/snapshot',{state:s});assert.ok(r.sync.consumed>0,'reservas dos kits já entregues deveriam ser consumidas');assert.ok(r.sync.operations_updated>0,'operações apontadas deveriam ir para o banco');
 const stockEq=async()=>{const rows=await call('GET','/api/projects/'+project.id+'/stock');s.stock.forEach(x=>{const d=rows.find(y=>y.item_code===x.code);if(!d){assert.equal(x.onHand,0,x.code);return;}assert.equal(Number(d.on_hand),x.onHand,'físico '+x.code);assert.equal(Number(d.reserved),x.reserved,'reservado '+x.code);});};
 await stockEq();
 // nova OP pelo banco, espelhada no motor; ciclo de apontamento completo
 const o=await call('POST','/api/projects/'+project.id+'/orders',{client:'Cliente integração',product:s.products[0].code,qty:1,dueHours:72,priority:'Urgente'});assert.match(o.code,/^OF-\d{4}$/);
 const local=F.addOrder(s,{id:o.code,client:'Cliente integração',product:0,qty:1,due:72,priority:'Urgente'});assert.equal(local.revision,o.revision);
 /* capacidade finita real: se a posição estiver ocupada por ordem semeada, conclui a operação dela antes */
 const drive=o=>{F.setStatus(s,o.id,'released');let guard=0;while(o.status!=='done'&&guard++<100){try{F.startOp(s,o.id);}catch(e){if(!/posição livre/.test(e.message))throw e;const busy=F.runningAt(s,F.cur(o))[0].o;if(!busy.consumed&&busy.step>=F.consumeStep(s,busy))F.pick(s,busy.id);F.finishOp(s,busy.id);continue;}if(o.step===F.consumeStep(s,o)&&!o.consumed)F.pick(s,o.id);F.finishOp(s,o.id);}assert.equal(o.status,'done');};
 drive(local);
 F.receive(s,0,25,'Teste');
 r=await call('PUT','/api/projects/'+project.id+'/snapshot',{state:s});assert.equal(r.sync.receipts,1);
 r=await call('PUT','/api/projects/'+project.id+'/snapshot',{state:s});assert.equal(r.sync.receipts,0,'recebimento não pode duplicar');assert.equal(r.sync.consumed,0);
 await stockEq();
 const orders=await call('GET','/api/projects/'+project.id+'/orders');const dbNew=orders.find(x=>x.code===o.code);assert.equal(dbNew.status,'completed');assert.equal(dbNew.priority,90);assert.equal(Number(dbNew.ops_done),Number(dbNew.ops_total));assert.equal(Number(dbNew.consumed_reservations),local.kit.length);
 s.orders.filter(x=>x.status==='running').forEach(x=>assert.equal(orders.find(y=>y.code===x.id).status,'running'));
 s.orders.filter(x=>x.status==='backlog'||x.status==='planned').forEach(x=>assert.equal(orders.find(y=>y.code===x.id).status,'draft'));
 // BOM importada da engenharia com item novo → banco cria item, revisão em análise, depois liberação
 const rows=[{code:s.stock[0].code,name:s.stock[0].name,unit:s.stock[0].unit,qty:3},{code:'T'+tag+'-NOVO',name:'Placa nova',unit:'un',qty:2}];
 const imp=await call('POST','/api/projects/'+project.id+'/revisions/import',{product:s.products[0].code,rows,note:'ECN teste'});assert.deepEqual(imp.created,['T'+tag+'-NOVO']);
 F.importBom(s,0,rows,'ECN teste');assert.equal(s.products[0].draft.rev,imp.code);
 await assert.rejects(call('POST','/api/projects/'+project.id+'/revisions',{product:s.products[0].code,changes:[]}),/409/);
 const rel=await call('POST','/api/projects/'+project.id+'/revisions/release',{product:s.products[0].code});assert.equal(rel.code,imp.code);F.releaseRevision(s,0);
 r=await call('PUT','/api/projects/'+project.id+'/snapshot',{state:s});
 const st2=await call('GET','/api/projects/'+project.id+'/state');assert.equal(st2.definition.products[0].rev,imp.code);assert.deepEqual(Object.keys(st2.definition.products[0].bom).sort(),rows.map(x=>x.code).sort());assert.ok(st2.definition.items.some(i=>i.code==='T'+tag+'-NOVO'),'item novo deveria constar na definição');assert.ok(st2.state,'snapshot v3 deveria existir');
 // ordem nova com item sem saldo: banco rejeita (reserva) → o motor permite só com allowShortage e mostra pendência
 await assert.rejects(call('POST','/api/projects/'+project.id+'/orders',{client:'Sem saldo',product:s.products[0].code,qty:1,dueHours:10}),/409/);
 // telemetria: ingestão idempotente por (tag, at), latest e histórico
 const at=new Date().toISOString();let tr=await call('POST','/api/projects/'+project.id+'/telemetry',{samples:[{tag:'T'+tag+'-TIC',value:18.4,quality:192,at},{tag:'T'+tag+'-PI',value:1.1,at}]});assert.equal(tr.ingested,2);tr=await call('POST','/api/projects/'+project.id+'/telemetry',{samples:[{tag:'T'+tag+'-TIC',value:18.4,quality:192,at}]});assert.equal(tr.ingested,0);assert.equal(tr.skipped,1);const tl=await call('GET','/api/projects/'+project.id+'/telemetry');assert.equal(tl.latest.find(x=>x.tag==='T'+tag+'-TIC').value,18.4);const hist=await call('GET','/api/projects/'+project.id+'/telemetry/T'+tag+'-TIC/history');assert.equal(hist.length,1);
 // portfólio inclui o projeto
 const pf=await call('GET','/api/portfolio');assert.ok(pf.some(p=>p.project.id===project.id&&p.state));
 await call('PATCH','/api/projects/'+project.id,{status:'archived'});
 const list=await call('GET','/api/projects');assert.ok(!list.some(p=>p.id===project.id));
});
