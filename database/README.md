# Banco PostgreSQL · GPlanSiS|PDIN

Migrações versionadas em `core.schema_migrations`. Testado em PostgreSQL 18 (compatível com 16+).

| Arquivo | Conteúdo |
|---|---|
| `001_schema.sql` | Fundação: plantas, centros, recursos, itens, revisões, BOM, roteiros, ordens, operações, eventos imutáveis, estoque por local com funções transacionais (`wms.receive_stock`, `reserve_stock`, `consume_reservation`, `release_reservation`), APS com validação de sobreposição, auditoria imutável |
| `002_api_role.sql` | Role `astra_api` sem login, sem DML direto em saldos/movimentos/eventos |
| `003_projects.sql` | `core.projects` (uma planta por projeto, numeração de OP serializada), `core.project_snapshots` (estado do motor), `core.create_project(jsonb)`, `ppcp.create_order(...)`, `core.save_snapshot(uuid,jsonb)`, `plm.propose_revision`, `plm.release_revision`, `plm.current_revision`, view `core.project_overview` |
| `004_operational.sql` | Modo operacional: `save_snapshot` v3 (status do PCP, apontamentos reais em `mes.operations`, itens importados), `plm.import_bom` |
| `005_iot.sql` | Schema `iot`: tags por projeto/recurso, amostras imutáveis, último valor, `iot.ingest` idempotente por (tag, at), `iot.sync_tags`; `create_project` passa a honrar recursos nomeados (ex.: `TQ-01`) |
| `900_demo_projects.sql` | Quatro projetos demo (fictícios). **Gerado** por `node tools/build-seed.cjs` a partir de `templates.js`. Recusa bancos sem sufixo `_demo`; idempotente |
| `reference_layout.sql` | Planta `PLANTA-DEMO` com 44 áreas e 12 centros extraídos do HTML original (opcional) |

## Subir o banco demo

```powershell
$env:PDIN_DB_PASSWORD = 'sua-senha'   # opcional; padrão local: pdin_demo_local
docker compose up -d
```

Banco `pdin_demo`, usuário `pdin_owner`, `127.0.0.1:5437`, volume `pdin_pgdata`. Os scripts do `docker-entrypoint-initdb.d` rodam apenas na criação do volume. Para recomeçar do zero: `docker compose down -v && docker compose up -d`.

## Modelo de reconciliação motor ↔ relacional

1. **Criação** de projeto/OP/revisão/importação de BOM acontece primeiro no banco (`create_project`, `create_order`, `propose_revision`, `import_bom`, `release_revision`) e é espelhada no motor.
2. O motor grava **snapshots** (`save_snapshot`). A função reconcilia: recebimentos do motor viram `wms.receive_stock` com chave de idempotência derivada do id do movimento; ordens com `consumed=true` consomem suas reservas ativas; ordens canceladas liberam reservas; status/prazo/prioridade de `ppcp.orders` seguem o snapshot (carteira/planejada → `draft`); `mes.operations` recebe início, fim, boas e refugo reais de cada apontamento.
3. Invariantes permanecem nas tabelas: saldo ≥ reservado ≥ 0, revisão liberada imutável, movimentos e eventos imutáveis, OP só com revisão liberada e roteiro da própria planta, reserva limitada à necessidade da OP.

## Consultas úteis

```sql
SELECT code,name,open_orders,completed_orders,sim_time,saved_at FROM core.project_overview;
SELECT item_code,on_hand,reserved,available FROM wms.stock_position WHERE plant_id=(SELECT plant_id FROM core.projects WHERE code='PAINEIS-ADV');
SELECT table_name,action,at FROM audit.events ORDER BY id DESC LIMIT 20;
```

## Produção

- Substitua a senha padrão e a URL (`PDIN_DATABASE_URL`); use a role `astra_api` com credencial própria em vez do owner.
- Multi-tenant/RLS, autenticação, backup/PITR, testes de carga e réplica não fazem parte desta entrega.
