fn main() {
    tauri_build::build();
    // Under MinGW (x86_64-pc-windows-gnu) `tauri-build` only passes
    // `libresource.a` (Common Controls v6 manifest) to `--bins`, not to the
    // `--lib` test harness, which links `comctl32`'s `TaskDialogIndirect`
    // (only exported by v6). Also pass `--allow-multiple-definition` and compile
    // a merged manifest for tests when using the GNU linker.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        if let Ok(out_dir) = std::env::var("OUT_DIR") {
            let out_path = std::path::Path::new(&out_dir);
            let res = out_path.join("libresource.a");
            if res.is_file() {
                println!("cargo:rustc-link-search=native={out_dir}");
                println!("cargo:rustc-link-lib=static:+whole-archive=resource");
            }
            // Locate WebView2Loader.dll (copied by tauri-build into target/{profile})
            // and copy it into OUT_DIR so `webview2_embed.rs` can embed it for a
            // single-file portable .exe.
            if let Some(target_profile_dir) = out_path
                .ancestors()
                .nth(4)
            {
                let loader = target_profile_dir.join("WebView2Loader.dll");
                if loader.is_file() {
                    let embedded = out_path.join("WebView2Loader.dll");
                    let _ = std::fs::copy(&loader, &embedded);
                }
            }
        }
    }
}
