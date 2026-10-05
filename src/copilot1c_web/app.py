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
from importlib import metadata, resources
from pathlib import Path

import httpx
from copilot1c.config import Settings, get_settings
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


def _core_version() -> str:
    try:
        return metadata.version("1c-copilot")
    except metadata.PackageNotFoundError:
        return "?"

app = FastAPI(title="1С Project Copilot", version=__version__, docs_url="/api/docs", redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def _pg_status(s: Settings) -> dict:
    """PostgreSQL: доступен ли и сколько в нём данных. Не роняет страницу, если базы нет."""
    from copilot1c.graph.store import try_connect

    host = s.pg_dsn.split("@")[-1]
    g = try_connect(s)
    if g is None:
        return {"ok": False, "where": host, "detail": "нет подключения"}
    try:
        rows = g.query("SELECT (SELECT count(*) FROM chunks) AS chunks, (SELECT count(*) FROM test_cases) AS test_cases,"
                       " (SELECT count(*) FROM requirements) AS requirements")
        return {"ok": True, "where": host, **rows[0]}
    except Exception as exc:  # noqa: BLE001 — база есть, но схема не создана
        return {"ok": True, "where": host, "detail": f"схема не создана (copilot1c init-db): {type(exc).__name__}"}
    finally:
        g.close()


def _index_status(s: Settings) -> dict:
    if not s.vector_store_id:
        return {"configured": False, "chunks": 0}
    from copilot1c.index.yandex import VectorIndex

    return {"configured": True, "chunks": len(VectorIndex(s.vector_store_id, s).load_manifest())}


@app.get("/api/health")
def health() -> JSONResponse:
    s = get_settings()
    from copilot1c.ingest.ocr import backend

    body = {
        "version": __version__,
        "core_version": _core_version(),
        "now": datetime.now().astimezone().isoformat(timespec="seconds"),
        "uptime_s": int(time.time() - STARTED),
        "project": s.project,
        "yandex": {"configured": bool(s.yc_api_key and s.yc_folder_id), "model": s.model_orchestrator},
        "index": _index_status(s),
        "postgres": _pg_status(s),
        "ocr": backend(s),
    }
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
