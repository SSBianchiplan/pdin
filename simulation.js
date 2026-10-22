/* GPlanSiS|PDIN · Motor operacional (sem modo simulado).
 * Tempo = minutos reais desde a época (Date.now()/60000). Nada avança sozinho: operações começam e terminam por
 * apontamento; paradas e não conformidades são registradas; o planejamento (APS) calcula datas com capacidade finita.
 * Estado é JSON serializável (snapshot). Independente de DOM e de banco. */
(function(root){
'use strict';
const DAY=1440;
/* Saldos em ponto flutuante acumulam ruído (6.4-... = 6.3999999999999); movimentos arredondam a 6 casas. */
const q6=v=>Math.round(v*1e6)/1e6;
const STATUS=['backlog','planned','released','running','paused','done','cancelled'];
const STATUS_LABEL={backlog:'Carteira',planned:'Planejada',released:'Liberada',running:'Em produção',paused:'Pausada',done:'Concluída',cancelled:'Cancelada'};
const RULES={rank:'Manual · sequência do PCP',due:'EDD · menor prazo',short:'SPT · menor operação',cr:'CR · razão crítica',fifo:'FIFO · ordem de chegada'};
const REASONS=['Falha elétrica','Quebra mecânica','Falta de operador','Ajuste de ferramenta','Aguardando manutenção','Sensor em falha','Falta de material'];
const clone=x=>JSON.parse(JSON.stringify(x));
const err=m=>{throw Error(m);};
const now=()=>Date.now()/60000;

function create(def,at){
 if(!def||!Array.isArray(def.stages)||!def.stages.length)err('Definição de projeto inválida: estágios ausentes.');
 const t0=at||now();
 const settings=Object.assign({shifts:[[0,DAY]],calendar:false,quality:true,autoMrp:false,consumeAt:null,orderPrefix:'OP'},def.settings||{});
 const s={version:3,project:{id:def.id||null,code:def.code,name:def.name,description:def.description||'',industry:def.industry||'',complexity:def.complexity||'basic',kind:def.kind||'demo'},
  time:t0,created:t0,next:1,nextPurchase:1,nextMove:1,lastMrp:0,
  stages:def.stages.map(st=>({id:st.id,name:st.name,minutes:+st.minutes,setup:+(st.setup||0),capacity:Math.max(1,st.capacity|0),twin:st.twin||st.id,mtbf:+(st.mtbf||0),mttr:+(st.mttr||0),yield:st.yield==null?1:+st.yield,reworkTo:st.reworkTo||null,planned:0,downtime:0,busy:0,demand:0,good:0,scrap:0,breakdowns:0,down:null,resources:Array.from({length:Math.max(1,st.capacity|0)},(_,i)=>(st.resources&&st.resources[i])||st.id+'-'+String(i+1).padStart(2,'0')),telemetry:(st.telemetry||[]).map(t=>Object.assign({},t)),unitLabel:st.unitLabel||'un'})),
  stock:def.items.map(i=>({code:i.code,name:i.name,unit:i.unit,location:i.location||'ALM-01',onHand:+(i.onHand||0),reserved:0,min:+(i.min||0),leadTime:+(i.leadTime||24)})),
  products:[],orders:[],purchases:[],stops:{},events:[],movements:[],planned:0,telemetry:{},settings};
 s.products=def.products.map(p=>{const route=(p.route||s.stages.map(x=>x.id)).map(id=>{const i=stageIndex(s,id);if(i<0)err('Roteiro de '+p.code+' referencia estágio inexistente: '+id);return i;});const bomSrc=Array.isArray(p.bom)?p.bom:Object.entries(p.bom||{}).map(([item,qty])=>({item,qty}));const bom=bomSrc.map(b=>{const i=s.stock.findIndex(x=>x.code===b.item);if(i<0)err('BOM de '+p.code+' referencia item inexistente: '+b.item);return {item:i,qty:+b.qty};});if(!route.length)err('Roteiro vazio em '+p.code);return {code:p.code,name:p.name,rev:p.rev||'A',draft:p.draft?normalizeDraft(s,p.draft):null,route,bom,params:p.params||{},style:p.style||''};});
 (def.orders||[]).forEach(v=>seedOrder(s,v));
 s.events=[];event(s,'Projeto '+s.project.code+' carregado · '+s.orders.length+' ordens · '+s.stages.length+' setores');return s;}
function normalizeDraft(s,d){if(!d)return null;const bom=Array.isArray(d.bom)?d.bom:Object.entries(d.bom||{}).map(([item,qty])=>({item,qty}));return {rev:d.rev,note:d.note||'',bom:bom.map(b=>({item:typeof b.item==='number'?b.item:s.stock.findIndex(x=>x.code===b.item),qty:+b.qty})).filter(b=>b.item>=0)};}
/* Semeadura de validação: posiciona a ordem em um estágio com histórico de apontamentos retroativos. */
function seedOrder(s,v){const pi=s.products.findIndex(p=>p.code===v.product);if(pi<0)return null;
 const o=addOrder(s,{id:v.id,client:v.client,product:pi,qty:v.qty,due:v.dueHours,priority:v.priority,created:v.created,notes:v.notes});
 const target=v.status||'backlog';
 if(target==='cancelled'){cancel(s,o.id);return o;}
 const stepTarget=v.startStage?o.route.indexOf(stageIndex(s,v.startStage)):-1;
 const shop=target==='done'||target==='running'||target==='paused'||target==='released';
 if(!shop){if(target==='planned'){o.status='planned';o.plannedStart=s.time+60;}return o;}
 o.status='released';o.releasedAt=s.time-600;
 const upto=target==='done'?o.route.length:Math.max(0,stepTarget);
 let t=s.time-Math.max(60,upto*70+120);
 for(let k=0;k<upto;k++){const op=o.ops[k];const d=duration(s,o,op.stage);if(k===consumeStep(s,o)&&!o.consumed)pick(s,o.id,{at:t,by:'seed'});op.status='done';op.start=t;op.end=t+d;op.lane=k%s.stages[op.stage].capacity;op.good=o.qty;op.operator='seed';s.stages[op.stage].good+=o.qty;t=op.end+15;}
 if(target==='done'){o.status='done';o.completed=t;o.step=o.route.length;o.startedAt=o.ops[0].start;return o;}
 o.step=upto;
 const prog=Math.min(95,+(v.progress||0));
 if(target==='running'||target==='paused'){const op=o.ops[upto];if(op&&(upto<=consumeStep(s,o)||o.consumed)){const lane=laneFree(s,op.stage);if(lane!=null){const d=duration(s,o,op.stage);op.status=target==='paused'?'paused':'running';if(target==='paused')op.pausedAt=s.time;op.start=s.time-d*Math.max(5,prog)/100;op.lane=lane;op.operator='seed';o.status=target;o.startedAt=o.startedAt??op.start;}}}
 return o;}

/* ---- utilitários */
function stageIndex(s,id){return s.stages.findIndex(x=>x.id===id);}
function cur(o){return o.step<o.route.length?o.route[o.step]:-1;}
function curOp(o){return o.ops[o.step]||null;}
function consumeStep(s,o){if(!s.settings.consumeAt)return 0;const i=stageIndex(s,s.settings.consumeAt);const st=o.route.indexOf(i);return st<0?0:st;}
function event(s,text,kind,order){s.events.unshift({time:s.time,text,kind:kind||'info',order:order||null});if(s.events.length>300)s.events.length=300;}
function movement(s,m){s.movements.unshift(Object.assign({id:s.nextMove++,time:s.time},m));if(s.movements.length>500)s.movements.length=500;}
function blocked(s,st){return !!(s.stops[st.id]||st.down);}
function minuteOfDay(t){const d=new Date(t*60000);return d.getHours()*60+d.getMinutes();}
function inShift(s,t){if(!s.settings.calendar)return true;const m=minuteOfDay(t==null?s.time:t);return s.settings.shifts.some(([a,b])=>m>=a&&m<b);}
function available(s,i){return s.stock[i].onHand-s.stock[i].reserved;}
function duration(s,o,i){const st=s.stages[i];return st.setup+st.minutes*(1+(o.qty-1)*.35);}
function remaining(s,o){let r=0;for(let k=o.step;k<o.ops.length;k++){const op=o.ops[k];const d=duration(s,o,op.stage);r+=op.status==='running'?Math.max(0,d-(s.time-op.start)):d;}return r;}
function runningAt(s,i){return s.orders.flatMap(o=>o.ops.filter(op=>op.stage===i&&op.status==='running').map(op=>({o,op})));}
function laneFree(s,i){const used=new Set(runningAt(s,i).map(x=>x.op.lane));for(let l=0;l<s.stages[i].capacity;l++)if(!used.has(l))return l;return null;}
function queue(s,i){return s.orders.filter(o=>(o.status==='released'||o.status==='running')&&cur(o)===i&&curOp(o).status!=='running').sort((a,b)=>(a.priority==='Urgente'?-1:0)-(b.priority==='Urgente'?-1:0)||a.rank-b.rank);}
function progress(s,o){const op=curOp(o);if(!op||(op.status!=='running'&&op.status!=='paused'))return 0;const el=op.status==='paused'?op.pausedAt-op.start:s.time-op.start;return Math.min(100,el/duration(s,o,op.stage)*100);}
function find(s,id){const o=s.orders.find(o=>o.id===id);if(!o)err('Ordem '+id+' não encontrada');return o;}

/* ---- ordens */
function addOrder(s,v){
 const p=s.products[v.product];const qty=Number(v.qty),due=Number(v.due);
 if(!p||!Number.isInteger(qty)||qty<1||qty>50||!v.client||!String(v.client).trim()||!Number.isFinite(due)||due<1||due>2000)err('Preencha cliente, quantidade de 1 a 50 e prazo de 1 a 2000 horas.');
 const need={};p.bom.forEach(b=>{need[b.item]=(need[b.item]||0)+b.qty*qty;});
 if(!v.allowShortage)Object.entries(need).forEach(([i,n])=>{if(available(s,+i)<n)err('Saldo insuficiente: '+s.stock[i].name+' (disponível '+available(s,+i)+' '+s.stock[i].unit+', necessário '+n+'). Reponha no almoxarifado.');});
 let id=v.id;if(id){const n=parseInt(String(id).split('-').pop(),10);if(Number.isFinite(n)&&n>=s.next)s.next=n+1;}else id=s.settings.orderPrefix+'-'+String(s.next++).padStart(4,'0');
 if(s.orders.some(o=>o.id===id))err('Ordem '+id+' já existe.');
 const o={id,client:String(v.client).trim().slice(0,60),product:v.product,productCode:p.code,revision:p.rev,kit:p.bom.map(b=>({item:b.item,qty:b.qty*qty})),qty,due:s.time+due*60,route:p.route.slice(),ops:p.route.map((stage,k)=>newOp(stage,k+1)),step:0,status:'backlog',priority:v.priority==='Urgente'?'Urgente':'Normal',consumed:false,picking:{status:'pending',at:null,by:null},rank:s.orders.length,created:v.created??s.time,plannedStart:null,plannedEnd:null,releasedAt:null,startedAt:null,completed:null,rework:0,notes:v.notes||''};
 o.kit.forEach(k=>s.stock[k.item].reserved+=k.qty);s.orders.push(o);event(s,o.id+' criada · '+p.code+' rev. '+p.rev+' · kit reservado','info',o.id);return o;}
function newOp(stage,seq,rework){return {seq,stage,status:'pending',start:null,end:null,lane:null,notBefore:null,plannedStart:null,plannedEnd:null,good:0,scrap:0,operator:null,rework:!!rework};}
function setStatus(s,id,status){const o=find(s,id);if(!STATUS.includes(status))err('Status inválido');if(o.status==='done'||o.status==='cancelled')err('Ordem encerrada não pode mudar de status.');if(o.status===status)return o;
 if(status==='cancelled')return cancel(s,id);
 if(status==='done')err('Conclua a última operação para encerrar a ordem.');
 if(status==='running'){if(o.status==='paused')return resumeOp(s,id),o;return startOp(s,id),o;}
 if(status==='paused'){if(o.status!=='running')err('Só ordens em produção podem ser pausadas.');return pauseOp(s,id),o;}
 if((status==='backlog'||status==='planned')&&o.ops.some(op=>op.status!=='pending'))err('Ordem com apontamentos não volta à carteira.');
 if(status==='released'&&o.status==='running')err('Ordem em produção: pause a operação primeiro.');
 if(status==='released'&&o.status==='paused')err('Ordem pausada: retome a operação ou registre NC.');
 const prev=o.status;o.status=status;if(status==='released'&&!o.releasedAt)o.releasedAt=s.time;if(status==='planned'&&!o.plannedStart)o.plannedStart=s.time;if(status==='backlog')o.releasedAt=null;
 event(s,o.id+' · '+STATUS_LABEL[prev]+' → '+STATUS_LABEL[status],'info',o.id);return o;}
function updateOrder(s,id,v){const o=find(s,id);if(o.status==='done'||o.status==='cancelled')err('Ordem encerrada.');
 if(v.due!=null){const d=Number(v.due);if(!Number.isFinite(d))err('Prazo inválido');o.due=d;}
 if(v.plannedStart!==undefined){o.plannedStart=v.plannedStart==null||v.plannedStart===''?null:Number(v.plannedStart);if(o.status==='backlog'&&o.plannedStart)o.status='planned';}
 if(v.priority)o.priority=v.priority==='Urgente'?'Urgente':'Normal';
 if(v.notes!==undefined)o.notes=String(v.notes).slice(0,500);
 if(v.client)o.client=String(v.client).trim().slice(0,60);
 event(s,o.id+' · planejamento atualizado'+(v.due!=null?' · prazo '+fmt(o.due):'')+(o.plannedStart?' · início '+fmt(o.plannedStart):''),'info',o.id);return o;}
function updateOp(s,id,seq,v){const o=find(s,id);const op=o.ops[seq-1];if(!op)err('Operação inexistente');if(op.status==='done')err('Operação concluída é imutável.');
 if(v.lane!==undefined){const cap=s.stages[op.stage].capacity;op.lane=v.lane==null||v.lane===''?null:Math.max(0,Math.min(cap-1,Number(v.lane)));}
 if(v.notBefore!==undefined)op.notBefore=v.notBefore==null||v.notBefore===''?null:Number(v.notBefore);
 if(v.operator!==undefined)op.operator=v.operator||null;
 return op;}
function openList(s){return s.orders.filter(x=>x.status!=='done'&&x.status!=='cancelled').sort((a,b)=>a.rank-b.rank);}
function setRank(s,id,newRank){const o=find(s,id);const list=openList(s);const idx=list.indexOf(o);if(idx<0)return;list.splice(idx,1);list.splice(Math.max(0,Math.min(list.length,newRank)),0,o);list.forEach((x,i)=>x.rank=i);event(s,o.id+' · sequência '+(list.indexOf(o)+1),'info',o.id);}
function moveRank(s,id,delta){const o=find(s,id);setRank(s,id,Math.max(0,openList(s).indexOf(o)+delta));}
function cancel(s,id){const o=find(s,id);if(o.status==='done'||o.status==='cancelled')err('Ordem não pode ser cancelada.');if(o.ops.some(op=>op.status==='running'))err('Conclua ou pause a operação em andamento antes de cancelar.');if(!o.consumed)o.kit.forEach(k=>{const x=s.stock[k.item];x.reserved=q6(x.reserved-k.qty);});o.status='cancelled';o.completed=s.time;event(s,o.id+' cancelada'+(o.consumed?' · materiais já consumidos':' · reservas liberadas'),'warn',o.id);return o;}

/* ---- almoxarifado: picking entrega o kit à produção e consome o estoque */
function consume(s,o){if(o.consumed)return;o.kit.forEach(k=>{const x=s.stock[k.item];x.onHand=q6(x.onHand-k.qty);x.reserved=q6(x.reserved-k.qty);movement(s,{item:k.item,qty:-k.qty,type:'Consumo',order:o.id});});o.consumed=true;}
function pick(s,id,opt){const o=find(s,id);if(o.picking.status==='picked')return o;if(o.status==='cancelled'||o.status==='done')err('Ordem encerrada.');o.kit.forEach(k=>{if(s.stock[k.item].onHand<k.qty)err('Saldo físico insuficiente para separar '+s.stock[k.item].name+' ('+s.stock[k.item].onHand+' de '+k.qty+' '+s.stock[k.item].unit+')');});o.picking={status:'picked',at:(opt&&opt.at)||s.time,by:(opt&&opt.by)||'almoxarifado'};consume(s,o);event(s,o.id+' · picking confirmado · kit entregue à produção','ok',o.id);return o;}
function pendencies(s){const out=[];s.orders.filter(o=>!o.consumed&&o.status!=='cancelled'&&o.status!=='done').forEach(o=>{o.kit.forEach(k=>{const x=s.stock[k.item];if(x.onHand<k.qty){const opens=s.purchases.filter(p=>p.item===k.item&&p.status==='open');out.push({order:o.id,item:k.item,need:k.qty,onHand:x.onHand,missing:k.qty-x.onHand,open:opens.reduce((n,p)=>n+p.qty,0),eta:opens.map(p=>p.arrive).sort((a,b)=>a-b)[0]||null});}});});return out;}

/* ---- apontamento */
function startOp(s,id,v){const o=find(s,id);v=v||{};if(!['released','running','paused','planned','backlog'].includes(o.status))err('Ordem '+STATUS_LABEL[o.status]+' não pode ser apontada.');const op=curOp(o);if(!op)err('Ordem sem operações pendentes.');if(op.status==='running')err('Operação já em andamento.');if(op.status==='paused')return resumeOp(s,id);const st=s.stages[op.stage];if(blocked(s,st))err(st.name+' está parado.');
 if(o.step>consumeStep(s,o)&&!o.consumed)err('Kit ainda não separado pelo almoxarifado: confirme o picking antes de avançar.');
 const running=runningAt(s,op.stage);if(running.length>=st.capacity)err(st.name+' sem posição livre ('+st.capacity+' ocupadas).');
 let lane=v.lane!=null&&v.lane!==''?Number(v.lane):(op.lane!=null?op.lane:laneFree(s,op.stage));if(lane==null||running.some(x=>x.op.lane===lane))lane=laneFree(s,op.stage);
 o.releasedAt=o.releasedAt||s.time;
 op.status='running';op.start=s.time;op.lane=lane;op.operator=v.operator||op.operator||'operador';o.status='running';o.startedAt=o.startedAt??s.time;
 event(s,o.id+' · '+st.name+' iniciada · '+st.resources[lane],'ok',o.id);return op;}
function pauseOp(s,id,reason){const o=find(s,id);const op=curOp(o);if(!op||op.status!=='running')err('Nenhuma operação em andamento.');op.status='paused';op.pausedAt=s.time;o.status='paused';event(s,o.id+' · '+s.stages[op.stage].name+' pausada'+(reason?': '+reason:''),'warn',o.id);return op;}
function resumeOp(s,id){const o=find(s,id);const op=curOp(o);if(!op||op.status!=='paused')err('Nenhuma operação pausada.');const st=s.stages[op.stage];if(blocked(s,st))err(st.name+' está parado.');if(runningAt(s,op.stage).length>=st.capacity)err(st.name+' sem posição livre.');if(op.pausedAt){op.start+=s.time-op.pausedAt;delete op.pausedAt;}op.status='running';o.status='running';event(s,o.id+' · '+st.name+' retomada','ok',o.id);return op;}
function finishOp(s,id,v){const o=find(s,id);v=v||{};const op=curOp(o);if(!op)err('Ordem sem operações pendentes.');if(op.status!=='running'&&op.status!=='paused')err('Inicie a operação antes de concluir.');const st=s.stages[op.stage];
 if(o.step===consumeStep(s,o)&&!o.consumed)err('Confirme o picking do kit no almoxarifado antes de concluir '+st.name+'.');
 const good=v.good!=null?Number(v.good):o.qty,scrap=Math.max(0,Number(v.scrap)||0);
 if(op.status==='paused'&&op.pausedAt){op.start+=s.time-op.pausedAt;delete op.pausedAt;}
 op.status='done';op.end=s.time;op.good=good;op.scrap=scrap;st.good+=good;st.scrap+=scrap;
 if(scrap>0&&v.rework!==false)return rework(s,o,op,'refugo apontado');
 o.step++;
 if(o.step>=o.ops.length){o.status='done';o.completed=s.time;event(s,o.id+' expedida · '+o.qty+' un · '+(o.completed<=o.due?'no prazo':'atrasada'),o.completed<=o.due?'ok':'warn',o.id);}
 else{o.status='released';event(s,o.id+' · '+st.name+' concluída → '+s.stages[cur(o)].name,'info',o.id);}
 return op;}
/* Retrabalho: reinsere as operações do estágio-alvo até o atual como novas operações após a atual. */
function rework(s,o,op,reason){const st=s.stages[op.stage];o.rework++;const target=st.reworkTo?stageIndex(s,st.reworkTo):op.stage;let back=o.route.lastIndexOf(target,o.step);if(back<0)back=o.step;const loop=o.ops.slice(back,o.step+1).map(x=>newOp(x.stage,0,true));o.ops.splice(o.step+1,0,...loop);o.ops.forEach((x,i)=>x.seq=i+1);o.route=o.ops.map(x=>x.stage);o.step=o.step+1;o.status='released';
 event(s,o.id+' · NC em '+st.name+(reason?' ('+reason+')':'')+' → retrabalho a partir de '+s.stages[o.route[o.step]].name+' ('+loop.length+' op.)','warn',o.id);return op;}
function reject(s,id,reason){const o=find(s,id);const op=curOp(o);if(!op||(op.status!=='running'&&op.status!=='paused'))err('Só operações em andamento podem receber NC.');const st=s.stages[op.stage];if(op.pausedAt){op.start+=s.time-op.pausedAt;delete op.pausedAt;}op.status='done';op.end=s.time;op.scrap=o.qty;st.scrap+=o.qty;return rework(s,o,op,reason||'inspeção');}

/* ---- setores: paradas programadas e falhas registradas */
function stop(s,id,reason){const st=s.stages[stageIndex(s,id)];if(!st)return;s.stops[id]=!s.stops[id];if(s.stops[id])st.stopSince=s.time;else delete st.stopSince;event(s,st.name+(s.stops[id]?' · parada programada'+(reason?': '+reason:''):' · operação retomada'),s.stops[id]?'warn':'ok');}
function breakdown(s,id,reason,minutes){const st=s.stages[stageIndex(s,id)];if(!st)err('Setor inexistente');if(st.down)err('Setor já está em falha');const dur=Math.max(5,Number(minutes)||st.mttr||30);st.down={since:s.time,until:s.time+dur,reason:reason||REASONS[0]};st.breakdowns++;event(s,st.name+' · falha registrada: '+st.down.reason+' · previsão '+dur+' min','alarm');return st.down;}
function repair(s,id){const st=s.stages[stageIndex(s,id)];if(!st||!st.down)return;event(s,st.name+' · reparo concluído ('+Math.round(s.time-st.down.since)+' min)','ok');st.down=null;}

/* ---- compras / MRP */
function receive(s,item,qty,ref){const x=s.stock[item];if(!x||!Number.isFinite(qty)||qty<=0)err('Quantidade inválida');x.onHand=q6(x.onHand+qty);movement(s,{item,qty,type:'Recebimento',ref:ref||'Manual'});event(s,'Recebido '+qty+' '+x.unit+' · '+x.name+(ref?' · '+ref:''));}
function purchase(s,item,qty){const x=s.stock[item];if(!x||!Number.isFinite(qty)||qty<=0)err('Quantidade inválida');const pc={id:'PC-'+String(s.nextPurchase++).padStart(4,'0'),item,qty,created:s.time,arrive:s.time+x.leadTime*60,status:'open'};s.purchases.unshift(pc);event(s,pc.id+' · compra de '+qty+' '+x.unit+' de '+x.name+' · chegada prevista '+fmt(pc.arrive));return pc;}
function receivePurchase(s,pcId){const pc=s.purchases.find(p=>p.id===pcId);if(!pc||pc.status!=='open')err('Pedido inexistente ou já recebido');pc.status='received';pc.received=s.time;receive(s,pc.item,pc.qty,pc.id);return pc;}
function suggestions(s){const pend=pendencies(s);return s.stock.map((x,i)=>{const avail=x.onHand-x.reserved,open=s.purchases.filter(p=>p.item===i&&p.status==='open').reduce((n,p)=>n+p.qty,0);const shortage=pend.filter(p=>p.item===i).reduce((n,p)=>n+p.missing,0);const covered=avail+open>=x.min&&shortage<=open;return {item:i,available:avail,open,shortage,covered,shortfall:covered?0:Math.ceil(Math.max(x.min*2-avail-open,shortage-open,1))};}).filter(r=>!r.covered);}
function mrp(s){return suggestions(s).map(r=>purchase(s,r.item,r.shortfall));}

/* ---- relógio: só atualiza tempo, contadores de OEE, chegadas automáticas e MRP */
function tick(s,at){const t=at||now();const dt=Math.max(0,t-s.time);const working=inShift(s,t);
 if(working&&dt>0)s.stages.forEach((st,i)=>{st.planned+=dt;if(blocked(s,st))st.downtime+=dt;else if(queue(s,i).length>0||runningAt(s,i).length>0)st.demand+=dt;st.busy+=dt*runningAt(s,i).length;});
 s.time=t;
 s.purchases.forEach(pc=>{if(pc.status==='open'&&pc.autoReceive&&s.time>=pc.arrive)receivePurchase(s,pc.id);});
 if(s.settings.autoMrp&&s.time-s.lastMrp>=60){s.lastMrp=s.time;mrp(s);}}

/* ---- APS: programação para frente com capacidade finita, pinos de recurso e restrições notBefore */
function schedule(s,rule,apply){rule=rule||'rank';const lanes=s.stages.map(st=>Array(st.capacity).fill(s.stops[st.id]?s.time+DAY:st.down?Math.max(s.time,st.down.until):s.time));
 const key={due:o=>o.due,short:o=>duration(s,o,cur(o)),cr:o=>(o.due-s.time)/Math.max(1,remaining(s,o)),fifo:o=>o.created,rank:o=>o.rank}[rule]||(o=>o.rank);
 const orders=s.orders.filter(o=>['backlog','planned','released','running','paused'].includes(o.status)&&cur(o)>=0).slice().sort((a,b)=>(a.priority==='Urgente'?-1:0)-(b.priority==='Urgente'?-1:0)||key(a)-key(b)||a.rank-b.rank);
 const jobs=[],finish={};
 orders.forEach(o=>{const op=curOp(o);if(op&&(op.status==='running'||op.status==='paused')){const l=op.lane??0;lanes[op.stage][l]=Math.max(lanes[op.stage][l],Math.max(s.time,op.start+duration(s,o,op.stage)));}});
 orders.forEach((o,rank)=>{if(apply&&rule!=='rank')o.rank=rank;let ready=Math.max(s.time,o.plannedStart||s.time);for(let k=o.step;k<o.ops.length;k++){const op=o.ops[k],i=op.stage,d=duration(s,o,i);let lane,start,end;
  if(op.status==='running'||op.status==='paused'){lane=op.lane??0;start=op.start;end=Math.max(s.time,op.start+d);}
  else{const earliest=Math.max(ready,op.notBefore||0);if(op.lane!=null)lane=op.lane;else{lane=0;for(let l=1;l<lanes[i].length;l++)if(lanes[i][l]<lanes[i][lane])lane=l;}start=Math.max(earliest,lanes[i][lane]);end=start+d;lanes[i][lane]=end;}
  jobs.push({id:o.id,seq:op.seq,stage:i,lane,start,end,client:o.client,status:op.status,pinned:op.lane!=null||!!op.notBefore,rework:!!op.rework});if(apply){op.plannedStart=start;op.plannedEnd=end;}ready=end;}finish[o.id]=ready;if(apply)o.plannedEnd=ready;});
 jobs.forEach(j=>{j.late=finish[j.id]>s.orders.find(o=>o.id===j.id).due;});
 if(apply){s.planned++;}
 const ends=Object.values(finish).filter(Number.isFinite);return {rule,jobs,finish,late:orders.filter(o=>finish[o.id]>o.due).length,orders:orders.length,makespan:ends.length?Math.max(...ends)-s.time:0,horizon:ends.length?Math.max(...ends):s.time+480};}
/* Move uma operação no Gantt: fixa início mínimo (e opcionalmente o recurso) e recompõe todo o plano para frente. */
function moveOp(s,id,seq,newStart,lane){const o=find(s,id);const op=o.ops[seq-1];if(!op||op.status!=='pending')err('Só operações pendentes podem ser movidas.');op.notBefore=Math.max(s.time,Number(newStart));if(lane!=null&&lane!=='')op.lane=Math.max(0,Math.min(s.stages[op.stage].capacity-1,Number(lane)));if(seq-1===o.step){o.plannedStart=op.notBefore;if(o.status==='backlog')o.status='planned';}event(s,o.id+' · '+s.stages[op.stage].name+' reprogramada para '+fmt(op.notBefore)+(lane!=null&&lane!==''?' · '+s.stages[op.stage].resources[op.lane]:''),'info',o.id);return schedule(s,'rank',true);}
function clearPins(s,id){const o=find(s,id);o.ops.forEach(op=>{if(op.status==='pending'){op.notBefore=null;op.lane=null;}});event(s,o.id+' · restrições de programação removidas','info',o.id);return o;}
function shiftMinutes(s){if(!s.settings.calendar)return DAY;return s.settings.shifts.reduce((n,[a,b])=>n+(b-a),0);}
/* Perfil de carga: minutos planejados por setor e por dia (a partir da meia-noite local de hoje). */
function loadProfile(s,plan,days){const d0=new Date(s.time*60000);d0.setHours(0,0,0,0);const from=d0.getTime()/60000;const n=days||7;const rows=s.stages.map(st=>({stage:st.id,name:st.name,capacityPerDay:st.capacity*shiftMinutes(s),days:Array(n).fill(0)}));plan.jobs.forEach(j=>{let a=Math.max(j.start,from),b=j.end;while(a<b){const d=Math.floor((a-from)/DAY);if(d>=n)break;const seg=Math.min(b,from+(d+1)*DAY)-a;rows[j.stage].days[d]+=seg;a+=seg;}});return {from,days:n,rows};}

/* ---- telemetria de campo (PLC / IHM / IoT): somente leitura; valores por tag com qualidade OPC UA */
function ingestTelemetry(s,samples){if(!s.telemetry)s.telemetry={};let n=0;(samples||[]).forEach(x=>{if(!x||!x.tag||!Number.isFinite(Number(x.value)))return;const at=x.at?(typeof x.at==='number'?x.at:new Date(x.at).getTime()/60000):s.time;const cur=s.telemetry[x.tag];if(cur&&cur.at>at)return;s.telemetry[x.tag]={value:Number(x.value),quality:x.quality==null?192:Number(x.quality),at};n++;});return n;}
function tagsOf(s,stageIdx,resource){const st=s.stages[stageIdx];return (st.telemetry||[]).filter(t=>!resource||!t.resource||t.resource===resource);}
/* Leitura contextualizada: para cada operação em andamento, os sinais do recurso ocupado e o setpoint da receita. */
function processReadings(s){const out=[];s.stages.forEach((st,i)=>{(st.telemetry||[]).forEach(t=>{const r=s.telemetry[t.tag];const run=runningAt(s,i).find(x=>st.resources[x.op.lane]===t.resource);const p=run?s.products[run.o.product]:null;const sp=p&&p.params&&t.setpoint?p.params[t.setpoint]:null;const lo=sp!=null&&t.tolerance!=null?sp-t.tolerance:t.lo;const hi=sp!=null&&t.tolerance!=null?sp+t.tolerance:t.hi;const stale=r&&s.time-r.at>(t.staleMinutes||15);const bad=r&&r.quality!==192;const dev=r&&!stale&&!bad&&((lo!=null&&r.value<lo)||(hi!=null&&r.value>hi));out.push({stage:st.id,stageName:st.name,resource:t.resource||null,tag:t.tag,kind:t.kind||'analog',unit:t.unit||'',description:t.description||'',value:r?r.value:null,quality:r?r.quality:null,at:r?r.at:null,order:run?run.o.id:null,product:p?p.code:null,setpoint:sp,lo,hi,state:!r?'nodata':bad?'bad':stale?'stale':dev?'deviation':'ok'});});});return out;}
/* ---- qualidade / manutenção / indicadores */
function oee(st){const up=st.planned-st.downtime;const a=st.planned>0?up/st.planned:1;const d=st.demand||0;const p=d>0?Math.min(1,st.busy/(d*st.capacity)):1;const q=(st.good+st.scrap)>0?st.good/(st.good+st.scrap):1;return {a,p,q,oee:a*p*q};}
function alarms(s){const out=[];s.stages.forEach((st,i)=>{if(st.down)out.push({sev:'alarm',kind:'falha',stage:st.id,text:st.name+' em falha: '+st.down.reason+' · previsão '+fmt(st.down.until)});if(s.stops[st.id])out.push({sev:'warn',kind:'parada',stage:st.id,text:st.name+' em parada programada'});const q=queue(s,i).length;if(q>st.capacity*2)out.push({sev:'warn',kind:'fila',stage:st.id,text:st.name+' com fila de '+q+' ordens para '+st.capacity+' posições'});});
 s.orders.filter(o=>o.status!=='done'&&o.status!=='cancelled'&&o.due<s.time).forEach(o=>out.push({sev:'alarm',kind:'atraso',order:o.id,text:o.id+' vencida há '+Math.round((s.time-o.due)/60)+' h · '+o.client}));
 s.orders.filter(o=>o.status==='running').forEach(o=>{const op=curOp(o);if(op&&op.status==='running'&&s.time-op.start>duration(s,o,op.stage)*1.25)out.push({sev:'warn',kind:'ciclo',order:o.id,text:o.id+' · '+s.stages[op.stage].name+' acima do tempo padrão ('+Math.round(s.time-op.start)+' min)'});});
 pendencies(s).forEach(p=>out.push({sev:'warn',kind:'material',order:p.order,item:p.item,text:p.order+' · falta '+p.missing+' '+s.stock[p.item].unit+' de '+s.stock[p.item].name+(p.eta?' · chegada '+fmt(p.eta):' · sem compra')}));
 s.stock.forEach((x,i)=>{if(x.onHand-x.reserved<x.min)out.push({sev:'warn',kind:'estoque',item:i,text:x.name+' abaixo do mínimo ('+(x.onHand-x.reserved)+' '+x.unit+')'});});
 processReadings(s).forEach(r=>{if(r.state==='deviation')out.push({sev:r.order?'alarm':'warn',kind:'processo',stage:r.stage,order:r.order,tag:r.tag,text:(r.resource||r.stageName)+' · '+r.tag+' = '+r.value+' '+r.unit+(r.setpoint!=null?' · setpoint '+r.setpoint+' ±'+(r.hi-r.setpoint):' · faixa '+(r.lo??'—')+'…'+(r.hi??'—'))+(r.order?' · '+r.order+' ('+r.product+')':'')});else if(r.state==='bad'&&r.order)out.push({sev:'warn',kind:'sinal',stage:r.stage,order:r.order,tag:r.tag,text:r.tag+' com qualidade ruim ('+r.quality+') em '+(r.resource||r.stageName)});});
 return out.sort((a,b)=>(a.sev==='alarm'?0:1)-(b.sev==='alarm'?0:1));}
function kpis(s){const open=s.orders.filter(o=>!['done','cancelled'].includes(o.status)),done=s.orders.filter(o=>o.status==='done');const working=inShift(s);const running=s.stages.reduce((n,st,i)=>n+runningAt(s,i).length,0),cap=s.stages.reduce((n,st)=>n+st.capacity,0);
 const onTime=done.filter(o=>o.completed<=o.due).length;const lead=done.length?done.reduce((n,o)=>n+(o.completed-o.created),0)/done.length/60:0;const first=s.orders.length?Math.min(...s.orders.map(o=>o.created)):s.time;const days=Math.max(1/24,(s.time-first)/DAY);
 const st=s.stages.filter(x=>x.planned>0).map(oee);const avg=k=>st.length?st.reduce((n,x)=>n+x[k],0)/st.length:0;
 return {open:open.length,backlog:s.orders.filter(o=>o.status==='backlog'||o.status==='planned').length,released:s.orders.filter(o=>o.status==='released').length,paused:s.orders.filter(o=>o.status==='paused').length,done:done.length,running,cap,working,load:cap?Math.round(running/cap*100):0,late:open.filter(o=>o.due<s.time).length,short:s.stock.filter(x=>x.onHand-x.reserved<x.min).length,pendencies:pendencies(s).length,shipped:done.reduce((n,o)=>n+o.qty,0),otif:done.length?Math.round(onTime/done.length*100):null,leadTime:lead,throughput:done.reduce((n,o)=>n+o.qty,0)/days,oee:avg('oee'),availability:avg('a'),performance:avg('p'),quality:avg('q'),down:s.stages.filter(x=>x.down).length,stopped:Object.values(s.stops).filter(Boolean).length,rework:s.orders.reduce((n,o)=>n+o.rework,0),alarms:alarms(s).length,pickingPending:s.orders.filter(o=>['released','running','paused'].includes(o.status)&&o.picking.status!=='picked').length};}
function fmt(v,withDate){if(v==null||!Number.isFinite(v))return '—';const d=new Date(v*60000);const hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');if(withDate===false)return hm;return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+' '+hm;}
function fmtLong(v){if(v==null||!Number.isFinite(v))return '—';return new Date(v*60000).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function toLocalInput(v){if(v==null||!Number.isFinite(v))return '';const d=new Date(v*60000);const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());}
function fromLocalInput(str){if(!str)return null;const t=new Date(str).getTime();return Number.isFinite(t)?t/60000:null;}

/* ---- engenharia: revisões controladas e importação de BOM */
function proposeRevision(s,pi,changes,note){const p=s.products[pi];if(!p)err('Produto inexistente');if(p.draft)err('Já existe revisão em análise para '+p.code);const bom=clone(p.bom);(changes||[]).forEach(c=>{const b=bom.find(x=>x.item===c.item);if(b){b.qty=Math.max(0,+(b.qty+(c.delta||0)).toFixed(3));}else if(c.delta>0)bom.push({item:c.item,qty:+c.delta});});p.draft={rev:String.fromCharCode(p.rev.charCodeAt(0)+1),bom:bom.filter(b=>b.qty>0),note:note||(changes||[]).map(c=>(c.delta>0?'+':'')+c.delta+' '+s.stock[c.item].unit+' '+s.stock[c.item].name).join(', ')};event(s,'PLM · '+p.code+' revisão '+p.draft.rev+' proposta: '+(p.draft.note||'sem alteração de BOM'));return p.draft;}
function releaseRevision(s,pi){const p=s.products[pi];if(!p||!p.draft)err('Nenhuma revisão em análise');p.rev=p.draft.rev;p.bom=p.draft.bom;p.draft=null;event(s,'PLM · '+p.code+' revisão '+p.rev+' liberada · válida para novas ordens','ok');return p;}
function discardRevision(s,pi){const p=s.products[pi];if(!p||!p.draft)err('Nenhuma revisão em análise');const r=p.draft.rev;p.draft=null;event(s,'PLM · '+p.code+' proposta '+r+' descartada','warn');return p;}
function parseBom(text){const rows=[];String(text||'').split(/\r?\n/).forEach((line,n)=>{const l=line.trim();if(!l||/^(c[oó]digo|item|sku|code)\b/i.test(l))return;const c=l.split(/[;\t]|,(?=\S)/).map(x=>x.trim());if(c.length<2)err('Linha '+(n+1)+': use código;descrição;unidade;quantidade');const qty=Number(String(c.length>=4?c[3]:c[c.length-1]).replace(',','.'));if(!(qty>0))err('Linha '+(n+1)+': quantidade inválida');const unit=(c.length>=4?c[2]:'un').toLowerCase();rows.push({code:c[0],name:c.length>=3?c[1]:c[0],unit:['un','m','kg','l'].includes(unit)?unit:'un',qty});});if(!rows.length)err('Nenhuma linha válida na BOM');return rows;}
/* Importa a lista de engenharia como nova revisão em análise; cria itens desconhecidos no catálogo com saldo zero. */
function importBom(s,pi,rows,note){const p=s.products[pi];if(!p)err('Produto inexistente');if(p.draft)err('Já existe revisão em análise para '+p.code);const created=[];const merged={};rows.forEach(r=>{let i=s.stock.findIndex(x=>x.code.toLowerCase()===r.code.toLowerCase());if(i<0){s.stock.push({code:r.code,name:r.name,unit:r.unit,location:'ALM-01',onHand:0,reserved:0,min:0,leadTime:48,imported:true});i=s.stock.length-1;created.push(r.code);}merged[i]=(merged[i]||0)+r.qty;});
 p.draft={rev:String.fromCharCode(p.rev.charCodeAt(0)+1),bom:Object.entries(merged).map(([i,q])=>({item:+i,qty:q})),note:note||('BOM importada da engenharia · '+rows.length+' linhas'+(created.length?' · '+created.length+' itens novos':'')),imported:true,created};event(s,'PLM · '+p.code+' revisão '+p.draft.rev+' importada · '+rows.length+' itens'+(created.length?' · novos: '+created.join(', '):''));return p.draft;}

const api={DAY,STATUS,STATUS_LABEL,RULES,REASONS,ingestTelemetry,processReadings,tagsOf,create,seedOrder,addOrder,setStatus,updateOrder,updateOp,setRank,moveRank,cancel,pick,pendencies,startOp,pauseOp,resumeOp,finishOp,reject,stop,breakdown,repair,receive,purchase,receivePurchase,mrp,suggestions,tick,schedule,moveOp,clearPins,loadProfile,shiftMinutes,oee,alarms,kpis,event,queue,runningAt,laneFree,duration,remaining,progress,inShift,stageIndex,cur,curOp,consumeStep,proposeRevision,releaseRevision,discardRevision,parseBom,importBom,fmt,fmtLong,toLocalInput,fromLocalInput,now};
if(typeof module!=='undefined')module.exports=api;else root.FactorySim=api;
})(typeof window!=='undefined'?window:globalThis);
