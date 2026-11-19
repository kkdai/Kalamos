//! EX-01 manual smoke test: render an exported HTML page to PDF for real
//! (hidden WKWebView + NSPrintOperation + PDFKit bookmarks) and read it back.
//!
//! cargo run --manifest-path src-tauri/Cargo.toml --example export_pdf_smoke -- \
//!     <page.html> <headings.json> <out.pdf> [runs]
//!
//! `headings.json` is the `headings` array that `buildExportHtml` returns.

#[cfg(target_os = "macos")]
fn main() {
    use std::time::Instant;

    use kalamos_lib::export::{
        export_pdf_blocking, inspect_pdf, live_export_windows, ExportHeading, EXPORT_TIMEOUT,
    };
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: export_pdf_smoke <page.html> <headings.json> <out.pdf> [runs]");
        std::process::exit(2);
    }
    let html = std::fs::read_to_string(&args[1]).expect("read html");
    let headings: Vec<ExportHeading> =
        serde_json::from_str(&std::fs::read_to_string(&args[2]).expect("read headings"))
            .expect("parse headings");
    let out = args[3].clone();
    let runs: usize = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(2);

    let mtm = MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    std::thread::spawn(move || {
        let mut ok = true;
        for run in 1..=runs {
            let started = Instant::now();
            match export_pdf_blocking(&html, &out, &headings, EXPORT_TIMEOUT) {
                Ok(meta) => {
                    let summary = inspect_pdf(std::path::Path::new(&meta.path)).expect("inspect");
                    println!(
                        "run {run}: {} bytes in {:?}; pages={} size={}x{}pt bookmarks={}",
                        meta.size,
                        started.elapsed(),
                        summary.page_count,
                        summary.page_width_pt,
                        summary.page_height_pt,
                        summary.outline.len()
                    );
                    if run == runs {
                        for e in &summary.outline {
                            println!("  {}{} → p.{}", "  ".repeat(e.depth), e.label, e.page + 1);
                        }
                    }
                }
                Err(err) => {
                    ok = false;
                    println!("run {run}: FAILED {err}");
                }
            }
        }
        dispatch2::DispatchQueue::main().exec_async(move || {
            println!("hidden export windows left: {}", live_export_windows());
            std::process::exit(if ok { 0 } else { 1 });
        });
    });
    app.run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("export_pdf_smoke only runs on macOS");
}
