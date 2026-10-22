# Validação executada · 2026-09-20 (v3 · modo operacional)

Ambiente: PostgreSQL 18 Alpine em contêiner `pdin-db` (compose `pdin`), banco `pdin_demo`, bind `127.0.0.1:5437`. API FastAPI local em `127.0.0.1:18380`. Microsoft Edge headless via protocolo DevTools (aba nova por execução).

Resultados:

- Migrações `001`–`005`: aplicadas; `core.schema_migrations` = {1, 3, 4, 5}.
- `900_demo_projects.sql`: 4 projetos com ordens em carteira, planejadas, liberadas (picking pendente), em produção, pausadas e concluídas, com apontamentos retroativos.
- `tests/simulation.test.js` (Node): 14/14 — nada avança sem apontamento; ciclo completo com interlock de picking e conservação de estoque; capacidade finita por posição; parada/falha/reparo; pausa preserva tempo; NC gera laço de retrabalho; transições do Kanban; cancelamento; pendências + MRP; APS sem sobreposição respeitando `notBefore`, pino de recurso e operação em andamento; perfil de carga; PLM com importação de BOM e congelamento por ordem; faixas de KPI/OEE.
- `tests/api.test.js`: reconciliação de kits já entregues e apontamentos semeados; OP criada no banco e concluída no motor vira `completed` com todas as `mes.operations` concluídas e reservas consumidas; recebimento idempotente; BOM importada cria item, revisão em análise e liberação; OP sem saldo rejeitada (409); portfólio.
- `tests/browser.cjs`: boot sem controles de simulação; 10 módulos; OP criada abre a gaveta; planejamento na gaveta (prazo, início, prioridade, recurso) recalcula o plano; apontamento pela gaveta com bloqueio de conclusão sem picking; Kanban drag muda status; Gantt drag fixa início e empurra as operações seguintes; clique na barra abre a gaveta; importação de BOM com item novo e liberação; pendência de material desabilita picking e gera alarme; falha/reparo; novo projeto pela UI; portfólio com 6 projetos e abertura de OP de outro projeto; tema claro propagado ao 3D; arquivamento; zero erros de console.
- `tests/database.sql`: OP com numeração/snapshot/reservas; rejeição atômica sem saldo; snapshot v3 reconcilia consumo, recebimento, status, prioridade e apontamentos reais em `mes.operations` de forma idempotente; revisão com delta, imutabilidade após liberação; movimentos/auditoria imutáveis; role da API sem DML em saldos.

Pendências para produção: autenticação, credencial própria da role da API, backup/PITR, carga concorrente, RLS multi-planta.
