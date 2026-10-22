"""GPlanSiS|PDIN · Gateway de telemetria (PLC/IHM via OPC UA, IoT via MQTT) → API PDIN.

Somente leitura: nenhum comando é escrito no PLC (IEC 62443 · zona de aplicação read-only).
Configuração em integration/<projeto>.json. Uso:

    python tools/opcua_gateway.py integration/meu-projeto-gateway.json            # OPC UA + MQTT reais
    python tools/opcua_gateway.py integration/meu-projeto-gateway.json --simulate # POC sem PLC: gera valores plausíveis
    python tools/opcua_gateway.py integration/meu-projeto-gateway.json --once     # uma leitura e sai (teste de comissionamento)
    python tools/opcua_gateway.py integration/*-gateway.json --simulate       # demonstração: vários projetos, amostras marcadas como simuladas

Com a API protegida por login, defina PDIN_GATEWAY_TOKEN (o mesmo do servidor).

Dependências opcionais: `pip install asyncua paho-mqtt`. Sem elas o gateway roda apenas em --simulate.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


TOKEN = os.environ.get("PDIN_GATEWAY_TOKEN", "")


def api(base: str, method: str, path: str, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"content-type": "application/json"}
    if TOKEN:  # a API exige sessão; o gateway usa o token próprio (PDIN_GATEWAY_TOKEN)
        headers["authorization"] = "Bearer " + TOKEN
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def resolve_project(base: str, code: str) -> str:
    for p in api(base, "GET", "/api/projects?status=all"):
        if p["code"] == code:
            return p["id"]
    raise SystemExit(f"Projeto {code} não encontrado na API {base}")


class Simulator:
    """Valores plausíveis para POC/demonstração, marcados como simulados na API.

    - Segue o setpoint da receita do lote que ocupa o recurso (lê o estado do projeto a cada minuto),
      para não gerar desvio falso quando o tanque troca de produto.
    - Perfil por unidade: temperatura converge ao alvo, densidade (°P) cai de OG a FG, corrente e vibração
      de motor com ruído, níveis e aberturas de válvula em ondas lentas, vazões e pressões dentro da faixa.
    - Excursões raras em vibração e ΔP de filtro (≈2 min a cada ~40 min por tag) para exercitar o andon.
    """

    def __init__(self, tags: list[dict], base: str | None = None, pid: str | None = None):
        self.t0 = time.time()
        self.tags = tags
        self.state: dict[str, float] = {}
        self.base, self.pid = base, pid
        self.ctx: dict[str, dict] = {}
        self.ctx_at = 0.0
        self.phase = {t["tag"]: random.uniform(0, 1000) for t in tags}

    def refresh_context(self) -> None:
        """Mapa recurso → parâmetros da receita do lote em execução (mesma regra de runningAt no motor)."""
        if not self.base or time.time() - self.ctx_at < 60:
            return
        self.ctx_at = time.time()
        try:
            st = api(self.base, "GET", f"/api/projects/{self.pid}/state").get("state") or {}
        except Exception:
            return
        ctx = {}
        stages, products = st.get("stages", []), st.get("products", [])
        for o in st.get("orders", []):
            for op in o.get("ops", []):
                if op.get("status") != "running":
                    continue
                stg = stages[op["stage"]] if op.get("stage") is not None and op["stage"] < len(stages) else None
                res = (stg or {}).get("resources") or []
                lane = op.get("lane") or 0
                if stg and lane < len(res):
                    prod = products[o["product"]] if isinstance(o.get("product"), int) and o["product"] < len(products) else {}
                    ctx[res[lane]] = prod.get("params") or {}
        self.ctx = ctx

    def _range(self, tag: dict, a: float, b: float, default: tuple[float, float]) -> float:
        lo, hi = tag.get("lo"), tag.get("hi")
        if lo is None or hi is None:
            lo, hi = default
        return lo + (hi - lo) * (a + (b - a) * 0.5)

    def _excursion(self, key: str, t: float) -> float:
        cyc = (t + self.phase[key]) % 40.0  # minutos
        return max(0.0, 1 - abs(cyc - 1.0)) if cyc < 2.0 else 0.0

    def _drift(self, key: str, target: float, gain: float, noise: float) -> float:
        cur = self.state.get(key, target + random.uniform(-2, 2) * noise * 10)
        cur += (target - cur) * gain + random.gauss(0, noise)
        self.state[key] = cur
        return cur

    def sample(self, tag: dict) -> float:
        t = (time.time() - self.t0) / 60.0
        kind, unit, key = tag.get("kind", "analog"), tag.get("unit", ""), tag["tag"]
        lo, hi = tag.get("lo"), tag.get("hi")
        wave = math.sin((t + self.phase[key]) / 23.0)
        params = self.ctx.get(tag.get("resource") or "", None)
        if kind == "digital":  # contato de alarme/intertravamento: 0 normal, 1 em excursões raras (≈40 s a cada ~40 min)
            return 1.0 if self._excursion(key, t) > 0.7 else 0.0
        if kind == "counter":
            self.state[key] = self.state.get(key, 0) + (random.randint(1, 4) if params is not None else 0)
            return float(self.state[key])
        if unit == "°C":
            sp = None
            if tag.get("setpoint") and params:
                sp = params.get(tag["setpoint"])
            if sp is None and tag.get("setpoint_value") is not None and params is not None:
                sp = tag["setpoint_value"]
            if sp is None:
                sp = self._range(tag, 0.35, 0.55, (4, 30)) if lo is not None else (8 if params is None else 18)
            return round(self._drift(key, sp + 0.25 * wave, 0.08, 0.08), 2)
        if unit == "°P":  # densidade do mosto: OG → FG ao longo da fermentação
            og = (params or {}).get("og", 12.0)
            fg = (params or {}).get("fg", 2.5)
            cur = self.state.get(key, og)
            cur = og if params is None else max(fg, cur - random.uniform(0.001, 0.004))
            self.state[key] = cur
            return round(cur, 2)
        if unit == "mm/s":  # vibração ISO 10816: 1,5–3 mm/s normal, excursões até acima do limite
            base = self._drift(key, 2.2 + 0.4 * wave, 0.15, 0.08)
            peak = (hi or 7.1) * 1.08
            return round(max(0.3, base + (peak - base) * self._excursion(key, t)), 2)
        if unit == "A":
            return round(self._drift(key, self._range(tag, 0.55, 0.72, (0, 60)) + 2 * wave, 0.2, 0.3), 1)
        if unit == "%":
            return round(min(100, max(0, self._range(tag, 0.3, 0.8, (0, 100)) + 22 * wave + random.gauss(0, 0.6))), 1)
        if unit == "bar":
            if "diferencial" in (tag.get("description") or "").lower():  # ΔP de filtro: sobe com saturação
                base = self._range(tag, 0.15, 0.35, (0, 2))
                return round(base + ((hi or 2) * 1.05 - base) * self._excursion(key, t), 3)
            if lo is None:
                return round(0.9 + 0.25 * wave + random.gauss(0, 0.02), 3)
            return round(self._range(tag, 0.35, 0.55, (0, 6)) + 0.08 * (hi - lo) * wave + random.gauss(0, 0.01 * (hi - lo)), 3)
        if unit == "kg":
            return round(600 + 200 * wave, 1)
        if unit in ("m³/h", "t/h"):
            return round(max(0, self._range(tag, 0.45, 0.7, (0, 12)) * (1 + 0.15 * wave) + random.gauss(0, 0.15)), 2)
        if unit == "NTU":
            return round(max(2, 18 + 8 * wave + random.gauss(0, 1)), 1)
        return round(random.uniform(lo or 0, hi or 100), 2)


async def read_opcua(cfg: dict, tags: list[dict]) -> list[dict]:
    try:
        from asyncua import Client  # type: ignore
    except ImportError:
        raise SystemExit("asyncua não instalado: pip install asyncua (ou use --simulate)")
    out = []
    async with Client(url=cfg["endpoint"]) as client:
        for tag in tags:
            try:
                node = client.get_node(tag["address"])
                dv = await node.read_data_value()
                out.append({"tag": tag["tag"], "value": float(dv.Value.Value), "quality": 192 if dv.StatusCode.is_good() else 0, "at": (dv.SourceTimestamp or datetime.now(timezone.utc)).isoformat()})
            except Exception as exc:  # tag ausente ou falha: registra qualidade ruim, não interrompe o lote
                out.append({"tag": tag["tag"], "value": 0.0, "quality": 0, "at": datetime.now(timezone.utc).isoformat(), "error": str(exc)[:80]})
    return out


def read_mqtt(cfg: dict, tags: list[dict], seconds: float) -> list[dict]:
    try:
        import paho.mqtt.client as mqtt  # type: ignore
    except ImportError:
        raise SystemExit("paho-mqtt não instalado: pip install paho-mqtt (ou use --simulate)")
    got = {}

    def on_message(_c, _u, msg):
        try:
            got[msg.topic] = float(msg.payload.decode())
        except ValueError:
            pass

    host, port = cfg["broker"].replace("mqtt://", "").split(":")
    c = mqtt.Client()
    c.on_message = on_message
    c.connect(host, int(port), 30)
    for t in tags:
        c.subscribe(t["address"])
    c.loop_start()
    time.sleep(seconds)
    c.loop_stop()
    now = datetime.now(timezone.utc).isoformat()
    return [{"tag": t["tag"], "value": got[t["address"]], "quality": 192, "at": now} for t in tags if t["address"] in got]


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("config", nargs="+", help="um ou mais integration/<projeto>-gateway.json")
    ap.add_argument("--simulate", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--api", default=None)
    args = ap.parse_args()
    if not args.simulate and len(args.config) > 1:
        raise SystemExit("Leitura de campo: um processo por projeto (um PLC por configuração).")
    jobs = []
    for path in args.config:
        cfg = json.loads(Path(path).read_text(encoding="utf-8"))
        base = args.api or cfg.get("api", "http://127.0.0.1:18380")
        for attempt in range(30):  # a API pode ainda estar subindo
            try:
                pid = resolve_project(base, cfg["projectCode"])
                break
            except (OSError, urllib.error.URLError) as exc:
                print(f"API indisponível ({exc}); nova tentativa em 5 s", file=sys.stderr)
                time.sleep(5)
        else:
            raise SystemExit("API não respondeu")
        tags = cfg["tags"]
        jobs.append({"cfg": cfg, "base": base, "pid": pid, "tags": tags, "sim": Simulator(tags, base, pid),
                     "opc": [t for t in tags if t.get("source", "opcua") == "opcua"], "mq": [t for t in tags if t.get("source") == "mqtt"]})
        print(f"gateway → {base} · projeto {cfg['projectCode']} ({pid}) · {len(tags)} tags · {'SIMULAÇÃO' if args.simulate else 'campo'}", flush=True)
    poll = min(float(j["cfg"].get("pollSeconds", 5)) for j in jobs)
    n = 0
    while True:
        for j in jobs:
            now = datetime.now(timezone.utc).isoformat()
            if args.simulate:
                j["sim"].refresh_context()
                samples = [{"tag": t["tag"], "value": j["sim"].sample(t), "quality": 192, "at": now} for t in j["tags"]]
            else:
                samples = []
                if j["opc"]:
                    samples += asyncio.run(read_opcua(j["cfg"]["opcua"], j["opc"]))
                if j["mq"]:
                    samples += read_mqtt(j["cfg"]["mqtt"], j["mq"], min(poll, 3))
            try:
                res = api(j["base"], "POST", f"/api/projects/{j['pid']}/telemetry", {"samples": samples, "simulated": args.simulate})
                if n % 60 == 0 or args.once:  # log a cada ~5 min por projeto
                    bad = sum(1 for s in samples if s.get("quality") != 192)
                    print(f"{datetime.now().strftime('%H:%M:%S')} · {j['cfg']['projectCode']} · {res.get('ingested', 0)} amostras · {bad} com qualidade ruim", flush=True)
            except Exception as exc:
                print(f"falha ao enviar {j['cfg']['projectCode']}:", exc, file=sys.stderr, flush=True)
        if args.once:
            break
        n += 1
        time.sleep(poll)


if __name__ == "__main__":
    main()
