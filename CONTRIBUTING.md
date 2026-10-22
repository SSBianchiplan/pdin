# Como contribuir com o GPlanSiS|PDIN

Obrigado pelo interesse! Este guia explica como propor mudanças de forma que a revisão seja rápida.

## Antes de começar
- Leia o [código de conduta](CODE_OF_CONDUCT.md).
- Para mudanças maiores que uma correção pontual, **abra uma issue primeiro** (modelos "Ideia" ou "Bug") e combine a abordagem.
- Falhas de segurança **não** vão em issue pública: siga a [política de segurança](SECURITY.md).

## Ambiente de desenvolvimento
```bash
docker compose up -d                      # PostgreSQL demo em 127.0.0.1:5437 (ou use um PostgreSQL local, ver README)
python3 -m venv .venv
.venv/bin/pip install -r api/requirements.txt
PDIN_MASTER_EMAIL=admin@exemplo.com PDIN_MASTER_PASSWORD='SenhaProvisoria123' \
.venv/bin/uvicorn api.main:app --host 127.0.0.1 --port 18380 --reload
```
Abra <http://127.0.0.1:18380>. O frontend não tem etapa de build: edite e recarregue (se o service worker segurar uma versão antiga, use recarga forçada ou desregistre-o nas ferramentas do navegador).

## Organização do código
- `simulation.js` — motor operacional (apontamento, capacidade, picking, MRP, APS). Puro e testável em Node.
- `app.js` / `modules.js` / `index.html` / `app.css` — shell e telas dos módulos.
- `templates.js` — projetos de demonstração; depois de alterar, rode `node tools/build-seed.cjs` para regenerar `database/900_demo_projects.sql`.
- `twin.html` — gêmeo digital 3D (three.js), conversa com o shell por `postMessage`.
- `api/main.py` / `api/auth.py` — API FastAPI; regras de negócio críticas ficam em funções do PostgreSQL (`database/`).
- `database/` — migrações numeradas; nunca edite uma migração já publicada, crie a próxima.

## Regras do projeto
- **Interface em português do Brasil**, textos curtos e diretos.
- **Sem build no frontend** e sem CDN: tudo é servido localmente.
- **Nada avança sem apontamento**: o motor não pode mover ordens sozinho.
- **Invariante no banco**: saldos, reservas, revisões e eventos são protegidos por funções e restrições do PostgreSQL, não só pela interface.
- **Telemetria é somente leitura**: nenhuma escrita em PLC.
- **Somente dados fictícios**: nunca inclua dados reais de clientes, empresas, pessoas, P&IDs, listas de instrumentos, modelos 3D de terceiros, `.env` ou dumps de banco em commits ou capturas.

## Testes antes do PR
```bash
node --test tests/simulation.test.js
PDIN_USER=admin@exemplo.com PDIN_PASSWORD='<senha>' node --test tests/api.test.js
psql -h 127.0.0.1 -p 5437 -U pdin_owner -d pdin_demo -f tests/database.sql
python -m py_compile api/*.py tools/*.py
```

## Pull requests
1. Faça um fork e crie uma branch a partir de `main` (`feat/…`, `fix/…`, `docs/…`).
2. Commits pequenos, com mensagem no imperativo explicando o porquê.
3. Preencha o modelo do PR: o que mudou, como testou, capturas se mexer na interface.

## Dúvidas
Abra uma issue com o modelo "Pergunta" ou escreva para contato@gplansis.com.
