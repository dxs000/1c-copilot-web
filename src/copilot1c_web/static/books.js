// 1С Project Copilot — «Книги»: таблица книг секретаря и история чтения каждой.
// Данные — у ядра (GET /api/secretary/books, /api/secretary/books/{id}); записи по полю «Я» (как в «Секретаре»).
// Использует общие функции из app.js: $, el, setText.
"use strict";

const BOOKS = { person: "", rows: [], open: new Set() };
const STATUS = { reading: "читаю", paused: "отложена", done: "прочитана" };

async function booksApi(path) {
  const r = await fetch(path, { cache: "no-store" });
  let data = {};
  try { data = await r.json(); } catch (e) { /* пустой ответ */ }
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${r.status}`);
  return data;
}

const q = (p) => `person=${encodeURIComponent(BOOKS.person)}`;

function fmtNum(v, suffix = "") { return v == null ? "—" : `${v}${suffix}`; }

function progressCell(b) {
  if (!b.total_pages) return el("td", { class: "hint" }, "объём не указан");
  const pct = b.percent || 0;
  return el("td", {},
    el("div", { class: "books-progress", role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0",
      "aria-valuemax": "100", "aria-label": `Прочитано ${pct} %` }, el("span", { style: `width:${pct}%` })),
    el("small", { class: "hint" }, `${pct} % из ${b.total_pages}` + (b.left != null ? ` · осталось ${b.left}` : "")));
}

function bookRow(b) {
  const tr = el("tr", { class: "book-row" + (b.status === "done" ? " done" : ""), tabindex: "0",
    "aria-expanded": BOOKS.open.has(b.id) ? "true" : "false" },
    el("td", { class: "num" }, String(b.num)),
    el("td", {}, el("b", {}, b.title), b.author ? el("div", { class: "hint" }, b.author) : ""),
    el("td", {}, el("span", { class: `book-status ${b.status}` }, STATUS[b.status] || b.status)),
    el("td", { class: "num" }, fmtNum(b.page)),
    progressCell(b),
    el("td", { class: "num" }, fmtNum(b.week_pages)),
    el("td", { class: "num" }, fmtNum(b.per_day)),
    el("td", {}, b.last_text || el("span", { class: "hint" }, "не отмечали")));
  const toggle = () => {
    if (BOOKS.open.has(b.id)) BOOKS.open.delete(b.id); else BOOKS.open.add(b.id);
    render();
  };
  tr.addEventListener("click", toggle);
  tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  return tr;
}

function historyRow(b) {
  const td = el("td", { colspan: "8", class: "book-history" }, el("p", { class: "hint" }, "Загружаю историю…"));
  booksApi(`/api/secretary/books/${b.id}?${q()}`).then((h) => {
    if (!h.entries.length) { td.replaceChildren(el("p", { class: "hint" }, "Отметок ещё не было.")); return; }
    td.replaceChildren(el("table", { class: "history-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Когда (местное время)"), el("th", { class: "num" }, "Страница"),
        el("th", { class: "num" }, "Прирост"), el("th", {}, "Где"))),
      el("tbody", {}, ...h.entries.map((e) => el("tr", {},
        el("td", {}, `${e.local_text} `, el("span", { class: "hint" }, e.utc_offset)),
        el("td", { class: "num" }, String(e.page)),
        el("td", { class: "num" + (e.delta < 0 ? " neg" : "") }, e.delta == null ? "—" : (e.delta >= 0 ? `+${e.delta}` : String(e.delta))),
        el("td", {}, e.city || "—"))))));
  }).catch((e) => td.replaceChildren(el("p", { class: "hint" }, `Не получилось: ${e.message}`)));
  return el("tr", { class: "history-row" }, td);
}

function render() {
  const showDone = $("books-done").checked;
  const rows = BOOKS.rows.filter((b) => showDone || b.status !== "done");
  const body = $("books-body");
  if (!rows.length) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: "8", class: "hint" },
      BOOKS.rows.length ? "Все книги прочитаны — включите «показывать прочитанные»."
        : "Книг пока нет. В «Секретаре» скажите: «зарегистрируй книгу Л.Н. Толстой „Война и мир“».")));
    return;
  }
  const out = [];
  for (const b of rows) {
    out.push(bookRow(b));
    if (BOOKS.open.has(b.id)) out.push(historyRow(b));
  }
  body.replaceChildren(...out);
}

async function loadBooks() {
  try {
    BOOKS.rows = (await booksApi(`/api/secretary/books?${q()}`)).books;
    render();
  } catch (e) {
    $("books-body").replaceChildren(el("tr", {}, el("td", { colspan: "8", class: "hint" }, `Не получилось: ${e.message}`)));
  }
}

function initBooks() {
  if (!$("books-body")) return;
  try { BOOKS.person = (localStorage.getItem("copilot.analyst") || "").trim(); } catch (e) { /* ничего */ }
  setText("books-who", BOOKS.person ? `Я: ${BOOKS.person}` : "Я: не указано (задайте в «Секретаре»)");
  $("books-done").addEventListener("change", render);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadBooks(); });
  loadBooks();
}

initBooks();
