//! Запуск `claude` в системном терминале под нужным аккаунтом.
//! Команда пишется во временный скрипт — так не нужно экранировать пути
//! с пробелами и кириллицей в аргументах терминала.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Переменные, которые подставляет хост-сессия Claude (desktop/IDE).
/// Если приложение запущено из такой среды, их нельзя передавать дальше.
pub const HOST_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_USER_EMAIL",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_PID",
];

pub struct Launch<'a> {
    pub cwd: &'a Path,
    /// None — стандартный ~/.claude (переменная CLAUDE_CONFIG_DIR снимается)
    pub config_dir: Option<&'a Path>,
    pub args: Vec<String>,
    pub title: String,
    /// полный путь к claude
    pub exe: PathBuf,
    /// вместо запуска claude выполнить эту строку (например, установку Claude Code)
    pub raw: Option<String>,
}

fn script_path(ext: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join("ccdeck");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // подчищаем старые скрипты
    if let Ok(rd) = fs::read_dir(&dir) {
        let now = SystemTime::now();
        for e in rd.flatten() {
            if let Ok(md) = e.metadata() {
                if let Ok(m) = md.modified() {
                    if now.duration_since(m).map(|d| d.as_secs() > 86400).unwrap_or(false) {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
    }
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(dir.join(format!("run-{n}.{ext}")))
}

pub fn open(l: Launch) -> Result<(), String> {
    if !l.cwd.is_dir() {
        return Err(format!("Папка проекта не найдена: {}", l.cwd.display()));
    }
    #[cfg(windows)]
    return open_windows(l);
    #[cfg(target_os = "macos")]
    return open_macos(l);
    #[cfg(all(unix, not(target_os = "macos")))]
    return open_linux(l);
}

// ---------------------------------------------------------------- Windows
#[cfg(windows)]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(windows)]
fn ps_script(l: &Launch) -> String {
    let mut ps = String::new();
    ps.push_str(&format!("$Host.UI.RawUI.WindowTitle = {}\r\n", ps_quote(&l.title)));
    for v in HOST_VARS {
        ps.push_str(&format!("Remove-Item Env:\\{v} -ErrorAction SilentlyContinue\r\n"));
    }
    match l.config_dir {
        Some(d) => ps.push_str(&format!(
            "$env:CLAUDE_CONFIG_DIR = {}\r\n",
            ps_quote(&d.to_string_lossy())
        )),
        None => ps.push_str("Remove-Item Env:\\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue\r\n"),
    }
    ps.push_str(&format!(
        "Set-Location -LiteralPath {}\r\n",
        ps_quote(&l.cwd.to_string_lossy())
    ));
    match &l.raw {
        Some(r) => {
            ps.push_str(r);
            ps.push_str("\r\n");
        }
        None => {
            let args: Vec<String> = l.args.iter().map(|a| ps_quote(a)).collect();
            ps.push_str(&format!("& {} {}\r\n", ps_quote(&l.exe.to_string_lossy()), args.join(" ")));
        }
    }
    ps
}

#[cfg(windows)]
fn write_ps(ps: &str) -> Result<PathBuf, String> {
    let script = script_path("ps1")?;
    // UTF-8 с BOM — иначе Windows PowerShell 5 читает кириллицу как ANSI
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(ps.as_bytes());
    fs::write(&script, bytes).map_err(|e| e.to_string())?;
    Ok(script)
}

#[cfg(windows)]
fn open_windows(l: Launch) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let script = write_ps(&ps_script(&l))?;
    let script_s = script.to_string_lossy().to_string();

    let shell = if which("pwsh.exe").is_some() { "pwsh.exe" } else { "powershell.exe" };
    let ps_args = [
        "-NoLogo",
        "-NoExit",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script_s.as_str(),
    ];

    if let Some(wt) = which("wt.exe") {
        let r = Command::new(wt)
            .args(["-w", "0", "new-tab", "--title", &l.title, shell])
            .args(ps_args)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        if r.is_ok() {
            return Ok(());
        }
    }
    Command::new(shell)
        .args(ps_args)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Не удалось открыть терминал: {e}"))
}

#[cfg(windows)]
fn which(exe: &str) -> Option<PathBuf> {
    if let Some(local) = dirs::data_local_dir() {
        let p = local.join("Microsoft").join("WindowsApps").join(exe);
        if p.exists() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe))
        .find(|p| p.is_file())
}

// ---------------------------------------------------------------- macOS / Linux
#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn unix_script(l: &Launch) -> Result<PathBuf, String> {
    let mut sh = String::from("# создано ccdeck\n");
    for v in HOST_VARS {
        sh.push_str(&format!("unset {v}\n"));
    }
    match l.config_dir {
        Some(d) => sh.push_str(&format!(
            "export CLAUDE_CONFIG_DIR={}\n",
            sh_quote(&d.to_string_lossy())
        )),
        None => sh.push_str("unset CLAUDE_CONFIG_DIR\n"),
    }
    sh.push_str(&format!("printf '\\033]0;%s\\007' {}\n", sh_quote(&l.title)));
    sh.push_str(&format!("cd {} && clear\n", sh_quote(&l.cwd.to_string_lossy())));
    match &l.raw {
        Some(r) => {
            sh.push_str(r);
            sh.push('\n');
        }
        None => {
            let args: Vec<String> = l.args.iter().map(|a| sh_quote(a)).collect();
            sh.push_str(&format!("{} {}\n", sh_quote(&l.exe.to_string_lossy()), args.join(" ")));
        }
    }
    let p = script_path("sh")?;
    fs::write(&p, sh).map_err(|e| e.to_string())?;
    Ok(p)
}

#[cfg(target_os = "macos")]
fn open_macos(l: Launch) -> Result<(), String> {
    let script = unix_script(&l)?;
    // source — чтобы скрипт выполнился в обычном интерактивном шелле (PATH, алиасы)
    let cmd = format!("source {}", sh_quote(&script.to_string_lossy()));
    let apple = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let osa = format!("tell application \"Terminal\"\n activate\n do script \"{apple}\"\nend tell");
    Command::new("osascript")
        .arg("-e")
        .arg(osa)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Не удалось открыть терминал: {e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_linux(l: Launch) -> Result<(), String> {
    let script = unix_script(&l)?;
    let inner = format!(
        "source {}; exec \"${{SHELL:-bash}}\"",
        sh_quote(&script.to_string_lossy())
    );
    for (term, pre) in [
        ("x-terminal-emulator", vec!["-e"]),
        ("gnome-terminal", vec!["--"]),
        ("konsole", vec!["-e"]),
        ("xterm", vec!["-e"]),
    ] {
        let r = Command::new(term).args(pre).args(["bash", "-lc", &inner]).spawn();
        if r.is_ok() {
            return Ok(());
        }
    }
    Err("Не найден терминал (x-terminal-emulator, gnome-terminal, konsole, xterm)".into())
}

/// Открыть папку в проводнике / Finder.
pub fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let mut c = Command::new("explorer.exe");
    #[cfg(target_os = "macos")]
    let mut c = Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut c = Command::new("xdg-open");
    c.arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Скрипт должен перейти в папку с кириллицей/пробелами/апострофом,
    /// выставить CLAUDE_CONFIG_DIR, снять переменные хост-сессии и вызвать claude.
    #[test]
    fn ps_script_runs_with_unicode_paths() {
        let cwd = std::env::temp_dir().join("ccdeck тест 'кв' папка");
        fs::create_dir_all(&cwd).unwrap();
        let cfg = PathBuf::from(r"C:\Users\x y\.claude-раб");
        let l = Launch {
            cwd: &cwd,
            config_dir: Some(&cfg),
            args: vec!["--version".into()],
            title: "Тест · 'проверка'".into(),
            exe: crate::cli::find().expect("claude").path,
            raw: None,
        };
        let mut ps = ps_script(&l);
        ps.push_str("Write-Output \"CFG=$env:CLAUDE_CONFIG_DIR\"\r\n");
        ps.push_str("Write-Output \"PWD=$((Get-Location).Path)\"\r\n");
        ps.push_str("Write-Output \"HOST=$env:CLAUDECODE\"\r\n");
        let script = write_ps(&ps).unwrap();
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .env("CLAUDECODE", "1")
            .output()
            .unwrap();
        // вывод консоли PowerShell 5 в OEM-кодировке, сравниваем только ASCII-части
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        println!("{text}\n{}", String::from_utf8_lossy(&out.stderr));
        assert!(text.contains("Claude Code"), "claude не запустился");
        assert!(text.contains(r"CFG=C:\Users\x y\.claude-"), "нет CLAUDE_CONFIG_DIR");
        assert!(text.contains("ccdeck "), "не перешли в папку проекта");
        assert!(text.contains("HOST=\r") || text.contains("HOST=\n"), "CLAUDECODE не снят");
        let _ = fs::remove_file(script);
        let _ = fs::remove_dir(&cwd);
    }

    #[test]
    fn default_account_unsets_config_dir() {
        let cwd = std::env::temp_dir();
        let l = Launch { cwd: &cwd, config_dir: None, args: vec![], title: "t".into(), exe: PathBuf::from("claude"), raw: None };
        assert!(ps_script(&l).contains(r"Remove-Item Env:\CLAUDE_CONFIG_DIR"));
    }
}
