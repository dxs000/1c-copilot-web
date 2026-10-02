"""Веб-приложение 1С Project Copilot (шаг 1 — заглушка).

Отдаёт два экрана интерфейса («Чат», «Материалы») и состояние системы. Вопросы и загрузка пока
отвечают заглушкой — они подключаются следующими шагами к функциям ядра (пакет copilot1c).

Запуск: copilot1c-web  (порт 80; для разработки: copilot1c-web --port 8080 --reload)
"""

from __future__ import annotations

import time
from datetime import datetime
from importlib import metadata, resources
from pathlib import Path

from copilot1c.config import Settings, get_settings
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from copilot1c_web import __version__

STATIC = Path(str(resources.files("copilot1c_web").joinpath("static")))


def _core_version() -> str:
    try:
        return metadata.version("1c-copilot")
    except metadata.PackageNotFoundError:
        return "?"
STARTED = time.time()

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
    question: str


@app.post("/api/ask")
def ask(req: AskRequest) -> dict:
    """Шаг 1: заглушка. Шаг 2 подключит агента (run_agent) и вернёт ответ с источниками."""
    return {
        "stub": True,
        "answer": f"Заглушка: вопрос «{req.question.strip()[:300]}» принят. Ответы агента подключаются на шаге 2.",
        "sources": [],
    }


@app.post("/api/upload")
def upload() -> JSONResponse:
    return JSONResponse({"stub": True, "detail": "Загрузка материалов подключается на шаге 3."}, status_code=501)


@app.get("/")
def chat_page() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/materials")
def materials_page() -> FileResponse:
    return FileResponse(STATIC / "materials.html")
