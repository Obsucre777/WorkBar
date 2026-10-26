use crate::{normalize_task, parse_hhmm, timer_mode, Plan, Task, TimerMode};
use rusqlite::{params, Connection, TransactionBehavior};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

type Result<T> = std::result::Result<T, String>;

/// One table, shared by the desktop process and every independent MCP process.
/// All mutations read the latest rows under BEGIN IMMEDIATE, then write only
/// changed rows. A renderer snapshot is never accepted as a storage operation.
pub struct Store {
    path: PathBuf,
}

fn db_error(error: rusqlite::Error) -> String {
    format!("任务数据库操作失败：{error}")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn state(task: &Task) -> &'static str {
    if task.done { "done" } else if task.running { "running" }
    else if task.paused || task.elapsed_ms > 0 { "paused" } else { "pending" }
}

fn elapsed(task: &Task, now: i64) -> u64 {
    task.elapsed_ms.saturating_add(task.running_since_ms
        .map(|start| now.saturating_sub(start).max(0) as u64).unwrap_or(0))
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let store = Self { path: path.as_ref().to_owned() };
        if let Some(parent) = store.path.parent().filter(|path| !path.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let conn = store.connect()?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0)).map_err(db_error)?;
        if version > 1 { return Err("任务数据库由更新版本的 Workbar 创建，请升级程序".into()); }
        if version == 0 {
            conn.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY NOT NULL,
                    plan_date TEXT NOT NULL,
                    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                    note TEXT,
                    position INTEGER NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('pending','running','paused','done')),
                    timer_mode TEXT NOT NULL CHECK(timer_mode IN ('up','down')),
                    est_min INTEGER NOT NULL CHECK(est_min >= 0),
                    scheduled_start INTEGER CHECK(scheduled_start BETWEEN 0 AND 1439),
                    scheduled_end INTEGER CHECK(scheduled_end BETWEEN 0 AND 1439),
                    elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
                    running_since_ms INTEGER,
                    source TEXT,
                    CHECK((state = 'running' AND running_since_ms IS NOT NULL)
                       OR (state != 'running' AND running_since_ms IS NULL))
                );
                CREATE INDEX IF NOT EXISTS tasks_day_order ON tasks(plan_date, position);
                PRAGMA user_version = 1;
                COMMIT;").map_err(db_error)?;
        }
        Ok(store)
    }

    fn connect(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path).map_err(db_error)?;
        conn.busy_timeout(Duration::from_secs(5)).map_err(db_error)?;
        let mode: String = conn.pragma_query_value(None, "journal_mode", |row| row.get(0)).map_err(db_error)?;
        if !mode.eq_ignore_ascii_case("wal") {
            conn.pragma_update(None, "journal_mode", "WAL").map_err(db_error)?;
        }
        conn.pragma_update(None, "synchronous", "FULL").map_err(db_error)?;
        Ok(conn)
    }

    pub fn load(&self) -> Result<Plan> {
        self.load_at(now_ms(), &crate::today(), crate::now_minutes())
    }

    fn load_at(&self, now: i64, today: &str, minute: u32) -> Result<Plan> {
        let conn = self.connect()?;
        Self::start_due(&conn, now, today, minute)?;
        Self::read(&conn, now, today)
    }

    fn start_due(conn: &Connection, now: i64, today: &str, minute: u32) -> Result<()> {
        // Explicit pauses never restart from their schedule. Starting when the
        // backend observes the window preserves the existing scheduling rule.
        conn.execute("UPDATE tasks SET state = 'running', running_since_ms = ?1
            WHERE plan_date = ?2 AND state = 'pending' AND scheduled_start <= ?3
              AND (scheduled_end IS NULL OR scheduled_end > ?3)",
            params![now, today, minute]).map_err(db_error)?;
        Ok(())
    }

    fn read(conn: &Connection, now: i64, today: &str) -> Result<Plan> {
        let mut statement = conn.prepare("SELECT id, plan_date, title, note, state,
            timer_mode, est_min, scheduled_start, scheduled_end, elapsed_ms,
            running_since_ms, source FROM tasks
            WHERE plan_date = ?1 OR (plan_date < ?1 AND state != 'done')
            ORDER BY position, rowid").map_err(db_error)?;
        let format_time = |value: Option<u32>| value.map(|m| format!("{:02}:{:02}", m / 60, m % 60));
        let tasks = statement.query_map([today], |row| {
            let status: String = row.get(4)?;
            let mode: String = row.get(5)?;
            let mut task = Task {
                id: row.get(0)?, plan_date: row.get(1)?, title: row.get(2)?, note: row.get(3)?,
                running: status == "running", paused: status == "paused", done: status == "done",
                timer: Some(if mode == "up" { TimerMode::Up } else { TimerMode::Down }),
                est_min: row.get(6)?, start: format_time(row.get(7)?), end: format_time(row.get(8)?),
                elapsed_ms: row.get::<_, i64>(9)? as u64, running_since_ms: row.get(10)?, source: row.get(11)?,
                ..Task::default()
            };
            task.spent_sec = elapsed(&task, now) / 1000;
            Ok(task)
        }).map_err(db_error)?.collect::<std::result::Result<Vec<_>, _>>().map_err(db_error)?;
        Ok(Plan { date: today.to_string(), tasks })
    }

    pub fn update<F>(&self, mutate: F) -> Result<Plan>
    where F: FnOnce(&mut Plan) -> Result<()> {
        self.update_at(i64::MIN, "", 0, mutate)
    }

    fn update_at<F>(&self, now: i64, today: &str, minute: u32, mutate: F) -> Result<Plan>
    where F: FnOnce(&mut Plan) -> Result<()> {
        let mut conn = self.connect()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        // Timestamp the action after acquiring the write lock, not before a
        // potentially slow wait behind another process.
        let current_day;
        let (now, today, minute) = if now == i64::MIN {
            current_day = crate::today();
            (now_ms(), current_day.as_str(), crate::now_minutes())
        } else { (now, today, minute) };
        Self::start_due(&tx, now, today, minute)?;
        let before = Self::read(&tx, now, today)?;
        let mut plan = before.clone();
        mutate(&mut plan)?;
        let old: HashMap<_, _> = before.tasks.iter().enumerate().map(|(index, task)| (task.id.as_str(), (index, task))).collect();
        let mut ids = HashSet::new();
        for (position, task) in plan.tasks.iter_mut().enumerate() {
            normalize_task(task)?;
            if !ids.insert(task.id.clone()) { return Err(format!("任务 id 重复：{}", task.id)); }
            if let Some((_, previous)) = old.get(task.id.as_str()) {
                // Never trust caller-supplied timer totals or timestamps.
                task.plan_date = previous.plan_date.clone();
                task.elapsed_ms = previous.elapsed_ms;
                task.running_since_ms = previous.running_since_ms;
                if previous.running && !task.running {
                    task.elapsed_ms = elapsed(previous, now);
                    task.running_since_ms = None;
                } else if !previous.running && task.running {
                    task.running_since_ms = Some(now);
                }
            } else {
                task.plan_date = today.to_string();
                task.elapsed_ms = 0;
                task.running_since_ms = task.running.then_some(now);
            }
            task.spent_sec = elapsed(task, now) / 1000;
            let unchanged = old.get(task.id.as_str()).is_some_and(|(index, previous)| *index == position && **previous == *task);
            if unchanged { continue; }
            // A conflict with an id outside the current view is an error, not
            // permission to replace a historical row.
            let sql = if old.contains_key(task.id.as_str()) {
                "UPDATE tasks SET plan_date=?2,title=?3,note=?4,position=?5,state=?6,
                 timer_mode=?7,est_min=?8,scheduled_start=?9,scheduled_end=?10,
                 elapsed_ms=?11,running_since_ms=?12,source=?13 WHERE id=?1"
            } else {
                "INSERT INTO tasks (id,plan_date,title,note,position,state,timer_mode,
                 est_min,scheduled_start,scheduled_end,elapsed_ms,running_since_ms,source)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)"
            };
            tx.execute(sql, params![task.id, task.plan_date, task.title, task.note, position as i64,
                state(task), if timer_mode(task) == TimerMode::Up { "up" } else { "down" }, task.est_min,
                task.start.as_deref().and_then(parse_hhmm), task.end.as_deref().and_then(parse_hhmm),
                task.elapsed_ms.min(i64::MAX as u64) as i64, task.running_since_ms, task.source]).map_err(db_error)?;
        }
        for previous in &before.tasks {
            if !ids.contains(&previous.id) {
                tx.execute("DELETE FROM tasks WHERE id = ?1", [&previous.id]).map_err(db_error)?;
            }
        }
        Self::start_due(&tx, now, today, minute)?;
        let mut result = Self::read(&tx, now, today)?;
        // A carried task completed today leaves the active view, but the
        // operation still needs its settled row for a precise acknowledgement.
        for task in &plan.tasks {
            if task.done && task.plan_date != today && !result.tasks.iter().any(|item| item.id == task.id) {
                result.tasks.push(task.clone());
            }
        }
        tx.commit().map_err(db_error)?;
        Ok(result)
    }

    pub fn set_task_state(&self, id: &str, action: &str) -> Result<Plan> {
        self.update(|plan| {
            let task = plan.tasks.iter_mut().find(|task| task.id == id)
                .ok_or_else(|| format!("找不到任务 {id}"))?;
            match action {
                "start" if !task.done => { task.running = true; task.paused = false; }
                "pause" if !task.done => { task.running = false; task.paused = true; }
                "complete" => { task.running = false; task.paused = false; task.done = true; }
                "start" | "pause" => return Err("任务已完成，请先重新打开任务".into()),
                _ => return Err("未知任务操作".into()),
            }
            Ok(())
        })
    }
}

pub fn load() -> Result<Plan> { Store::open(crate::database_path())?.load() }
pub fn update<F>(mutate: F) -> Result<Plan>
where F: FnOnce(&mut Plan) -> Result<()> { Store::open(crate::database_path())?.update(mutate) }
pub fn set_task_state(id: &str, action: &str) -> Result<Plan> {
    Store::open(crate::database_path())?.set_task_state(id, action)
}

#[cfg(test)]
mod tests {
    use super::*;
    const DAY: &str = "2026-10-26";

    struct Database { directory: PathBuf, store: Store }
    impl Database {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!("workbar-sqlite-{}-{}", std::process::id(), crate::new_id()));
            let store = Store::open(directory.join("workbar.db")).unwrap();
            Self { directory, store }
        }
    }
    impl Drop for Database {
        fn drop(&mut self) {
            for name in ["workbar.db", "workbar.db-wal", "workbar.db-shm", "plan.json"] {
                let _ = std::fs::remove_file(self.directory.join(name));
            }
            let _ = std::fs::remove_dir(&self.directory);
        }
    }

    fn task(id: &str, running: bool) -> Task {
        Task { id: id.into(), title: id.into(), running, ..Task::default() }
    }

    fn change(store: &Store, now: i64, action: &str) -> Plan {
        store.update_at(now, DAY, 0, |plan| {
            let target = &mut plan.tasks[0];
            target.running = action == "start";
            target.paused = action == "pause";
            target.done = action == "complete";
            Ok(())
        }).unwrap()
    }

    #[test]
    fn one_table_and_no_json_import() {
        let db = Database::new();
        std::fs::write(db.directory.join("plan.json"), b"not even valid JSON").unwrap();
        assert!(db.store.load_at(1000, DAY, 0).unwrap().tasks.is_empty());
        let conn = db.store.connect().unwrap();
        let tables: Vec<String> = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").unwrap()
            .query_map([], |row| row.get(0)).unwrap().map(|row| row.unwrap()).collect();
        assert_eq!(tables, ["tasks"]);
        assert_eq!(std::fs::read(db.directory.join("plan.json")).unwrap(), b"not even valid JSON");
    }

    #[test]
    fn timers_survive_reopen_and_settle_once_without_periodic_writes() {
        let db = Database::new();
        db.store.update_at(1000, DAY, 0, |plan| { plan.tasks.push(task("a", true)); Ok(()) }).unwrap();
        let reopened = Store::open(&db.store.path).unwrap();
        let running = reopened.load_at(4500, DAY, 0).unwrap();
        assert_eq!(running.tasks[0].spent_sec, 3);
        assert_eq!(running.tasks[0].elapsed_ms, 0);
        assert_eq!(running.tasks[0].running_since_ms, Some(1000));
        // Reading/displaying twice does not rebase or double count the timer.
        assert_eq!(reopened.load_at(4500, DAY, 0).unwrap().tasks[0], running.tasks[0]);
        let paused = change(&reopened, 4500, "pause");
        assert_eq!(paused.tasks[0].elapsed_ms, 3500);
        assert_eq!(paused.tasks[0].running_since_ms, None);
        assert_eq!(change(&reopened, 8000, "pause").tasks[0].elapsed_ms, 3500);
        assert_eq!(change(&reopened, 10000, "start").tasks[0].running_since_ms, Some(10000));
        assert_eq!(change(&reopened, 11000, "start").tasks[0].running_since_ms, Some(10000));
        let finished = change(&reopened, 12500, "complete");
        assert_eq!(finished.tasks[0].elapsed_ms, 6000);
        assert!(finished.tasks[0].done);
        assert_eq!(change(&reopened, 20000, "complete").tasks[0].elapsed_ms, 6000);
        // A backwards wall-clock jump cannot subtract already settled time.
        change(&reopened, 30000, "start");
        assert_eq!(change(&reopened, 29000, "pause").tasks[0].elapsed_ms, 6000);
    }

    #[test]
    fn caller_cannot_replace_timer_anchors_or_elapsed_totals() {
        let db = Database::new();
        db.store.update_at(1000, DAY, 0, |plan| { plan.tasks.push(task("a", true)); Ok(()) }).unwrap();
        let plan = db.store.update_at(3000, DAY, 0, |plan| {
            plan.tasks[0].elapsed_ms = 9999999;
            plan.tasks[0].spent_sec = 9999999;
            plan.tasks[0].running_since_ms = Some(-9999999);
            plan.tasks[0].title = "renamed".into();
            Ok(())
        }).unwrap();
        assert_eq!(plan.tasks[0].elapsed_ms, 0);
        assert_eq!(plan.tasks[0].running_since_ms, Some(1000));
        assert_eq!(plan.tasks[0].spent_sec, 2);
    }

    #[test]
    fn parallel_writers_and_stale_ui_actions_never_remove_new_tasks() {
        let db = Database::new();
        db.store.update(|plan| { plan.tasks.push(task("base", true)); Ok(()) }).unwrap();
        let stale_ui = db.store.load().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(5));
        let handles: Vec<_> = (0..4).map(|worker| {
            let path = db.store.path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let store = Store::open(path).unwrap();
                barrier.wait();
                for index in 0..12 {
                    store.update(|plan| { plan.tasks.push(task(&format!("{worker}-{index}"), false)); Ok(()) }).unwrap();
                }
            })
        }).collect();
        barrier.wait();
        for _ in 0..12 {
            db.store.set_task_state(&stale_ui.tasks[0].id, "pause").unwrap();
            db.store.set_task_state(&stale_ui.tasks[0].id, "start").unwrap();
        }
        for handle in handles { handle.join().unwrap(); }
        let plan = db.store.load().unwrap();
        assert_eq!(plan.tasks.len(), 49);
        assert!(plan.tasks[0].running);
        assert_eq!(plan.tasks.iter().map(|task| &task.id).collect::<HashSet<_>>().len(), 49);
        assert!(plan.tasks[1..].iter().all(|task| !task.running));
    }

    #[test]
    fn invalid_mutation_rolls_back_all_rows() {
        let db = Database::new();
        db.store.update_at(1000, DAY, 0, |plan| { plan.tasks.push(task("a", false)); Ok(()) }).unwrap();
        let before = db.store.load_at(1000, DAY, 0).unwrap();
        assert!(db.store.update_at(2000, DAY, 0, |plan| {
            plan.tasks[0].title = "must roll back".into();
            plan.tasks.push(task("bad", false));
            plan.tasks[1].title.clear();
            Ok(())
        }).is_err());
        assert_eq!(db.store.load_at(3000, DAY, 0).unwrap().tasks, before.tasks);
        assert!(db.store.update_at(4000, DAY, 0, |plan| {
            plan.tasks.push(task("a", false)); Ok(())
        }).is_err());
        assert_eq!(db.store.load_at(5000, DAY, 0).unwrap().tasks, before.tasks);
    }

    #[test]
    fn schedules_start_in_backend_but_never_restart_explicit_pauses() {
        let db = Database::new();
        db.store.update_at(1000, DAY, 9 * 60, |plan| {
            for id in ["a", "b", "paused"] {
                let mut task = task(id, false);
                task.start = Some("10:00".into());
                task.paused = id == "paused";
                plan.tasks.push(task);
            }
            Ok(())
        }).unwrap();
        assert!(db.store.load_at(2000, DAY, 9 * 60 + 59).unwrap().tasks.iter().all(|task| !task.running));
        let plan = db.store.load_at(3000, DAY, 10 * 60).unwrap();
        assert!(plan.tasks[0].running && plan.tasks[1].running);
        assert!(plan.tasks[2].paused && !plan.tasks[2].running);
        assert_eq!(plan.tasks[0].running_since_ms, Some(3000));
    }

    #[test]
    fn unfinished_tasks_cross_midnight_without_relabeling_history() {
        let db = Database::new();
        db.store.update_at(1000, DAY, 0, |plan| {
            plan.tasks.push(task("running", true));
            let mut done = task("old-done", false); done.done = true;
            plan.tasks.push(done); Ok(())
        }).unwrap();
        let next = db.store.load_at(3000, "2026-10-27", 0).unwrap();
        assert_eq!(next.tasks.len(), 1);
        assert_eq!(next.tasks[0].plan_date, DAY);
        assert_eq!(next.tasks[0].spent_sec, 2);
        db.store.update_at(4000, "2026-10-27", 0, |plan| { plan.tasks.clear(); Ok(()) }).unwrap();
        let conn = db.store.connect().unwrap();
        let remaining: String = conn.query_row("SELECT id FROM tasks", [], |row| row.get(0)).unwrap();
        assert_eq!(remaining, "old-done");
    }

    #[test]
    fn completing_carried_work_returns_its_settled_result_then_archives_it() {
        let db = Database::new();
        db.store.update_at(1000, DAY, 0, |plan| { plan.tasks.push(task("a", true)); Ok(()) }).unwrap();
        let result = db.store.update_at(4500, "2026-10-27", 0, |plan| {
            plan.tasks[0].done = true;
            Ok(())
        }).unwrap();
        assert!(result.tasks[0].done);
        assert_eq!(result.tasks[0].elapsed_ms, 3500);
        assert!(db.store.load_at(5000, "2026-10-27", 0).unwrap().tasks.is_empty());
    }
}
