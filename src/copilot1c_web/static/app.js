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
      pill(h.index.configured ? `в поиске: ${h.index.chunks}` : "база поиска недоступна", h.index.configured ? "ok" : "bad"),
      pill(h.postgres.ok ? "PostgreSQL" : "PostgreSQL недоступен", h.postgres.ok ? "ok" : "bad"),
    );
    setText("s-chunks", h.index.chunks ?? "—");
    setText("s-pg-chunks", h.postgres.chunks ?? "—");
    setText("s-tc", h.postgres.test_cases ?? "—");
    setText("s-req", h.postgres.requirements ?? "—");
    setText("c-yandex", h.yandex.configured ? `подключено · ${h.yandex.model}` : "нет ключей в .env");
    setText("c-index", h.index.configured ? `${h.index.chunks} фрагментов · PostgreSQL` : "недоступна (PostgreSQL, init-db)");
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

function addUser(question, files = []) {
  const empty = $("empty");
  if (empty) empty.remove();
  const node = el("div", { class: "msg-user" }, question,
    files.length ? el("div", { class: "msg-files" }, ...files.map((f) => el("span", { class: "file-chip" }, f.name))) : null);
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

function renderAnswer(holder, question, data, files = []) {
  holder.replaceChildren();
  const meta = [`ответ за ${data.seconds} с`];
  if (data.intent?.primary_label && data.intent.primary !== "question") meta.push(`тип: ${data.intent.primary_label}`);
  if (data.sources?.length) meta.push(`фрагментов: ${data.sources.length}`);
  if (data.tools?.length) meta.push(`доп. поиск: ${data.tools.length}`);
  if (data.attachments?.length) meta.push(`приложено: ${data.attachments.length}`);
  if (data.web_sources?.length) meta.push(`интернет: ${data.web_sources.length}`);
  holder.append(el("div", { class: "msg-meta" }, meta.join(" · ")), renderMarkdown(data.answer || "Пустой ответ."));
  const skipped = (data.attachments || []).filter((a) => a.note);
  if (skipped.length) {
    holder.append(el("details", { class: "issue-why" }, el("summary", {}, "Что из приложенного учтено не полностью"),
      el("ul", {}, ...skipped.map((a) => el("li", {}, `${a.filename}: ${a.note}`)))));
  }

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
  if (data.issues?.length) {  // обращения, которые видел агент: упомянутые в вопросе и возможные дубли
    wrap.append(el("h2", {}, "Обращения"), el("ul", { class: "web-sources issue-refs" }, ...data.issues.map((x) =>
      el("li", {}, el("a", { href: `/issues#${x.id}`, target: "_blank", rel: "noopener" }, `${x.number} · ${x.title}`),
        el("span", { class: "mat-sub" }, ` ${x.status || ""} · ${x.kind === "similar"
          ? `возможный дубль${x.why?.length ? ` (${x.why.join(", ")})` : ""}` : "упомянуто в вопросе"}`)))));
  }
  if (data.web_sources?.length) {  // найденное в интернете — отдельно от материалов проекта, со ссылками
    wrap.append(el("h2", {}, "Из интернета"), el("ul", { class: "web-sources" }, ...data.web_sources.map((w) =>
      el("li", {}, el("a", { href: w.url, target: "_blank", rel: "noopener noreferrer" }, w.title || w.url),
        el("span", { class: "mat-sub" }, ` ${w.domain || ""}${w.read ? " · прочитано агентом" : ""}`)))));
  }
  holder.after(wrap);
  const fb = feedbackRow(question, data.answer || "");
  wrap.after(fb);
  let last = fb;
  // «Передать в Claude…» — у каждого ответа; если агент сам рекомендовал эксперта — панель открыта сразу
  const expert = el("button", { type: "button" }, "Передать в Claude…");
  fb.insertBefore(expert, fb.lastChild);
  const openExpert = () => {
    if (fb.nextElementSibling?.classList.contains("expert-panel")) return;
    const panel = expertPanel(question, data, files);
    fb.after(panel);
    expert.disabled = true;
    scrollToEnd(panel);
  };
  expert.addEventListener("click", openExpert);
  if (data.escalation) openExpert();
  const triaged = (data.triage?.emails || []).filter((e) => files.some((f) => f.name === e.filename));
  if (data.issue_draft && !(triaged.length && !data.issue_draft.already_registered)) {
    const card = issueCard(question, data, files);
    (fb.nextElementSibling?.classList.contains("expert-panel") ? fb.nextElementSibling : last).after(card);
    last = card;
    scrollToEnd(card);
  } else if (!data.escalation && !data.intake) {
    scrollToEnd(wrap);
  }
  if (triaged.length) {  // письмо по обращениям: обновить существующее / новое / только в базу
    triaged.forEach((email) => {
      const card = triageCard(email, question, data, files.find((f) => f.name === email.filename), data.triage.statuses);
      last.after(card);
      last = card;
    });
    scrollToEnd(last);
  } else if (data.intake?.items?.length) {  // «просмотри и добавь в базу» — карточка разбора сразу
    const card = intakeCard(data.intake, files);
    last.after(card);
    last = card;
  } else if (files.length) {  // файлы к вопросу — по кнопке их можно разобрать и добавить в базу
    const offer = el("button", { type: "button" }, "Разобрать для базы…");
    offer.addEventListener("click", async () => {
      offer.disabled = true;
      offer.textContent = "разбираю…";
      try {
        const card = intakeCard(await analyzeFiles(files), files);
        last.after(card);
        scrollToEnd(card);
        offer.remove();
      } catch (e) {
        offer.textContent = `Не разобрано: ${e.message}`;
      }
    });
    fb.insertBefore(offer, fb.lastChild);
  }
}

// ---------- эксперт через оператора: пакет для Claude ----------

function expertPanel(question, data, files = []) {
  const rec = data.escalation;
  const panel = el("section", { class: "expert-panel" + (rec ? " recommended" : ""), "aria-label": "Пакет для эксперта" });
  panel.append(el("div", { class: "issue-card-head" },
    el("strong", {}, rec ? "Агент рекомендует передать вопрос эксперту (Claude)" : "Передать вопрос эксперту (Claude)"),
    el("span", { class: "mat-sub" }, "архив с промтом и материалами — передаёт оператор")));
  const reason = el("textarea", { rows: "2", placeholder: "Почему нужен эксперт (необязательно)" });
  reason.value = rec?.reason || "";
  const ask = el("textarea", { rows: "3" });
  ask.value = rec?.expert_question || question;
  const raw = el("input", { type: "checkbox" });
  const fields = el("div", { class: "issue-card-fields" },
    el("label", { class: "fld wide" }, el("span", {}, "Вопрос эксперту"), ask),
    el("label", { class: "fld wide" }, el("span", {}, "Почему не справились сами"), reason),
    files.length ? el("label", { class: "fld wide check" }, raw,
      el("span", {}, `Приложить исходные файлы (${files.map((f) => f.name).join(", ")}) — в письмах есть имена и адреса; `
        + "без отметки в пакет идёт только их очищенный текст")) : null);
  const note = el("span", { class: "issue-card-note", "aria-live": "polite" });
  const result = el("div", { class: "expert-result", hidden: "" });
  const build = el("button", { type: "button", class: "btn small primary", onclick: async () => {
    build.disabled = true;
    note.textContent = "собираю пакет…";
    const payload = {
      question, expert_question: ask.value.trim(), reason: reason.value.trim(), answer: data.answer || "",
      sources: (data.sources || []).map((x) => ({ n: x.n, label: x.label, text: x.text })),
      web_sources: data.web_sources || [], tools: data.tools || [], include_raw: raw.checked,
    };
    const body = new FormData();
    body.append("payload", JSON.stringify(payload));
    files.forEach((f) => body.append("files", f, f.name));
    try {
      const r = await fetch("/api/escalations", { method: "POST", body });
      const pkg = await r.json();
      if (!r.ok) throw new Error(typeof pkg.detail === "string" ? pkg.detail : `HTTP ${r.status}`);
      note.textContent = "";
      result.replaceChildren(
        el("a", { class: "btn small primary", href: `/api/escalations/${pkg.id}`, download: pkg.filename },
          `Скачать «${pkg.filename}» (${fmtSize(pkg.size)})`),
        el("ul", { class: "expert-files" }, ...pkg.files.map((f) => el("li", {}, el("code", {}, f.path), ` — ${f.what}`))),
        el("p", { class: "mat-sub" }, "Передайте архив в Claude целиком: PROMPT.md — задача, остальное — материалы. "
          + "Имена, e-mail и телефоны в текстах пакета заменены."));
      result.hidden = false;
      build.textContent = "Собрать заново";
    } catch (e) {
      note.textContent = `Пакет не собран: ${e.message}`;
    } finally {
      build.disabled = false;
    }
  } }, "Собрать пакет");
  panel.append(fields, el("div", { class: "issue-card-actions" }, build, note), result);
  return panel;
}

// ---------- сообщение о проблеме: карточка обращения прямо в чате ----------

let issueMeta = null;
async function loadIssueMeta() {
  if (!issueMeta) {
    const r = await fetch("/api/issues/meta", { cache: "no-store" });
    if (!r.ok) throw new Error(`справочники обращений недоступны (HTTP ${r.status})`);
    issueMeta = await r.json();
  }
  return issueMeta;
}

function analyst() {
  try { return localStorage.getItem("copilot.analyst") || null; } catch (e) { return null; }
}

function intentFeedback(question, data, verdict, extra = {}) {
  // журнал решений по типу сообщения — материал для настройки эвристик и эталонного набора
  fetch("/api/intent-feedback", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, verdict, intent: data.intent || {}, ...extra }),
  }).catch(() => {});
}

function issueCard(question, data, files = []) {
  const { initiator, contact, already_registered: registered, ...d } = data.issue_draft;
  const card = el("section", { class: "issue-card", "aria-label": "Черновик обращения" });
  const signals = data.intent?.signals || [];
  const head = el("div", { class: "issue-card-head" },
    el("strong", {}, "Похоже на сообщение о проблеме"),
    el("span", { class: "mat-sub" }, "зарегистрировать как обращение?"));
  const why = signals.length ? el("details", { class: "issue-why" }, el("summary", {}, "Почему так решено"),
    el("ul", {}, ...signals.map((x) => el("li", {}, x)))) : null;

  const title = el("input", { type: "text", value: d.title || "", maxlength: "500", "aria-label": "Тема обращения" });
  const category = el("select", { "aria-label": "Категория" });
  const priority = el("select", { "aria-label": "Приоритет" });
  const objects = el("input", { type: "text", value: (d.objects || []).join(", "), "aria-label": "Объекты метаданных",
    placeholder: "объекты через запятую" });
  loadIssueMeta().then((m) => {
    category.replaceChildren(...m.categories.map((x) => el("option", { value: x.value }, x.label)));
    priority.replaceChildren(...m.priorities.map((x) => el("option", { value: x.value }, x.label)));
    category.value = d.category || "bug";
    priority.value = d.priority || "medium";
  }).catch((e) => { note.textContent = e.message; });

  const who = initiator ? el("div", { class: "fld wide" }, el("span", {}, "Инициатор — из письма"),
    el("div", {}, [initiator.name, initiator.email, initiator.position].filter(Boolean).join(" · "),
      el("span", { class: "mat-sub" }, contact ? " — уже есть в контактах" : " — будет добавлен в контакты"))) : null;
  const fields = el("div", { class: "issue-card-fields" }, who,
    el("label", { class: "fld wide" }, el("span", {}, "Тема"), title),
    el("label", { class: "fld" }, el("span", {}, "Категория"), category),
    el("label", { class: "fld" }, el("span", {}, "Приоритет"), priority),
    el("label", { class: "fld wide" }, el("span", {}, "Объекты"), objects),
    d.error_text ? el("div", { class: "fld wide" }, el("span", {}, "Текст ошибки 1С"),
      el("pre", { class: "issue-error mono" }, d.error_text)) : null);

  const draft = () => ({
    ...d, title: title.value.trim(), category: category.value || d.category, priority: priority.value || d.priority,
    objects: objects.value.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean),
    source_ref: d.source_ref || `чат, ${new Date().toLocaleString("ru-RU")}`,
  });
  // контакт инициатора: найденный по e-mail или новый (с должностью и телефоном из подписи)
  const initiatorId = async () => {
    if (!initiator) return null;
    if (contact) return contact.id;
    const r = await fetch("/api/contacts", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: initiator.name, email: initiator.email, position: initiator.position || null,
        phone: initiator.phone || null, organization: initiator.organization || null }) });
    const c = await r.json();
    if (!r.ok) throw new Error(typeof c.detail === "string" ? c.detail : `контакт: HTTP ${r.status}`);
    return c.id;
  };
  const note = el("span", { class: "issue-card-note", "aria-live": "polite" });
  const me = analyst();
  if (!me) note.textContent = "Аналитик не выбран — укажите себя в поле «Я» на вкладке «Обращения».";

  const done = (content) => { actions.replaceChildren(content); fields.remove(); if (why) why.remove(); };
  const register = el("button", { type: "button", class: "btn small primary", onclick: async () => {
    if (!title.value.trim()) { note.textContent = "Укажите тему обращения."; title.focus(); return; }
    register.disabled = true;
    note.textContent = "регистрирую…";
    try {
      const cid = await initiatorId();
      const r = await fetch("/api/issues", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft(), ...(cid ? { initiator_contact_id: cid } : {}), actor: me }) });
      const issue = await r.json();
      if (!r.ok) throw new Error(typeof issue.detail === "string" ? issue.detail : `HTTP ${r.status}`);
      intentFeedback(question, data, "registered", { issue_id: issue.id });
      let filesNote = "";
      if (files.length) {  // приложенное к вопросу — во вложения обращения (письма вместе с файлами из них)
        note.textContent = "прикрепляю файлы…";
        const body = new FormData();
        files.forEach((f) => body.append("files", f, f.name));
        body.append("expand", "true");
        if (me) body.append("actor", me);
        try {
          const ar = await fetch(`/api/issues/${issue.id}/attachments`, { method: "POST", body });
          const res = await ar.json();
          if (!ar.ok) throw new Error(typeof res.detail === "string" ? res.detail : `HTTP ${ar.status}`);
          const ok = (res.attachments || []).filter((a) => !a.error).length;
          filesNote = ` · вложений: ${ok}`;
        } catch (e) {
          filesNote = ` · файлы не прикреплены: ${e.message}`;
        }
      }
      head.replaceChildren(el("strong", {}, `Зарегистрировано обращение ${issue.number}`),
        filesNote ? el("span", { class: "mat-sub" }, filesNote) : null);
      done(el("a", { class: "btn small", href: `/issues#${issue.id}`, target: "_blank", rel: "noopener" },
        `Открыть ${issue.number}`));
    } catch (e) {
      note.textContent = `Не зарегистрировано: ${e.message}`;
      register.disabled = false;
    }
  } }, "Зарегистрировать");
  const edit = el("button", { type: "button", class: "btn small", onclick: async () => {
    // полная карточка в новой вкладке — чат остаётся на месте; черновик передаётся через localStorage
    let who = null;
    try { who = initiator ? { id: await initiatorId(), name: initiator.name, email: initiator.email } : null; } catch (e) { /* без контакта */ }
    const payload = { ...draft(), contact: who, files: files.map((f) => f.name) };
    try { localStorage.setItem("copilot.issueDraft", JSON.stringify(payload)); } catch (e) { /* нет хранилища */ }
    intentFeedback(question, data, "edit");
    window.open("/issues#draft", "_blank", "noopener");
    note.textContent = "Черновик открыт в новой вкладке «Обращения» — сохраните его там.";
  } }, "Поправить и зарегистрировать");
  const notIssue = el("button", { type: "button", class: "btn small", onclick: () => {
    intentFeedback(question, data, "not_issue");
    head.replaceChildren(el("span", { class: "mat-sub" }, "Отмечено: это не обращение."));
    done(el("span"));
  } }, "Это не обращение");
  const actions = el("div", { class: "issue-card-actions" }, register, edit, notIssue, note);
  if (registered) {  // письмо уже заведено — вместо регистрации ссылка на обращение
    head.replaceChildren(el("strong", {}, `Это письмо уже зарегистрировано: ${registered.number}`),
      el("span", { class: "mat-sub" }, `«${registered.title}»`));
    actions.replaceChildren(el("a", { class: "btn small", href: `/issues#${registered.id}`, target: "_blank",
      rel: "noopener" }, `Открыть ${registered.number}`));
    fields.remove();
    card.append(head, actions);
    return card;
  }
  const similar = el("div", { class: "issue-similar", hidden: "" });
  card.append(head, fields, similar, actions);
  if (why) card.append(why);
  // уже зарегистрировано? — похожие обращения по черновику (дубль лучше увидеть до «Зарегистрировать»)
  fetch("/api/issues/related", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: d.title, description: d.description, error_text: d.error_text, objects: d.objects || [] }) })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      const items = (rel?.issues || []).slice(0, 3);
      if (!items.length) return;
      similar.replaceChildren(el("strong", {}, "Возможно, уже зарегистрировано:"), el("ul", {}, ...items.map((x) =>
        el("li", {}, el("a", { href: `/issues#${x.id}`, target: "_blank", rel: "noopener" }, `${x.number} · ${x.title}`),
          ` — ${x.status_label}; ${x.why.join(", ")}`))));
      similar.hidden = false;
    })
    .catch(() => {});
  return card;
}

// ---------- «Входящие»: карточка разбора и приёма материалов (чат и экран «Входящие») ----------

const RELATION = {
  new: () => "в базе нет",
  already_uploaded: (r) => `этот файл уже загружали («${r.filename}», ${r.status})`,
  same_content: (r) => `то же содержание уже в базе: «${r.document_title}»`,
  new_version: (r) => `похоже на новую редакцию «${r.document_title}»` + (r.version_label ? ` (сейчас ред. ${r.version_label})` : ""),
  known_letters: () => "все письма уже в базе",
};

function relationText(rel) {
  return (RELATION[rel?.type] || RELATION.new)(rel || {});
}

function emailText(email) {
  if (!email) return "";
  const parts = [`писем новых: ${email.letters_new}, уже известных: ${email.letters_known}`];
  for (const t of email.threads || []) {
    parts.push(`ветка «${t.title}»${t.id ? "" : " (новая)"}` + (t.issue_id ? ` · обращение ОБР-${String(t.issue_id).padStart(4, "0")}` : ""));
  }
  return parts.join(" · ");
}

// analysis — ответ /api/intake/analyze (или data.intake из чата), files — те же File из браузера;
// onDone(result) — после приёма (обновить список на экране «Входящие»)
function intakeCard(analysis, files, onDone) {
  const contours = analysis.contours || [];
  const kinds = analysis.kinds || {};
  const actions = analysis.actions || {};
  const card = el("section", { class: "intake-card", "aria-label": "Разбор приложенного для базы" });
  card.append(el("div", { class: "issue-card-head" },
    el("strong", {}, `Разбор для базы: ${plural(analysis.items.length, "файл", "файла", "файлов")}`),
    el("span", { class: "mat-sub" }, analysis.method === "llm" ? "вид и контуры уточнила модель" : "по названиям и справочнику контуров")));

  // контуры «для всех»: отметка ставит или снимает контур во всех строках
  const rows = [];
  if (contours.length) {
    const all = el("div", { class: "intake-all" }, el("span", { class: "mat-sub" }, "Контур для всех:"));
    contours.forEach((c) => all.append(el("button", { type: "button", class: "chip-toggle", onclick: () => {
      const on = !rows.every((r) => r.contourBoxes.get(c.id)?.checked);
      rows.forEach((r) => { const b = r.contourBoxes.get(c.id); if (b && !b.disabled) b.checked = on; });
    } }, c.name)));
    card.append(all);
  }

  analysis.items.forEach((it) => {
    const row = { it, contourBoxes: new Map(), newContour: null };
    const kind = el("select", { "aria-label": `Вид: ${it.filename}` },
      ...Object.entries(kinds).map(([k, label]) => el("option", { value: k }, label)));
    kind.value = it.doc_kind;
    if (it.kind === "email") kind.disabled = true;
    const action = el("select", { "aria-label": `Что сделать: ${it.filename}` });
    for (const [k, label] of Object.entries(actions)) {
      if (k === "new_version" && !(it.relation?.candidates?.length)) continue;
      action.append(el("option", { value: k }, label));
    }
    action.value = it.action;
    const target = el("select", { "aria-label": "Какого документа редакция", hidden: "" },
      ...(it.relation?.candidates || []).map((d) => el("option", { value: String(d.id) }, d.title)));
    const syncTarget = () => { target.hidden = action.value !== "new_version"; };
    action.addEventListener("change", syncTarget);
    syncTarget();
    row.kind = kind; row.action = action; row.target = target;

    const chips = el("div", { class: "intake-contours" });
    contours.forEach((c) => {
      const box = el("input", { type: "checkbox" });
      box.checked = (it.contours || []).includes(c.id);
      row.contourBoxes.set(c.id, box);
      chips.append(el("label", { class: "chip-check", title: c.kind_label }, box, ` ${c.name}`));
    });
    if (it.new_contour) {  // модель предлагает новый контур — отметкой он добавится в справочник
      const box = el("input", { type: "checkbox" });
      box.checked = true;
      row.newContour = { box, ...it.new_contour };
      chips.append(el("label", { class: "chip-check new" }, box, ` новый: ${it.new_contour.name}`));
    }
    const addKind = el("select", { "aria-label": "Вид нового контура" },
      el("option", { value: "process" }, "процесс"), el("option", { value: "system" }, "система"),
      el("option", { value: "project" }, "проект"));
    const addName = el("input", { type: "text", placeholder: "новый контур", "aria-label": "Название нового контура",
      maxlength: "200" });
    row.addKind = addKind; row.addName = addName;
    chips.append(el("span", { class: "intake-add" }, addKind, addName));

    const inner = (it.inner || []).map((x) => el("li", {}, x.same_as ? `${x.filename} — то же, что приложенный «${x.same_as}»`
      : `${x.filename}${x.title ? ` — «${x.title}»` : ""}; ${relationText(x.relation)}`));
    const node = el("div", { class: "intake-row" },
      el("div", { class: "intake-top" }, el("span", { class: "mat-name" }, it.filename),
        it.title && it.title !== it.filename ? el("span", { class: "mat-sub" }, `«${it.title}»${it.version ? `, ред. ${it.version}` : ""}`) : null),
      it.about ? el("p", { class: "intake-about" }, it.about) : null,
      el("p", { class: "intake-rel" }, it.email ? emailText(it.email) : relationText(it.relation)),
      inner.length ? el("details", { class: "issue-why" }, el("summary", {}, `Внутри письма: ${inner.length}`), el("ul", {}, ...inner)) : null,
      it.notes?.length ? el("p", { class: "mat-sub" }, it.notes.join("; ")) : null,
      el("div", { class: "intake-fields" },
        el("label", { class: "fld" }, el("span", {}, "Вид"), kind),
        el("label", { class: "fld" }, el("span", {}, "Что сделать"), action, target),
        el("div", { class: "fld wide" }, el("span", {}, "Контуры"), chips)),
      it.reason ? el("p", { class: "mat-sub" }, `Почему так предложено: ${it.reason}`) : null);
    row.node = node;
    rows.push(row);
    card.append(node);
  });

  const note = el("span", { class: "issue-card-note", "aria-live": "polite" });
  const accept = el("button", { type: "button", class: "btn small primary", onclick: async () => {
    const decisions = rows.map((r) => {
      const fresh = [];
      if (r.newContour?.box.checked) fresh.push({ kind: r.newContour.kind, name: r.newContour.name });
      if (r.addName.value.trim()) fresh.push({ kind: r.addKind.value, name: r.addName.value.trim() });
      return {
        filename: r.it.filename, action: r.action.value, kind: r.kind.disabled ? null : r.kind.value,
        contours: [...r.contourBoxes].filter(([, b]) => b.checked).map(([id]) => id),
        document_id: r.action.value === "new_version" ? Number(r.target.value) || null : null,
        new_contours: fresh,
      };
    });
    const send = files.filter((f) => decisions.some((d) => d.filename === f.name && d.action !== "skip"));
    if (!send.length) { note.textContent = "Ничего не выбрано для добавления."; return; }
    accept.disabled = true;
    note.textContent = "передаю в обработку…";
    const body = new FormData();
    send.forEach((f) => body.append("files", f, f.name));
    body.append("decisions", JSON.stringify(decisions));
    try {
      const r = await fetch("/api/intake/accept", { method: "POST", body });
      const res = await r.json();
      if (!r.ok) throw new Error(typeof res.detail === "string" ? res.detail : `HTTP ${r.status}`);
      const mats = res.materials || [];
      const queued = mats.filter((m) => m.status === "queued").length;
      const archived = mats.filter((m) => m.status === "archived").length;
      const before = mats.filter((m) => m.already_uploaded).length;
      const errors = mats.filter((m) => m.error);
      const parts = [`в обработку: ${queued}`];
      if (archived) parts.push(`без индексации: ${archived}`);
      if (before) parts.push(`уже были в базе (контуры обновлены): ${before}`);
      if (res.contours_created?.length) parts.push(`новые контуры: ${res.contours_created.map((c) => c.name).join(", ")}`);
      if (errors.length) parts.push(`ошибки: ${errors.map((m) => `${m.filename} — ${m.error}`).join("; ")}`);
      rows.forEach((r) => r.node.querySelectorAll("select, input, button").forEach((x) => { x.disabled = true; }));
      card.querySelectorAll(".intake-all button").forEach((x) => { x.disabled = true; });
      actionsBox.replaceChildren(el("strong", {}, "Принято. "), el("span", {}, parts.join(" · ")),
        location.pathname === "/materials" ? null : el("a", { class: "btn small", href: "/materials", target: "_blank", rel: "noopener" }, "Открыть «Входящие»"));
      if (onDone) onDone(res);
    } catch (e) {
      note.textContent = `Не принято: ${e.message}`;
      accept.disabled = false;
    }
  } }, "Принять");
  const actionsBox = el("div", { class: "issue-card-actions" }, accept, note);
  card.append(actionsBox);
  return card;
}

// ---------- письмо по обращениям: обновить существующее, зарегистрировать новое или только в базу ----------

function triageCard(email, question, data, file, statuses) {
  const card = el("section", { class: "intake-card triage-card", "aria-label": "Письмо и обращения" });
  const rep = email.letters || {};
  const threads = (rep.threads || []).map((t) => `ветка «${t.title}»${t.id ? "" : " (новая)"}`).join(", ");
  card.append(el("div", { class: "issue-card-head" },
    el("strong", {}, `Письмо «${email.filename}»`),
    el("span", { class: "mat-sub" }, `новых писем: ${rep.letters_new ?? 0}, уже известных: ${rep.letters_known ?? 0}`
      + (threads ? ` · ${threads}` : ""))));
  if (email.error) { card.append(el("p", { class: "mat-sub" }, email.error)); return card; }

  const cands = email.candidates || [];
  const choice = el("div", { class: "triage-choice", role: "radiogroup", "aria-label": "Что сделать с письмом" });
  const panel = el("div", { class: "triage-panel" });
  const radios = {};
  const option = (value, label, sub) => {
    const r = el("input", { type: "radio", name: `triage-${Math.random().toString(36).slice(2)}`, value });
    radios[value] = r;
    r.addEventListener("change", () => show(value));
    choice.append(el("label", { class: "triage-opt" }, r, el("span", {}, el("strong", {}, label), sub ? el("small", {}, sub) : null)));
  };
  if (cands.length) option("update", `Обновить ${cands[0].number}`, `«${cands[0].title}» · ${cands[0].status_label}`);
  option("new", "Зарегистрировать новое обращение", cands.length && email.decision !== "update" ? `возможно, это ${cands[0].number}` : "");
  option("knowledge", "Не обращение — только в базу знаний", "");
  card.append(choice, panel);

  // --- обновление существующего ---
  const updatePanel = () => {
    const u = email.update || { what_changed: "", status: cands[0].status, comment: "", resolution: "" };
    const pick = el("select", { "aria-label": "Какое обращение обновить" },
      ...cands.map((c) => el("option", { value: String(c.id) }, `${c.number} · ${c.title} — ${c.status_label}`)));
    const why = el("p", { class: "mat-sub" });
    const syncWhy = () => {
      const c = cands.find((x) => String(x.id) === pick.value);
      why.textContent = c ? `Почему: ${c.why.join("; ")}` : "";
    };
    pick.addEventListener("change", syncWhy);
    syncWhy();
    const status = el("select", { "aria-label": "Статус после обновления" },
      ...(statuses || []).map((x) => el("option", { value: x.value }, x.label)));
    status.value = u.status;
    const comment = el("textarea", { rows: "4", "aria-label": "Комментарий в историю обращения" });
    comment.value = u.comment || "";
    const resolution = el("textarea", { rows: "2", "aria-label": "Решение" });
    resolution.value = u.resolution || "";
    const resWrap = el("label", { class: "fld wide" }, el("span", {}, "Решение"), resolution);
    const syncRes = () => { resWrap.hidden = !["resolved", "closed"].includes(status.value); };
    status.addEventListener("change", syncRes);
    syncRes();
    const fresh = (email.new_letters || []).map((x) => el("li", {},
      el("strong", {}, `${x.sender || "?"}${x.sent_at ? `, ${fmtTime(x.sent_at)}` : ""}: `), x.excerpt));
    const note = el("span", { class: "issue-card-note", "aria-live": "polite" });
    const go = el("button", { type: "button", class: "btn small primary", onclick: async () => {
      const c = cands.find((x) => String(x.id) === pick.value);
      go.disabled = true;
      note.textContent = "прикрепляю письмо…";
      const me = analyst();
      try {
        const body = new FormData();
        body.append("files", file, file.name);
        body.append("expand", "true");
        if (me) body.append("actor", me);
        let r = await fetch(`/api/issues/${c.id}/attachments`, { method: "POST", body });
        let res = await r.json();
        if (!r.ok) throw new Error(typeof res.detail === "string" ? res.detail : `HTTP ${r.status}`);
        note.textContent = "обновляю обращение…";
        const cur = await (await fetch(`/api/issues/${c.id}`, { cache: "no-store" })).json();  // версия — после вложения
        const changes = {};
        if (status.value && status.value !== cur.status) changes.status = status.value;
        if (!resWrap.hidden && resolution.value.trim()) changes.resolution = resolution.value.trim();
        r = await fetch(`/api/issues/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: cur.version, changes, comment: comment.value.trim() || null, actor: me }) });
        res = await r.json();
        if (!r.ok) throw new Error(r.status === 409 ? "обращение изменили — откройте его и повторите"
          : typeof res.detail === "string" ? res.detail : `HTTP ${r.status}`);
        intentFeedback(question, data, "issue_updated", { issue_id: c.id });
        card.querySelectorAll("input, select, textarea, button").forEach((x) => { x.disabled = true; });
        actions.replaceChildren(el("strong", {}, `${c.number} обновлено`),
          el("span", { class: "mat-sub" }, ` · ${res.status_label || ""}`),
          el("a", { class: "btn small", href: `/issues#${c.id}`, target: "_blank", rel: "noopener" }, `Открыть ${c.number}`));
      } catch (e) {
        note.textContent = `Не обновлено: ${e.message}`;
        go.disabled = false;
      }
    } }, `Обновить ${cands[0].number}`);
    pick.addEventListener("change", () => {
      const c = cands.find((x) => String(x.id) === pick.value);
      go.textContent = `Обновить ${c.number}`;
    });
    if (!analyst()) note.textContent = "Аналитик не выбран — укажите себя в поле «Я» на вкладке «Обращения».";
    const actions = el("div", { class: "issue-card-actions" }, go, note);
    panel.replaceChildren(
      el("div", { class: "intake-fields" },
        el("label", { class: "fld wide" }, el("span", {}, "Обращение"), pick), why,
        u.what_changed ? el("div", { class: "fld wide" }, el("span", {}, "Что изменилось"), el("p", { class: "intake-about" }, u.what_changed)) : null,
        fresh.length ? el("details", { class: "issue-why wide", open: "" }, el("summary", {}, `Новые письма: ${fresh.length}`), el("ul", {}, ...fresh))
          : el("p", { class: "mat-sub" }, "Новых писем нет — всё в этом файле уже известно."),
        el("label", { class: "fld" }, el("span", {}, `Статус (сейчас «${cands[0].status_label}»)`), status),
        el("label", { class: "fld wide" }, el("span", {}, "Комментарий в историю"), comment),
        resWrap),
      actions);
  };

  // --- новое обращение: черновик из письма (инициатор, дата, тема) и обычная карточка обращения ---
  const newPanel = async () => {
    if (data.issue_draft) { panel.replaceChildren(issueCard(question, data, [file])); return; }
    panel.replaceChildren(el("p", { class: "mat-sub" }, "готовлю черновик обращения из письма…"));
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const r = await fetch("/api/issues/from-email", { method: "POST", body });
      const p = await r.json();
      if (!r.ok) throw new Error(typeof p.detail === "string" ? p.detail : `HTTP ${r.status}`);
      const draft = { ...Object.fromEntries(Object.entries(p.draft).filter(([, v]) => v)), initiator: p.initiator,
        contact: p.contact, already_registered: p.already_registered };
      panel.replaceChildren(issueCard(question, { ...data, issue_draft: draft }, [file]));
    } catch (e) {
      panel.replaceChildren(el("p", { class: "mat-sub" }, `Черновик не собран: ${e.message}`));
    }
  };

  // --- только в базу знаний: обычная карточка приёма ---
  const knowledgePanel = async () => {
    panel.replaceChildren(el("p", { class: "mat-sub" }, "разбираю для базы…"));
    try {
      panel.replaceChildren(intakeCard(await analyzeFiles([file]), [file]));
    } catch (e) {
      panel.replaceChildren(el("p", { class: "mat-sub" }, `Не разобрано: ${e.message}`));
    }
  };

  const show = (value) => {
    radios[value].checked = true;
    if (value === "update") updatePanel();
    else if (value === "new") newPanel();
    else knowledgePanel();
  };
  show(email.decision === "update" && cands.length ? "update" : email.decision === "new" ? "new" : "knowledge");
  return card;
}

async function analyzeFiles(files) {
  const body = new FormData();
  files.forEach((f) => body.append("files", f, f.name));
  const r = await fetch("/api/intake/analyze", { method: "POST", body });
  const data = await r.json();
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${r.status}`);
  return data;
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

  // ---------- «+»: файлы и письма к вопросу ----------
  let chatFiles = [];
  const MAX_CHAT_FILES = 10;
  const renderChips = () => {
    const box = $("attached");
    box.hidden = !chatFiles.length;
    box.replaceChildren(...chatFiles.map((f, i) => el("span", { class: "file-chip" }, f.name,
      el("button", { type: "button", class: "chip-x", "aria-label": `Убрать ${f.name}`, onclick: () => {
        chatFiles.splice(i, 1);
        renderChips();
      } }, "×"))));
    if (chatFiles.length) box.append(el("span", { class: "mat-sub" }, "файлы учтутся только в этом вопросе"));
  };
  const addFiles = (list) => {
    for (const f of list) {
      if (chatFiles.length >= MAX_CHAT_FILES) break;
      if (!chatFiles.some((x) => x.name === f.name && x.size === f.size)) chatFiles.push(f);
    }
    renderChips();
  };
  $("chat-files").addEventListener("change", () => { addFiles($("chat-files").files); $("chat-files").value = ""; });
  $("attach").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("chat-files").click(); }
  });
  const composer = form.closest(".composer");
  composer.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("over"); });
  composer.addEventListener("dragleave", () => composer.classList.remove("over"));
  composer.addEventListener("drop", (e) => {
    e.preventDefault();
    composer.classList.remove("over");
    addFiles(e.dataTransfer.files);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = q.value.trim();
    if (question.length < 2) return;
    const files = chatFiles;
    chatFiles = [];
    renderChips();
    addUser(question, files);
    const hb = el("button", { type: "button", onclick: () => { q.value = question; q.focus(); } },
      question.length > 60 ? question.slice(0, 57) + "…" : question);
    $("history").prepend(el("li", {}, hb));
    q.value = "";
    send.disabled = true;
    const thinking = addThinking();
    try {
      let r;
      if (files.length) {
        const body = new FormData();
        body.append("question", question);
        files.forEach((f) => body.append("files", f, f.name));
        r = await fetch("/api/ask-files", { method: "POST", body });
      } else {
        r = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question }),
        });
      }
      const data = await r.json();
      thinking.done();
      if (!r.ok) {
        thinking.node.classList.add("error");
        const detail = typeof data.detail === "string" ? data.detail : "Ошибка запроса";
        thinking.node.replaceChildren(el("p", {}, detail));
      } else {
        renderAnswer(thinking.node, question, data, files);
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


// ---------- «Входящие»: материалы, их разбор и судьба ----------

const ACTIVE = new Set(["queued", "parsing", "indexing", "graph"]);
const STATUS_CLASS = { done: "done", error: "error", duplicate: "", deleted: "", archived: "" };
let contourNames = {};

function fmtSize(n) {
  if (n < 1024) return `${n} Б`;
  if (n < 1048576) return `${Math.round(n / 1024)} КБ`;
  return `${(n / 1048576).toFixed(1)} МБ`;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

function reportItems(r) {
  // отчёт обработки по-русски: что было в файле и что из этого попало в базу
  const items = [];
  if (r.emails) items.push(plural(r.emails, "письмо", "письма", "писем"));
  for (const d of r.documents || []) {
    const extra = [];
    if (d.test_cases) extra.push(plural(d.test_cases, "тест-кейс", "тест-кейса", "тест-кейсов"));
    if (d.plan_items) extra.push(plural(d.plan_items, "пункт плана", "пункта плана", "пунктов плана"));
    items.push(`документ «${d.title}»` + (extra.length ? ` — ${extra.join(", ")}` : ""));
  }
  if (r.images) items.push(`распознано картинок: ${r.images}`);
  if (r.chunks !== undefined) items.push(`фрагментов: ${r.chunks}, из них новых: ${r.chunks_new ?? 0}`);
  for (const t of r.threads || []) items.push(`ветка «${t.title}»: новых писем ${t.new}, известных ${t.known}`);
  for (const v of r.versions || []) {
    items.push(v.superseded_versions ? `новая редакция документа «${v.title}» — прежняя выведена из поиска`
      : `документ «${v.title}» — в реестре документов`);
  }
  if (r.contours?.length) items.push(`контуры: ${r.contours.map((id) => contourNames[id] || id).join(", ")}`);
  for (const w of r.already_in_base || []) items.push(`уже в базе: ${w}`);
  for (const s of r.skipped || []) items.push(`пропущено ${s.file}: ${s.reason}`);
  return items;
}

function materialRow(m) {
  const status = el("span", { class: "st " + (ACTIVE.has(m.status) ? "active" : STATUS_CLASS[m.status] ?? "") },
    m.status_label || m.status);
  const result = el("td", {}, el("div", { class: "mat-detail" }, m.detail || (ACTIVE.has(m.status) ? "" : "—")));
  const items = reportItems(m.report || {});
  if (items.length) {
    const list = el("ul");
    items.forEach((x) => list.append(el("li", {}, x)));
    result.append(el("details", {}, el("summary", {}, "Подробнее"), list));
  }
  if (["done", "duplicate", "error", "archived"].includes(m.status)) {  // убрать из базы: фрагменты, редакции, письма
    const del = el("button", { type: "button", class: "link-btn muted", onclick: async () => {
      if (!confirm(`Убрать «${m.filename}» из базы? Фрагменты, редакции документов и письма из этого файла `
        + "перестанут находиться; сам файл останется в реестре.")) return;
      del.disabled = true;
      try {
        const r = await fetch(`/api/materials/${m.id}`, { method: "DELETE" });
        const res = await r.json();
        if (!r.ok) throw new Error(typeof res.detail === "string" ? res.detail : `HTTP ${r.status}`);
        loadMaterials();
        loadHealth();
      } catch (e) {
        del.disabled = false;
        del.textContent = `Не удалено: ${e.message}`;
      }
    } }, "Убрать из базы");
    const tools = el("div", { class: "mat-tools" });
    if (m.status === "error") {  // повторить — например, после того как появились ключи AI Studio
      const retry = el("button", { type: "button", class: "link-btn accent", onclick: async () => {
        retry.disabled = true;
        const r = await fetch(`/api/materials/${m.id}/retry`, { method: "POST" });
        if (r.ok) loadMaterials(); else { retry.disabled = false; retry.textContent = "Не удалось повторить"; }
      } }, "Повторить");
      tools.append(retry);
    }
    tools.append(del);
    result.append(tools);
  }
  const when = m.finished_at ? `обработан ${fmtTime(m.finished_at)}` : m.started_at ? `начат ${fmtTime(m.started_at)}` : "";
  return el("tr", {},
    el("td", {}, el("span", { class: "mat-name" }, m.filename), el("span", { class: "mat-sub" }, fmtSize(m.size))),
    el("td", {}, fmtTime(m.uploaded_at), el("span", { class: "mat-sub" }, when)),
    el("td", {}, status),
    result);
}

let pollTimer = null;
let wasActive = false;

async function loadMaterials() {
  const box = $("uploads");
  clearTimeout(pollTimer);
  let data;
  try {
    const r = await fetch("/api/materials", { cache: "no-store" });
    data = await r.json();
    if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${r.status}`);
  } catch (e) {
    box.replaceChildren(el("p", { class: "hint" }, `Список недоступен: ${e.message}`));
    pollTimer = setTimeout(loadMaterials, 10000);
    return;
  }
  const rows = data.materials || [];
  if (!rows.length) {
    box.replaceChildren(el("p", { class: "hint" }, "Через веб пока ничего не загружали."));
  } else {
    const body = el("tbody");
    rows.forEach((m) => body.append(materialRow(m)));
    box.replaceChildren(el("table", { class: "mat-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Файл"), el("th", {}, "Загружен"), el("th", {}, "Статус"), el("th", {}, "Итог"))),
      body));
  }
  const active = rows.filter((m) => ACTIVE.has(m.status)).length;
  setText("uploads-live", active ? `в работе: ${active} · обновляется автоматически` : "");
  if (wasActive && !active) loadHealth();  // обработка закончилась — обновить счётчики справа
  wasActive = active > 0;
  pollTimer = setTimeout(loadMaterials, active ? 3000 : 30000);
}

async function uploadFiles(fileList) {
  // «Входящие»: сначала разбор (что это, к чему относится, что уже есть), потом приём по решению аналитика
  const files = [...fileList];
  if (!files.length) return;
  const drop = $("drop");
  const status = $("upload-status");
  if (files.length > 20) {
    status.className = "upload-status bad";
    status.textContent = "Не больше 20 файлов за раз.";
    return;
  }
  drop.classList.add("busy");
  $("pick").setAttribute("aria-disabled", "true");
  status.className = "upload-status";
  status.textContent = `Разбираю ${plural(files.length, "файл", "файла", "файлов")}…`;
  try {
    const analysis = await analyzeFiles(files);
    status.textContent = "Проверьте разбор и нажмите «Принять».";
    const card = intakeCard(analysis, files, () => {
      status.textContent = "";
      loadMaterials();
    });
    $("intake").prepend(card);
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    status.className = "upload-status bad";
    status.textContent = `Не удалось разобрать: ${e.message}`;
  } finally {
    drop.classList.remove("busy");
    $("pick").removeAttribute("aria-disabled");
    $("files").value = "";
  }
}

function initMaterials() {
  const drop = $("drop");
  if (!drop) return;
  const input = $("files");
  const pick = $("pick");  // <label for="files">: диалог открывает браузер сам
  // клик по зоне вне кнопки тоже открывает выбор; клики по самой кнопке и полю не дублируем
  drop.addEventListener("click", (e) => { if (!e.target.closest("label, input")) input.click(); });
  pick.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => uploadFiles(input.files));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    uploadFiles(e.dataTransfer.files);
  });
  fetch("/api/contours", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    contourNames = Object.fromEntries((d?.contours || []).map((c) => [c.id, c.name]));
  }).catch(() => {}).finally(loadMaterials);
}

loadHealth();
initChat();
initMaterials();
