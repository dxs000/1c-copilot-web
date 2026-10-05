"""Веб-приложение 1С Project Copilot.

Экраны «Чат» и «Материалы», состояние системы и вопросы к агенту ядра (пакет copilot1c) с
источниками. Загрузка материалов через веб — заглушка до шага 3.

Запуск: copilot1c-web  (порт 80; для разработки: copilot1c-web --port 8080 --reload)
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from importlib import metadata, resources
from pathlib import Path

from copilot1c.config import Settings, get_settings
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from copilot1c_web import __version__

STATIC = Path(str(resources.files("copilot1c_web").joinpath("static")))


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


def _search_sources(s: Settings, question: str, k: int = 8) -> list[dict]:
    """Те же фрагменты, что агент получает перед ответом (тот же запрос и тот же поиск ядра)."""
    from copilot1c.index.yandex import VectorIndex
    from copilot1c.retrieval import smart_search, source_label

    index = VectorIndex(s.vector_store_id, s)
    hits = smart_search(lambda q, f, kk: index.search(q, filters=f, k=kk), question, {"project": s.project}, k)
    out = []
    for i, h in enumerate(hits, 1):
        attrs = h.get("attributes") or {}
        out.append({"n": i, "label": source_label(attrs, h.get("text", "")), "doc_type": attrs.get("doc_type", ""),
                    "date": attrs.get("date", ""), "text": h.get("text", "")})
    return out


def _run_agent(s: Settings, question: str):
    from copilot1c.agent.tools import ToolContext, run_agent
    from copilot1c.graph.store import try_connect

    store = try_connect(s)
    try:
        return run_agent(question, ToolContext(s, s.vector_store_id, Path("data/dumps"), store))
    finally:
        if store is not None:
            store.close()


@app.post("/api/ask")
def ask(req: AskRequest) -> dict:
    """Вопрос агенту: ответ, источники (найденные фрагменты) и шаги агента."""
    s = get_settings()
    if not (s.yc_api_key and s.yc_folder_id and s.vector_store_id):
        raise HTTPException(503, "Не настроены ключи Yandex или COPILOT_VECTOR_STORE_ID в .env")
    question = req.question.strip()
    t0 = time.monotonic()
    try:
        sources = _search_sources(s, question)
        result = _run_agent(s, question)
    except Exception as exc:  # noqa: BLE001 — показываем пользователю причину, а не 500 без текста
        _log("asks", {"question": question, "error": f"{type(exc).__name__}: {exc}"[:500]})
        raise HTTPException(502, f"Ошибка обращения к Yandex AI Studio: {type(exc).__name__}: {str(exc)[:300]}") from exc
    seconds = round(time.monotonic() - t0, 1)
    tools = [t.get("tool", "") for t in getattr(result, "trace", [])]
    _log("asks", {"question": question, "answer": result.answer, "seconds": seconds, "steps": result.steps,
                  "tools": tools, "sources": [x["label"] for x in sources]})
    return {"answer": result.answer, "sources": sources, "seconds": seconds, "steps": result.steps, "tools": tools}


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
