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


def test_health_without_keys_and_postgres(monkeypatch, tmp_path):
    h = _client(monkeypatch, tmp_path, yc_api_key="", yc_folder_id="").get("/api/health").json()
    assert h["yandex"]["configured"] is False
    assert h["index"] == {"configured": False, "chunks": 0}
    assert h["postgres"]["ok"] is False and h["postgres"]["detail"] == "нет подключения"
    assert h["project"] == "ut11-update"


def test_health_counts_manifest(monkeypatch, tmp_path):
    (tmp_path / "vector_store").mkdir()
    (tmp_path / "vector_store" / "vs1.json").write_text('{"a": "f1", "b": "f2"}', encoding="utf-8")
    h = _client(monkeypatch, tmp_path, yc_api_key="k", yc_folder_id="f", vector_store_id="vs1").get("/api/health").json()
    assert h["yandex"]["configured"] is True and h["index"] == {"configured": True, "chunks": 2}




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
    assert c.post("/api/upload").status_code == 501


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
    h = _client(monkeypatch, tmp_path).get("/api/health").json()
    assert h["version"] == "0.1.0" and h["core_version"] == "0.1.0"


def test_cli_defaults_to_port_80(monkeypatch):
    import uvicorn

    from copilot1c_web import cli

    seen = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(kw, app=app))
    cli.main([])
    assert seen["port"] == 80 and seen["host"] == "0.0.0.0" and seen["app"] == "copilot1c_web.app:app"
