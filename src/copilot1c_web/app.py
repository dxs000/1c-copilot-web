"""Веб-приложение 1С Project Copilot.

Экраны «Чат», «Входящие» (разбор и приём материалов), «Обращения» и «Секретарь» (распорядок дня),
состояние системы и вопросы к агенту с источниками. Всё
уходит в демон ядра (служба copilot1c-core, HTTP на 127.0.0.1:8100; адрес — COPILOT_CORE_URL): у ядра
свои настройки, индекс, база и файлы. Веб только пересылает запросы и отдаёт страницы.

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
from typing import Annotated

import httpx
from copilot1c.config import get_settings
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
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


@app.middleware("http")
async def no_stale_pages(request, call_next):
    """Страницы и статика — с проверкой свежести: после обновления веба браузер не держит старый app.js."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


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
    ai, vs, pg = c.get("ai_studio", {}), c.get("search") or c.get("vector_store", {}), c.get("postgres", {})
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


MAX_CHAT_FILES = 10


@app.post("/api/ask-files")
def ask_files(question: Annotated[str, Form(min_length=2, max_length=2000)],
              files: Annotated[list[UploadFile], File()]) -> dict:
    """Вопрос с приложенными файлами («+» в чате) → ядро POST /ask/files. Файлы — контекст этого вопроса,
    в базу не сохраняются."""
    if len(files) > MAX_CHAT_FILES:
        raise HTTPException(413, f"Не больше {MAX_CHAT_FILES} файлов к одному вопросу")
    question = question.strip()
    parts = [("files", (f.filename or "файл", f.file.read(), f.content_type or "application/octet-stream"))
             for f in files]
    try:
        data = _core_call("POST", "/ask/files", data={"question": question}, files=parts)
    except HTTPException as exc:
        _log("asks", {"question": question, "files": [p[1][0] for p in parts], "error": str(exc.detail)[:500]})
        raise
    _log("asks", {"question": question, "files": [p[1][0] for p in parts], "answer": data.get("answer", ""),
                  "seconds": data.get("seconds"), "steps": data.get("steps"), "tools": data.get("tools", []),
                  "sources": [x.get("label", "") for x in data.get("sources", [])]})
    return data


@app.post("/api/escalations")
def escalations_create(payload: Annotated[str, Form()] = "{}",
                       files: Annotated[list[UploadFile] | None, File()] = None) -> dict:
    """Пакет для эксперта (Claude): собирает ядро (POST /escalations), веб пересылает вопрос, материалы и файлы."""
    if files and len(files) > MAX_CHAT_FILES:
        raise HTTPException(413, f"Не больше {MAX_CHAT_FILES} файлов")
    parts = [("files", (f.filename or "файл", f.file.read(), f.content_type or "application/octet-stream"))
             for f in files or []]
    data = _core_call("POST", "/escalations", data={"payload": payload}, files=parts or None)
    _log("escalations", {"id": data.get("id"), "filename": data.get("filename"), "size": data.get("size"),
                         "raw_attachments": data.get("raw_attachments")})
    return data


@app.get("/api/escalations/{package_id}")
def escalations_get(package_id: str) -> Response:
    """Скачать архив пакета (zip) — имя файла от ядра."""
    try:
        r = httpx.get(f"{CORE_URL}/escalations/{package_id}", timeout=CORE_TIMEOUT)
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"Ядро недоступно ({CORE_URL})") from exc
    if r.status_code != 200:
        detail = "Пакет не найден" if r.status_code == 404 else f"Ошибка ядра: HTTP {r.status_code}"
        raise HTTPException(r.status_code, detail)
    headers = {k: r.headers[k] for k in ("content-disposition",) if k in r.headers}
    return Response(r.content, media_type="application/zip", headers=headers)


@app.post("/api/feedback")
def feedback(req: FeedbackRequest) -> dict:
    _log("feedback", req.model_dump())
    return {"ok": True}


class IntentFeedback(BaseModel):
    question: str = Field(max_length=20000)
    verdict: str = Field(pattern="^(registered|edit|not_issue|issue_updated)$")
    intent: dict = Field(default_factory=dict)
    issue_id: int | None = None


@app.post("/api/intent-feedback")
def intent_feedback(req: IntentFeedback) -> dict:
    """Что аналитик сделал с предложением зарегистрировать обращение — в .cache/web/intents.jsonl.
    «not_issue» — ложные срабатывания эвристик, кандидаты в размеченный набор tests/test_intent.py."""
    _log("intents", req.model_dump())
    return {"ok": True}


MAX_UPLOAD_FILES = 20


def _core_call(method: str, path: str, **kw) -> dict:
    """Запрос к демону ядра с понятными ошибками: недоступен → 503, таймаут → 504, ошибка ядра — как есть."""
    try:
        r = httpx.request(method, f"{CORE_URL}{path}", timeout=CORE_TIMEOUT, **kw)
    except httpx.TimeoutException as exc:
        raise HTTPException(504, f"Ядро не ответило за {CORE_TIMEOUT} с") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"Ядро недоступно ({CORE_URL}). Проверьте службу: systemctl status copilot1c-core") \
            from exc
    try:
        data = r.json()
    except ValueError:
        data = {}
    if r.status_code != 200:
        detail = data.get("detail")
        if not isinstance(detail, str | dict):  # dict — например, 409 обращений с актуальной карточкой
            detail = f"Ошибка ядра: HTTP {r.status_code}"
        raise HTTPException(r.status_code, detail)
    return data


@app.post("/api/upload")
def upload(files: Annotated[list[UploadFile], File()]) -> dict:
    """Файлы из браузера → демон ядра (POST /materials): сохранение, реестр, очередь обработки."""
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(413, f"Не больше {MAX_UPLOAD_FILES} файлов за раз")
    parts = [("files", (f.filename or "файл", f.file.read(), f.content_type or "application/octet-stream"))
             for f in files]
    data = _core_call("POST", "/materials", files=parts)
    _log("uploads", {"files": [{"filename": m.get("filename"), "id": m.get("id"), "error": m.get("error"),
                                "already_uploaded": m.get("already_uploaded")} for m in data.get("materials", [])]})
    return data


@app.get("/api/materials")
def materials(limit: int = 200) -> dict:
    """Реестр загруженных материалов и их статусы (по данным демона ядра)."""
    return _core_call("GET", "/materials", params={"limit": limit})


@app.delete("/api/materials/{material_id}")
def material_delete(material_id: int) -> dict:
    """Убрать материал из базы: фрагменты, редакции документов, письма (файл и запись реестра остаются)."""
    data = _core_call("DELETE", f"/materials/{material_id}")
    _log("uploads", {"deleted": material_id, "chunks": data.get("removed_chunks")})
    return data


@app.post("/api/materials/{material_id}/retry")
def material_retry(material_id: int) -> dict:
    """Материал с ошибкой — снова в очередь обработки."""
    return _core_call("POST", f"/materials/{material_id}/retry")


# ---------- «Входящие»: разбор принесённого и приём по решению аналитика ----------

def _parts(files: list[UploadFile]) -> list:
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(413, f"Не больше {MAX_UPLOAD_FILES} файлов за раз")
    return [("files", (f.filename or "файл", f.file.read(), f.content_type or "application/octet-stream"))
            for f in files]


@app.post("/api/intake/analyze")
def intake_analyze(files: Annotated[list[UploadFile], File()]) -> dict:
    """Что это, к чему относится, что уже в базе, что предложить — без сохранения (ядро: POST /intake/analyze)."""
    return _core_call("POST", "/intake/analyze", files=_parts(files))


@app.post("/api/intake/accept")
def intake_accept(files: Annotated[list[UploadFile], File()], decisions: Annotated[str, Form()] = "[]") -> dict:
    """Файлы с решениями аналитика → ядро (POST /intake/accept): в обработку, без индексации или мимо."""
    data = _core_call("POST", "/intake/accept", files=_parts(files), data={"decisions": decisions})
    _log("uploads", {"intake": [{"filename": m.get("filename"), "id": m.get("id"), "status": m.get("status"),
                                 "skipped": m.get("skipped"), "error": m.get("error")}
                                for m in data.get("materials", [])],
                     "contours_created": data.get("contours_created", [])})
    return data


@app.get("/api/contours")
def contours(all: bool = False) -> dict:  # noqa: A002 — имя параметра запроса
    return _core_call("GET", "/contours", params={"all": str(all).lower()})


@app.post("/api/contours")
def contours_create(body: Annotated[dict, Body()]) -> dict:
    return _core_call("POST", "/contours", json=body)


@app.patch("/api/contours/{contour_id}")
def contours_patch(contour_id: int, body: Annotated[dict, Body()]) -> dict:
    return _core_call("PATCH", f"/contours/{contour_id}", json=body)


@app.get("/api/documents")
def documents(q: str = "", limit: int = 200) -> dict:
    return _core_call("GET", "/documents", params={"q": q, "limit": limit} if q else {"limit": limit})


@app.get("/api/threads")
def threads(q: str = "", limit: int = 100) -> dict:
    return _core_call("GET", "/threads", params={"q": q, "limit": limit} if q else {"limit": limit})


@app.get("/api/threads/{thread_id}")
def thread(thread_id: int) -> dict:
    return _core_call("GET", f"/threads/{thread_id}")


# ---------- обращения: те же методы, что у демона ядра (/issues…, /contacts), под префиксом /api ----------
# Проверку полей, историю и защиту от одновременной правки ведёт ядро; веб пересылает запрос как есть.

@app.get("/api/issues/meta")
def issues_meta() -> dict:
    return _core_call("GET", "/issues/meta")


@app.get("/api/issues")
def issues_list(request: Request) -> dict:
    """Фильтры (status, priority, category, assignee, open, q, limit) пересылаются как есть."""
    return _core_call("GET", "/issues", params=dict(request.query_params))


@app.post("/api/issues")
def issues_create(body: Annotated[dict, Body()]) -> dict:
    return _core_call("POST", "/issues", json=body)


@app.get("/api/issues/{issue_id}")
def issues_get(issue_id: int) -> dict:
    return _core_call("GET", f"/issues/{issue_id}")


@app.patch("/api/issues/{issue_id}")
def issues_patch(issue_id: int, body: Annotated[dict, Body()]) -> dict:
    return _core_call("PATCH", f"/issues/{issue_id}", json=body)


@app.post("/api/issues/{issue_id}/comments")
def issues_comment(issue_id: int, body: Annotated[dict, Body()]) -> dict:
    return _core_call("POST", f"/issues/{issue_id}/comments", json=body)


@app.post("/api/issues/{issue_id}/kb-draft")
def issues_kb_draft(issue_id: int) -> dict:
    """Разбор решённого обращения для базы знаний (готовит ядро, ничего не сохраняет)."""
    return _core_call("POST", f"/issues/{issue_id}/kb-draft", json={})


@app.post("/api/issues/{issue_id}/kb-publish")
def issues_kb_publish(issue_id: int, body: Annotated[dict, Body()]) -> dict:
    """Разбор → материал «Решение ОБР-… — тема.md» и ссылка на него в обращении."""
    return _core_call("POST", f"/issues/{issue_id}/kb-publish", json=body)


@app.get("/api/issues/{issue_id}/related")
def issues_related(issue_id: int) -> dict:
    """Похожие обращения и связанные тест-кейсы ПиМИ и пункты ТЗ (считает ядро)."""
    return _core_call("GET", f"/issues/{issue_id}/related")


@app.post("/api/issues/related")
def issues_related_draft(body: Annotated[dict, Body()]) -> dict:
    """То же для черновика: новое обращение в карточке или карточка в чате."""
    return _core_call("POST", "/issues/related", json=body)


@app.post("/api/issues/from-email")
def issues_from_email(file: Annotated[UploadFile, File()]) -> dict:
    """Письмо .msg/.eml → черновик обращения от ядра (инициатор, тема, текст, цепочка). Ничего не сохраняет."""
    part = ("file", (file.filename or "письмо", file.file.read(), file.content_type or "application/octet-stream"))
    return _core_call("POST", "/issues/from-email", files=[part])


@app.post("/api/issues/suggest-contours")
def issues_suggest_contours(body: Annotated[dict, Body()]) -> dict:
    """Система и подсистема для обращения (ядро: POST /issues/suggest-contours)."""
    return _core_call("POST", "/issues/suggest-contours", json=body)


@app.post("/api/issues/triage")
def issues_triage(files: Annotated[list[UploadFile], File()], question: Annotated[str, Form()] = "") -> dict:
    """Письмо по обращениям: обновить существующее, новое или только в базу (ядро: POST /issues/triage)."""
    return _core_call("POST", "/issues/triage", files=_parts(files), data={"question": question})


@app.post("/api/issues/{issue_id}/attachments")
def issues_attach(issue_id: int, files: Annotated[list[UploadFile], File()],
                  actor: Annotated[str | None, Form()] = None, expand: Annotated[bool, Form()] = False) -> dict:
    """expand — прикрепить письмо вместе с вложенными в него файлами (разбирает ядро)."""
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(413, f"Не больше {MAX_UPLOAD_FILES} файлов за раз")
    parts = [("files", (f.filename or "файл", f.file.read(), f.content_type or "application/octet-stream"))
             for f in files]
    data = {k: v for k, v in (("actor", actor), ("expand", "true" if expand else None)) if v}
    return _core_call("POST", f"/issues/{issue_id}/attachments", files=parts, data=data or None)


@app.get("/api/issues/{issue_id}/attachments/{attachment_id}")
def issues_attachment(issue_id: int, attachment_id: int) -> Response:
    """Файл вложения от ядра: тот же тип и имя (Content-Disposition), чтобы браузер открыл или скачал его."""
    try:
        r = httpx.get(f"{CORE_URL}/issues/{issue_id}/attachments/{attachment_id}", timeout=CORE_TIMEOUT)
    except httpx.HTTPError as exc:
        raise HTTPException(503, f"Ядро недоступно ({CORE_URL})") from exc
    if r.status_code != 200:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = None
        raise HTTPException(r.status_code, detail if isinstance(detail, str) else f"Ошибка ядра: HTTP {r.status_code}")
    media = r.headers.get("content-type", "application/octet-stream")
    headers = {"X-Content-Type-Options": "nosniff"}  # браузер не угадывает тип: файл заказчика не станет страницей
    disposition = r.headers.get("content-disposition", "")
    if _viewable(media):  # скриншоты, PDF и тексты открываются во вкладке, остальное скачивается
        disposition = disposition.replace("attachment", "inline", 1)
    if disposition:
        headers["Content-Disposition"] = disposition
    return Response(r.content, media_type=media, headers=headers)


def _viewable(media: str) -> bool:
    """Безопасно показать в браузере: картинки (кроме SVG — в нём бывают скрипты), PDF, простой текст."""
    m = media.split(";", 1)[0].strip().lower()
    return (m.startswith("image/") and m != "image/svg+xml") or m in ("application/pdf", "text/plain")


@app.get("/api/contacts")
def contacts(q: str = "", limit: int = 50) -> dict:
    return _core_call("GET", "/contacts", params={"q": q, "limit": limit})


@app.post("/api/contacts")
def contacts_upsert(body: Annotated[dict, Body()]) -> dict:
    return _core_call("POST", "/contacts", json=body)


# ---------- секретарь: место, рабочие сессии и перерывы (всё хранит и считает ядро) ----------

@app.post("/api/secretary/say")
def secretary_say(body: Annotated[dict, Body()]) -> dict:
    return _core_call("POST", "/secretary/say", json=body)


@app.get("/api/secretary/state")
def secretary_state(person: str = "") -> dict:
    return _core_call("GET", "/secretary/state", params={"person": person})


@app.get("/api/secretary/notices")
def secretary_notices(person: str = "", after: int = 0, unread: bool = False) -> dict:
    return _core_call("GET", "/secretary/notices", params={"person": person, "after": after, "unread": unread})


@app.post("/api/secretary/notices/{notice_id}/read")
def secretary_notice_read(notice_id: int, body: Annotated[dict, Body()]) -> dict:
    return _core_call("POST", f"/secretary/notices/{notice_id}/read", json=body)


@app.get("/api/secretary/places")
def secretary_places(person: str = "", limit: int = 50) -> dict:
    return _core_call("GET", "/secretary/places", params={"person": person, "limit": limit})


@app.get("/secretary")
def secretary_page() -> FileResponse:
    return FileResponse(STATIC / "secretary.html")


@app.get("/issues")
def issues_page() -> FileResponse:
    return FileResponse(STATIC / "issues.html")


@app.get("/")
def chat_page() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/materials")
def materials_page() -> FileResponse:
    return FileResponse(STATIC / "materials.html")
