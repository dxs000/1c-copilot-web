# Развёртывание на локальном Linux-хосте

Цель: веб-интерфейс на `http://magic.lcl` (порт 80), PostgreSQL на том же хосте, сервис
поднимается сам после перезагрузки. Команды — для Ubuntu 22.04/24.04 или Debian 12; выполнять
от пользователя с `sudo`.

Ставится один проект — этот (`1c-copilot-web`). Ядро `1c-copilot` (разбор материалов, индекс,
агент, команды `copilot1c …`) приезжает зависимостью в то же окружение, его коммит зафиксирован
в `uv.lock`.

## 1. Пользователь и код

```bash
sudo useradd --system --no-create-home --home-dir /opt/1c-copilot-web --shell /usr/sbin/nologin copilot
sudo git clone https://github.com/dxs000/1c-copilot-web /opt/1c-copilot-web
sudo mkdir -p /opt/1c-copilot-web/.cache /opt/1c-copilot-web/data
sudo chown -R copilot:copilot /opt/1c-copilot-web
cd /opt/1c-copilot-web
curl -LsSf https://astral.sh/uv/install.sh | sudo -u copilot env HOME=/opt/1c-copilot-web UV_INSTALL_DIR=/opt/1c-copilot-web/.local/bin sh
sudo -u copilot env HOME=/opt/1c-copilot-web .local/bin/uv sync --frozen --no-dev
```

`uv` сам скачает Python 3.12, если его нет. После установки в `.venv/bin` две команды:
`copilot1c-web` (веб-сервер) и `copilot1c` (ядро: `init-db`, `index-docs`, `ask`, `eval`).

Если репозитории станут приватными: этот — клонировать по SSH-ключу развёртывания; для ядра
поменять адрес зависимости в `pyproject.toml` на `git+ssh://git@github.com/dxs000/1c-copilot@main`
и выполнить `uv lock`.

## 2. PostgreSQL

```bash
sudo apt install -y postgresql
sudo apt install -y postgresql-16-pgvector   # необязательно; без него схема тоже создаётся
sudo -u postgres psql -c "CREATE USER copilot WITH PASSWORD '<пароль>';"
sudo -u postgres psql -c "CREATE DATABASE copilot OWNER copilot;"
```

Номер версии в имени пакета pgvector — по установленному PostgreSQL (`psql --version`).
База слушает только `localhost` — так и оставьте: приложение на том же хосте.

## 3. Настройки

Скопируйте `.env` с рабочей машины (там уже ключи Yandex и `COPILOT_VECTOR_STORE_ID`) в
`/opt/1c-copilot-web/.env` и поправьте строку базы:

```bash
sudo -u copilot nano /opt/1c-copilot-web/.env
#   COPILOT_PG_DSN=postgresql://copilot:<пароль>@localhost:5432/copilot
sudo chmod 600 /opt/1c-copilot-web/.env
sudo -u copilot .venv/bin/copilot1c init-db
```

## 4. Сервис на порту 80

```bash
sudo cp deploy/copilot1c-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now copilot1c-web
systemctl status copilot1c-web       # active (running)
curl -s http://localhost/api/health
```

Сервис работает от пользователя `copilot`, порт 80 ему разрешён правом `CAP_NET_BIND_SERVICE`
в unit-файле — root не нужен. Если на хосте порт 80 уже занят (nginx, apache):
`sudo ss -ltnp 'sport = :80'`. Логи: `journalctl -u copilot1c-web -f`.

## 5. Имя magic.lcl и файрвол

- **DNS.** Запись `magic.lcl → <IP хоста>` во внутреннем DNS. Без него — строка в `hosts` на
  каждом рабочем месте (Windows: `C:\Windows\System32\drivers\etc\hosts`, Linux: `/etc/hosts`):
  `192.168.x.y  magic.lcl`.
- **Файрвол:** `sudo ufw allow from 192.168.0.0/16 to any port 80 proto tcp` — только локальная
  сеть, подставьте свою подсеть.

Проверка с рабочего места: `http://magic.lcl` — в шапке три зелёных метки: Yandex AI Studio,
индекс, PostgreSQL. Вкладка «Материалы» показывает, что уже в индексе и в базе.

## 6. Данные

- **Манифест индекса.** Материалы уже проиндексированы с Windows; манифест лежит там в
  `.cache\vector_store\<id>.json`. Скопируйте его в `/opt/1c-copilot-web/.cache/vector_store/` —
  иначе счётчик индекса покажет 0 (сам индекс в облаке цел).
- **PostgreSQL.** Положите материалы в `/opt/1c-copilot-web/data/<папка>` и выполните
  `sudo -u copilot .venv/bin/copilot1c index-docs data/<папка>`: уже загруженные в Vector Store
  фрагменты повторно не загружаются, база заполнится реестрами.

## 7. Обновление

```bash
cd /opt/1c-copilot-web
sudo -u copilot git pull
sudo -u copilot env HOME=/opt/1c-copilot-web .local/bin/uv sync --frozen --no-dev
sudo systemctl restart copilot1c-web
```

Свежее ядро подтягивается в этом репозитории командой `uv lock --upgrade-package 1c-copilot`
(коммит в `uv.lock`), затем — те же шаги обновления на хосте.

## Ограничения

- **Входа нет.** Интерфейс открыт всем, кто достаёт до порта 80, поэтому порт закрыт файрволом
  для всех, кроме локальной сети. Вход по паролю — на одном из следующих шагов.
- **Только HTTP.** Для локальной сети на пилоте достаточно.
- **Загрузка через веб — заглушка** до шага 3; пока материалы добавляются командой
  `copilot1c index-docs`.
- **Ответ идёт 10–40 с**: поиск плюс несколько обращений агента к модели. Каждый вопрос тратит
  токены Yandex AI Studio.
