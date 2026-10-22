/* Gera database/900_demo_projects.sql a partir de templates.js (fonte única dos projetos demo).
 * Uso: node tools/build-seed.cjs */
const fs=require('node:fs'),path=require('node:path');
const T=require('../templates.js');
const out=[];
out.push('-- GERADO por tools/build-seed.cjs a partir de templates.js. Não edite manualmente.');
out.push('-- Exclusivo para banco com sufixo _demo. Idempotente: projetos existentes são preservados.');
out.push('BEGIN;');
out.push(`DO $$ BEGIN IF current_database() NOT LIKE '%\\_demo' ESCAPE '\\' THEN RAISE EXCEPTION 'Seed permitido apenas em banco com sufixo _demo'; END IF; END $$;`);
for(const t of T.list()){
 const json=JSON.stringify(t);
 if(json.includes('$spec$'))throw Error('Template contém delimitador reservado');
 out.push(`SELECT core.create_project($spec$${json}$spec$::jsonb) WHERE NOT EXISTS(SELECT 1 FROM core.projects WHERE code='${t.code}');`);
}
out.push('COMMIT;');
const file=path.join(__dirname,'..','database','900_demo_projects.sql');
fs.writeFileSync(file,out.join('\n')+'\n');
console.log('Seed gerado:',file,'·',T.list().length,'projetos');
