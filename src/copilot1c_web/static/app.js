// 1С Project Copilot — интерфейс (шаг 1). Без сборки и зависимостей.
"use strict";

const $ = (id) => document.getElementById(id);

function pill(text, state) {
  const el = document.createElement("span");
  el.className = "pill" + (state ? " " + state : "");
  el.textContent = text;
  return el;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

async function loadHealth() {
  const box = $("status");
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const h = await r.json();
    setText("project", h.project);
    box.replaceChildren(
      pill(h.yandex.configured ? "Yandex AI Studio" : "нет ключей Yandex", h.yandex.configured ? "ok" : "bad"),
      pill(h.index.configured ? `индекс: ${h.index.chunks}` : "индекс не задан", h.index.configured ? "ok" : "bad"),
      pill(h.postgres.ok ? "PostgreSQL" : "PostgreSQL недоступен", h.postgres.ok ? "ok" : "bad"),
    );
    // Экран «Материалы»
    setText("s-chunks", h.index.chunks ?? "—");
    setText("s-pg-chunks", h.postgres.chunks ?? "—");
    setText("s-tc", h.postgres.test_cases ?? "—");
    setText("s-req", h.postgres.requirements ?? "—");
    setText("c-yandex", h.yandex.configured ? `подключено · ${h.yandex.model}` : "нет ключей в .env");
    setText("c-index", h.index.configured ? `${h.index.chunks} фрагментов` : "COPILOT_VECTOR_STORE_ID не задан");
    setText("c-pg", h.postgres.ok ? (h.postgres.detail || `подключено · ${h.postgres.where}`) : `${h.postgres.detail} · ${h.postgres.where}`);
    setText("c-ocr", { yandex: "Yandex Vision OCR", tesseract: "tesseract (локально)", none: "выключено" }[h.ocr] || h.ocr);
    setText("c-version", h.version);
  } catch (e) {
    box.replaceChildren(pill("сервер не отвечает", "bad"));
  }
}

function addMessage(kind, text, meta) {
  const empty = $("empty");
  if (empty) empty.remove();
  const el = document.createElement("div");
  el.className = kind;
  if (meta) {
    const m = document.createElement("div");
    m.className = "msg-meta";
    m.textContent = meta;
    el.append(m);
  }
  el.append(document.createTextNode(text));
  $("messages").append(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

function initChat() {
  const form = $("ask");
  if (!form) return;
  const q = $("q");
  const send = $("send");

  form.querySelectorAll(".chips button").forEach((b) =>
    b.addEventListener("click", () => { q.value = b.textContent; q.focus(); }));

  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  $("new").addEventListener("click", () => {
    $("messages").replaceChildren();
    q.value = "";
    q.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = q.value.trim();
    if (!question) return;
    addMessage("msg-user", question);
    const li = document.createElement("li");
    const hb = document.createElement("button");
    hb.type = "button";
    hb.textContent = question.length > 60 ? question.slice(0, 57) + "…" : question;
    hb.addEventListener("click", () => { q.value = question; q.focus(); });
    li.append(hb);
    $("history").prepend(li);
    q.value = "";
    send.disabled = true;
    const t0 = performance.now();
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await r.json();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const el = addMessage("msg-bot", data.answer || data.detail || "Пустой ответ", `ответ за ${secs} с`);
      if (data.stub) el.classList.add("stub");
    } catch (err) {
      addMessage("msg-bot", "Сервер не ответил. Проверьте сервис: systemctl status copilot1c-web.");
    } finally {
      send.disabled = false;
      q.focus();
    }
  });
}

loadHealth();
initChat();
