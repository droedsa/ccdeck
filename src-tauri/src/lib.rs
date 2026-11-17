mod accounts;
mod cli;
mod launch;
mod sessions;
mod vscode;
pub mod wrap;

use accounts::{norm_path, Account, AccountStatus, Config};
use serde::Serialize;
use sessions::{Cache, Running, SessionInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};

struct AppState {
    cfg: Mutex<Config>,
    cfg_path: PathBuf,
    cache: Mutex<Cache>,
}

impl AppState {
    fn cfg(&self) -> Config {
        self.cfg.lock().unwrap().clone()
    }
    fn update(&self, f: impl FnOnce(&mut Config) -> Result<(), String>) -> Result<(), String> {
        let mut cfg = self.cfg.lock().unwrap();
        f(&mut cfg)?;
        cfg.save(&self.cfg_path)
    }
    fn account(&self, id: &str) -> Result<Account, String> {
        self.cfg().find(id).cloned().ok_or_else(|| format!("Нет аккаунта {id}"))
    }
    fn config_dirs(&self) -> Vec<(String, PathBuf)> {
        self.cfg().accounts.iter().map(|a| (a.id.clone(), a.config_dir())).collect()
    }
    fn session(&self, id: &str) -> Result<SessionInfo, String> {
        self.cache
            .lock()
            .unwrap()
            .get_by_id(id)
            .ok_or_else(|| "Сессия не найдена — обновите список".to_string())
    }
}

fn err(app: &AppHandle, e: impl ToString) {
    let _ = app.emit("app-error", e.to_string());
}

// ------------------------------------------------------------------ аккаунты

#[tauri::command]
fn get_accounts(state: State<AppState>) -> Vec<AccountStatus> {
    state.cfg().accounts.iter().map(accounts::status).collect()
}

#[tauri::command]
fn suggest_dir(name: String) -> String {
    let n = name.to_lowercase();
    let suffix = if n.contains("лич") || n.contains("perso") || n.contains("home") {
        "personal"
    } else if n.contains("раб") || n.contains("work") {
        "work"
    } else {
        "alt"
    };
    accounts::home().join(format!(".claude-{suffix}")).to_string_lossy().to_string()
}

#[tauri::command]
fn add_account(app: AppHandle, state: State<AppState>, name: String, dir: String, color: String) -> Result<Vec<String>, String> {
    let name = name.trim().to_string();
    let dir = dir.trim().to_string();
    if name.is_empty() || dir.is_empty() {
        return Err("Укажите название и папку".into());
    }
    let report = accounts::prepare_dir(Path::new(&dir))?;
    state.update(|cfg| {
        let mut id: String = name
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect();
        while cfg.find(&id).is_some() {
            id.push('2');
        }
        cfg.accounts.push(Account { id, name: name.clone(), dir: Some(dir), color });
        Ok(())
    })?;
    refresh_tray(&app);
    Ok(report)
}

#[tauri::command]
fn repair_account(state: State<AppState>, id: String) -> Result<Vec<String>, String> {
    match state.account(&id)?.dir {
        Some(d) => accounts::prepare_dir(Path::new(&d)),
        None => Ok(vec!["Основной аккаунт не требует настройки".into()]),
    }
}

#[tauri::command]
fn update_account(app: AppHandle, state: State<AppState>, id: String, name: String, color: String) -> Result<(), String> {
    state.update(|cfg| {
        let a = cfg.accounts.iter_mut().find(|a| a.id == id).ok_or("Нет такого аккаунта")?;
        a.name = name.trim().to_string();
        a.color = color;
        Ok(())
    })?;
    refresh_tray(&app);
    Ok(())
}

#[tauri::command]
fn remove_account(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    state.update(|cfg| {
        if cfg.find(&id).map(|a| a.dir.is_none()).unwrap_or(false) {
            return Err("Основной аккаунт убрать нельзя".into());
        }
        cfg.accounts.retain(|a| a.id != id);
        cfg.bindings.retain(|_, a| *a != id);
        cfg.chat_bindings.retain(|_, a| *a != id);
        if cfg.default_account.as_deref() == Some(&id) {
            cfg.default_account = None;
        }
        Ok(())
    })?;
    refresh_tray(&app);
    Ok(())
}

#[tauri::command]
fn set_default_account(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    state.update(|cfg| {
        cfg.find(&id).ok_or("Нет такого аккаунта")?;
        cfg.default_account = Some(id);
        Ok(())
    })?;
    refresh_tray(&app);
    Ok(())
}

/// Привязать папку проекта к аккаунту (None — снять привязку, будет аккаунт по умолчанию).
#[tauri::command]
fn set_binding(app: AppHandle, state: State<AppState>, path: String, account_id: Option<String>) -> Result<(), String> {
    state.update(|cfg| {
        let key = norm_path(&path);
        match account_id {
            Some(id) => {
                cfg.find(&id).ok_or("Нет такого аккаунта")?;
                cfg.bindings.insert(key, id);
            }
            None => {
                cfg.bindings.remove(&key);
            }
        }
        Ok(())
    })?;
    refresh_tray(&app);
    Ok(())
}

/// Аккаунт для отдельного чата (None — как у проекта).
#[tauri::command]
fn set_chat_account(app: AppHandle, state: State<AppState>, session_id: String, account_id: Option<String>) -> Result<(), String> {
    state.update(|cfg| {
        match account_id {
            Some(id) => {
                cfg.find(&id).ok_or("Нет такого аккаунта")?;
                cfg.chat_bindings.insert(session_id, id);
            }
            None => {
                cfg.chat_bindings.remove(&session_id);
            }
        }
        Ok(())
    })?;
    refresh_tray(&app);
    Ok(())
}

#[tauri::command]
fn login(state: State<AppState>, account_id: String) -> Result<(), String> {
    let acc = state.account(&account_id)?;
    launch_terminal(&acc, &accounts::home(), vec!["auth".into(), "login".into()], format!("Вход: {}", acc.name))
}

// ------------------------------------------------------------------ сессии

#[tauri::command]
async fn list_sessions(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let dirs: Vec<PathBuf> = state.config_dirs().into_iter().map(|(_, d)| d).collect();
    let roots = sessions::projects_roots(&dirs);
    let list = {
        let mut cache = state.cache.lock().unwrap();
        sessions::list(&mut cache, &roots)
    };
    refresh_tray(&app);
    Ok(list)
}

#[tauri::command]
async fn search_sessions(state: State<'_, AppState>, query: String) -> Result<Vec<String>, String> {
    let cache = state.cache.lock().unwrap();
    Ok(sessions::search(&cache, &query))
}

#[derive(Serialize)]
struct Runtime {
    running: Vec<Running>,
    last_used: HashMap<String, String>,
    bindings: HashMap<String, String>,
    chat_bindings: HashMap<String, String>,
    default_account: String,
    /// последние запуски Claude из VS Code через обёртку
    wrap_log: Vec<wrap::LogEntry>,
    windows: bool,
}

#[tauri::command]
fn get_runtime(state: State<AppState>) -> Runtime {
    let cfg = state.cfg();
    Runtime {
        running: sessions::running(&state.config_dirs()),
        last_used: cfg.last_used.clone(),
        bindings: cfg.bindings.clone(),
        chat_bindings: cfg.chat_bindings.clone(),
        default_account: cfg.default_acc().id.clone(),
        wrap_log: wrap::recent(40),
        windows: cfg!(windows),
    }
}

#[tauri::command]
fn delete_session(state: State<AppState>, session_id: String) -> Result<(), String> {
    let info = state.session(&session_id)?;
    sessions::trash_session(&info)?;
    state.update(|cfg| {
        cfg.last_used.remove(&session_id);
        cfg.chat_bindings.remove(&session_id);
        Ok(())
    })
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    launch::reveal(Path::new(&path))
}

// ------------------------------------------------------------------ терминал

fn launch_terminal(acc: &Account, cwd: &Path, args: Vec<String>, title: String) -> Result<(), String> {
    let exe = cli::require()?.path;
    let dir = acc.config_dir();
    launch::open(launch::Launch {
        cwd,
        config_dir: acc.dir.as_ref().map(|_| dir.as_path()),
        args,
        title,
        exe,
        raw: None,
    })
}

#[derive(Serialize)]
struct ClaudeStatus {
    found: bool,
    path: Option<String>,
    source: Option<&'static str>,
}

#[tauri::command]
fn claude_status() -> ClaudeStatus {
    match cli::find() {
        Some(b) => ClaudeStatus { found: true, path: Some(b.path.to_string_lossy().into()), source: Some(b.source) },
        None => ClaudeStatus { found: false, path: None, source: None },
    }
}

/// Открыть терминал с официальной командой установки Claude Code.
#[tauri::command]
fn install_claude() -> Result<(), String> {
    launch::open(launch::Launch {
        cwd: &accounts::home(),
        config_dir: None,
        args: vec![],
        title: "Установка Claude Code".into(),
        exe: PathBuf::from("claude"),
        raw: Some(cli::install_command().into()),
    })
}

fn short(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{t}…") } else { t }
}

fn session_label(s: &SessionInfo) -> String {
    s.title.clone().or(s.first_prompt.clone()).unwrap_or_else(|| s.id.clone())
}

/// Продолжить сессию в терминале. Без account_id — аккаунт проекта.
fn resume_in_terminal(state: &AppState, session_id: &str, account_id: Option<&str>) -> Result<String, String> {
    let info = state.session(session_id)?;
    let cwd = info.cwd.clone().ok_or("У сессии не записана папка проекта")?;
    let acc = match account_id {
        Some(id) => state.account(id)?,
        None => state.cfg().account_for(&cwd, Some(session_id)).0.clone(),
    };
    launch_terminal(
        &acc,
        Path::new(&cwd),
        vec!["--resume".into(), session_id.to_string()],
        format!("{} · {}", acc.name, short(&session_label(&info), 40)),
    )?;
    let (sid, aid) = (session_id.to_string(), acc.id.clone());
    state.update(|cfg| {
        cfg.last_used.insert(sid, aid);
        Ok(())
    })?;
    Ok(acc.name)
}

#[tauri::command]
fn resume_session(state: State<AppState>, session_id: String, account_id: Option<String>) -> Result<String, String> {
    resume_in_terminal(&state, &session_id, account_id.as_deref())
}

#[tauri::command]
fn new_session(state: State<AppState>, cwd: String, account_id: Option<String>, continue_last: bool) -> Result<String, String> {
    let acc = match account_id {
        Some(id) => state.account(&id)?,
        None => state.cfg().account_for_path(&cwd).clone(),
    };
    let folder = Path::new(&cwd).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(cwd.clone());
    let args = if continue_last { vec!["--continue".to_string()] } else { vec![] };
    launch_terminal(&acc, Path::new(&cwd), args, format!("{} · {}", acc.name, folder))?;
    Ok(acc.name)
}

// ------------------------------------------------------------------ VS Code

#[derive(Serialize)]
struct EditorStatus {
    #[serde(flatten)]
    editor: vscode::Editor,
    installed: bool,
    connected: bool,
}

#[derive(Serialize)]
struct Integration {
    editors: Vec<EditorStatus>,
    wrapper_path: Option<String>,
}

fn wrapper_path() -> Option<PathBuf> {
    let p = wrap::app_dir().join("bin").join(if cfg!(windows) { "ccdeck-wrap.exe" } else { "ccdeck-wrap" });
    Some(p)
}

#[tauri::command]
fn integration_status() -> Integration {
    let wp = wrapper_path();
    let wps = wp.as_ref().map(|p| norm_path(&p.to_string_lossy()));
    Integration {
        editors: vscode::editors()
            .into_iter()
            .filter(|e| e.has_extension)
            .map(|e| EditorStatus {
                installed: vscode::exe(&e.name).is_some(),
                connected: e.wrapper.as_deref().map(norm_path) == wps,
                editor: e,
            })
            .collect(),
        wrapper_path: wp.map(|p| p.to_string_lossy().to_string()),
    }
}

#[tauri::command]
fn connect_editors() -> Result<Vec<String>, String> {
    let w = wrap::ensure_installed()?;
    let mut done = vec![];
    for e in vscode::editors().into_iter().filter(|e| e.has_extension) {
        vscode::connect(Path::new(&e.settings), &w).map_err(|x| format!("{}: {x}", e.name))?;
        done.push(e.name);
    }
    if done.is_empty() {
        return Err("Не найден VS Code / Cursor с расширением Claude Code".into());
    }
    Ok(done)
}

#[tauri::command]
fn disconnect_editors() -> Result<Vec<String>, String> {
    let mut done = vec![];
    for e in vscode::editors().into_iter().filter(|e| e.wrapper.is_some()) {
        vscode::disconnect(Path::new(&e.settings)).map_err(|x| format!("{}: {x}", e.name))?;
        done.push(e.name);
    }
    Ok(done)
}

/// Открыть папку проекта в редакторе и затем чат (существующий или новый).
/// Работает в фоне: ждём окно с проектом, потом отправляем ссылку расширению.
fn open_chat_impl(app: &AppHandle, folder: String, session_id: Option<String>, editor: Option<String>) -> Result<(), String> {
    let folder_path = PathBuf::from(&folder);
    if !folder_path.is_dir() {
        return Err(format!("Папка проекта не найдена: {folder}"));
    }
    let eds: Vec<vscode::Editor> = vscode::editors()
        .into_iter()
        .filter(|e| e.has_extension && vscode::exe(&e.name).is_some())
        .collect();
    let ed = editor
        .as_deref()
        .and_then(|n| eds.iter().find(|e| e.name == n))
        .or_else(|| eds.first())
        .cloned()
        .ok_or("Не найден VS Code с расширением Claude Code")?;

    let name = folder_path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let was_open = vscode::window_open(&name);
    vscode::open_folder(&ed.name, &folder_path)?;

    if let Some(sid) = &session_id {
        let sid = sid.clone();
        let st = app.state::<AppState>();
        let acc = st.cfg().account_for(&folder, Some(&sid)).0.id.clone();
        let _ = st.update(|cfg| {
            cfg.last_used.insert(sid, acc);
            Ok(())
        });
    }

    let app = app.clone();
    std::thread::spawn(move || {
        match was_open {
            Some(true) => std::thread::sleep(Duration::from_millis(500)),
            Some(false) => {
                // ждём появления окна с проектом, затем даём расширению загрузиться
                let mut ok = false;
                for _ in 0..60 {
                    std::thread::sleep(Duration::from_millis(300));
                    if vscode::window_open(&name) == Some(true) {
                        ok = true;
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(if ok { 2500 } else { 500 }));
            }
            None => std::thread::sleep(Duration::from_millis(3500)),
        }
        if let Err(e) = vscode::open_chat_url(&ed, session_id.as_deref(), None) {
            err(&app, e);
        }
    });
    Ok(())
}

#[tauri::command]
fn open_chat(app: AppHandle, folder: String, session_id: Option<String>, editor: Option<String>) -> Result<(), String> {
    open_chat_impl(&app, folder, session_id, editor)
}

// ------------------------------------------------------------------ обновления

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Проверить, есть ли новая версия (None — актуальная).
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Скачать, проверить подпись, установить и перезапустить.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Обновлений нет")?;
    let progress = app.clone();
    let mut done: usize = 0;
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk;
                if let Some(t) = total {
                    let _ = progress.emit("update-progress", (done as f64 / t as f64 * 100.0).round());
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

// ------------------------------------------------------------------ трей

const TRAY_RECENT: usize = 8;

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let cfg = state.cfg();
    let recent: Vec<SessionInfo> = {
        let cache = state.cache.lock().unwrap();
        let mut all = cache.all();
        all.retain(|s| s.cwd.as_deref().map(|c| Path::new(c).is_dir()).unwrap_or(false));
        all.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        all.truncate(TRAY_RECENT);
        all
    };
    let has_editor = vscode::editors().iter().any(|e| e.has_extension);

    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "Открыть CC Deck", true, None::<&str>)?)?;
    if !recent.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        let head = if has_editor { "Продолжить в VS Code:" } else { "Продолжить в терминале:" };
        menu.append(&MenuItem::with_id(app, "recent-head", head, false, None::<&str>)?)?;
        for s in &recent {
            let cwd = s.cwd.clone().unwrap_or_default();
            let acc = cfg.account_for(&cwd, Some(&s.id)).0;
            let project = Path::new(&cwd).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default();
            let label = format!("{} — {} · {}", short(&session_label(s), 38), project, acc.name);
            menu.append(&MenuItem::with_id(app, format!("s:{}", s.id), label, true, None::<&str>)?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?)?;
    Ok(menu)
}

fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn on_tray_session(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let Ok(info) = state.session(id) else { return };
    let Some(cwd) = info.cwd.clone() else { return };
    let has_editor = vscode::editors().iter().any(|e| e.has_extension);
    let res = if has_editor {
        open_chat_impl(app, cwd, Some(id.to_string()), None)
    } else {
        resume_in_terminal(&state, id, None).map(|_| ())
    };
    if let Err(e) = res {
        show_main(app);
        err(app, e);
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// ------------------------------------------------------------------ запуск

/// `ccdeck --dump [query]` — аккаунты, сессии и т.п. в JSON (для отладки).
pub fn dump(query: Option<String>) {
    let cfg = Config::load(&wrap::app_dir().join("config.json"));
    let dirs: Vec<(String, PathBuf)> = cfg.accounts.iter().map(|a| (a.id.clone(), a.config_dir())).collect();
    let roots = sessions::projects_roots(&dirs.iter().map(|(_, d)| d.clone()).collect::<Vec<_>>());
    let mut cache = Cache::load(wrap::app_dir().join("sessions-cache-v2.json"));
    let t = std::time::Instant::now();
    let list = sessions::list(&mut cache, &roots);
    let list_ms = t.elapsed().as_millis();
    let found = query.map(|q| {
        let t = std::time::Instant::now();
        let ids = sessions::search(&cache, &q);
        serde_json::json!({ "query": q, "ids": ids, "ms": t.elapsed().as_millis() })
    });
    let out = serde_json::json!({
        "accounts": cfg.accounts.iter().map(accounts::status).collect::<Vec<_>>(),
        "roots": roots,
        "list_ms": list_ms,
        "sessions": list,
        "running": sessions::running(&dirs),
        "integration": integration_status(),
        "wrap_log": wrap::recent(10),
        "search": found,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let dir = wrap::app_dir();
    let cfg_path = dir.join("config.json");
    let state = AppState {
        cfg: Mutex::new(Config::load(&cfg_path)),
        cfg_path,
        cache: Mutex::new(Cache::load(dir.join("sessions-cache-v2.json"))),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_accounts,
            suggest_dir,
            add_account,
            repair_account,
            update_account,
            remove_account,
            set_default_account,
            set_binding,
            set_chat_account,
            login,
            list_sessions,
            search_sessions,
            get_runtime,
            delete_session,
            reveal,
            resume_session,
            new_session,
            integration_status,
            connect_editors,
            disconnect_editors,
            open_chat,
            app_version,
            check_update,
            install_update,
            claude_status,
            install_claude,
        ])
        .setup(|app| {
            // если обёртка уже подключена — держим её копию актуальной версии
            if vscode::editors().iter().any(|e| e.wrapper.is_some()) {
                let _ = wrap::ensure_installed();
            }
            let menu = tray_menu(app.handle())?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("CC Deck")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    id if id.starts_with("s:") => on_tray_session(app, &id[2..]),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = e
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // крестик прячет окно в трей, выход — через меню трея
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения");
}
