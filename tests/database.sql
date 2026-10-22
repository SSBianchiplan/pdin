-- Invariantes do banco GPlanSiS|PDIN. Requer 003_projects.sql e o seed 900 (projeto PAINEIS-ADV). Tudo em ROLLBACK.
-- Uso: docker exec -i pdin-db psql -U pdin_owner -d pdin_demo -v ON_ERROR_STOP=1 -f - < tests/database.sql
BEGIN;
DO $$
DECLARE pr uuid; pl uuid; o jsonb; oid uuid; n integer; item uuid; loc uuid; before numeric; rev jsonb; snap jsonb; res jsonb; mid integer; qty0 numeric;
BEGIN
 SELECT id,plant_id INTO pr,pl FROM core.projects WHERE code='PAINEIS-ADV';
 IF pr IS NULL THEN RAISE EXCEPTION 'Projeto demo ausente'; END IF;
 SELECT id INTO loc FROM wms.locations WHERE plant_id=pl AND code='ALM-01';

 -- 1) OP: numeração por projeto, snapshot de materiais/operações e reserva atômica
 o=ppcp.create_order(pr,'QGBT','Teste SQL',2,now()+interval '2 days',50);
 oid=(o->>'id')::uuid;
 IF o->>'code' !~ '^OP-\d{4}$' THEN RAISE EXCEPTION 'Código de OP inválido: %',o->>'code'; END IF;
 SELECT count(*) INTO n FROM mes.operations WHERE order_id=oid; IF n<>12 THEN RAISE EXCEPTION 'Roteiro QGBT deveria ter 12 operações, tem %',n; END IF;
 SELECT count(*) INTO n FROM ppcp.order_materials WHERE order_id=oid; IF n<>6 THEN RAISE EXCEPTION 'BOM QGBT deveria ter 6 itens, tem %',n; END IF;
 SELECT count(*) INTO n FROM wms.reservations WHERE order_id=oid AND status='active'; IF n<>6 THEN RAISE EXCEPTION 'Kit deveria ter 6 reservas ativas, tem %',n; END IF;
 SELECT id INTO item FROM plm.items WHERE code='INV-001';
 BEGIN PERFORM wms.reserve_stock(oid,loc,item,'',1,gen_random_uuid()); RAISE EXCEPTION 'TEST_FAIL: reserva acima da necessidade aceita'; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF; END;

 -- 2) Saldo insuficiente é rejeitado atomicamente (OP não fica criada)
 SELECT count(*) INTO n FROM ppcp.orders WHERE plant_id=pl;
 BEGIN PERFORM ppcp.create_order(pr,'CDC','Sem saldo',50,now()+interval '1 day',50); RAISE EXCEPTION 'TEST_FAIL: OP sem saldo aceita'; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM ppcp.orders WHERE plant_id=pl)<>n THEN RAISE EXCEPTION 'OP rejeitada deixou resíduo'; END IF;

 -- 3) Snapshot reconcilia: consumo de reservas e recebimento idempotente
 SELECT on_hand INTO before FROM wms.balances WHERE plant_id=pl AND item_id=item;
 SELECT coalesce(max(synced_movement),0)+1 INTO mid FROM core.project_snapshots WHERE project_id=pr; -- movimento ainda não sincronizado
 snap=jsonb_build_object('version',3,'time',extract(epoch from now())/60,
  'stock',jsonb_build_array(jsonb_build_object('code','INV-001')),
  'movements',jsonb_build_array(jsonb_build_object('id',mid,'type','Recebimento','item',0,'qty',5,'ref','Teste SQL')),
  'orders',jsonb_build_array(jsonb_build_object('id',o->>'code','status','running','step',3,'priority','Urgente','consumed',true,
    'ops',jsonb_build_array(jsonb_build_object('seq',1,'status','done','start',extract(epoch from now())/60-200,'end',extract(epoch from now())/60-150,'good',2,'scrap',0),
                            jsonb_build_object('seq',2,'status','done','start',extract(epoch from now())/60-150,'end',extract(epoch from now())/60-100,'good',2,'scrap',0),
                            jsonb_build_object('seq',3,'status','done','start',extract(epoch from now())/60-100,'end',extract(epoch from now())/60-50,'good',2,'scrap',0),
                            jsonb_build_object('seq',4,'status','running','start',extract(epoch from now())/60-40,'good',0,'scrap',0)))));
 res=core.save_snapshot(pr,snap);
 IF (res->>'consumed')::int<>6 OR (res->>'receipts')::int<>1 THEN RAISE EXCEPTION 'Reconciliação inesperada: %',res; END IF;
 IF (SELECT count(*) FROM wms.reservations WHERE order_id=oid AND status='consumed')<>6 THEN RAISE EXCEPTION 'Reservas não consumidas'; END IF;
 IF (SELECT on_hand FROM wms.balances WHERE plant_id=pl AND item_id=item)<>before-2+5 THEN RAISE EXCEPTION 'Saldo físico incoerente após consumo (2) e recebimento (5)'; END IF;
 IF (SELECT status FROM ppcp.orders WHERE id=oid)<>'running' OR (SELECT priority FROM ppcp.orders WHERE id=oid)<>90 THEN RAISE EXCEPTION 'Status/prioridade da OP não sincronizados'; END IF;
 IF (SELECT count(*) FROM mes.operations WHERE order_id=oid AND status='completed')<>3 THEN RAISE EXCEPTION 'Operações concluídas deveriam ser 3'; END IF;
 IF (SELECT status FROM mes.operations WHERE order_id=oid AND sequence=4)<>'running' OR (SELECT started_at FROM mes.operations WHERE order_id=oid AND sequence=3) IS NULL THEN RAISE EXCEPTION 'Apontamentos reais não refletidos em mes.operations'; END IF;
 res=core.save_snapshot(pr,snap);
 IF (res->>'receipts')::int<>0 OR (res->>'consumed')::int<>0 THEN RAISE EXCEPTION 'Reconciliação não idempotente: %',res; END IF;

 -- 4) Engenharia: proposta copia BOM com delta, liberação congela, revisão liberada imutável
 SELECT quantity INTO qty0 FROM plm.bom_lines b JOIN plm.items i ON i.id=b.component_id WHERE b.revision_id=plm.current_revision(pl,'QGBT') AND i.code='CB-025';
 rev=plm.propose_revision(pr,'QGBT',jsonb_build_array(jsonb_build_object('item','CB-025','delta',2)));
 IF (SELECT quantity FROM plm.bom_lines b JOIN plm.items i ON i.id=b.component_id WHERE b.revision_id=(rev->>'id')::uuid AND i.code='CB-025')<>qty0+2 THEN RAISE EXCEPTION 'Delta de BOM não aplicado'; END IF;
 BEGIN PERFORM plm.propose_revision(pr,'QGBT','[]'); RAISE EXCEPTION 'TEST_FAIL: segunda proposta aceita'; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF; END;
 PERFORM plm.release_revision(pr,'QGBT');
 IF plm.current_revision(pl,'QGBT')<>(rev->>'id')::uuid THEN RAISE EXCEPTION 'Revisão liberada não é a vigente'; END IF;
 BEGIN UPDATE plm.bom_lines SET quantity=1 WHERE revision_id=(rev->>'id')::uuid; RAISE EXCEPTION 'TEST_FAIL: BOM liberada alterada'; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF; END;
 IF (SELECT revision_id FROM ppcp.orders WHERE id=oid)=(rev->>'id')::uuid THEN RAISE EXCEPTION 'OP existente mudou de revisão'; END IF;

 -- 5) Imutabilidade de movimentos e auditoria
 BEGIN DELETE FROM wms.movements WHERE plant_id=pl; RAISE EXCEPTION 'TEST_FAIL: movimento apagado'; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF; END;
 IF NOT EXISTS(SELECT 1 FROM audit.events WHERE table_name='ppcp.orders' AND new_row->>'id'=oid::text) THEN RAISE EXCEPTION 'Auditoria da OP ausente'; END IF;

 -- 6) Role da API não escreve saldos diretamente
 EXECUTE 'SET LOCAL ROLE astra_api';
 BEGIN UPDATE wms.balances SET on_hand=on_hand+1 WHERE plant_id=pl; RAISE EXCEPTION 'TEST_FAIL: role API alterou saldo'; EXCEPTION WHEN insufficient_privilege THEN NULL; WHEN OTHERS THEN IF SQLERRM LIKE 'TEST_FAIL:%' THEN RAISE; END IF; END;
 EXECUTE 'RESET ROLE';
 RAISE NOTICE 'Todos os testes de banco aprovados';
END $$;
ROLLBACK;
