"""Запуск веб-сервера: copilot1c-web [--host 0.0.0.0] [--port 80] [--reload]."""

from __future__ import annotations

import argparse


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="copilot1c-web", description="Веб-интерфейс 1С Project Copilot")
    parser.add_argument("--host", default="0.0.0.0", help="адрес; 0.0.0.0 — доступно из локальной сети")
    parser.add_argument("--port", type=int, default=80, help="порт (по умолчанию 80)")
    parser.add_argument("--reload", action="store_true", help="перезапуск при изменении кода (разработка)")
    args = parser.parse_args(argv)

    import uvicorn

    uvicorn.run("copilot1c_web.app:app", host=args.host, port=args.port, reload=args.reload, proxy_headers=True)


if __name__ == "__main__":
    main()
