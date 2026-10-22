<p align="center">
  <a href="https://pdin.gplansis.com"><img src=".github/capa.png" alt="GPlanSiS|PDIN — Planejamento Digital da Indústria" width="100%"></a>
</p>

<h1 align="center">GPlanSiS|PDIN</h1>

<p align="center">
  <strong>Planejamento Digital da Indústria: gêmeo digital 3D, MES, APS, PLM, PCP Kanban, almoxarifado, qualidade e manutenção sobre o mesmo PostgreSQL.</strong><br>
  Nada avança sem apontamento; o relógio é o relógio de parede.
</p>

<p align="center">
  <a href="https://pdin.gplansis.com"><img alt="No ar" src="https://img.shields.io/badge/no%20ar-pdin.gplansis.com-f0883e?style=flat-square"></a>
  <img alt="Versão" src="https://img.shields.io/badge/vers%C3%A3o-3.7.0-21262d?style=flat-square">
  <a href="LICENSE"><img alt="licença MIT" src="https://img.shields.io/badge/licen%C3%A7a-MIT-2ea44f?style=flat-square"></a>
  <img alt="Python" src="https://img.shields.io/badge/Python-3.12-21262d?style=flat-square&logo=python&logoColor=white">
  <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-PostgreSQL-21262d?style=flat-square&logo=fastapi&logoColor=white">
  <img alt="three.js" src="https://img.shields.io/badge/3D-three.js-21262d?style=flat-square&logo=threedotjs&logoColor=white">
  <img alt="PWA" src="https://img.shields.io/badge/PWA-instal%C3%A1vel-21262d?style=flat-square">
  <a href="CONTRIBUTING.md"><img alt="Contribuições bem-vindas" src="https://img.shields.io/badge/contribui%C3%A7%C3%B5es-bem--vindas-3fb950?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://pdin.gplansis.com"><b>➜ Abrir o GPlanSiS|PDIN em pdin.gplansis.com</b></a>
</p>

---

## O que é

O **GPlanSiS|PDIN** é um sistema **operacional** de planejamento e execução industrial que roda no navegador. Cada **projeto** é uma fábrica completa — setores com posições de recurso, produtos com roteiro e BOM, estoque, ordens de produção e histórico — e todos os módulos trabalham sobre o mesmo dado, persistido em **PostgreSQL**:

**Portfólio multiprojeto · Gêmeo digital 3D · MES · APS · PLM · PCP Kanban · WMS · Qualidade · Manutenção · Indicadores.**

Não existe modo "simulado" escondido: nenhuma ordem avança sem apontamento humano. O motor operacional roda no navegador, e o servidor persiste *snapshots* e **reconcilia o modelo relacional** a cada gravação (saldos, reservas, apontamentos, revisões de BOM).

O repositório traz **quatro fábricas de demonstração com dados fictícios** (painéis elétricos, envase de bebidas, usinagem CNC e papelão ondulado), cada uma com ordens em todas as situações — carteira, planejada, liberada com picking pendente, em produção, pausada e concluída — para validar o fluxo de ponta a ponta assim que o sistema sobe.

## Funcionalidades

### Planejamento e execução
- **Gaveta da OP** (clique em qualquer código de ordem, barra do Gantt ou cartão do Kanban): planejamento ao vivo (cliente, prazo, início planejado, prioridade, observações), posição na sequência, operações com recurso selecionável, datas planejadas × reais, apontamento (iniciar, pausar, retomar, concluir com boas/refugo, NC), materiais do kit, picking e histórico. Salvar recalcula o plano.
- **PCP · Kanban**: Carteira → Planejada → Liberada → Em produção → Pausada → Concluída. Arrastar entre colunas muda o status, com interlocks (só ordens em produção pausam; ordens com apontamento não voltam à carteira); arrastar dentro da coluna define a **sequência** usada pelo APS. Painel de MRP com necessidades.
- **APS**: Gantt por posição de recurso com linha do agora, sombreamento fora de turno e operações em execução ocupando a posição real. **Arrastar** uma operação fixa um novo início mínimo (soltar em outra pista troca o recurso) e empurra a programação. **Cinco regras comparadas**: sequência manual do PCP, EDD, SPT, razão crítica e FIFO.
- **Portfólio**: todos os projetos ativos no mesmo Gantt e **capacidade combinada** por setor e dia; clicar numa barra abre a OP no projeto correspondente.
- **MES**: filtros por setor e situação, apontamento direto na linha, quadro de setores com posições ocupadas, fila, OEE e paradas.

### Engenharia e materiais
- **PLM**: BOM e roteiro por produto; **importar BOM da engenharia** (colar ou CSV/TXT `código;descrição;unidade;qtd`) como revisão em análise — itens desconhecidos entram no catálogo com saldo zero e viram **pendência de material**; propor revisão por deltas, liberar (afeta só novas ordens) ou descartar.
- **WMS / Almoxarifado**: fila de **picking para produção**, pedidos de compra com recebimento, posição de estoque (físico, reservado, disponível, mínimo, cobertura, lead time) e movimentações. A operação de almoxarifado não conclui sem picking; estágios seguintes não iniciam sem kit.

### Qualidade, manutenção e chão de fábrica
- **Qualidade**: FPY por setor, NC manual que gera laço de retrabalho, conclusão com refugo.
- **Manutenção**: parada programada e falha com motivo/duração, reparo e disponibilidade por setor.
- **Gêmeo digital 3D** (three.js): WIP e posições ocupadas por setor, alarmes (andon), inspeção do setor com fila e ordens em execução; o tema acompanha o sistema.
- **Telemetria de campo (somente leitura)**: projetos podem declarar tags por estágio/recurso; o gateway `tools/opcua_gateway.py` lê OPC UA/MQTT (ou gera valores com `--simulate`) e envia para a API. As leituras são contextualizadas ao lote que ocupa o recurso e comparadas ao setpoint da receita. **Nenhuma escrita em PLC.**

### Plataforma
- **Login obrigatório**: sessão em cookie HttpOnly/SameSite=Lax (12 h, ou 30 dias com "manter conectado"), senhas com **scrypt**, bloqueio após 5 erros e limite por IP.
- **Perfis**: Administrador, Operador e Leitor (o servidor recusa escrita do leitor). **Master** único, sempre ativo, protegido por *trigger* no banco, com troca obrigatória de senha no 1º acesso.
- **Gestão de usuários** com senha provisória exibida uma vez, trilha de acesso (`auth.events`) e encerramento de sessões ao mudar perfil.
- **Página pública** (`landing.html`) com formulário de **pedido de demonstração** (`POST /api/leads`, isca contra robô, limite por IP) que o admin acompanha na tela *Usuários*.
- **PWA**: instalável; o service worker nunca faz cache de `/api` nem de `data/`; no celular a barra lateral vira gaveta.
- **Temas** escuro (padrão) e claro.

## Telas

| Gêmeo digital 3D | APS · Gantt com capacidade finita |
|---|---|
| ![Gêmeo digital da planta Aurora (fictícia) com setores, WIP e inspeção do setor](.github/telas/gemeo-digital.png) | ![Programação APS com cinco regras comparadas e Gantt por recurso](.github/telas/aps-gantt.png) |
| **PCP · Kanban** | **Portfólio multiprojeto** |
| ![Kanban do PCP com ordens por status e MRP](.github/telas/pcp-kanban.png) | ![Portfólio com todos os projetos no mesmo Gantt](.github/telas/portfolio.png) |

> Capturas feitas numa instância local com os projetos de demonstração do repositório (empresas e clientes fictícios).

## Arquitetura

```mermaid
flowchart LR
    subgraph Navegador
        UI["index.html · app.js · modules.js<br/>módulos, gaveta da OP, Kanban, Gantt"]
        SIM["simulation.js<br/>motor operacional determinístico"]
        TW["twin.html<br/>gêmeo 3D (three.js)"]
        SW["sw.js<br/>PWA"]
    end
    subgraph Servidor["Contêiner pdin-app"]
        API["FastAPI · api/main.py<br/>REST + estático com allowlist"]
        AUTH["api/auth.py<br/>sessões, perfis, leads"]
    end
    DB[("PostgreSQL<br/>core · ppcp · mes · wms · plm · iot · auth")]
    GW["tools/opcua_gateway.py<br/>OPC UA / MQTT (somente leitura)"]
    CADDY["Caddy<br/>TLS + proxy reverso"]

    UI --- SIM
    UI -- "postMessage" --- TW
    UI -- "GET /state · PUT /snapshot · POST /orders …" --> CADDY --> API
    API --- AUTH
    API -- "funções SECURITY DEFINER" --> DB
    GW -- "POST /telemetry (Bearer)" --> API
```

- **Motor no navegador, verdade no banco**: ordens, revisões e importações são criadas **primeiro no PostgreSQL** e espelhadas no motor; os *snapshots* (a cada 10 s e ao sair) são reconciliados no relacional (`save_snapshot`): recebimentos idempotentes, consumo de reservas no picking, status de `ppcp.orders`, apontamentos reais em `mes.operations`.
- **Invariantes no banco**: saldo ≥ reservado ≥ 0, revisão liberada imutável, movimentos e eventos imutáveis, OP só com revisão liberada.
- O servidor só entrega arquivos estáticos de uma *allowlist* de extensões e bloqueia `api/`, `database/`, `tests/`, `tools/`, `integration/`, `deploy/` e `.github/`.

## Stack

| Camada | Tecnologia |
|---|---|
| Frontend | HTML, CSS e JavaScript sem build; three.js (r128) no gêmeo 3D; PWA |
| Backend | Python 3.12, FastAPI, uvicorn, psycopg 3, Pydantic v2 |
| Banco | PostgreSQL 16+ (testado em 14 e 18), schemas `core`, `ppcp`, `mes`, `wms`, `plm`, `iot`, `auth` |
| Integração | Gateway OPC UA / MQTT em Python (opcional) |
| Testes | `node --test` (motor e API), SQL com `ROLLBACK`, navegador via DevTools Protocol |
| Implantação | Docker / Docker Compose, Caddy |

## Como rodar localmente

Requisitos: Python 3.12+, PostgreSQL 16+ (ou Docker), Node 20+ só para os testes, navegador com WebGL.

### 1. Banco

Com Docker (sobe PostgreSQL em `127.0.0.1:5437` e aplica migrações + seed demo):

```bash
docker compose up -d
```

Sem Docker, com um PostgreSQL local:

```bash
createdb -h 127.0.0.1 -p 5437 -U pdin_owner pdin_demo
for f in 001_schema 002_api_role 003_projects 004_operational 005_iot 900_demo_projects; do
  psql -h 127.0.0.1 -p 5437 -U pdin_owner -d pdin_demo -v ON_ERROR_STOP=1 -f database/$f.sql
done
```

> O seed `900_demo_projects.sql` só roda em banco com sufixo `_demo`. Ele é gerado a partir de `templates.js` por `node tools/build-seed.cjs`.

### 2. API + frontend

```bash
python3 -m venv .venv
.venv/bin/pip install -r api/requirements.txt

PDIN_DATABASE_URL=postgresql://pdin_owner:pdin_demo_local@127.0.0.1:5437/pdin_demo \
PDIN_MASTER_EMAIL=admin@exemplo.com \
PDIN_MASTER_PASSWORD='SenhaProvisoria123' \
.venv/bin/uvicorn api.main:app --host 127.0.0.1 --port 18380
```

Abra <http://127.0.0.1:18380>: a página pública aparece para visitantes; **Entrar** leva ao login. Use o e-mail e a senha acima e defina a nova senha (troca obrigatória no 1º acesso). Documentação da API em `/api/docs` (com sessão). A API aplica `006`–`008` (usuários, leads, telemetria simulada) na subida.

No Windows, `.\INICIAR.ps1` faz os dois passos (Docker + API); `.\INICIAR.ps1 -Local` serve só o frontend, que entra em **modo local** (persistência no navegador, sem API).

### Produção com Docker

```bash
cp .env.example .env        # preencha com seus valores
docker compose -f docker-compose.prod.yml up -d --build
# app em http://127.0.0.1:8940 — publique atrás de HTTPS (modelo em deploy/pdin.caddy)
```

### Testes

```bash
node --test tests/simulation.test.js                       # motor: 14 testes
PDIN_USER=admin@exemplo.com PDIN_PASSWORD='<sua senha>' \
  node --test --test-concurrency=1 tests/auth.test.js tests/api.test.js   # integração (API no ar)
psql -h 127.0.0.1 -p 5437 -U pdin_owner -d pdin_demo -f tests/database.sql   # invariantes do banco (ROLLBACK)
node tests/browser.cjs                                      # navegador via DevTools (porta 9224)
```

> `auth.test.js` troca a senha do master e derruba as outras sessões: rode-o numa base descartável.

## Estrutura de pastas

```
pdin/
├── index.html, app.css, app.js   # shell, temas, gaveta da OP, arrastar no Kanban e no Gantt
├── modules.js                    # telas dos módulos (MES, APS, PLM, PCP, WMS, qualidade, manutenção…)
├── simulation.js                 # motor operacional determinístico (testável em Node)
├── templates.js                  # projetos de demonstração (fonte única do seed e do modo local)
├── users.js                      # gestão de usuários e leads
├── twin.html, twin-enhancements.js, three.min.js   # gêmeo digital 3D
├── landing.html, landing/        # página pública e capturas
├── login.html, offline.html, sw.js, manifest.webmanifest, icons/   # login e PWA
├── api/
│   ├── main.py                   # API REST + estático com allowlist
│   ├── auth.py                   # sessões, perfis, master, leads
│   └── requirements.txt
├── database/                     # migrações 001–008, seed 900, layout de referência, notas
├── tools/
│   ├── build-seed.cjs            # gera database/900_demo_projects.sql de templates.js
│   ├── build-gateway-config.cjs  # gera integration/<projeto>-gateway.json
│   └── opcua_gateway.py          # gateway OPC UA/MQTT (somente leitura, --simulate)
├── tests/                        # motor, API, auth, banco e navegador
├── deploy/pdin.caddy             # bloco do Caddy
├── Dockerfile, compose.yaml, docker-compose.prod.yml, INICIAR.ps1
└── .env.example
```

## Variáveis de ambiente

| Variável | Uso | Padrão |
|---|---|---|
| `PDIN_DATABASE_URL` | Conexão PostgreSQL usada pela API | `postgresql://pdin_owner:pdin_demo_local@127.0.0.1:5437/pdin_demo` |
| `PDIN_DB_PASSWORD` | Senha do PostgreSQL nos arquivos Compose | `pdin_demo_local` (local); obrigatória em produção |
| `PDIN_MASTER_EMAIL` | E-mail do administrador master | `contato@gplansis.com` |
| `PDIN_MASTER_NAME` | Nome exibido do master | parte local do e-mail |
| `PDIN_MASTER_PASSWORD` | Senha provisória do master, usada só na criação | gerada e exibida no log |
| `PDIN_GATEWAY_TOKEN` | Token *Bearer* do gateway de telemetria | vazio (telemetria recusada) |
| `PDIN_API`, `PDIN_USER`, `PDIN_PASSWORD` | Usadas apenas pelos testes | — |

Modelo em [`.env.example`](.env.example). Nunca versione o `.env`.

## O que não está neste repositório

A instância em produção também atende projetos reais de clientes (modelos 3D de engenharia, listas de instrumentos e configurações de gateway). **Esses dados não são publicados.** Também ficaram de fora o pipeline de importação de NWD (depende de SDK comercial e licença de terceiros) e os modelos GLB. O código publicado funciona por completo com os projetos de demonstração e com o gêmeo 3D da planta ilustrativa.

## Contribua

O PDIN quer ser uma base aberta e séria para planejamento industrial — leve, sem build e com regra de negócio verificável no banco. **Toda ajuda conta**, de uma correção de texto a uma nova regra de sequenciamento.

**Por onde começar (boas primeiras issues):**
- 🧮 **APS**: setup dependente de sequência e respeito ao calendário de turnos nas durações (hoje o turno só aparece no Gantt).
- 📦 **WMS**: múltiplos locais de estoque por projeto e controle de lote/série.
- 🔁 **Retrabalho no relacional**: refletir os laços de retrabalho do motor em `mes.operations`.
- 🔐 **Autenticação**: 2FA e recuperação de senha por e-mail; permissões por projeto.
- 🧪 **CI**: workflow do GitHub Actions com PostgreSQL de serviço rodando `simulation.test.js`, `api.test.js` e `tests/database.sql`.
- 🏭 **Novos modelos de indústria** em `templates.js` (sempre com dados fictícios) e novas geometrias para o gêmeo 3D.
- 🌐 **Internacionalização**: extrair os textos (hoje em pt-BR) para inglês e espanhol.
- ♿ **Acessibilidade**: navegação por teclado no Kanban e no Gantt, rótulos ARIA, contraste no tema claro.

Leia o [guia de contribuição](CONTRIBUTING.md), abra uma [issue](../../issues/new/choose) para combinar a ideia e mande seu pull request. Siga o [código de conduta](CODE_OF_CONDUCT.md). Encontrou uma falha de segurança? Veja a [política de segurança](SECURITY.md) — não abra issue pública.

## Licença

Código próprio sob a **[licença MIT](LICENSE)** — Copyright (c) 2026 GPlanSiS.

Componentes de terceiros incluídos: **three.js** r128 (`three.min.js`, MIT, © three.js authors). Dependências Python instaladas via pip: FastAPI (MIT), uvicorn (BSD-3-Clause), psycopg (LGPL-3.0, usada como biblioteca sem modificação), Pydantic (MIT).

## Créditos

Desenvolvido pela **[GPlanSiS|Group](https://gplansis.com)** · contato: [contato@gplansis.com](mailto:contato@gplansis.com)

<p align="center"><a href="https://pdin.gplansis.com"><b>pdin.gplansis.com</b></a></p>
