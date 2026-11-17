//! Лимиты аккаунта (5 часов / неделя).
//!
//! 1. Кэш Claude Code (`cachedUsageUtilization` в .claude.json) — без запросов, но может устареть.
//! 2. По кнопке «Проверить лимиты» — запрос к серверу, тот же, что делает Claude Code для /usage:
//!    GET https://api.anthropic.com/api/oauth/usage с OAuth-токеном аккаунта из
//!    <config>/.credentials.json. Токен только читается и уходит только на api.anthropic.com.
//!    Истёкший токен НЕ обновляем (refresh мог бы сбить вход в Claude Code).
//!    Сервер ограничивает частоту, поэтому запрашиваем не чаще раза в минуту на аккаунт.

use crate::accounts::Usage;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const URL: &str = "https://api.anthropic.com/api/oauth/usage";

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Разбор объекта utilization: { five_hour: {utilization, resets_at}, seven_day: {...} }.
pub fn parse(ut: &Value, fetched_ms: Option<u64>) -> Usage {
    let pick = |k: &str| -> (Option<f64>, Option<String>) {
        match ut.get(k) {
            Some(w) if !w.is_null() => (
                w.get("utilization").and_then(|x| x.as_f64()),
                w.get("resets_at").and_then(|x| x.as_str()).map(String::from),
            ),
            _ => (None, None),
        }
    };
    let (fh, fhr) = pick("five_hour");
    let (sd, sdr) = pick("seven_day");
    Usage {
        five_hour: fh,
        five_hour_resets: fhr,
        seven_day: sd,
        seven_day_resets: sdr,
        fetched_ms,
        live: false,
    }
}

fn token(config_dir: &Path) -> Result<String, String> {
    let text = fs::read_to_string(config_dir.join(".credentials.json")).map_err(|_| {
        if cfg!(target_os = "macos") {
            "На macOS вход хранится в Keychain — здесь лимиты пока только из кэша Claude Code.".to_string()
        } else {
            "Не выполнен вход в этот аккаунт.".to_string()
        }
    })?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "Не удалось прочитать данные входа.".to_string())?;
    let o = v.get("claudeAiOauth").ok_or("Не выполнен вход в этот аккаунт.")?;
    let expires = o.get("expiresAt").and_then(|x| x.as_u64()).unwrap_or(0);
    if expires != 0 && expires < now_ms() + 60_000 {
        return Err("Вход давно не обновлялся. Откройте любой чат под этим аккаунтом (Claude Code обновит вход сам) и проверьте снова.".into());
    }
    o.get("accessToken")
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| "Не выполнен вход в этот аккаунт.".into())
}

/// Запросить лимиты с сервера.
pub fn fetch(config_dir: &Path) -> Result<Usage, String> {
    let token = token(config_dir)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(8)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent
        .get(URL)
        .header("Authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "ccdeck")
        .call()
        .map_err(|e| format!("Нет связи с сервером: {e}"))?;
    let status = resp.status().as_u16();
    match status {
        200 => {}
        429 => {
            let wait = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .map(|s| format!(" через {s} с"))
                .unwrap_or_else(|| " чуть позже".into());
            return Err(format!("Сервер просит не спешить — попробуйте{wait}."));
        }
        401 | 403 => return Err("Вход устарел. Откройте чат под этим аккаунтом или войдите заново.".into()),
        s => return Err(format!("Сервер ответил {s}.")),
    }
    let v: Value = resp.body_mut().read_json().map_err(|_| "Непонятный ответ сервера.".to_string())?;
    let mut u = parse(&v, Some(now_ms()));
    if u.five_hour.is_none() && u.seven_day.is_none() {
        return Err("Сервер не прислал лимиты.".into());
    }
    u.live = true;
    Ok(u)
}

#[cfg(test)]
mod tests {
    /// Ручная проверка на машине разработчика: cargo test usage -- --ignored --nocapture
    #[test]
    #[ignore]
    fn fetch_both_accounts() {
        for dir in [crate::accounts::default_claude_dir(), crate::accounts::home().join(".claude-work")] {
            match super::fetch(&dir) {
                Ok(u) => println!("{}: 5ч {:?}% · неделя {:?}%", dir.display(), u.five_hour, u.seven_day),
                Err(e) => println!("{}: {e}", dir.display()),
            }
        }
    }
}
