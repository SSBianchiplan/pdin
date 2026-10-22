-- GPlanSiS|PDIN · Migração 004: modo operacional.
-- Snapshot v3: status de OP do PCP (carteira/planejada/liberada/produção/pausada/concluída), operações com
-- apontamentos reais (início/fim em minutos desde a época), picking, itens criados por importação de BOM.
BEGIN;
CREATE OR REPLACE FUNCTION core.save_snapshot(p_project uuid,p_state jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid='00000000-0000-0000-0000-000000000010'; pl uuid; loc uuid; v_last integer; maxid integer; m jsonb; o jsonb; op jsonb; r record; item uuid; oid uuid; cur text; curp integer; newstatus text; newp integer; n_rec integer=0; n_cons integer=0; n_ord integer=0; n_ops integer=0; it jsonb; v_item uuid;
BEGIN
 SELECT plant_id INTO pl FROM core.projects WHERE id=p_project FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Projeto inexistente'; END IF;
 SELECT id INTO loc FROM wms.locations WHERE plant_id=pl AND code='ALM-01';
 INSERT INTO core.project_snapshots(project_id,state,sim_time) VALUES(p_project,p_state,coalesce((p_state->>'time')::numeric,0))
  ON CONFLICT(project_id) DO UPDATE SET state=EXCLUDED.state,sim_time=EXCLUDED.sim_time,saved_at=now();
 -- itens criados no motor (importação de BOM) entram no catálogo e nos metadados do projeto
 FOR it IN SELECT e FROM jsonb_array_elements(coalesce(p_state->'stock','[]')) e WHERE coalesce((e->>'imported')::boolean,false) LOOP
  INSERT INTO plm.items(code,name,kind,uom) VALUES(it->>'code',it->>'name','material',coalesce(it->>'unit','un')) ON CONFLICT(code) DO NOTHING;
  UPDATE core.projects SET settings=jsonb_set(settings,'{items}',coalesce(settings->'items','[]')||jsonb_build_object('code',it->>'code','name',it->>'name','unit',coalesce(it->>'unit','un'),'onHand',0,'min',coalesce((it->>'min')::numeric,0),'leadTime',coalesce((it->>'leadTime')::numeric,48),'location','ALM-01'))
   WHERE id=p_project AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(settings->'items') x WHERE x->>'code'=it->>'code');
 END LOOP;
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
  newstatus=CASE o->>'status' WHEN 'done' THEN 'completed' WHEN 'paused' THEN 'paused' WHEN 'cancelled' THEN 'cancelled' WHEN 'running' THEN 'running' WHEN 'released' THEN 'released' ELSE 'draft' END;
  newp=CASE WHEN o->>'priority'='Urgente' THEN 90 ELSE 50 END;
  IF cur NOT IN ('completed','cancelled') AND (cur<>newstatus OR curp<>newp OR (o->>'due')::numeric IS NOT NULL) THEN
   UPDATE ppcp.orders SET status=newstatus,priority=newp,due_at=coalesce(to_timestamp((o->>'due')::numeric*60),due_at),completed_at=CASE WHEN newstatus='completed' THEN coalesce(to_timestamp((o->>'completed')::numeric*60),now()) END
    WHERE id=oid AND (status<>newstatus OR priority<>newp OR due_at IS DISTINCT FROM to_timestamp((o->>'due')::numeric*60)); IF FOUND THEN n_ord=n_ord+1; END IF;
  END IF;
  IF coalesce((o->>'consumed')::boolean,false) THEN
   FOR r IN SELECT id FROM wms.reservations WHERE order_id=oid AND status='active' LOOP
    PERFORM wms.consume_reservation(r.id,md5(p_project::text||':res:'||r.id::text)::uuid,actor); n_cons=n_cons+1;
   END LOOP;
  ELSIF o->>'status'='cancelled' THEN
   FOR r IN SELECT id FROM wms.reservations WHERE order_id=oid AND status='active' LOOP PERFORM wms.release_reservation(r.id); END LOOP;
  END IF;
  -- operações: apontamentos reais por sequência do roteiro original (laços de retrabalho não têm linha relacional)
  FOR op IN SELECT e FROM jsonb_array_elements(coalesce(o->'ops','[]')) e WHERE NOT coalesce((e->>'rework')::boolean,false) LOOP
   UPDATE mes.operations SET
     status=CASE op->>'status' WHEN 'done' THEN 'completed' WHEN 'running' THEN 'running' WHEN 'paused' THEN 'paused' ELSE 'queued' END,
     started_at=CASE WHEN op->>'start' IS NOT NULL THEN to_timestamp((op->>'start')::numeric*60) END,
     completed_at=CASE WHEN op->>'status'='done' AND op->>'end' IS NOT NULL THEN greatest(to_timestamp((op->>'end')::numeric*60),to_timestamp((op->>'start')::numeric*60)) END,
     good_quantity=coalesce((op->>'good')::numeric,0),scrap_quantity=coalesce((op->>'scrap')::numeric,0)
    WHERE order_id=oid AND sequence=(SELECT count(*) FROM jsonb_array_elements(o->'ops') WITH ORDINALITY t(v,i) WHERE i<=(op->>'seq')::integer AND NOT coalesce((v->>'rework')::boolean,false))
      AND status<>'completed'
      AND (status IS DISTINCT FROM CASE op->>'status' WHEN 'done' THEN 'completed' WHEN 'running' THEN 'running' WHEN 'paused' THEN 'paused' ELSE 'queued' END);
   IF FOUND THEN n_ops=n_ops+1; END IF;
  END LOOP;
 END LOOP;
 UPDATE core.projects SET updated_at=now() WHERE id=p_project;
 RETURN jsonb_build_object('receipts',n_rec,'consumed',n_cons,'orders_updated',n_ord,'operations_updated',n_ops);
END $$;

-- Importação de BOM da engenharia: cria itens desconhecidos e substitui a estrutura na revisão proposta.
CREATE OR REPLACE FUNCTION plm.import_bom(p_project uuid,p_product text,p_rows jsonb,p_note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pl uuid; cur uuid; item uuid; newcode text; rev uuid; r jsonb; comp uuid; created text[]='{}';
BEGIN
 SELECT plant_id INTO pl FROM core.projects WHERE id=p_project FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Projeto inexistente'; END IF;
 cur=plm.current_revision(pl,p_product);
 IF cur IS NULL THEN RAISE EXCEPTION 'Produto sem revisão liberada'; END IF;
 SELECT item_id,chr(ascii(code)+1) INTO item,newcode FROM plm.revisions WHERE id=cur;
 IF EXISTS(SELECT 1 FROM plm.revisions WHERE item_id=item AND state IN ('draft','review')) THEN RAISE EXCEPTION 'Já existe revisão em análise para %',p_product; END IF;
 INSERT INTO plm.revisions(item_id,code,state,description) VALUES(item,newcode,'review',coalesce(p_note,'BOM importada da engenharia')) RETURNING id INTO rev;
 INSERT INTO plm.routing_steps(revision_id,sequence,work_center_id,setup_minutes,unit_minutes,instructions) SELECT rev,sequence,work_center_id,setup_minutes,unit_minutes,instructions FROM plm.routing_steps WHERE revision_id=cur;
 FOR r IN SELECT e FROM jsonb_array_elements(p_rows) e LOOP
  INSERT INTO plm.items(code,name,kind,uom) VALUES(r->>'code',coalesce(r->>'name',r->>'code'),'material',CASE WHEN r->>'unit' IN ('un','m','kg','l') THEN r->>'unit' ELSE 'un' END) ON CONFLICT(code) DO NOTHING RETURNING id INTO comp;
  IF comp IS NOT NULL THEN created=created||(r->>'code'); ELSE SELECT id INTO comp FROM plm.items WHERE code=r->>'code'; END IF;
  INSERT INTO plm.bom_lines(revision_id,component_id,quantity) VALUES(rev,comp,(r->>'qty')::numeric) ON CONFLICT(revision_id,component_id) DO UPDATE SET quantity=plm.bom_lines.quantity+EXCLUDED.quantity;
  comp=NULL;
 END LOOP;
 RETURN jsonb_build_object('id',rev,'code',newcode,'product',p_product,'created',to_jsonb(created));
END $$;
GRANT EXECUTE ON FUNCTION plm.import_bom(uuid,text,jsonb,text) TO astra_api;
INSERT INTO core.schema_migrations(version) VALUES(4);
COMMIT;
