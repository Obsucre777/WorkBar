//! Workbar MCP server.
//!
//! A tiny stdio Model Context Protocol server that lets *any* AI harness
//! (Claude Code, Cursor, Codex, DSH, ...) read and edit the day plan that the
//! Workbar floating bar is displaying.
//!
//! No async runtime, no SDK, no Node.js: just JSON-RPC 2.0 over stdio.
//! Tasks live in `%APPDATA%\Workbar\workbar.db`, shared with the app.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::OnceLock;

use workbar_core::{normalize_task, parse_hhmm, Plan, Task, TimerMode};

const SERVER_NAME: &str = "workbar";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const FALLBACK_PROTOCOL: &str = "2024-11-05";

/// Name of the AI client that connected, captured from `initialize`.
static CLIENT_NAME: OnceLock<String> = OnceLock::new();

fn remember_client(params: &Value) {
    let name = params
        .get("clientInfo")
        .and_then(|info| info.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !name.is_empty() {
        let _ = CLIENT_NAME.set(name.to_string());
    }
}

fn client_name() -> String {
    CLIENT_NAME
        .get()
        .cloned()
        .unwrap_or_else(|| "ai".to_string())
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                write_message(
                    &mut stdout,
                    &json!({
                        "jsonrpc": "2.0",
                        "id": Value::Null,
                        "error": { "code": -32700, "message": format!("JSON 解析失败: {err}") }
                    }),
                );
                continue;
            }
        };
        if let Some(response) = dispatch(&message) {
            write_message(&mut stdout, &response);
        }
    }
}

fn write_message(out: &mut io::Stdout, value: &Value) {
    let _ = out.write_all(value.to_string().as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

type RpcError = (i64, String);

fn dispatch(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    // Notifications never get a response.
    let is_notification = id.is_none();

    let outcome: Result<Value, RpcError> = match method {
        "initialize" => {
            remember_client(&params);
            Ok(initialize_result(&params))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(&params),
        "resources/list" => Ok(json!({ "resources": [] })),
        "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "logging/setLevel" => Ok(json!({})),
        "notifications/initialized"
        | "notifications/cancelled"
        | "notifications/roots/list_changed" => return None,
        other => Err((-32601, format!("method not found: {other}"))),
    };

    if is_notification {
        return None;
    }

    let id = id.unwrap_or(Value::Null);
    match outcome {
        Ok(result) => Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        Err((code, message)) => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        })),
    }
}

// ---------------------------------------------------------------------------
// Protocol surface
// ---------------------------------------------------------------------------

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(FALLBACK_PROTOCOL);
    json!({
        "protocolVersion": requested,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": SERVER_NAME,
            "title": "Workbar",
            "version": SERVER_VERSION
        },
        "instructions": "Workbar is the user's always-on-top floating work bar on Windows. Each task has its own independent timer and state; no task has priority because of its position or a current-task marker. The bar is the single source of truth for today's plan. \
\n\nWhen to call tools (do it proactively, do not just print a plan in chat): whenever the user talks about today's plan, their tasks, what to do next, finishing something, moving/renaming a task, or asks for a schedule. \
\n\nWorkflow rules:\n\
1. Call workbar_get_today before reading or editing so you reuse existing task ids and see which task the bar is showing.\n\
2. workbar_plan_day replaces the whole day — use it only when starting or fully re-planning the day.\n\
3. Queue order is stable: workbar_add_tasks appends in supplied order; editing times or timer states never reorders tasks. Only when explicitly requested, use position='first'/'last' or after_id on add/update, or workbar_reorder_tasks with task_ids / by='start_time'. Prefer these over re-creating the day.\n\
4. Times are local HH:mm (24h). One task = one short piece of work; titles must be short (<= 14 Chinese chars / ~40 latin chars) because the bar is tiny; prefer 3-8 tasks per day. A task with an estimate or a time window counts down against it; a task with neither is an open-ended stopwatch (timer 'up', ring laps once per hour).\n\
5. After a write, reply with one short confirmation line. The bar updates in under a second; there is no need to echo the whole plan.\n\
6. Tasks may run in parallel. Starting, pausing, or finishing one task never changes another task. Set running=true to start a task and running=false to explicitly pause it.\n\
7. Show your work on the bar. Every time the user gives you a job to do — write/fix/check/research/summarize/build something, even a quick \"is X configured?\" check — first summarize it into a 3-8 character title and call workbar_start_work with that title: the bar immediately shows a running stopwatch for the job. When the job is finished, call workbar_finish_work with that task's id so only that task is marked done. Starting another job leaves existing sessions unchanged. Skip this only for pure chit-chat or clarifying questions, and never use workbar_add_tasks for your own work sessions."
    })
}

fn task_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "Short task title shown on the bar (<= 14 Chinese characters)."
            },
            "start": {
                "type": "string",
                "pattern": "^\\d{1,2}:\\d{2}$",
                "description": "Local start time, HH:mm (24h)."
            },
            "end": {
                "type": "string",
                "pattern": "^\\d{1,2}:\\d{2}$",
                "description": "Local end time, HH:mm (24h)."
            },
            "est_min": {
                "type": "integer",
                "minimum": 1,
                "maximum": 720,
                "description": "Planned minutes for a countdown task (defaults to end-start when both times are given, otherwise 25). Leave it out — together with start/end — to get an open-ended stopwatch task."
            },
            "timer": {
                "type": "string",
                "enum": ["down", "up"],
                "description": "Timer mode. 'down' counts down against est_min (default when an estimate or a time window exists); 'up' is a stopwatch with no target (use it for open-ended work like 'write the report until it's done')."
            },
            "running": {
                "type": "boolean",
                "description": "Start this new task immediately, independently of every other task. Defaults to false."
            },
            "paused": {
                "type": "boolean",
                "description": "Create an explicitly paused task that its schedule must not automatically start. Ignored when running is true."
            },
            "note": {
                "type": "string",
                "description": "Optional one-line detail."
            }
        },
        "required": ["title"],
        "additionalProperties": false
    })
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "workbar_get_today",
            "title": "Read today's Workbar plan",
            "description": "Read the user's current day plan: tasks, ids, time windows, estimates, and how much time was actually spent. Call this first before editing. If you are about to do a job for the user, call workbar_start_work first so the bar shows it.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "workbar_start_work",
            "title": "Show that you are working",
            "description": "REQUIRED FIRST STEP whenever the user gives you a job to do — any research, lookup, check, writing, coding, fixing, summarizing, planning or building task, even a small one like \"what's the weather?\" or \"is X configured?\". Before running any other tool (web search, file reads, commands), summarize the job into a 3-8 character title and call this: the Workbar floating bar immediately shows that job as a running stopwatch. When the job is finished, call workbar_finish_work so the task is marked done. Only skip this for pure chit-chat or clarifying questions. Do NOT announce the stopwatch in your answer; just use the tools.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title of the work (3-8 Chinese chars / a few latin words)."
                    },
                    "note": { "type": "string", "description": "Optional one-line detail." }
                },
                "required": ["title"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_finish_work",
            "title": "Show that you finished",
            "description": "Call this right after you finish the job announced with workbar_start_work (before composing your final answer): the running stopwatch stops and the task is marked done on the bar.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Task id. May be omitted only if this client has exactly one unfinished session. Required when multiple sessions are open."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_plan_day",
            "title": "Replace today's plan",
            "description": "Write a complete day plan, replacing all tasks in the supplied order. Use when the user asks to plan their day, or says something like 'today I need to do X, Y, Z'. Provide short task titles and optional start/end times; times do not change queue order.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": { "type": "array", "items": task_schema(), "minItems": 1 }
                },
                "required": ["tasks"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_add_tasks",
            "title": "Add tasks",
            "description": "Append one or more tasks in supplied order without moving existing tasks or changing their states. Use position or after_id only when the user explicitly requests another placement. Times do not change queue order.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": { "type": "array", "items": task_schema(), "minItems": 1 },
                    "position": { "type": "string", "enum": ["first", "last"], "description": "Explicitly insert this batch at the front or end. Omit to append. Cannot combine with after_id." },
                    "after_id": { "type": "string", "description": "Explicitly insert this batch after an existing task id. Cannot combine with position." }
                },
                "required": ["tasks"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_update_task",
            "title": "Update a task",
            "description": "Change one task in place: title, time window, estimate, timer mode, note, running state, or done state. Times and state changes preserve queue order. Use position or after_id only for an explicitly requested move. Set running=true to start only this timer; running=false explicitly pauses it, including after a restart. Other tasks keep their own states.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id from workbar_get_today." },
                    "title": { "type": "string" },
                    "start": { "type": ["string", "null"], "description": "New start HH:mm, or null to clear." },
                    "end": { "type": ["string", "null"], "description": "New end HH:mm, or null to clear." },
                    "est_min": { "type": "integer", "minimum": 1 },
                    "timer": {
                        "type": "string",
                        "enum": ["down", "up"],
                        "description": "Switch the timer mode for this task. Ignored by 'up' tasks."
                    },
                    "note": { "type": ["string", "null"] },
                    "running": { "type": "boolean", "description": "Start or explicitly pause only this task's timer." },
                    "done": { "type": "boolean" },
                    "position": { "type": "string", "enum": ["first", "last"], "description": "Explicitly move this task to the front or end. Cannot combine with after_id." },
                    "after_id": { "type": "string", "description": "Explicitly move this task after another task id. Cannot combine with position." }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_reorder_tasks",
            "title": "Explicitly reorder tasks",
            "description": "Only when the user explicitly asks to reorder: supply task_ids to place those tasks first in that order (unlisted tasks retain their relative order), or by='start_time' to sort by scheduled start with unscheduled tasks last. Equal times keep their previous order. Supply exactly one of task_ids or by. Task data and timer states are preserved.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1, "uniqueItems": true },
                    "by": { "type": "string", "enum": ["start_time"] }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_set_current",
            "title": "Start one task (compatibility tool)",
            "description": "Compatibility alias: start only the specified task. Tasks no longer have a unique current-task identity; other tasks are unchanged.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_complete_task",
            "title": "Mark a task done",
            "description": "Mark only the specified task as finished and stop its timer. Other tasks keep their own states.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_remove_task",
            "title": "Delete a task",
            "description": "Remove a task from today's plan.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_clear_day",
            "title": "Clear today's plan",
            "description": "Remove every task from today's plan. Only use when the user explicitly asks to clear or start over.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
    ]
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

fn call_tool(params: &Value) -> Result<Value, RpcError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "缺少 tool name".to_string()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "workbar_get_today" => Ok(tool_get_today(&args)),
        "workbar_plan_day" => Ok(tool_plan_day(&args)),
        "workbar_add_tasks" => Ok(tool_add_tasks(&args)),
        "workbar_update_task" => Ok(tool_update_task(&args)),
        "workbar_reorder_tasks" => Ok(tool_reorder_tasks(&args)),
        "workbar_set_current" => Ok(tool_set_current(&args)),
        "workbar_complete_task" => Ok(tool_complete_task(&args)),
        "workbar_remove_task" => Ok(tool_remove_task(&args)),
        "workbar_clear_day" => Ok(tool_clear_day()),
        "workbar_start_work" => Ok(tool_start_work(&args)),
        "workbar_finish_work" => Ok(tool_finish_work(&args)),
        other => Err((-32602, format!("unknown tool: {other}"))),
    }
}

fn text_result(text: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": false
    })
}

fn error_result(text: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": true
    })
}

fn render(plan: &Plan, message: &str) -> Value {
    text_result(json!({ "message": message, "date": plan.date,
        "tasks": plan.tasks.iter().map(compact_task).collect::<Vec<_>>() }).to_string())
}

fn compact_task(task: &Task) -> Value {
    json!({ "id": task.id, "title": task.title, "timer": workbar_core::timer_mode(task),
        "running": task.running, "paused": task.paused, "done": task.done, "spent_sec": task.spent_sec })
}

fn task_result(plan: &Plan, id: &str) -> Value {
    match plan.tasks.iter().find(|task| task.id == id) {
        Some(task) => text_result(compact_task(task).to_string()),
        None => error_result(format!("找不到任务 {id}")),
    }
}

fn tool_get_today(_args: &Value) -> Value {
    match workbar_core::load() {
        Ok(plan) => {
            let mut text = String::new();
            if !plan.date.is_empty() && plan.date != workbar_core::today() {
                text.push_str(&format!(
                    "注意：当前计划日期是 {}，今天是 {}。可以用 workbar_plan_day 重新安排今天。\n\n",
                    plan.date,
                    workbar_core::today()
                ));
            }
            text.push_str(&workbar_core::tool_result_text(&plan, "今日 Workbar 计划"));
            text_result(text)
        }
        Err(err) => error_result(err),
    }
}

fn parse_tasks(value: &Value) -> Result<Vec<Task>, String> {
    let items = value.as_array().ok_or_else(|| "tasks 必须是数组".to_string())?;
    if items.is_empty() {
        return Err("tasks 不能为空".to_string());
    }
    let mut tasks = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let mut task: Task = serde_json::from_value(item.clone())
            .map_err(|err| format!("第 {} 个任务格式错误：{err}", index + 1))?;
        normalize_task(&mut task).map_err(|err| format!("第 {} 个任务无效：{err}", index + 1))?;
        tasks.push(task);
    }
    Ok(tasks)
}

fn tool_plan_day(args: &Value) -> Value {
    let tasks = match parse_tasks(args.get("tasks").unwrap_or(&Value::Null)) {
        Ok(tasks) => tasks,
        Err(err) => return error_result(err),
    };
    match workbar_core::update(|plan| {
        plan.date = workbar_core::today();
        plan.tasks = tasks.clone();
        Ok(())
    }) {
        Ok(plan) => render(&plan, "已安排今天的计划。"),
        Err(err) => error_result(err),
    }
}

fn tool_add_tasks(args: &Value) -> Value {
    let tasks = match parse_tasks(args.get("tasks").unwrap_or(&Value::Null)) {
        Ok(tasks) => tasks,
        Err(err) => return error_result(err),
    };
    let placement = match parse_placement(args) {
        Ok(value) => value,
        Err(err) => return error_result(err),
    };
    let added_ids: Vec<_> = tasks.iter().map(|task| task.id.clone()).collect();
    match workbar_core::update(|plan| {
        if plan.date.trim().is_empty() || plan.date != workbar_core::today() {
            plan.date = workbar_core::today();
        }
        insert_tasks(plan, tasks, placement)?;
        Ok(())
    }) {
        Ok(mut plan) => {
            plan.tasks.retain(|task| added_ids.contains(&task.id));
            render(&plan, "已添加任务。")
        }
        Err(err) => error_result(err),
    }
}

enum Placement {
    First,
    Last,
    After(String),
}

fn parse_placement(args: &Value) -> Result<Option<Placement>, String> {
    match (args.get("position"), args.get("after_id")) {
        (None, None) => Ok(None),
        (Some(_), Some(_)) => Err("position 和 after_id 不能同时指定".into()),
        (Some(value), None) => match value.as_str() {
            Some("first") => Ok(Some(Placement::First)),
            Some("last") => Ok(Some(Placement::Last)),
            _ => Err("position 只能是 first 或 last".into()),
        },
        (None, Some(value)) => value.as_str().map(str::trim)
            .filter(|id| !id.is_empty())
            .map(|id| Some(Placement::After(id.to_string())))
            .ok_or_else(|| "after_id 必须是非空任务 id".into()),
    }
}

fn insert_tasks(plan: &mut Plan, tasks: Vec<Task>, placement: Option<Placement>) -> Result<(), String> {
    let index = match placement {
        Some(Placement::First) => 0,
        Some(Placement::After(id)) => plan.tasks.iter().position(|task| task.id == id)
            .map(|index| index + 1).ok_or_else(|| format!("找不到位置参照任务 {id}"))?,
        None | Some(Placement::Last) => plan.tasks.len(),
    };
    plan.tasks.splice(index..index, tasks);
    Ok(())
}

fn tool_reorder_tasks(args: &Value) -> Value {
    let ids = match (args.get("task_ids"), args.get("by")) {
        (None, Some(value)) if value.as_str() == Some("start_time") => None,
        (Some(value), None) => {
            let Some(values) = value.as_array().filter(|values| !values.is_empty()) else {
                return error_result("task_ids 必须是非空 id 数组".into());
            };
            let mut ids = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for value in values {
                let Some(id) = value.as_str().map(str::trim).filter(|id| !id.is_empty()) else {
                    return error_result("task_ids 只能包含非空任务 id".into());
                };
                if !seen.insert(id.to_string()) {
                    return error_result(format!("任务 id 重复：{id}"));
                }
                ids.push(id.to_string());
            }
            Some(ids)
        }
        _ => return error_result("请只指定 task_ids，或指定 by: start_time".into()),
    };
    match workbar_core::update(|plan| {
        if let Some(ids) = ids {
            let mut reordered = Vec::with_capacity(plan.tasks.len());
            for id in &ids {
                let task = plan.tasks.iter().find(|task| &task.id == id)
                    .ok_or_else(|| format!("找不到任务 {id}"))?;
                reordered.push(task.clone());
            }
            let selected: std::collections::HashSet<_> = ids.into_iter().collect();
            reordered.extend(plan.tasks.iter().filter(|task| !selected.contains(&task.id)).cloned());
            plan.tasks = reordered;
        } else {
            workbar_core::sort_tasks(&mut plan.tasks);
        }
        Ok(())
    }) {
        Ok(plan) => text_result(json!({ "task_ids": plan.tasks.iter().map(|task| &task.id).collect::<Vec<_>>() }).to_string()),
        Err(err) => error_result(err),
    }
}

fn required_id(args: &Value) -> Result<String, Value> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    match id {
        Some(id) => Ok(id),
        None => Err(error_result("缺少任务 id（先用 workbar_get_today 查看）".to_string())),
    }
}

fn tool_update_task(args: &Value) -> Value {
    let id = match required_id(args) {
        Ok(id) => id,
        Err(err) => return err,
    };
    let placement = match parse_placement(args) {
        Ok(value) => value,
        Err(err) => return error_result(err),
    };
    if matches!(&placement, Some(Placement::After(after)) if after == &id) {
        return error_result("不能将任务放到它自己后面".into());
    }
    let result = workbar_core::update(|plan| {
        let task = plan
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| format!("找不到任务 {id}"))?;

        if let Some(title) = args.get("title").and_then(Value::as_str) {
            task.title = title.to_string();
        }
        if let Some(value) = args.get("start") {
            task.start = optional_boundary(value, "start")?;
        }
        if let Some(value) = args.get("end") {
            task.end = optional_boundary(value, "end")?;
        }
        if let Some(value) = args.get("est_min").and_then(Value::as_u64) {
            task.est_min = value as u32;
        }
        if let Some(value) = args.get("timer") {
            task.timer = match value.as_str() {
                Some("up") => Some(workbar_core::TimerMode::Up),
                Some("down") => Some(workbar_core::TimerMode::Down),
                None => None,
                Some(other) => return Err(format!("timer 只能是 down 或 up，收到：{other}")),
            };
        }
        if let Some(value) = args.get("note") {
            task.note = optional_text(value);
        }
        if let Some(done) = args.get("done").and_then(Value::as_bool) {
            task.done = done;
            if done {
                task.running = false;
                task.paused = false;
            }
        }
        if let Some(running) = args.get("running").and_then(Value::as_bool) {
            task.running = running && !task.done;
            task.paused = !running && !task.done;
        }

        normalize_task(task)?;
        if placement.is_some() {
            let index = plan.tasks.iter().position(|task| task.id == id).unwrap();
            let task = plan.tasks.remove(index);
            insert_tasks(plan, vec![task], placement)?;
        }
        Ok(())
    });
    match result {
        Ok(plan) => task_result(&plan, &id),
        Err(err) => error_result(err),
    }
}

fn tool_set_current(args: &Value) -> Value {
    let id = match required_id(args) {
        Ok(id) => id,
        Err(err) => return err,
    };
    match workbar_core::update(|plan| {
        let task = plan.tasks.iter_mut().find(|task| task.id == id)
            .ok_or_else(|| format!("找不到任务 {id}"))?;
        if task.done { return Err("已完成的任务不能开始，请先将 done 改为 false".into()); }
        task.running = true;
        task.paused = false;
        Ok(())
    }) {
        Ok(plan) => task_result(&plan, &id),
        Err(err) => error_result(err),
    }
}

fn tool_complete_task(args: &Value) -> Value {
    let id = match required_id(args) {
        Ok(id) => id,
        Err(err) => return err,
    };
    match workbar_core::update(|plan| {
        let task = plan
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| format!("找不到任务 {id}"))?;
        task.done = true;
        task.running = false;
        task.paused = false;
        Ok(())
    }) {
        Ok(plan) => task_result(&plan, &id),
        Err(err) => error_result(err),
    }
}

fn tool_remove_task(args: &Value) -> Value {
    let id = match required_id(args) {
        Ok(id) => id,
        Err(err) => return err,
    };
    match workbar_core::update(|plan| {
        let before = plan.tasks.len();
        plan.tasks.retain(|task| task.id != id);
        if plan.tasks.len() == before {
            return Err(format!("找不到任务 {id}"));
        }
        Ok(())
    }) {
        Ok(_) => text_result(json!({ "id": id, "removed": true }).to_string()),
        Err(err) => error_result(err),
    }
}

fn tool_clear_day() -> Value {
    let mut removed = 0;
    match workbar_core::update(|plan| {
        removed = plan.tasks.len();
        plan.tasks.clear();
        plan.date = workbar_core::today();
        Ok(())
    }) {
        Ok(_) => text_result(json!({ "cleared": true, "removed_count": removed }).to_string()),
        Err(err) => error_result(err),
    }
}

/// Start an AI work session: a running stopwatch task with no target.
fn tool_start_work(args: &Value) -> Value {
    let title = match args
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(title) => title.to_string(),
        None => return error_result("title 不能为空".to_string()),
    };
    let note = args
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let source = client_name();
    let mut task = Task {
            title,
            note,
            timer: Some(TimerMode::Up),
            running: true,
            source: Some(source.clone()),
            ..Task::default()
    };
    if let Err(error) = normalize_task(&mut task) { return error_result(error); }
    let id = task.id.clone();
    let result = workbar_core::update(|plan| {
        plan.tasks.push(task);
        Ok(())
    });
    match result {
        Ok(plan) => task_result(&plan, &id),
        Err(err) => error_result(err),
    }
}

/// Finish the running AI work session: the task is marked done.
fn tool_finish_work(args: &Value) -> Value {
    let explicit = args
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let source = client_name();
    let mut finished_id = String::new();
    let result = workbar_core::update(|plan| {
        let index = if let Some(id) = explicit.clone() {
            plan.tasks
                .iter()
                .position(|task| task.id == id)
                .ok_or_else(|| format!("找不到任务 {id}"))?
        } else {
            let matches: Vec<_> = plan.tasks.iter().enumerate()
                .filter(|(_, task)| task.source.as_deref() == Some(source.as_str()) && !task.done)
                .map(|(index, _)| index).collect();
            match matches.as_slice() {
                [index] => *index,
                [] => return Err("本客户端没有未完成的 AI 工作会话，请提供要完成的任务 id".into()),
                _ => return Err("本客户端有多个未完成的 AI 工作会话，请提供要完成的任务 id".into()),
            }
        };
        let task = &mut plan.tasks[index];
        finished_id = task.id.clone();
        task.done = true;
        task.running = false;
        task.paused = false;
        Ok(())
    });
    match result {
        Ok(plan) => task_result(&plan, &finished_id),
        Err(err) => error_result(err),
    }
}

fn optional_text(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn optional_boundary(value: &Value, field: &str) -> Result<Option<String>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let raw = value
        .as_str()
        .ok_or_else(|| format!("{field} 必须是 HH:mm 字符串或 null"))?
        .trim()
        .to_string();
    if raw.is_empty() {
        return Ok(None);
    }
    if parse_hhmm(&raw).is_none() {
        return Err(format!("{field} 必须是 HH:mm 格式，收到：{raw}"));
    }
    Ok(Some(raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_operations_keep_other_tasks_independent() {
        let directory = std::env::temp_dir().join(format!("workbar-independent-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs_create_directory(&directory);
        let previous = std::env::var_os("WORKBAR_DATA_DIR");
        std::env::set_var("WORKBAR_DATA_DIR", &directory);
        struct Restore { previous: Option<std::ffi::OsString>, directory: std::path::PathBuf }
        impl Drop for Restore {
            fn drop(&mut self) {
                if let Some(value) = &self.previous { std::env::set_var("WORKBAR_DATA_DIR", value); }
                else { std::env::remove_var("WORKBAR_DATA_DIR"); }
                let _ = std::fs::remove_file(self.directory.join("workbar.db"));
                let _ = std::fs::remove_file(self.directory.join("workbar.db-wal"));
                let _ = std::fs::remove_file(self.directory.join("workbar.db-shm"));
                let _ = std::fs::remove_dir(&self.directory);
            }
        }
        let _restore = Restore { previous, directory };
        remember_client(&json!({ "clientInfo": { "name": "independence-test" } }));
        let ok = |value: Value| { assert_ne!(value["isError"], true, "{value}"); };
        ok(tool_add_tasks(&json!({ "tasks": [
            { "id": "a", "title": "a", "est_min": 30, "running": true },
            { "id": "b", "title": "b", "est_min": 30, "paused": true },
            { "id": "c", "title": "c", "timer": "up" }
        ] })));
        ok(tool_set_current(&json!({ "id": "c" })));
        let plan = workbar_core::load().unwrap();
        assert!(plan.tasks.iter().find(|task| task.id == "a").unwrap().running);
        assert!(plan.tasks.iter().find(|task| task.id == "b").unwrap().paused);
        assert!(plan.tasks.iter().find(|task| task.id == "c").unwrap().running);

        ok(tool_update_task(&json!({ "id": "c", "running": false })));
        let plan = workbar_core::load().unwrap();
        let paused = plan.tasks.iter().find(|task| task.id == "c").unwrap();
        assert!(paused.paused && !paused.running && paused.spent_sec == 0);
        assert!(plan.tasks.iter().find(|task| task.id == "a").unwrap().running);
        ok(tool_complete_task(&json!({ "id": "c" })));
        ok(tool_update_task(&json!({ "id": "c", "done": false, "running": true })));
        assert!(workbar_core::load().unwrap().tasks.iter().find(|task| task.id == "c").unwrap().running);

        ok(tool_start_work(&json!({ "title": "first independent session" })));
        let first = workbar_core::load().unwrap().tasks.iter().find(|task| task.title == "first independent session").unwrap().id.clone();
        ok(tool_start_work(&json!({ "title": "second independent session" })));
        let second = workbar_core::load().unwrap().tasks.iter().find(|task| task.title == "second independent session").unwrap().id.clone();
        let plan = workbar_core::load().unwrap();
        let first_task = plan.tasks.iter().find(|task| task.id == first).unwrap();
        assert!(first_task.running && !first_task.done);
        assert!(plan.tasks.iter().find(|task| task.id == "a").unwrap().running);
        assert_eq!(tool_finish_work(&json!({}))["isError"], true);
        assert!(workbar_core::load().unwrap().tasks.iter().filter(|task| task.id == first || task.id == second).all(|task| task.running && !task.done));
        ok(tool_finish_work(&json!({ "id": second })));
        let plan = workbar_core::load().unwrap();
        assert!(plan.tasks.iter().find(|task| task.id == second).unwrap().done);
        assert!(!plan.tasks.iter().find(|task| task.id == first).unwrap().done);
        ok(tool_finish_work(&json!({})));
        assert!(workbar_core::load().unwrap().tasks.iter().find(|task| task.id == first).unwrap().done);

        ok(tool_add_tasks(&json!({ "tasks": [
            { "id": "foreign", "title": "another client's work", "timer": "up", "running": true, "source": "another-client" }
        ] })));
        assert_eq!(tool_finish_work(&json!({}))["isError"], true);
        assert!(workbar_core::load().unwrap().tasks.iter().find(|task| task.id == "foreign").unwrap().running);

        ok(tool_start_work(&json!({ "title": "open one" })));
        ok(tool_start_work(&json!({ "title": "open two" })));
        assert_eq!(tool_finish_work(&json!({}))["isError"], true);
        let plan = workbar_core::load().unwrap();
        assert_eq!(plan.tasks.iter().filter(|task| task.source.as_deref() == Some("independence-test") && !task.done).count(), 2);
    }

    fn fs_create_directory(path: &std::path::Path) {
        std::fs::create_dir(path).unwrap();
    }
}
