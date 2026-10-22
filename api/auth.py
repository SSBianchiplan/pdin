"""GPlanSiS|PDIN · Autenticação por sessão e gestão de usuários.

- Sessão em cookie HttpOnly (SameSite=Lax): fetch, sendBeacon e os iframes 3D mandam o cookie sem
  mudança no frontend. No banco fica só o SHA-256 do token.
- Senhas com scrypt (hashlib, sem dependência nova).
- Perfis: admin (tudo + usuários), operador (opera o sistema), leitor (somente consulta).
  O master é único, sempre admin ativo, e só ele cria ou altera outros administradores.
- O gateway de telemetria autentica por `Authorization: Bearer $PDIN_GATEWAY_TOKEN`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import psycopg
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

COOKIE = "pdin_session"
SESSION_HOURS = 12
REMEMBER_DAYS = 30
MAX_FAILS = 5
LOCK_MINUTES = 15
MASTER_EMAIL = os.environ.get("PDIN_MASTER_EMAIL", "contato@gplansis.com").strip().lower()
GATEWAY_TOKEN = os.environ.get("PDIN_GATEWAY_TOKEN", "")
ROLES = ("admin", "operador", "leitor")

# Rotas e arquivos acessíveis sem sessão: a tela de login e o que o PWA precisa para instalar.
PUBLIC_FILES = {"login.html", "landing.html", "manifest.webmanifest", "sw.js", "favicon.ico", "offline.html", "robots.txt"}
PUBLIC_PREFIXES = ("icons/", "landing/")
PUBLIC_API = {"/api/auth/login", "/api/auth/logout", "/api/health", "/api/leads"}
LANDING = Path(__file__).resolve().parent.parent / "landing.html"
# Leitor pode chamar estas rotas de escrita (são sobre a própria conta).
SELF_SERVICE = {"/api/auth/logout", "/api/auth/password"}

router = APIRouter(prefix="/api", tags=["Autenticação e usuários"])
_db: Callable[[], Any] | None = None
_cache: dict[bytes, tuple[float, dict[str, Any]]] = {}
_ip_fails: dict[str, list[float]] = {}
CACHE_TTL = 20.0


def configure(db_factory: Callable[[], Any]) -> None:
    global _db
    _db = db_factory


def db():
    assert _db is not None, "auth.configure(db) não foi chamado"
    return _db()


# ---------------------------------------------------------------- senhas e tokens
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        calc = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(base64.b64decode(dk)))
        return hmac.compare_digest(calc, base64.b64decode(dk))
    except Exception:
        return False


# Custo equivalente para e-mail inexistente: não revela quais contas existem pelo tempo de resposta.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def temp_password() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))


def check_strength(password: str) -> None:
    if len(password) < 10:
        raise HTTPException(400, "A senha precisa de pelo menos 10 caracteres")
    if password.lower() == password or password.upper() == password or not any(c.isdigit() for c in password):
        raise HTTPException(400, "Use letras maiúsculas, minúsculas e números na senha")


def token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "")) or "-"


def is_https(request: Request) -> bool:
    return request.headers.get("x-forwarded-proto", request.url.scheme) == "https"


def public_user(u: dict[str, Any]) -> dict[str, Any]:
    out = {k: u.get(k) for k in ("id", "email", "name", "role", "active", "is_master", "must_change", "created_at", "last_login_at", "locked_until")}
    for k, v in list(out.items()):
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    return out


def log_event(conn, actor_id, action: str, target: str | None, ip: str, detail: dict | None = None) -> None:
    from psycopg.types.json import Jsonb
    conn.execute("INSERT INTO auth.events(actor_id,action,target,ip,detail) VALUES (%s,%s,%s,%s,%s)", (actor_id, action, target, ip, Jsonb(detail or {})))


def drop_sessions(conn, user_id: int, keep: bytes | None = None) -> None:
    conn.execute("DELETE FROM auth.sessions WHERE user_id=%s AND token_hash IS DISTINCT FROM %s", (user_id, keep))
    for k in [k for k, (_, u) in _cache.items() if u["id"] == user_id and k != keep]:
        _cache.pop(k, None)


# ---------------------------------------------------------------- bootstrap
def bootstrap(root: Path) -> None:
    """Aplica 006_auth.sql e garante o administrador master."""
    sql = (root / "database" / "006_auth.sql").read_text(encoding="utf-8") + "\n" + (root / "database" / "007_leads.sql").read_text(encoding="utf-8") + "\n" + (root / "database" / "008_telemetry_sim.sql").read_text(encoding="utf-8")
    with db() as conn:
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(6006)")
            conn.execute(sql)
            row = conn.execute("SELECT id,is_master FROM auth.users WHERE email=%s", (MASTER_EMAIL,)).fetchone()
            if row and not row["is_master"]:
                conn.execute("UPDATE auth.users SET is_master=false WHERE is_master AND email<>%s", (MASTER_EMAIL,))
                conn.execute("UPDATE auth.users SET role='admin',active=true,is_master=true,updated_at=now() WHERE id=%s", (row["id"],))
            elif not row:
                pwd = os.environ.get("PDIN_MASTER_PASSWORD") or ""
                generated = not pwd
                if generated:
                    pwd = temp_password()
                conn.execute(
                    "INSERT INTO auth.users(email,name,role,password_hash,is_master,must_change) VALUES (%s,%s,'admin',%s,true,true)",
                    (MASTER_EMAIL, os.environ.get("PDIN_MASTER_NAME") or MASTER_EMAIL.split("@")[0], hash_password(pwd)),
                )
                log_event(conn, None, "bootstrap_master", MASTER_EMAIL, "-")
                if generated:
                    print(f"[PDIN] administrador master criado: {MASTER_EMAIL} · senha provisória: {pwd}", flush=True)
            conn.execute("DELETE FROM auth.sessions WHERE expires_at < now()")


# ---------------------------------------------------------------- sessão
def _load_session(th: bytes) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            """UPDATE auth.sessions s SET last_seen_at=now() FROM auth.users u
               WHERE s.token_hash=%s AND u.id=s.user_id AND s.expires_at>now() AND u.active
               RETURNING u.*""",
            (th,),
        ).fetchone()
    return row


async def current_user(request: Request) -> dict[str, Any] | None:
    token = request.cookies.get(COOKIE)
    if not token or len(token) > 100:
        return None
    th = token_hash(token)
    hit = _cache.get(th)
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]
    user = await run_in_threadpool(_load_session, th)
    if user:
        _cache[th] = (now, user)
    else:
        _cache.pop(th, None)
    return user


def require(request: Request, admin: bool = False) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Sessão expirada. Entre novamente.")
    if admin and user["role"] != "admin":
        raise HTTPException(403, "Apenas administradores")
    return user


def _is_public(path: str) -> bool:
    rel = path.lstrip("/")
    return path in PUBLIC_API or rel in PUBLIC_FILES or rel.startswith(PUBLIC_PREFIXES)


async def middleware(request: Request, call_next):
    path = request.url.path
    method = request.method
    # Gateway de telemetria (máquina, sem navegador): token próprio, só nesta rota.
    # Pode listar projetos e ler o estado (para contextualizar a simulação ao lote) e enviar amostras.
    gateway_route = (method == "POST" and path.startswith("/api/projects/") and path.endswith("/telemetry")) or (
        method == "GET" and (path == "/api/projects" or (path.startswith("/api/projects/") and path.endswith("/state"))))
    if GATEWAY_TOKEN and gateway_route:
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip(), GATEWAY_TOKEN):
            return await call_next(request)
    user = await current_user(request)
    request.state.user = user
    # Página inicial: vitrine pública para visitantes; quem tem sessão vai direto ao sistema.
    if not user and path == "/" and method in ("GET", "HEAD"):
        return FileResponse(LANDING, headers={"Cache-Control": "no-cache"})
    if _is_public(path):
        if path == "/api/leads" and method != "POST":
            pass  # listar solicitações exige administrador (abaixo)
        else:
            return await call_next(request)
    if not user:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "Sessão expirada. Entre novamente."}, status_code=401)
        if path in ("/", "") or path.endswith(".html"):
            nxt = path + (("?" + request.url.query) if request.url.query else "")
            return RedirectResponse("/login.html" + ("" if nxt == "/index.html" else "?next=" + nxt), status_code=302)
        return JSONResponse({"detail": "Não autenticado"}, status_code=401)
    if method not in ("GET", "HEAD", "OPTIONS"):
        # Defesa extra contra CSRF além do SameSite=Lax: origem, quando enviada, precisa ser a própria.
        origin = request.headers.get("origin")
        if origin and origin.split("://", 1)[-1] != request.headers.get("host", ""):
            return JSONResponse({"detail": "Origem não permitida"}, status_code=403)
        if user["role"] == "leitor" and path not in SELF_SERVICE:
            return JSONResponse({"detail": "Perfil leitor: somente consulta."}, status_code=403)
        if user["must_change"] and path not in SELF_SERVICE:
            return JSONResponse({"detail": "Troque a senha provisória antes de continuar."}, status_code=403)
    if (path.startswith("/api/nwd/") and method == "POST") or path.startswith("/api/docs") or path == "/api/openapi.json":
        if user["role"] != "admin":
            return JSONResponse({"detail": "Apenas administradores"}, status_code=403)
    return await call_next(request)


# ---------------------------------------------------------------- modelos
class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)
    remember: bool = False


class PasswordIn(BaseModel):
    current: str = Field(min_length=1, max_length=200)
    new: str = Field(min_length=10, max_length=200)


class UserIn(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    name: str = Field(min_length=2, max_length=120)
    role: str = Field(default="operador", pattern="^(admin|operador|leitor)$")
    password: str | None = Field(default=None, max_length=200)


class UserPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    role: str | None = Field(default=None, pattern="^(admin|operador|leitor)$")
    active: bool | None = None


class ResetIn(BaseModel):
    password: str | None = Field(default=None, max_length=200)


# ---------------------------------------------------------------- rotas de conta
def _throttled(ip: str) -> bool:
    now = time.time()
    fails = [t for t in _ip_fails.get(ip, []) if now - t < 600]
    _ip_fails[ip] = fails
    return len(fails) >= 20


@router.post("/auth/login")
def login(body: LoginIn, request: Request, response: Response) -> dict[str, Any]:
    ip = client_ip(request)
    if _throttled(ip):
        raise HTTPException(429, "Muitas tentativas. Aguarde alguns minutos.")
    email = body.email.strip().lower()
    with db() as conn:
        with conn.transaction():
            u = conn.execute("SELECT * FROM auth.users WHERE email=%s FOR UPDATE", (email,)).fetchone()
            if u and u["locked_until"] and u["locked_until"] > datetime.now(timezone.utc):
                raise HTTPException(423, "Conta bloqueada temporariamente por tentativas inválidas. Tente em alguns minutos.")
            ok = verify_password(body.password, u["password_hash"] if u else _DUMMY_HASH) and bool(u)
            if not ok or not u["active"]:
                _ip_fails.setdefault(ip, []).append(time.time())
                if u:
                    fails = u["failed_logins"] + 1
                    lock = datetime.now(timezone.utc) + timedelta(minutes=LOCK_MINUTES) if fails >= MAX_FAILS else None
                    conn.execute("UPDATE auth.users SET failed_logins=%s,locked_until=%s WHERE id=%s", (0 if lock else fails, lock, u["id"]))
                    log_event(conn, u["id"], "login_failed" if u["active"] else "login_inactive", email, ip, {"locked": bool(lock)})
                raise HTTPException(401, "E-mail ou senha inválidos")
            token = secrets.token_urlsafe(32)
            ttl = timedelta(days=REMEMBER_DAYS) if body.remember else timedelta(hours=SESSION_HOURS)
            conn.execute(
                "INSERT INTO auth.sessions(token_hash,user_id,expires_at,ip,user_agent) VALUES (%s,%s,%s,%s,%s)",
                (token_hash(token), u["id"], datetime.now(timezone.utc) + ttl, ip, (request.headers.get("user-agent") or "")[:300]),
            )
            conn.execute("UPDATE auth.users SET failed_logins=0,locked_until=NULL,last_login_at=now() WHERE id=%s", (u["id"],))
            log_event(conn, u["id"], "login", email, ip)
    response.set_cookie(
        COOKIE, token, max_age=int(ttl.total_seconds()) if body.remember else None,
        httponly=True, secure=is_https(request), samesite="lax", path="/",
    )
    return {"ok": True, "user": public_user(u)}


@router.post("/auth/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    token = request.cookies.get(COOKIE)
    if token:
        th = token_hash(token)
        _cache.pop(th, None)
        with db() as conn:
            conn.execute("DELETE FROM auth.sessions WHERE token_hash=%s", (th,))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request) -> dict[str, Any]:
    return public_user(require(request))


@router.post("/auth/password")
def change_password(body: PasswordIn, request: Request) -> dict[str, Any]:
    user = require(request)
    check_strength(body.new)
    if body.new == body.current:
        raise HTTPException(400, "A nova senha precisa ser diferente da atual")
    th = token_hash(request.cookies.get(COOKIE, ""))
    with db() as conn:
        with conn.transaction():
            u = conn.execute("SELECT password_hash FROM auth.users WHERE id=%s FOR UPDATE", (user["id"],)).fetchone()
            if not verify_password(body.current, u["password_hash"]):
                raise HTTPException(400, "Senha atual incorreta")
            conn.execute("UPDATE auth.users SET password_hash=%s,must_change=false,updated_at=now() WHERE id=%s", (hash_password(body.new), user["id"]))
            drop_sessions(conn, user["id"], keep=th)  # encerra as outras sessões desta conta
            log_event(conn, user["id"], "password_changed", user["email"], client_ip(request))
    _cache.pop(th, None)
    return {"ok": True}


# ---------------------------------------------------------------- gestão de usuários (admin)
def _guard_target(actor: dict[str, Any], target: dict[str, Any], new_role: str | None = None) -> None:
    if target["is_master"] and not actor["is_master"]:
        raise HTTPException(403, "Somente o próprio master altera a conta master")
    if not actor["is_master"] and (target["role"] == "admin" or new_role == "admin") and target["id"] != actor["id"]:
        raise HTTPException(403, "Somente o administrador master cria ou altera administradores")


@router.get("/users")
def list_users(request: Request) -> list[dict[str, Any]]:
    require(request, admin=True)
    with db() as conn:
        rows = conn.execute(
            """SELECT u.*, (SELECT count(*) FROM auth.sessions s WHERE s.user_id=u.id AND s.expires_at>now()) AS sessions
               FROM auth.users u ORDER BY u.is_master DESC, u.active DESC, lower(u.name)"""
        ).fetchall()
    return [{**public_user(r), "sessions": r["sessions"]} for r in rows]


@router.post("/users", status_code=201)
def create_user(body: UserIn, request: Request) -> dict[str, Any]:
    actor = require(request, admin=True)
    if body.role == "admin" and not actor["is_master"]:
        raise HTTPException(403, "Somente o administrador master cria administradores")
    email = body.email.strip().lower()
    pwd = body.password or temp_password()
    if body.password:
        check_strength(body.password)
    try:
        with db() as conn:
            with conn.transaction():
                u = conn.execute(
                    "INSERT INTO auth.users(email,name,role,password_hash,must_change) VALUES (%s,%s,%s,%s,true) RETURNING *",
                    (email, body.name.strip(), body.role, hash_password(pwd)),
                ).fetchone()
                log_event(conn, actor["id"], "user_created", email, client_ip(request), {"role": body.role})
    except psycopg.errors.UniqueViolation:
        raise HTTPException(409, "Já existe um usuário com este e-mail")
    except psycopg.errors.CheckViolation:
        raise HTTPException(400, "E-mail inválido")
    return {"user": public_user(u), "temporaryPassword": None if body.password else pwd}


@router.patch("/users/{uid}")
def update_user(uid: int, body: UserPatch, request: Request) -> dict[str, Any]:
    actor = require(request, admin=True)
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(400, "Nada a alterar")
    with db() as conn:
        with conn.transaction():
            t = conn.execute("SELECT * FROM auth.users WHERE id=%s FOR UPDATE", (uid,)).fetchone()
            if not t:
                raise HTTPException(404, "Usuário não encontrado")
            _guard_target(actor, t, changes.get("role"))
            if t["is_master"] and (changes.get("role", "admin") != "admin" or changes.get("active") is False):
                raise HTTPException(400, "O administrador master é sempre administrador ativo")
            if t["id"] == actor["id"] and (changes.get("active") is False or changes.get("role", actor["role"]) != actor["role"]):
                raise HTTPException(400, "Você não pode desativar nem rebaixar a própria conta")
            sets = ", ".join(f"{k}=%s" for k in changes)
            u = conn.execute(f"UPDATE auth.users SET {sets}, updated_at=now() WHERE id=%s RETURNING *", (*changes.values(), uid)).fetchone()
            if changes.get("active") is False or ("role" in changes and changes["role"] != t["role"]):
                drop_sessions(conn, uid)
            log_event(conn, actor["id"], "user_updated", t["email"], client_ip(request), changes)
    return public_user(u)


@router.post("/users/{uid}/password")
def reset_password(uid: int, body: ResetIn, request: Request) -> dict[str, Any]:
    actor = require(request, admin=True)
    pwd = body.password or temp_password()
    if body.password:
        check_strength(body.password)
    with db() as conn:
        with conn.transaction():
            t = conn.execute("SELECT * FROM auth.users WHERE id=%s FOR UPDATE", (uid,)).fetchone()
            if not t:
                raise HTTPException(404, "Usuário não encontrado")
            _guard_target(actor, t)
            conn.execute(
                "UPDATE auth.users SET password_hash=%s,must_change=true,failed_logins=0,locked_until=NULL,updated_at=now() WHERE id=%s",
                (hash_password(pwd), uid),
            )
            drop_sessions(conn, uid)
            log_event(conn, actor["id"], "password_reset", t["email"], client_ip(request))
    return {"ok": True, "temporaryPassword": None if body.password else pwd}


@router.delete("/users/{uid}")
def delete_user(uid: int, request: Request) -> dict[str, Any]:
    actor = require(request, admin=True)
    with db() as conn:
        with conn.transaction():
            t = conn.execute("SELECT * FROM auth.users WHERE id=%s FOR UPDATE", (uid,)).fetchone()
            if not t:
                raise HTTPException(404, "Usuário não encontrado")
            if t["is_master"]:
                raise HTTPException(400, "O administrador master não pode ser removido")
            if t["id"] == actor["id"]:
                raise HTTPException(400, "Você não pode remover a própria conta")
            _guard_target(actor, t)
            drop_sessions(conn, uid)
            conn.execute("DELETE FROM auth.users WHERE id=%s", (uid,))
            log_event(conn, actor["id"], "user_deleted", t["email"], client_ip(request))
    return {"ok": True}


@router.get("/users/events")
def user_events(request: Request, limit: int = 50) -> list[dict[str, Any]]:
    require(request, admin=True)
    with db() as conn:
        rows = conn.execute(
            """SELECT e.at,e.action,e.target,e.ip,e.detail,u.email AS actor FROM auth.events e
               LEFT JOIN auth.users u ON u.id=e.actor_id ORDER BY e.id DESC LIMIT %s""",
            (max(1, min(limit, 200)),),
        ).fetchall()
    return [{**r, "at": r["at"].isoformat()} for r in rows]


# ---------------------------------------------------------------- solicitações de demonstração (página pública)
class LeadIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    company: str = Field(min_length=2, max_length=160)
    email: str = Field(min_length=5, max_length=254)
    phone: str | None = Field(default=None, max_length=40)
    role: str | None = Field(default=None, max_length=80)
    interests: list[str] = Field(default_factory=list, max_length=10)
    message: str | None = Field(default=None, max_length=2000)
    website: str | None = None  # isca para robôs: humano nunca preenche


class LeadPatch(BaseModel):
    status: str = Field(pattern="^(novo|contatado|descartado)$")


LEAD_INTERESTS = {"supervisorio", "mes", "aps", "plm", "pcp", "almoxarifado"}
_lead_hits: dict[str, list[float]] = {}


@router.post("/leads", status_code=201)
def create_lead(body: LeadIn, request: Request) -> dict[str, Any]:
    ip = client_ip(request)
    if body.website:
        return {"ok": True}  # robô: finge sucesso e descarta
    now = time.time()
    hits = [t for t in _lead_hits.get(ip, []) if now - t < 3600]
    if len(hits) >= 5:
        raise HTTPException(429, "Recebemos várias solicitações deste endereço. Tente mais tarde.")
    _lead_hits[ip] = hits + [now]
    interests = sorted({i for i in body.interests if i in LEAD_INTERESTS})
    try:
        with db() as conn:
            with conn.transaction():
                conn.execute(
                    "INSERT INTO auth.leads(name,company,email,phone,role,interests,message,ip,user_agent) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (body.name.strip(), body.company.strip(), body.email.strip().lower(), (body.phone or "").strip() or None,
                     (body.role or "").strip() or None, interests, (body.message or "").strip() or None, ip, (request.headers.get("user-agent") or "")[:300]),
                )
    except psycopg.errors.CheckViolation:
        raise HTTPException(400, "Confira o e-mail informado.")
    return {"ok": True}


@router.get("/leads")
def list_leads(request: Request, limit: int = 100) -> list[dict[str, Any]]:
    require(request, admin=True)
    with db() as conn:
        rows = conn.execute("SELECT id,at,name,company,email,phone,role,interests,message,status FROM auth.leads ORDER BY id DESC LIMIT %s", (max(1, min(limit, 500)),)).fetchall()
    return [{**r, "at": r["at"].isoformat()} for r in rows]


@router.patch("/leads/{lid}")
def update_lead(lid: int, body: LeadPatch, request: Request) -> dict[str, Any]:
    actor = require(request, admin=True)
    with db() as conn:
        with conn.transaction():
            n = conn.execute("UPDATE auth.leads SET status=%s WHERE id=%s", (body.status, lid)).rowcount
            if n:
                log_event(conn, actor["id"], "lead_" + body.status, str(lid), client_ip(request))
    if not n:
        raise HTTPException(404, "Solicitação não encontrada")
    return {"ok": True}
