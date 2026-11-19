pub mod error;
pub mod export;
pub mod files;
pub mod fsops;
pub mod images;
pub mod pandoc;
pub mod recovery;
pub mod settings;
pub mod themes;
pub mod tree;
pub mod upload;
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
            images::import_image,
            images::import_image_bytes,
            images::allow_asset_dir,
            export::export_pdf,
            pandoc::pandoc_status,
            pandoc::export_pandoc,
            pandoc::import_pandoc,
            upload::upload_images,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
