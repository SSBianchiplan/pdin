"""GPlanSiS|PDIN · API de persistência (FastAPI + psycopg 3).

Regras:
- Toda invariante de negócio vive no PostgreSQL (funções SECURITY DEFINER das migrações 003/004).
- A API traduz HTTP <-> SQL, valida formato e serve o frontend estático com allowlist.
- O motor operacional roda no navegador; o servidor persiste snapshots e reconcilia o relacional.
"""
from __future__ import annotations

import json
import os
import re
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
VERSION = "3.6.0"
PRODUCT = "GPlanSiS|PDIN · Planejamento Digital da Indústria"
SNAPSHOT_VERSION = 3


def _load_env() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


_load_env()
DATABASE_URL = os.environ.get("PDIN_DATABASE_URL", "postgresql://pdin_owner:pdin_demo_local@127.0.0.1:5437/pdin_demo")


@contextmanager
def db():
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        yield conn


app = FastAPI(title=PRODUCT, version=VERSION, docs_url="/api/docs", openapi_url="/api/openapi.json")
from . import auth
auth.configure(db)
app.include_router(auth.router)
app.middleware("http")(auth.middleware)


@app.on_event("startup")
def _auth_bootstrap() -> None:
    auth.bootstrap(ROOT)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def sql_error(exc: Exception) -> HTTPException:
    msg = re.sub(r"^(ERROR|ERRO):\s*", "", str(exc).split("\n")[0])
    code = 409 if isinstance(exc, (psycopg.errors.RaiseException, psycopg.errors.IntegrityError, psycopg.errors.CheckViolation)) else 500
    return HTTPException(status_code=code, detail=msg)


def check_uuid(value: str) -> str:
    if not UUID_RE.match(value):
        raise HTTPException(400, "Identificador inválido")
    return value


def clean(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, datetime):
            v = v.isoformat()
        elif hasattr(v, "hex") and not isinstance(v, (str, bytes)):
            v = str(v)
        elif type(v).__name__ == "Decimal":
            v = float(v)
        out[k] = v
    return out


# ---------------------------------------------------------------- modelos
class ProjectSpec(BaseModel):
    code: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{1,31}$")
    name: str = Field(min_length=3, max_length=120)
    description: str = ""
    industry: str = ""
    kind: str = Field(default="real", pattern="^(demo|real)$")
    complexity: str = Field(default="basic", pattern="^(basic|advanced|expert)$")
    settings: dict[str, Any] = Field(default_factory=dict)
    stages: list[dict[str, Any]] = Field(min_length=2, max_length=24)
    items: list[dict[str, Any]] = Field(default_factory=list, max_length=80)
    products: list[dict[str, Any]] = Field(min_length=1, max_length=30)
    orders: list[dict[str, Any]] = Field(default_factory=list, max_length=200)


class ProjectPatch(BaseModel):
    status: str | None = Field(default=None, pattern="^(active|archived)$")
    name: str | None = Field(default=None, min_length=3, max_length=120)
    description: str | None = None


class OrderIn(BaseModel):
    client: str = Field(min_length=2, max_length=60)
    product: str = Field(min_length=1, max_length=60)
    qty: int = Field(ge=1, le=50)
    dueHours: float = Field(ge=1, le=2000)
    priority: str = Field(default="Normal", pattern="^(Normal|Urgente)$")


class Snapshot(BaseModel):
    state: dict[str, Any]


class RevisionIn(BaseModel):
    product: str
    changes: list[dict[str, Any]] = Field(default_factory=list)


class BomImportIn(BaseModel):
    product: str
    rows: list[dict[str, Any]] = Field(min_length=1, max_length=500)
    note: str = ""


class ReleaseIn(BaseModel):
    product: str


class TelemetryIn(BaseModel):
    samples: list[dict[str, Any]] = Field(min_length=1, max_length=5000)
    simulated: bool = False  # gateway em --simulate: vai para iot.sim_samples e marca o valor como simulado


# ---------------------------------------------------------------- rotas
@app.get("/api/health")
def health(request: Request) -> dict[str, Any]:
    info: dict[str, Any] = {"ok": True, "product": PRODUCT, "version": VERSION, "database": False}
    if not getattr(request.state, "user", None):  # sem sessão: só o essencial, sem detalhes do banco
        try:
            with db() as conn:
                conn.execute("SELECT 1")
            info["database"] = True
        except Exception:
            pass
        return info
    try:
        with db() as conn:
            row = conn.execute("SELECT current_database() AS db, max(version) AS migration FROM core.schema_migrations").fetchone()
            info.update({"database": True, "db": row["db"], "migration": row["migration"]})
    except Exception as exc:
        info.update({"database": False, "error": str(exc).split("\n")[0]})
    return info


@app.get("/api/projects")
def list_projects(status: str = "active") -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute("SELECT * FROM core.project_overview WHERE status=%s OR %s='all' ORDER BY updated_at DESC", (status, status)).fetchall()
    return [clean(r) for r in rows]


@app.post("/api/projects", status_code=201)
def create_project(spec: ProjectSpec) -> dict[str, Any]:
    try:
        with db() as conn:
            with conn.transaction():
                pid = conn.execute("SELECT core.create_project(%s) AS id", (Jsonb(spec.model_dump()),)).fetchone()["id"]
            row = conn.execute("SELECT * FROM core.project_overview WHERE id=%s", (pid,)).fetchone()
    except psycopg.Error as exc:
        raise sql_error(exc)
    return clean(row)


@app.get("/api/projects/{pid}")
def get_project(pid: str) -> dict[str, Any]:
    check_uuid(pid)
    with db() as conn:
        row = conn.execute("SELECT * FROM core.project_overview WHERE id=%s", (pid,)).fetchone()
    if not row:
        raise HTTPException(404, "Projeto não encontrado")
    return clean(row)


@app.patch("/api/projects/{pid}")
def patch_project(pid: str, patch: ProjectPatch) -> dict[str, Any]:
    check_uuid(pid)
    sets, params = [], []
    for k, v in patch.model_dump(exclude_none=True).items():
        sets.append(f"{k}=%s")
        params.append(v)
    if not sets:
        raise HTTPException(400, "Nada a alterar")
    params.append(pid)
    try:
        with db() as conn:
            with conn.transaction():
                n = conn.execute(f"UPDATE core.projects SET {', '.join(sets)}, updated_at=now() WHERE id=%s", params).rowcount
            row = conn.execute("SELECT * FROM core.project_overview WHERE id=%s", (pid,)).fetchone()
    except psycopg.Error as exc:
        raise sql_error(exc)
    if not n:
        raise HTTPException(404, "Projeto não encontrado")
    return clean(row)


DB_STATUS = {"draft": "backlog", "released": "released", "running": "running", "paused": "paused", "completed": "done"}


def build_definition(conn: psycopg.Connection, project: dict[str, Any]) -> dict[str, Any]:
    """Reconstrói a definição do motor a partir do relacional (verdade) + metadados do projeto."""
    spec = project["settings"] or {}
    pl = project["plant_id"]
    balances = {r["item_code"]: r for r in conn.execute("SELECT item_code,sum(on_hand) AS on_hand,sum(reserved) AS reserved FROM wms.stock_position WHERE plant_id=%s GROUP BY item_code", (pl,)).fetchall()}
    items = [{**it, "onHand": float(balances[it["code"]]["on_hand"]) if it["code"] in balances else 0.0} for it in spec.get("items", [])]
    known = {it["code"] for it in items}
    prow = conn.execute(
        """SELECT DISTINCT ON (i.code) i.code,i.name,r.id AS rev_id,r.code AS rev
           FROM plm.revisions r JOIN plm.items i ON i.id=r.item_id
           WHERE r.state='released' AND EXISTS(SELECT 1 FROM plm.routing_steps rs JOIN core.work_centers wc ON wc.id=rs.work_center_id WHERE rs.revision_id=r.id AND wc.plant_id=%s)
           ORDER BY i.code,r.released_at DESC""",
        (pl,),
    ).fetchall()
    order_of = {p["code"]: n for n, p in enumerate(spec.get("products", []))}
    spec_prod = {p["code"]: p for p in spec.get("products", [])}  # receita (params) e estilo vivem na especificação
    products = []

    def bom_of(rev_id):
        rows = conn.execute("SELECT c.code,c.name,c.uom,b.quantity FROM plm.bom_lines b JOIN plm.items c ON c.id=b.component_id WHERE b.revision_id=%s ORDER BY c.code", (rev_id,)).fetchall()
        for r in rows:  # itens de BOM importada que ainda não estão nos metadados do projeto
            if r["code"] not in known:
                items.append({"code": r["code"], "name": r["name"], "unit": r["uom"], "onHand": float(balances[r["code"]]["on_hand"]) if r["code"] in balances else 0.0, "min": 0, "leadTime": 48, "location": "ALM-01"})
                known.add(r["code"])
        return {r["code"]: float(r["quantity"]) for r in rows}

    for p in sorted(prow, key=lambda r: order_of.get(r["code"], 999)):
        bom = bom_of(p["rev_id"])
        route = [r["code"] for r in conn.execute("SELECT wc.code FROM plm.routing_steps rs JOIN core.work_centers wc ON wc.id=rs.work_center_id WHERE rs.revision_id=%s ORDER BY rs.sequence", (p["rev_id"],)).fetchall()]
        draft_row = conn.execute("SELECT r.id,r.code,r.description FROM plm.revisions r JOIN plm.items i ON i.id=r.item_id WHERE i.code=%s AND r.state IN ('draft','review') ORDER BY r.created_at DESC LIMIT 1", (p["code"],)).fetchone()
        draft = {"rev": draft_row["code"], "bom": bom_of(draft_row["id"]), "note": draft_row["description"] or ""} if draft_row else None
        sp = spec_prod.get(p["code"], {})
        products.append({"code": p["code"], "name": p["name"], "rev": p["rev"], "route": route, "bom": bom, "draft": draft, "params": sp.get("params", {}), "style": sp.get("style", "")})
    seeds = spec.get("orders", [])
    created0: datetime = project["created_at"]
    orders = []
    rows = conn.execute(
        """SELECT o.code,o.customer_reference,o.quantity,o.due_at,o.priority,o.status,o.created_at,i.code AS product,
                  (SELECT count(*) FROM mes.operations m WHERE m.order_id=o.id AND m.status='completed') AS ops_done
           FROM ppcp.orders o JOIN plm.revisions r ON r.id=o.revision_id JOIN plm.items i ON i.id=r.item_id
           WHERE o.plant_id=%s AND o.status<>'cancelled' ORDER BY o.created_at,o.code""",
        (pl,),
    ).fetchall()
    for n, o in enumerate(rows):
        seed = seeds[n] if n < len(seeds) and seeds[n].get("product") == o["product"] else {}
        prod = next((p for p in products if p["code"] == o["product"]), None)
        route = prod["route"] if prod else []
        start_stage = seed.get("startStage")
        if not start_stage and route and 0 < o["ops_done"] < len(route):
            start_stage = route[int(o["ops_done"])]
        orders.append({
            "id": o["code"], "client": o["customer_reference"], "product": o["product"], "qty": int(o["quantity"]),
            "dueHours": max(1.0, (o["due_at"] - datetime.now(timezone.utc)).total_seconds() / 3600),
            "priority": "Urgente" if (o["priority"] or 50) >= 90 else "Normal",
            "status": DB_STATUS.get(o["status"], "backlog") if not seed else seed.get("status", DB_STATUS.get(o["status"], "backlog")),
            "startStage": start_stage, "progress": seed.get("progress", 0),
        })
    return {
        "id": str(project["id"]), "code": project["code"], "name": project["name"], "description": project["description"],
        "industry": project["industry"], "complexity": project["complexity"], "kind": project["kind"],
        "settings": spec.get("settings", {}), "stages": spec.get("stages", []), "items": items, "products": products, "orders": orders,
    }


def state_payload(conn, project, with_definition: bool = True):
    """Snapshot v3 quando existe (estado operacional) + definição reconstruída do relacional (opcional no portfólio)."""
    snap = conn.execute("SELECT state,saved_at FROM core.project_snapshots WHERE project_id=%s", (project["id"],)).fetchone()
    state = snap["state"] if snap and snap["state"].get("version") == SNAPSHOT_VERSION else None
    if state is not None:
        state.setdefault("project", {})["id"] = str(project["id"])
    definition = build_definition(conn, project) if (with_definition or state is None) else None
    return {"project": clean({k: v for k, v in project.items() if k != "settings"}), "definition": definition, "state": state, "savedAt": snap["saved_at"].isoformat() if snap else None}


@app.get("/api/projects/{pid}/state")
def get_state(pid: str) -> dict[str, Any]:
    check_uuid(pid)
    with db() as conn:
        project = conn.execute("SELECT * FROM core.projects WHERE id=%s", (pid,)).fetchone()
        if not project:
            raise HTTPException(404, "Projeto não encontrado")
        return state_payload(conn, project)


@app.get("/api/portfolio")
def portfolio() -> list[dict[str, Any]]:
    """Todos os projetos ativos com estado (snapshot ou definição) para a visão unificada de capacidade."""
    with db() as conn:
        projects = conn.execute("SELECT * FROM core.projects WHERE status='active' ORDER BY created_at").fetchall()
        return [state_payload(conn, p, with_definition=False) for p in projects]


@app.put("/api/projects/{pid}/snapshot")
def put_snapshot(pid: str, body: Snapshot) -> dict[str, Any]:
    check_uuid(pid)
    if body.state.get("version") != SNAPSHOT_VERSION:
        raise HTTPException(400, "Snapshot incompatível")
    try:
        with db() as conn:
            with conn.transaction():
                res = conn.execute("SELECT core.save_snapshot(%s,%s) AS r", (pid, Jsonb(body.state))).fetchone()["r"]
    except psycopg.Error as exc:
        raise sql_error(exc)
    return {"ok": True, "sync": res}


@app.post("/api/projects/{pid}/snapshot")
async def post_snapshot(pid: str, request: Request) -> dict[str, Any]:
    raw = await request.body()
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        raise HTTPException(400, "JSON inválido")
    return put_snapshot(pid, Snapshot(state=data.get("state", data)))


@app.delete("/api/projects/{pid}/snapshot")
def delete_snapshot(pid: str) -> dict[str, Any]:
    check_uuid(pid)
    with db() as conn:
        with conn.transaction():
            n = conn.execute("DELETE FROM core.project_snapshots WHERE project_id=%s", (pid,)).rowcount
    return {"ok": True, "deleted": n}


@app.post("/api/projects/{pid}/orders", status_code=201)
def create_order(pid: str, body: OrderIn) -> dict[str, Any]:
    check_uuid(pid)
    due = datetime.now(timezone.utc) + timedelta(hours=body.dueHours)
    try:
        with db() as conn:
            with conn.transaction():
                res = conn.execute("SELECT ppcp.create_order(%s,%s,%s,%s,%s,%s) AS r", (pid, body.product, body.client, body.qty, due, 90 if body.priority == "Urgente" else 50)).fetchone()["r"]
    except psycopg.Error as exc:
        raise sql_error(exc)
    return res


@app.get("/api/projects/{pid}/orders")
def list_orders(pid: str) -> list[dict[str, Any]]:
    check_uuid(pid)
    with db() as conn:
        rows = conn.execute(
            """SELECT o.code,o.customer_reference AS client,i.code AS product,r.code AS revision,o.quantity,o.due_at,o.priority,o.status,o.created_at,o.completed_at,o.version,
                      (SELECT count(*) FROM mes.operations m WHERE m.order_id=o.id AND m.status='completed') AS ops_done,
                      (SELECT count(*) FROM mes.operations m WHERE m.order_id=o.id) AS ops_total,
                      (SELECT count(*) FROM wms.reservations w WHERE w.order_id=o.id AND w.status='consumed') AS consumed_reservations
               FROM ppcp.orders o JOIN core.projects p ON p.plant_id=o.plant_id JOIN plm.revisions r ON r.id=o.revision_id JOIN plm.items i ON i.id=r.item_id
               WHERE p.id=%s ORDER BY o.created_at DESC""",
            (pid,),
        ).fetchall()
    return [clean(r) for r in rows]


@app.get("/api/projects/{pid}/stock")
def stock(pid: str) -> list[dict[str, Any]]:
    check_uuid(pid)
    with db() as conn:
        rows = conn.execute("SELECT s.item_code,s.item_name,s.uom,s.location_code,s.on_hand,s.reserved,s.available FROM wms.stock_position s JOIN core.projects p ON p.plant_id=s.plant_id WHERE p.id=%s ORDER BY s.item_code", (pid,)).fetchall()
    return [clean(r) for r in rows]


@app.post("/api/projects/{pid}/revisions", status_code=201)
def propose_revision(pid: str, body: RevisionIn) -> dict[str, Any]:
    check_uuid(pid)
    try:
        with db() as conn:
            with conn.transaction():
                res = conn.execute("SELECT plm.propose_revision(%s,%s,%s) AS r", (pid, body.product, Jsonb(body.changes))).fetchone()["r"]
    except psycopg.Error as exc:
        raise sql_error(exc)
    return res


@app.post("/api/projects/{pid}/revisions/import", status_code=201)
def import_bom(pid: str, body: BomImportIn) -> dict[str, Any]:
    check_uuid(pid)
    for r in body.rows:
        if not r.get("code") or not (float(r.get("qty", 0)) > 0):
            raise HTTPException(400, "Linha de BOM inválida")
    try:
        with db() as conn:
            with conn.transaction():
                res = conn.execute("SELECT plm.import_bom(%s,%s,%s,%s) AS r", (pid, body.product, Jsonb(body.rows), body.note or None)).fetchone()["r"]
    except psycopg.Error as exc:
        raise sql_error(exc)
    return res


@app.post("/api/projects/{pid}/revisions/release")
def release_revision(pid: str, body: ReleaseIn) -> dict[str, Any]:
    check_uuid(pid)
    try:
        with db() as conn:
            with conn.transaction():
                res = conn.execute("SELECT plm.release_revision(%s,%s) AS r", (pid, body.product)).fetchone()["r"]
    except psycopg.Error as exc:
        raise sql_error(exc)
    return res


@app.delete("/api/projects/{pid}/revisions/{product}")
def discard_revision(pid: str, product: str) -> dict[str, Any]:
    check_uuid(pid)
    try:
        with db() as conn:
            with conn.transaction():
                row = conn.execute("SELECT r.id FROM plm.revisions r JOIN plm.items i ON i.id=r.item_id WHERE i.code=%s AND r.state IN ('draft','review') ORDER BY r.created_at DESC LIMIT 1", (product,)).fetchone()
                if not row:
                    raise HTTPException(404, "Nenhuma revisão em análise")
                conn.execute("DELETE FROM plm.bom_lines WHERE revision_id=%s", (row["id"],))
                conn.execute("DELETE FROM plm.routing_steps WHERE revision_id=%s", (row["id"],))
                conn.execute("DELETE FROM plm.revisions WHERE id=%s", (row["id"],))
    except psycopg.Error as exc:
        raise sql_error(exc)
    return {"ok": True}


@app.get("/api/projects/{pid}/audit")
def audit(pid: str, limit: int = 40) -> list[dict[str, Any]]:
    check_uuid(pid)
    limit = max(1, min(limit, 200))
    with db() as conn:
        rows = conn.execute(
            """SELECT a.id,a.table_name,a.action,a.at,coalesce(a.new_row->>'code',a.new_row->>'id',a.old_row->>'id') AS ref
               FROM audit.events a JOIN core.projects p ON p.id=%s
               WHERE coalesce(a.new_row->>'plant_id',a.old_row->>'plant_id')=p.plant_id::text ORDER BY a.id DESC LIMIT %s""",
            (pid, limit),
        ).fetchall()
    return [clean(r) for r in rows]


# ---------------------------------------------------------------- telemetria de campo (somente leitura do processo)
@app.post("/api/projects/{pid}/telemetry")
def post_telemetry(pid: str, body: TelemetryIn) -> dict[str, Any]:
    """Gateway OPC UA/MQTT -> amostras {tag, value, quality, at}. Idempotente por (tag, at). Nunca escreve em PLC."""
    check_uuid(pid)
    try:
        with db() as conn:
            with conn.transaction():
                fn = "iot.ingest_sim" if body.simulated else "iot.ingest"
                res = conn.execute(f"SELECT {fn}(%s,%s) AS r", (pid, Jsonb(body.samples))).fetchone()["r"]
    except psycopg.Error as exc:
        raise sql_error(exc)
    return res


@app.get("/api/projects/{pid}/telemetry")
def get_telemetry(pid: str) -> dict[str, Any]:
    check_uuid(pid)
    with db() as conn:
        latest = conn.execute("SELECT tag,value,quality,at,sim FROM iot.tag_latest WHERE project_id=%s ORDER BY tag", (pid,)).fetchall()
        tags = conn.execute("SELECT tag,description,kind,unit,stage_code,resource,source,address,lo,hi FROM iot.tags WHERE project_id=%s ORDER BY stage_code,tag", (pid,)).fetchall()
    return {"latest": [clean(r) for r in latest], "tags": [clean(r) for r in tags]}


@app.get("/api/projects/{pid}/telemetry/{tag}/history")
def tag_history(pid: str, tag: str, limit: int = 300) -> list[dict[str, Any]]:
    check_uuid(pid)
    with db() as conn:
        rows = conn.execute(
            """SELECT value,quality,at,false AS sim FROM iot.samples WHERE project_id=%s AND tag=%s
               UNION ALL SELECT value,192,at,true FROM iot.sim_samples WHERE project_id=%s AND tag=%s
               ORDER BY at DESC LIMIT %s""",
            (pid, tag, pid, tag, max(1, min(limit, 5000))),
        ).fetchall()
    return [clean(r) for r in rows]


@app.post("/api/projects/{pid}/tags/sync")
def sync_tags(pid: str) -> dict[str, Any]:
    check_uuid(pid)
    with db() as conn:
        with conn.transaction():
            n = conn.execute("SELECT iot.sync_tags(%s) AS n", (pid,)).fetchone()["n"]
    return {"tags": n}


# ---------------------------------------------------------------- estático (allowlist)
STATIC_EXT = {".html", ".css", ".js", ".json", ".png", ".svg", ".ico", ".webmanifest", ".glb", ".bin", ".woff2", ".webp", ".jpg", ".txt"}
BLOCKED = ("api", "database", "tests", "tools", "integration", "deploy", ".github", ".browser-profile", "artifacts", ".git")


@app.get("/{path:path}", include_in_schema=False)
def static(path: str):
    if path.startswith("api/"):
        raise HTTPException(404)
    rel = path or "index.html"
    parts = Path(rel).parts
    if not parts or parts[0] in BLOCKED or tuple(parts[:2]) == ("data", "nwd-imports") or any(p in ("..", "") for p in parts):
        raise HTTPException(404)
    target = (ROOT / rel).resolve()
    if ROOT not in target.parents or target.suffix.lower() not in STATIC_EXT or not target.is_file():
        raise HTTPException(404)
    # no-cache = revalida com ETag (304 barato). Sem isso o navegador guardava GLB/JSON por heurística e seguia
    # usando o modelo antigo depois de uma troca no servidor.
    headers = {"Cache-Control": "no-cache"} if target.suffix in (".html", ".js", ".css", ".webmanifest", ".glb", ".json") else {}
    if rel.startswith(("landing/", "icons/")):
        headers = {"Cache-Control": "public, max-age=86400"}
    if rel == "sw.js":
        headers["Service-Worker-Allowed"] = "/"
    return FileResponse(target, headers=headers)


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
