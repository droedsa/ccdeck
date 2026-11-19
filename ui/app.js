const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event?.listen;

const COLORS = ["#d97757", "#6a9bcc", "#788c5d", "#b07cc6", "#c9a227", "#5aa3a3"];
const COLOR_NAMES = ["Оранжевый", "Голубой", "Зелёный", "Фиолетовый", "Жёлтый", "Бирюзовый"];
const LIMIT_OFFER = 95; // % — предлагаем открыть под другим аккаунтом
const LIMIT_WARN = 85;  // % — предупреждаем в строке чата
const USAGE_STALE_MS = 15 * 60 * 1000; // старше — перед открытием тихо проверяем лимиты

const st = {
  accounts: [],
  sessions: [],
  loaded: false,
  running: [],
  bindings: {},
  chatBindings: {},
  defaultAccount: "main",
  wrapLog: [],
  windows: true,
  integration: { editors: [] },
  claude: { found: true },
  version: "",
  q: "",
  project: null,
  hideMissing: true,
  show: "all",       // all | open
  accFilter: null,   // id аккаунта: только чаты, открытые под ним
  deepIds: null,
  deepQuery: "",
};

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

/* ================================================================== утилиты */
function hl(text) {
  const t = esc(text);
  const q = st.q.trim();
  if (!q) return t;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return t.replace(re, (m) => `<mark>${m}</mark>`);
}

function baseName(p) {
  if (!p) return "—";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function ago(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "только что";
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  if (d < 172800) return "вчера";
  const dt = new Date(ms);
  return dt.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: dt.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function untilText(iso) {
  if (!iso) return "";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "уже сбросился";
  if (s < 3600) return `сброс через ${Math.ceil(s / 60)} мин`;
  if (s < 86400) return `сброс через ${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
  return `сброс ${new Date(iso).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })}`;
}

/* --- уведомления: обычные исчезают сами, ошибки — висят до закрытия, их можно скопировать */
let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  clearTimeout(toastTimer);
  t.className = "toast" + (err ? " err" : "");
  t.setAttribute("role", err ? "alert" : "status");
  t.innerHTML = `<span class="t-text">${esc(msg)}</span>${err
    ? `<button data-t="copy" title="Скопировать текст ошибки">Скопировать</button><button data-t="x" aria-label="Закрыть">×</button>`
    : ""}`;
  t.hidden = false;
  if (!err) toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
$("#toast").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.t === "copy") {
    await navigator.clipboard.writeText($("#toast .t-text").textContent);
    b.textContent = "Скопировано";
  } else $("#toast").hidden = true;
});

async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(String(e), true);
    throw e;
  }
}

/** Ждать, пока условие не станет истинным (опрос каждые 3 с, до 3 мин). */
function waitFor(check, onDone, ms = 180000) {
  const t0 = Date.now();
  const tick = async () => {
    try { if (await check()) return onDone(); } catch {}
    if (Date.now() - t0 < ms) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

/* ================================================================== какой аккаунт */
function normPath(p) {
  let s = String(p || "").trim().replace(/\\/g, "/");
  if (s.startsWith("//?/")) s = s.slice(4);
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return st.windows ? s.toLowerCase() : s;
}

const accById = (id) => st.accounts.find((a) => a.id === id);
const defAcc = () => accById(st.defaultAccount) || st.accounts[0];

/** Аккаунт проекта: {acc, bound}. */
function projectAccount(path) {
  const p = normPath(path);
  let best = null;
  for (const [k, id] of Object.entries(st.bindings)) {
    if ((p === k || p.startsWith(k + "/")) && accById(id) && (!best || k.length > best.k.length)) best = { k, id };
  }
  return best ? { acc: accById(best.id), bound: true } : { acc: defAcc(), bound: false };
}

/** Аккаунт чата: первый, где выбран — чат → проект → основной. {acc, source}. */
function chatAccount(s) {
  const own = accById(st.chatBindings[s.id]);
  if (own) return { acc: own, source: "chat" };
  const p = projectAccount(s.cwd);
  return { acc: p.acc, source: p.bound ? "project" : "default" };
}
const SOURCE_LABEL = { chat: "для чата", project: "проект", default: "основной" };
const SOURCE_WHY = {
  chat: "выбран для этого чата",
  project: "так выбрано для проекта",
  default: "основной аккаунт: для чата и проекта ничего не выбрано",
};

/** Процент с учётом сброса: если окно уже сбросилось, старое значение неактуально → 0. */
function effUsage(val, resets) {
  if (val == null) return null;
  if (resets && Date.parse(resets) <= Date.now()) return 0;
  return val;
}
function usagePeak(acc) {
  const u = acc?.usage;
  if (!u) return null;
  const vals = [effUsage(u.five_hour, u.five_hour_resets), effUsage(u.seven_day, u.seven_day_resets)].filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}
/** Когда сбросится самое загруженное окно. */
function peakResets(acc) {
  const u = acc?.usage;
  if (!u) return null;
  const fh = effUsage(u.five_hour, u.five_hour_resets) ?? -1;
  const sd = effUsage(u.seven_day, u.seven_day_resets) ?? -1;
  return fh >= sd ? u.five_hour_resets : u.seven_day_resets;
}

/** Под каким аккаунтом чат шёл на самом деле — по отметкам в файле чата (пишет приложение Claude). */
function recordedAccount(s) {
  if (!s) return null;
  if (s.org_uuid) {
    const a = st.accounts.find((x) => x.org_uuid === s.org_uuid);
    if (a) return { acc: a };
  }
  if (s.account_email) {
    const same = st.accounts.filter((x) => x.email === s.account_email);
    if (same.length === 1) return { acc: same[0] };
    return { email: s.account_email };
  }
  return null;
}

/** Аккаунт открытого сейчас чата. */
function runAccount(run) {
  const s = st.sessions.find((x) => x.id === run.session_id);
  if (run.entrypoint === "claude-desktop" || s?.entrypoint === "claude-desktop") {
    const r = recordedAccount(s);
    if (r) return r;
  }
  return { acc: accById(run.account_id) };
}
const runName = (r) => r?.acc?.name || r?.email || "?";

const hasEditor = () => st.integration.editors.some((e) => e.installed);
const connected = () => st.integration.editors.some((e) => e.connected);

/* ================================================================== окна */
let modalState = null; // { onClose, returnFocus }
let modalHideTimer = null;

/** Плавно скрыть окно. */
function hideModal() {
  const m = $("#modal");
  m.classList.add("closing");
  clearTimeout(modalHideTimer);
  modalHideTimer = setTimeout(() => { m.hidden = true; m.classList.remove("closing"); }, 140);
}

function modal(html, onMount, onClose) {
  const m = $("#modal");
  const card = $("#modal-card");
  clearTimeout(modalHideTimer);
  m.classList.remove("closing");
  modalState = { onClose, returnFocus: document.activeElement };
  card.innerHTML = html;
  const h = card.querySelector("h3");
  if (h) { h.id = "modal-title"; card.setAttribute("aria-labelledby", "modal-title"); }
  m.hidden = false;
  const close = (fromUser = false) => {
    if (m.hidden || m.classList.contains("closing")) return;
    hideModal();
    const s = modalState;
    modalState = null;
    if (fromUser) s?.onClose?.();
    s?.returnFocus?.focus?.();
  };
  m.onclick = (e) => e.target === m && close(true);
  onMount?.(card, () => close(false));
  (card.querySelector("input[type=text]") || card.querySelector(".primary") || card.querySelector("button"))?.focus();
  return close;
}
function closeModalByUser() {
  const m = $("#modal");
  if (m.hidden || m.classList.contains("closing")) return;
  hideModal();
  const s = modalState;
  modalState = null;
  s?.onClose?.();
  s?.returnFocus?.focus?.();
}

/** Диалог с кнопками → значение нажатой кнопки; Esc / клик мимо → null. */
function choose(title, html, buttons, after = "") {
  return new Promise((resolve) => {
    modal(
      `<h3>${esc(title)}</h3>${html}
       <div class="buttons">${buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ""}">${esc(b.label)}</button>`).join("")}</div>
       ${after ? `<p class="after">${after}</p>` : ""}`,
      (card, close) => {
        card.querySelectorAll("[data-i]").forEach((el) => {
          el.onclick = () => { close(); resolve(buttons[+el.dataset.i].value); };
        });
      },
      () => resolve(null)
    );
  });
}

// ловушка фокуса в окне
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab" || $("#modal").hidden) return;
  const items = [...$("#modal-card").querySelectorAll("button, input, summary, [tabindex]")].filter((x) => !x.disabled);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

function showHelp() {
  store.set("ccdeck-help-seen", "1");
  const d = defAcc();
  modal(
    `<h3>Как это работает</h3>
     <p><b>Чаты общие для всех аккаунтов.</b> Любой чат можно продолжить под любым аккаунтом с того же места.</p>
     <p style="margin-bottom:2px"><b>Под каким аккаунтом откроется чат</b> — берётся первый, где он выбран:</p>
     <div class="chain"><span class="step">Чат</span><span class="arrow">→</span><span class="step">Проект</span><span class="arrow">→</span><span class="step">Основной: ${esc(d?.name || "")}</span></div>
     <ol class="steps">
       <li>Справа у каждого чата — метка <span class="chip-demo" style="--c:${d?.color}"><span class="dot"></span>${esc(d?.name || "")} · основной ▾</span>.
           В ней видно аккаунт и откуда он взялся. Нажмите на метку, чтобы сменить аккаунт чата или всего проекта.</li>
       <li><b>«Открыть»</b> запускает чат в VS Code под этим аккаунтом. <b>«VS Code ▸»</b> у проекта слева открывает весь проект.</li>
       <li><b>Упёрлись в лимит?</b> CC Deck сам предложит другой аккаунт. Уже открытую вкладку чата закройте — она работает под прежним аккаунтом.</li>
     </ol>
     <p style="margin-bottom:2px"><b>Клавиши</b></p>
     <div class="keys">
       <kbd>/</kbd><span>поиск</span>
       <kbd>↑ ↓</kbd><span>выбрать чат (или <kbd>j</kbd> <kbd>k</kbd>)</span>
       <kbd>Enter</kbd><span>открыть в VS Code</span>
       <kbd>Shift+Enter</kbd><span>открыть в терминале</span>
       <kbd>Ctrl+Enter</kbd><span>в поиске — искать в тексте переписки</span>
       <kbd>Esc</kbd><span>сбросить поиск / закрыть проект</span>
       <kbd>F5</kbd><span>обновить всё</span>
     </div>
     <p class="small">Версия ${esc(st.version)}. Номер версии слева вверху — проверка обновлений.</p>
     <div class="buttons"><button data-x class="primary">Понятно</button></div>`,
    (card, close) => (card.querySelector("[data-x]").onclick = close)
  );
}
$("#help").onclick = showHelp;

/* ================================================================== данные */
async function loadAccounts() {
  st.accounts = await call("get_accounts");
}

async function loadIntegration() {
  const [integ, claude] = await Promise.all([
    invoke("integration_status").catch(() => ({ editors: [] })),
    invoke("claude_status").catch(() => ({ found: true })),
  ]);
  st.integration = integ;
  st.claude = claude;
}

async function loadRuntime() {
  const r = await invoke("get_runtime").catch(() => null);
  if (!r) return false;
  const sig = (x) => JSON.stringify([x.running?.map((r) => r.session_id + r.account_id), x.bindings, x.chat_bindings, x.default_account, x.wrap_log?.[0]?.t]);
  const changed = sig(r) !== sig({ running: st.running, bindings: st.bindings, chat_bindings: st.chatBindings, default_account: st.defaultAccount, wrap_log: st.wrapLog });
  st.running = r.running;
  st.bindings = r.bindings;
  st.chatBindings = r.chat_bindings;
  st.defaultAccount = r.default_account;
  st.wrapLog = r.wrap_log;
  st.windows = r.windows;
  return changed;
}

async function loadSessions() {
  st.sessions = await call("list_sessions");
  st.loaded = true;
}

async function refreshAll() {
  await Promise.all([loadAccounts(), loadRuntime(), loadIntegration()]);
  render();
  await loadSessions();
  render();
}

function render() {
  renderAccounts();
  renderVscodeStatus();
  renderBanner();
  renderFilters();
  renderProjects();
  renderProjectBar();
  renderList();
}

/* ================================================================== аккаунты */
function meter(label, raw, resets) {
  const val = effUsage(raw, resets);
  if (val == null) return "";
  const wasReset = raw != null && val === 0 && raw !== 0;
  const cls = val >= LIMIT_WARN ? "high" : val >= 60 ? "mid" : "";
  return `<div class="meter-row"><span>${label}: ${Math.round(val)}%${val >= 100 ? " · исчерпан" : ""}</span>
            <span>${wasReset ? "окно сбросилось" : esc(untilText(resets))}</span></div>
          <div class="bar" role="img" aria-label="${label}: ${Math.round(val)}%"><i class="${cls}" style="width:${Math.min(100, val)}%"></i></div>`;
}

function usageFoot(a) {
  const u = a.usage;
  const busy = usageBusy.has(a.id);
  const btn = `<button class="link" data-usage="${a.id}" title="Узнать актуальные лимиты у Anthropic">${busy ? "проверяю…" : "⟳ обновить"}</button>`;
  if (!u?.fetched_ms) return `<div class="meter-foot"><span class="age">лимиты появятся после первой проверки</span>${btn}</div>`;
  const old = Date.now() - u.fetched_ms > 3600e3;
  const when = new Date(u.fetched_ms).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `<div class="meter-foot ${old ? "old" : ""}" title="${u.live ? "Данные с сервера Anthropic" : "Данные из кэша Claude Code"}">
    <span class="age">${old ? "данные от " + esc(when) : "обновлено " + esc(ago(u.fetched_ms))}</span>${btn}</div>`;
}

function renderAccounts() {
  $("#accounts").innerHTML = st.accounts.map((a) => {
    const u = a.usage;
    const live = st.running.filter((r) => runAccount(r).acc?.id === a.id).length;
    // «тот же аккаунт» — только по данным, проверенным по входу (общий .claude.json может врать)
    const dup = a.verified && a.account_uuid && st.accounts.find((x) => x.id !== a.id && x.verified && x.account_uuid === a.account_uuid);
    const hasUsage = u && (u.five_hour != null || u.seven_day != null);
    return `<div class="acc" role="listitem" style="--c:${a.color}">
      <div class="acc-head">
        <span class="acc-name">${esc(a.name)}</span>
        ${live ? `<button class="live-btn ${st.accFilter === a.id ? "on" : ""}" data-livefilter="${a.id}" title="Показать чаты, открытые сейчас под «${esc(a.name)}»"><span class="pulse">●</span> ${live} открыто</button>` : ""}
        <button class="icon-btn" data-edit="${a.id}" title="Настроить аккаунт" aria-label="Настроить аккаунт «${esc(a.name)}»">✎</button>
      </div>
      <div class="acc-sub" title="${esc(a.dir)}">${a.email ? esc(a.email) : a.logged_in ? "Вход выполнен" : "Нет входа"}${a.verified
        ? ` <span class="ok" title="Вход проверен у Anthropic" aria-label="вход проверен">✓</span>` : ""}</div>
      ${a.logged_in ? `<div class="meter">${hasUsage ? meter("5 ч", u.five_hour, u.five_hour_resets) + meter("Неделя", u.seven_day, u.seven_day_resets) : ""}${usageFoot(a)}</div>` : ""}
      ${dup ? `<div class="acc-warn">В «${esc(a.name)}» и «${esc(dup.name)}» вход под одним аккаунтом Claude.<br><button data-login="${a.id}">Войти заново</button></div>` : ""}
      ${!a.exists ? `<div class="acc-warn">Папка аккаунта не найдена: <code>${esc(a.dir)}</code>. Уберите аккаунт или войдите заново.</div>` : ""}
      ${a.exists && !a.shared_ok ? `<div class="acc-warn">Этот аккаунт не видит общих чатов.<br><button data-repair="${a.id}">Исправить</button></div>` : ""}
      ${!a.logged_in ? `<div class="acc-actions"><button class="primary" data-login="${a.id}">Войти</button></div>` : ""}
    </div>`;
  }).join("");
}

$("#accounts").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.usage) await refreshUsage(b.dataset.usage);
  else if (b.dataset.login) await loginFlow(b.dataset.login);
  else if (b.dataset.repair) {
    const rep = await call("repair_account", { id: b.dataset.repair });
    showReport("Общие чаты подключены", rep);
    refreshAll();
  } else if (b.dataset.edit) editAccount(accById(b.dataset.edit));
  else if (b.dataset.livefilter) {
    st.accFilter = st.accFilter === b.dataset.livefilter ? null : b.dataset.livefilter;
    render();
  }
});

/** Открыть вход и дождаться, пока он выполнится. */
async function loginFlow(id) {
  const a = accById(id);
  const before = { logged_in: a?.logged_in, verified: a?.verified };
  await call("login", { accountId: id });
  toast(`Открыт терминал — войдите в аккаунт «${a?.name}». CC Deck подхватит вход сам.`);
  waitFor(async () => {
    await loadAccounts();
    const now = accById(id);
    // вход появился, или сменился (проверенный профиль сбросился из-за новых данных входа)
    return now && ((!before.logged_in && now.logged_in) || (before.verified && !now.verified));
  }, async () => {
    await refreshUsage(id, true);
    toast(`Вход в «${accById(id)?.name}» выполнен ✓${accById(id)?.email ? " — " + accById(id).email : ""}`);
    render();
  });
}

const usageBusy = new Set();

/** Спросить лимиты у сервера для аккаунта. silent — без сообщений. */
async function refreshUsage(id, silent = false) {
  if (usageBusy.has(id)) return;
  usageBusy.add(id);
  renderAccounts();
  try {
    const u = await invoke("refresh_usage", { accountId: id });
    await loadAccounts();
    const a = accById(id);
    if (a) a.usage = u;
    if (!silent) {
      const fh = Math.round(effUsage(u.five_hour, u.five_hour_resets) ?? 0);
      const sd = Math.round(effUsage(u.seven_day, u.seven_day_resets) ?? 0);
      toast(`${a?.name}: 5 ч — ${fh}%, неделя — ${sd}%${Math.max(fh, sd) >= 100 ? " · лимит исчерпан" : ""}`);
    }
  } catch (e) {
    if (!silent) toast(`${accById(id)?.name}: ${e}`, true);
  } finally {
    usageBusy.delete(id);
    renderAccounts();
    renderList();
  }
}

function colorPicker(sel) {
  return `<div class="colors" role="group" aria-label="Цвет">${COLORS.map((c, i) =>
    `<button type="button" data-c="${c}" aria-pressed="${c === sel}" aria-label="${COLOR_NAMES[i]}" title="${COLOR_NAMES[i]}" style="--c:${c}"></button>`).join("")}</div>`;
}
function bindColors(card, onPick) {
  card.querySelectorAll(".colors button").forEach((b) => {
    b.onclick = () => {
      card.querySelectorAll(".colors button").forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      onPick(b.dataset.c);
    };
  });
}

function showReport(title, lines) {
  modal(
    `<h3>${esc(title)}</h3><details><summary>Подробнее</summary><ul class="report">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></details>
     <div class="buttons"><button data-x class="primary">Готово</button></div>`,
    (card, close) => (card.querySelector("[data-x]").onclick = close)
  );
}

async function addAccount() {
  const dir = await call("suggest_dir", { name: "Личный" });
  const used = new Set(st.accounts.map((a) => a.color));
  let color = COLORS.find((c) => !used.has(c)) || COLORS[1];
  const main = st.accounts.find((a) => a.is_default);
  modal(
    `<h3>Новый аккаунт</h3>
     <p>В основном аккаунте сейчас вход как <b>${esc(main?.email || "—")}</b>. Добавьте сюда <b>другой</b> аккаунт Claude.
        Чаты, проекты, память, скиллы и настройки будут общими — отдельным будет только вход.</p>
     <label for="f-name">Название</label><input type="text" id="f-name" value="Личный">
     <label>Цвет</label>${colorPicker(color)}
     <details><summary>Дополнительно</summary>
       <label for="f-dir">Папка для входа (<code>CLAUDE_CONFIG_DIR</code>)</label><input type="text" id="f-dir" value="${esc(dir)}">
     </details>
     <div class="buttons"><button data-x>Отмена</button><button data-ok class="primary">Создать</button></div>`,
    (card, close) => {
      bindColors(card, (c) => (color = c));
      let dirTouched = false;
      card.querySelector("#f-dir").oninput = () => (dirTouched = true);
      card.querySelector("#f-name").oninput = async (e) => {
        if (!dirTouched) card.querySelector("#f-dir").value = await invoke("suggest_dir", { name: e.target.value });
      };
      card.querySelector("[data-x]").onclick = close;
      card.querySelector("[data-ok]").onclick = async () => {
        const name = card.querySelector("#f-name").value.trim() || "Личный";
        const rep = await call("add_account", { name, dir: card.querySelector("#f-dir").value, color });
        close();
        await refreshAll();
        const acc = st.accounts[st.accounts.length - 1];
        const r = await choose(`Аккаунт «${name}» создан`,
          `<p>Осталось войти. Откроется терминал — войдите <b>другим</b> аккаунтом Claude, не тем, что в «${esc(main?.name || "")}».</p>
           <details><summary>Подробнее</summary><ul class="report">${rep.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></details>`,
          [{ label: "Позже", value: false }, { label: "Войти", value: true, cls: "primary" }]);
        if (r) loginFlow(acc.id);
      };
    }
  );
}

function editAccount(a) {
  let color = a.color;
  const isDefault = a.id === st.defaultAccount;
  modal(
    `<h3>${esc(a.name)}</h3>
     <p>${esc(a.email || "Нет входа")}${a.verified ? " ✓" : ""}<br><span class="small">Папка: <code>${esc(a.dir)}</code></span></p>
     <label for="f-name">Название</label><input type="text" id="f-name" value="${esc(a.name)}">
     <label>Цвет</label>${colorPicker(color)}
     <label class="check"><input type="checkbox" id="f-def" ${isDefault ? "checked disabled" : ""}>
       ${isDefault ? "Основной аккаунт" : "Сделать основным"} — под ним открываются чаты и проекты, для которых аккаунт не выбран</label>
     <div class="buttons">
       ${a.is_default ? "" : `<button data-rm class="danger" style="margin-right:auto">Убрать аккаунт</button>`}
       <button data-login>Войти заново</button>
       <button data-x>Отмена</button><button data-ok class="primary">Сохранить</button>
     </div>`,
    (card, close) => {
      bindColors(card, (c) => (color = c));
      card.querySelector("[data-x]").onclick = close;
      card.querySelector("[data-login]").onclick = () => { close(); loginFlow(a.id); };
      card.querySelector("[data-ok]").onclick = async () => {
        await call("update_account", { id: a.id, name: card.querySelector("#f-name").value, color });
        if (card.querySelector("#f-def").checked && !isDefault) await call("set_default_account", { id: a.id });
        close();
        refreshAll();
      };
      const rm = card.querySelector("[data-rm]");
      if (rm) rm.onclick = async () => {
        close();
        const ok = await choose("Убрать аккаунт?",
          `<p>«${esc(a.name)}» пропадёт из списка, его чаты и проекты перейдут на основной аккаунт. Папка <code>${esc(a.dir)}</code> и вход в ней останутся на диске.</p>`,
          [{ label: "Отмена", value: false }, { label: "Убрать", value: true, cls: "danger" }]);
        if (!ok) return;
        await call("remove_account", { id: a.id });
        refreshAll();
      };
    }
  );
}

$("#add-account").onclick = addAccount;

/* ================================================================== VS Code и первый запуск */
function renderVscodeStatus() {
  const el = $("#vscode-status");
  if (!connected()) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="vs-line"><span class="ok">✓</span> VS Code: аккаунт выбирается по чату и проекту
      <button class="link" id="vs-disconnect">отключить</button></div>`
    + (st.claude.source === "vscode" ? `<div class="vs-line" title="${esc(st.claude.path || "")}">Claude Code: из расширения VS Code</div>` : "");
}

/** Шаги первого запуска: что уже сделано и что дальше. */
function setupSteps() {
  const others = st.accounts.filter((a) => !a.is_default);
  const notLogged = st.accounts.find((a) => !a.logged_in);
  const steps = [
    { done: st.claude.found, text: "Claude Code установлен", btn: `<button class="primary" id="claude-install">Установить Claude Code</button>` },
    { done: others.length > 0, text: "Второй аккаунт добавлен", why: "без него переключаться не на что", btn: `<button class="primary" data-step="add">Добавить аккаунт</button>` },
    { done: !notLogged, text: notLogged ? `Вход в «${notLogged.name}»` : "Вход во все аккаунты выполнен", btn: notLogged ? `<button class="primary" data-login-step="${notLogged.id}">Войти</button>` : "" },
  ];
  if (hasEditor()) steps.push({ done: connected(), text: "VS Code настроен", why: "чтобы чаты открывались под нужным аккаунтом", btn: `<button class="primary" id="vs-connect">Настроить VS Code</button>` });
  return steps;
}

function renderBanner() {
  const b = $("#banner");
  const steps = setupSteps();
  const left = steps.filter((s) => !s.done);
  const show = left.length && (!st.claude.found || store.get("ccdeck-setup-hidden") !== "1");
  b.hidden = !show;
  if (!show) return;
  const first = steps.findIndex((s) => !s.done);
  b.innerHTML = `<div class="b-head"><b>Настройка: осталось ${left.length} из ${steps.length}</b>
      ${st.claude.found ? `<button class="link" id="setup-hide">скрыть</button>` : ""}</div>
    <ul class="steps-list">${steps.map((s, i) => `<li class="${s.done ? "done" : ""}">
        <span class="mark" aria-hidden="true">${s.done ? "✓" : "○"}</span>
        <span>${esc(s.text)}${!s.done && s.why ? ` <span class="why">— ${esc(s.why)}</span>` : ""}</span>
        ${i === first ? s.btn : ""}</li>`).join("")}</ul>`;
}

async function connectFlow() {
  await call("connect_editors");
  await loadIntegration();
  render();
  toast("VS Code настроен ✓ Чаты будут открываться под выбранным аккаунтом.");
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("#claude-install")) {
    await call("install_claude");
    toast("Установка идёт в терминале. Когда закончится, CC Deck это увидит.");
    waitFor(async () => { await loadIntegration(); return st.claude.found; }, () => { render(); toast("Claude Code установлен ✓"); }, 600000);
  } else if (e.target.closest("#vs-connect")) {
    await connectFlow();
  } else if (e.target.closest("#setup-hide")) {
    store.set("ccdeck-setup-hidden", "1");
    renderBanner();
  } else if (e.target.closest("[data-step=add]")) {
    addAccount();
  } else if (e.target.closest("[data-login-step]")) {
    loginFlow(e.target.closest("[data-login-step]").dataset.loginStep);
  } else if (e.target.closest("#vs-disconnect")) {
    const ok = await choose("Отключить VS Code?",
      `<p>VS Code перестанет учитывать выбор аккаунта: все чаты в нём будут под тем аккаунтом, в который выполнен вход в основном аккаунте.</p>`,
      [{ label: "Отмена", value: false }, { label: "Отключить", value: true, cls: "danger" }]);
    if (!ok) return;
    await call("disconnect_editors");
    await loadIntegration();
    render();
  }
});

/* ================================================================== смена аккаунта */
async function setProjectAccount(path, accId) {
  // основной аккаунт = просто снять привязку
  await call("set_binding", { path, accountId: accId === st.defaultAccount ? null : accId });
  await loadRuntime();
  render();
}

async function setChatAccount(s, accId) {
  // совпадает с аккаунтом проекта — отдельный выбор не нужен
  const same = accId === projectAccount(s.cwd).acc.id;
  await call("set_chat_account", { sessionId: s.id, accountId: same ? null : accId });
  await loadRuntime();
  render();
}

function accItems(kind, currentId) {
  return st.accounts.map((a) => {
    const peak = usagePeak(a);
    return `<button role="menuitem" data-kind="${kind}" data-acc="${a.id}">
      <span class="dot" style="--c:${a.color}"></span>${esc(a.name)}
      ${peak != null ? `<span class="pct" title="Израсходовано лимита">${Math.round(peak)}%</span>` : ""}
      ${a.id === currentId ? `<span class="check-mark" aria-label="выбран">✓</span>` : ""}</button>`;
  }).join("");
}

/** Меню метки чата: аккаунт этого чата + возврат «как у проекта» + переход к аккаунту проекта. */
function chatAccountMenu(s, x, y) {
  const { acc, source } = chatAccount(s);
  const proj = projectAccount(s.cwd).acc;
  openMenu(
    `<div class="menu-head">Открывать этот чат под:</div>${accItems("chat", acc.id)}
     ${source === "chat" ? `<hr><button role="menuitem" data-kind="reset">↩ Как у проекта (${esc(proj.name)})</button>` : ""}
     <hr><button role="menuitem" data-kind="project">Изменить аккаунт всего проекта «${esc(baseName(s.cwd))}»…</button>`,
    x, y,
    async (b) => {
      const k = b.dataset.kind;
      if (k === "chat") {
        if (b.dataset.acc === acc.id) return;
        await setChatAccount(s, b.dataset.acc);
        toast(`Чат будет открываться под «${accById(b.dataset.acc)?.name}»`);
      } else if (k === "reset") {
        await call("set_chat_account", { sessionId: s.id, accountId: null });
        await loadRuntime();
        render();
        toast(`Чат снова открывается как проект — под «${proj.name}»`);
      } else if (k === "project") {
        projectAccountMenu(s.cwd, x, y);
      }
    }
  );
}

function projectAccountMenu(path, x, y) {
  const { acc } = projectAccount(path);
  openMenu(
    `<div class="menu-head">Проект «${esc(baseName(path))}» открывать под:</div>${accItems("project", acc.id)}
     <div class="menu-note">Действует на все чаты проекта, кроме тех, где аккаунт выбран отдельно.</div>`,
    x, y,
    async (b) => {
      if (!b.dataset.acc || b.dataset.acc === acc.id) return;
      await setProjectAccount(path, b.dataset.acc);
      toast(`Проект «${baseName(path)}» теперь открывается под «${accById(b.dataset.acc)?.name}»`);
    }
  );
}

function chip(acc, source, attrs) {
  const label = SOURCE_LABEL[source] || "";
  const why = source ? `Откроется под «${acc?.name}» — ${SOURCE_WHY[source]}. Нажмите, чтобы сменить.` : "Нажмите, чтобы сменить";
  return `<button class="chip ${source === "chat" ? "own" : ""}" style="--c:${acc?.color}" ${attrs} title="${esc(why)}" aria-label="${esc(why)}" aria-haspopup="menu">
    <span class="dot"></span>${esc(acc?.name || "")}${label ? `<span class="src">· ${label}</span>` : ""}<span class="caret">▾</span></button>`;
}

/* ================================================================== открыть чат */
/** Проверки перед запуском: свежие лимиты, лимит, уже открытая вкладка. Возвращает аккаунт или false. */
async function preflight(s, path) {
  let acc = s ? chatAccount(s).acc : projectAccount(path).acc;
  // лимиты устарели — тихо проверить (сервер сам не даст спрашивать чаще раза в минуту)
  if (acc.logged_in && (!acc.usage?.fetched_ms || Date.now() - acc.usage.fetched_ms > USAGE_STALE_MS)) {
    await refreshUsage(acc.id, true);
    acc = accById(acc.id) || acc;
  }
  const peak = usagePeak(acc);
  if (peak != null && peak >= LIMIT_OFFER && st.accounts.length > 1) {
    const others = st.accounts.filter((a) => a.id !== acc.id && a.logged_in);
    const alt = others.sort((a, b) => (usagePeak(a) ?? 0) - (usagePeak(b) ?? 0))[0];
    const altPeak = alt ? usagePeak(alt) ?? 0 : null;
    if (alt && altPeak >= LIMIT_OFFER) {
      const ok = await choose("Лимит почти исчерпан у обоих аккаунтов",
        `<p>«${esc(acc.name)}» — ${Math.round(peak)}%, ${esc(untilText(peakResets(acc)))}.<br>«${esc(alt.name)}» — ${Math.round(altPeak)}%, ${esc(untilText(peakResets(alt)))}.</p>`,
        [{ label: "Отмена", value: false }, { label: `Открыть под «${acc.name}»`, value: true, cls: "primary" }]);
      if (!ok) return false;
    } else if (alt) {
      const r = await choose(`У «${acc.name}» израсходовано ${Math.round(peak)}%`,
        `<p>Лимит ${esc(untilText(peakResets(acc)))}. У «${esc(alt.name)}» — ${Math.round(altPeak)}%.</p>
         <p>${s ? "Продолжить этот чат" : "Начать чат"} под «${esc(alt.name)}»? Переписка сохранится.</p>`,
        [{ label: "Отмена", value: null }, { label: `Оставить «${acc.name}»`, value: "keep" },
         { label: `Открыть под «${alt.name}»`, value: "switch", cls: "primary" }],
        s ? `Чат запомнит «${esc(alt.name)}». Вернуть можно в метке аккаунта у чата.`
          : `Проект запомнит «${esc(alt.name)}» — новые чаты тоже пойдут под ним.`);
      if (!r) return false;
      if (r === "switch") {
        if (s) await setChatAccount(s, alt.id);
        else await setProjectAccount(path, alt.id);
        acc = alt;
      }
    }
  }
  const run = s && st.running.find((r) => r.session_id === s.id);
  const runAcc = run && runAccount(run);
  if (run && runAcc.acc?.id !== acc.id) {
    const r = await choose("Чат уже открыт",
      `<p>Этот чат сейчас идёт под «${esc(runName(runAcc))}». Чтобы он продолжился под «${esc(acc.name)}», закройте его вкладку в VS Code (или окно терминала) и нажмите «Открыть» ещё раз.</p>`,
      [{ label: "Понятно, закрою вкладку", value: false }, { label: `Перейти к вкладке (останется «${runName(runAcc)}»)`, value: true }]);
    if (!r) return false;
  }
  return acc;
}

async function ensureConnected() {
  if (connected() || !hasEditor()) return true;
  const r = await choose("Сначала настроить VS Code?",
    `<p>Без этого VS Code не знает, какой аккаунт вы выбрали, и откроет чат под основным аккаунтом.</p>`,
    [{ label: "Отмена", value: null }, { label: "Открыть так", value: "skip" },
     { label: "Настроить и открыть", value: "connect", cls: "primary" }]);
  if (!r) return false;
  if (r === "connect") await connectFlow();
  return true;
}

async function openChat(s) {
  if (!hasEditor()) return openTerminal(s);
  if (!(await ensureConnected())) return;
  const acc = await preflight(s);
  if (!acc) return;
  await call("open_chat", { folder: s.cwd, sessionId: s.id });
  toast(`Открываю чат в VS Code под «${acc.name}»`);
}

async function openTerminal(s) {
  const acc = await preflight(s);
  if (!acc) return;
  await call("resume_session", { sessionId: s.id, accountId: acc.id });
  toast(`Чат открыт в терминале под «${acc.name}»`);
}

async function newChat(path, where) {
  if (where === "editor" && !(await ensureConnected())) return;
  const acc = await preflight(null, path);
  if (!acc) return;
  if (where === "editor") await call("open_chat", { folder: path, sessionId: null });
  else await call("new_session", { cwd: path, accountId: acc.id, continueLast: false });
  toast(`Новый чат под «${acc.name}»`);
}

/** «VS Code ▸» у проекта: выбрать аккаунт (проект его запомнит) и открыть папку. */
function openProjectMenu(path, x, y) {
  const { acc } = projectAccount(path);
  openMenu(
    `<div class="menu-head">Открыть «${esc(baseName(path))}» в VS Code под:</div>${accItems("open", acc.id)}
     <div class="menu-note">Проект запомнит этот аккаунт — новые чаты тоже пойдут под ним. Все прежние чаты останутся.</div>`,
    x, y,
    async (b) => { if (b.dataset.acc) await openProject(path, b.dataset.acc); }
  );
}

async function openProject(path, accId) {
  if (!(await ensureConnected())) return;
  const changed = accId !== projectAccount(path).acc.id;
  if (changed) await setProjectAccount(path, accId);
  const acc = accById(accId);
  const p = normPath(path);
  const stale = st.running.filter((r) => {
    const s = st.sessions.find((x) => x.id === r.session_id);
    return s && normPath(s.cwd) === p && runAccount(r).acc?.id !== accId;
  }).length;
  const ed = await call("open_project", { folder: path });
  toast(`«${baseName(path)}» открыт в ${ed} под «${acc?.name}».${changed ? " Теперь это аккаунт проекта." : ""}`
    + (stale ? ` Уже открытые вкладки чатов (${stale}) работают под прежним аккаунтом — закройте их и откройте заново.` : ""));
}

/* ================================================================== проекты */
function projectsOf(list) {
  const map = new Map();
  for (const s of list) {
    if (!s.cwd) continue;
    const k = normPath(s.cwd);
    const p = map.get(k) || { cwd: s.cwd, n: 0, last: 0, exists: s.cwd_exists };
    p.n++;
    p.last = Math.max(p.last, s.modified_ms);
    map.set(k, p);
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}

function renderProjects() {
  if (!st.loaded) { $("#projects").innerHTML = `<div class="muted small" style="padding:4px 8px">Загружаю…</div>`; return; }
  let ps = projectsOf(st.sessions);
  if (st.hideMissing) ps = ps.filter((p) => p.exists);
  const cur = st.project && normPath(st.project);
  $("#projects").innerHTML = ps.map((p) => {
    const { acc, bound } = projectAccount(p.cwd);
    return `<div class="proj ${cur === normPath(p.cwd) ? "active" : ""}" role="listitem" tabindex="0" data-cwd="${esc(p.cwd)}"
        aria-label="Проект ${esc(baseName(p.cwd))}, чатов: ${p.n}${bound ? ", аккаунт " + esc(acc.name) : ""}">
      <span class="pname" title="${esc(p.cwd)}">${esc(baseName(p.cwd))}</span>
      ${bound ? `<span class="pacc" title="Аккаунт проекта"><span class="dot" style="--c:${acc.color}"></span>${esc(acc.name)}</span>` : ""}
      <span class="n" aria-hidden="true">${p.n}</span>
      ${p.exists && hasEditor() ? `<button class="proj-open" data-open-proj="${esc(p.cwd)}" aria-haspopup="menu"
          title="Открыть проект в VS Code под выбранным аккаунтом">VS Code ▸</button>` : ""}</div>`;
  }).join("") || `<div class="muted small" style="padding:4px 8px">Проектов пока нет</div>`;
}

function toggleProject(cwd) {
  st.project = st.project && normPath(st.project) === normPath(cwd) ? null : cwd;
  render();
  $(`.proj[data-cwd="${CSS.escape(cwd)}"]`)?.focus();
}

$("#projects").addEventListener("click", (e) => {
  const ob = e.target.closest("[data-open-proj]");
  if (ob) {
    const r = ob.getBoundingClientRect();
    return openProjectMenu(ob.dataset.openProj, r.left, r.bottom + 4);
  }
  const el = e.target.closest(".proj");
  if (el) toggleProject(el.dataset.cwd);
});
$("#projects").addEventListener("keydown", (e) => {
  const el = e.target.closest(".proj");
  if (!el || e.target !== el) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleProject(el.dataset.cwd); }
  else if (e.key === "ArrowDown") { e.preventDefault(); el.nextElementSibling?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); el.previousElementSibling?.focus(); }
});

function renderProjectBar() {
  const bar = $("#project-bar");
  if (!st.project) { bar.hidden = true; return; }
  bar.hidden = false;
  const { acc, bound } = projectAccount(st.project);
  const ed = hasEditor();
  bar.innerHTML = `
    <div class="pb-row">
      <span class="path" title="${esc(st.project)}"><b>${esc(baseName(st.project))}</b><span class="muted"> ${esc(st.project)}</span></span>
      <button class="icon-btn" data-open title="Открыть папку" aria-label="Открыть папку проекта">📂</button>
      <button class="icon-btn" data-clear title="Все проекты (Esc)" aria-label="Закрыть проект, показать все">✕</button>
    </div>
    <div class="pb-row">
      <span class="muted">Аккаунт проекта:</span>
      ${chip(acc, bound ? "project" : "default", "data-projchip")}
      <span class="spacer"></span>
      ${ed ? `<button class="primary" data-openproj>Открыть проект в VS Code</button>` : ""}
      <button data-newmenu aria-haspopup="menu">Новый чат ▾</button>
    </div>`;
}

$("#project-bar").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const r = b.getBoundingClientRect();
  if (b.dataset.clear != null) { st.project = null; render(); }
  else if (b.dataset.open != null) call("reveal", { path: st.project });
  else if (b.dataset.projchip != null) projectAccountMenu(st.project, r.left, r.bottom + 4);
  else if (b.dataset.openproj != null) openProject(st.project, projectAccount(st.project).acc.id);
  else if (b.dataset.newmenu != null) {
    const path = st.project;
    openMenu(`${hasEditor() ? `<button role="menuitem" data-w="editor">В VS Code</button>` : ""}
              <button role="menuitem" data-w="term">В терминале</button>`, r.left, r.bottom + 4, (x) => newChat(path, x.dataset.w));
  }
});

/* ================================================================== фильтры и список чатов */
function renderFilters() {
  document.querySelectorAll(".seg[data-show]").forEach((b) => {
    b.classList.toggle("on", b.dataset.show === st.show);
    b.setAttribute("aria-pressed", b.dataset.show === st.show);
  });
  const a = st.accFilter && accById(st.accFilter);
  $("#acc-filter").innerHTML = a
    ? `<button class="filter-chip" style="--c:${a.color}" data-clear-acc title="Сбросить фильтр">открытые под «${esc(a.name)}» <span aria-hidden="true">×</span></button>`
    : "";
}
document.querySelector(".segs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-show]");
  if (!b) return;
  st.show = b.dataset.show;
  if (st.show === "all") st.accFilter = null;
  render();
});
$("#acc-filter").addEventListener("click", (e) => {
  if (e.target.closest("[data-clear-acc]")) { st.accFilter = null; render(); }
});

function filtered() {
  const q = st.q.trim().toLowerCase();
  const proj = st.project && normPath(st.project);
  const runMap = new Map(st.running.map((r) => [r.session_id, r]));
  let hidden = 0;
  const list = st.sessions.filter((s) => {
    if (st.hideMissing && !s.cwd_exists) { hidden++; return false; }
    if (proj && normPath(s.cwd) !== proj) return false;
    if (st.show === "open" || st.accFilter) {
      const r = runMap.get(s.id);
      if (!r) return false;
      if (st.accFilter && runAccount(r).acc?.id !== st.accFilter) return false;
    }
    if (st.deepIds) return st.deepIds.has(s.id);
    if (!q) return true;
    return [s.title, s.first_prompt, s.last_prompt, s.cwd, s.git_branch, s.id, chatAccount(s).acc?.name]
      .some((x) => x && x.toLowerCase().includes(q));
  });
  return { list, hidden };
}

const LIMIT = 300;

function emptyState() {
  if (!st.loaded) return `<div class="empty">Загружаю чаты…</div>`;
  if (!st.sessions.length) return `<div class="empty">Чатов пока нет.<br>Начните чат в VS Code или терминале — он появится здесь.</div>`;
  if (st.show === "open" || st.accFilter) return `<div class="empty">Сейчас нет открытых чатов${st.accFilter ? ` под «${esc(accById(st.accFilter)?.name)}»` : ""}.</div>`;
  if (st.q.trim() && !st.deepIds) {
    return `<div class="empty">В названиях, запросах и путях ничего нет по «${esc(st.q.trim())}».<br>
      <button class="primary" data-deep-now>Искать в тексте переписки</button></div>`;
  }
  return `<div class="empty">Ничего не найдено.</div>`;
}

function renderList() {
  const { list, hidden } = filtered();
  const runMap = new Map(st.running.map((r) => [r.session_id, r]));
  const ed = hasEditor();
  const selId = document.querySelector(".row.sel")?.dataset.id;

  let head = "";
  if (st.deepIds) {
    head = `<div class="list-note">Найдено в переписке по «${esc(st.deepQuery)}»: ${st.deepIds.size}
      · <button class="link" id="clear-deep">сбросить</button></div>`;
  }

  if (!list.length) {
    $("#list").innerHTML = head + emptyState();
  } else {
    $("#list").innerHTML = head + list.slice(0, LIMIT).map((s) => {
      const title = s.title || s.first_prompt || s.id;
      const prompt = s.last_prompt && s.last_prompt !== title ? s.last_prompt : s.title ? s.first_prompt : null;
      const run = runMap.get(s.id);
      const runAcc = run && runAccount(run);
      const desk = s.entrypoint === "claude-desktop" ? recordedAccount(s) : null;
      const { acc, source } = chatAccount(s);
      const peak = usagePeak(acc);
      const warn = peak != null && peak >= LIMIT_WARN && s.cwd_exists
        ? `<span class="badge warn">${peak >= 100 ? `у «${esc(acc.name)}» лимит исчерпан` : `у «${esc(acc.name)}» осталось ${Math.max(0, 100 - Math.round(peak))}%`}</span>` : "";
      return `<div class="row ${s.id === selId ? "sel" : ""}" role="listitem" data-id="${s.id}" style="--c:${acc?.color}">
        <div class="title" title="${esc(title)}">${hl(title)}</div>
        <div class="actions">
          ${s.cwd_exists ? `${chip(acc, source, "data-chip")}
            <button class="go" data-go title="${ed ? "Открыть в VS Code (Enter)" : "Открыть в терминале (Enter)"}">Открыть</button>` : ""}
          <button class="icon-btn" data-more title="Ещё" aria-label="Ещё действия с чатом" aria-haspopup="menu">⋯</button>
        </div>
        <div class="meta">
          <a href="#" data-proj="${esc(s.cwd || "")}" title="${esc(s.cwd || "")}">${hl(baseName(s.cwd))}</a>
          <span title="${new Date(s.modified_ms).toLocaleString("ru-RU")}">${ago(s.modified_ms)}</span>
          ${s.git_branch ? `<span>⎇ ${hl(s.git_branch)}</span>` : ""}
          ${run ? `<span class="badge live" title="Чат сейчас открыт${run.entrypoint === "claude-desktop" ? " в приложении Claude" : ""}"><span class="pulse">●</span> открыт · ${esc(runName(runAcc))}</span>` : ""}
          ${!run && desk ? `<span class="badge" title="Чат из приложения Claude; под этим аккаунтом он шёл последний раз">приложение Claude · ${esc(runName(desk))}</span>` : ""}
          ${warn}
          ${!s.cwd_exists ? `<span class="badge missing">папки проекта нет</span>` : ""}
        </div>
        ${prompt ? `<div class="prompt" title="${esc(prompt)}">${hl(prompt)}</div>` : ""}
      </div>`;
    }).join("") + (list.length > LIMIT ? `<div class="empty">Показаны первые ${LIMIT} из ${list.length}. Уточните поиск.</div>` : "");
  }
  const total = st.sessions.length - hidden;
  const shown = list.length === total ? `${total} чатов` : `${list.length} из ${total}`;
  $("#count").innerHTML = !st.loaded ? "загрузка…"
    : esc(shown) + (hidden && st.hideMissing ? ` · <button class="link" id="show-hidden" title="Показать чаты удалённых проектов">${hidden} скрыто</button>` : "");
}

$("#list").addEventListener("click", (e) => {
  if (e.target.closest("#clear-deep")) return clearDeep();
  if (e.target.closest("[data-deep-now]")) return deepSearch();
  const s = sessionOf(e.target);
  if (!s) return;
  const b = e.target.closest("button, a");
  if (!b) return selectRow(e.target.closest(".row"));
  e.preventDefault();
  const r = b.getBoundingClientRect();
  if (b.dataset.chip != null) { b.setAttribute("aria-expanded", "true"); chatAccountMenu(s, r.left, r.bottom + 4); }
  else if (b.dataset.go != null) openChat(s);
  else if (b.dataset.more != null) sessionMenu(s, r.right - 260, r.bottom + 4);
  else if (b.dataset.proj) { st.project = b.dataset.proj; render(); }
});
$("#count").addEventListener("click", (e) => {
  if (e.target.closest("#show-hidden")) { st.hideMissing = false; $("#hide-missing").checked = false; render(); }
});
$("#list").addEventListener("dblclick", (e) => {
  const s = sessionOf(e.target);
  if (s && s.cwd_exists && !e.target.closest("button, a")) openChat(s);
});
$("#list").addEventListener("contextmenu", (e) => {
  const s = sessionOf(e.target);
  if (!s) return;
  e.preventDefault();
  sessionMenu(s, e.clientX, e.clientY);
});

/* ================================================================== меню */
let menuReturn = null;
let menuOpener = null;   // кнопка, которая открыла меню
let skipOpen = false;    // повторный клик по той же кнопке — закрыть, а не открыть снова
function openMenu(html, x, y, onPick) {
  if (skipOpen) { skipOpen = false; return; }
  closeMenu(false);
  menuReturn = document.activeElement;
  menuOpener = document.activeElement?.closest?.("[aria-haspopup=menu]") || null;
  const m = document.createElement("div");
  m.className = "menu";
  m.id = "ctx";
  m.setAttribute("role", "menu");
  m.innerHTML = html;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
  m.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    closeMenu(true);
    onPick(b);
  };
  m.onkeydown = (e) => {
    const items = [...m.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); closeMenu(true); }
  };
  m.querySelector("button")?.focus();
}
function closeMenu(returnFocus = true) {
  const m = $("#ctx");
  if (!m) return;
  document.querySelectorAll("[aria-expanded=true]").forEach((x) => x.setAttribute("aria-expanded", "false"));
  // плавно гасим и убираем; id снимаем сразу, чтобы меню считалось закрытым
  m.id = "";
  m.classList.add("closing");
  m.style.pointerEvents = "none";
  setTimeout(() => m.remove(), 130);
  if (returnFocus) menuReturn?.focus?.();
  menuReturn = null;
  menuOpener = null;
}
document.addEventListener("mousedown", (e) => {
  skipOpen = false;
  if (e.target.closest("#ctx")) return;
  const trigger = e.target.closest("[aria-haspopup=menu]");
  if ($("#ctx") && trigger && trigger === menuOpener) {
    // клик по кнопке уже открытого меню — закрываем его, следующий click не откроет заново
    skipOpen = true;
    closeMenu(false);
    return;
  }
  if (!trigger) closeMenu(false);
});

function sessionMenu(s, x, y) {
  const ed = hasEditor();
  openMenu(`
    ${s.cwd_exists && ed ? `<button role="menuitem" data-a="ed">Открыть в VS Code</button>` : ""}
    ${s.cwd_exists ? `<button role="menuitem" data-a="term">Открыть в терминале</button>` : ""}
    ${s.cwd_exists ? `<hr>` : ""}
    ${s.cwd ? `<button role="menuitem" data-a="proj">Все чаты проекта «${esc(baseName(s.cwd))}»</button>
               <button role="menuitem" data-a="open">Открыть папку проекта</button>` : ""}
    <button role="menuitem" data-a="cmd">Скопировать команду для терминала</button>
    <hr><button role="menuitem" data-a="del" class="danger">Удалить чат…</button>`,
    x, y,
    async (b) => {
      const a = b.dataset.a;
      if (a === "ed") openChat(s);
      if (a === "term") openTerminal(s);
      if (a === "proj") { st.project = s.cwd; render(); }
      if (a === "open") call("reveal", { path: s.cwd });
      if (a === "cmd") { await navigator.clipboard.writeText(`claude --resume ${s.id}`); toast("Скопировано: claude --resume …"); }
      if (a === "del") {
        const ok = await choose("Удалить чат?",
          `<p>«${esc(s.title || s.first_prompt || s.id)}» будет перемещён в корзину. Восстановить можно оттуда.</p>`,
          [{ label: "Отмена", value: false }, { label: "В корзину", value: true, cls: "danger" }]);
        if (!ok) return;
        await call("delete_session", { sessionId: s.id });
        st.sessions = st.sessions.filter((x) => x.id !== s.id);
        render();
        toast("Чат перемещён в корзину");
      }
    }
  );
}

const sessionOf = (el) => {
  const row = el?.closest?.(".row");
  return row && st.sessions.find((x) => x.id === row.dataset.id);
};

/* выделение строки и клавиатура */
function selectRow(row) {
  document.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
  if (row) { row.classList.add("sel"); row.scrollIntoView({ block: "nearest" }); }
}
function moveSel(d) {
  const rows = [...document.querySelectorAll(".row")];
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.classList.contains("sel"));
  selectRow(rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))]);
}

/* ================================================================== поиск */
let qTimer;
$("#q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { st.q = e.target.value; st.deepIds = null; renderList(); }, 120);
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); deepSearch(); }
  else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); e.target.blur(); moveSel(e.key === "Enter" ? 0 : 1); }
});

async function deepSearch() {
  const q = $("#q").value.trim();
  if (!q) { $("#q").focus(); return toast("Введите текст, который нужно найти в переписке"); }
  const b = $("#deep");
  b.disabled = true;
  b.textContent = "Ищу…";
  try {
    st.deepIds = new Set(await call("search_sessions", { query: q }));
    st.deepQuery = q;
    st.q = q;
    renderList();
  } finally {
    b.disabled = false;
    b.textContent = "Искать в переписке";
  }
}
function clearDeep() { st.deepIds = null; renderList(); }
$("#deep").onclick = deepSearch;

$("#hide-missing").onchange = (e) => { st.hideMissing = e.target.checked; render(); };

async function refreshEverything() {
  await refreshAll();
  for (const a of st.accounts.filter((x) => x.logged_in)) await refreshUsage(a.id, true);
}
$("#refresh").onclick = refreshEverything;

document.addEventListener("keydown", (e) => {
  const inInput = document.activeElement.tagName === "INPUT";
  if (!$("#modal").hidden) {
    if (e.key === "Escape") { e.preventDefault(); closeModalByUser(); }
    return;
  }
  if ($("#ctx")) {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
    return;
  }
  const inProj = document.activeElement.closest?.("#projects");
  if (e.key === "/" && !inInput) { e.preventDefault(); $("#q").focus(); $("#q").select(); }
  else if (e.key === "F5") { e.preventDefault(); refreshEverything(); }
  else if (e.key === "Escape") {
    if (inInput && $("#q").value) { $("#q").value = ""; st.q = ""; clearDeep(); }
    else if (st.project) { st.project = null; render(); }
  } else if (!inInput && !inProj && (e.key === "ArrowDown" || e.key === "j")) { e.preventDefault(); moveSel(1); }
  else if (!inInput && !inProj && (e.key === "ArrowUp" || e.key === "k")) { e.preventDefault(); moveSel(-1); }
  else if (!inInput && !inProj && e.key === "Enter" && document.activeElement === document.body) {
    const s = sessionOf(document.querySelector(".row.sel"));
    if (s && s.cwd_exists) (e.shiftKey ? openTerminal : openChat)(s);
  }
});

/* ================================================================== обновление приложения */
let pendingUpdate = null;

async function checkUpdate(manual = false) {
  try {
    pendingUpdate = await invoke("check_update");
  } catch (e) {
    if (manual) toast(`Не удалось проверить обновления: ${e}`, true);
    return;
  }
  renderUpdate();
  if (manual && !pendingUpdate) toast(`Установлена последняя версия (${st.version})`);
}

function renderUpdate(progress = null) {
  const el = $("#update");
  el.hidden = !pendingUpdate;
  if (!pendingUpdate) return;
  el.innerHTML = progress == null
    ? `<div class="upd"><div><b>Новая версия ${esc(pendingUpdate.version)}</b><span class="muted small"> · у вас ${esc(pendingUpdate.current)}</span></div>
         ${pendingUpdate.notes ? `<div class="muted small upd-notes">${esc(pendingUpdate.notes)}</div>` : ""}
         <button class="primary wide" id="upd-go">Обновить и перезапустить</button></div>`
    : `<div class="upd" role="status"><b>Обновляю… ${progress}%</b><div class="bar"><i style="width:${progress}%"></i></div></div>`;
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("#upd-go")) {
    renderUpdate(0);
    try { await invoke("install_update"); } catch (err) { toast(`Обновление не удалось: ${err}`, true); renderUpdate(); }
  } else if (e.target.closest("#ver")) {
    checkUpdate(true);
  }
});
listen?.("update-progress", (ev) => renderUpdate(ev.payload));

invoke("app_version").then((v) => { st.version = v; $("#ver").textContent = v; }).catch(() => {});
setTimeout(() => checkUpdate(), 4000);
setInterval(() => checkUpdate(), 6 * 3600 * 1000);

/* ================================================================== события и обновление данных */
listen?.("app-error", (ev) => toast(String(ev.payload), true));

window.addEventListener("focus", async () => {
  await Promise.all([loadAccounts(), loadRuntime(), loadIntegration()]);
  render();
});
setInterval(async () => { if (await loadRuntime()) render(); }, 5000);
setInterval(async () => { await loadAccounts(); renderAccounts(); }, 60000);
setInterval(async () => { await loadSessions(); render(); }, 120000);

/** Мягкое появление при первом показе (одним разом, без повторов на обновлениях). */
function playIntro() {
  for (const el of [$("#list"), $("#accounts"), $("#projects")]) el.classList.add("intro");
  setTimeout(() => { for (const el of [$("#list"), $("#accounts"), $("#projects")]) el.classList.remove("intro"); }, 1200);
}

refreshAll().then(async () => {
  playIntro();
  // справка сама — только когда есть что переключать
  if (!store.get("ccdeck-help-seen") && st.accounts.length > 1) showHelp();
  for (const a of st.accounts.filter((x) => x.logged_in)) await refreshUsage(a.id, true);
});
