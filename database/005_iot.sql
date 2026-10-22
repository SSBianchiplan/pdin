-- GPlanSiS|PDIN · Migração 005: telemetria de campo (PLC / IHM / IoT) por projeto e recursos nomeados.
-- Mantém o princípio "a IA/gateway propõe, o humano decide": nenhuma escrita em PLC nasce aqui; só leitura.
BEGIN;
CREATE SCHEMA iot;
CREATE TABLE iot.tags(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id uuid NOT NULL REFERENCES core.projects ON DELETE CASCADE,
 tag text NOT NULL,
 description text NOT NULL DEFAULT '',
 kind text NOT NULL DEFAULT 'analog' CHECK(kind IN ('analog','digital','counter','text')),
 unit text NOT NULL DEFAULT '',
 stage_code text,                -- estágio do motor (ex.: fermentacao)
 resource text,                  -- posição/recurso (ex.: TQ-01)
 source text NOT NULL DEFAULT 'opcua' CHECK(source IN ('opcua','mqtt','modbus','manual','sim')),
 address text NOT NULL DEFAULT '',  -- NodeId OPC UA, tópico MQTT ou registrador Modbus
 lo numeric, hi numeric,          -- limites de alarme (opcional)
 UNIQUE(project_id,tag));
CREATE TABLE iot.samples(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id uuid NOT NULL,
 tag text NOT NULL,
 value numeric NOT NULL,
 quality smallint NOT NULL DEFAULT 192,   -- StatusCode OPC UA reduzido (192 = Good)
 at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX samples_tag_time ON iot.samples(project_id,tag,at DESC);
CREATE TABLE iot.tag_latest(
 project_id uuid NOT NULL,
 tag text NOT NULL,
 value numeric NOT NULL,
 quality smallint NOT NULL,
 at timestamptz NOT NULL,
 PRIMARY KEY(project_id,tag));
CREATE TRIGGER samples_immutable BEFORE UPDATE OR DELETE ON iot.samples FOR EACH ROW EXECUTE FUNCTION core.immutable_record();

-- Ingestão idempotente por (tag, at): reenvio do gateway não duplica; latest só avança no tempo.
CREATE FUNCTION iot.ingest(p_project uuid,p_samples jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb; n integer=0; skipped integer=0; t timestamptz; v numeric; q smallint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.projects WHERE id=p_project) THEN RAISE EXCEPTION 'Projeto inexistente'; END IF;
 FOR s IN SELECT e FROM jsonb_array_elements(p_samples) e LOOP
  IF s->>'tag' IS NULL OR s->>'value' IS NULL THEN skipped=skipped+1; CONTINUE; END IF;
  v=(s->>'value')::numeric; q=coalesce((s->>'quality')::smallint,192);
  t=coalesce((s->>'at')::timestamptz,now());
  IF EXISTS(SELECT 1 FROM iot.samples WHERE project_id=p_project AND tag=s->>'tag' AND at=t) THEN skipped=skipped+1; CONTINUE; END IF;
  INSERT INTO iot.samples(project_id,tag,value,quality,at) VALUES(p_project,s->>'tag',v,q,t);
  INSERT INTO iot.tag_latest(project_id,tag,value,quality,at) VALUES(p_project,s->>'tag',v,q,t)
   ON CONFLICT(project_id,tag) DO UPDATE SET value=EXCLUDED.value,quality=EXCLUDED.quality,at=EXCLUDED.at WHERE iot.tag_latest.at<=EXCLUDED.at;
  n=n+1;
 END LOOP;
 RETURN jsonb_build_object('ingested',n,'skipped',skipped);
END $$;

-- Cadastro de tags a partir da especificação do projeto (settings.stages[].telemetry) — idempotente.
CREATE FUNCTION iot.sync_tags(p_project uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE st jsonb; tg jsonb; n integer=0;
BEGIN
 FOR st IN SELECT e FROM core.projects p, jsonb_array_elements(coalesce(p.settings->'stages','[]')) e WHERE p.id=p_project LOOP
  FOR tg IN SELECT e FROM jsonb_array_elements(coalesce(st->'telemetry','[]')) e LOOP
   INSERT INTO iot.tags(project_id,tag,description,kind,unit,stage_code,resource,source,address,lo,hi)
   VALUES(p_project,tg->>'tag',coalesce(tg->>'description',''),coalesce(tg->>'kind','analog'),coalesce(tg->>'unit',''),st->>'id',tg->>'resource',coalesce(tg->>'source','opcua'),coalesce(tg->>'address',''),(tg->>'lo')::numeric,(tg->>'hi')::numeric)
   ON CONFLICT(project_id,tag) DO UPDATE SET description=EXCLUDED.description,kind=EXCLUDED.kind,unit=EXCLUDED.unit,stage_code=EXCLUDED.stage_code,resource=EXCLUDED.resource,source=EXCLUDED.source,address=EXCLUDED.address,lo=EXCLUDED.lo,hi=EXCLUDED.hi;
   n=n+1;
  END LOOP;
 END LOOP;
 RETURN n;
END $$;

-- Recursos nomeados (ex.: TQ-01) quando o estágio traz "resources"; senão código-NN como antes.
CREATE OR REPLACE FUNCTION core.create_project(spec jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid='00000000-0000-0000-0000-000000000010'; pl uuid; pr uuid; loc uuid; wc uuid; v_item uuid; rev uuid; n integer; st jsonb; it jsonb; pd jsonb; od jsonb; k text; v jsonb; stage jsonb; rname text;
BEGIN
 IF spec->>'code' IS NULL OR spec->>'name' IS NULL THEN RAISE EXCEPTION 'Projeto exige code e name'; END IF;
 IF jsonb_array_length(coalesce(spec->'stages','[]'))<2 THEN RAISE EXCEPTION 'Projeto exige ao menos 2 estágios'; END IF;
 IF jsonb_array_length(coalesce(spec->'products','[]'))<1 THEN RAISE EXCEPTION 'Projeto exige ao menos 1 produto'; END IF;
 INSERT INTO core.plants(code,name) VALUES(spec->>'code',spec->>'name') RETURNING id INTO pl;
 INSERT INTO core.projects(plant_id,code,name,description,industry,kind,complexity,settings) VALUES(pl,spec->>'code',spec->>'name',coalesce(spec->>'description',''),coalesce(spec->>'industry',''),coalesce(spec->>'kind','demo'),coalesce(spec->>'complexity','basic'),spec) RETURNING id INTO pr;
 FOR st IN SELECT e FROM jsonb_array_elements(spec->'stages') e LOOP
  INSERT INTO core.work_centers(plant_id,code,name) VALUES(pl,st->>'id',st->>'name') RETURNING id INTO wc;
  FOR n IN 1..greatest(1,coalesce((st->>'capacity')::integer,1)) LOOP
   rname=coalesce(st->'resources'->>(n-1),(st->>'id')||'-'||lpad(n::text,2,'0'));
   INSERT INTO core.resources(plant_id,work_center_id,code) VALUES(pl,wc,rname);
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
 PERFORM iot.sync_tags(pr);
 RETURN pr;
END $$;
GRANT USAGE ON SCHEMA iot TO astra_api;
GRANT SELECT ON iot.tags,iot.samples,iot.tag_latest TO astra_api;
GRANT EXECUTE ON FUNCTION iot.ingest(uuid,jsonb),iot.sync_tags(uuid) TO astra_api;
INSERT INTO core.schema_migrations(version) VALUES(5);
COMMIT;
