/* GPlanSiS|PDIN · Templates de projetos demo.
 * Fonte única compartilhada por navegador (modo local), Node (testes) e gerador do seed SQL.
 * Nada aqui é dado real de cliente: nomes de empresas são referências fictícias de demonstração.
 * Campos por estágio: id, name, minutes (min base por unidade), setup, capacity (posições paralelas),
 * twin (setor do gêmeo 3D usado para visualização), mtbf/mttr (min), yield (0..1) e reworkTo. */
(function(root){
'use strict';
const T={};
const shifts2=[[360,870],[870,1380]];   // 06:00–14:30 · 14:30–23:00
const shifts3=[[0,480],[480,960],[960,1440]];
/* Mistura de situações para validação operacional: carteira, planejada, liberada (picking pendente), em produção, pausada e concluída. */
const S=['running','released','backlog','running','planned','done','paused','running','released','backlog','running','done'];

T['PAINEIS-ADV']={
 code:'PAINEIS-ADV',name:'Painéis elétricos · Planta Aurora (fictícia)',industry:'Painéis elétricos de baixa tensão',
 description:'Cenário avançado da fábrica de painéis: 12 setores com capacidade finita, dois turnos, setup por operação, quebras estocásticas, inspeção com retrabalho, MRP automático e OEE por setor.',
 kind:'demo',complexity:'advanced',
 settings:{orderPrefix:'OP',shifts:shifts2,calendar:true,quality:true,autoMrp:true,consumeAt:'almox',twinGeometry:'PLANTA-DEMO'},
 stages:[
  {id:'receb',name:'Recebimento',minutes:12,setup:5,capacity:2,twin:'receb'},
  {id:'almox',name:'Almoxarifado',minutes:18,setup:0,capacity:2,twin:'almox'},
  {id:'corte',name:'Corte',minutes:30,setup:10,capacity:2,twin:'corte',mtbf:2400,mttr:45},
  {id:'barr',name:'Barramentos',minutes:40,setup:15,capacity:2,twin:'barr',mtbf:1800,mttr:60},
  {id:'mec',name:'Montagem mecânica',minutes:65,setup:10,capacity:3,twin:'mec'},
  {id:'eletrica',name:'Montagem elétrica',minutes:95,setup:15,capacity:4,twin:'eletrica'},
  {id:'ident',name:'Identificação',minutes:22,setup:5,capacity:2,twin:'ident',mtbf:3000,mttr:30},
  {id:'comp',name:'Componentes',minutes:40,setup:10,capacity:3,twin:'comp'},
  {id:'teste',name:'Testes / TAF',minutes:50,setup:20,capacity:2,twin:'teste',yield:.9,reworkTo:'eletrica',mtbf:2600,mttr:40},
  {id:'acab',name:'Acabamento',minutes:20,setup:5,capacity:2,twin:'acab',yield:.97,reworkTo:'acab'},
  {id:'embal',name:'Embalagem',minutes:18,setup:5,capacity:2,twin:'embal'},
  {id:'exped',name:'Expedição',minutes:15,setup:0,capacity:2,twin:'exped'}],
 items:[
  {code:'INV-001',name:'Invólucro metálico IP54',unit:'un',location:'A-01-01',onHand:140,min:15,leadTime:72},
  {code:'CU-030',name:'Barramento de cobre 30 mm',unit:'m',location:'A-02-03',onHand:2600,min:220,leadTime:48},
  {code:'DJ-250',name:'Disjuntor tripolar 250 A',unit:'un',location:'B-01-02',onHand:420,min:35,leadTime:96},
  {code:'CB-025',name:'Cabo flexível 2,5 mm²',unit:'m',location:'B-03-01',onHand:6000,min:500,leadTime:24},
  {code:'CT-100',name:'Contator tripolar 100 A',unit:'un',location:'B-02-01',onHand:900,min:60,leadTime:72},
  {code:'CLP-01',name:'CLP compacto 24 E/S',unit:'un',location:'C-01-01',onHand:60,min:6,leadTime:240},
  {code:'BOR-01',name:'Borne de passagem 4 mm²',unit:'un',location:'C-02-02',onHand:14000,min:800,leadTime:24},
  {code:'TIL-01',name:'Trilho DIN 35 mm',unit:'m',location:'C-03-01',onHand:1400,min:100,leadTime:48}],
 products:[
  {code:'QGBT',name:'Painel de distribuição',rev:'C',route:['receb','almox','corte','barr','mec','eletrica','ident','comp','teste','acab','embal','exped'],bom:{'INV-001':1,'CU-030':12,'DJ-250':2,'CB-025':24,'BOR-01':60,'TIL-01':6}},
  {code:'CCM',name:'Centro de controle de motores',rev:'B',route:['receb','almox','corte','barr','mec','eletrica','ident','comp','teste','acab','embal','exped'],bom:{'INV-001':1,'CU-030':18,'DJ-250':4,'CB-025':36,'CT-100':12,'BOR-01':80,'TIL-01':8}},
  {code:'AUT',name:'Painel de automação',rev:'D',route:['receb','almox','corte','mec','eletrica','ident','comp','teste','acab','embal','exped'],bom:{'INV-001':1,'CU-030':6,'DJ-250':1,'CB-025':48,'CLP-01':1,'BOR-01':120,'TIL-01':10}},
  {code:'CDC',name:'Centro de distribuição de cargas',rev:'A',route:['receb','almox','corte','barr','mec','eletrica','ident','comp','teste','acab','embal','exped'],bom:{'INV-001':1,'CU-030':30,'DJ-250':6,'CB-025':40,'BOR-01':40,'TIL-01':6}},
  {code:'RET',name:'Retrofit de painel existente',rev:'A',route:['receb','almox','eletrica','ident','teste','acab','exped'],bom:{'CB-025':30,'DJ-250':2,'BOR-01':40}}],
 orders:(function(){const c=['Alfa Energia','Beta Saneamento','Celta Papel','Delta Motores','Épsilon Celulose','Fênix Distribuidora','Gama Mineração','Hélio Aços','Íris Tubos','Júpiter Compressores'],p=['QGBT','CCM','AUT','CDC','RET','QGBT','CCM','AUT'],st=['receb','almox','corte','barr','mec','eletrica','ident','comp','teste','acab','embal','exped'];const o=[];for(let i=0;i<26;i++){o.push({client:c[i%c.length],product:p[i%p.length],qty:1+(i*7)%4,dueHours:6+i*1.7,priority:i%9===4?'Urgente':'Normal',status:S[i%S.length],startStage:st[(i*5)%st.length],progress:(i*17)%70});}return o;})()
};

T['BEV-ENVASE-01']={
 code:'BEV-ENVASE-01',name:'Bebidas · Linha de envase 01',industry:'Alimentos e bebidas',
 description:'Linha contínua de envase em três turnos: xaroparia, pasteurização, envase de alta cadência, rotulagem, inspeção e paletização. Qualidade com rejeição na inspeção e quebras na enchedora.',
 kind:'demo',complexity:'advanced',
 settings:{orderPrefix:'LOTE',shifts:shifts3,calendar:true,quality:true,autoMrp:true,consumeAt:'almox'},
 stages:[
  {id:'receb',name:'Recebimento de insumos',minutes:10,setup:0,capacity:2,twin:'receb'},
  {id:'almox',name:'Almoxarifado / silos',minutes:12,setup:0,capacity:2,twin:'almox'},
  {id:'xarop',name:'Xaroparia',minutes:35,setup:20,capacity:2,twin:'corte',mtbf:3000,mttr:35},
  {id:'past',name:'Pasteurização',minutes:25,setup:15,capacity:1,twin:'barr',mtbf:2200,mttr:50},
  {id:'envase',name:'Envase / enchedora',minutes:40,setup:30,capacity:2,twin:'eletrica',mtbf:900,mttr:25},
  {id:'rotul',name:'Rotulagem',minutes:15,setup:10,capacity:2,twin:'ident',mtbf:1500,mttr:20},
  {id:'insp',name:'Inspeção de qualidade',minutes:12,setup:0,capacity:2,twin:'teste',yield:.94,reworkTo:'rotul'},
  {id:'palet',name:'Paletização',minutes:18,setup:5,capacity:2,twin:'embal'},
  {id:'exped',name:'Expedição refrigerada',minutes:14,setup:0,capacity:2,twin:'exped'}],
 items:[
  {code:'PET-500',name:'Pré-forma PET 500 ml',unit:'un',location:'S-01',onHand:120000,min:20000,leadTime:48},
  {code:'PET-2000',name:'Pré-forma PET 2 L',unit:'un',location:'S-02',onHand:60000,min:10000,leadTime:48},
  {code:'TMP-28',name:'Tampa 28 mm',unit:'un',location:'S-03',onHand:200000,min:30000,leadTime:24},
  {code:'ROT-01',name:'Rótulo BOPP',unit:'un',location:'S-04',onHand:180000,min:30000,leadTime:72},
  {code:'CONC-01',name:'Concentrado sabor cola',unit:'l',location:'T-01',onHand:4000,min:600,leadTime:120},
  {code:'ACU-01',name:'Açúcar cristal',unit:'kg',location:'T-02',onHand:20000,min:3000,leadTime:48},
  {code:'CO2-01',name:'Dióxido de carbono',unit:'kg',location:'T-03',onHand:6000,min:500,leadTime:24},
  {code:'FLM-01',name:'Filme stretch',unit:'kg',location:'S-05',onHand:800,min:120,leadTime:24}],
 products:[
  {code:'REFRI-2L',name:'Refrigerante cola 2 L · lote 1.000 un',rev:'A',route:['receb','almox','xarop','past','envase','rotul','insp','palet','exped'],bom:{'PET-2000':1000,'TMP-28':1000,'ROT-01':1000,'CONC-01':60,'ACU-01':220,'CO2-01':16,'FLM-01':6}},
  {code:'AGUA-500',name:'Água mineral 500 ml · lote 2.000 un',rev:'B',route:['receb','almox','envase','rotul','insp','palet','exped'],bom:{'PET-500':2000,'TMP-28':2000,'ROT-01':2000,'FLM-01':5}},
  {code:'SUCO-1L',name:'Suco integral 1 L · lote 800 un',rev:'A',route:['receb','almox','xarop','past','envase','rotul','insp','palet','exped'],bom:{'PET-2000':800,'TMP-28':800,'ROT-01':800,'CONC-01':120,'ACU-01':40,'FLM-01':5}}],
 orders:(function(){const c=['Atacado Sul','Rede Supermarket','Distribuidora Litoral','Hortifruti Vale','Cash & Carry Norte'],p=['REFRI-2L','AGUA-500','SUCO-1L'],st=['receb','almox','xarop','past','envase','rotul','insp','palet'];const o=[];for(let i=0;i<18;i++)o.push({client:c[i%c.length],product:p[i%3],qty:1+i%3,dueHours:8+i*2.2,priority:i%7===3?'Urgente':'Normal',status:S[i%S.length],startStage:st[(i*3)%st.length],progress:(i*23)%60});return o;})()
};

T['USI-CNC-02']={
 code:'USI-CNC-02',name:'Usinagem de precisão · Célula CNC 02',industry:'Usinagem e metalmecânica',
 description:'Célula de usinagem com serra, tornos e centros CNC, retífica, tratamento térmico externo e inspeção dimensional com retrabalho. Setup alto e lotes pequenos.',
 kind:'demo',complexity:'advanced',
 settings:{orderPrefix:'OF',shifts:shifts2,calendar:true,quality:true,autoMrp:true,consumeAt:'almox'},
 stages:[
  {id:'receb',name:'Recebimento de matéria-prima',minutes:10,setup:0,capacity:1,twin:'receb'},
  {id:'almox',name:'Almoxarifado',minutes:10,setup:0,capacity:1,twin:'almox'},
  {id:'serra',name:'Serra de fita',minutes:12,setup:10,capacity:1,twin:'corte',mtbf:2800,mttr:30},
  {id:'torno',name:'Torno CNC',minutes:45,setup:40,capacity:2,twin:'barr',mtbf:1600,mttr:55},
  {id:'fresa',name:'Centro de usinagem',minutes:60,setup:45,capacity:2,twin:'mec',mtbf:1400,mttr:60},
  {id:'retif',name:'Retífica',minutes:30,setup:25,capacity:1,twin:'eletrica',mtbf:2000,mttr:40},
  {id:'trat',name:'Tratamento térmico',minutes:90,setup:30,capacity:3,twin:'comp'},
  {id:'insp',name:'Inspeção dimensional',minutes:20,setup:5,capacity:1,twin:'teste',yield:.92,reworkTo:'retif'},
  {id:'acab',name:'Rebarbação e acabamento',minutes:15,setup:5,capacity:2,twin:'acab'},
  {id:'embal',name:'Embalagem',minutes:10,setup:0,capacity:1,twin:'embal'},
  {id:'exped',name:'Expedição',minutes:10,setup:0,capacity:1,twin:'exped'}],
 items:[
  {code:'ACO-1045',name:'Barra aço SAE 1045 Ø50',unit:'m',location:'MP-01',onHand:300,min:60,leadTime:120},
  {code:'ALU-6061',name:'Tarugo alumínio 6061 Ø80',unit:'m',location:'MP-02',onHand:120,min:30,leadTime:96},
  {code:'INS-CNMG',name:'Inserto CNMG 12',unit:'un',location:'FER-01',onHand:400,min:80,leadTime:48},
  {code:'FRE-D12',name:'Fresa topo Ø12 metal duro',unit:'un',location:'FER-02',onHand:60,min:12,leadTime:72},
  {code:'OLE-01',name:'Óleo solúvel de corte',unit:'l',location:'QUI-01',onHand:600,min:100,leadTime:24},
  {code:'EMB-CX',name:'Caixa de madeira exportação',unit:'un',location:'EMB-01',onHand:80,min:15,leadTime:48}],
 products:[
  {code:'EIXO-A',name:'Eixo escalonado A · lote 10 pç',rev:'C',route:['receb','almox','serra','torno','trat','retif','insp','acab','embal','exped'],bom:{'ACO-1045':6,'INS-CNMG':4,'OLE-01':2,'EMB-CX':1}},
  {code:'FLANGE-B',name:'Flange usinado B · lote 20 pç',rev:'B',route:['receb','almox','serra','torno','fresa','insp','acab','embal','exped'],bom:{'ACO-1045':4,'INS-CNMG':6,'FRE-D12':1,'OLE-01':3,'EMB-CX':1}},
  {code:'CARC-C',name:'Carcaça alumínio C · lote 8 pç',rev:'A',route:['receb','almox','serra','fresa','insp','acab','embal','exped'],bom:{'ALU-6061':5,'FRE-D12':2,'OLE-01':3,'EMB-CX':1}}],
 orders:(function(){const c=['Motores Alfa','Compressores Beta','Fundição Gama','Metalúrgica Norte','Máquinas Delta','Usinagem Sul'],p=['EIXO-A','FLANGE-B','CARC-C'],st=['receb','almox','serra','torno','fresa','retif','trat','insp','acab'];const o=[];for(let i=0;i<16;i++)o.push({client:c[i%c.length],product:p[i%3],qty:1+i%2,dueHours:10+i*3.1,priority:i%8===2?'Urgente':'Normal',status:S[i%S.length],startStage:st[(i*4)%st.length],progress:(i*29)%65});return o;})()
};

T['EMB-PAPEL-03']={
 code:'EMB-PAPEL-03',name:'Embalagens · Papelão ondulado 03',industry:'Embalagens de papel',
 description:'Planta de caixas de papelão: onduladeira, impressão flexográfica, corte e vinco, colagem e paletização. Alta cadência, setup por troca de clichê e inspeção com refugo.',
 kind:'demo',complexity:'basic',
 settings:{orderPrefix:'OP',shifts:shifts2,calendar:true,quality:true,autoMrp:false,consumeAt:'almox'},
 stages:[
  {id:'receb',name:'Recebimento de bobinas',minutes:10,setup:0,capacity:2,twin:'receb'},
  {id:'almox',name:'Almoxarifado de bobinas',minutes:10,setup:0,capacity:2,twin:'almox'},
  {id:'ondul',name:'Onduladeira',minutes:30,setup:20,capacity:1,twin:'corte',mtbf:1200,mttr:35},
  {id:'flexo',name:'Impressão flexográfica',minutes:25,setup:35,capacity:2,twin:'ident',mtbf:1800,mttr:25},
  {id:'vinco',name:'Corte e vinco',minutes:20,setup:25,capacity:2,twin:'barr',mtbf:2000,mttr:30},
  {id:'cola',name:'Colagem / grampeação',minutes:18,setup:10,capacity:2,twin:'mec'},
  {id:'insp',name:'Inspeção final',minutes:8,setup:0,capacity:1,twin:'teste',yield:.95,reworkTo:'cola'},
  {id:'palet',name:'Paletização',minutes:12,setup:0,capacity:2,twin:'embal'},
  {id:'exped',name:'Expedição',minutes:10,setup:0,capacity:2,twin:'exped'}],
 items:[
  {code:'BOB-KRAFT',name:'Bobina kraft 150 g',unit:'kg',location:'B-01',onHand:60000,min:8000,leadTime:96},
  {code:'BOB-MIOLO',name:'Bobina miolo 120 g',unit:'kg',location:'B-02',onHand:40000,min:6000,leadTime:96},
  {code:'ADE-01',name:'Adesivo amido',unit:'kg',location:'Q-01',onHand:3000,min:400,leadTime:48},
  {code:'TIN-01',name:'Tinta flexo base água',unit:'l',location:'Q-02',onHand:1500,min:200,leadTime:72},
  {code:'FLM-01',name:'Filme stretch',unit:'kg',location:'E-01',onHand:600,min:100,leadTime:24}],
 products:[
  {code:'CX-403030',name:'Caixa 40×30×30 · lote 5.000 un',rev:'A',route:['receb','almox','ondul','flexo','vinco','cola','insp','palet','exped'],bom:{'BOB-KRAFT':1800,'BOB-MIOLO':900,'ADE-01':60,'TIN-01':25,'FLM-01':8}},
  {code:'BDJ-01',name:'Bandeja hortifrúti · lote 8.000 un',rev:'B',route:['receb','almox','ondul','vinco','insp','palet','exped'],bom:{'BOB-KRAFT':1200,'BOB-MIOLO':700,'ADE-01':40,'FLM-01':6}},
  {code:'DSP-01',name:'Display ponto de venda · lote 1.000 un',rev:'A',route:['receb','almox','ondul','flexo','vinco','cola','insp','palet','exped'],bom:{'BOB-KRAFT':900,'BOB-MIOLO':400,'ADE-01':30,'TIN-01':40,'FLM-01':4}}],
 orders:(function(){const c=['Cosméticos Aurora','Calçados Brisa','Chocolates Cacaual','Moda Ventura','Varejo Horizonte'],p=['CX-403030','BDJ-01','DSP-01'],st=['receb','almox','ondul','flexo','vinco','cola','insp','palet'];const o=[];for(let i=0;i<14;i++)o.push({client:c[i%c.length],product:p[i%3],qty:1+i%3,dueHours:6+i*2.5,priority:i%6===1?'Urgente':'Normal',status:S[i%S.length],startStage:st[(i*3)%st.length],progress:(i*19)%50});return o;})()
};


const api={templates:T,list:()=>Object.values(T),get:code=>T[code]};
if(typeof module!=='undefined')module.exports=api;else root.PDIN_TEMPLATES=api;
})(typeof window!=='undefined'?window:globalThis);
