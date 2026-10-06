// 1С Project Copilot — экран «Обращения»: список с фильтрами и карточка (просмотр, правка, вложения, история).
// Использует общие функции из app.js: $, el, setText, fmtSize, fmtTime, plural.
"use strict";

const ISS = {
  meta: null,              // справочники ядра: статусы, категории, приоритеты, источники, аналитики
  labels: {},              // field → {value: label}
  issue: null,             // открытая карточка (null — новое обращение)
  base: null,              // значения формы при открытии/сохранении — для поиска изменений
  contactId: null,         // выбранный инициатор
  contacts: new Map(),     // подпись в списке подсказок → контакт
  pendingFiles: [],        // файлы, выбранные до создания нового обращения
  extra: {},               // поля без элементов формы: Message-ID и имя файла письма-источника
  listTimer: null,
};

// Поля формы по видам: так форма читается и заполняется одинаково для любого обращения
const TEXT = ["title", "assignee", "description", "error_text", "steps", "expected", "actual", "infobase", "server",
  "config_version", "platform_version", "root_cause", "resolution"];
const SELECT = ["status", "priority", "category", "source"];
const LISTS = ["tags", "objects", "test_case_ids", "requirement_ids"];
const FIELD_LABEL = {
  title: "Тема", description: "Описание", summary: "Краткое описание", error_text: "Текст ошибки", steps: "Шаги",
  expected: "Ожидалось", actual: "Получено", category: "Категория", priority: "Приоритет", status: "Статус",
  tags: "Теги", assignee: "Ответственный", due_date: "Срок", infobase: "База", server: "Сервер",
  config_version: "Версия конфигурации", platform_version: "Версия платформы", objects: "Объекты",
  initiator_contact_id: "Инициатор", reported_at: "Когда сообщил", registered_by: "Кто завёл", source: "Источник",
  source_ref: "Ссылка на источник", duplicate_of: "Дубль обращения", requirement_ids: "Пункты ТЗ",
  test_case_ids: "Тест-кейсы ПиМИ", root_cause: "Причина", resolution: "Решение",
};
const LONG = new Set(["description", "error_text", "steps", "expected", "actual", "root_cause", "resolution", "summary"]);
const OPEN = () => new Set(ISS.meta?.open_statuses || []);

const form = () => $("issue-form");
const field = (name) => form().elements.namedItem(name);

async function api(path, opts = {}) {
  const r = await fetch(path, { cache: "no-store", ...opts });
  let data = {};
  try { data = await r.json(); } catch (e) { /* файл или пустой ответ */ }
  if (!r.ok) {
    const err = new Error(typeof data.detail === "string" ? data.detail : data.detail?.message || `HTTP ${r.status}`);
    err.status = r.status;
    err.detail = data.detail;
    throw err;
  }
  return data;
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------- «Я»: от чьего имени изменения (запоминается в браузере) ----------

function me() {
  const v = ISS.meta?.analysts?.length ? $("me").value : $("me-text").value.trim();
  return v || null;
}

function initMe() {
  let saved = "";
  try { saved = localStorage.getItem("copilot.analyst") || ""; } catch (e) { /* хранилище недоступно */ }
  const remember = (v) => { try { localStorage.setItem("copilot.analyst", v); } catch (e) { /* ничего */ } };
  const analysts = ISS.meta.analysts || [];
  if (analysts.length) {
    $("me").replaceChildren(el("option", { value: "" }, "— выберите себя —"),
      ...analysts.map((a) => el("option", { value: a }, a)));
    if (analysts.includes(saved)) $("me").value = saved;
    $("me").addEventListener("change", () => remember($("me").value));
  } else {
    $("me").hidden = true;
    $("me-text").hidden = false;
    $("me-text").value = saved;
    $("me-text").addEventListener("change", () => remember($("me-text").value.trim()));
  }
  $("analysts").replaceChildren(...analysts.map((a) => el("option", { value: a })));
}

// ---------- справочники и фильтры ----------

function options(select, pairs, keepFirst = 0) {
  const keep = [...select.options].slice(0, keepFirst);
  select.replaceChildren(...keep, ...pairs.map((p) => el("option", { value: p.value }, p.label)));
}

async function loadMeta() {
  ISS.meta = await api("/api/issues/meta");
  for (const [key, field_] of [["statuses", "status"], ["priorities", "priority"], ["categories", "category"], ["sources", "source"]]) {
    ISS.labels[field_] = Object.fromEntries(ISS.meta[key].map((p) => [p.value, p.label]));
  }
  options($("f-status"), ISS.meta.statuses, 2);
  options($("f-priority"), ISS.meta.priorities, 1);
  options($("f-category"), ISS.meta.categories, 1);
  options($("f-assignee"), ISS.meta.analysts.map((a) => ({ value: a, label: a })), 1);
  options(field("status"), ISS.meta.statuses);
  options(field("priority"), ISS.meta.priorities);
  options(field("category"), ISS.meta.categories);
  options(field("source"), ISS.meta.sources);
}

// ---------- список ----------

function priorityClass(p) {
  return p === "critical" ? "prio crit" : p === "high" ? "prio high" : "prio";
}

function statusClass(s) {
  if (s === "new") return "st active-static";
  if (s === "resolved" || s === "closed") return "st done";
  if (s === "rejected" || s === "duplicate") return "st";
  return "st progress";
}

function issueRow(x) {
  const open = el("button", { type: "button", class: "link-btn", onclick: () => openIssue(x.id) }, x.title);
  const sub = [x.initiator_name && `инициатор: ${x.initiator_name}${x.initiator_org ? ` (${x.initiator_org})` : ""}`,
    x.objects?.length ? x.objects.join(", ") : ""].filter(Boolean).join(" · ");
  const tr = el("tr", { class: "clickable" },
    el("td", { class: "mono" }, x.number),
    el("td", {}, open, sub ? el("span", { class: "mat-sub" }, sub) : null),
    el("td", {}, el("span", { class: statusClass(x.status) }, x.status_label)),
    el("td", {}, el("span", { class: priorityClass(x.priority) }, x.priority_label)),
    el("td", {}, x.assignee || "—"),
    el("td", {}, fmtTime(x.updated_at), el("span", { class: "mat-sub" }, x.category_label)),
    el("td", { class: "num" }, x.attachments ? `📎 ${x.attachments}` : ""));
  tr.addEventListener("click", (e) => { if (!e.target.closest("button")) openIssue(x.id); });
  return tr;
}

async function loadIssues() {
  clearTimeout(ISS.listTimer);
  const box = $("issues");
  const params = new URLSearchParams();
  const st = $("f-status").value;
  if (st === "open") params.set("open", "true");
  else if (st) params.set("status", st);
  for (const [id, key] of [["f-priority", "priority"], ["f-category", "category"], ["f-assignee", "assignee"], ["f-q", "q"]]) {
    const v = $(id).value.trim();
    if (v) params.set(key, v);
  }
  try {
    const data = await api("/api/issues?" + params);
    const rows = data.issues || [];
    if (!rows.length) {
      const filtered = [...params.keys()].some((k) => k !== "open");
      box.replaceChildren(el("p", { class: "hint" }, filtered ? "Ничего не найдено — измените фильтры."
        : st === "open" ? "Открытых обращений нет." : "Обращений пока нет."));
    } else {
      const body = el("tbody");
      rows.forEach((x) => body.append(issueRow(x)));
      box.replaceChildren(el("table", { class: "mat-table iss-table" },
        el("thead", {}, el("tr", {}, ...["№", "Тема", "Статус", "Приоритет", "Ответственный", "Обновлено", ""]
          .map((h) => el("th", {}, h)))), body),
        el("p", { class: "hint list-count" }, plural(rows.length, "обращение", "обращения", "обращений")));
    }
  } catch (e) {
    box.replaceChildren(el("p", { class: "hint" }, `Список недоступен: ${e.message}`));
  }
  ISS.listTimer = setTimeout(() => { if ($("issue-panel").hidden) loadIssues(); else ISS.listTimer = null; }, 60000);
}

// ---------- форма карточки: чтение, заполнение, изменения ----------

const clean = (v) => (typeof v === "string" ? v.trim() || null : v ?? null);
const splitList = (s) => [...new Set((s || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))];

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readForm() {
  const v = {};
  TEXT.forEach((k) => { v[k] = clean(field(k).value); });
  SELECT.forEach((k) => { v[k] = field(k).value; });
  LISTS.forEach((k) => { v[k] = splitList(field(k).value); });
  v.due_date = field("due_date").value || null;
  const rep = field("reported_at").value;
  v.reported_at = rep ? new Date(rep).toISOString() : null;
  const dup = field("duplicate_of").value;
  v.duplicate_of = dup ? Number(dup) : null;
  v.initiator_contact_id = ISS.contactId;
  v.source_message_id = ISS.extra.source_message_id ?? null;
  v.source_ref = ISS.extra.source_ref ?? null;
  return v;
}

function fillForm(v) {
  TEXT.forEach((k) => { field(k).value = v[k] ?? ""; });
  SELECT.forEach((k) => { if (v[k]) field(k).value = v[k]; });
  LISTS.forEach((k) => { field(k).value = (v[k] || []).join(", "); });
  field("due_date").value = v.due_date || "";
  field("reported_at").value = toLocalInput(v.reported_at);
  field("duplicate_of").value = v.duplicate_of ?? "";
}

// Сравнение в одной форме записи: даты — как моменты времени, остальное — как JSON
function same(k, a, b) {
  if (k === "reported_at" && a && b) return new Date(a).getTime() === new Date(b).getTime();
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function changes() {
  const now = readForm();
  const out = {};
  for (const k of Object.keys(now)) if (!same(k, ISS.base?.[k], now[k])) out[k] = now[k];
  return out;
}

function dirty() {
  return !$("issue-panel").hidden && (Object.keys(changes()).length > 0 || $("ip-comment").value.trim() !== "");
}

function notice(text, kind = "", action = null) {
  const n = $("ip-notice");
  n.hidden = !text;
  n.className = "notice" + (kind ? " " + kind : "");
  n.textContent = text || "";
  if (text && action) n.append(" ", el("button", { type: "button", class: "btn small", onclick: action.onclick }, action.label));
}

// ---------- инициатор ----------

function contactLabel(c) {
  return [c.name, c.email, c.organization].filter(Boolean).join(" · ");
}

function showContact(c) {
  ISS.contactId = c ? c.id : null;
  $("ip-contact-q").value = c ? contactLabel(c) : "";
  setText("ip-contact-info", c ? [c.position, c.phone].filter(Boolean).join(" · ") : "");
  if (c) ISS.contacts.set(contactLabel(c), c);
}

let contactTimer = null;
function initContacts() {
  const q = $("ip-contact-q");
  q.addEventListener("input", () => {
    clearTimeout(contactTimer);
    const exact = ISS.contacts.get(q.value);
    if (exact) { showContact(exact); return; }
    if (!q.value.trim()) { ISS.contactId = null; setText("ip-contact-info", ""); return; }
    setText("ip-contact-info", "контакт не выбран — выберите из подсказок или добавьте новый");
    ISS.contactId = null;
    contactTimer = setTimeout(async () => {
      try {
        const data = await api("/api/contacts?" + new URLSearchParams({ q: q.value.trim(), limit: "20" }));
        $("contacts").replaceChildren(...data.contacts.map((c) => {
          ISS.contacts.set(contactLabel(c), c);
          return el("option", { value: contactLabel(c) });
        }));
      } catch (e) { /* подсказки необязательны */ }
    }, 250);
  });
  $("ip-contact-new").addEventListener("click", () => {
    const box = $("ip-contact-form");
    box.hidden = !box.hidden;
    if (!box.hidden) {
      const typed = q.value.trim();
      if (typed && !ISS.contactId) (typed.includes("@") ? $("nc-email") : $("nc-name")).value = typed;
      $("nc-name").focus();
    }
  });
  $("nc-save").addEventListener("click", async () => {
    const body = { name: $("nc-name").value, email: $("nc-email").value || null, organization: $("nc-org").value || null,
      position: $("nc-position").value || null, phone: $("nc-phone").value || null };
    try {
      const c = await api("/api/contacts", json("POST", body));
      showContact(c);
      $("ip-contact-form").hidden = true;
      ["nc-name", "nc-email", "nc-org", "nc-position", "nc-phone"].forEach((id) => { $(id).value = ""; });
    } catch (e) {
      notice(`Контакт не добавлен: ${e.message}`, "bad");
    }
  });
}

// ---------- вложения и история ----------

function renderAttachments(issue) {
  const list = $("ip-attachments");
  const items = (issue?.attachments || []).map((a) => el("li", {},
    el("a", { href: `/api/issues/${issue.id}/attachments/${a.id}`, target: "_blank", rel: "noopener" }, a.filename),
    el("span", { class: "mat-sub" }, [fmtSize(a.size), a.uploaded_by, fmtTime(a.uploaded_at)].filter(Boolean).join(" · "))));
  const pending = ISS.pendingFiles.map((f) => el("li", { class: "pending" }, f.name,
    el("span", { class: "mat-sub" }, `${fmtSize(f.size)} · будет прикреплён при сохранении`
      + (isEmail(f.name) ? " вместе с файлами из письма" : ""))));
  list.replaceChildren(...items, ...pending);
  if (!items.length && !pending.length) list.append(el("li", { class: "hint" }, "Вложений нет."));
}

function fmtValue(k, v) {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "—";
  if (ISS.labels[k]) return ISS.labels[k][v] || v;
  if (Array.isArray(v)) return v.join(", ");
  if (k === "reported_at") return fmtTime(v);
  if (k === "duplicate_of") return `ОБР-${String(v).padStart(4, "0")}`;
  if (k === "initiator_contact_id") return `контакт № ${v}`;
  const s = String(v);
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

function eventLine(e) {
  const who = el("b", {}, e.actor || "—");
  const when = el("time", { datetime: e.at }, fmtTime(e.at));
  let what;
  if (e.type === "created") what = "завёл обращение";
  else if (e.type === "comment") what = el("span", { class: "ev-comment" }, e.comment);
  else if (e.type === "attachment") what = `приложил файл «${e.new_value?.filename || "?"}»`;
  else {
    const name = FIELD_LABEL[e.field] || e.field;
    what = LONG.has(e.field) ? `изменил поле «${name}»`
      : `${name}: ${fmtValue(e.field, e.old_value)} → ${fmtValue(e.field, e.new_value)}`;
  }
  return el("li", { class: "ev ev-" + e.type }, el("div", { class: "ev-head" }, who, " ", when), el("div", {}, what));
}

function renderHistory(issue) {
  $("ip-history-box").hidden = !issue;
  if (issue) $("ip-history").replaceChildren(...(issue.events || []).map(eventLine).reverse());  // новые сверху
}

// ---------- открыть / создать / сохранить ----------

function showPanel() {
  form().scrollTop = 0;  // карточка всегда открывается с начала
  $("issue-panel").hidden = false;
  $("backdrop").hidden = false;
  document.body.classList.add("drawer-open");
}

function render(issue) {
  ISS.issue = issue;
  ISS.extra = issue ? { source_message_id: issue.source_message_id, source_ref: issue.source_ref } : {};
  $("ip-chain").hidden = true;
  notice("");
  setText("ip-saved", "");
  $("ip-contact-form").hidden = true;
  $("ip-comment").value = "";
  if (issue) {
    setText("ip-number", issue.number);
    const st = $("ip-status");
    st.className = statusClass(issue.status);
    st.textContent = issue.status_label;
    st.hidden = false;
    fillForm(issue);
    showContact(issue.initiator);
    $("ip-files-hint").textContent = "или перетащите сюда скриншоты, логи, письма";
  } else {
    setText("ip-number", "Новое обращение");
    $("ip-status").hidden = true;
    form().reset();
    fillForm({ status: "new", priority: "medium", category: "bug", source: "manual" });
    showContact(null);
    $("ip-files-hint").textContent = "файлы прикрепятся, когда обращение будет сохранено";
  }
  ISS.base = readForm();
  renderAttachments(issue);
  renderHistory(issue);
}

async function openIssue(id) {
  if (dirty() && !confirm("Есть несохранённые изменения. Открыть другое обращение и отбросить их?")) return;
  ISS.pendingFiles = [];
  try {
    render(await api(`/api/issues/${id}`));
    history.replaceState(null, "", `#${id}`);
    showPanel();
    $("ip-close").focus();
  } catch (e) {
    alert(e.status === 404 ? `Обращение № ${id} не найдено` : `Не удалось открыть обращение: ${e.message}`);
  }
}

function newIssue() {
  if (dirty() && !confirm("Есть несохранённые изменения. Начать новое обращение и отбросить их?")) return;
  ISS.pendingFiles = [];
  render(null);
  history.replaceState(null, "", "#new");
  showPanel();
  $("ip-title").focus();
}

function closePanel(force = false) {
  if (!force && dirty() && !confirm("Есть несохранённые изменения. Закрыть без сохранения?")) return;
  $("issue-panel").hidden = true;
  $("backdrop").hidden = true;
  document.body.classList.remove("drawer-open");
  ISS.issue = null;
  ISS.pendingFiles = [];
  history.replaceState(null, "", location.pathname + location.search);
  loadIssues();
}

const isEmail = (name) => /\.(msg|eml)$/i.test(name || "");

async function uploadTo(id, files) {
  const body = new FormData();
  files.forEach((f) => body.append("files", f, f.name));
  body.append("expand", "true");  // письма .msg/.eml прикрепляются вместе со скриншотами и логами из них
  const actor = me();
  if (actor) body.append("actor", actor);
  const data = await api(`/api/issues/${id}/attachments`, { method: "POST", body });
  return (data.attachments || []).filter((a) => a.error).map((a) => `${a.filename}: ${a.error}`);
}

async function save(e) {
  e.preventDefault();
  if (!field("title").value.trim()) { notice("Укажите тему обращения.", "bad"); field("title").focus(); return; }
  const btn = $("ip-save");
  btn.disabled = true;
  setText("ip-saved", "сохраняю…");
  try {
    if (!ISS.issue) {
      const v = readForm();
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && !(Array.isArray(x) && !x.length)));
      const actor = me();
      if (actor) body.actor = actor;
      const created = await api("/api/issues", json("POST", body));
      const failed = ISS.pendingFiles.length ? await uploadTo(created.id, ISS.pendingFiles) : [];
      ISS.pendingFiles = [];
      const comment = $("ip-comment").value.trim();
      if (comment) await api(`/api/issues/${created.id}/comments`, json("POST", { text: comment, actor }));
      render(await api(`/api/issues/${created.id}`));
      form().scrollTop = 0;
      history.replaceState(null, "", `#${created.id}`);
      if (created.already_registered) notice("Это письмо уже зарегистрировано — открыто существующее обращение.");
      else if (failed.length) notice(`Обращение создано, но не все файлы прикреплены: ${failed.join("; ")}`, "bad");
      setText("ip-saved", `создано ${created.number}`);
    } else {
      const diff = changes();
      const comment = $("ip-comment").value.trim();
      if (!Object.keys(diff).length && !comment) { setText("ip-saved", "изменений нет"); return; }
      try {
        render(await api(`/api/issues/${ISS.issue.id}`, json("PATCH",
          { version: ISS.issue.version, changes: diff, comment: comment || null, actor: me() })));
        setText("ip-saved", "сохранено");
      } catch (err) {
        if (err.status !== 409 || !err.detail?.current) throw err;
        // Обращение успели изменить: показываем свежую версию и возвращаем в форму правки аналитика —
        // он видит, что поменялось (история), и сохраняет ещё раз осознанно.
        render(err.detail.current);
        fillForm({ ...readForm(), ...diff });
        if ("initiator_contact_id" in diff) {
          showContact([...ISS.contacts.values()].find((c) => c.id === diff.initiator_contact_id) || null);
        }
        if (comment) $("ip-comment").value = comment;
        notice("Пока вы редактировали, обращение изменил другой аналитик (см. историю). Ваши правки сохранены в форме, " +
          "но не записаны — проверьте их и нажмите «Сохранить» ещё раз.", "warn");
        setText("ip-saved", "");
      }
    }
  } catch (err) {
    notice(`Не сохранено: ${err.message}`, "bad");
    setText("ip-saved", "");
  } finally {
    btn.disabled = false;
    loadIssues();  // список за панелью — в актуальном виде
  }
}

async function addComment() {
  const text = $("ip-comment").value.trim();
  if (!text) return;
  if (!ISS.issue) { notice("Комментарий будет добавлен при сохранении нового обращения."); return; }
  try {
    const card = await api(`/api/issues/${ISS.issue.id}/comments`, json("POST", { text, actor: me() }));
    $("ip-comment").value = "";
    renderHistory(card);
  } catch (e) {
    notice(`Комментарий не добавлен: ${e.message}`, "bad");
  }
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (!ISS.issue) {
    ISS.pendingFiles.push(...files);
    renderAttachments(null);
    return;
  }
  setText("ip-saved", `прикрепляю ${plural(files.length, "файл", "файла", "файлов")}…`);
  try {
    const failed = await uploadTo(ISS.issue.id, files);
    const card = await api(`/api/issues/${ISS.issue.id}`);
    ISS.issue.attachments = card.attachments;  // форму не трогаем: в ней могут быть несохранённые правки
    renderAttachments(card);
    renderHistory(card);
    notice(failed.length ? `Не прикреплено: ${failed.join("; ")}` : "", failed.length ? "bad" : "");
    setText("ip-saved", failed.length ? "" : "файлы прикреплены");
  } catch (e) {
    notice(`Файлы не прикреплены: ${e.message}`, "bad");
    setText("ip-saved", "");
  } finally {
    $("ip-files").value = "";
  }
}

// ---------- заполнение по письму пользователя ----------

function emailRole(c) {
  return `${c.role_label}${c.origin === "file" ? "" : ` · ${c.origin_label}`}`;
}

async function chooseInitiator(c, signatureHint) {
  // контакт по адресу: найдётся существующий (пустые поля дополнятся подписью) или будет создан
  if (!c.email && !c.name) return;
  const sig = signatureHint || c.signature || {};
  try {
    const contact = await api("/api/contacts", json("POST", { name: c.name, email: c.email,
      position: sig.position || null, phone: sig.phone || null, organization: sig.organization || null }));
    showContact(contact);
    if (c.date) field("reported_at").value = toLocalInput(c.date);
  } catch (e) {
    notice(`Контакт не сохранён: ${e.message}`, "bad");
  }
}

function renderChain(p) {
  const box = $("ip-chain");
  if (!p.chain?.length) { box.hidden = true; return; }
  const items = [...p.chain].reverse().map((c) => {  // новые сверху, как в почте
    const who = el("span", { class: "chain-who" }, el("b", {}, c.name || c.email || "—"),
      c.email ? el("span", { class: "mat-sub" }, c.email) : null);
    const meta = el("span", { class: "mat-sub" }, [emailRole(c), c.date ? fmtTime(c.date) : ""].filter(Boolean).join(" · "));
    const pick = c.chosen ? el("span", { class: "st done" }, "инициатор")
      : c.role === "analyst" ? null
        : el("button", { type: "button", class: "btn small", onclick: async () => {
          await chooseInitiator(c);
          p.chain.forEach((x) => { x.chosen = x.index === c.index; });
          renderChain(p);
          notice(`Инициатор выбран вручную: ${c.name || c.email}${c.email && c.name ? ` (${c.email})` : ""}; ` +
            "«Когда сообщил» — дата его письма. Проверьте поля и сохраните.", "info");
        } }, "Сделать инициатором");
    return el("li", { class: c.chosen ? "chosen" : "" }, el("div", { class: "chain-row" }, who, meta, pick),
      c.excerpt ? el("div", { class: "chain-excerpt" }, c.excerpt) : null);
  });
  box.replaceChildren(el("div", { class: "chain-head" }, `Цепочка письма: ${plural(p.chain.length, "автор", "автора", "авторов")}`),
    el("ol", { class: "chain-list" }, ...items));
  box.hidden = false;
}

async function fromEmail(file) {
  if (!file) return;
  if (!isEmail(file.name)) { notice("Нужен файл письма .msg или .eml", "bad"); return; }
  setText("ip-saved", "разбираю письмо…");
  let p;
  try {
    const body = new FormData();
    body.append("file", file, file.name);
    p = await api("/api/issues/from-email", { method: "POST", body });
  } catch (e) {
    notice(`Письмо не разобрано: ${e.message}`, "bad");
    setText("ip-saved", "");
    return;
  }
  setText("ip-saved", "");
  const reg = p.already_registered;
  if (reg && reg.id !== ISS.issue?.id) {
    notice(`Это письмо уже зарегистрировано: ${reg.number} «${reg.title}».`, "warn",
      { label: `Открыть ${reg.number}`, onclick: () => { ISS.pendingFiles = []; ISS.base = readForm(); openIssue(reg.id); } });
    return;
  }
  // поля из письма заполняют только пустое — набранное аналитиком не затирается
  const d = p.draft;
  for (const k of ["title", "description"]) if (d[k] && !field(k).value.trim()) field(k).value = d[k];
  if (d.reported_at && !field("reported_at").value) field("reported_at").value = toLocalInput(d.reported_at);
  field("source").value = "email";
  if (!ISS.extra.source_message_id) ISS.extra = { source_message_id: d.source_message_id, source_ref: d.source_ref };

  const ini = p.initiator;
  const chosen = p.chain.find((c) => c.chosen);
  if (p.contact) {
    await chooseInitiator({ ...chosen, name: p.contact.name, email: p.contact.email }, ini);
  } else if (ini && p.confidence === "high") {
    await chooseInitiator(chosen, ini);
  } else if (ini) {
    // неуверенный выбор — контакт не создаётся сам: форма заполнена, аналитик подтверждает
    $("ip-contact-form").hidden = false;
    $("nc-name").value = ini.name || "";
    $("nc-email").value = ini.email || "";
    $("nc-position").value = ini.position || "";
    $("nc-phone").value = ini.phone || "";
    $("nc-org").value = ini.organization || "";
  }
  renderChain(p);

  if (ISS.issue) {
    try {
      const failed = await uploadTo(ISS.issue.id, [file]);
      const card = await api(`/api/issues/${ISS.issue.id}`);
      ISS.issue.attachments = card.attachments;
      renderAttachments(card);
      renderHistory(card);
      if (failed.length) notice(`Не прикреплено: ${failed.join("; ")}`, "bad");
    } catch (e) {
      notice(`Письмо не прикреплено: ${e.message}`, "bad");
    }
  } else {
    ISS.pendingFiles.push(file);
    renderAttachments(null);
  }
  const files = p.files?.length ? `; из письма будет прикреплено файлов: ${p.files.length}` : "";
  const how = ini ? `Инициатор: ${ini.name}${ini.email ? ` (${ini.email})` : ""} — ${p.reason}` : p.reason;
  notice(`${how}${files}. Проверьте поля и сохраните.`, p.confidence === "high" ? "info" : "warn");
}

// ---------- запуск ----------

async function initIssues() {
  if (!$("issue-panel")) return;
  try {
    await loadMeta();
  } catch (e) {
    $("issues").replaceChildren(el("p", { class: "hint" }, `Обращения недоступны: ${e.message}`));
    return;
  }
  initMe();
  initContacts();

  let qTimer = null;
  $("f-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(loadIssues, 300); });
  ["f-status", "f-priority", "f-category", "f-assignee"].forEach((id) => $(id).addEventListener("change", loadIssues));
  $("filters").addEventListener("submit", (e) => { e.preventDefault(); loadIssues(); });

  $("new-issue").addEventListener("click", newIssue);
  // «Из письма…»: в шапке — новое обращение по письму, в карточке — дозаполнить открытое
  let emailTarget = "new";
  $("new-from-email").addEventListener("click", () => { emailTarget = "new"; $("email-file").click(); });
  $("ip-from-email").addEventListener("click", () => { emailTarget = "card"; $("email-file").click(); });
  $("email-file").addEventListener("change", async () => {
    const file = $("email-file").files[0];
    $("email-file").value = "";
    if (!file) return;
    if (emailTarget === "new") {
      if (dirty() && !confirm("Есть несохранённые изменения. Начать новое обращение и отбросить их?")) return;
      ISS.base = readForm();  // вопрос уже задан — newIssue не спрашивает повторно
      newIssue();
    }
    await fromEmail(file);
  });
  $("ip-close").addEventListener("click", () => closePanel());
  $("ip-cancel").addEventListener("click", () => closePanel());
  $("backdrop").addEventListener("click", () => closePanel());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("issue-panel").hidden) closePanel(); });
  form().addEventListener("submit", save);
  $("ip-comment-send").addEventListener("click", addComment);
  $("ip-files").addEventListener("change", () => addFiles($("ip-files").files));
  const drop = $("ip-drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
  window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });

  await loadIssues();
  const h = location.hash.slice(1);
  if (h === "new") newIssue();
  else if (/^\d+$/.test(h)) openIssue(Number(h));
}

initIssues();
