import json

from copilot1c.config import Settings
from copilot1c.graph import store
from fastapi.testclient import TestClient

from copilot1c_web import app as web


def _client(monkeypatch, tmp_path, **settings):
    s = Settings(cache_dir=str(tmp_path), **settings)
    monkeypatch.setattr(web, "get_settings", lambda: s)
    monkeypatch.setattr(store, "try_connect", lambda s=None: None)
    return TestClient(web.app)


def test_pages_and_static(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    for path, marker in (("/", "source-panel"), ("/materials", "Материалы проекта"),
                         ("/static/app.js", "renderMarkdown"), ("/static/style.css", "--accent")):
        r = c.get(path)
        assert r.status_code == 200 and marker in r.text, path


CORE_HEALTH = {"status": "ok", "version": "0.1.0", "project": "ut11-update", "checks": {
    "ai_studio": {"ok": True, "folder": "b1g", "model": "gpt-oss-120b/latest"},
    "vector_store": {"ok": True, "id": "vs1", "manifest": True, "chunks": 1100},
    "postgres": {"ok": True, "tables": 12, "chunks": 1100, "test_cases": 68, "requirements": 341,
                 "host": "localhost:5432/copilot"},
    "platform_1c": {"ok": False, "optional": True}, "ocr": {"ok": True, "backend": "yandex", "optional": True}}}


def test_health_from_core_keeps_web_format(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    monkeypatch.setattr(web, "_core_health", lambda: CORE_HEALTH)
    h = c.get("/api/health").json()
    assert h["core"]["ok"] is True and h["core_version"] == "0.1.0" and h["project"] == "ut11-update"
    assert h["yandex"] == {"configured": True, "model": "gpt-oss-120b/latest"}
    assert h["index"] == {"configured": True, "chunks": 1100} and h["ocr"] == "yandex"
    assert h["postgres"] == {"ok": True, "where": "localhost:5432/copilot", "chunks": 1100, "test_cases": 68,
                             "requirements": 341}


def test_health_when_core_is_down(monkeypatch, tmp_path):
    import httpx

    c = _client(monkeypatch, tmp_path)

    def refused(*a, **kw):
        raise httpx.ConnectError("Connection refused")

    monkeypatch.setattr(httpx, "get", refused)
    h = c.get("/api/health").json()
    assert h["core"]["ok"] is False and h["index"] == {"configured": False, "chunks": 0}
    assert h["postgres"]["detail"] == "ядро недоступно" and h["project"] == "ut11-update"


def _core(monkeypatch, status=200, body=None, exc=None):
    import httpx

    sent = []

    def fake(question):
        sent.append(question)
        if exc:
            raise exc
        return httpx.Response(status, json=body if body is not None else {})

    monkeypatch.setattr(web, "_core_ask", fake)
    return sent


def test_ask_proxies_to_core_and_logs(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    src = [{"n": 1, "label": "Письмо · 2025-03-01", "doc_type": "email", "date": "2025-03-01", "text": "11.5.27.75"}]
    body = {"answer": "Потому что [1].", "sources": src, "seconds": 12.3, "steps": 2, "tools": ["search_docs"]}
    sent = _core(monkeypatch, 200, body)
    r = c.post("/api/ask", json={"question": "  Почему не 11.6?  "})
    assert r.status_code == 200 and r.json() == body and sent == ["Почему не 11.6?"]
    log = [json.loads(x) for x in (tmp_path / "web" / "asks.jsonl").read_text(encoding="utf-8").splitlines()]
    assert log[0]["question"] == "Почему не 11.6?" and log[0]["sources"] == ["Письмо · 2025-03-01"]
    assert c.post("/api/ask", json={"question": "?"}).status_code == 422


def test_ask_passes_core_errors_through(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    _core(monkeypatch, 502, {"detail": "Ошибка обращения к Yandex AI Studio: 429 Too Many Requests"})
    r = c.post("/api/ask", json={"question": "Почему не 11.6?"})
    assert r.status_code == 502 and "429" in r.json()["detail"]
    _core(monkeypatch, 503, {"detail": "Не настроены ключи Yandex или COPILOT_VECTOR_STORE_ID в .env ядра"})
    assert c.post("/api/ask", json={"question": "Почему не 11.6?"}).status_code == 503
    assert "error" in (tmp_path / "web" / "asks.jsonl").read_text(encoding="utf-8")


def test_ask_when_core_is_down_or_slow(monkeypatch, tmp_path):
    import httpx

    c = _client(monkeypatch, tmp_path)
    _core(monkeypatch, exc=httpx.ConnectError("Connection refused"))
    r = c.post("/api/ask", json={"question": "Почему не 11.6?"})
    assert r.status_code == 503 and "copilot1c-core" in r.json()["detail"]
    _core(monkeypatch, exc=httpx.ReadTimeout("timed out"))
    assert c.post("/api/ask", json={"question": "Почему не 11.6?"}).status_code == 504


def test_feedback_is_logged(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    ok = {"question": "q?", "answer": "a", "verdict": "wrong", "comment": "не та версия"}
    assert c.post("/api/feedback", json=ok).json() == {"ok": True}
    assert c.post("/api/feedback", json={**ok, "verdict": "maybe"}).status_code == 422
    rec = json.loads((tmp_path / "web" / "feedback.jsonl").read_text(encoding="utf-8"))
    assert rec["verdict"] == "wrong" and rec["comment"] == "не та версия" and "at" in rec


def test_health_reports_versions(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    monkeypatch.setattr(web, "_core_health", lambda: CORE_HEALTH)
    h = c.get("/api/health").json()
    assert h["version"] == "0.1.0" and h["core_version"] == "0.1.0"


def test_cli_defaults_to_port_80(monkeypatch):
    import uvicorn

    from copilot1c_web import cli

    seen = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(kw, app=app))
    cli.main([])
    assert seen["port"] == 80 and seen["host"] == "0.0.0.0" and seen["app"] == "copilot1c_web.app:app"


def _core_request(monkeypatch, status=200, body=None, exc=None):
    import httpx

    calls = []

    def fake(method, url, **kw):
        calls.append({"method": method, "url": url, **kw})
        if exc:
            raise exc
        return httpx.Response(status, json=body if body is not None else {})

    monkeypatch.setattr(httpx, "request", fake)
    return calls


def test_upload_forwards_files_to_core_and_logs(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    body = {"materials": [{"id": 1, "filename": "ТЗ.docx", "status": "queued", "already_uploaded": False},
                          {"filename": "пустой.txt", "error": "пустой файл — не сохранён"}]}
    calls = _core_request(monkeypatch, 200, body)
    r = c.post("/api/upload", files=[("files", ("ТЗ.docx", b"docx", "application/octet-stream")),
                                     ("files", ("пустой.txt", b"", "text/plain"))])
    assert r.status_code == 200 and r.json() == body
    sent = calls[0]
    assert sent["method"] == "POST" and sent["url"].endswith("/materials")
    assert [(n, f[0], f[1]) for n, f in sent["files"]] == [("files", "ТЗ.docx", b"docx"), ("files", "пустой.txt", b"")]
    log = json.loads((tmp_path / "web" / "uploads.jsonl").read_text(encoding="utf-8"))
    assert log["files"][0] == {"filename": "ТЗ.docx", "id": 1, "error": None, "already_uploaded": False}


def test_upload_limits_and_core_errors(monkeypatch, tmp_path):
    import httpx

    c = _client(monkeypatch, tmp_path)
    many = [("files", (f"{i}.txt", b"x", "text/plain")) for i in range(21)]
    assert c.post("/api/upload", files=many).status_code == 413
    _core_request(monkeypatch, exc=httpx.ConnectError("refused"))
    r = c.post("/api/upload", files=[("files", ("a.txt", b"x", "text/plain"))])
    assert r.status_code == 503 and "copilot1c-core" in r.json()["detail"]
    _core_request(monkeypatch, 503, {"detail": "PostgreSQL недоступен — реестр материалов не работает"})
    r = c.get("/api/materials")
    assert r.status_code == 503 and "PostgreSQL" in r.json()["detail"]


def test_materials_list_proxied(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    rows = {"materials": [{"id": 2, "filename": "письмо.msg", "status": "duplicate", "status_label": "уже есть"}]}
    calls = _core_request(monkeypatch, 200, rows)
    assert c.get("/api/materials?limit=50").json() == rows
    assert calls[0]["method"] == "GET" and calls[0]["params"] == {"limit": 50}


def test_materials_page_has_live_upload(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    page = c.get("/materials").text
    assert 'id="drop"' in page and 'id="files"' in page and 'id="uploads"' in page and "disabled" not in page
    js = c.get("/static/app.js").text
    assert "initMaterials" in js and "/api/upload" in js and "/api/materials" in js


def test_file_picker_is_native_label_and_pages_not_cached(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    page = c.get("/materials")
    assert '<label class="btn primary" for="files" id="pick"' in page.text  # диалог открывается и без скрипта
    assert page.headers["cache-control"] == "no-cache"
    assert c.get("/static/app.js").headers["cache-control"] == "no-cache"


# ---------- обращения ----------

def test_issues_page_and_tabs(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    page = c.get("/issues").text
    assert 'id="issue-panel"' in page and 'id="issues"' in page and "/static/issues.js" in page
    for path in ("/", "/materials", "/issues"):
        assert 'href="/issues"' in c.get(path).text, path  # вкладка на всех экранах
    js = c.get("/static/issues.js").text
    assert "initIssues" in js and "/api/issues" in js and "409" in js


def test_issues_calls_are_forwarded(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    calls = _core_request(monkeypatch, 200, {"issues": []})
    assert c.get("/api/issues?open=true&q=КС_Гамма").json() == {"issues": []}
    assert calls[-1]["method"] == "GET" and calls[-1]["url"].endswith("/issues")
    assert calls[-1]["params"] == {"open": "true", "q": "КС_Гамма"}

    c.post("/api/issues", json={"title": "Ошибка", "actor": "Иванов И."})
    assert calls[-1]["method"] == "POST" and calls[-1]["json"] == {"title": "Ошибка", "actor": "Иванов И."}
    c.patch("/api/issues/7", json={"version": 2, "changes": {"status": "in_progress"}})
    assert calls[-1]["method"] == "PATCH" and calls[-1]["url"].endswith("/issues/7")
    c.post("/api/issues/7/comments", json={"text": "ок"})
    assert calls[-1]["url"].endswith("/issues/7/comments")
    c.get("/api/issues/meta")
    assert calls[-1]["url"].endswith("/issues/meta")
    c.get("/api/contacts?q=смирн")
    assert calls[-1]["url"].endswith("/contacts") and calls[-1]["params"] == {"q": "смирн", "limit": 50}

    c.post("/api/issues/7/attachments", files=[("files", ("скрин.png", b"png", "image/png"))], data={"actor": "Иванов И."})
    sent = calls[-1]
    assert sent["url"].endswith("/issues/7/attachments") and sent["data"] == {"actor": "Иванов И."}
    assert [(n, f[0], f[1]) for n, f in sent["files"]] == [("files", "скрин.png", b"png")]


def test_issue_conflict_passes_current_card(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    detail = {"message": "Обращение уже изменено другим аналитиком", "current": {"id": 7, "version": 3}}
    _core_request(monkeypatch, 409, {"detail": detail})
    r = c.patch("/api/issues/7", json={"version": 2, "changes": {"priority": "low"}})
    assert r.status_code == 409 and r.json()["detail"] == detail  # браузер получает свежую карточку
    _core_request(monkeypatch, 422, {"detail": "Неизвестное значение status: 'забыто'"})
    assert c.post("/api/issues", json={"title": "x", "status": "забыто"}).json()["detail"].startswith("Неизвестное")


def test_issue_attachment_download(monkeypatch, tmp_path):
    import httpx

    c = _client(monkeypatch, tmp_path)
    cd = "attachment; filename*=utf-8''%D0%BB%D0%BE%D0%B3.txt"
    monkeypatch.setattr(httpx, "get", lambda url, **kw: httpx.Response(
        200, content=b"line1", headers={"content-type": "text/plain; charset=utf-8", "content-disposition": cd}))
    r = c.get("/api/issues/7/attachments/3")
    assert r.status_code == 200 and r.content == b"line1" and r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["content-disposition"] == cd.replace("attachment", "inline")  # текст открывается во вкладке
    for media, mode in (("image/png", "inline"), ("application/pdf", "inline"), ("image/svg+xml", "attachment"),
                        ("text/html", "attachment"), ("application/octet-stream", "attachment")):
        monkeypatch.setattr(httpx, "get", lambda url, m=media, **kw: httpx.Response(
            200, content=b"x", headers={"content-type": m, "content-disposition": cd}))
        assert c.get("/api/issues/7/attachments/3").headers["content-disposition"].startswith(mode), media
    monkeypatch.setattr(httpx, "get", lambda url, **kw: httpx.Response(404, json={"detail": "Вложение не найдено"}))
    r = c.get("/api/issues/7/attachments/99")
    assert r.status_code == 404 and r.json()["detail"] == "Вложение не найдено"


def test_issue_from_email_and_expand_forwarded(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    calls = _core_request(monkeypatch, 200, {"draft": {"title": "Ошибка"}, "chain": []})
    r = c.post("/api/issues/from-email", files={"file": ("fw.msg", b"ole", "application/vnd.ms-outlook")})
    assert r.status_code == 200 and r.json()["draft"]["title"] == "Ошибка"
    assert calls[-1]["url"].endswith("/issues/from-email") and calls[-1]["files"][0][1][:2] == ("fw.msg", b"ole")
    c.post("/api/issues/7/attachments", files=[("files", ("fw.msg", b"ole", "x"))], data={"expand": "true"})
    assert calls[-1]["data"] == {"expand": "true"}
    c.post("/api/issues/7/attachments", files=[("files", ("a.txt", b"x", "x"))])
    assert calls[-1]["data"] is None
    page = c.get("/issues").text
    assert 'id="new-from-email"' in page and 'id="ip-from-email"' in page and 'accept=".msg,.eml"' in page


def test_intent_feedback_logged_and_chat_has_issue_card(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    body = {"question": "Не проводится реализация", "verdict": "not_issue", "intent": {"primary": "issue"}}
    assert c.post("/api/intent-feedback", json=body).json() == {"ok": True}
    assert c.post("/api/intent-feedback", json={**body, "verdict": "maybe"}).status_code == 422
    rec = json.loads((tmp_path / "web" / "intents.jsonl").read_text(encoding="utf-8"))
    assert rec["verdict"] == "not_issue" and rec["intent"] == {"primary": "issue"}
    js = c.get("/static/app.js").text
    assert "issueCard" in js and "/api/intent-feedback" in js and "copilot.issueDraft" in js
    assert "openDraftFromChat" in c.get("/static/issues.js").text


def test_related_forwarded(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    calls = _core_request(monkeypatch, 200, {"issues": [], "test_cases": [], "requirements": []})
    assert c.get("/api/issues/5/related").json()["issues"] == []
    assert calls[-1]["method"] == "GET" and calls[-1]["url"].endswith("/issues/5/related")
    c.post("/api/issues/related", json={"title": "Не проводится реализация"})
    assert calls[-1]["url"].endswith("/issues/related") and calls[-1]["json"] == {"title": "Не проводится реализация"}
    assert 'id="ip-related"' in c.get("/issues").text and "renderRelated" in c.get("/static/issues.js").text
