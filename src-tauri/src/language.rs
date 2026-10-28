//! UI language preferences, independent of task data and shortcut settings.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::Path, sync::{Mutex, OnceLock}};
use tauri::{menu::{CheckMenuItem, MenuItem, Submenu}, AppHandle, Emitter, Manager, Wry};

type Messages = BTreeMap<String, String>;

fn messages(locale: &str) -> &'static Messages {
    static ZH: OnceLock<Messages> = OnceLock::new();
    static EN: OnceLock<Messages> = OnceLock::new();
    if locale == "zh-CN" {
        ZH.get_or_init(|| serde_json::from_str(include_str!("../../src/locales/zh-CN.json")).expect("valid Chinese catalog"))
    } else {
        EN.get_or_init(|| serde_json::from_str(include_str!("../../src/locales/en.json")).expect("valid English catalog"))
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub enum Preference {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}

fn resolve(preference: Preference, system: &str) -> &'static str {
    match preference {
        Preference::Chinese => "zh-CN",
        Preference::English => "en",
        Preference::System if system.split(['-', '_']).next().unwrap_or("").eq_ignore_ascii_case("zh") => "zh-CN",
        Preference::System => "en",
    }
}

fn system_language() -> &'static str {
    #[cfg(windows)]
    {
        // Use the Windows display language, independently of date/number formats.
        let id = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
        if id & 0x03ff == 0x04 { "zh-CN" } else { "en" }
    }
    #[cfg(not(windows))]
    { resolve(Preference::System, &std::env::var("LC_ALL").or_else(|_| std::env::var("LANG")).unwrap_or_default()) }
}

#[derive(Clone, Serialize)]
pub struct LanguageInfo {
    preference: Preference,
    locale: &'static str,
    messages: &'static Messages,
}

impl LanguageInfo {
    fn new(preference: Preference) -> Self {
        let locale = resolve(preference, system_language());
        Self { preference, locale, messages: messages(locale) }
    }
}

pub struct TrayLabels {
    pub shortcut: MenuItem<Wry>,
    pub autostart: CheckMenuItem<Wry>,
    pub data: MenuItem<Wry>,
    pub quit: MenuItem<Wry>,
    pub language: Submenu<Wry>,
    pub system: CheckMenuItem<Wry>,
    pub chinese: CheckMenuItem<Wry>,
    pub english: CheckMenuItem<Wry>,
}

pub struct LanguageState {
    current: Mutex<LanguageInfo>,
    menu: Mutex<Option<TrayLabels>>,
}

impl LanguageState {
    pub fn load() -> Self {
        let preference = read_preference(&preference_path()).unwrap_or_else(|error| {
            eprintln!("[workbar] language preference ignored: {error}");
            Preference::System
        });
        Self { current: Mutex::new(LanguageInfo::new(preference)), menu: Mutex::new(None) }
    }
}

pub fn text(app: &AppHandle, key: &str) -> String {
    let info = app.state::<LanguageState>();
    let current = info.current.lock().unwrap();
    current.messages.get(key).or_else(|| messages("en").get(key)).cloned().unwrap_or_else(|| key.to_string())
}

// Send stable message keys so an open settings window can retranslate errors
// immediately when the user changes language, without losing an edited shortcut.
#[derive(Clone, Debug, Serialize)]
pub struct UiError {
    pub key: &'static str,
    pub detail: Option<String>,
}

impl UiError {
    pub fn new(key: &'static str) -> Self { Self { key, detail: None } }
    pub fn detail(key: &'static str, detail: impl ToString) -> Self { Self { key, detail: Some(detail.to_string()) } }
}

#[derive(Deserialize, Serialize)]
struct SavedPreference { language: Preference }

fn preference_path() -> std::path::PathBuf { workbar_core::data_dir().join("language.json") }

fn read_preference(path: &Path) -> Result<Preference, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice::<SavedPreference>(&body).map(|saved| saved.language).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Preference::System),
        Err(error) => Err(error.to_string()),
    }
}

fn write_preference(path: &Path, language: Preference) -> Result<(), std::io::Error> {
    let parent = path.parent().ok_or_else(|| std::io::Error::other("invalid preference path"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".language-{}-{}.tmp", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(&SavedPreference { language })?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[tauri::command]
pub fn get_language(app: AppHandle) -> LanguageInfo {
    app.state::<LanguageState>().current.lock().unwrap().clone()
}

pub fn attach_menu(app: &AppHandle, labels: TrayLabels) {
    *app.state::<LanguageState>().menu.lock().unwrap() = Some(labels);
    refresh(app);
}

fn refresh(app: &AppHandle) {
    let state = app.state::<LanguageState>();
    let info = state.current.lock().unwrap().clone();
    if let Some(menu) = state.menu.lock().unwrap().as_ref() {
        let _ = menu.shortcut.set_text(text(app, "tray.shortcut"));
        let _ = menu.autostart.set_text(text(app, "tray.autostart"));
        let _ = menu.data.set_text(text(app, "tray.data"));
        let _ = menu.quit.set_text(text(app, "tray.quit"));
        let _ = menu.language.set_text(text(app, "tray.language"));
        let _ = menu.system.set_text(text(app, "language.system"));
        let _ = menu.system.set_checked(info.preference == Preference::System);
        let _ = menu.chinese.set_checked(info.preference == Preference::Chinese);
        let _ = menu.english.set_checked(info.preference == Preference::English);
    }
    crate::shortcut_settings::update_menu(app);
    if let Some(window) = app.get_webview_window("shortcut-settings") {
        let _ = window.set_title(&text(app, "settings.windowTitle"));
    }
}

pub fn select(app: &AppHandle, preference: Preference) {
    let state = app.state::<LanguageState>();
    let result = {
        let mut current = state.current.lock().unwrap();
        write_preference(&preference_path(), preference).map(|()| {
            *current = LanguageInfo::new(preference);
            current.clone()
        })
    };
    refresh(app); // Also restore checkmarks if saving failed.
    match result {
        Ok(info) => { let _ = app.emit("language-changed", info); }
        Err(error) => {
            let message = format!("{}\n\n{error}", text(app, "language.saveError"));
            eprintln!("[workbar] {message}");
            #[cfg(windows)]
            unsafe {
                use windows::{core::{w, PCWSTR}, Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK, MB_ICONERROR}};
                let wide: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
                let _ = MessageBoxW(None, PCWSTR(wide.as_ptr()), w!("WorkBar"), MB_OK | MB_ICONERROR);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_language_and_explicit_overrides() {
        for system in ["zh", "zh-CN", "zh_TW", "ZH-Hant-HK"] {
            assert_eq!(resolve(Preference::System, system), "zh-CN");
            assert_eq!(resolve(Preference::English, system), "en");
        }
        for system in ["en-US", "fr-FR", "ja-JP", "", "zho"] {
            assert_eq!(resolve(Preference::System, system), "en");
            assert_eq!(resolve(Preference::Chinese, system), "zh-CN");
        }
    }

    #[test]
    fn catalogs_have_matching_keys_and_placeholders() {
        let zh = messages("zh-CN");
        let en = messages("en");
        assert_eq!(zh.keys().collect::<Vec<_>>(), en.keys().collect::<Vec<_>>());
        let placeholders = |value: &str| {
            let mut result: Vec<String> = value.split('{').skip(1).map(|part| part.split('}').next().unwrap().to_string()).collect();
            result.sort();
            result
        };
        for (key, value) in zh {
            assert!(!value.is_empty() && !en[key].is_empty(), "{key}");
            assert_eq!(placeholders(value), placeholders(&en[key]), "{key}");
        }
    }

    #[test]
    fn preference_roundtrips_without_touching_other_data() {
        let directory = std::env::temp_dir().join(format!("workbar-language-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("language.json");
        fs::write(directory.join("workbar.db"), b"task data").unwrap();
        fs::write(directory.join("shortcut.json"), b"shortcut data").unwrap();
        assert_eq!(read_preference(&path).unwrap(), Preference::System);
        for preference in [Preference::English, Preference::Chinese, Preference::System] {
            write_preference(&path, preference).unwrap();
            assert_eq!(read_preference(&path).unwrap(), preference);
        }
        fs::write(&path, br#"{"language":"unknown"}"#).unwrap();
        assert!(read_preference(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), br#"{"language":"unknown"}"#);
        assert_eq!(fs::read(directory.join("workbar.db")).unwrap(), b"task data");
        assert_eq!(fs::read(directory.join("shortcut.json")).unwrap(), b"shortcut data");
        assert!(write_preference(&directory.join("workbar.db/language.json"), Preference::English).is_err());
        for name in ["language.json", "workbar.db", "shortcut.json"] { fs::remove_file(directory.join(name)).unwrap(); }
        fs::remove_dir(directory).unwrap();
    }
}
