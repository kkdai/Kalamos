pub mod error;
pub mod export;
pub mod files;
pub mod fsops;
pub mod images;
pub mod menu;
pub mod open_with;
pub mod pandoc;
pub mod platform;
pub mod recovery;
pub mod search;
pub mod settings;
pub mod themes;
pub mod tree;
pub mod upload;
pub mod watch;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(watch::WatcherManager::new())
        .manage(open_with::PendingOpenFiles::new());

    // Windows / Linux: a second instance launched by Explorer ("Open with")
    // forwards its argv to the running instance and exits.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        open_with::focus_main_window(app);
        open_with::handle_cli_args(app, &argv, Some(std::path::Path::new(&cwd)));
    }));

    // #74 / #89: native menu bar (macOS app menu bar; Windows / Linux window menu bar).
    // Custom items emit `menu-action` to the frontend.
    let builder = builder
        .menu(menu::build_app_menu)
        .on_menu_event(menu::handle_menu_event);

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                let args: Vec<String> = std::env::args().collect();
                if args.len() > 1 {
                    let cwd = std::env::current_dir().ok();
                    open_with::handle_cli_args(_app.handle(), &args, cwd.as_deref());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            files::open_file,
            files::save_file,
            tree::read_tree,
            tree::list_files,
            tree::list_markdown_paths,
            watch::watch_folder,
            fsops::create_file,
            fsops::rename_path,
            fsops::trash_path,
            recovery::write_recovery,
            recovery::list_recovery,
            recovery::clear_recovery,
            settings::get_settings,
            settings::set_settings,
            settings::get_active_ui_locale,
            settings::set_ui_locale,
            themes::list_themes,
            themes::read_theme_css,
            themes::open_themes_dir,
            images::import_image,
            images::import_image_bytes,
            images::allow_asset_dir,
            images::allow_asset_file,
            export::export_pdf,
            pandoc::pandoc_status,
            pandoc::export_pandoc,
            pandoc::import_pandoc,
            upload::upload_images,
            open_with::take_pending_open_files,
            search::search_in_folder,
            menu::sync_menu_state,
            menu::quit_app,
            menu::restart_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // #67: Finder / Dock / `open -a Kalamos x.md` (macOS only event).
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                open_with::handle_opened_urls(_app, urls);
            }
        });
}
