//! Лимиты аккаунта (5 часов / неделя) из кэша Claude Code (`cachedUsageUtilization`
//! в .claude.json). Свежесть зависит от того, когда Claude Code последний раз их обновлял,
//! поэтому вместе с данными отдаём время, а интерфейс учитывает уже сброшенные окна.
//!
//! Живой запрос к серверу пробовали: эндпоинт лимитов сильно ограничен по частоте (429),
//! а токены редко используемого аккаунта успевают истечь — обновлять их самим опасно.

use crate::accounts::Usage;
use serde_json::Value;

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
