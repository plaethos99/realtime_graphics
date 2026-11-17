//! Desktop shell: a transparent, click-through, always-on-top window covering the active monitor.
//! Rust owns the parts a web page can't do: global hotkeys, screen capture, the tray menu and settings.
//! Everything else (recording, talking to the proxy, drawing) happens in the overlay page.

mod audio;
mod capture;
mod settings;

use settings::Settings;
use std::sync::Mutex;
use tauri::{
    ipc::Response,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const OVERLAY: &str = "overlay";
const SETTINGS: &str = "settings";
const LIBRARY: &str = "library";

#[derive(Default)]
struct Keys {
    talk: Option<Shortcut>,
    ask: Option<Shortcut>,
    escape_on: bool,
}

struct AppState {
    settings: Mutex<Settings>,
    recorder: Mutex<Option<audio::Recorder>>,
    keys: Mutex<Keys>,
    escape: Shortcut,
}

/// Move and resize the overlay to cover the monitor under the mouse, so drawings land on that screen.
fn fit_overlay_to_cursor(app: &AppHandle) {
    let Some(win) = app.get_webview_window(OVERLAY) else { return };
    let cursor = win.cursor_position().ok();
    let monitors = win.available_monitors().unwrap_or_default();
    let target = cursor
        .and_then(|c| {
            monitors.iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                c.x >= p.x as f64
                    && c.y >= p.y as f64
                    && c.x < p.x as f64 + s.width as f64
                    && c.y < p.y as f64 + s.height as f64
            })
        })
        .cloned()
        .or_else(|| win.primary_monitor().ok().flatten());
    if let Some(m) = target {
        let _ = win.set_position(*m.position());
        let _ = win.set_size(*m.size());
    }
}

fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, pressed: bool) {
    let state = app.state::<AppState>();
    let (talk, ask) = {
        let keys = state.keys.lock().unwrap();
        (keys.talk, keys.ask)
    };
    if talk.as_ref() == Some(shortcut) {
        // Holding the key repeats "pressed"; the page ignores repeats while it is recording.
        if pressed {
            fit_overlay_to_cursor(app);
            let _ = app.emit_to(OVERLAY, "talk-start", ());
        } else {
            let _ = app.emit_to(OVERLAY, "talk-stop", ());
        }
    } else if ask.as_ref() == Some(shortcut) {
        if pressed {
            fit_overlay_to_cursor(app);
            let _ = app.emit_to(OVERLAY, "type-open", ());
        }
    } else if *shortcut == state.escape && pressed {
        let _ = app.emit_to(OVERLAY, "dismiss", ());
    }
}

/// Swap the registered hotkeys for the ones in `settings`, restoring the old ones if that fails.
fn apply_shortcuts(app: &AppHandle, state: &AppState, settings: &Settings) -> Result<(), String> {
    let talk: Shortcut = settings
        .talk_shortcut
        .parse()
        .map_err(|e| format!("Talk shortcut \"{}\" is not valid: {e}", settings.talk_shortcut))?;
    let ask: Shortcut = settings
        .type_shortcut
        .parse()
        .map_err(|e| format!("Type shortcut \"{}\" is not valid: {e}", settings.type_shortcut))?;
    if talk == ask {
        return Err("The talk and type shortcuts must be different.".into());
    }

    let shortcuts = app.global_shortcut();
    let (old_talk, old_ask) = {
        let keys = state.keys.lock().unwrap();
        (keys.talk, keys.ask)
    };
    for old in [old_talk, old_ask].into_iter().flatten() {
        let _ = shortcuts.unregister(old);
    }
    if let Err(e) = shortcuts.register(talk).and_then(|_| shortcuts.register(ask)) {
        let _ = shortcuts.unregister(talk);
        let _ = shortcuts.unregister(ask);
        for old in [old_talk, old_ask].into_iter().flatten() {
            let _ = shortcuts.register(old);
        }
        return Err(format!("Could not register the shortcut; another app may already use it. ({e})"));
    }
    let mut keys = state.keys.lock().unwrap();
    keys.talk = Some(talk);
    keys.ask = Some(ask);
    Ok(())
}

/// WebView2 would show its microphone prompt inside the click-through overlay, where it can't be clicked,
/// leaving the app waiting forever. The overlay only ever loads our own pages, so grant the mic directly.
#[cfg(windows)]
fn allow_microphone(win: &WebviewWindow) {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
    let result = win.with_webview(|webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
            eprintln!("could not install microphone permission handler: {e}");
        }
    });
    if let Err(e) = result {
        eprintln!("could not reach the overlay webview: {e}");
    }
}

fn open_settings_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(SETTINGS) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("Realtime Graphics settings")
        .inner_size(480.0, 600.0)
        .min_inner_size(420.0, 480.0)
        .center()
        .build();
    if let Err(e) = built {
        eprintln!("could not open settings: {e}");
    }
}

/// The book library: a normal window. Its page handles dropped files itself, so the native
/// drag-and-drop handler (which would swallow them) is off.
fn open_library_window(app: &AppHandle, book: Option<String>) {
    if let Some(win) = app.get_webview_window(LIBRARY) {
        let _ = win.unminimize();
        let _ = win.set_focus();
        if let Some(id) = book {
            let _ = app.emit_to(LIBRARY, "open-book", id);
        }
        return;
    }
    let page = match &book {
        Some(id) => format!("library.html?book={}", id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>()),
        None => "library.html".to_string(),
    };
    let built = WebviewWindowBuilder::new(app, LIBRARY, WebviewUrl::App(page.into()))
        .title("Library · Realtime Graphics")
        .inner_size(1180.0, 780.0)
        .min_inner_size(720.0, 520.0)
        .disable_drag_drop_handler()
        .center()
        .build();
    match built {
        #[cfg(windows)]
        Ok(win) => allow_microphone(&win),
        #[cfg(not(windows))]
        Ok(_) => {}
        Err(e) => eprintln!("could not open the library: {e}"),
    }
}

// ---------- commands called from the pages ----------

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    apply_shortcuts(&app, &state, &settings)?;
    settings::save(&app, &settings)?;
    *state.settings.lock().unwrap() = settings.clone();
    app.emit_to(OVERLAY, "settings-changed", settings).map_err(|e| e.to_string())
}

/// JPEG of the monitor the overlay currently covers.
#[tauri::command]
async fn capture_screen(window: WebviewWindow) -> Result<Response, String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let (x, y) = (pos.x + size.width as i32 / 2, pos.y + size.height as i32 / 2);
    let started = std::time::Instant::now();
    let bytes = tauri::async_runtime::spawn_blocking(move || capture::capture_monitor_at(x, y))
        .await
        .map_err(|e| e.to_string())??;
    eprintln!("screenshot: {} KB in {} ms", bytes.len() / 1024, started.elapsed().as_millis());
    Ok(Response::new(bytes))
}

/// Mouse position in the calling window's CSS pixels, for deciding when to let clicks through.
#[tauri::command]
fn cursor_position(window: WebviewWindow) -> Option<(f64, f64)> {
    let cursor = window.cursor_position().ok()?;
    let origin = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    Some(((cursor.x - origin.x as f64) / scale, (cursor.y - origin.y as f64) / scale))
}

/// Esc is grabbed globally only while a drawing is on screen, so other apps keep it otherwise.
#[tauri::command]
fn set_escape(app: AppHandle, state: State<AppState>, enabled: bool) -> Result<(), String> {
    let mut keys = state.keys.lock().unwrap();
    if keys.escape_on == enabled {
        return Ok(());
    }
    let shortcuts = app.global_shortcut();
    let result = if enabled { shortcuts.register(state.escape) } else { shortcuts.unregister(state.escape) };
    result.map_err(|e| e.to_string())?;
    keys.escape_on = enabled;
    Ok(())
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    open_settings_window(&app);
}

#[tauri::command]
fn open_library(app: AppHandle, book: Option<String>) {
    open_library_window(&app, book);
}

/// Tray items that change with the recording state.
struct SessionMenu {
    watch: MenuItem<tauri::Wry>,
    meeting: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
}

fn set_recording_menu(app: &AppHandle, recording: bool) {
    // Menus live on the main thread; queue the change rather than wait for it from a command thread.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(menu) = handle.try_state::<SessionMenu>() {
            let _ = menu.watch.set_enabled(!recording);
            let _ = menu.meeting.set_enabled(!recording);
            let _ = menu.stop.set_enabled(recording);
        }
    });
}

/// Start recording for a session: "watch" records the computer's sound, "meeting" also the microphone.
/// Returns warnings for sources that couldn't be opened.
#[tauri::command]
async fn start_recording(app: AppHandle, mode: String) -> Result<Vec<String>, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        if let Some(old) = state.recorder.lock().unwrap().take() {
            old.stop();
        }
        let (recorder, warnings) = audio::start(handle.clone(), OVERLAY, true, mode == "meeting")?;
        *state.recorder.lock().unwrap() = Some(recorder);
        Ok::<_, String>(warnings)
    })
    .await
    .map_err(|e| e.to_string())?;
    eprintln!("start_recording: {result:?}");
    set_recording_menu(&app, result.is_ok());
    result
}

/// Stop recording; the last audio is sent before this returns.
#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(recorder) = handle.state::<AppState>().recorder.lock().unwrap().take() {
            recorder.stop();
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    set_recording_menu(&app, false);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Only one copy may run (two would fight over the hotkeys); launching again opens Settings in the
        // first, the Library with --library, or starts/stops recording with --watch, --meeting, --stop-recording.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let has = |flag: &str| args.iter().any(|a| a == flag);
            if has("--library") {
                open_library_window(app, None)
            } else if has("--watch") || has("--meeting") {
                fit_overlay_to_cursor(app);
                let _ = app.emit_to(OVERLAY, "session-start", if has("--meeting") { "meeting" } else { "watch" });
            } else if has("--stop-recording") {
                let _ = app.emit_to(OVERLAY, "session-stop", ());
            } else {
                open_settings_window(app)
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    on_shortcut(app, shortcut, event.state() == ShortcutState::Pressed)
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            capture_screen,
            cursor_position,
            set_escape,
            open_settings,
            open_library,
            start_recording,
            stop_recording
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let saved = settings::load(&handle);
            let first_run = saved.is_none();
            let current = saved.unwrap_or_default();
            app.manage(AppState {
                settings: Mutex::new(current.clone()),
                recorder: Mutex::new(None),
                keys: Mutex::new(Keys::default()),
                escape: "Escape".parse().expect("valid shortcut"),
            });

            let shortcuts_ok = match apply_shortcuts(&handle, app.state::<AppState>().inner(), &current) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("{e}");
                    false
                }
            };

            if let Some(win) = app.get_webview_window(OVERLAY) {
                win.set_ignore_cursor_events(true)?;
                fit_overlay_to_cursor(&handle);
                #[cfg(windows)]
                allow_microphone(&win);
            }

            let ask = MenuItem::with_id(app, "ask", "Ask by typing", true, None::<&str>)?;
            let library_item = MenuItem::with_id(app, "library", "Library…", true, None::<&str>)?;
            let watch_item = MenuItem::with_id(app, "watch", "Start watch mode (video)", true, None::<&str>)?;
            let meeting_item = MenuItem::with_id(app, "meeting", "Start meeting mode", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop recording", false, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&ask, &library_item, &separator, &watch_item, &meeting_item, &stop_item, &PredefinedMenuItem::separator(app)?, &settings_item, &quit],
            )?;
            app.manage(SessionMenu { watch: watch_item.clone(), meeting: meeting_item.clone(), stop: stop_item.clone() });
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Realtime Graphics")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "ask" => {
                        fit_overlay_to_cursor(app);
                        let _ = app.emit_to(OVERLAY, "type-open", ());
                    }
                    "library" => open_library_window(app, None),
                    "watch" | "meeting" => {
                        fit_overlay_to_cursor(app);
                        let _ = app.emit_to(OVERLAY, "session-start", event.id().as_ref());
                    }
                    "stop" => {
                        let _ = app.emit_to(OVERLAY, "session-stop", ());
                    }
                    "settings" => open_settings_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if first_run || !shortcuts_ok {
                open_settings_window(&handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
