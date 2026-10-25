//! Tray shortcut preferences. This module never reads or writes the task plan.

use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path, sync::{atomic::{AtomicBool, Ordering}, Mutex}};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+W";
const LABEL: &str = "shortcut-settings";

#[derive(Clone, Serialize)]
pub struct ShortcutInfo {
    shortcut: String,
    default_shortcut: &'static str,
    registered: bool,
    error: Option<String>,
}

struct Current {
    info: ShortcutInfo,
    active: Option<Shortcut>,
}

pub struct SettingsState {
    current: Mutex<Current>,
    operation: Mutex<()>,
    menu: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
    recording: AtomicBool,
    opening: AtomicBool,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            current: Mutex::new(Current {
                info: ShortcutInfo { shortcut: DEFAULT_SHORTCUT.into(), default_shortcut: DEFAULT_SHORTCUT, registered: false, error: None },
                active: None,
            }),
            operation: Mutex::new(()), menu: Mutex::new(None),
            recording: AtomicBool::new(false), opening: AtomicBool::new(false),
        }
    }
}

fn parse(value: &str) -> Result<Shortcut, String> {
    let key = value.trim().parse::<Shortcut>().map_err(|_| "请使用单个按键，或 Ctrl / Alt 组合键".to_string())?;
    if key.mods.intersects(Modifiers::SUPER | Modifiers::META) || key.key == Code::F12 {
        return Err("避开 Windows 键和 F12，其余单键或组合键都可以".into());
    }
    Ok(key)
}

fn display(key: Shortcut) -> String {
    let mut parts = Vec::new();
    if key.mods.contains(Modifiers::CONTROL) { parts.push("Ctrl".to_string()); }
    if key.mods.contains(Modifiers::ALT) { parts.push("Alt".to_string()); }
    if key.mods.contains(Modifiers::SHIFT) { parts.push("Shift".to_string()); }
    let code = key.key.to_string();
    parts.push(code.strip_prefix("Key").or_else(|| code.strip_prefix("Digit")).unwrap_or(&code).into());
    parts.join("+")
}

#[derive(Serialize, Deserialize)]
struct Preference { shortcut: String }

fn read_preference(path: &Path) -> Result<String, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice::<Preference>(&body).map(|p| p.shortcut).map_err(|_| "快捷键配置无法读取，可重新设置后保存".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DEFAULT_SHORTCUT.into()),
        Err(error) => Err(format!("读取快捷键配置失败：{error}")),
    }
}

fn write_preference(path: &Path, shortcut: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("快捷键配置路径无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".shortcut-{}-{}.tmp", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(&Preference { shortcut: shortcut.into() })?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result.map_err(|e: std::io::Error| format!("保存快捷键失败：{e}"))
}

fn preference_path() -> std::path::PathBuf { workbar_core::data_dir().join("shortcut.json") }

pub fn initialize(app: &AppHandle) {
    let loaded = read_preference(&preference_path());
    let mut error = loaded.as_ref().err().cloned();
    let key = loaded.as_ref().ok().and_then(|value| parse(value).ok()).unwrap_or_else(|| {
        if loaded.is_ok() { error = Some("已保存的快捷键无效，请重新设置".into()); }
        parse(DEFAULT_SHORTCUT).expect("default shortcut is valid")
    });
    let registered = app.global_shortcut().register(key).map_err(|e| {
        eprintln!("[workbar] shortcut registration failed: {e}");
        error = Some("快捷键未生效，可能已被占用；可从托盘重新设置".into());
    }).is_ok();
    let state = app.state::<SettingsState>();
    let mut current = state.current.lock().unwrap();
    current.info = ShortcutInfo { shortcut: display(key), default_shortcut: DEFAULT_SHORTCUT, registered, error };
    current.active = registered.then_some(key);
}

pub fn attach_menu(app: &AppHandle, item: tauri::menu::MenuItem<tauri::Wry>) {
    let state = app.state::<SettingsState>();
    *state.menu.lock().unwrap() = Some(item);
    update_menu(app);
}

fn update_menu(app: &AppHandle) {
    let state = app.state::<SettingsState>();
    let shortcut = state.current.lock().unwrap().info.shortcut.clone();
    let item = state.menu.lock().unwrap().clone();
    if let Some(item) = item {
        let _ = item.set_text(format!("收起 / 展开  ({shortcut})"));
    }
}

pub fn should_toggle(app: &AppHandle, key: &Shortcut) -> bool {
    let state = app.state::<SettingsState>();
    let (active, value) = {
        let current = state.current.lock().unwrap();
        (current.active == Some(*key), current.info.shortcut.clone())
    };
    if !active { return false; }
    if state.recording.load(Ordering::SeqCst) {
        let _ = app.emit_to(LABEL, "shortcut-recorded", value);
        return false;
    }
    true
}

#[tauri::command]
pub fn get_shortcut(app: AppHandle) -> ShortcutInfo {
    app.state::<SettingsState>().current.lock().unwrap().info.clone()
}

#[tauri::command]
pub fn save_shortcut(app: AppHandle, shortcut: String) -> Result<ShortcutInfo, String> {
    let candidate = parse(&shortcut)?;
    let state = app.state::<SettingsState>();
    let _operation = state.operation.lock().map_err(|_| "快捷键设置正忙")?;
    let previous = state.current.lock().unwrap().active;
    let already_registered = app.global_shortcut().is_registered(candidate);
    if !already_registered {
        app.global_shortcut().register(candidate).map_err(|e| {
            eprintln!("[workbar] shortcut registration failed: {e}");
            "该组合已被占用或不可用，原快捷键保持不变".to_string()
        })?;
    }
    let value = display(candidate);
    if let Err(error) = write_preference(&preference_path(), &value) {
        if !already_registered {
            if let Err(cleanup) = app.global_shortcut().unregister(candidate) {
                eprintln!("[workbar] shortcut rollback failed: {cleanup}");
                return Err(format!("{error}。原快捷键仍有效；新组合释放失败，请重启 Workbar。"));
            }
        }
        return Err(error);
    }
    let error = previous.filter(|key| *key != candidate).and_then(|key| {
        app.global_shortcut().unregister(key).err().map(|error| {
            eprintln!("[workbar] old shortcut release failed: {error}");
            "新快捷键已保存，旧组合释放失败，请重启 Workbar".into()
        })
    });
    let info = ShortcutInfo { shortcut: value, default_shortcut: DEFAULT_SHORTCUT, registered: true, error };
    {
        let mut current = state.current.lock().unwrap();
        current.active = Some(candidate);
        current.info = info.clone();
    }
    update_menu(&app);
    Ok(info)
}

#[tauri::command]
pub fn set_shortcut_recording(window: WebviewWindow, recording: bool) -> Result<(), String> {
    if window.label() != LABEL { return Err("请在快捷键设置窗口录入".into()); }
    if recording && (!window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false)) {
        return Err("请先切换到快捷键设置窗口".into());
    }
    window.state::<SettingsState>().recording.store(recording, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn close_shortcut_settings(window: WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL { return Err("窗口不匹配".into()); }
    window.state::<SettingsState>().recording.store(false, Ordering::SeqCst);
    window.hide().map_err(|e| e.to_string())
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == LABEL && matches!(event, tauri::WindowEvent::Focused(false) | tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
        window.state::<SettingsState>().recording.store(false, Ordering::SeqCst);
        let _ = window.emit("shortcut-recording-cancelled", ());
    }
}

pub fn open(app: &AppHandle) {
    if app.state::<SettingsState>().opening.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    // WebView2 creation must run outside the synchronous tray callback.
    std::thread::spawn(move || {
        let result = (|| -> tauri::Result<()> {
            if let Some(window) = app.get_webview_window(LABEL) {
                let was_visible = window.is_visible()?;
                window.show()?;
                window.set_focus()?;
                if !was_visible { window.emit("shortcut-settings-opened", ())?; }
                return Ok(());
            }
            let mut builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("shortcut-settings.html".into()))
                .title("Workbar · 快捷键").inner_size(440.0, 320.0).center().resizable(false)
                .maximizable(false).minimizable(false).decorations(false).shadow(false).transparent(true)
                .background_color(tauri::utils::config::Color(0, 0, 0, 0)).always_on_top(true).visible(false);
            if let Some(main) = app.config().app.windows.iter().find(|window| window.label == "main") {
                if let Some(args) = &main.additional_browser_args { builder = builder.additional_browser_args(args); }
                if let Some(directory) = &main.data_directory { builder = builder.data_directory(directory.clone()); }
            }
            let window = builder.build()?;
            window.show()?;
            window.set_focus()?;
            Ok(())
        })();
        if let Err(error) = result { eprintln!("[workbar] shortcut settings window failed: {error}"); }
        app.state::<SettingsState>().opening.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_formats_shortcuts() {
        assert_eq!(display(parse("Alt+KeyW").unwrap()), "Alt+W");
        assert_eq!(display(parse(DEFAULT_SHORTCUT).unwrap()), DEFAULT_SHORTCUT);
        assert_eq!(display(parse("W").unwrap()), "W");
        assert_eq!(display(parse("F9").unwrap()), "F9");
        assert_eq!(display(parse("Shift+Space").unwrap()), "Shift+Space");
        for value in ["Alt", "Ctrl+Alt", "Super+W", "Ctrl+F12"] { assert!(parse(value).is_err(), "{value}"); }
    }

    #[test]
    fn saving_replaces_only_the_shortcut_file() {
        let directory = std::env::temp_dir().join(format!("workbar-shortcut-only-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("shortcut.json");
        fs::write(directory.join("plan.json"), b"untouched plan").unwrap();
        assert_eq!(read_preference(&path).unwrap(), DEFAULT_SHORTCUT);
        write_preference(&path, "Alt+W").unwrap();
        write_preference(&path, "Ctrl+Shift+J").unwrap();
        assert_eq!(read_preference(&path).unwrap(), "Ctrl+Shift+J");
        assert_eq!(fs::read(directory.join("plan.json")).unwrap(), b"untouched plan");
        fs::remove_file(path).unwrap();
        fs::remove_file(directory.join("plan.json")).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn invalid_preference_is_not_changed_by_reading() {
        let path = std::env::temp_dir().join(format!("workbar-shortcut-invalid-{}.json", std::process::id()));
        fs::write(&path, b"invalid").unwrap();
        assert!(read_preference(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid");
        fs::remove_file(path).unwrap();
    }
}
