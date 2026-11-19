pub mod error;
pub mod files;
pub mod recovery;
pub mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            files::open_file,
            files::save_file,
            recovery::write_recovery,
            recovery::list_recovery,
            recovery::clear_recovery,
            settings::get_settings,
            settings::set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
