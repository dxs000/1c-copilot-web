// 1С Project Copilot — «Секретарь»: место, рабочие сессии и перерывы, сообщения таймера.
// Таймер и записи живут в ядре; страница показывает «сейчас», ведёт обратный отсчёт и забирает сообщения
// об окончании сессий (опрос раз в 5 с). Использует общие функции из app.js: $, el, setText.
"use strict";

const SEC = {
  person: "",
  state: null,
  skew: 0,              // часы сервера минус часы браузера, мс
  shown: new Set(),     // id показанных сообщений таймера
  pollTimer: null,
  audio: null,
  ending: false,        // отсчёт дошёл до нуля — ждём сообщение ядра
};
const POLL_MS = 5000;
const LOG_MAX = 150;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* хранилище недоступно */ }
  },
};
const logKey = () => `copilot.secretary.log.${SEC.person || "-"}`;

async function secApi(path, opts = {}) {
  const r = await fetch(path, { cache: "no-store", ...opts });
  let data = {};
  try { data = await r.json(); } catch (e) { /* пустой ответ */ }
  if (!r.ok) throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${r.status}`);
  return data;
}
const post = (path, body) => secApi(path, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body) });

// ---------- сообщения ----------

function addMessage(kind, text, opts = {}) {
  $("sec-empty")?.remove();
  const box = $("sec-messages");
  const cls = kind === "user" ? "msg-user" : kind === "sky" ? "sec-sky" : "msg-bot sec-msg" +
    (kind === "notice" ? " sec-alert" : "") + (kind === "error" ? " error" : "");
  const node = el("div", { class: cls });
  if (kind === "sky") node.append(el("span", { class: "sec-sky-mark", "aria-hidden": "true" }, "✦"));
  else if (opts.meta) node.append(el("div", { class: "msg-meta" }, opts.meta));
  node.append(el("div", { class: "sec-text" }, text));
  box.append(node);
  node.scrollIntoView({ block: "end", behavior: "smooth" });
  if (!opts.restore) {
    const log = store.get(logKey(), []);
    log.push({ kind, text, meta: opts.meta || "" });
    store.set(logKey(), log.slice(-LOG_MAX));
  }
}

function restoreLog() {
  $("sec-messages").replaceChildren(
    el("div", { class: "empty", id: "sec-empty" }, el("h1", {}, "Секретарь"),
      el("p", {}, "Скажите, где вы, и запустите рабочую сессию. По окончании — точное местное время и погода.")));
  for (const m of store.get(logKey(), [])) addMessage(m.kind, m.text, { meta: m.meta, restore: true });
}

async function say(text) {
  addMessage("user", text);
  unlockAudio();
  $("sec-send").disabled = true;
  try {
    const r = await post("/api/secretary/say", { person: SEC.person, text });
    addMessage("bot", r.reply, { meta: r.via === "model" ? "понято моделью" : "" });
    applyState(r.state);
  } catch (e) {
    addMessage("error", `Не получилось: ${e.message}`);
  } finally {
    $("sec-send").disabled = false;
  }
}

// ---------- сигнал и уведомление браузера ----------

function unlockAudio() {
  if (SEC.audio) return;
  try { SEC.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { SEC.audio = null; }
}

function beep() {
  const ctx = SEC.audio;
  if (!ctx) return;
  try {
    ctx.resume();
    [0, 0.35, 0.7].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i === 2 ? 1046 : 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.3);
    });
  } catch (e) { /* звук недоступен */ }
}

function notifyBrowser(text) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const [title, ...rest] = text.split("\n");
  try { new Notification(title, { body: rest.join("\n"), tag: "copilot-secretary" }); } catch (e) { /* ничего */ }
}

function initNotifyButton() {
  const btn = $("sec-notify");
  if (!("Notification" in window) || Notification.permission !== "default") return;
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    unlockAudio();
    try { await Notification.requestPermission(); } catch (e) { /* старые браузеры */ }
    btn.hidden = Notification.permission !== "default";
  });
}

// ---------- «сейчас»: часы, сессия, поездки ----------

const fmtCache = new Map();
function formatter(tz, opts) {
  const key = tz + JSON.stringify(opts);
  if (!fmtCache.has(key)) {
    try { fmtCache.set(key, new Intl.DateTimeFormat("ru-RU", { timeZone: tz, ...opts })); }
    catch (e) { fmtCache.set(key, null); }
  }
  return fmtCache.get(key);
}

// Время по поясу места; если браузер не знает пояс — по смещению UTC из ответа ядра
function zoned(date, opts) {
  const st = SEC.state;
  const f = st && formatter(st.tz, opts);
  if (f) return f.format(date);
  const m = /UTC([+-])(\d\d):(\d\d)/.exec(st?.utc_offset || "");
  const shift = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", ...opts }).format(new Date(date.getTime() + shift * 60000));
}

const serverNow = () => new Date(Date.now() + SEC.skew);

function pad(n) { return String(n).padStart(2, "0"); }
function fmtLeft(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function tick() {
  const st = SEC.state;
  if (!st) return;
  const now = serverNow();
  setText("sec-clock", zoned(now, { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  setText("sec-date", `${zoned(now, { weekday: "long", day: "numeric", month: "long" })} · ${st.utc_offset}`);
  const s = st.session;
  if (!s) return;
  const end = new Date(s.ends_at), start = new Date(s.started_at);
  const left = Math.max(0, Math.round((end - now) / 1000));
  setText("sec-left", left ? fmtLeft(left) : "00:00");
  const pct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  $("sec-bar-fill").style.width = `${pct}%`;
  $("sec-bar").setAttribute("aria-valuenow", String(Math.round(pct)));
  if (!left && !SEC.ending) {
    SEC.ending = true;
    setText("sec-until", "Время вышло — жду сообщение секретаря…");
    setTimeout(poll, 1500);  // ядро завершает сессию в течение секунды-двух, погода — ещё несколько секунд
  }
}

function applyState(st) {
  if (!st) return;
  SEC.state = st;
  SEC.skew = Date.parse(st.now) - Date.now();
  const p = st.place;
  $("sec-city").replaceChildren(p ? el("b", {}, p.city) : "Место не указано",
    p ? el("span", { class: "hint" }, ` · ${p.country}`) : "");
  const s = st.session;
  $("sec-session").hidden = !s;
  if (s) {
    SEC.ending = s.remaining_s <= 0 && SEC.ending;
    setText("sec-session-title", s.kind === "work" ? `Работа · ${fmtMin(s.minutes)}` : `Перерыв · ${fmtMin(s.minutes)}`);
    $("sec-session").classList.toggle("rest", s.kind === "rest");
    if (s.remaining_s > 0) {
      SEC.ending = false;
      setText("sec-until", `до ${zoned(new Date(s.ends_at), { hour: "2-digit", minute: "2-digit" })} по местному времени`);
    }
  } else SEC.ending = false;
  setText("sec-today", (st.today || "—").replace(/^Сегодня:\s*/, ""));
  const trips = st.upcoming || [];
  $("sec-trips").replaceChildren(...(trips.length ? trips.map((u) => el("li", {},
    el("b", {}, u.city), ` — с ${fmtDay(u.date)}`)) : [el("li", { class: "hint" }, "Запланированных нет")]));
  renderBooks(st.books || []);
  for (const n of st.unread || []) deliver(n);
  tick();
}

// «2026-10-10» → «10 октября, суббота» (день как его назвали, без сдвига поясов)
function fmtDay(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y) return "—";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long", weekday: "long" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

// Читаемые книги на панели: № , название, страница и прогресс; щелчок — подставить «книга № N, страница »
function renderBooks(books) {
  const box = $("sec-books");
  if (!books.length) {
    box.replaceChildren(el("li", { class: "hint" }, "Книг в чтении нет — «зарегистрируй книгу Л.Н. Толстой „Война и мир“»"));
    return;
  }
  box.replaceChildren(...books.map((b) => {
    const page = b.page != null ? `стр. ${b.page}${b.total_pages ? ` из ${b.total_pages}` : ""}` : "не отмечали";
    const bar = el("span", { class: "sec-book-bar" }, el("span", { style: `width:${b.percent || 0}%` }));
    const btn = el("button", { type: "button", class: "sec-book", title: "Отметить страницу",
      onclick: () => { const q = $("sec-q"); q.value = `книга № ${b.num}, страница `; q.focus(); } },
      el("b", {}, `№ ${b.num}`), " ", el("span", { class: "sec-book-title" }, b.title),
      el("span", { class: "sec-book-meta" }, page + (b.section ? ` · ${b.section}` : "") + (b.last_text ? ` · ${b.last_text}` : "")),
      b.total_pages ? bar : "");
    return el("li", {}, btn);
  }));
}

function fmtMin(m) {
  const h = Math.floor(m / 60), mi = m % 60;
  return h && mi ? `${h} ч ${mi} мин` : h ? `${h} ч` : `${mi} мин`;
}

async function deliver(n) {
  if (SEC.shown.has(n.id)) return;
  SEC.shown.add(n.id);
  if (n.kind === "astro") {  // небо — тихо: без звука и уведомления браузера, строкой в ленте
    addMessage("sky", n.text);
    try { await post(`/api/secretary/notices/${n.id}/read`, { person: SEC.person }); } catch (e) { /* покажется снова */ }
    return;
  }
  addMessage("notice", n.text, { meta: "Таймер" });
  beep();
  notifyBrowser(n.text);
  if (document.hidden) document.title = "⏰ Сессия закончилась — Секретарь";
  try { await post(`/api/secretary/notices/${n.id}/read`, { person: SEC.person }); } catch (e) { /* покажется снова */ }
}

async function poll() {
  try {
    applyState(await secApi(`/api/secretary/state?person=${encodeURIComponent(SEC.person)}`));
  } catch (e) {
    setText("sec-until", `Нет связи с ядром: ${e.message}`);
  }
}

// ---------- запуск ----------

function setPerson(v) {
  SEC.person = v.trim();
  try { localStorage.setItem("copilot.analyst", SEC.person); } catch (e) { /* ничего */ }
  SEC.shown.clear();
  restoreLog();
  poll();
}

function initSecretary() {
  const form = $("sec-form");
  if (!form) return;
  const q = $("sec-q");
  let saved = "";
  try { saved = localStorage.getItem("copilot.analyst") || ""; } catch (e) { /* ничего */ }
  $("sec-me").value = saved;
  SEC.person = saved.trim();
  $("sec-me").addEventListener("change", () => setPerson($("sec-me").value));

  form.querySelectorAll(".chips button").forEach((b) => b.addEventListener("click", () => say(b.textContent)));
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    q.value = "";
    say(text);
  });
  $("sec-stop").addEventListener("click", () => say("Стоп"));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { document.title = "Секретарь — 1С Project Copilot"; poll(); }
  });
  document.addEventListener("click", unlockAudio, { once: true });
  initNotifyButton();
  restoreLog();
  poll();
  SEC.pollTimer = setInterval(poll, POLL_MS);
  setInterval(tick, 1000);
}

initSecretary();
