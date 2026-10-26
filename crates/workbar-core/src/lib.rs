//! Shared task model and SQLite storage for the floating bar and MCP clients.
//! Timers are persisted as an elapsed baseline and a running timestamp.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

mod storage;
pub use storage::{load, set_task_state, update, Store};

pub const APP_DIR: &str = "Workbar";
pub const DEFAULT_EST_MIN: u32 = 25;

fn is_false(value: &bool) -> bool {
    !*value
}

/// How a task's timer behaves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimerMode {
    /// Countdown against `est_min` (the default for planned tasks).
    Down,
    /// Stopwatch with no target; the ring laps once per hour.
    Up,
}

impl Default for TimerMode {
    fn default() -> Self {
        TimerMode::Down
    }
}

/// One short piece of work shown on the bar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Planned minutes. Ignored by stopwatch tasks.
    #[serde(default)]
    pub est_min: u32,
    /// Timer mode. Omitted on old plans; use [`timer_mode`] to resolve it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timer: Option<TimerMode>,
    #[serde(default)]
    pub spent_sec: u64,
    /// Settled time only. The running interval is never periodically written.
    #[serde(default)]
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_since_ms: Option<i64>,
    #[serde(default)]
    pub plan_date: String,
    #[serde(default)]
    pub running: bool,
    /// Explicitly paused, including a pause before the first elapsed second.
    /// Prevents the schedule from restarting this task after a reload.
    #[serde(default, skip_serializing_if = "is_false")]
    pub paused: bool,
    #[serde(default)]
    pub done: bool,
    /// Who created the task (e.g. the AI client name) for work sessions made
    /// through `workbar_start_work`; user/planner tasks leave it empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Effective timer mode: an explicit `timer` wins, otherwise an estimate means
/// countdown and a bare task (no estimate, no window) becomes a stopwatch.
pub fn timer_mode(task: &Task) -> TimerMode {
    task.timer.unwrap_or(if task.est_min > 0 {
        TimerMode::Down
    } else {
        TimerMode::Up
    })
}

impl Default for Task {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            start: None,
            end: None,
            est_min: 0,
            timer: None,
            spent_sec: 0,
            elapsed_ms: 0,
            running_since_ms: None,
            plan_date: String::new(),
            running: false,
            paused: false,
            done: false,
            source: None,
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
    #[serde(default)]
    pub tasks: Vec<Task>,
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

pub fn database_path() -> PathBuf {
    data_dir().join("workbar.db")
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

/// Minutes since local midnight.
pub fn now_minutes() -> u32 {
    use chrono::Timelike;
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

pub fn today_weekday() -> String {
    use chrono::Datelike;
    const NAMES: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    NAMES[chrono::Local::now().weekday().num_days_from_monday() as usize].to_string()
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

/// Explicit schedule sort only. Equal start times (including absent times)
/// keep their queue order; task ids never imply creation order.
pub fn sort_tasks(tasks: &mut [Task]) {
    tasks.sort_by_key(sort_key);
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
    if task.done {
        task.running = false;
        task.paused = false;
    } else if task.running {
        task.paused = false;
    }
    if let Some(source) = &task.source {
        let trimmed = source.trim().to_string();
        task.source = if trimmed.is_empty() { None } else { Some(trimmed) };
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
    // Timer mode: an explicit value wins. Otherwise a task with an estimate (or
    // a time window) is a countdown, and a bare task is a stopwatch.
    if task.timer.is_none() {
        task.timer = Some(if task.est_min > 0 {
            TimerMode::Down
        } else {
            TimerMode::Up
        });
    }
    if timer_mode(task) == TimerMode::Down && task.est_min == 0 {
        task.est_min = DEFAULT_EST_MIN;
    }
    Ok(())
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
    for task in &plan.tasks {
        let mark = if task.done {
            "x"
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
        let target = if timer_mode(task) == TimerMode::Up {
            " 正计时".to_string()
        } else {
            format!(" est:{}m", task.est_min)
        };
        let ai = if task.source.is_some() { " (AI)" } else { "" };
        let state = if task.done {
            ""
        } else if task.running {
            " running"
        } else if task.paused || task.spent_sec > 0 {
            " paused"
        } else {
            ""
        };
        out.push_str(&format!(
            "- [{mark}] {id}  {title}{window}{target}{spent}{state}{ai}\n",
            id = task.id,
            title = task.title
        ));
    }
    if plan.tasks.is_empty() {
        out.push_str("(no tasks yet — use workbar_plan_day or workbar_add_tasks)\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_time_sort_preserves_equal_time_and_unscheduled_queue_order() {
        let mut tasks = vec![
            Task { id: "z".into(), start: Some("09:00".into()), running: true, spent_sec: 17, ..Task::default() },
            Task { id: "q".into(), ..Task::default() },
            Task { id: "a".into(), start: Some("09:00".into()), ..Task::default() },
            Task { id: "m".into(), start: Some("08:00".into()), ..Task::default() },
            Task { id: "b".into(), ..Task::default() },
        ];
        sort_tasks(&mut tasks);
        assert_eq!(tasks.iter().map(|task| task.id.as_str()).collect::<Vec<_>>(), ["m", "z", "a", "q", "b"]);
        assert!(tasks[1].running);
        assert_eq!(tasks[1].spent_sec, 17);
    }

    #[test]
    fn paused_state_is_backward_compatible_and_survives_round_trip() {
        let mut task: Task = serde_json::from_value(serde_json::json!({ "title": "task" })).unwrap();
        assert!(!task.paused);
        assert!(serde_json::to_value(&task).unwrap().get("paused").is_none());
        task.paused = true;
        let restored: Task = serde_json::from_value(serde_json::to_value(&task).unwrap()).unwrap();
        assert!(restored.paused);
        assert_eq!(restored.spent_sec, 0);
    }

    #[test]
    fn running_and_completed_tasks_clear_only_their_own_pause() {
        let mut running = Task { title: "running".into(), running: true, paused: true, ..Task::default() };
        normalize_task(&mut running).unwrap();
        assert!(running.running);
        assert!(!running.paused);
        let mut done = Task { title: "done".into(), running: true, paused: true, done: true, ..Task::default() };
        normalize_task(&mut done).unwrap();
        assert!(!done.running);
        assert!(!done.paused);
        let mut paused = Task { title: "paused".into(), paused: true, ..Task::default() };
        normalize_task(&mut paused).unwrap();
        assert!(paused.paused);
        assert!(!paused.running);
    }

    #[test]
    fn tasks_have_no_implicit_current_identity() {
        let plan = Plan {
            tasks: vec![
                Task { id: "a".into(), title: "a".into(), ..Task::default() },
                Task { id: "b".into(), title: "b".into(), ..Task::default() },
            ],
            ..Plan::default()
        };
        let summary = summarize(&plan);
        assert!(!summary.contains("[>]"));
        assert!(summary.contains("- [ ] a"));
        assert!(summary.contains("- [ ] b"));
        assert!(plan.tasks.iter().all(|task| !task.running));
    }

    #[test]
    fn read_result_contains_each_task_once_without_workflow_instructions() {
        let plan = Plan {
            tasks: vec![
                Task { id: "a".into(), title: "a".into(), source: Some("one".into()), ..Task::default() },
                Task { id: "b".into(), title: "b".into(), source: Some("two".into()), ..Task::default() },
            ],
            ..Plan::default()
        };
        let result = tool_result_text(&plan, "test");
        assert_eq!(result.matches("\"id\": \"a\"").count(), 1);
        assert!(!result.contains("workbar_finish_work"));
    }
}

/// Read results contain one representation, without a duplicate task summary.
pub fn tool_result_text(plan: &Plan, message: &str) -> String {
    serde_json::to_string_pretty(&serde_json::json!({ "message": message,
        "date": plan.date, "tasks": plan.tasks })).expect("serializable task result")
}
