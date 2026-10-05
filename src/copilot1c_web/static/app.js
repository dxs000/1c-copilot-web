// 1С Project Copilot — интерфейс. Без сборки и зависимостей.
"use strict";

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

// ---------- состояние системы (шапка и экран «Материалы») ----------

function pill(text, state) {
  return el("span", { class: "pill" + (state ? " " + state : "") }, text);
}

async function loadHealth() {
  const box = $("status");
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const h = await r.json();
    setText("project", h.project);
    if (h.core && !h.core.ok) {
      // демон ядра не отвечает — одна понятная метка вместо трёх ложных «нет ключей / индекса / базы»
      box.replaceChildren(pill("ядро недоступно", "bad"));
      box.title = `Нет ответа от ${h.core.url}. Проверьте службу: systemctl status copilot1c-core`;
    } else box.replaceChildren(
      pill(h.yandex.configured ? "Yandex AI Studio" : "нет ключей Yandex", h.yandex.configured ? "ok" : "bad"),
      pill(h.index.configured ? `индекс: ${h.index.chunks}` : "индекс не задан", h.index.configured ? "ok" : "bad"),
      pill(h.postgres.ok ? "PostgreSQL" : "PostgreSQL недоступен", h.postgres.ok ? "ok" : "bad"),
    );
    setText("s-chunks", h.index.chunks ?? "—");
    setText("s-pg-chunks", h.postgres.chunks ?? "—");
    setText("s-tc", h.postgres.test_cases ?? "—");
    setText("s-req", h.postgres.requirements ?? "—");
    setText("c-yandex", h.yandex.configured ? `подключено · ${h.yandex.model}` : "нет ключей в .env");
    setText("c-index", h.index.configured ? `${h.index.chunks} фрагментов` : "COPILOT_VECTOR_STORE_ID не задан");
    setText("c-pg", h.postgres.ok ? (h.postgres.detail || `подключено · ${h.postgres.where}`) : `${h.postgres.detail} · ${h.postgres.where}`);
    setText("c-ocr", { yandex: "Yandex Vision OCR", tesseract: "tesseract (локально)", none: "выключено" }[h.ocr] || h.ocr);
    setText("c-version", `${h.version} · ядро ${h.core_version}`);
  } catch (e) {
    box.replaceChildren(pill("сервер не отвечает", "bad"));
  }
}

// ---------- безопасная мини-разметка ответа (markdown → DOM, без innerHTML) ----------

function inline(text) {
  // **жирный** и `код`; всё остальное — обычный текст
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    out.push(t.startsWith("**") ? el("strong", {}, t.slice(2, -2)) : el("code", {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  const cells = (s) => s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      frag.append(el("h3", {}, ...inline(m[1]))); i++; continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const table = el("table");
      const head = el("tr");
      cells(line).forEach((c) => head.append(el("th", {}, ...inline(c))));
      table.append(el("thead", {}, head));
      const body = el("tbody");
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const tr = el("tr");
        cells(lines[i]).forEach((c) => tr.append(el("td", {}, ...inline(c.replace(/<br\s*\/?>/gi, " ")))));
        body.append(tr);
        i++;
      }
      table.append(body);
      frag.append(table);
      continue;
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        list.append(el("li", {}, ...inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ""))));
        i++;
      }
      frag.append(list);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !isTableRow(lines[i])
           && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    frag.append(el("p", {}, ...inline(para.join(" "))));
  }
  return frag;
}

// ---------- панель источника ----------

const KIND = { email: "Письмо", tz: "Техническое задание", ds: "Допсоглашение", pimi: "ПиМИ", doc: "Документ" };

function highlight(text, question) {
  const terms = [...new Set((question.toLowerCase().match(/[\p{L}\d.]{4,}/gu) || []))]
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return [document.createTextNode(text)];
  const re = new RegExp(`(${terms.join("|")})`, "giu");
  return text.split(re).map((part, idx) => (idx % 2 ? el("mark", {}, part) : document.createTextNode(part)));
}

function openSource(src, question, card) {
  document.querySelectorAll(".source-card[aria-pressed='true']").forEach((c) => c.setAttribute("aria-pressed", "false"));
  if (card) card.setAttribute("aria-pressed", "true");
  setText("sp-n", src.n);
  setText("sp-kind", KIND[src.doc_type] || "Источник");
  setText("sp-label", src.label);
  $("sp-text").replaceChildren(...highlight(src.text, question));
  $("source-panel").hidden = false;
  document.querySelector(".chat").classList.add("with-source");
}

function closeSource() {
  $("source-panel").hidden = true;
  document.querySelector(".chat").classList.remove("with-source");
  document.querySelectorAll(".source-card[aria-pressed='true']").forEach((c) => c.setAttribute("aria-pressed", "false"));
}

// ---------- чат ----------

function scrollToEnd(node) {
  node.scrollIntoView({ behavior: "smooth", block: "end" });
}

function addUser(question) {
  const empty = $("empty");
  if (empty) empty.remove();
  const node = el("div", { class: "msg-user" }, question);
  $("messages").append(node);
  scrollToEnd(node);
}

function addThinking() {
  const node = el("div", { class: "msg-bot" }, el("div", { class: "thinking" }, "Ищу в переписке и документах…"));
  $("messages").append(node);
  scrollToEnd(node);
  const later = setTimeout(() => {
    const t = node.querySelector(".thinking");
    if (t) t.textContent = "Агент формулирует ответ по найденным фрагментам…";
  }, 2500);
  return { node, done: () => clearTimeout(later) };
}

function feedbackRow(question, answer) {
  const row = el("div", { class: "actions" });
  const send = async (verdict, btn) => {
    row.querySelectorAll("button[data-v]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    let comment = "";
    if (verdict === "wrong") comment = prompt("Что не так в ответе? (необязательно)") || "";
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer, verdict, comment }),
    });
    note.textContent = "Спасибо, отметка сохранена.";
  };
  const ok = el("button", { type: "button", "data-v": "ok", onclick: (e) => send("ok", e.currentTarget) }, "Ответ верный");
  const bad = el("button", { type: "button", "data-v": "wrong", onclick: (e) => send("wrong", e.currentTarget) }, "Есть ошибка");
  const copy = el("button", { type: "button", onclick: () => navigator.clipboard?.writeText(answer) }, "Скопировать");
  const note = el("span");
  row.append(copy, ok, bad, note);
  return row;
}

function renderAnswer(holder, question, data) {
  holder.replaceChildren();
  const meta = [`ответ за ${data.seconds} с`];
  if (data.sources?.length) meta.push(`фрагментов: ${data.sources.length}`);
  if (data.tools?.length) meta.push(`доп. поиск: ${data.tools.length}`);
  holder.append(el("div", { class: "msg-meta" }, meta.join(" · ")), renderMarkdown(data.answer || "Пустой ответ."));

  const wrap = el("div", { class: "sources" });
  if (data.sources?.length) {
    wrap.append(el("h2", {}, "Найденные фрагменты"));
    data.sources.forEach((src) => {
      const card = el("button", { type: "button", class: "source-card", "aria-pressed": "false" },
        el("span", { class: "badge" }, String(src.n)),
        el("span", {}, el("span", {}, KIND[src.doc_type] || "Источник"), el("small", { title: src.label }, src.label)));
      card.addEventListener("click", () => openSource(src, question, card));
      wrap.append(card);
    });
  }
  holder.after(wrap);
  wrap.after(feedbackRow(question, data.answer || ""));
  scrollToEnd(wrap);
}

function initChat() {
  const form = $("ask");
  if (!form) return;
  const q = $("q");
  const send = $("send");
  $("sp-close").addEventListener("click", closeSource);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("source-panel").hidden) closeSource(); });

  form.querySelectorAll(".chips button").forEach((b) =>
    b.addEventListener("click", () => { q.value = b.textContent; q.focus(); }));

  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  $("new").addEventListener("click", () => {
    $("messages").replaceChildren();
    closeSource();
    q.value = "";
    q.focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = q.value.trim();
    if (question.length < 2) return;
    addUser(question);
    const hb = el("button", { type: "button", onclick: () => { q.value = question; q.focus(); } },
      question.length > 60 ? question.slice(0, 57) + "…" : question);
    $("history").prepend(el("li", {}, hb));
    q.value = "";
    send.disabled = true;
    const thinking = addThinking();
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await r.json();
      thinking.done();
      if (!r.ok) {
        thinking.node.classList.add("error");
        const detail = typeof data.detail === "string" ? data.detail : "Ошибка запроса";
        thinking.node.replaceChildren(el("p", {}, detail));
      } else {
        renderAnswer(thinking.node, question, data);
      }
    } catch (err) {
      thinking.done();
      thinking.node.classList.add("error");
      thinking.node.replaceChildren(el("p", {}, "Сервер не ответил. Проверьте сервис: systemctl status copilot1c-web."));
    } finally {
      send.disabled = false;
      q.focus();
    }
  });
}

loadHealth();
initChat();
