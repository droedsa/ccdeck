const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event?.listen;

const COLORS = ["#d97757", "#6a9bcc", "#788c5d", "#b07cc6", "#c9a227", "#5aa3a3"];
const LIMIT_WARN = 95; // % лимита, после которого предлагаем другой аккаунт

const st = {
  accounts: [],
  sessions: [],
  running: [],
  bindings: {},
  chatBindings: {},
  defaultAccount: "main",
  wrapLog: [],
  windows: true,
  integration: { editors: [] },
  claude: { found: true },
  q: "",
  project: null,
  hideMissing: true,
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

/* ------------------------------------------------------------------ утилиты */
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
  if (s <= 0) return "сброшен";
  if (s < 3600) return `сброс через ${Math.ceil(s / 60)} мин`;
  if (s < 86400) return `сброс через ${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
  return `сброс ${new Date(iso).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })}`;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 7000 : 3000);
}

async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    toast(String(e), true);
    throw e;
  }
}

/* ------------------------------------------------------------------ какой аккаунт */
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

/** Аккаунт чата: {acc, source: "chat" | "project" | "default"}. */
function chatAccount(s) {
  const own = accById(st.chatBindings[s.id]);
  if (own) return { acc: own, source: "chat" };
  const p = projectAccount(s.cwd);
  return { acc: p.acc, source: p.bound ? "project" : "default" };
}

/** Процент с учётом сброса: если окно уже сбросилось, старое значение неактуально → 0. */
function effUsage(val, resets) {
  if (val == null) return null;
  if (resets && Date.parse(resets) <= Date.now()) return 0;
  return val;
}

/** Под каким аккаунтом чат шёл на самом деле — по отметкам в файле чата (пишет приложение Claude).
 *  {acc} — совпал с карточкой, {email} — аккаунт не из CC Deck, null — неизвестно. */
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

/** Аккаунт открытого сейчас чата. Для чатов приложения Claude — из самого чата,
 *  иначе — по папке конфига, в которой он запущен. */
function runAccount(run) {
  const s = st.sessions.find((x) => x.id === run.session_id);
  if (run.entrypoint === "claude-desktop" || s?.entrypoint === "claude-desktop") {
    const r = recordedAccount(s);
    if (r) return r;
  }
  return { acc: accById(run.account_id) };
}
const runName = (r) => r?.acc?.name || r?.email || "?";

function usagePeak(acc) {
  const u = acc?.usage;
  if (!u) return null;
  const vals = [effUsage(u.five_hour, u.five_hour_resets), effUsage(u.seven_day, u.seven_day_resets)].filter((v) => v != null);
  return vals.length ? Math.max(...vals) : null;
}

const hasEditor = () => st.integration.editors.some((e) => e.installed);
const connected = () => st.integration.editors.some((e) => e.connected);

/* ------------------------------------------------------------------ модалки */
function modal(html, onMount) {
  const m = $("#modal");
  $("#modal-card").innerHTML = html;
  m.hidden = false;
  const close = () => (m.hidden = true);
  m.onclick = (e) => e.target === m && close();
  onMount?.($("#modal-card"), close);
  $("#modal-card").querySelector("input[type=text]")?.focus();
  return close;
}

/** Диалог с кнопками; resolve(value кнопки | null). */
function choose(title, html, buttons) {
  return new Promise((resolve) => {
    modal(
      `<h3>${esc(title)}</h3>${html}
       <div class="buttons">${buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ""}">${esc(b.label)}</button>`).join("")}</div>`,
      (card, close) => {
        card.querySelectorAll("[data-i]").forEach((el) => {
          el.onclick = () => { close(); resolve(buttons[+el.dataset.i].value); };
        });
        $("#modal").onclick = (e) => { if (e.target === $("#modal")) { close(); resolve(null); } };
        card.querySelector(".primary")?.focus();
      }
    );
  });
}

function showHelp() {
  store.set("ccdeck-help-seen", "1");
  const d = defAcc();
  modal(
    `<h3>Как это работает</h3>
     <ol class="steps">
       <li><b>Чаты общие для всех аккаунтов.</b> Любой чат можно продолжить под любым аккаунтом с того же места.</li>
       <li><b>Справа у чата видно, под каким аккаунтом он откроется</b> — <span class="chip-demo" style="--c:${d?.color}"><span class="dot"></span>${esc(d?.name || "")} ▾</span>.
           Нажмите на него, чтобы сменить: только для этого чата или для всего проекта.</li>
       <li><b>«Открыть»</b> запускает чат в VS Code под этим аккаунтом.</li>
       <li><b>Упёрлись в лимит?</b> Смените аккаунт у чата и нажмите «Открыть» ещё раз (старую вкладку чата в VS Code закройте).</li>
     </ol>
     <p>Если ничего не выбирать, всё работает под «${esc(d?.name || "")}». Это меняется в настройках аккаунта (✎).</p>
     ${hasEditor() && !connected() ? `<p class="note">Чтобы это работало в VS Code, нужно один раз нажать <b>«Настроить VS Code»</b> вверху списка.</p>` : ""}
     <div class="buttons"><button data-x class="primary">Понятно</button></div>`,
    (card, close) => (card.querySelector("[data-x]").onclick = close)
  );
}
$("#help").onclick = showHelp;

/* ------------------------------------------------------------------ данные */
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
  $("#count").textContent = "загрузка…";
  st.sessions = await call("list_sessions");
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
  renderProjects();
  renderProjectBar();
  renderList();
}

/* ------------------------------------------------------------------ аккаунты */
function meter(label, raw, resets) {
  const val = effUsage(raw, resets);
  if (val == null) return "";
  const wasReset = raw != null && val === 0 && raw !== 0;
  const cls = val >= 85 ? "high" : val >= 60 ? "mid" : "";
  return `<div class="meter-row"><span>${label}: ${Math.round(val)}%</span>
            <span>${wasReset ? "окно сброшено" : esc(untilText(resets))}</span></div>
          <div class="bar"><i class="${cls}" style="width:${Math.min(100, val)}%"></i></div>`;
}

function usageAge(u) {
  if (!u?.fetched_ms) return "";
  const old = !u.live && Date.now() - u.fetched_ms > 3600e3;
  const when = new Date(u.fetched_ms).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `<div class="meter-age ${old ? "old" : ""}" title="Лимиты берутся из Claude Code и обновляются, когда он работает под этим аккаунтом">
    ${old ? "данные от " + esc(when) : (u.live ? "с сервера " : "обновлено ") + esc(ago(u.fetched_ms))}</div>`;
}

function renderAccounts() {
  $("#accounts").innerHTML = st.accounts.map((a) => {
    const u = a.usage;
    const live = st.running.filter((r) => runAccount(r).acc?.id === a.id).length;
    const dup = a.account_uuid && st.accounts.find((x) => x.id !== a.id && x.account_uuid === a.account_uuid);
    return `<div class="acc" style="--c:${a.color}">
      <div class="acc-head">
        <span class="acc-name">${esc(a.name)}</span>
        ${live ? `<span class="badge live" title="Открытых сейчас чатов">● ${live}</span>` : ""}
        <button class="icon-btn" data-edit="${a.id}" title="Настроить">✎</button>
      </div>
      <div class="acc-sub" title="${esc(a.dir)}">${esc(a.email || (a.logged_in ? "вход выполнен" : "не выполнен вход"))}</div>
      ${u && (u.five_hour != null || u.seven_day != null)
        ? `<div class="meter">${meter("5 ч", u.five_hour, u.five_hour_resets)}${meter("Неделя", u.seven_day, u.seven_day_resets)}${usageAge(u)}</div>`
        : a.logged_in ? `<div class="meter-age">лимитов пока нет</div>` : ""}
      ${a.logged_in ? `<button class="link usage-btn" data-usage="${a.id}" title="Узнать актуальные лимиты у Anthropic">${usageBusy.has(a.id) ? "проверяю…" : "Проверить лимиты"}</button>` : ""}
      ${dup ? `<div class="acc-warn">Вход в тот же аккаунт, что и «${esc(dup.name)}». Нажмите ✎ → «Сменить вход» и войдите нужным аккаунтом.</div>` : ""}
      ${!a.exists ? `<div class="acc-warn">Папка конфига не найдена</div>` : ""}
      ${a.exists && !a.shared_ok ? `<div class="acc-warn">История не общая с основным аккаунтом</div>` : ""}
      ${!a.logged_in || (a.exists && !a.shared_ok) ? `<div class="acc-actions">
        ${!a.logged_in ? `<button class="primary" data-login="${a.id}">Войти</button>` : ""}
        ${a.exists && !a.shared_ok ? `<button data-repair="${a.id}">Починить</button>` : ""}
      </div>` : ""}
    </div>`;
  }).join("");
}

$("#accounts").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.usage) {
    await refreshUsage(b.dataset.usage);
  } else if (b.dataset.login) {
    await call("login", { accountId: b.dataset.login });
    toast("Открыл терминал для входа. После входа нажмите ⟳");
  } else if (b.dataset.repair) {
    const rep = await call("repair_account", { id: b.dataset.repair });
    showReport("Настройка общих папок", rep);
    refreshAll();
  } else if (b.dataset.edit) {
    editAccount(accById(b.dataset.edit));
  }
});

const usageBusy = new Set();

/** Спросить лимиты у сервера для аккаунта. silent — без сообщений об ошибке (при запуске). */
async function refreshUsage(id, silent = false) {
  if (usageBusy.has(id)) return;
  usageBusy.add(id);
  renderAccounts();
  try {
    const u = await invoke("refresh_usage", { accountId: id });
    const a = accById(id);
    if (a) a.usage = u;
    if (!silent) {
      const peak = usagePeak(a);
      toast(`${a?.name}: 5 ч — ${Math.round(effUsage(u.five_hour, u.five_hour_resets) ?? 0)}%, неделя — ${Math.round(effUsage(u.seven_day, u.seven_day_resets) ?? 0)}%${peak >= 100 ? " · лимит исчерпан" : ""}`);
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
  return `<div class="colors">${COLORS.map((c) => `<button type="button" data-c="${c}" class="${c === sel ? "sel" : ""}" style="--c:${c}"></button>`).join("")}</div>`;
}
function bindColors(card, onPick) {
  card.querySelectorAll(".colors button").forEach((b) => {
    b.onclick = () => {
      card.querySelectorAll(".colors button").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      onPick(b.dataset.c);
    };
  });
}

function showReport(title, lines, extra = "") {
  modal(
    `<h3>${esc(title)}</h3><ul class="report">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>${extra}
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
     <p>В основном <code>~/.claude</code> сейчас вход как <b>${esc(main?.email || "—")}</b>. Здесь добавьте <b>другой</b> аккаунт.
        У него будет своя папка, где хранится только вход. Чаты, проекты, память, скиллы и настройки общие.</p>
     <label>Название</label><input type="text" id="f-name" value="Личный">
     <label>Папка конфига (CLAUDE_CONFIG_DIR)</label><input type="text" id="f-dir" value="${esc(dir)}">
     <label>Цвет</label>${colorPicker(color)}
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
        const name = card.querySelector("#f-name").value;
        const rep = await call("add_account", { name, dir: card.querySelector("#f-dir").value, color });
        await refreshAll();
        const acc = st.accounts[st.accounts.length - 1];
        showReport(`Аккаунт «${name}» создан`, rep,
          `<p style="margin-top:14px">Теперь войдите в него — откроется терминал с <code>claude auth login</code>.</p>
           <div class="buttons" style="margin-top:0"><button class="primary" id="go-login">Войти сейчас</button></div>`);
        $("#go-login").onclick = async () => {
          await call("login", { accountId: acc.id });
          $("#modal").hidden = true;
          toast("После входа нажмите ⟳");
        };
      };
    }
  );
}

function editAccount(a) {
  let color = a.color;
  const isDefault = a.id === st.defaultAccount;
  modal(
    `<h3>${esc(a.name)}</h3>
     <p>${esc(a.email || "")}<br><code>${esc(a.dir)}</code>${a.is_default ? " — основной конфиг" : ""}</p>
     <label>Название</label><input type="text" id="f-name" value="${esc(a.name)}">
     <label>Цвет</label>${colorPicker(color)}
     <label class="check"><input type="checkbox" id="f-def" ${isDefault ? "checked disabled" : ""}> Основной: всё, для чего аккаунт не выбран, работает под ним</label>
     <div class="buttons">
       ${a.is_default ? "" : `<button data-rm class="danger" style="margin-right:auto">Убрать</button>`}
       <button data-login>Сменить вход</button>
       <button data-x>Отмена</button><button data-ok class="primary">Сохранить</button>
     </div>`,
    (card, close) => {
      bindColors(card, (c) => (color = c));
      card.querySelector("[data-x]").onclick = close;
      card.querySelector("[data-login]").onclick = async () => {
        close();
        await call("login", { accountId: a.id });
        toast("Открыл терминал для входа. После входа нажмите ⟳");
      };
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

/* ------------------------------------------------------------------ VS Code */
function renderVscodeStatus() {
  const el = $("#vscode-status");
  if (!connected()) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="vs-line" title="Чаты в VS Code открываются под выбранным аккаунтом">
    <span class="ok">✓</span> VS Code настроен <button class="link" id="vs-disconnect">отключить</button></div>`
    + (st.claude.source === "vscode" ? `<div class="vs-line" title="${esc(st.claude.path || "")}">Claude Code: из расширения VS Code</div>` : "");
}

function renderBanner() {
  const b = $("#banner");
  if (!st.claude.found) {
    b.hidden = false;
    b.innerHTML = `<div class="banner-text">
        <b>Claude Code не установлен.</b>
        CC Deck управляет Claude Code, поэтому сначала его нужно установить. Откроется терминал с официальной командой установки — после неё нажмите ⟳.
      </div>
      <button class="primary" id="claude-install">Установить Claude Code</button>`;
    return;
  }
  const show = hasEditor() && !connected();
  b.hidden = !show;
  if (!show) return;
  b.innerHTML = `<div class="banner-text">
      <b>Последний шаг: настроить VS Code.</b>
      Тогда чаты в VS Code будут открываться под тем аккаунтом, который вы выберете. В VS Code добавится одна настройка, отключить можно в любой момент.
    </div>
    <button class="primary" id="vs-connect">Настроить VS Code</button>`;
}

async function connectFlow() {
  await call("connect_editors");
  await loadIntegration();
  render();
  toast("VS Code настроен");
}

document.addEventListener("click", async (e) => {
  if (e.target.closest("#claude-install")) {
    await call("install_claude");
    toast("Идёт установка в терминале. Когда закончится — нажмите ⟳");
    return;
  }
  if (e.target.closest("#vs-connect")) {
    await connectFlow();
  } else if (e.target.closest("#vs-disconnect")) {
    const ok = await choose("Отключить VS Code?",
      `<p>VS Code перестанет учитывать выбор аккаунта: все чаты в нём будут под тем аккаунтом, в который выполнен вход в <code>~/.claude</code>.</p>`,
      [{ label: "Отмена", value: false }, { label: "Отключить", value: true, cls: "danger" }]);
    if (!ok) return;
    await call("disconnect_editors");
    await loadIntegration();
    render();
  }
});

/* ------------------------------------------------------------------ смена аккаунта */
async function setProjectAccount(path, accId) {
  // аккаунт по умолчанию = просто снять привязку
  await call("set_binding", { path, accountId: accId === st.defaultAccount ? null : accId });
  await loadRuntime();
  render();
}

async function setChatAccount(s, accId) {
  // если совпадает с аккаунтом проекта — отдельный выбор не нужен
  const same = accId === projectAccount(s.cwd).acc.id;
  await call("set_chat_account", { sessionId: s.id, accountId: same ? null : accId });
  await loadRuntime();
  render();
}

function accItems(kind, currentId) {
  return st.accounts.map((a) => {
    const peak = usagePeak(a);
    return `<button data-kind="${kind}" data-acc="${a.id}">
      <span class="dot" style="--c:${a.color}"></span>${esc(a.name)}
      ${peak != null ? `<span class="muted small">${Math.round(peak)}%</span>` : ""}
      ${a.id === currentId ? `<span class="check-mark">✓</span>` : ""}</button>`;
  }).join("");
}

/** Меню у метки аккаунта чата. */
function chatAccountMenu(s, x, y) {
  const { acc } = chatAccount(s);
  const proj = projectAccount(s.cwd).acc;
  openMenu(
    `<div class="menu-head">Этот чат открывать под:</div>${accItems("chat", acc.id)}
     <hr><div class="menu-head">Весь проект «${esc(baseName(s.cwd))}»:</div>${accItems("project", proj.id)}`,
    x, y,
    async (b) => {
      const id = b.dataset.acc;
      if (!id) return;
      if (b.dataset.kind === "chat") {
        if (id === acc.id) return;
        await setChatAccount(s, id);
        toast(`Чат будет открываться под «${accById(id)?.name}»`);
      } else {
        if (id === proj.id) return;
        await setProjectAccount(s.cwd, id);
        toast(`Проект «${baseName(s.cwd)}» → ${accById(id)?.name}`);
      }
    }
  );
}

function projectAccountMenu(path, x, y) {
  const { acc } = projectAccount(path);
  openMenu(`<div class="menu-head">Проект «${esc(baseName(path))}» работает под:</div>${accItems("project", acc.id)}`, x, y, async (b) => {
    if (!b.dataset.acc || b.dataset.acc === acc.id) return;
    await setProjectAccount(path, b.dataset.acc);
    toast(`Проект «${baseName(path)}» → ${accById(b.dataset.acc)?.name}`);
  });
}

function chip(acc, attrs, title, cls = "") {
  return `<button class="chip ${cls}" style="--c:${acc?.color}" ${attrs} title="${esc(title)}"><span class="dot"></span>${esc(acc?.name || "")}<span class="caret">▾</span></button>`;
}

/* ------------------------------------------------------------------ открыть чат */
/** Проверки перед запуском. Возвращает аккаунт или false. */
async function preflight(s, path) {
  let acc = s ? chatAccount(s).acc : projectAccount(path).acc;
  const peak = usagePeak(acc);
  if (peak != null && peak >= LIMIT_WARN && st.accounts.length > 1) {
    const alt = st.accounts
      .filter((a) => a.id !== acc.id && a.logged_in)
      .sort((a, b) => (usagePeak(a) ?? 0) - (usagePeak(b) ?? 0))[0];
    if (alt) {
      const resets = acc.usage.five_hour >= LIMIT_WARN ? acc.usage.five_hour_resets : acc.usage.seven_day_resets;
      const r = await choose(`У «${acc.name}» лимит ${Math.round(peak)}%`,
        `<p>${esc(untilText(resets))}. У «${esc(alt.name)}» — ${Math.round(usagePeak(alt) ?? 0)}%.</p>
         <p>Открыть ${s ? "этот чат" : "новый чат"} под «${esc(alt.name)}»? История общая — продолжится с того же места.</p>`,
        [{ label: "Отмена", value: null }, { label: `Оставить «${acc.name}»`, value: "keep" },
         { label: `Открыть под «${alt.name}»`, value: "switch", cls: "primary" }]);
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
    const was = { name: runName(runAcc) };
    const ok = await choose("Чат уже открыт",
      `<p>Этот чат сейчас идёт под «${esc(was?.name || "?")}». Чтобы он продолжился под «${esc(acc.name)}», закройте его вкладку в VS Code (или окно терминала) и нажмите «Открыть» ещё раз.</p>`,
      [{ label: "Отмена", value: false }, { label: "Всё равно открыть", value: true, cls: "primary" }]);
    if (!ok) return false;
  }
  return acc;
}

async function ensureConnected() {
  if (connected() || !hasEditor()) return true;
  const r = await choose("Сначала настроить VS Code?",
    `<p>Без этого VS Code не знает, какой аккаунт вы выбрали, и откроет чат под тем, в который выполнен вход в <code>~/.claude</code>.</p>`,
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
  toast(`Открываю в VS Code · ${acc.name}`);
}

async function openTerminal(s) {
  const acc = await preflight(s);
  if (!acc) return;
  await call("resume_session", { sessionId: s.id, accountId: acc.id });
  toast(`Терминал · ${acc.name}`);
}

async function newChat(path, where) {
  if (where === "editor" && !(await ensureConnected())) return;
  const acc = await preflight(null, path);
  if (!acc) return;
  if (where === "editor") await call("open_chat", { folder: path, sessionId: null });
  else await call("new_session", { cwd: path, accountId: acc.id, continueLast: false });
  toast(`Новый чат · ${acc.name}`);
}

/** Меню «Открыть проект в VS Code под: …» → привязать аккаунт (если другой) и открыть папку. */
function openProjectMenu(path, x, y) {
  const { acc } = projectAccount(path);
  openMenu(
    `<div class="menu-head">Открыть «${esc(baseName(path))}» в VS Code под:</div>${accItems("open", acc.id)}
     <div class="menu-note">Все чаты проекта останутся — история общая.</div>`,
    x, y,
    async (b) => {
      if (!b.dataset.acc) return;
      await openProject(path, b.dataset.acc);
    }
  );
}

async function openProject(path, accId) {
  if (!(await ensureConnected())) return;
  const before = projectAccount(path).acc;
  if (accId !== before.id) await setProjectAccount(path, accId);
  const acc = accById(accId);
  // открытые сейчас чаты проекта под другим аккаунтом так и останутся, пока их не закрыть
  const p = normPath(path);
  const stale = st.running.filter((r) => {
    const s = st.sessions.find((x) => x.id === r.session_id);
    return s && normPath(s.cwd) === p && runAccount(r).acc?.id !== accId;
  }).length;
  const ed = await call("open_project", { folder: path });
  toast(`${baseName(path)} → ${ed} · ${acc?.name}` + (stale ? `. Уже открытые вкладки чатов (${stale}) работают под прежним аккаунтом — закройте их и откройте заново` : ""));
}

/* ------------------------------------------------------------------ проекты */
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
  let ps = projectsOf(st.sessions);
  if (st.hideMissing) ps = ps.filter((p) => p.exists);
  const cur = st.project && normPath(st.project);
  $("#projects").innerHTML = ps.map((p) => {
    const { acc, bound } = projectAccount(p.cwd);
    return `<div class="proj ${cur === normPath(p.cwd) ? "active" : ""}" data-cwd="${esc(p.cwd)}" title="${esc(p.cwd)}">
      <span class="pname">${esc(baseName(p.cwd))}</span>
      ${bound ? `<span class="pacc" style="--c:${acc.color}">${esc(acc.name)}</span>` : ""}
      <span class="n">${p.n}</span>
      ${p.exists && hasEditor() ? `<button class="proj-open" data-open-proj="${esc(p.cwd)}" title="Открыть проект в VS Code под выбранным аккаунтом">VS Code ▸</button>` : ""}</div>`;
  }).join("") || `<div class="muted" style="padding:4px 8px">Нет проектов</div>`;
}

$("#projects").addEventListener("click", (e) => {
  const ob = e.target.closest("[data-open-proj]");
  if (ob) {
    const r = ob.getBoundingClientRect();
    return openProjectMenu(ob.dataset.openProj, r.left, r.bottom + 4);
  }
  const el = e.target.closest(".proj");
  if (!el) return;
  st.project = st.project && normPath(st.project) === normPath(el.dataset.cwd) ? null : el.dataset.cwd;
  render();
});

function renderProjectBar() {
  const bar = $("#project-bar");
  if (!st.project) { bar.hidden = true; return; }
  bar.hidden = false;
  const { acc, bound } = projectAccount(st.project);
  bar.innerHTML = `
    <div class="pb-row">
      <span class="path" title="${esc(st.project)}"><b>${esc(baseName(st.project))}</b><span class="muted"> ${esc(st.project)}</span></span>
      <button class="ghost" data-open title="Открыть папку">📂</button>
      <button class="ghost" data-clear title="Все проекты (Esc)">✕</button>
    </div>
    <div class="pb-row">
      <span class="muted">Аккаунт проекта:</span>
      ${chip(acc, "data-projchip", "Под этим аккаунтом открываются чаты проекта, если для чата не выбран другой")}
      ${bound ? "" : `<span class="muted small">(основной)</span>`}
      <span class="spacer"></span>
      ${hasEditor() ? `<button class="primary" data-openproj>Открыть проект в VS Code</button>
                       <button data-new="editor">Новый чат в VS Code</button>` : ""}
      <button data-new="term">Новый чат в терминале</button>
    </div>`;
}

$("#project-bar").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.clear != null) { st.project = null; render(); }
  else if (b.dataset.open != null) call("reveal", { path: st.project });
  else if (b.dataset.projchip != null) { const r = b.getBoundingClientRect(); projectAccountMenu(st.project, r.left, r.bottom + 4); }
  else if (b.dataset.new) newChat(st.project, b.dataset.new);
  else if (b.dataset.openproj != null) { const r = b.getBoundingClientRect(); openProjectMenu(st.project, r.left, r.bottom + 4); }
});

/* ------------------------------------------------------------------ список чатов */
function filtered() {
  const q = st.q.trim().toLowerCase();
  const proj = st.project && normPath(st.project);
  return st.sessions.filter((s) => {
    if (st.hideMissing && !s.cwd_exists) return false;
    if (proj && normPath(s.cwd) !== proj) return false;
    if (st.deepIds) return st.deepIds.has(s.id);
    if (!q) return true;
    return [s.title, s.first_prompt, s.last_prompt, s.cwd, s.git_branch, s.id].some((x) => x && x.toLowerCase().includes(q));
  });
}

const LIMIT = 300;
const WHY = {
  chat: (a) => `Чат откроется под «${a}» — выбрано для этого чата. Нажмите, чтобы сменить.`,
  project: (a) => `Чат откроется под «${a}» — как у проекта. Нажмите, чтобы сменить.`,
  default: (a) => `Чат откроется под «${a}» — основной аккаунт. Нажмите, чтобы сменить.`,
};

function renderList() {
  const list = filtered();
  const runMap = new Map(st.running.map((r) => [r.session_id, r]));
  const ed = hasEditor();
  const selId = document.querySelector(".row.sel")?.dataset.id;

  let head = "";
  if (st.deepIds) {
    head = `<div class="muted" style="padding:6px 10px">Найдено в переписке по «${esc(st.deepQuery)}»: ${st.deepIds.size}
      · <a href="#" id="clear-deep">сбросить</a></div>`;
  }

  if (!list.length) {
    $("#list").innerHTML = head + `<div class="empty">${st.sessions.length ? "Ничего не найдено" : "Чатов пока нет"}</div>`;
  } else {
    $("#list").innerHTML = head + list.slice(0, LIMIT).map((s) => {
      const title = s.title || s.first_prompt || s.id;
      const prompt = s.last_prompt && s.last_prompt !== title ? s.last_prompt : s.title ? s.first_prompt : null;
      const run = runMap.get(s.id);
      const runAcc = run && runAccount(run);
      const desk = s.entrypoint === "claude-desktop" ? recordedAccount(s) : null;
      const { acc, source } = chatAccount(s);
      const peak = usagePeak(acc);
      return `<div class="row ${s.id === selId ? "sel" : ""}" data-id="${s.id}" style="--c:${acc?.color}">
        <div class="title" title="${esc(title)}">${hl(title)}</div>
        <div class="actions">
          ${s.cwd_exists ? `
            ${chip(acc, "data-chip", WHY[source](acc?.name), source === "chat" ? "own" : "")}
            <button class="go" data-go title="${ed ? "Открыть в VS Code (Enter)" : "Открыть в терминале (Enter)"}">Открыть</button>` : ""}
          <button class="more" data-more title="Ещё">⋯</button>
        </div>
        <div class="meta">
          <a href="#" data-proj="${esc(s.cwd || "")}" title="${esc(s.cwd || "")}">${hl(baseName(s.cwd))}</a>
          <span title="${new Date(s.modified_ms).toLocaleString("ru-RU")}">${ago(s.modified_ms)}</span>
          ${s.git_branch ? `<span>⎇ ${hl(s.git_branch)}</span>` : ""}
          ${run ? `<span class="badge live" title="Чат сейчас открыт${run.entrypoint === "claude-desktop" ? " в приложении Claude" : ""}">● открыт · ${esc(runName(runAcc))}</span>` : ""}
          ${!run && desk ? `<span class="badge" title="Чат из приложения Claude; под этим аккаунтом он шёл последний раз">приложение Claude · ${esc(runName(desk))}</span>` : ""}
          ${peak != null && peak >= LIMIT_WARN && s.cwd_exists ? `<span class="badge warn">у «${esc(acc.name)}» лимит ${Math.round(peak)}%</span>` : ""}
          ${!s.cwd_exists ? `<span class="badge missing">папки проекта нет</span>` : ""}
        </div>
        ${prompt ? `<div class="prompt" title="${esc(prompt)}">${hl(prompt)}</div>` : ""}
      </div>`;
    }).join("") + (list.length > LIMIT ? `<div class="empty">Показаны первые ${LIMIT} из ${list.length}. Уточните поиск.</div>` : "");
  }
  const total = st.sessions.filter((s) => !st.hideMissing || s.cwd_exists).length;
  $("#count").textContent = list.length === total ? `${total} чатов` : `${list.length} из ${total}`;
  $("#clear-deep")?.addEventListener("click", (e) => { e.preventDefault(); clearDeep(); });
}

/* ------------------------------------------------------------------ меню */
function openMenu(html, x, y, onPick) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu";
  m.id = "ctx";
  m.innerHTML = html;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + "px";
  m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + "px";
  m.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    closeMenu();
    onPick(b);
  };
}
function closeMenu() { $("#ctx")?.remove(); }
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#ctx") && !e.target.closest("[data-more], .chip")) closeMenu();
});

function sessionMenu(s, x, y) {
  const ed = hasEditor();
  openMenu(`
    ${s.cwd_exists && ed ? `<button data-a="ed">Открыть в VS Code</button>` : ""}
    ${s.cwd_exists ? `<button data-a="term">Открыть в терминале</button>` : ""}
    ${s.cwd_exists ? `<hr>` : ""}
    ${s.cwd ? `<button data-a="proj">Все чаты проекта «${esc(baseName(s.cwd))}»</button><button data-a="open">Открыть папку проекта</button>` : ""}
    <button data-a="cmd">Скопировать команду для терминала</button>
    <hr><button data-a="del" class="danger">Удалить чат…</button>`,
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

$("#list").addEventListener("click", (e) => {
  const s = sessionOf(e.target);
  if (!s) return;
  const b = e.target.closest("button, a");
  if (!b) return selectRow(e.target.closest(".row"));
  e.preventDefault();
  const r = b.getBoundingClientRect();
  if (b.dataset.chip != null) chatAccountMenu(s, r.left, r.bottom + 4);
  else if (b.dataset.go != null) openChat(s);
  else if (b.dataset.more != null) sessionMenu(s, r.right - 260, r.bottom + 4);
  else if (b.dataset.proj) { st.project = b.dataset.proj; render(); }
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

/* ------------------------------------------------------------------ поиск */
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
  if (!q) return toast("Введите текст для поиска");
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
$("#refresh").onclick = refreshAll;

document.addEventListener("keydown", (e) => {
  const inInput = document.activeElement.tagName === "INPUT";
  if (!$("#modal").hidden) {
    if (e.key === "Escape") $("#modal").hidden = true;
    return;
  }
  if (e.key === "/" && !inInput) { e.preventDefault(); $("#q").focus(); $("#q").select(); }
  else if (e.key === "F5") { e.preventDefault(); refreshAll(); }
  else if (e.key === "Escape") {
    if ($("#ctx")) closeMenu();
    else if (inInput && $("#q").value) { $("#q").value = ""; st.q = ""; clearDeep(); }
    else if (st.project) { st.project = null; render(); }
  } else if (!inInput && (e.key === "ArrowDown" || e.key === "j")) { e.preventDefault(); moveSel(1); }
  else if (!inInput && (e.key === "ArrowUp" || e.key === "k")) { e.preventDefault(); moveSel(-1); }
  else if (!inInput && e.key === "Enter") {
    const s = sessionOf(document.querySelector(".row.sel"));
    if (s && s.cwd_exists) (e.shiftKey ? openTerminal : openChat)(s);
  }
});

/* ------------------------------------------------------------------ обновление приложения */
let pendingUpdate = null;

async function checkUpdate(manual = false) {
  try {
    pendingUpdate = await invoke("check_update");
  } catch (e) {
    if (manual) toast(`Не удалось проверить обновления: ${e}`, true);
    return;
  }
  renderUpdate();
  if (manual && !pendingUpdate) toast("У вас последняя версия");
}

function renderUpdate(progress = null) {
  const el = $("#update");
  el.hidden = !pendingUpdate;
  if (!pendingUpdate) return;
  el.innerHTML = progress == null
    ? `<div class="upd"><div><b>Новая версия ${esc(pendingUpdate.version)}</b><span class="muted small"> у вас ${esc(pendingUpdate.current)}</span></div>
         ${pendingUpdate.notes ? `<div class="muted small upd-notes">${esc(pendingUpdate.notes)}</div>` : ""}
         <button class="primary wide" id="upd-go">Обновить и перезапустить</button></div>`
    : `<div class="upd"><b>Обновляю… ${progress}%</b><div class="bar"><i style="width:${progress}%"></i></div></div>`;
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

invoke("app_version").then((v) => { $("#ver").textContent = v; $("#ver").title = "Проверить обновления"; }).catch(() => {});
setTimeout(() => checkUpdate(), 4000);
setInterval(() => checkUpdate(), 6 * 3600 * 1000);

/* ------------------------------------------------------------------ события и обновление */
listen?.("app-error", (ev) => toast(String(ev.payload), true));

window.addEventListener("focus", async () => {
  await Promise.all([loadAccounts(), loadRuntime(), loadIntegration()]);
  render();
});
setInterval(async () => { if (await loadRuntime()) render(); }, 5000);
setInterval(async () => { await loadAccounts(); renderAccounts(); }, 60000);
setInterval(async () => { await loadSessions(); render(); }, 120000);

refreshAll().then(async () => {
  if (!store.get("ccdeck-help-seen")) showHelp();
  // один раз при запуске — актуальные лимиты всех аккаунтов (по очереди, тихо)
  for (const a of st.accounts.filter((x) => x.logged_in)) await refreshUsage(a.id, true);
});
