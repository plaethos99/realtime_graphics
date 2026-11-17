use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

/// User settings, stored as JSON in the app's config directory. Field names match the TypeScript side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub proxy_url: String,
    pub token: String,
    /// Hold to talk.
    pub talk_shortcut: String,
    /// Opens a box to type the question instead.
    pub type_shortcut: String,
    pub speak: bool,
    /// edge-tts voice name; empty uses the proxy's default.
    pub voice: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            proxy_url: "http://localhost:8787".into(),
            token: String::new(),
            talk_shortcut: "CommandOrControl+Shift+Space".into(),
            type_shortcut: "CommandOrControl+Shift+K".into(),
            speak: true,
            voice: String::new(),
        }
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Returns the saved settings, or `None` on first run.
pub fn load(app: &AppHandle) -> Option<Settings> {
    let text = fs::read_to_string(path(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}
