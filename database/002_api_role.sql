-- Opcional: executar como administrador após 001_schema.sql.
-- Role sem login. A futura API recebe uma credencial própria no provisionamento.
BEGIN;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='astra_api') THEN CREATE ROLE astra_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;
GRANT USAGE ON SCHEMA core,plm,ppcp,mes,aps,wms,audit TO astra_api;
GRANT SELECT ON ALL TABLES IN SCHEMA core,plm,ppcp,mes,aps,wms TO astra_api;
GRANT INSERT,UPDATE ON core.users,core.memberships,core.areas,core.work_centers,core.resources,core.resource_calendar,plm.items,plm.revisions,plm.bom_lines,plm.routing_steps,plm.documents,ppcp.orders,mes.operations,mes.downtimes,aps.scenarios,aps.allocations TO astra_api;
GRANT INSERT ON mes.production_events,mes.quality_checks TO astra_api;
-- Snapshot de materiais criado exclusivamente pelo trigger SECURITY DEFINER da OP.
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA mes TO astra_api;
GRANT EXECUTE ON FUNCTION wms.receive_stock(uuid,uuid,uuid,text,numeric,text,uuid,uuid),wms.reserve_stock(uuid,uuid,uuid,text,numeric,uuid),wms.consume_reservation(uuid,uuid,uuid),wms.release_reservation(uuid) TO astra_api;
-- Sem permissão de UPDATE/DELETE em eventos nem DML em saldos/reservas/movimentos.
-- Autorização por planta e usuário pertence à API confiável; esta role NÃO é multi-tenant/RLS.
COMMIT;
