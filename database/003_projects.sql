-- GPlanSiS|PDIN · Migração 003: projetos, snapshots de simulação e funções de aplicação.
-- Depende de 001_schema.sql. Transacional. Não contém dados demo (ver 900_demo_projects.sql).
-- Invariantes ficam no banco: numeração de OP serializada por projeto, reserva atômica de kit,
-- sincronização idempotente de recebimentos/consumos e congelamento de revisões liberadas.
BEGIN;
INSERT INTO core.users(id,external_subject,display_name) VALUES('00000000-0000-0000-0000-000000000010','pdin:system','GPlanSiS|PDIN · Sistema') ON CONFLICT(external_subject) DO NOTHING;

CREATE TABLE core.projects(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 plant_id uuid NOT NULL UNIQUE REFERENCES core.plants,
 code text NOT NULL UNIQUE CHECK(code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 3 AND 120),
 description text NOT NULL DEFAULT '',
 industry text NOT NULL DEFAULT '',
 kind text NOT NULL DEFAULT 'demo' CHECK(kind IN ('demo','real')),
 complexity text NOT NULL DEFAULT 'basic' CHECK(complexity IN ('basic','advanced','expert')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 order_seq integer NOT NULL DEFAULT 0 CHECK(order_seq>=0),
 settings jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE core.project_snapshots(
 project_id uuid PRIMARY KEY REFERENCES core.projects ON DELETE CASCADE,
 state jsonb NOT NULL,
 sim_time numeric NOT NULL DEFAULT 0,
 synced_movement integer NOT NULL DEFAULT 0,
 saved_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX projects_status ON core.projects(status,updated_at DESC);

-- Snapshot da estrutura/roteiro de um produto liberado nesta planta (mais recente).
CREATE FUNCTION plm.current_revision(p_plant uuid,p_product text) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT r.id FROM plm.revisions r JOIN plm.items i ON i.id=r.item_id
 WHERE i.code=p_product AND r.state='released'
   AND EXISTS(SELECT 1 FROM plm.routing_steps rs JOIN core.work_centers wc ON wc.id=rs.work_center_id WHERE rs.revision_id=r.id AND wc.plant_id=p_plant)
 ORDER BY r.released_at DESC LIMIT 1 $$;

-- Cria OP com código sequencial por projeto, snapshot de materiais/operações (trigger) e reserva atômica do kit.
CREATE FUNCTION ppcp.create_order(p_project uuid,p_product text,p_client text,p_qty numeric,p_due timestamptz,p_priority integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pl uuid; prefix text; seq integer; ocode text; rev uuid; oid uuid; loc uuid; m record;
BEGIN
 IF p_qty IS NULL OR p_qty<=0 OR p_qty>50 THEN RAISE EXCEPTION 'Quantidade deve estar entre 1 e 50'; END IF;
 IF p_client IS NULL OR length(trim(p_client))<2 THEN RAISE EXCEPTION 'Cliente obrigatório'; END IF;
 IF p_due IS NULL OR p_due<=now() THEN RAISE EXCEPTION 'Prazo deve ser futuro'; END IF;
 SELECT plant_id,coalesce(settings->'settings'->>'orderPrefix','OP') INTO pl,prefix FROM core.projects WHERE id=p_project AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Projeto inexistente ou arquivado'; END IF;
 rev=plm.current_revision(pl,p_product);
 IF rev IS NULL THEN RAISE EXCEPTION 'Produto % sem revisão liberada neste projeto',p_product; END IF;
 UPDATE core.projects SET order_seq=order_seq+1,updated_at=now() WHERE id=p_project RETURNING order_seq INTO seq;
 ocode=prefix||'-'||lpad(seq::text,4,'0');
 INSERT INTO ppcp.orders(plant_id,code,customer_reference,revision_id,quantity,due_at,priority,status) VALUES(pl,ocode,trim(p_client),rev,p_qty,p_due,coalesce(p_priority,50),'released') RETURNING id INTO oid;
 SELECT id INTO loc FROM wms.locations WHERE plant_id=pl AND code='ALM-01';
 FOR m IN SELECT item_id,required_quantity FROM ppcp.order_materials WHERE order_id=oid LOOP
  PERFORM wms.reserve_stock(oid,loc,m.item_id,'',m.required_quantity,gen_random_uuid());
 END LOOP;
 RETURN jsonb_build_object('id',oid,'code',ocode,'revision',(SELECT code FROM plm.revisions WHERE id=rev),'product',p_product);
END $$;

-- Cria um projeto completo a partir de uma especificação (mesmo formato de templates.js).
CREATE FUNCTION core.create_project(spec jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid='00000000-0000-0000-0000-000000000010'; pl uuid; pr uuid; loc uuid; wc uuid; v_item uuid; rev uuid; n integer; st jsonb; it jsonb; pd jsonb; od jsonb; k text; v jsonb; stage jsonb;
BEGIN
 IF spec->>'code' IS NULL OR spec->>'name' IS NULL THEN RAISE EXCEPTION 'Projeto exige code e name'; END IF;
 IF jsonb_array_length(coalesce(spec->'stages','[]'))<2 THEN RAISE EXCEPTION 'Projeto exige ao menos 2 estágios'; END IF;
 IF jsonb_array_length(coalesce(spec->'products','[]'))<1 THEN RAISE EXCEPTION 'Projeto exige ao menos 1 produto'; END IF;
 INSERT INTO core.plants(code,name) VALUES(spec->>'code',spec->>'name') RETURNING id INTO pl;
 INSERT INTO core.projects(plant_id,code,name,description,industry,kind,complexity,settings) VALUES(pl,spec->>'code',spec->>'name',coalesce(spec->>'description',''),coalesce(spec->>'industry',''),coalesce(spec->>'kind','demo'),coalesce(spec->>'complexity','basic'),spec) RETURNING id INTO pr;
 FOR st IN SELECT e FROM jsonb_array_elements(spec->'stages') e LOOP
  INSERT INTO core.work_centers(plant_id,code,name) VALUES(pl,st->>'id',st->>'name') RETURNING id INTO wc;
  FOR n IN 1..greatest(1,coalesce((st->>'capacity')::integer,1)) LOOP
   INSERT INTO core.resources(plant_id,work_center_id,code) VALUES(pl,wc,(st->>'id')||'-'||lpad(n::text,2,'0'));
  END LOOP;
 END LOOP;
 INSERT INTO wms.locations(plant_id,code,kind) VALUES(pl,'ALM-01','storage') RETURNING id INTO loc;
 FOR it IN SELECT e FROM jsonb_array_elements(coalesce(spec->'items','[]')) e LOOP
  INSERT INTO plm.items(code,name,kind,uom) VALUES(it->>'code',it->>'name','material',it->>'unit') ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO v_item;
  IF coalesce((it->>'onHand')::numeric,0)>0 THEN PERFORM wms.receive_stock(pl,loc,v_item,'',(it->>'onHand')::numeric,'Carga inicial '||(spec->>'code'),gen_random_uuid(),actor); END IF;
 END LOOP;
 FOR pd IN SELECT e FROM jsonb_array_elements(spec->'products') e LOOP
  INSERT INTO plm.items(code,name,kind,uom) VALUES(pd->>'code',pd->>'name','product','un') ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO v_item;
  IF EXISTS(SELECT 1 FROM plm.revisions WHERE item_id=v_item AND code=coalesce(pd->>'rev','A')) THEN RAISE EXCEPTION 'Produto % revisão % já existe em outro projeto; use códigos distintos',pd->>'code',coalesce(pd->>'rev','A'); END IF;
  INSERT INTO plm.revisions(item_id,code,description) VALUES(v_item,coalesce(pd->>'rev','A'),'Revisão inicial do projeto '||(spec->>'code')) RETURNING id INTO rev;
  FOR k,v IN SELECT * FROM jsonb_each(coalesce(pd->'bom','{}')) LOOP
   INSERT INTO plm.bom_lines(revision_id,component_id,quantity) SELECT rev,id,(v#>>'{}')::numeric FROM plm.items WHERE code=k;
   IF NOT FOUND THEN RAISE EXCEPTION 'BOM de % referencia item inexistente %',pd->>'code',k; END IF;
  END LOOP;
  FOR n,k IN SELECT ord,val FROM jsonb_array_elements_text(coalesce(pd->'route',(SELECT jsonb_agg(e->>'id') FROM jsonb_array_elements(spec->'stages') e))) WITH ORDINALITY t(val,ord) LOOP
   SELECT e INTO stage FROM jsonb_array_elements(spec->'stages') e WHERE e->>'id'=k;
   IF stage IS NULL THEN RAISE EXCEPTION 'Roteiro de % referencia estágio inexistente %',pd->>'code',k; END IF;
   INSERT INTO plm.routing_steps(revision_id,sequence,work_center_id,setup_minutes,unit_minutes) SELECT rev,n,id,coalesce((stage->>'setup')::numeric,0),(stage->>'minutes')::numeric FROM core.work_centers WHERE plant_id=pl AND code=k;
  END LOOP;
  UPDATE plm.revisions SET state='released',released_at=now(),released_by=actor WHERE id=rev;
 END LOOP;
 FOR od IN SELECT e FROM jsonb_array_elements(coalesce(spec->'orders','[]')) e LOOP
  PERFORM ppcp.create_order(pr,od->>'product',od->>'client',(od->>'qty')::numeric,now()+((od->>'dueHours')::numeric*interval '1 hour'),CASE WHEN od->>'priority'='Urgente' THEN 90 ELSE 50 END);
 END LOOP;
 RETURN pr;
END $$;

-- Engenharia: proposta copia BOM/roteiro da revisão vigente com deltas; liberação congela.
CREATE FUNCTION plm.propose_revision(p_project uuid,p_product text,p_changes jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pl uuid; cur uuid; item uuid; newcode text; rev uuid; c jsonb; comp uuid; delta numeric;
BEGIN
 SELECT plant_id INTO pl FROM core.projects WHERE id=p_project FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Projeto inexistente'; END IF;
 cur=plm.current_revision(pl,p_product);
 IF cur IS NULL THEN RAISE EXCEPTION 'Produto sem revisão liberada'; END IF;
 SELECT item_id,chr(ascii(code)+1) INTO item,newcode FROM plm.revisions WHERE id=cur;
 IF EXISTS(SELECT 1 FROM plm.revisions WHERE item_id=item AND state IN ('draft','review')) THEN RAISE EXCEPTION 'Já existe revisão em análise para %',p_product; END IF;
 INSERT INTO plm.revisions(item_id,code,state,description) VALUES(item,newcode,'review','Proposta a partir da revisão '||(SELECT code FROM plm.revisions WHERE id=cur)) RETURNING id INTO rev;
 INSERT INTO plm.bom_lines(revision_id,component_id,quantity,scrap_factor) SELECT rev,component_id,quantity,scrap_factor FROM plm.bom_lines WHERE revision_id=cur;
 INSERT INTO plm.routing_steps(revision_id,sequence,work_center_id,setup_minutes,unit_minutes,instructions) SELECT rev,sequence,work_center_id,setup_minutes,unit_minutes,instructions FROM plm.routing_steps WHERE revision_id=cur;
 FOR c IN SELECT e FROM jsonb_array_elements(coalesce(p_changes,'[]')) e LOOP
  SELECT id INTO comp FROM plm.items WHERE code=c->>'item'; delta=coalesce((c->>'delta')::numeric,0);
  IF comp IS NULL THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM plm.bom_lines WHERE revision_id=rev AND component_id=comp) THEN
   DELETE FROM plm.bom_lines WHERE revision_id=rev AND component_id=comp AND quantity+delta<=0;
   UPDATE plm.bom_lines SET quantity=quantity+delta WHERE revision_id=rev AND component_id=comp;
  ELSIF delta>0 THEN
   INSERT INTO plm.bom_lines(revision_id,component_id,quantity) VALUES(rev,comp,delta);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('id',rev,'code',newcode,'product',p_product);
END $$;
CREATE FUNCTION plm.release_revision(p_project uuid,p_product text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid='00000000-0000-0000-0000-000000000010'; pl uuid; rev uuid; c text;
BEGIN
 SELECT plant_id INTO pl FROM core.projects WHERE id=p_project FOR UPDATE;
 SELECT r.id,r.code INTO rev,c FROM plm.revisions r JOIN plm.items i ON i.id=r.item_id WHERE i.code=p_product AND r.state IN ('draft','review') ORDER BY r.created_at DESC LIMIT 1;
 IF rev IS NULL THEN RAISE EXCEPTION 'Nenhuma revisão em análise para %',p_product; END IF;
 UPDATE plm.revisions SET state='released',released_at=now(),released_by=actor WHERE id=rev;
 RETURN jsonb_build_object('id',rev,'code',c,'product',p_product);
END $$;

-- Persiste o snapshot do motor e reconcilia o relacional: recebimentos (idempotentes por movimento),
-- consumo de reservas na saída do almoxarifado, status de OP/operações e prioridade.
CREATE FUNCTION core.save_snapshot(p_project uuid,p_state jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid='00000000-0000-0000-0000-000000000010'; pl uuid; loc uuid; v_last integer; maxid integer; m jsonb; o jsonb; r record; item uuid; oid uuid; cur text; curp integer; newstatus text; newp integer; step integer; n_rec integer=0; n_cons integer=0; n_ord integer=0;
BEGIN
 SELECT plant_id INTO pl FROM core.projects WHERE id=p_project FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Projeto inexistente'; END IF;
 SELECT id INTO loc FROM wms.locations WHERE plant_id=pl AND code='ALM-01';
 INSERT INTO core.project_snapshots(project_id,state,sim_time) VALUES(p_project,p_state,coalesce((p_state->>'time')::numeric,0))
  ON CONFLICT(project_id) DO UPDATE SET state=EXCLUDED.state,sim_time=EXCLUDED.sim_time,saved_at=now();
 SELECT synced_movement INTO v_last FROM core.project_snapshots WHERE project_id=p_project; maxid=v_last;
 FOR m IN SELECT e FROM jsonb_array_elements(coalesce(p_state->'movements','[]')) e WHERE e->>'type'='Recebimento' AND (e->>'id')::integer>v_last ORDER BY (e->>'id')::integer LOOP
  SELECT id INTO item FROM plm.items WHERE code=(p_state->'stock'->((m->>'item')::integer)->>'code');
  IF item IS NOT NULL THEN
   PERFORM wms.receive_stock(pl,loc,item,'',(m->>'qty')::numeric,coalesce(m->>'ref','Recebimento'),md5(p_project::text||':mov:'||(m->>'id'))::uuid,actor); n_rec=n_rec+1;
  END IF;
  maxid=greatest(maxid,(m->>'id')::integer);
 END LOOP;
 UPDATE core.project_snapshots SET synced_movement=maxid WHERE project_id=p_project;
 FOR o IN SELECT e FROM jsonb_array_elements(coalesce(p_state->'orders','[]')) e LOOP
  SELECT id,status,priority INTO oid,cur,curp FROM ppcp.orders WHERE plant_id=pl AND code=o->>'id';
  IF NOT FOUND THEN CONTINUE; END IF;
  step=coalesce((o->>'step')::integer,0);
  newstatus=CASE o->>'status' WHEN 'done' THEN 'completed' WHEN 'paused' THEN 'paused' WHEN 'cancelled' THEN 'cancelled' ELSE CASE WHEN step>0 OR coalesce((o->>'progress')::numeric,0)>0 THEN 'running' ELSE 'released' END END;
  newp=CASE WHEN o->>'priority'='Urgente' THEN 90 ELSE 50 END;
  IF cur NOT IN ('completed','cancelled') AND (cur<>newstatus OR curp<>newp) THEN
   UPDATE ppcp.orders SET status=newstatus,priority=newp,completed_at=CASE WHEN newstatus='completed' THEN now() END WHERE id=oid; n_ord=n_ord+1;
  END IF;
  IF coalesce((o->>'consumed')::boolean,false) THEN
   FOR r IN SELECT id FROM wms.reservations WHERE order_id=oid AND status='active' LOOP
    PERFORM wms.consume_reservation(r.id,md5(p_project::text||':res:'||r.id::text)::uuid,actor); n_cons=n_cons+1;
   END LOOP;
  ELSIF o->>'status'='cancelled' THEN
   FOR r IN SELECT id FROM wms.reservations WHERE order_id=oid AND status='active' LOOP PERFORM wms.release_reservation(r.id); END LOOP;
  END IF;
  UPDATE mes.operations SET status='completed',started_at=coalesce(started_at,now()),completed_at=coalesce(completed_at,now()) WHERE order_id=oid AND sequence<=step AND status<>'completed';
  IF o->>'status' IN ('active','paused') AND coalesce((o->>'progress')::numeric,0)>0 THEN
   UPDATE mes.operations SET status=CASE WHEN o->>'status'='paused' THEN 'paused' ELSE 'running' END,started_at=coalesce(started_at,now()) WHERE order_id=oid AND sequence=step+1 AND status<>'completed';
  END IF;
 END LOOP;
 UPDATE core.projects SET updated_at=now() WHERE id=p_project;
 RETURN jsonb_build_object('receipts',n_rec,'consumed',n_cons,'orders_updated',n_ord);
END $$;

CREATE VIEW core.project_overview AS
 SELECT p.id,p.code,p.name,p.description,p.industry,p.kind,p.complexity,p.status,p.created_at,p.updated_at,p.plant_id,
  (SELECT count(*) FROM ppcp.orders o WHERE o.plant_id=p.plant_id AND o.status IN ('released','running','paused')) AS open_orders,
  (SELECT count(*) FROM ppcp.orders o WHERE o.plant_id=p.plant_id AND o.status='completed') AS completed_orders,
  (SELECT count(*) FROM core.work_centers w WHERE w.plant_id=p.plant_id) AS work_centers,
  (SELECT count(*) FROM plm.revisions r JOIN plm.routing_steps rs ON rs.revision_id=r.id JOIN core.work_centers w ON w.id=rs.work_center_id WHERE w.plant_id=p.plant_id AND r.state='released' AND rs.sequence=1) AS products,
  s.sim_time,s.saved_at
 FROM core.projects p LEFT JOIN core.project_snapshots s ON s.project_id=p.id;

GRANT SELECT ON core.projects,core.project_snapshots,core.project_overview TO astra_api;
GRANT INSERT,UPDATE ON core.projects TO astra_api;
GRANT EXECUTE ON FUNCTION core.create_project(jsonb),core.save_snapshot(uuid,jsonb),ppcp.create_order(uuid,text,text,numeric,timestamptz,integer),plm.propose_revision(uuid,text,jsonb),plm.release_revision(uuid,text),plm.current_revision(uuid,text) TO astra_api;
INSERT INTO core.schema_migrations(version) VALUES(3);
COMMIT;
