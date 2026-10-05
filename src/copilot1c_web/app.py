"""Веб-приложение 1С Project Copilot.

Экраны «Чат» и «Материалы», состояние системы и вопросы к агенту с источниками. Вопросы уходят в
демон ядра (служба copilot1c-core, HTTP на 127.0.0.1:8100; адрес — COPILOT_CORE_URL): у ядра свои
настройки, индекс и кэш. Загрузка материалов через веб — заглушка до шага 3.

Запуск: copilot1c-web  (порт 80; для разработки: copilot1c-web --port 8080 --reload)
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime
from importlib import resources
from pathlib import Path

import httpx
from copilot1c.config import get_settings
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from copilot1c_web import __version__

STATIC = Path(str(resources.files("copilot1c_web").joinpath("static")))


CORE_URL = os.environ.get("COPILOT_CORE_URL", "http://127.0.0.1:8100").rstrip("/")
CORE_TIMEOUT = 300  # агент отвечает 10–40 с, но при ограничениях AI Studio SDK ждёт и повторяет
STARTED = time.time()
_LOG_LOCK = threading.Lock()


app = FastAPI(title="1С Project Copilot", version=__version__, docs_url="/api/docs", redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _core_health() -> dict | None:
    """Состояние ядра от демона; None — демон недоступен."""
    try:
        r = httpx.get(f"{CORE_URL}/health", timeout=10)
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


@app.get("/api/health")
def health() -> JSONResponse:
    """Состояние системы для шапки и экрана «Материалы» — по данным демона ядра, в прежнем формате."""
    body: dict = {"version": __version__, "now": datetime.now().astimezone().isoformat(timespec="seconds"),
                  "uptime_s": int(time.time() - STARTED)}
    core = _core_health()
    if core is None:
        body.update({"core": {"ok": False, "url": CORE_URL}, "core_version": "?", "project": get_settings().project,
                     "yandex": {"configured": False, "model": ""}, "index": {"configured": False, "chunks": 0},
                     "postgres": {"ok": False, "where": "", "detail": "ядро недоступно"}, "ocr": "?"})
        return JSONResponse(body)
    c = core.get("checks", {})
    ai, vs, pg = c.get("ai_studio", {}), c.get("vector_store", {}), c.get("postgres", {})
    postgres = {"ok": pg.get("ok", False), "where": pg.get("host", "")}
    postgres.update({k: pg[k] for k in ("chunks", "test_cases", "requirements", "detail") if k in pg})
    body.update({
        "core": {"ok": True, "url": CORE_URL, "status": core.get("status")},
        "core_version": core.get("version", "?"),
        "project": core.get("project", ""),
        "yandex": {"configured": ai.get("ok", False), "model": ai.get("model", "")},
        "index": {"configured": vs.get("ok", False), "chunks": vs.get("chunks", 0)},
        "postgres": postgres,
        "ocr": c.get("ocr", {}).get("backend", "?"),
    })
    return JSONResponse(body)


class AskRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)


class FeedbackRequest(BaseModel):
    question: str = Field(max_length=2000)
    answer: str = Field(max_length=20000)
    verdict: str = Field(pattern="^(ok|wrong)$")
    comment: str = Field(default="", max_length=2000)


def _log(name: str, record: dict) -> None:
    """Журнал вопросов и отметок — в .cache/web/*.jsonl: аудит и пополнение эталонного набора для eval."""
    s = get_settings()
    path = Path(s.cache_dir or ".cache") / "web" / f"{name}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"at": datetime.now().astimezone().isoformat(timespec="seconds"), **record}, ensure_ascii=False)
    with _LOG_LOCK, path.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def _core_ask(question: str) -> httpx.Response:
    """Вопрос демону ядра; ответ в формате {answer, sources, seconds, steps, tools}."""
    return httpx.post(f"{CORE_URL}/ask", json={"question": question}, timeout=CORE_TIMEOUT)


@app.post("/api/ask")
def ask(req: AskRequest) -> dict:
    """Вопрос агенту через демон ядра: ответ, источники (найденные фрагменты) и шаги агента."""
    question = req.question.strip()
    try:
        r = _core_ask(question)
    except httpx.TimeoutException as exc:
        _log("asks", {"question": question, "error": "таймаут ядра"})
        raise HTTPException(504, f"Ядро не ответило за {CORE_TIMEOUT} с") from exc
    except httpx.HTTPError as exc:
        _log("asks", {"question": question, "error": f"ядро недоступно: {type(exc).__name__}"})
        raise HTTPException(503, f"Ядро недоступно ({CORE_URL}). Проверьте службу: systemctl status copilot1c-core") \
            from exc
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code != 200:
        detail = data.get("detail") if isinstance(data.get("detail"), str) else f"Ошибка ядра: HTTP {r.status_code}"
        _log("asks", {"question": question, "error": detail[:500]})
        raise HTTPException(r.status_code, detail)
    _log("asks", {"question": question, "answer": data.get("answer", ""), "seconds": data.get("seconds"),
                  "steps": data.get("steps"), "tools": data.get("tools", []),
                  "sources": [x.get("label", "") for x in data.get("sources", [])]})
    return data


@app.post("/api/feedback")
def feedback(req: FeedbackRequest) -> dict:
    _log("feedback", req.model_dump())
    return {"ok": True}


@app.post("/api/upload")
def upload() -> JSONResponse:
    return JSONResponse({"stub": True, "detail": "Загрузка материалов подключается на шаге 3."}, status_code=501)


@app.get("/")
def chat_page() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/materials")
def materials_page() -> FileResponse:
    return FileResponse(STATIC / "materials.html")
