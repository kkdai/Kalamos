pub mod error;
pub mod files;
pub mod fsops;
pub mod recovery;
pub mod settings;
pub mod themes;
pub mod tree;
pub mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(watch::WatcherManager::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            files::open_file,
            files::save_file,
            tree::read_tree,
            tree::list_files,
            watch::watch_folder,
            fsops::create_file,
            fsops::rename_path,
            fsops::trash_path,
            recovery::write_recovery,
            recovery::list_recovery,
            recovery::clear_recovery,
            settings::get_settings,
            settings::set_settings,
            themes::list_themes,
            themes::read_theme_css,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
