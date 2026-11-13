//! Чтение сессий из <config>/projects/<папка-проекта>/<uuid>.jsonl.
//! Файлы бывают по сотни МБ, поэтому читаем только начало (cwd, первый запрос)
//! и хвост (название, последний запрос), а результат кэшируем по mtime+size.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionInfo {
    pub id: String,
    pub file: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    pub git_branch: Option<String>,
    pub entrypoint: Option<String>,
    pub modified_ms: u64,
    pub size: u64,
    #[serde(default)]
    pub cwd_exists: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Cached {
    mtime: u64,
    size: u64,
    info: SessionInfo,
}

#[derive(Default)]
pub struct Cache {
    map: HashMap<String, Cached>,
    path: PathBuf,
}

impl Cache {
    pub fn load(path: PathBuf) -> Cache {
        let map = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Cache { map, path }
    }
    fn save(&self) {
        if let Some(p) = self.path.parent() {
            let _ = fs::create_dir_all(p);
        }
        if let Ok(s) = serde_json::to_string(&self.map) {
            let _ = fs::write(&self.path, s);
        }
    }
    pub fn all(&self) -> Vec<SessionInfo> {
        self.map.values().map(|c| c.info.clone()).collect()
    }
    pub fn get_by_id(&self, id: &str) -> Option<SessionInfo> {
        self.map.values().find(|c| c.info.id == id).map(|c| c.info.clone())
    }
}

const HEAD_LIMIT: u64 = 8 * 1024 * 1024;
const TAIL_BYTES: u64 = 2 * 1024 * 1024;
const TEXT_MAX: usize = 400;

fn clip(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= TEXT_MAX {
        t.to_string()
    } else {
        let mut out: String = t.chars().take(TEXT_MAX).collect();
        out.push('…');
        out
    }
}

/// Текст настоящего запроса пользователя (не служебные вставки и не tool_result).
fn user_text(v: &Value) -> Option<String> {
    if v.get("isMeta").and_then(|x| x.as_bool()) == Some(true)
        || v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true)
    {
        return None;
    }
    let content = v.get("message")?.get("content")?;
    let pieces: Vec<&str> = match content {
        Value::String(s) => vec![s.as_str()],
        Value::Array(items) => items
            .iter()
            .filter(|i| i.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
            .collect(),
        _ => return None,
    };
    pieces.into_iter().find_map(|p| {
        let t = strip_reminders(p);
        let t = t.trim();
        if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
            None
        } else {
            Some(clip(t))
        }
    })
}

/// Убирает служебные блоки <system-reminder>…</system-reminder>, которые клиент
/// подмешивает в сообщение пользователя.
fn strip_reminders(s: &str) -> String {
    const OPEN: &str = "<system-reminder>";
    const CLOSE: &str = "</system-reminder>";
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i]);
        match rest[i..].find(CLOSE) {
            Some(j) => rest = &rest[i + j + CLOSE.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn mtime_ms(md: &fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse(path: &Path, md: &fs::Metadata) -> SessionInfo {
    let id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut info = SessionInfo {
        id,
        file: path.to_string_lossy().to_string(),
        cwd: None,
        title: None,
        first_prompt: None,
        last_prompt: None,
        git_branch: None,
        entrypoint: None,
        modified_ms: mtime_ms(md),
        size: md.len(),
        cwd_exists: false,
    };
    let Ok(f) = File::open(path) else { return info };

    // --- начало файла
    let mut reader = BufReader::new(f.take(HEAD_LIMIT));
    let mut line = String::new();
    while info.cwd.is_none() || info.first_prompt.is_none() {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let need_cwd = info.cwd.is_none() && line.contains("\"cwd\":");
        let is_user = info.first_prompt.is_none() && line.contains("\"type\":\"user\"");
        let is_title = line.contains("\"type\":\"custom-title\"");
        if !(need_cwd || is_user || is_title) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if need_cwd {
            info.cwd = v.get("cwd").and_then(|x| x.as_str()).map(String::from);
            info.git_branch = v
                .get("gitBranch")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
            info.entrypoint = v.get("entrypoint").and_then(|x| x.as_str()).map(String::from);
        }
        if is_user && v.get("type").and_then(|t| t.as_str()) == Some("user") {
            info.first_prompt = user_text(&v);
        }
        if is_title {
            info.title = v.get("customTitle").and_then(|x| x.as_str()).map(String::from);
        }
    }

    // --- хвост файла: последнее название и последний запрос
    if let Ok(mut f) = File::open(path) {
        let len = md.len();
        let start = len.saturating_sub(TAIL_BYTES);
        if f.seek(SeekFrom::Start(start)).is_ok() {
            let mut buf = Vec::new();
            let _ = f.read_to_end(&mut buf);
            let text = String::from_utf8_lossy(&buf);
            let mut lines: Vec<&str> = text.split('\n').collect();
            if start > 0 && !lines.is_empty() {
                lines.remove(0); // обрезанная строка
            }
            let mut got_title = false;
            let mut got_last = false;
            let mut got_summary = info.title.is_some();
            for l in lines.iter().rev() {
                if got_title && got_last {
                    break;
                }
                if !got_title && l.contains("\"type\":\"custom-title\"") {
                    if let Ok(v) = serde_json::from_str::<Value>(l) {
                        if let Some(t) = v.get("customTitle").and_then(|x| x.as_str()) {
                            info.title = Some(t.to_string());
                            got_title = true;
                            got_summary = true;
                        }
                    }
                } else if !got_last && l.contains("\"type\":\"last-prompt\"") {
                    if let Ok(v) = serde_json::from_str::<Value>(l) {
                        info.last_prompt = v
                            .get("lastPrompt")
                            .and_then(|x| x.as_str())
                            .map(|t| clip(&strip_reminders(t)));
                        got_last = true;
                    }
                } else if !got_summary && l.contains("\"type\":\"summary\"") {
                    if let Ok(v) = serde_json::from_str::<Value>(l) {
                        info.title = v.get("summary").and_then(|x| x.as_str()).map(String::from);
                        got_summary = true;
                    }
                }
            }
        }
    }
    info
}

/// Все папки projects/ всех аккаунтов без дублей (у общих они одинаковые).
pub fn projects_roots(config_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for d in config_dirs {
        let p = d.join("projects");
        if let Ok(c) = fs::canonicalize(&p).map(plain_path) {
            if seen.insert(c.clone()) {
                out.push(c);
            }
        }
    }
    out
}

/// Убирает префикс \?\ , который canonicalize добавляет на Windows.
pub fn plain_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

fn session_files(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = vec![];
    for root in roots {
        let Ok(rd) = fs::read_dir(root) else { continue };
        for proj in rd.flatten() {
            let Ok(inner) = fs::read_dir(proj.path()) else { continue };
            for f in inner.flatten() {
                let p = f.path();
                let name = f.file_name().to_string_lossy().to_string();
                if p.extension().and_then(|e| e.to_str()) == Some("jsonl")
                    && !name.starts_with("agent-")
                    && p.is_file()
                {
                    files.push(p);
                }
            }
        }
    }
    files
}

pub fn list(cache: &mut Cache, roots: &[PathBuf]) -> Vec<SessionInfo> {
    let files = session_files(roots);
    let keyed: Vec<(String, PathBuf, fs::Metadata)> = files
        .into_iter()
        .filter_map(|p| {
            let md = fs::metadata(&p).ok()?;
            Some((p.to_string_lossy().to_string(), p, md))
        })
        .collect();

    let fresh: Vec<(String, Cached)> = keyed
        .par_iter()
        .filter_map(|(k, p, md)| {
            let (mt, sz) = (mtime_ms(md), md.len());
            match cache.map.get(k) {
                Some(c) if c.mtime == mt && c.size == sz => None,
                _ => Some((
                    k.clone(),
                    Cached {
                        mtime: mt,
                        size: sz,
                        info: parse(p, md),
                    },
                )),
            }
        })
        .collect();

    let changed = !fresh.is_empty();
    for (k, c) in fresh {
        cache.map.insert(k, c);
    }
    let live: HashSet<&String> = keyed.iter().map(|(k, _, _)| k).collect();
    let before = cache.map.len();
    cache.map.retain(|k, _| live.contains(k));
    if changed || before != cache.map.len() {
        cache.save();
    }

    let mut out: Vec<SessionInfo> = cache
        .map
        .values()
        .map(|c| {
            let mut i = c.info.clone();
            i.cwd_exists = i.cwd.as_deref().map(|d| Path::new(d).is_dir()).unwrap_or(false);
            i
        })
        .collect();
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

/// Полнотекстовый поиск по сообщениям (user/assistant). Возвращает id сессий.
pub fn search(cache: &Cache, query: &str) -> Vec<String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let items: Vec<(String, String)> = cache
        .map
        .values()
        .map(|c| (c.info.id.clone(), c.info.file.clone()))
        .collect();
    items
        .par_iter()
        .filter(|(_, file)| {
            let Ok(f) = File::open(file) else { return false };
            let mut r = BufReader::new(f);
            let mut line = String::new();
            loop {
                line.clear();
                match r.read_line(&mut line) {
                    Ok(0) | Err(_) => return false,
                    Ok(_) => {}
                }
                if (line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\""))
                    && line.to_lowercase().contains(&q)
                {
                    return true;
                }
            }
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// Перемещает файл сессии и её служебную папку (сабагенты и т.п.) в корзину ОС.
pub fn trash_session(info: &SessionInfo) -> Result<(), String> {
    let file = PathBuf::from(&info.file);
    let mut items = vec![file.clone()];
    if let Some(parent) = file.parent() {
        let dir = parent.join(&info.id);
        if dir.is_dir() {
            items.push(dir);
        }
    }
    trash::delete_all(&items).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone, Debug)]
pub struct Running {
    pub session_id: String,
    pub account_id: String,
    pub pid: u32,
    pub status: Option<String>,
}

/// Запущенные сейчас сессии: <config>/sessions/<pid>.json + проверка, что процесс жив.
pub fn running(accounts: &[(String, PathBuf)]) -> Vec<Running> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut found = vec![];
    let mut seen_dirs = HashSet::new();
    for (acc_id, dir) in accounts {
        let sdir = dir.join("sessions");
        let key = fs::canonicalize(&sdir).unwrap_or(sdir.clone());
        if !seen_dirs.insert(key) {
            continue;
        }
        let Ok(rd) = fs::read_dir(&sdir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Some(v) = fs::read_to_string(&p)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            else {
                continue;
            };
            let (Some(pid), Some(sid)) = (
                v.get("pid").and_then(|x| x.as_u64()),
                v.get("sessionId").and_then(|x| x.as_str()),
            ) else {
                continue;
            };
            found.push(Running {
                session_id: sid.to_string(),
                account_id: acc_id.clone(),
                pid: pid as u32,
                status: v.get("status").and_then(|x| x.as_str()).map(String::from),
            });
        }
    }
    if found.is_empty() {
        return found;
    }
    let pids: Vec<Pid> = found.iter().map(|r| Pid::from_u32(r.pid)).collect();
    let Ok(mut sys) = System::new() else {
        return found;
    };
    sys.refresh_processes(ProcessesToUpdate::Some(&pids), true);
    found
        .into_iter()
        .filter(|r| sys.process(Pid::from_u32(r.pid)).is_some())
        .collect()
}
