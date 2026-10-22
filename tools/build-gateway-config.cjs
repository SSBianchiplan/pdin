/* Gera integration/<projeto>-gateway.json a partir da telemetria declarada no template (fonte única).
 * Uso: node tools/build-gateway-config.cjs <CODIGO-DO-PROJETO> (template com stages[].telemetry) */
const fs=require('node:fs'),path=require('node:path');
const T=require('../templates.js');
const code=process.argv[2];if(!code)throw Error('Informe o código do projeto: node tools/build-gateway-config.cjs <CODIGO>');const t=T.get(code);if(!t)throw Error('Template não encontrado: '+code);
const tags=[];t.stages.forEach(st=>(st.telemetry||[]).forEach(x=>{const prod=t.products.find(p=>p.params&&x.setpoint&&p.params[x.setpoint]!=null);tags.push({tag:x.tag,description:x.description||'',kind:x.kind||'analog',unit:x.unit||'',stage:st.id,resource:x.resource||null,source:x.source||'opcua',address:x.address||'',lo:x.lo??null,hi:x.hi??null,setpoint:x.setpoint||null,setpoint_value:prod?prod.params[x.setpoint]:null});}));
const cfg={projectCode:code,api:'http://127.0.0.1:18380',pollSeconds:t.settings.integration?.pollSeconds||5,writeToPlc:false,opcua:t.settings.integration?.opcua||{endpoint:'opc.tcp://localhost:4840'},mqtt:t.settings.integration?.mqtt||{broker:'mqtt://localhost:1883'},tags};
fs.mkdirSync(path.join(__dirname,'..','integration'),{recursive:true});
const file=path.join(__dirname,'..','integration',code.toLowerCase()+'-gateway.json');fs.writeFileSync(file,JSON.stringify(cfg,null,1)+'\n');console.log('Config gerada:',file,'·',tags.length,'tags');
