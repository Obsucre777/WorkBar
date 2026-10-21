//! Shared plan model, validation and storage for Workbar.
//!
//! The Electron-free, runtime-free core used by both the floating bar app and
//! the `workbar-mcp` server. Everything lives in a single human-readable file:
//!
//! ```text
//! %APPDATA%\Workbar\plan.json
//! ```
//!
//! Writes are atomic (temp file + rename) and serialized through a small lock
//! file so the app and an MCP server can safely update the plan at the same time.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub const APP_DIR: &str = "Workbar";
pub const DEFAULT_EST_MIN: u32 = 25;

/// One short piece of work shown on the bar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Local start time, `HH:mm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// Local end time, `HH:mm`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default)]
    pub est_min: u32,
    #[serde(default)]
    pub spent_sec: u64,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Default for Task {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            start: None,
            end: None,
            est_min: 0,
            spent_sec: 0,
            running: false,
            done: false,
            note: None,
        }
    }
}

/// A single day plan. Workbar v0 is deliberately one day at a time.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Plan {
    /// `YYYY-MM-DD` in local time.
    #[serde(default)]
    pub date: String,
    /// One line that says what today is really about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    /// Task the bar is currently showing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_id: Option<String>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Data directory. `WORKBAR_DATA_DIR` exists for tests and portable setups.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("WORKBAR_DATA_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    match std::env::var_os("APPDATA") {
        Some(dir) => PathBuf::from(dir).join(APP_DIR),
        None => PathBuf::from(APP_DIR),
    }
}

pub fn plan_path() -> PathBuf {
    data_dir().join("plan.json")
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

pub fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub fn now_hhmm() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

/// Parse `HH:mm` (or `H:mm`) into minutes since midnight.
pub fn parse_hhmm(value: &str) -> Option<u32> {
    let (h, m) = value.trim().split_once(':')?;
    let h: u32 = h.parse().ok()?;
    let m: u32 = m.parse().ok()?;
    if h < 24 && m < 60 {
        Some(h * 60 + m)
    } else {
        None
    }
}

pub fn is_hhmm(value: &str) -> bool {
    parse_hhmm(value).is_some()
}

fn sort_key(task: &Task) -> u32 {
    task.start
        .as_deref()
        .and_then(parse_hhmm)
        .unwrap_or(24 * 60 + 1)
}

/// Stable order: by start time, then by creation/id.
pub fn sort_tasks(tasks: &mut [Task]) {
    tasks.sort_by(|a, b| sort_key(a).cmp(&sort_key(b)).then_with(|| a.id.cmp(&b.id)));
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/// Short, collision-resistant-enough ids like `t3f9a1c2`.
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed) as u64;
    let mix = (now.as_nanos() as u64)
        ^ ((std::process::id() as u64) << 32)
        ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("t{:08x}", (mix & 0xFFFF_FFFF) as u32)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

pub fn normalize_task(task: &mut Task) -> Result<(), String> {
    task.title = task.title.trim().to_string();
    if task.title.is_empty() {
        return Err("任务标题不能为空".to_string());
    }
    if task.id.trim().is_empty() {
        task.id = new_id();
    }
    for (field, value) in [("start", &task.start), ("end", &task.end)] {
        if let Some(v) = value {
            if !is_hhmm(v) {
                return Err(format!("{field} 必须是 HH:mm 格式，收到：{v}"));
            }
        }
    }
    if task.est_min == 0 {
        if let (Some(start), Some(end)) = (&task.start, &task.end) {
            if let (Some(a), Some(b)) = (parse_hhmm(start), parse_hhmm(end)) {
                if b > a {
                    task.est_min = b - a;
                }
            }
        }
    }
    if task.est_min == 0 {
        task.est_min = DEFAULT_EST_MIN;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

pub fn load() -> Result<Plan, String> {
    let path = plan_path();
    match fs::read_to_string(&path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Plan::default()),
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("plan.json 解析失败：{e}")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Plan::default()),
        Err(err) => Err(format!("读取 plan.json 失败：{err}")),
    }
}

fn save_unlocked(plan: &Plan) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let path = plan_path();
    let tmp = path.with_extension("json.tmp");
    let mut body = serde_json::to_string_pretty(plan).map_err(|e| e.to_string())?;
    body.push('\n');
    fs::write(&tmp, body).map_err(|e| format!("写入临时文件失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换 plan.json 失败：{e}"))?;
    Ok(())
}

struct Lock {
    path: PathBuf,
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_lock() -> Result<Lock, String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let path = dir.join(".lock");
    for _ in 0..150 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(Lock { path });
            }
            Err(_) => {
                // Break locks left behind by a crashed process.
                if let Ok(meta) = fs::metadata(&path) {
                    if let Ok(modified) = meta.modified() {
                        let stale = SystemTime::now()
                            .duration_since(modified)
                            .map(|age| age.as_secs() > 15)
                            .unwrap_or(false);
                        if stale {
                            let _ = fs::remove_file(&path);
                            continue;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    Err("plan.json 正被另一个进程写入，请稍后重试".to_string())
}

/// Replace the whole plan (used by the bar app for timer state).
pub fn replace(plan: &Plan) -> Result<(), String> {
    let _lock = acquire_lock()?;
    save_unlocked(plan)
}

/// Read-modify-write under the lock. Used by every MCP mutation.
pub fn update<F>(mutate: F) -> Result<Plan, String>
where
    F: FnOnce(&mut Plan) -> Result<(), String>,
{
    let _lock = acquire_lock()?;
    let mut plan = load()?;
    if plan.date.trim().is_empty() {
        plan.date = today();
    }
    mutate(&mut plan)?;
    sort_tasks(&mut plan.tasks);
    plan.updated_at = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());
    save_unlocked(&plan)?;
    Ok(plan)
}

// ---------------------------------------------------------------------------
// MCP-facing helpers
// ---------------------------------------------------------------------------

/// Compact, model-friendly one-line-per-task summary.
pub fn summarize(plan: &Plan) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "Workbar · {} · {}/{} done\n",
        if plan.date.is_empty() {
            "(no day yet)"
        } else {
            &plan.date
        },
        plan.tasks.iter().filter(|t| t.done).count(),
        plan.tasks.len()
    ));
    if let Some(intro) = plan.intro.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("today: {intro}\n"));
    }
    for task in &plan.tasks {
        let mark = if task.done {
            "x"
        } else if plan.current_id.as_deref() == Some(task.id.as_str()) {
            ">"
        } else {
            " "
        };
        let window = match (&task.start, &task.end) {
            (Some(s), Some(e)) => format!(" {s}-{e}"),
            (Some(s), None) => format!(" {s}-"),
            (None, Some(e)) => format!(" -{e}"),
            (None, None) => String::new(),
        };
        let spent = if task.spent_sec > 0 {
            format!(" spent:{}m", task.spent_sec / 60)
        } else {
            String::new()
        };
        out.push_str(&format!(
            "- [{mark}] {id}  {title}{window} est:{}m{spent}\n",
            task.est_min,
            id = task.id,
            title = task.title
        ));
    }
    if plan.tasks.is_empty() {
        out.push_str("(no tasks yet — use workbar_plan_day or workbar_add_tasks)\n");
    }
    out
}

/// Summary tailored for a tool result: headline + human summary + raw JSON.
pub fn tool_result_text(plan: &Plan, message: &str) -> String {
    format!(
        "{message}\n\n{}\n```json\n{}\n```",
        summarize(plan),
        serde_json::to_string_pretty(plan).unwrap_or_else(|_| "{}".to_string())
    )
}
