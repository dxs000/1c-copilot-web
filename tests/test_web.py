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
    for path, marker in (("/", "Спросите о проекте"), ("/materials", "Материалы проекта"),
                         ("/static/app.js", "loadHealth"), ("/static/style.css", "--accent")):
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


def test_ask_and_upload_are_stubs(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    r = c.post("/api/ask", json={"question": "Почему не 11.6?"}).json()
    assert r["stub"] is True and "Почему не 11.6?" in r["answer"]
    assert c.post("/api/upload").status_code == 501


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
