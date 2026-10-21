//! Workbar MCP server.
//!
//! A tiny stdio Model Context Protocol server that lets *any* AI harness
//! (Claude Code, Cursor, Codex, DSH, ...) read and edit the day plan that the
//! Workbar floating bar is displaying.
//!
//! No async runtime, no SDK, no Node.js: just JSON-RPC 2.0 over stdio.
//! All state lives in `%APPDATA%\Workbar\plan.json`, shared with the app.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

use workbar_core::{normalize_task, parse_hhmm, Plan, Task};

const SERVER_NAME: &str = "workbar";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const FALLBACK_PROTOCOL: &str = "2024-11-05";

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
        "initialize" => Ok(initialize_result(&params)),
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
        "instructions": "Workbar is the user's always-on-top floating work bar on Windows. It shows exactly one current task with a timer ring, plus the next few tasks. The bar is the single source of truth for today's plan. \
\n\nWhen to call tools (do it proactively, do not just print a plan in chat): whenever the user talks about today's plan, their tasks, what to do next, finishing something, moving/renaming a task, or asks for a schedule. \
\n\nWorkflow rules:\n\
1. Call workbar_get_today before reading or editing so you reuse existing task ids and see which task the bar is showing.\n\
2. workbar_plan_day replaces the whole day — use it only when starting or fully re-planning the day.\n\
3. workbar_add_tasks appends; workbar_update_task moves/renames one task; prefer these over re-creating the day.\n\
4. Times are local HH:mm (24h). One task = one short piece of work; titles must be short (<= 14 Chinese chars / ~40 latin chars) because the bar is tiny; prefer 3-8 tasks per day.\n\
5. After a write, reply with one short confirmation line. The bar updates in under a second; there is no need to echo the whole plan."
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
                "description": "Estimated minutes. Defaults to end-start when both times are given, otherwise 25."
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
            "description": "Read the user's current day plan: tasks, ids, time windows, estimates, and how much time was actually spent. Call this first before editing.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }),
        json!({
            "name": "workbar_plan_day",
            "title": "Replace today's plan",
            "description": "Write a complete day plan, replacing all tasks. Use when the user asks to plan their day, or says something like 'today I need to do X, Y, Z'. Provide short task titles and optional start/end times.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "intro": {
                        "type": "string",
                        "description": "One short line describing what today is really about."
                    },
                    "tasks": {
                        "type": "array",
                        "items": task_schema(),
                        "minItems": 1
                    }
                },
                "required": ["tasks"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_add_tasks",
            "title": "Add tasks to today",
            "description": "Append one or more tasks to today's plan without touching existing ones. Use for 'add a task', 'also remind me to...'.",
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
            "name": "workbar_update_task",
            "title": "Update a task",
            "description": "Change one task in place: title, time window, estimate, note, or done state. Use the id from workbar_get_today.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Task id from workbar_get_today." },
                    "title": { "type": "string" },
                    "start": { "type": ["string", "null"], "description": "New start HH:mm, or null to clear." },
                    "end": { "type": ["string", "null"], "description": "New end HH:mm, or null to clear." },
                    "est_min": { "type": "integer", "minimum": 1 },
                    "note": { "type": ["string", "null"] },
                    "done": { "type": "boolean" }
                },
                "required": ["id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "workbar_set_current",
            "title": "Point the bar at a task",
            "description": "Make a specific task the one shown on the bar right now.",
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
            "description": "Mark one task as finished. The bar will automatically move on to the next task.",
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
        "workbar_set_current" => Ok(tool_set_current(&args)),
        "workbar_complete_task" => Ok(tool_complete_task(&args)),
        "workbar_remove_task" => Ok(tool_remove_task(&args)),
        "workbar_clear_day" => Ok(tool_clear_day()),
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
    text_result(workbar_core::tool_result_text(plan, message))
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
    let intro = args
        .get("intro")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    match workbar_core::update(|plan| {
        plan.date = workbar_core::today();
        plan.intro = intro.clone();
        plan.tasks = tasks.clone();
        plan.current_id = None;
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
    match workbar_core::update(|plan| {
        if plan.date.trim().is_empty() || plan.date != workbar_core::today() {
            plan.date = workbar_core::today();
            plan.current_id = None;
        }
        plan.tasks.extend(tasks.clone());
        Ok(())
    }) {
        Ok(plan) => render(&plan, "已添加到今天的计划。"),
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
        if let Some(value) = args.get("note") {
            task.note = optional_text(value);
        }
        if let Some(done) = args.get("done").and_then(Value::as_bool) {
            task.done = done;
            if done {
                task.running = false;
            }
        }

        normalize_task(task)?;
        if task.done && plan.current_id.as_deref() == Some(task.id.as_str()) {
            plan.current_id = None;
        }
        Ok(())
    });
    match result {
        Ok(plan) => render(&plan, "已更新任务。"),
        Err(err) => error_result(err),
    }
}

fn tool_set_current(args: &Value) -> Value {
    let id = match required_id(args) {
        Ok(id) => id,
        Err(err) => return err,
    };
    match workbar_core::update(|plan| {
        if !plan.tasks.iter().any(|task| task.id == id) {
            return Err(format!("找不到任务 {id}"));
        }
        plan.current_id = Some(id.clone());
        Ok(())
    }) {
        Ok(plan) => render(&plan, "已切换当前任务。"),
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
        if plan.current_id.as_deref() == Some(id.as_str()) {
            plan.current_id = None;
        }
        Ok(())
    }) {
        Ok(plan) => render(&plan, "已完成一项。"),
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
        if plan.current_id.as_deref() == Some(id.as_str()) {
            plan.current_id = None;
        }
        Ok(())
    }) {
        Ok(plan) => render(&plan, "已删除任务。"),
        Err(err) => error_result(err),
    }
}

fn tool_clear_day() -> Value {
    match workbar_core::update(|plan| {
        plan.tasks.clear();
        plan.current_id = None;
        plan.intro = None;
        plan.date = workbar_core::today();
        Ok(())
    }) {
        Ok(plan) => render(&plan, "已清空今天的计划。"),
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
