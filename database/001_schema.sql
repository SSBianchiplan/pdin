-- ASTRA | Fundação PostgreSQL 17+ para futura API de produção.
-- Migração única e transacional. NÃO contém dados demo.
BEGIN;
CREATE SCHEMA core;
CREATE SCHEMA plm;
CREATE SCHEMA ppcp;
CREATE SCHEMA mes;
CREATE SCHEMA aps;
CREATE SCHEMA wms;
CREATE SCHEMA audit;

CREATE TABLE core.schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE core.plants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL, timezone text NOT NULL DEFAULT 'America/Sao_Paulo');
CREATE TABLE core.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_subject text NOT NULL UNIQUE, display_name text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE TABLE core.memberships(plant_id uuid REFERENCES core.plants NOT NULL, user_id uuid REFERENCES core.users NOT NULL, role text NOT NULL CHECK(role IN ('viewer','operator','planner','engineer','warehouse','admin')), PRIMARY KEY(plant_id,user_id,role));
CREATE TABLE core.areas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL REFERENCES core.plants, code text NOT NULL, name text NOT NULL, geometry jsonb NOT NULL DEFAULT '{}', UNIQUE(plant_id,code), UNIQUE(plant_id,id));
CREATE TABLE core.work_centers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL REFERENCES core.plants, area_id uuid, code text NOT NULL, name text NOT NULL, UNIQUE(plant_id,code), UNIQUE(plant_id,id), FOREIGN KEY(plant_id,area_id) REFERENCES core.areas(plant_id,id));
CREATE TABLE core.resources(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL, work_center_id uuid NOT NULL, code text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(plant_id,code), UNIQUE(plant_id,id), FOREIGN KEY(plant_id,work_center_id) REFERENCES core.work_centers(plant_id,id));
CREATE TABLE core.resource_calendar(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resource_id uuid NOT NULL REFERENCES core.resources, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, available boolean NOT NULL DEFAULT true, CHECK(ends_at>starts_at));

CREATE TABLE plm.items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL, kind text NOT NULL CHECK(kind IN ('material','product','assembly')), uom text NOT NULL CHECK(uom IN ('un','m','kg','l')), active boolean NOT NULL DEFAULT true);
CREATE TABLE plm.revisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES plm.items, code text NOT NULL, state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','review','released','obsolete')), description text, released_by uuid REFERENCES core.users, released_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(item_id,code), CHECK((state IN ('released','obsolete'))=(released_at IS NOT NULL)), CHECK(released_at IS NULL OR released_by IS NOT NULL));
CREATE TABLE plm.bom_lines(revision_id uuid NOT NULL REFERENCES plm.revisions, component_id uuid NOT NULL REFERENCES plm.items, quantity numeric(18,4) NOT NULL CHECK(quantity>0), scrap_factor numeric(8,5) NOT NULL DEFAULT 0 CHECK(scrap_factor BETWEEN 0 AND 1), PRIMARY KEY(revision_id,component_id));
CREATE TABLE plm.routing_steps(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL REFERENCES plm.revisions, sequence integer NOT NULL CHECK(sequence>0), work_center_id uuid NOT NULL REFERENCES core.work_centers, setup_minutes numeric(12,3) NOT NULL DEFAULT 0 CHECK(setup_minutes>=0), unit_minutes numeric(12,3) NOT NULL CHECK(unit_minutes>0), instructions text, UNIQUE(revision_id,sequence));
CREATE TABLE plm.documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), revision_id uuid NOT NULL REFERENCES plm.revisions, name text NOT NULL, object_key text NOT NULL, sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE ppcp.orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL REFERENCES core.plants, code text NOT NULL, customer_reference text NOT NULL, revision_id uuid NOT NULL REFERENCES plm.revisions, quantity numeric(18,4) NOT NULL CHECK(quantity>0), due_at timestamptz NOT NULL, priority integer NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','released','running','paused','completed','cancelled')), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, version integer NOT NULL DEFAULT 1 CHECK(version>0), UNIQUE(plant_id,code), UNIQUE(plant_id,id), CHECK((status='completed')=(completed_at IS NOT NULL)));
CREATE TABLE ppcp.order_materials(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES ppcp.orders, item_id uuid NOT NULL REFERENCES plm.items, required_quantity numeric(18,4) NOT NULL CHECK(required_quantity>0), UNIQUE(order_id,item_id));
CREATE TABLE mes.operations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL, order_id uuid NOT NULL, work_center_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>0), setup_minutes numeric(12,3) NOT NULL CHECK(setup_minutes>=0), run_minutes numeric(12,3) NOT NULL CHECK(run_minutes>0), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','completed')), good_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK(good_quantity>=0), scrap_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK(scrap_quantity>=0), started_at timestamptz, completed_at timestamptz, UNIQUE(order_id,sequence), UNIQUE(plant_id,id), FOREIGN KEY(plant_id,order_id) REFERENCES ppcp.orders(plant_id,id), FOREIGN KEY(plant_id,work_center_id) REFERENCES core.work_centers(plant_id,id), CHECK(completed_at IS NULL OR (started_at IS NOT NULL AND completed_at>=started_at)));
CREATE TABLE mes.production_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, operation_id uuid NOT NULL REFERENCES mes.operations, operator_id uuid NOT NULL REFERENCES core.users, event_type text NOT NULL CHECK(event_type IN ('start','pause','resume','good','scrap','complete')), quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK(quantity>=0), occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), idempotency_key uuid NOT NULL UNIQUE, details jsonb NOT NULL DEFAULT '{}');
CREATE TABLE mes.downtimes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resource_id uuid NOT NULL REFERENCES core.resources, reason_code text NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz, planned boolean NOT NULL DEFAULT false, CHECK(ends_at IS NULL OR ends_at>starts_at));
CREATE UNIQUE INDEX downtime_one_open ON mes.downtimes(resource_id) WHERE ends_at IS NULL;
CREATE TABLE mes.quality_checks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_id uuid NOT NULL REFERENCES mes.operations, checked_by uuid NOT NULL REFERENCES core.users, test_code text NOT NULL, result text NOT NULL CHECK(result IN ('passed','failed','waived')), measurement numeric, uom text, evidence_key text, checked_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE aps.scenarios(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL REFERENCES core.plants, name text NOT NULL, rule text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','archived')), created_by uuid NOT NULL REFERENCES core.users, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(plant_id,id));
CREATE TABLE aps.allocations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL, scenario_id uuid NOT NULL, operation_id uuid NOT NULL, resource_id uuid NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, FOREIGN KEY(plant_id,scenario_id) REFERENCES aps.scenarios(plant_id,id), FOREIGN KEY(plant_id,operation_id) REFERENCES mes.operations(plant_id,id), FOREIGN KEY(plant_id,resource_id) REFERENCES core.resources(plant_id,id), UNIQUE(scenario_id,operation_id), CHECK(ends_at>starts_at));
-- Uma linha por recurso físico. Serialização por cenário evita colisões concorrentes.
CREATE FUNCTION aps.validate_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM aps.scenarios WHERE id=NEW.scenario_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM mes.operations o JOIN core.resources r ON r.work_center_id=o.work_center_id WHERE o.id=NEW.operation_id AND r.id=NEW.resource_id AND r.active) THEN RAISE EXCEPTION 'Recurso incompatível com a operação'; END IF;
 IF EXISTS(SELECT 1 FROM aps.allocations a WHERE a.scenario_id=NEW.scenario_id AND a.resource_id=NEW.resource_id AND a.id<>NEW.id AND tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(NEW.starts_at,NEW.ends_at,'[)')) THEN RAISE EXCEPTION 'Sobreposição de capacidade'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER allocation_capacity BEFORE INSERT OR UPDATE ON aps.allocations FOR EACH ROW EXECUTE FUNCTION aps.validate_allocation();

CREATE TABLE wms.locations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL REFERENCES core.plants, code text NOT NULL, kind text NOT NULL CHECK(kind IN ('receiving','storage','production','shipping','quarantine')), UNIQUE(plant_id,code), UNIQUE(plant_id,id));
CREATE TABLE wms.balances(plant_id uuid NOT NULL, location_id uuid NOT NULL, item_id uuid NOT NULL REFERENCES plm.items, lot text NOT NULL DEFAULT '', on_hand numeric(18,4) NOT NULL DEFAULT 0 CHECK(on_hand>=0), reserved numeric(18,4) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand), PRIMARY KEY(plant_id,location_id,item_id,lot), FOREIGN KEY(plant_id,location_id) REFERENCES wms.locations(plant_id,id));
CREATE TABLE wms.reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plant_id uuid NOT NULL, order_id uuid NOT NULL, location_id uuid NOT NULL, item_id uuid NOT NULL, lot text NOT NULL DEFAULT '', quantity numeric(18,4) NOT NULL CHECK(quantity>0), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','consumed','released')), idempotency_key uuid NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(plant_id,order_id) REFERENCES ppcp.orders(plant_id,id), FOREIGN KEY(plant_id,location_id,item_id,lot) REFERENCES wms.balances);
CREATE TABLE wms.movements(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, plant_id uuid NOT NULL, location_id uuid NOT NULL, item_id uuid NOT NULL, lot text NOT NULL DEFAULT '', quantity numeric(18,4) NOT NULL CHECK(quantity<>0), kind text NOT NULL CHECK(kind IN ('receipt','consumption','adjustment','transfer')), order_id uuid, reservation_id uuid UNIQUE REFERENCES wms.reservations, reference text NOT NULL, idempotency_key uuid NOT NULL UNIQUE, actor_id uuid NOT NULL REFERENCES core.users, occurred_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(plant_id,location_id,item_id,lot) REFERENCES wms.balances, FOREIGN KEY(plant_id,order_id) REFERENCES ppcp.orders(plant_id,id));

CREATE TABLE audit.events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, table_name text NOT NULL, action text NOT NULL, actor_subject text, db_user text NOT NULL DEFAULT session_user, at timestamptz NOT NULL DEFAULT now(), old_row jsonb, new_row jsonb);
CREATE FUNCTION audit.capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO audit.events(table_name,action,actor_subject,old_row,new_row) VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,TG_OP,current_setting('app.actor',true),CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END);
 RETURN NULL;
END $$;
CREATE FUNCTION core.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Registro imutável; registre um novo evento compensatório'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit.events FOR EACH ROW EXECUTE FUNCTION core.immutable_record();
CREATE TRIGGER movements_immutable BEFORE UPDATE OR DELETE ON wms.movements FOR EACH ROW EXECUTE FUNCTION core.immutable_record();
CREATE TRIGGER production_immutable BEFORE UPDATE OR DELETE ON mes.production_events FOR EACH ROW EXECUTE FUNCTION core.immutable_record();

CREATE FUNCTION plm.protect_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state IN ('released','obsolete') THEN RAISE EXCEPTION 'Revisão liberada é imutável; crie outra revisão'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revision_freeze BEFORE UPDATE OR DELETE ON plm.revisions FOR EACH ROW EXECUTE FUNCTION plm.protect_revision();
CREATE FUNCTION plm.protect_structure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
 rid=CASE WHEN TG_OP='DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
 PERFORM 1 FROM plm.revisions WHERE id=rid FOR UPDATE;
 IF EXISTS(SELECT 1 FROM plm.revisions WHERE id=rid AND state IN ('released','obsolete')) THEN RAISE EXCEPTION 'Estrutura de revisão liberada é imutável'; END IF;
 IF TG_OP='UPDATE' AND OLD.revision_id<>NEW.revision_id THEN RAISE EXCEPTION 'Não é permitido mover estruturas entre revisões'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER bom_freeze BEFORE INSERT OR UPDATE OR DELETE ON plm.bom_lines FOR EACH ROW EXECUTE FUNCTION plm.protect_structure();
CREATE TRIGGER route_freeze BEFORE INSERT OR UPDATE OR DELETE ON plm.routing_steps FOR EACH ROW EXECUTE FUNCTION plm.protect_structure();
CREATE TRIGGER documents_freeze BEFORE INSERT OR UPDATE OR DELETE ON plm.documents FOR EACH ROW EXECUTE FUNCTION plm.protect_structure();

-- Snapshot atômico da estrutura e roteiro na criação da OP.
CREATE FUNCTION ppcp.snapshot_order() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE vstate text;
BEGIN
 SELECT state INTO vstate FROM plm.revisions WHERE id=NEW.revision_id FOR SHARE;
 IF vstate IS DISTINCT FROM 'released' THEN RAISE EXCEPTION 'OP exige revisão liberada'; END IF;
 IF NOT EXISTS(SELECT 1 FROM plm.routing_steps WHERE revision_id=NEW.revision_id) THEN RAISE EXCEPTION 'Roteiro vazio'; END IF;
 IF EXISTS(SELECT 1 FROM plm.routing_steps r JOIN core.work_centers c ON c.id=r.work_center_id WHERE r.revision_id=NEW.revision_id AND c.plant_id<>NEW.plant_id) THEN RAISE EXCEPTION 'Roteiro pertence a outra planta'; END IF;
 INSERT INTO ppcp.order_materials(order_id,item_id,required_quantity) SELECT NEW.id,component_id,quantity*(1+scrap_factor)*NEW.quantity FROM plm.bom_lines WHERE revision_id=NEW.revision_id;
 INSERT INTO mes.operations(plant_id,order_id,work_center_id,sequence,setup_minutes,run_minutes) SELECT NEW.plant_id,NEW.id,work_center_id,sequence,setup_minutes,unit_minutes*NEW.quantity FROM plm.routing_steps WHERE revision_id=NEW.revision_id;
 RETURN NEW;
END $$;
CREATE TRIGGER order_snapshot AFTER INSERT ON ppcp.orders FOR EACH ROW EXECUTE FUNCTION ppcp.snapshot_order();
CREATE FUNCTION ppcp.protect_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision_id<>OLD.revision_id OR NEW.quantity<>OLD.quantity OR NEW.plant_id<>OLD.plant_id THEN RAISE EXCEPTION 'Quantidade, planta e revisão congeladas; cancele e crie nova OP'; END IF;
 NEW.version=OLD.version+1; RETURN NEW;
END $$;
CREATE TRIGGER order_identity BEFORE UPDATE ON ppcp.orders FOR EACH ROW EXECUTE FUNCTION ppcp.protect_order_identity();

-- Escritas WMS usam funções. A role da API não recebe DML direto nessas tabelas.
-- Advisory lock serializa repetições da mesma chave de idempotência.
CREATE FUNCTION wms.receive_stock(p_plant uuid,p_location uuid,p_item uuid,p_lot text,p_qty numeric,p_reference text,p_key uuid,p_actor uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE result bigint; prior wms.movements;
BEGIN
 IF p_qty IS NULL OR p_qty<=0 THEN RAISE EXCEPTION 'Quantidade deve ser positiva'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text,0));
 SELECT * INTO prior FROM wms.movements WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF prior.kind<>'receipt' OR (prior.plant_id,prior.location_id,prior.item_id,prior.lot,prior.quantity,prior.reference,prior.actor_id) IS DISTINCT FROM (p_plant,p_location,p_item,p_lot,p_qty,p_reference,p_actor) THEN RAISE EXCEPTION 'Chave de idempotência reutilizada com outro conteúdo'; END IF;
  RETURN prior.id;
 END IF;
 INSERT INTO wms.balances(plant_id,location_id,item_id,lot,on_hand) VALUES(p_plant,p_location,p_item,p_lot,p_qty) ON CONFLICT(plant_id,location_id,item_id,lot) DO UPDATE SET on_hand=wms.balances.on_hand+EXCLUDED.on_hand;
 INSERT INTO wms.movements(plant_id,location_id,item_id,lot,quantity,kind,reference,idempotency_key,actor_id) VALUES(p_plant,p_location,p_item,p_lot,p_qty,'receipt',p_reference,p_key,p_actor) RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION wms.reserve_stock(p_order uuid,p_location uuid,p_item uuid,p_lot text,p_qty numeric,p_key uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE vplant uuid; result uuid; prior wms.reservations; required numeric; allocated numeric;
BEGIN
 IF p_qty IS NULL OR p_qty<=0 THEN RAISE EXCEPTION 'Quantidade deve ser positiva'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text,0));
 SELECT * INTO prior FROM wms.reservations WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF (prior.order_id,prior.location_id,prior.item_id,prior.lot,prior.quantity) IS DISTINCT FROM (p_order,p_location,p_item,p_lot,p_qty) THEN RAISE EXCEPTION 'Chave de idempotência reutilizada com outro conteúdo'; END IF;
  RETURN prior.id;
 END IF;
 SELECT plant_id INTO vplant FROM ppcp.orders WHERE id=p_order AND status IN ('draft','released','running','paused') FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Ordem inexistente ou encerrada'; END IF;
 SELECT required_quantity INTO required FROM ppcp.order_materials WHERE order_id=p_order AND item_id=p_item;
 SELECT coalesce(sum(quantity),0) INTO allocated FROM wms.reservations WHERE order_id=p_order AND item_id=p_item AND status IN ('active','consumed');
 IF required IS NULL OR allocated+p_qty>required THEN RAISE EXCEPTION 'Reserva excede necessidade da OP'; END IF;
 UPDATE wms.balances SET reserved=reserved+p_qty WHERE plant_id=vplant AND location_id=p_location AND item_id=p_item AND lot=p_lot AND on_hand-reserved>=p_qty;
 IF NOT FOUND THEN RAISE EXCEPTION 'Saldo disponível insuficiente'; END IF;
 INSERT INTO wms.reservations(plant_id,order_id,location_id,item_id,lot,quantity,idempotency_key) VALUES(vplant,p_order,p_location,p_item,p_lot,p_qty,p_key) RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION wms.consume_reservation(p_id uuid,p_key uuid,p_actor uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r wms.reservations; prior wms.movements; result bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_key::text,0));
 SELECT * INTO prior FROM wms.movements WHERE idempotency_key=p_key;
 IF FOUND THEN
  IF prior.kind<>'consumption' OR prior.reservation_id IS DISTINCT FROM p_id OR prior.actor_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'Chave de idempotência reutilizada com outro conteúdo'; END IF;
  RETURN prior.id;
 END IF;
 SELECT * INTO r FROM wms.reservations WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR r.status<>'active' THEN RAISE EXCEPTION 'Reserva inexistente ou não ativa'; END IF;
 UPDATE wms.balances SET on_hand=on_hand-r.quantity,reserved=reserved-r.quantity WHERE plant_id=r.plant_id AND location_id=r.location_id AND item_id=r.item_id AND lot=r.lot;
 UPDATE wms.reservations SET status='consumed' WHERE id=p_id;
 INSERT INTO wms.movements(plant_id,location_id,item_id,lot,quantity,kind,order_id,reservation_id,reference,idempotency_key,actor_id) VALUES(r.plant_id,r.location_id,r.item_id,r.lot,-r.quantity,'consumption',r.order_id,r.id,'Reserva '||r.id,p_key,p_actor) RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION wms.release_reservation(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r wms.reservations;
BEGIN
 SELECT * INTO r FROM wms.reservations WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reserva inexistente'; END IF;
 IF r.status='released' THEN RETURN; END IF;
 IF r.status<>'active' THEN RAISE EXCEPTION 'Reserva já consumida'; END IF;
 UPDATE wms.balances SET reserved=reserved-r.quantity WHERE plant_id=r.plant_id AND location_id=r.location_id AND item_id=r.item_id AND lot=r.lot;
 UPDATE wms.reservations SET status='released' WHERE id=p_id;
END $$;

CREATE VIEW wms.stock_position AS SELECT b.*,b.on_hand-b.reserved AS available,i.code AS item_code,i.name AS item_name,i.uom,l.code AS location_code FROM wms.balances b JOIN plm.items i ON i.id=b.item_id JOIN wms.locations l ON l.id=b.location_id;
CREATE VIEW mes.floor_status AS SELECT o.plant_id,o.work_center_id,count(*) FILTER(WHERE o.status='running') AS running,count(*) FILTER(WHERE o.status='queued') AS queued,count(*) FILTER(WHERE o.status='paused') AS paused FROM mes.operations o JOIN ppcp.orders p ON p.id=o.order_id WHERE p.status NOT IN ('draft','completed','cancelled') GROUP BY o.plant_id,o.work_center_id;
CREATE INDEX orders_queue ON ppcp.orders(plant_id,status,priority,due_at);
CREATE INDEX operations_center ON mes.operations(plant_id,work_center_id,status);
CREATE INDEX production_timeline ON mes.production_events(operation_id,occurred_at);
CREATE INDEX reservations_order ON wms.reservations(order_id,status);
CREATE INDEX movements_item ON wms.movements(plant_id,item_id,occurred_at DESC);
CREATE INDEX audit_timeline ON audit.events(table_name,at DESC);
CREATE INDEX allocations_timeline ON aps.allocations(scenario_id,resource_id,starts_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['plm.revisions','plm.bom_lines','plm.routing_steps','ppcp.orders','mes.operations','mes.production_events','mes.downtimes','mes.quality_checks','wms.balances','wms.reservations','wms.movements','aps.scenarios','aps.allocations'] LOOP
 EXECUTE format('CREATE TRIGGER change_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION audit.capture()',t);
 END LOOP;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wms,audit FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
INSERT INTO core.schema_migrations(version) VALUES(1);
COMMIT;
