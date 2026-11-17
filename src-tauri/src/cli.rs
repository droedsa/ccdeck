//! Где взять `claude`.
//!
//! 1. Установленный CLI: PATH и стандартные папки (нативный установщик, npm, WinGet, Homebrew).
//!    У GUI-приложений PATH бывает урезан (особенно на macOS), поэтому папки проверяем явно.
//! 2. Если CLI нет — `claude`, встроенный в расширение Claude Code для VS Code / Cursor.
//! 3. Иначе — не найден: интерфейс предложит установить Claude Code.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Clone, Debug)]
pub struct ClaudeBin {
    pub path: PathBuf,
    /// "cli" — установленный Claude Code, "vscode" — из расширения редактора
    pub source: &'static str,
}

#[cfg(windows)]
const NAMES: &[&str] = &["claude.exe", "claude.cmd"];
#[cfg(unix)]
const NAMES: &[&str] = &["claude"];

fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs_: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();
    dirs_.push(home.join(".local").join("bin"));
    #[cfg(windows)]
    {
        if let Some(a) = dirs::data_dir() {
            dirs_.push(a.join("npm"));
        }
        if let Some(l) = dirs::data_local_dir() {
            dirs_.push(l.join("Microsoft").join("WinGet").join("Links"));
        }
    }
    #[cfg(unix)]
    {
        dirs_.push(PathBuf::from("/opt/homebrew/bin"));
        dirs_.push(PathBuf::from("/usr/local/bin"));
        dirs_.push(home.join(".npm-global").join("bin"));
        dirs_.push(home.join(".claude").join("local"));
    }
    dirs_
}

fn find_cli() -> Option<PathBuf> {
    for d in candidate_dirs() {
        for n in NAMES {
            let p = d.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn platform_dir() -> String {
    let os = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    format!("{os}-{arch}")
}

/// `claude` из самой свежей установленной версии расширения.
fn find_in_extensions() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let plat = platform_dir();
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = vec![];
    for ext_root in [".vscode", ".vscode-insiders", ".cursor"] {
        let Ok(rd) = fs::read_dir(home.join(ext_root).join("extensions")) else { continue };
        for e in rd.flatten() {
            if !e.file_name().to_string_lossy().to_lowercase().starts_with("anthropic.claude-code") {
                continue;
            }
            // платформенная сборка расширения: resources/native-binary/claude(.exe);
            // универсальная: resources/native-binaries/<os-arch>/claude(.exe)
            let res = e.path().join("resources");
            for p in [res.join("native-binary").join(exe), res.join("native-binaries").join(&plat).join(exe)] {
                if p.is_file() {
                    let t = fs::metadata(e.path()).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    found.push((t, p));
                    break;
                }
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().next().map(|(_, p)| p)
}

pub fn find() -> Option<ClaudeBin> {
    if let Some(p) = find_cli() {
        return Some(ClaudeBin { path: p, source: "cli" });
    }
    find_in_extensions().map(|p| ClaudeBin { path: p, source: "vscode" })
}

pub fn require() -> Result<ClaudeBin, String> {
    find().ok_or_else(|| {
        "Claude Code не установлен. Нажмите «Установить Claude Code» вверху окна CC Deck.".to_string()
    })
}

/// Официальная команда установки для терминала этой ОС.
pub fn install_command() -> &'static str {
    if cfg!(windows) {
        "irm https://claude.ai/install.ps1 | iex"
    } else {
        "curl -fsSL https://claude.ai/install.sh | bash"
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_claude_on_this_machine() {
        let b = super::find();
        println!("claude: {b:?}");
        assert!(b.is_some(), "на машине разработчика claude установлен");
        // запасной вариант: claude из расширения VS Code (если оно установлено)
        let ext = super::find_in_extensions();
        println!("из расширения: {ext:?}");
        if let Some(p) = ext {
            let out = std::process::Command::new(&p).arg("--version").output().unwrap();
            let v = String::from_utf8_lossy(&out.stdout);
            println!("версия: {v}");
            assert!(v.contains("Claude Code"));
        }
    }
}
