//! Workbar — a tiny always-on-top bar that tells you what to do right now.
//!
//! The window is frameless, transparent, always on top, out of the taskbar and
//! (on Windows) marked `WS_EX_NOACTIVATE` so that clicking the bar never steals
//! focus from the app you are working in.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shortcut_settings;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::ShortcutState;

const PILL_WIDTH: f64 = 1120.0;
const PILL_HEIGHT: f64 = 64.0;
/// Margins around the pill inside the window, so the CSS drop shadow can fade
/// out before it hits the window edge (otherwise it is cut into a hard black
/// rim). They are deliberately tiny: everything inside the window swallows
/// clicks, so a large transparent margin makes the pixels around the bar
/// unclickable for whatever is behind it. Keep these in sync with `.stage`
/// padding in `src/styles.css`.
const SIDE_MARGIN: f64 = 4.0;
const TOP_MARGIN: f64 = 3.0;
const BOTTOM_MARGIN: f64 = 6.0;
/// The collapsed window is exactly as tall as the line itself: no transparent
/// margin left over, because a layered/transparent WebView2 window would render
/// that leftover strip as a black band on some machines.
const LINE_HEIGHT: f64 = 4.0;
const INSTANCE_MUTEX: &str = "Local\\io.workbar.desktop.single";

/// Mirror of the bar's collapsed state. The web UI and native toggles (hotkey,
/// tray) can both change it, so the current value must live where both reach it.
/// `applied` is the state the window has actually been resized to; `operation`
/// serializes the window updates; `revision` cancels superseded fade waits.
struct BarState {
    collapsed: AtomicBool,
    applied: AtomicBool,
    revision: AtomicU64,
    operation: Mutex<()>,
}

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

/// Millisecond-resolution hop tracing for the hotkey -> event -> JS -> resize
/// chain, written to `trace.log`. Toggling the bar is rare, so the file stays
/// tiny; it exists to diagnose occasional multi-second delays.
fn trace(message: &str) {
    use std::io::Write;
    let dir = workbar_core::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("trace.log"))
    {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = writeln!(file, "[{ms}] {message}");
    }
}

/// Priority class plus EcoQoS state: a never-activated toolwindow process may be
/// power-throttled by the OS, which starves the hotkey/event handling under load.
#[cfg(windows)]
fn process_power_state() -> String {
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetPriorityClass, GetProcessInformation, ProcessPowerThrottling,
        PROCESS_POWER_THROTTLING_STATE,
    };
    unsafe {
        let priority = GetPriorityClass(GetCurrentProcess());
        let mut state = PROCESS_POWER_THROTTLING_STATE {
            Version: 0,
            ControlMask: 0,
            StateMask: 0,
        };
        let query = GetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            &mut state as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
        let eco = query.is_ok() && (state.StateMask & 0x1) != 0;
        format!("priority={priority:?} eco_qos={eco}")
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

/// Compute the window geometry (size + position) for a bar state.
fn bar_geometry(
    window: &WebviewWindow,
    collapsed: bool,
) -> Option<(PhysicalSize<u32>, PhysicalPosition<i32>)> {
    let scale = window.scale_factor().ok()?;
    let monitor = window.primary_monitor().ok().flatten()?;
    let screen = monitor.size();
    let origin = monitor.position();

    // Collapsed: a full-width line flush with the top edge of the screen.
    if collapsed {
        let height = (LINE_HEIGHT * scale).round().max(2.0) as u32;
        return Some((PhysicalSize::new(screen.width, height), PhysicalPosition::new(origin.x, origin.y)));
    }

    let mut width = ((PILL_WIDTH + SIDE_MARGIN * 2.0) * scale).round() as u32;
    let max_width = screen
        .width
        .saturating_sub((120.0 * scale).round() as u32)
        .max(420);
    if width > max_width {
        width = max_width;
    }
    let height = ((TOP_MARGIN + PILL_HEIGHT + BOTTOM_MARGIN) * scale).round() as u32;
    let x = origin.x + ((screen.width as i64 - width as i64) / 2) as i32;
    Some((PhysicalSize::new(width, height), PhysicalPosition::new(x, origin.y)))
}

/// A parking spot fully outside every connected monitor. Deliberately NOT
/// (-32000, -32000): that is where Windows parks *minimized* windows, and
/// WebView2 treats a window resting there like a minimized one — delivery
/// into the webview then stalled for seconds after the resize (traced).
fn offscreen_park(window: &WebviewWindow) -> PhysicalPosition<i32> {
    let mut right: i32 = i32::MIN;
    let mut top: i32 = 0;
    let mut have = false;
    if let Ok(monitors) = window.available_monitors() {
        for monitor in monitors {
            let p = monitor.position();
            let s = monitor.size();
            right = right.max(p.x + s.width as i32);
            if have {
                top = top.min(p.y);
            } else {
                top = p.y;
                have = true;
            }
        }
    }
    if have {
        PhysicalPosition::new(right + 100, top)
    } else {
        PhysicalPosition::new(-32000, -32000)
    }
}

/// Horizontal pill centered at the top of the primary monitor.
fn place(window: &WebviewWindow, collapsed: bool) {
    if let Some((size, position)) = bar_geometry(window, collapsed) {
        let _ = window.set_size(size);
        let _ = window.set_position(position);
    }
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

/// Apply the current desired bar state to the window after the CSS fade grace
/// period. Runs on a plain native thread on purpose: Chromium throttles JS
/// timers, animation frames and IPC delivery in states the anti-throttle
/// browser flags do not fully cover, which used to stall the switch for
/// seconds. Sleeping here keeps the actual resize off that path entirely.
fn apply_bar_state_later(app: AppHandle, requested: bool) {
    let revision = app.state::<BarState>().revision.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let state = app.state::<BarState>();
        // Give the web UI's fade-out animation the time the CSS needs, so the
        // resize lands on a page that already renders the target state. Wait
        // outside the lock: rapid toggles must not queue repeated fade delays.
        std::thread::sleep(Duration::from_millis(if requested { 300 } else { 180 }));
        let _guard = state.operation.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.revision.load(Ordering::SeqCst) != revision {
            trace(&format!("apply {requested} superseded revision={revision}"));
            return;
        }
        let desired = state.collapsed.load(Ordering::SeqCst);
        if state.applied.load(Ordering::SeqCst) == desired {
            trace(&format!("apply {desired} unchanged revision={revision}"));
            return;
        }
        let Some(window) = app.get_webview_window("main") else { return; };
        trace(&format!("apply {desired} start revision={revision}"));
        if let Some((size, position)) = bar_geometry(&window, desired) {
            // Park the window off-screen for the resize. Resizing a visible
            // transparent WebView2 window paints a black band for a few
            // frames, while hiding the HWND makes WebView2 suspend the
            // renderer and stall the toggle for seconds (traced in
            // trace.log). Off-screen the window stays "visible" to WebView2,
            // so the band renders outside the monitor. Delivery into WebView2
            // may still stall; the line is therefore revealed by viewport CSS
            // rather than waiting for the completion event below.
            let _ = window.set_position(offscreen_park(&window));
            let _ = window.set_size(size);
            // Re-assert a fully transparent backdrop after the resize,
            // otherwise some WebView2 versions keep the opaque band.
            let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
            // Give WebView2 a moment to repaint at the new size while the
            // band frames land off-screen, then return to the final spot.
            std::thread::sleep(Duration::from_millis(60));
            let _ = window.set_position(position);
        }
        let _ = window.set_always_on_top(true);
        state.applied.store(desired, Ordering::SeqCst);
        trace(&format!("apply {desired} done"));
        // Split native UI dispatch from WebView2 delivery in the trace. Neither
        // acknowledgement gates the line's visibility.
        let queued_at = std::time::Instant::now();
        let _ = app.run_on_main_thread(move || {
            trace(&format!("main-thread after resize revision={revision} queue_ms={}", queued_at.elapsed().as_millis()));
        });
        trace(&format!("emit bar-resized {desired} start revision={revision}"));
        let result = app.emit("bar-resized", desired);
        trace(&format!("emit bar-resized {desired} queued revision={revision} ok={}", result.is_ok()));
    });
}

/// Apply a collapsed/expanded window state immediately and tell the web UI to match.
fn set_bar_state(app: &AppHandle, window: &WebviewWindow, collapsed: bool) {
    let state = app.state::<BarState>();
    state.collapsed.store(collapsed, Ordering::SeqCst);
    state.applied.store(collapsed, Ordering::SeqCst);
    state.revision.fetch_add(1, Ordering::SeqCst);
    // Resize while hidden: avoids the clipped/stale frames you get when a
    // transparent window is resized mid-animation.
    let _ = window.hide();
    place(window, collapsed);
    // Re-assert a fully transparent backdrop after the resize, otherwise some
    // WebView2 versions paint the resized surface with an opaque black band.
    let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = app.emit("mode-changed", collapsed);
}

fn toggle_bar(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    #[cfg(windows)]
    trace(&format!("hotkey visible={} {}", window.is_visible().unwrap_or(false), process_power_state()));
    #[cfg(not(windows))]
    trace(&format!("hotkey visible={}", window.is_visible().unwrap_or(false)));
    if !window.is_visible().unwrap_or(false) {
        // Hidden: bring it back expanded natively — the webview may be
        // suspended while hidden and would not process events promptly.
        set_bar_state(app, &window, false);
        return;
    }
    // Visible: flip the state, tell the web UI to start its fade, and schedule
    // the actual resize natively — never through JS timers, which Chromium may
    // throttle for seconds in states the anti-throttle flags don't cover.
    let next = !app.state::<BarState>().collapsed.load(Ordering::SeqCst);
    app.state::<BarState>().collapsed.store(next, Ordering::SeqCst);
    let _ = app.emit("bar-toggle", next);
    trace(&format!("emit bar-toggle {next}"));
    apply_bar_state_later(app.clone(), next);
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

/// Drive the renderer clock from native code.
///
/// Chromium throttles JS timers when it considers the window occluded/backgrounded;
/// on a transparent always-on-top overlay that made the on-screen timer freeze for
/// a moment and then jump. A native tick keeps the UI updating independently of
/// JS timer scheduling.
fn spawn_clock(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1000));
        let _ = app.emit("clock-tick", ());
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
fn set_collapsed(app: AppHandle, collapsed: bool) -> Result<(), String> {
    trace(&format!("set_collapsed {collapsed} requested"));
    app.state::<BarState>().collapsed.store(collapsed, Ordering::SeqCst);
    // The delayed native applier does the resize after the CSS fade grace and
    // reports back via `bar-resized`; returning immediately keeps this command
    // out of the throttled-JS-timer path too.
    apply_bar_state_later(app, collapsed);
    Ok(())
}

/// Frontend hop timestamps; the message carries the JS wall clock (Date.now)
/// so delivery delay through the IPC is measurable too.
#[tauri::command]
fn trace_js(msg: String) {
    trace(&format!("js: {msg}"));
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

    let show_item = MenuItem::with_id(app, "show", "收起 / 展开  (Ctrl+Alt+W)", true, None::<&str>)?;
    shortcut_settings::attach_menu(app.handle(), show_item.clone());
    let shortcut_item = MenuItem::with_id(app, "shortcut", "设置快捷键…", true, None::<&str>)?;
    let data_item = MenuItem::with_id(app, "data", "打开数据目录", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Workbar", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &shortcut_item,
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
            "shortcut" => shortcut_settings::open(app),
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
        .manage(BarState {
            collapsed: AtomicBool::new(false),
            applied: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            operation: Mutex::new(()),
        })
        .manage(shortcut_settings::SettingsState::default())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed && shortcut_settings::should_toggle(app, shortcut) {
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
            app_info,
            trace_js,
            shortcut_settings::get_shortcut,
            shortcut_settings::save_shortcut,
            shortcut_settings::set_shortcut_recording,
            shortcut_settings::close_shortcut_settings
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

            shortcut_settings::initialize(app.handle());

            eprintln!("[workbar] setup: tray...");
            if let Err(err) = setup_tray(app) {
                // A tray failure must never keep the bar itself from showing.
                eprintln!("[workbar] setup: tray failed: {err}");
            } else {
                eprintln!("[workbar] setup: tray ok");
            }
            spawn_plan_watcher(app.handle().clone());
            eprintln!("[workbar] setup: watcher ok");
            spawn_clock(app.handle().clone());
            eprintln!("[workbar] setup: clock ok");
            Ok(())
        })
        .on_window_event(|window, event| {
            shortcut_settings::window_event(window, event);
            if let WindowEvent::Destroyed = event {
                trace(&format!("window destroyed label={}", window.label()));
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                trace(&format!("close requested label={}", window.label()));
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .inspect_err(|error| log_boot(&format!("event loop exited with error: {error}")))
        .inspect(|_| log_boot("event loop exited cleanly"))
        .expect("error while running Workbar");
}
