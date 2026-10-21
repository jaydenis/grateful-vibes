mod sonos;

#[tauri::command]
async fn sonos_supported() -> bool {
    sonos::supported()
}

#[tauri::command]
async fn sonos_discover() -> Result<Vec<sonos::SonosPlayer>, String> {
    if !sonos::supported() {
        return Err("Sonos local output is available in desktop builds only.".into());
    }
    tauri::async_runtime::spawn_blocking(sonos::discover)
        .await
        .map_err(|error| format!("Sonos discovery failed: {error}"))?
}

#[tauri::command]
async fn sonos_play(player_id: String, url: String, title: String) -> Result<(), String> {
    if !sonos::supported() {
        return Err("Sonos local output is available in desktop builds only.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        sonos::play(&player_id, &url, &title, "Grateful Dead")
    })
    .await
    .map_err(|error| format!("Sonos playback failed: {error}"))?
}

#[tauri::command]
async fn sonos_control(
    player_id: String,
    action: String,
    value: Option<String>,
) -> Result<(), String> {
    if !sonos::supported() {
        return Err("Sonos local output is available in desktop builds only.".into());
    }
    tauri::async_runtime::spawn_blocking(move || sonos::control(&player_id, &action, value))
        .await
        .map_err(|error| format!("Sonos control failed: {error}"))?
}

#[tauri::command]
async fn sonos_status(player_id: String) -> Result<sonos::SonosStatus, String> {
    if !sonos::supported() {
        return Err("Sonos local output is available in desktop builds only.".into());
    }
    tauri::async_runtime::spawn_blocking(move || sonos::status(&player_id))
        .await
        .map_err(|error| format!("Could not read Sonos playback status: {error}"))?
}

#[tauri::command]
async fn sonos_player_join(player_id: String, coordinator_rincon_id: String) -> Result<(), String> {
    if !sonos::supported() {
        return Err("Sonos local output is available in desktop builds only.".into());
    }
    tauri::async_runtime::spawn_blocking(move || sonos::join(&player_id, &coordinator_rincon_id))
        .await
        .map_err(|error| format!("Could not group Sonos rooms: {error}"))?
}

#[tauri::command]
async fn sonos_player_leave(player_id: String) -> Result<(), String> {
    if !sonos::supported() {
        return Err("Sonos local output is available in desktop builds only.".into());
    }
    tauri::async_runtime::spawn_blocking(move || sonos::leave(&player_id))
        .await
        .map_err(|error| format!("Could not ungroup the Sonos room: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            sonos_supported,
            sonos_discover,
            sonos_play,
            sonos_control,
            sonos_status,
            sonos_player_join,
            sonos_player_leave
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
