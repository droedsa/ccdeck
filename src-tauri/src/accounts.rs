//! Аккаунты: у каждого свой CLAUDE_CONFIG_DIR (логин), а история, проекты,
//! память и настройки общие — ссылки на основной ~/.claude.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Account {
    pub id: String,
    pub name: String,
    /// None — стандартный конфиг (~/.claude), CLAUDE_CONFIG_DIR не задаётся.
    pub dir: Option<String>,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Config {
    pub accounts: Vec<Account>,
    /// sessionId -> accountId, под каким аккаунтом сессию открывали последний раз
    #[serde(default)]
    pub last_used: HashMap<String, String>,
    /// нормализованный путь проекта -> accountId (действует и на вложенные папки)
    #[serde(default)]
    pub bindings: HashMap<String, String>,
    /// аккаунт для проектов без привязки (None — основной)
    #[serde(default)]
    pub default_account: Option<String>,
    /// sessionId -> accountId: аккаунт, выбранный для отдельного чата
    #[serde(default)]
    pub chat_bindings: HashMap<String, String>,
}

/// Почему выбран аккаунт.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Chat,
    Project,
    Default,
}

/// Путь для сравнения: прямые слэши, без хвостового слэша, на Windows — без учёта регистра.
pub fn norm_path(p: &str) -> String {
    let s = p.trim().replace('\\', "/");
    let s = s.strip_prefix("//?/").unwrap_or(&s).to_string();
    let s = if s.len() > 1 { s.trim_end_matches('/').to_string() } else { s };
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

impl Config {
    pub fn default_acc(&self) -> &Account {
        self.default_account
            .as_deref()
            .and_then(|id| self.find(id))
            .or_else(|| self.accounts.iter().find(|a| a.dir.is_none()))
            .unwrap_or(&self.accounts[0])
    }

    /// Привязка, действующая для пути: самая длинная совпадающая папка.
    pub fn binding_for(&self, path: &str) -> Option<(&str, &Account)> {
        let p = norm_path(path);
        self.bindings
            .iter()
            .filter(|(k, _)| p == **k || p.starts_with(&format!("{k}/")))
            .max_by_key(|(k, _)| k.len())
            .and_then(|(k, id)| self.find(id).map(|a| (k.as_str(), a)))
    }

    pub fn account_for_path(&self, path: &str) -> &Account {
        self.binding_for(path)
            .map(|(_, a)| a)
            .unwrap_or_else(|| self.default_acc())
    }

    /// Аккаунт для чата: выбранный для чата → проекта → по умолчанию.
    pub fn account_for(&self, path: &str, session: Option<&str>) -> (&Account, Source) {
        if let Some(a) = session.and_then(|s| self.chat_bindings.get(s)).and_then(|id| self.find(id)) {
            return (a, Source::Chat);
        }
        match self.binding_for(path) {
            Some((_, a)) => (a, Source::Project),
            None => (self.default_acc(), Source::Default),
        }
    }

    pub fn load(path: &Path) -> Config {
        let mut cfg: Config = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if cfg.accounts.is_empty() {
            cfg.accounts.push(Account {
                id: "main".into(),
                name: "Основной".into(),
                dir: None,
                color: "#d97757".into(),
            });
        }
        cfg
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let s = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, s).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn find(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn default_claude_dir() -> PathBuf {
    home().join(".claude")
}

impl Account {
    pub fn config_dir(&self) -> PathBuf {
        match &self.dir {
            Some(d) => PathBuf::from(d),
            None => default_claude_dir(),
        }
    }
    /// Где лежит .claude.json: без CLAUDE_CONFIG_DIR — в домашней папке, иначе внутри конфига.
    pub fn json_path(&self) -> PathBuf {
        match &self.dir {
            Some(d) => PathBuf::from(d).join(".claude.json"),
            None => home().join(".claude.json"),
        }
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Usage {
    pub five_hour: Option<f64>,
    pub five_hour_resets: Option<String>,
    pub seven_day: Option<f64>,
    pub seven_day_resets: Option<String>,
    pub fetched_ms: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AccountStatus {
    pub id: String,
    pub name: String,
    pub color: String,
    pub dir: String,
    pub is_default: bool,
    pub exists: bool,
    pub logged_in: bool,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub org: Option<String>,
    pub plan: Option<String>,
    pub usage: Option<Usage>,
    /// какие общие папки реально ссылаются на основной конфиг
    pub shared_ok: bool,
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string())
}

pub fn status(acc: &Account) -> AccountStatus {
    let cfg_dir = acc.config_dir();
    let json = read_json(&acc.json_path());
    let oauth = json.as_ref().and_then(|j| j.get("oauthAccount")).cloned();
    let creds_file = cfg_dir.join(".credentials.json").exists();
    // На macOS токены лежат в Keychain, файла нет — судим по oauthAccount.
    let logged_in = oauth.is_some() && (cfg!(target_os = "macos") || creds_file);

    let usage = json.as_ref().and_then(|j| {
        let u = j.get("cachedUsageUtilization")?;
        // кэш должен относиться к этому же аккаунту
        let acc_uuid = oauth.as_ref().and_then(|o| s(o, "accountUuid"));
        if acc_uuid.is_some() && s(u, "accountUuid") != acc_uuid {
            return None;
        }
        let ut = u.get("utilization")?;
        let pick = |k: &str| -> (Option<f64>, Option<String>) {
            match ut.get(k) {
                Some(w) if !w.is_null() => (
                    w.get("utilization").and_then(|x| x.as_f64()),
                    s(w, "resets_at"),
                ),
                _ => (None, None),
            }
        };
        let (fh, fhr) = pick("five_hour");
        let (sd, sdr) = pick("seven_day");
        Some(Usage {
            five_hour: fh,
            five_hour_resets: fhr,
            seven_day: sd,
            seven_day_resets: sdr,
            fetched_ms: u.get("fetchedAtMs").and_then(|x| x.as_u64()),
        })
    });

    let shared_ok = acc.dir.is_none() || {
        let main = fs::canonicalize(default_claude_dir().join("projects")).ok();
        let mine = fs::canonicalize(cfg_dir.join("projects")).ok();
        main.is_some() && main == mine
    };

    AccountStatus {
        id: acc.id.clone(),
        name: acc.name.clone(),
        color: acc.color.clone(),
        dir: cfg_dir.to_string_lossy().to_string(),
        is_default: acc.dir.is_none(),
        exists: cfg_dir.exists(),
        logged_in,
        email: oauth.as_ref().and_then(|o| s(o, "emailAddress")),
        display_name: oauth.as_ref().and_then(|o| s(o, "displayName")),
        org: oauth.as_ref().and_then(|o| s(o, "organizationName")),
        plan: oauth
            .as_ref()
            .and_then(|o| s(o, "organizationRateLimitTier").or_else(|| s(o, "seatTier"))),
        usage,
        shared_ok,
    }
}

/// Папки, общие для всех аккаунтов (ссылки на основной ~/.claude).
const SHARED_DIRS: &[&str] = &[
    "projects",
    "file-history",
    "todos",
    "plans",
    "skills",
    "agents",
    "commands",
    "plugins",
    "output-styles",
];
/// Файлы, общие для всех аккаунтов.
const SHARED_FILES: &[&str] = &["settings.json", "CLAUDE.md", "keybindings.json"];

/// Ключи .claude.json, которые переносим во второй аккаунт (без логина и кэшей аккаунта):
/// доверенные папки, MCP-серверы, флаги онбординга.
const SEED_KEYS: &[&str] = &[
    "projects",
    "mcpServers",
    "hasCompletedOnboarding",
    "lastOnboardingVersion",
    "githubRepoPaths",
    "installMethod",
    "autoUpdates",
    "shiftEnterKeyBindingInstalled",
    "theme",
];

fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        junction::create(target, link)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
}

/// Возвращает способ, которым удалось связать файл.
fn link_file(target: &Path, link: &Path) -> std::io::Result<&'static str> {
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(target, link).is_ok() {
            return Ok("symlink");
        }
        if fs::hard_link(target, link).is_ok() {
            return Ok("hardlink");
        }
        fs::copy(target, link).map(|_| "копия")
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).map(|_| "symlink")
    }
}

/// Готовит папку второго аккаунта: ссылки на общие данные + .claude.json без логина.
pub fn prepare_dir(dir: &Path) -> Result<Vec<String>, String> {
    let main = default_claude_dir();
    let main_c = fs::canonicalize(&main).unwrap_or(main.clone());
    let dir_c = fs::canonicalize(dir).unwrap_or(dir.to_path_buf());
    if dir_c == main_c {
        return Err("Это основной конфиг ~/.claude — выберите другую папку".into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("Не удалось создать {}: {e}", dir.display()))?;
    let mut report = vec![];

    for name in SHARED_DIRS {
        let target = main.join(name);
        let link = dir.join(name);
        if let Err(e) = fs::create_dir_all(&target) {
            report.push(format!("⚠ {name}: {e}"));
            continue;
        }
        if fs::symlink_metadata(&link).is_ok() {
            let same = fs::canonicalize(&link).ok() == fs::canonicalize(&target).ok();
            report.push(if same {
                format!("✓ {name}: уже общий")
            } else {
                format!("⚠ {name}: уже есть своя папка, не трогаю")
            });
            continue;
        }
        match link_dir(&target, &link) {
            Ok(()) => report.push(format!("✓ {name}: общий")),
            Err(e) => report.push(format!("⚠ {name}: {e}")),
        }
    }

    for name in SHARED_FILES {
        let target = main.join(name);
        if !target.exists() {
            continue;
        }
        let link = dir.join(name);
        if fs::symlink_metadata(&link).is_ok() {
            report.push(format!("• {name}: уже есть, не трогаю"));
            continue;
        }
        match link_file(&target, &link) {
            Ok(how) => report.push(format!("✓ {name}: общий ({how})")),
            Err(e) => report.push(format!("⚠ {name}: {e}")),
        }
    }

    let json_path = dir.join(".claude.json");
    if !json_path.exists() {
        let src = read_json(&home().join(".claude.json")).unwrap_or(Value::Object(Default::default()));
        let mut seeded = serde_json::Map::new();
        for k in SEED_KEYS {
            if let Some(v) = src.get(*k) {
                seeded.insert((*k).to_string(), v.clone());
            }
        }
        let n = seeded
            .get("projects")
            .and_then(|p| p.as_object())
            .map(|o| o.len())
            .unwrap_or(0);
        fs::write(
            &json_path,
            serde_json::to_string_pretty(&Value::Object(seeded)).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        report.push(format!(
            "✓ .claude.json: перенесены доверенные папки ({n}) и MCP-серверы, без логина"
        ));
    } else {
        report.push("• .claude.json: уже есть, не трогаю".into());
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_link_shares_content_and_removes_cleanly() {
        let base = std::env::temp_dir().join(format!("ccdeck-test-{}", std::process::id()));
        let target = base.join("target");
        let link = base.join("link");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("a.txt"), "hello").unwrap();

        link_dir(&target, &link).unwrap();
        assert_eq!(fs::read_to_string(link.join("a.txt")).unwrap(), "hello");
        fs::write(link.join("b.txt"), "via link").unwrap();
        assert!(target.join("b.txt").exists());
        assert_eq!(fs::canonicalize(&link).unwrap(), fs::canonicalize(&target).unwrap());

        // удаление ссылки не должно трогать содержимое цели
        #[cfg(windows)]
        fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        fs::remove_file(&link).unwrap();
        assert!(target.join("a.txt").exists());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn file_link_works() {
        let base = std::env::temp_dir().join(format!("ccdeck-ftest-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        let t = base.join("settings.json");
        fs::write(&t, "{}").unwrap();
        let how = link_file(&t, &base.join("copy.json")).unwrap();
        println!("file link method: {how}");
        assert_eq!(fs::read_to_string(base.join("copy.json")).unwrap(), "{}");
        fs::remove_dir_all(&base).unwrap();
    }
}
