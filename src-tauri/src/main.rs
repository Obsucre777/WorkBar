//! Workbar — a tiny always-on-top bar that tells you what to do right now.
//!
//! The window is frameless, transparent, always on top, out of the taskbar and
//! (on Windows) marked `WS_EX_NOACTIVATE` so that clicking the bar never steals
//! focus from the app you are working in.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const BAR_WIDTH: f64 = 900.0;
const BAR_HEIGHT: f64 = 76.0;
/// The collapsed window is exactly as tall as the line itself: no transparent
/// margin left over, because a layered/transparent WebView2 window would render
/// that leftover strip as a black band on some machines.
const LINE_HEIGHT: f64 = 4.0;
const TOP_GAP: f64 = 6.0;
const HOTKEY: &str = "Ctrl+Alt+W";
const INSTANCE_MUTEX: &str = "Local\\io.workbar.desktop.single";

/// Write panics (with backtrace) to `%APPDATA%\Workbar\crash.log`.
fn install_panic_logger() {
    std::env::set_var("RUST_BACKTRACE", "1");
    let dir = workbar_core::data_dir();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::fs::create_dir_all(&dir);
        let mut text = format!(
            "[{}] panic: {info}\n",
            chrono_like_timestamp()
        );
        if let Some(location) = info.location() {
            text.push_str(&format!(
                "  at {}:{}:{}\n",
                location.file(),
                location.line(),
                location.column()
            ));
        }
        let backtrace = std::backtrace::Backtrace::force_capture();
        text.push_str(&format!("  backtrace:\n{backtrace}\n"));
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("crash.log"))
        {
            use std::io::Write as _;
            let _ = file.write_all(text.as_bytes());
        }
        eprintln!("{text}");
    }));
}

fn chrono_like_timestamp() -> String {
    // No extra dependency: UTC seconds since epoch is enough for a log line.
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => format!("unix:{}", d.as_secs()),
        Err(_) => "unix:0".to_string(),
    }
}

fn log_boot(message: &str) {
    let dir = workbar_core::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("boot.log"))
    {
        use std::io::Write as _;
        let _ = writeln!(
            file,
            "[{}] {} v{}",
            chrono_like_timestamp(),
            message,
            env!("CARGO_PKG_VERSION")
        );
    }
}

/// Detect a second instance *before* Tauri/WebView2 starts.
///
/// Creating a second WebView2 environment against a user data folder that the
/// first instance already holds fails with "access denied", which used to
/// abort the whole process. Here we catch it first, surface the existing bar,
/// and exit quietly.
#[cfg(windows)]
fn second_instance_exit() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, BOOL, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, ShowWindow, SW_SHOW};

    let mutex_name: Vec<u16> = INSTANCE_MUTEX.encode_utf16().chain(std::iter::once(0)).collect();
    let already_running = unsafe {
        // Keep the handle for the lifetime of the process by leaking it.
        let handle = CreateMutexW(None, BOOL(0), PCWSTR(mutex_name.as_ptr()));
        std::mem::forget(handle);
        GetLastError() == ERROR_ALREADY_EXISTS
    };

    if !already_running {
        return false;
    }

    let title: Vec<u16> = "Workbar".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        if let Ok(hwnd) = FindWindowW(PCWSTR::null(), PCWSTR(title.as_ptr())) {
            if !hwnd.0.is_null() {
                let _ = ShowWindow(hwnd, SW_SHOW);
            }
        }
    }
    true
}

/// Horizontal pill centered at the top of the primary monitor.
fn place(window: &WebviewWindow, collapsed: bool) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let Some(monitor) = window.primary_monitor().ok().flatten() else {
        return;
    };
    let screen = monitor.size();
    let origin = monitor.position();

    // Collapsed: a full-width line flush with the top edge of the screen.
    if collapsed {
        let height = (LINE_HEIGHT * scale).round().max(2.0) as u32;
        let _ = window.set_size(PhysicalSize::new(screen.width, height));
        let _ = window.set_position(PhysicalPosition::new(origin.x, origin.y));
        return;
    }

    let mut width = (BAR_WIDTH * scale).round() as u32;
    let max_width = screen
        .width
        .saturating_sub((160.0 * scale).round() as u32)
        .max(420);
    if width > max_width {
        width = max_width;
    }
    let height = (BAR_HEIGHT * scale).round() as u32;

    let x = origin.x + ((screen.width as i64 - width as i64) / 2) as i32;
    let y = origin.y + (TOP_GAP * scale).round() as i32;

    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Keep the bar clickable but never focusable, and out of Alt-Tab.
#[cfg(windows)]
fn make_non_activating(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    if let Ok(hwnd) = window.hwnd() {
        let raw: *mut std::ffi::c_void = hwnd.0;
        let handle = HWND(raw);
        unsafe {
            let current = GetWindowLongPtrW(handle, GWL_EXSTYLE);
            let extra = (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
            SetWindowLongPtrW(handle, GWL_EXSTYLE, current | extra);
        }
    }
}

fn toggle_bar(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        // Showing always expands the bar, even if it was collapsed before hiding.
        place(&window, false);
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = app.emit("mode-changed", false);
    }
}

fn spawn_plan_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let path = workbar_core::plan_path();
        let mut last = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        loop {
            std::thread::sleep(Duration::from_millis(800));
            let current = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
            if current != last {
                last = current;
                let _ = app.emit("plan-changed", ());
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Commands used by the web UI
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_plan() -> Result<workbar_core::Plan, String> {
    workbar_core::load()
}

#[tauri::command]
fn save_plan(plan: workbar_core::Plan) -> Result<(), String> {
    workbar_core::replace(&plan)
}

#[tauri::command]
fn set_collapsed(window: WebviewWindow, collapsed: bool) -> Result<(), String> {
    // Resize while hidden: avoids the clipped/stale frames you get when a
    // transparent window is resized mid-animation.
    window.hide().map_err(|e| e.to_string())?;
    place(&window, collapsed);
    // Re-assert a fully transparent backdrop after the resize, otherwise some
    // WebView2 versions paint the resized surface with an opaque black band.
    let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_always_on_top(true);
    Ok(())
}

#[tauri::command]
fn hide_bar(window: WebviewWindow) {
    let _ = window.hide();
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_data_dir() -> Result<String, String> {
    let dir = workbar_core::data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

#[tauri::command]
fn app_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": workbar_core::data_dir().display().to_string(),
        "planPath": workbar_core::plan_path().display().to_string(),
        "today": workbar_core::today(),
    })
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let autostart_for_handler = autostart_item.clone();

    let show_item = MenuItem::with_id(app, "show", "显示 / 隐藏  (Ctrl+Alt+W)", true, None::<&str>)?;
    let data_item = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Workbar", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &autostart_item,
            &data_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Workbar")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => toggle_bar(app),
            "data" => {
                let _ = open_data_dir();
            }
            "quit" => app.exit(0),
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                if result.is_ok() {
                    let _ = autostart_for_handler.set_checked(!enabled);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_bar(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    install_panic_logger();
    log_boot("boot");

    #[cfg(windows)]
    {
        if second_instance_exit() {
            log_boot("second instance detected -> showing existing bar and exiting");
            return;
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_bar(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_plan,
            save_plan,
            set_collapsed,
            hide_bar,
            quit_app,
            open_data_dir,
            app_info
        ])
        .setup(|app| {
            eprintln!("[workbar] setup: start");
            let window = app
                .get_webview_window("main")
                .expect("main window should exist");
            eprintln!("[workbar] setup: window ok");
            place(&window, false);
            let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
            eprintln!("[workbar] setup: placed");
            #[cfg(windows)]
            make_non_activating(&window);
            eprintln!("[workbar] setup: non-activating");
            let _ = window.set_always_on_top(true);
            eprintln!("[workbar] setup: topmost");
            let _ = window.show();
            eprintln!("[workbar] setup: shown");

            if let Ok(shortcut) = HOTKEY.parse::<Shortcut>() {
                match app.global_shortcut().register(shortcut) {
                    Ok(_) => eprintln!("[workbar] setup: hotkey ok"),
                    Err(err) => eprintln!("[workbar] setup: hotkey failed: {err}"),
                }
            }

            eprintln!("[workbar] setup: tray...");
            if let Err(err) = setup_tray(app) {
                // A tray failure must never keep the bar itself from showing.
                eprintln!("[workbar] setup: tray failed: {err}");
            } else {
                eprintln!("[workbar] setup: tray ok");
            }
            spawn_plan_watcher(app.handle().clone());
            eprintln!("[workbar] setup: watcher ok");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Workbar");
}
