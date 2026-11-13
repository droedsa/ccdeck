//! Режим обёртки для расширения Claude Code в VS Code.
//!
//! Расширение с настройкой `claudeCode.claudeProcessWrapper` запускает
//! `<обёртка> <путь-к-claude> <аргументы…>` в папке проекта. Обёртка выбирает
//! аккаунт по привязке проекта в CC Deck, выставляет CLAUDE_CONFIG_DIR и
//! запускает настоящий claude, прозрачно передавая ввод/вывод и код выхода.

use crate::accounts::Config;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub const WRAP_NAME: &str = "ccdeck-wrap";

pub fn app_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(crate::accounts::home)
        .join("ccdeck")
}

pub fn log_path() -> PathBuf {
    app_dir().join("wrap-log.jsonl")
}

/// Запущены ли мы как обёртка (по имени файла).
pub fn is_wrapper_invocation() -> bool {
    let by_arg0 = std::env::args_os()
        .next()
        .map(|a| {
            Path::new(&a)
                .file_stem()
                .map(|s| s.to_string_lossy().eq_ignore_ascii_case(WRAP_NAME))
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let by_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().eq_ignore_ascii_case(WRAP_NAME)))
        .unwrap_or(false);
    by_arg0 || by_exe
}

/// id чата из аргументов: `--resume=<id>`, `--resume <id>`, `--session-id=<id>`.
pub fn session_from_args(args: &[String]) -> Option<String> {
    let is_id = |s: &str| s.len() == 36 && s.chars().filter(|c| *c == '-').count() == 4;
    for (i, a) in args.iter().enumerate() {
        for flag in ["--resume", "-r", "--session-id"] {
            if let Some(v) = a.strip_prefix(&format!("{flag}=")) {
                if is_id(v) {
                    return Some(v.to_string());
                }
            }
            if a == flag {
                if let Some(v) = args.get(i + 1).filter(|v| is_id(v)) {
                    return Some(v.clone());
                }
            }
        }
    }
    None
}

fn log(cwd: &str, account: &str, account_id: &str, source: &str, session: Option<&str>, args: &[String]) {
    let path = log_path();
    if fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // только имена флагов, без значений (в них может быть текст)
    let shown: Vec<String> = args
        .iter()
        .filter(|a| a.starts_with("--"))
        .map(|a| a.split('=').next().unwrap_or("").to_string())
        .take(12)
        .collect();
    let line = serde_json::json!({
        "t": now, "cwd": cwd, "account": account, "account_id": account_id,
        "source": source, "session": session, "args": shown
    });
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn main() -> ! {
    main_from(std::env::args().skip(1).collect())
}

pub fn main_from(mut args: Vec<String>) -> ! {
    if args.is_empty() {
        eprintln!("ccdeck-wrap: ожидается путь к claude первым аргументом");
        std::process::exit(2);
    }
    let claude = args.remove(0);
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let cfg = Config::load(&app_dir().join("config.json"));
    let session = session_from_args(&args);
    let (acc, source) = cfg.account_for(&cwd, session.as_deref());
    let acc = acc.clone();
    let source = serde_json::to_value(source).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    log(&cwd, &acc.name, &acc.id, &source, session.as_deref(), &args);

    let mut cmd = Command::new(&claude);
    cmd.args(&args);
    match &acc.dir {
        Some(d) => {
            cmd.env("CLAUDE_CONFIG_DIR", d);
        }
        None => {
            cmd.env_remove("CLAUDE_CONFIG_DIR");
        }
    }
    run(cmd)
}

#[cfg(unix)]
fn run(mut cmd: Command) -> ! {
    use std::os::unix::process::CommandExt;
    // exec заменяет процесс обёртки — сигналы и ввод/вывод идут напрямую в claude
    let err = cmd.exec();
    eprintln!("ccdeck-wrap: не удалось запустить claude: {err}");
    std::process::exit(127);
}

#[cfg(windows)]
fn run(mut cmd: Command) -> ! {
    // Кладём себя в Job Object с KILL_ON_JOB_CLOSE: дочерние процессы наследуют job,
    // и если расширение завершит обёртку, claude и его подпроцессы завершатся вместе с ней.
    unsafe {
        use windows_sys::Win32::System::JobObjects::*;
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if !job.is_null() {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok != 0 {
                AssignProcessToJobObject(job, GetCurrentProcess());
            }
            // дескриптор job намеренно не закрываем: он закроется при выходе процесса
        }
    }
    // У обёртки нет своей консоли (GUI-приложение), поэтому без этого флага
    // Windows открыл бы для claude видимое окно консоли. Ввод/вывод всё равно
    // передаются через унаследованные дескрипторы.
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    match cmd.status() {
        Ok(st) => std::process::exit(st.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("ccdeck-wrap: не удалось запустить claude: {e}");
            std::process::exit(127)
        }
    }
}

/// Кладёт копию (Windows) или ссылку (macOS/Linux) на исполняемый файл приложения
/// под именем ccdeck-wrap — путь к ней прописывается в VS Code.
pub fn ensure_installed() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = app_dir().join("bin");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let dst = dir.join(format!("{WRAP_NAME}.exe"));
        let same = match (fs::metadata(&exe), fs::metadata(&dst)) {
            (Ok(a), Ok(b)) => a.len() == b.len() && b.modified().ok() >= a.modified().ok(),
            _ => false,
        };
        if !same {
            // если файл занят запущенной обёрткой — пишем рядом и подменяем
            let tmp = dir.join(format!("{WRAP_NAME}.new"));
            fs::copy(&exe, &tmp).map_err(|e| e.to_string())?;
            if fs::rename(&tmp, &dst).is_err() {
                let old = dir.join(format!("{WRAP_NAME}.old-{}.exe", std::process::id()));
                let _ = fs::rename(&dst, &old);
                fs::rename(&tmp, &dst).map_err(|e| e.to_string())?;
            }
        }
        // подчищаем старые копии
        if let Ok(rd) = fs::read_dir(&dir) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().contains(".old-") {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        Ok(dst)
    }
    #[cfg(unix)]
    {
        let dst = dir.join(WRAP_NAME);
        let current = fs::read_link(&dst).ok();
        if current.as_deref() != Some(exe.as_path()) {
            let _ = fs::remove_file(&dst);
            std::os::unix::fs::symlink(&exe, &dst).map_err(|e| e.to_string())?;
        }
        Ok(dst)
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct LogEntry {
    pub t: u64,
    pub cwd: String,
    pub account: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub session: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "072f9573-767b-4570-b703-b12b428e47f5";

    #[test]
    fn session_id_parsing() {
        let v = |a: &[&str]| session_from_args(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(v(&["--output-format=stream-json", &format!("--resume={ID}")]).as_deref(), Some(ID));
        assert_eq!(v(&["--resume", ID]).as_deref(), Some(ID));
        assert_eq!(v(&[&format!("--session-id={ID}")]).as_deref(), Some(ID));
        assert_eq!(v(&["--continue"]), None);
        assert_eq!(v(&["--resume=не-id"]), None);
    }
}

/// Последние запуски через обёртку (новые первыми).
pub fn recent(limit: usize) -> Vec<LogEntry> {
    let Ok(text) = fs::read_to_string(log_path()) else { return vec![] };
    text.lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
        .take(limit)
        .collect()
}
