//! Интеграция с VS Code (и Cursor / Insiders).
//!
//! - Подключение: в пользовательский settings.json пишется
//!   `claudeCode.claudeProcessWrapper` = путь к обёртке CC Deck. Обёртка выбирает
//!   аккаунт по папке проекта. settings.json — это JSONC (с комментариями),
//!   поэтому правим только один ключ прямо в тексте.
//! - Открытие чата: окно с папкой проекта + ссылка
//!   `vscode://anthropic.claude-code/open?session=<id>`.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const WRAPPER_KEY: &str = "claudeCode.claudeProcessWrapper";
pub const ENV_KEY: &str = "claudeCode.environmentVariables";
const VAR: &str = "CLAUDE_CONFIG_DIR";

#[derive(Serialize, Clone, Debug)]
pub struct Editor {
    pub name: String,
    pub settings: String,
    pub has_extension: bool,
    /// текущее значение claudeProcessWrapper
    pub wrapper: Option<String>,
    /// CLAUDE_CONFIG_DIR, заданный вручную в claudeCode.environmentVariables
    pub env_config_dir: Option<String>,
    /// схема ссылок: vscode / vscode-insiders / cursor
    pub scheme: String,
}

struct EditorDef {
    name: &'static str,
    folder: &'static str,
    ext: &'static str,
    scheme: &'static str,
}

const DEFS: &[EditorDef] = &[
    EditorDef { name: "VS Code", folder: "Code", ext: ".vscode", scheme: "vscode" },
    EditorDef { name: "VS Code Insiders", folder: "Code - Insiders", ext: ".vscode-insiders", scheme: "vscode-insiders" },
    EditorDef { name: "Cursor", folder: "Cursor", ext: ".cursor", scheme: "cursor" },
];

fn settings_base() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        dirs::home_dir().map(|h| h.join("Library").join("Application Support"))
    } else {
        dirs::config_dir()
    }
}

fn has_claude_ext(ext_dir: &Path) -> bool {
    fs::read_dir(ext_dir)
        .map(|rd| {
            rd.flatten().any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with("anthropic.claude-code")
            })
        })
        .unwrap_or(false)
}

pub fn editors() -> Vec<Editor> {
    let (Some(base), Some(home)) = (settings_base(), dirs::home_dir()) else {
        return vec![];
    };
    DEFS.iter()
        .filter_map(|d| {
            let user = base.join(d.folder).join("User");
            if !user.is_dir() {
                return None;
            }
            let settings = user.join("settings.json");
            let text = fs::read_to_string(&settings).unwrap_or_default();
            let parsed = parse(&text);
            Some(Editor {
                name: d.name.into(),
                settings: settings.to_string_lossy().into(),
                has_extension: has_claude_ext(&home.join(d.ext).join("extensions")),
                wrapper: parsed
                    .as_ref()
                    .and_then(|v| v.get(WRAPPER_KEY))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                env_config_dir: parsed.as_ref().and_then(env_dir),
                scheme: d.scheme.into(),
            })
        })
        .collect()
}

fn parse(text: &str) -> Option<Value> {
    if text.trim().is_empty() {
        return Some(json!({}));
    }
    serde_json::from_str(&strip_jsonc(text)).ok()
}

fn env_dir(v: &Value) -> Option<String> {
    v.get(ENV_KEY)?
        .as_array()?
        .iter()
        .find(|e| e.get("name").and_then(|n| n.as_str()) == Some(VAR))
        .and_then(|e| e.get("value").and_then(|x| x.as_str()))
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
}

// ------------------------------------------------------------------ правка settings.json

/// Установить (Some) или удалить (None) ключ верхнего уровня, не трогая остальной текст.
pub fn set_key(text: &str, key: &str, value: Option<&Value>) -> Result<String, String> {
    let parsed = parse(text).ok_or("Не удалось разобрать settings.json")?;
    if !parsed.is_object() {
        return Err("settings.json должен быть объектом".into());
    }
    let found = find_member(text, key);
    match (value, found) {
        (Some(v), Some((_, vs, ve))) => Ok(format!("{}{}{}", &text[..vs], render(v), &text[ve..])),
        (Some(v), None) => {
            if text.trim().is_empty() {
                return Ok(format!("{{\n  \"{key}\": {}\n}}\n", render(v)));
            }
            let open = first_brace(text).ok_or("В settings.json не найден объект")?;
            let comma = if parsed.as_object().map(|o| o.is_empty()).unwrap_or(true) { "" } else { "," };
            Ok(format!(
                "{}\n  \"{key}\": {}{comma}{}",
                &text[..open + 1],
                render(v),
                &text[open + 1..]
            ))
        }
        (None, None) => Ok(text.to_string()),
        (None, Some((ks, _, ve))) => {
            // убираем член вместе с запятой: после него, а если её нет — перед ним
            let b = text.as_bytes();
            let mut end = ve;
            while end < b.len() && (b[end] == b' ' || b[end] == b'\t') {
                end += 1;
            }
            if end < b.len() && b[end] == b',' {
                end += 1;
                let mut start = ks;
                // забираем отступ и перевод строки перед ключом
                while start > 0 && (b[start - 1] == b' ' || b[start - 1] == b'\t') {
                    start -= 1;
                }
                if start > 0 && b[start - 1] == b'\n' {
                    start -= 1;
                    if start > 0 && b[start - 1] == b'\r' {
                        start -= 1;
                    }
                }
                return Ok(format!("{}{}", &text[..start], &text[end..]));
            }
            let mut start = ks;
            while start > 0 && (b[start - 1] as char).is_whitespace() {
                start -= 1;
            }
            if start > 0 && b[start - 1] == b',' {
                start -= 1;
            }
            Ok(format!("{}{}", &text[..start], &text[ve..]))
        }
    }
}

fn render(v: &Value) -> String {
    match v {
        Value::Array(items) if !items.is_empty() => {
            let lines: Vec<String> = items
                .iter()
                .map(|i| format!("    {}", serde_json::to_string(i).unwrap()))
                .collect();
            format!("[\n{}\n  ]", lines.join(",\n"))
        }
        _ => serde_json::to_string(v).unwrap(),
    }
}

/// Убрать CLAUDE_CONFIG_DIR из claudeCode.environmentVariables (остальные переменные остаются).
fn drop_env_dir(text: &str) -> Result<String, String> {
    let parsed = parse(text).ok_or("Не удалось разобрать settings.json")?;
    let Some(arr) = parsed.get(ENV_KEY).and_then(|v| v.as_array()) else {
        return Ok(text.into());
    };
    let rest: Vec<Value> = arr
        .iter()
        .filter(|e| e.get("name").and_then(|n| n.as_str()) != Some(VAR))
        .cloned()
        .collect();
    if rest.len() == arr.len() {
        return Ok(text.into());
    }
    if rest.is_empty() {
        set_key(text, ENV_KEY, None)
    } else {
        set_key(text, ENV_KEY, Some(&Value::Array(rest)))
    }
}

fn save_checked(path: &Path, new: &str, check: impl Fn(&Value) -> bool) -> Result<(), String> {
    let v = parse(new).ok_or("Проверка после правки не прошла, settings.json не изменён")?;
    if !check(&v) {
        return Err("Проверка после правки не прошла, settings.json не изменён".into());
    }
    if path.exists() {
        let bak = path.with_extension("json.ccdeck-bak");
        if !bak.exists() {
            fs::copy(path, &bak).map_err(|e| e.to_string())?;
        }
    } else if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(path, new).map_err(|e| e.to_string())
}

/// Подключить: прописать обёртку и убрать ручной CLAUDE_CONFIG_DIR (иначе он бы мешал).
pub fn connect(settings: &Path, wrapper: &Path) -> Result<(), String> {
    let text = fs::read_to_string(settings).unwrap_or_default();
    let w = wrapper.to_string_lossy().to_string();
    let new = set_key(&text, WRAPPER_KEY, Some(&Value::String(w.clone())))?;
    let new = drop_env_dir(&new)?;
    save_checked(settings, &new, |v| {
        v.get(WRAPPER_KEY).and_then(|x| x.as_str()) == Some(w.as_str()) && env_dir(v).is_none()
    })
}

pub fn disconnect(settings: &Path) -> Result<(), String> {
    let text = fs::read_to_string(settings).unwrap_or_default();
    let new = set_key(&text, WRAPPER_KEY, None)?;
    save_checked(settings, &new, |v| v.get(WRAPPER_KEY).is_none())
}

// ------------------------------------------------------------------ запуск VS Code

/// Исполняемый файл редактора.
pub fn exe(name: &str) -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = vec![];
    #[cfg(windows)]
    {
        let (dir, file) = match name {
            "VS Code Insiders" => ("Microsoft VS Code Insiders", "Code - Insiders.exe"),
            "Cursor" => ("cursor", "Cursor.exe"),
            _ => ("Microsoft VS Code", "Code.exe"),
        };
        if let Some(l) = dirs::data_local_dir() {
            c.push(l.join("Programs").join(dir).join(file));
        }
        for v in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(p) = std::env::var_os(v) {
                c.push(PathBuf::from(p).join(dir).join(file));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let app = match name {
            "VS Code Insiders" => "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
            "Cursor" => "Cursor.app/Contents/Resources/app/bin/cursor",
            _ => "Visual Studio Code.app/Contents/Resources/app/bin/code",
        };
        c.push(PathBuf::from("/Applications").join(app));
        if let Some(h) = dirs::home_dir() {
            c.push(h.join("Applications").join(app));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let bin = match name {
            "VS Code Insiders" => "code-insiders",
            "Cursor" => "cursor",
            _ => "code",
        };
        for d in ["/usr/bin", "/usr/local/bin", "/snap/bin"] {
            c.push(PathBuf::from(d).join(bin));
        }
    }
    c.into_iter().find(|p| p.is_file())
}

fn spawn(exe: &Path, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    // окружение хост-сессии Claude не должно попасть в редактор
    for v in crate::launch::HOST_VARS {
        cmd.env_remove(v);
    }
    cmd.env_remove("CLAUDE_CONFIG_DIR");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(|_| ()).map_err(|e| format!("Не удалось запустить редактор: {e}"))
}

/// Открыть папку (или переключиться на уже открытое окно с ней).
pub fn open_folder(editor: &str, folder: &Path) -> Result<(), String> {
    let exe = exe(editor).ok_or_else(|| format!("{editor} не найден"))?;
    spawn(&exe, &[folder.as_os_str()])
}

/// Открыть чат в расширении: session — id сессии, None — новый чат.
pub fn open_chat_url(editor: &Editor, session: Option<&str>, prompt: Option<&str>) -> Result<(), String> {
    let exe = exe(&editor.name).ok_or_else(|| format!("{} не найден", editor.name))?;
    let mut q = vec![];
    if let Some(s) = session {
        q.push(format!("session={s}"));
    }
    if let Some(p) = prompt {
        q.push(format!("prompt={}", urlenc(p)));
    }
    let url = format!(
        "{}://anthropic.claude-code/open{}{}",
        editor.scheme,
        if q.is_empty() { "" } else { "?" },
        q.join("&")
    );
    spawn(&exe, &["--open-url".as_ref(), url.as_ref()])
}

fn urlenc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Есть ли окно редактора, в заголовке которого есть имя папки (Windows).
/// На других ОС — None (неизвестно).
pub fn window_open(folder_name: &str) -> Option<bool> {
    #[cfg(windows)]
    {
        Some(win::titles().iter().any(|t| {
            let tl = t.to_lowercase();
            tl.contains(&folder_name.to_lowercase())
                && (tl.contains("visual studio code") || tl.contains("cursor"))
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = folder_name;
        None
    }
}

#[cfg(windows)]
mod win {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};

    unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> BOOL {
        let out = &mut *(lp as *mut Vec<String>);
        if IsWindowVisible(hwnd) != 0 {
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if n > 0 {
                out.push(String::from_utf16_lossy(&buf[..n as usize]));
            }
        }
        1
    }

    pub fn titles() -> Vec<String> {
        let mut v: Vec<String> = vec![];
        unsafe {
            EnumWindows(Some(cb), &mut v as *mut _ as LPARAM);
        }
        v
    }
}

// ------------------------------------------------------------------ JSONC

enum Tok {
    Char(usize, u8),
    Str(usize, usize), // [start, end) включая кавычки
}

/// Идём по тексту, пропуская комментарии; строки отдаём целиком.
fn scan(text: &str, mut f: impl FnMut(Tok) -> bool) {
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'"' {
            let s = i;
            i += 1;
            while i < b.len() && b[i] != b'"' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
            if !f(Tok::Str(s, i.min(b.len()))) {
                return;
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'/' {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < b.len() && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if !f(Tok::Char(i, c)) {
            return;
        }
        i += 1;
    }
}

/// Убирает комментарии и висячие запятые, чтобы текст разобрал serde_json.
pub fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_comma: Option<usize> = None;
    scan(text, |t| {
        match t {
            Tok::Str(s, e) => {
                pending_comma = None;
                out.push_str(&text[s..e.min(text.len())]);
            }
            Tok::Char(_, c) => {
                if c == b',' {
                    pending_comma = Some(out.len());
                    out.push(',');
                } else if c == b'}' || c == b']' {
                    if let Some(p) = pending_comma.take() {
                        out.replace_range(p..p + 1, " ");
                    }
                    out.push(c as char);
                } else {
                    if !(c as char).is_whitespace() {
                        pending_comma = None;
                    }
                    out.push(c as char);
                }
            }
        }
        true
    });
    out
}

fn first_brace(text: &str) -> Option<usize> {
    let mut pos = None;
    scan(text, |t| {
        if let Tok::Char(i, b'{') = t {
            pos = Some(i);
            return false;
        }
        true
    });
    pos
}

/// Член верхнего уровня: (начало ключа, начало значения, конец значения).
fn find_member(text: &str, key: &str) -> Option<(usize, usize, usize)> {
    let quoted = format!("\"{key}\"");
    let mut depth = 0i32;
    let mut state = 0u8; // 0 ищем ключ, 1 ждём ':', 2 ждём значение, 3 внутри значения
    let (mut kstart, mut vstart) = (0usize, 0usize);
    let mut vdepth = 0i32;
    let mut result = None;
    scan(text, |t| {
        match (state, t) {
            (0, Tok::Str(s, e)) => {
                if depth == 1 && &text[s..e] == quoted {
                    kstart = s;
                    state = 1;
                }
            }
            (0, Tok::Char(_, c)) => match c {
                b'{' | b'[' => depth += 1,
                b'}' | b']' => depth -= 1,
                _ => {}
            },
            (1, Tok::Char(_, b':')) => state = 2,
            (1, Tok::Char(_, c)) if (c as char).is_whitespace() => {}
            (1, _) => state = 0,
            (2, Tok::Char(_, c)) if (c as char).is_whitespace() => {}
            (2, Tok::Str(s, e)) => {
                result = Some((kstart, s, e));
                return false;
            }
            (2, Tok::Char(i, c)) => {
                if c == b'[' || c == b'{' {
                    vstart = i;
                    vdepth = 1;
                    state = 3;
                } else {
                    let rest = &text[i..];
                    let len = rest.find([',', '}', '\n', '/']).unwrap_or(rest.len());
                    result = Some((kstart, i, i + rest[..len].trim_end().len()));
                    return false;
                }
            }
            (3, Tok::Char(i, c)) => {
                if c == b'[' || c == b'{' {
                    vdepth += 1;
                } else if c == b']' || c == b'}' {
                    vdepth -= 1;
                    if vdepth == 0 {
                        result = Some((kstart, vstart, i + 1));
                        return false;
                    }
                }
            }
            _ => {}
        }
        true
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
  // ── Claude Code ─────── "claudeCode.claudeProcessWrapper" в комментарии
  "claudeCode.preferredLocation": "panel",
  /* блочный комментарий: { [ */
  "editor.fontSize": 14,
  "url": "http://example.com/a//b",
  "nested": { "claudeCode.claudeProcessWrapper": "не трогать" },
}
"#;

    fn wrapper(t: &str) -> Option<String> {
        parse(t)?.get(WRAPPER_KEY)?.as_str().map(String::from)
    }

    #[test]
    fn add_replace_remove_keeps_everything_else() {
        let a = set_key(SAMPLE, WRAPPER_KEY, Some(&json!(r"C:\x\ccdeck-wrap.exe"))).unwrap();
        assert_eq!(wrapper(&a).as_deref(), Some(r"C:\x\ccdeck-wrap.exe"));
        assert!(a.contains("// ── Claude Code"));
        assert!(a.contains("/* блочный комментарий: { [ */"));
        assert!(a.contains(r#""nested": { "claudeCode.claudeProcessWrapper": "не трогать" }"#));

        let b = set_key(&a, WRAPPER_KEY, Some(&json!("/y"))).unwrap();
        assert_eq!(wrapper(&b).as_deref(), Some("/y"));
        assert_eq!(b.matches(WRAPPER_KEY).count(), a.matches(WRAPPER_KEY).count());

        let c = set_key(&b, WRAPPER_KEY, None).unwrap();
        assert_eq!(wrapper(&c), None);
        let before = parse(SAMPLE).unwrap();
        assert_eq!(parse(&c).unwrap(), before);
        assert!(c.contains("// ── Claude Code"));
    }

    #[test]
    fn remove_last_member_and_only_member() {
        let t = "{\n  \"a\": 1,\n  \"claudeCode.claudeProcessWrapper\": \"x\"\n}\n";
        let r = set_key(t, WRAPPER_KEY, None).unwrap();
        assert_eq!(parse(&r).unwrap(), json!({"a": 1}));
        assert!(serde_json::from_str::<Value>(&r).is_ok(), "{r}");
        let t = "{ \"claudeCode.claudeProcessWrapper\": \"x\" }";
        let r = set_key(t, WRAPPER_KEY, None).unwrap();
        assert_eq!(parse(&r).unwrap(), json!({}));
    }

    #[test]
    fn empty_files() {
        let r = set_key("", WRAPPER_KEY, Some(&json!("/w"))).unwrap();
        assert_eq!(wrapper(&r).as_deref(), Some("/w"));
        let r = set_key("{}", WRAPPER_KEY, Some(&json!("/w"))).unwrap();
        assert!(serde_json::from_str::<Value>(&r).is_ok());
    }

    #[test]
    fn env_dir_removed_other_vars_kept() {
        let t = r#"{ "claudeCode.environmentVariables": [ {"name":"FOO","value":"1"}, {"name":"CLAUDE_CONFIG_DIR","value":"/a"} ] }"#;
        let r = drop_env_dir(t).unwrap();
        let v = parse(&r).unwrap();
        assert_eq!(env_dir(&v), None);
        assert_eq!(v[ENV_KEY][0]["name"], "FOO");
        let t = r#"{ "x": 1, "claudeCode.environmentVariables": [ {"name":"CLAUDE_CONFIG_DIR","value":"/a"} ] }"#;
        let v = parse(&drop_env_dir(t).unwrap()).unwrap();
        assert_eq!(v, json!({"x": 1}));
    }

    #[test]
    fn real_user_settings_roundtrip() {
        // реальный settings.json, правка только в памяти
        for e in editors() {
            let text = fs::read_to_string(&e.settings).unwrap_or_default();
            let a = set_key(&text, WRAPPER_KEY, Some(&json!(r"C:\tmp\w.exe"))).unwrap();
            assert_eq!(wrapper(&a).as_deref(), Some(r"C:\tmp\w.exe"));
            let b = set_key(&a, WRAPPER_KEY, e.wrapper.as_ref().map(|w| json!(w)).as_ref()).unwrap();
            assert_eq!(parse(&b).unwrap(), parse(&text).unwrap(), "{}", e.name);
            println!("{}: ok", e.name);
        }
    }

    #[test]
    fn url_encoding() {
        assert_eq!(urlenc("привет мир"), "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82%20%D0%BC%D0%B8%D1%80");
    }
}
