//! EX-01: export the current document to PDF with bookmarks.
//!
//! The WebView builds a standalone HTML page (src/export/html.ts). Here we
//! load it into a hidden, JavaScript-disabled `WKWebView`, print it with
//! `NSPrintOperation` (job disposition = save to file, no panels) so WebKit
//! paginates onto A4 pages, then reopen the PDF with PDFKit, locate every
//! heading with `findString:withOptions:` and write a nested `PDFOutline`.
//! The final file is written next to the target and renamed into place.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorKind};
use crate::files::FileMeta;

/// Whole export (load + print + bookmarks) must finish within this time.
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(60);

/// A4 in PostScript points.
pub const A4_WIDTH_PT: f64 = 595.28;
pub const A4_HEIGHT_PT: f64 = 841.89;
/// 1 mm in points. Margins must match `@page { margin: 18mm 20mm }` in
/// src/export/print-css.ts.
const MM: f64 = 72.0 / 25.4;
pub const MARGIN_TOP_PT: f64 = 18.0 * MM;
pub const MARGIN_BOTTOM_PT: f64 = 18.0 * MM;
pub const MARGIN_LEFT_PT: f64 = 20.0 * MM;
pub const MARGIN_RIGHT_PT: f64 = 20.0 * MM;

static EXPORT_BUSY: AtomicBool = AtomicBool::new(false);
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHeading {
    pub level: u8,
    pub text: String,
    pub id: String,
}

/// Parent of every heading in the bookmark tree: the nearest previous heading
/// with a smaller level (so h1 → h3 nests the h3 directly under the h1).
pub fn outline_parents(levels: &[u8]) -> Vec<Option<usize>> {
    let mut parents = Vec::with_capacity(levels.len());
    let mut stack: Vec<usize> = Vec::new();
    for (i, &level) in levels.iter().enumerate() {
        while let Some(&top) = stack.last() {
            if levels[top] < level {
                break;
            }
            stack.pop();
        }
        parents.push(stack.last().copied());
        stack.push(i);
    }
    parents
}

/// Where a heading's text was found: page index and distance from the page
/// top (points), i.e. reading order.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextHit {
    pub page: usize,
    pub top: f64,
}

/// Strings to search for a heading: the whitespace-normalised text, then a
/// prefix (a long heading may wrap onto several lines in the PDF).
pub fn search_needles(text: &str) -> Vec<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut needles = vec![normalized.clone()];
    let chars: Vec<char> = normalized.chars().collect();
    if chars.len() > 16 {
        let prefix: String = chars[..16].iter().collect();
        needles.push(prefix.trim_end().to_string());
    }
    needles
}

/// Is text whose vertical centre is `center_from_top` points below the page
/// top inside the printed area? WebKit also draws a clipped copy of a block
/// that straddles a page break into the previous page's bottom margin; that
/// copy is invisible but still in the text layer, so bookmarks must skip it.
pub fn in_printable_area(center_from_top: f64, page_height: f64) -> bool {
    center_from_top >= MARGIN_TOP_PT && center_from_top <= page_height - MARGIN_BOTTOM_PT
}

/// First hit at or after `cursor` in reading order.
fn first_hit_after(hits: &[TextHit], cursor: TextHit) -> Option<TextHit> {
    let mut sorted: Vec<TextHit> = hits.to_vec();
    sorted.sort_by(|a, b| a.page.cmp(&b.page).then(a.top.total_cmp(&b.top)));
    sorted
        .into_iter()
        .find(|h| h.page > cursor.page || (h.page == cursor.page && h.top >= cursor.top))
}

/// Destination of every heading, in order. Headings are matched in document
/// order (so repeated titles map to successive occurrences); a heading that
/// cannot be found points at the previous heading's location (or page 1).
pub fn resolve_destinations<F>(headings: &[ExportHeading], mut find: F) -> Vec<TextHit>
where
    F: FnMut(&str) -> Vec<TextHit>,
{
    let mut out = Vec::with_capacity(headings.len());
    let mut cursor = TextHit { page: 0, top: 0.0 };
    let mut previous = TextHit { page: 0, top: 0.0 };
    for heading in headings {
        let found = search_needles(&heading.text)
            .iter()
            .find_map(|needle| first_hit_after(&find(needle), cursor));
        match found {
            Some(hit) => {
                out.push(hit);
                previous = hit;
                cursor = TextHit {
                    page: hit.page,
                    top: hit.top + 0.5,
                };
            }
            None => out.push(previous),
        }
    }
    out
}

/// Text prepared for matching headings against a PDF page's text layer:
/// NFKC-folded (via `nfkc`), lowercased and with all whitespace removed (a
/// heading may wrap, and CJK lines break without spaces). Each folded char
/// remembers the UTF-16 range of the original char it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldedText {
    chars: Vec<char>,
    origin: Vec<(usize, usize)>,
}

pub fn fold_text(text: &str, nfkc: &mut dyn FnMut(char) -> String) -> FoldedText {
    let mut chars = Vec::new();
    let mut origin = Vec::new();
    let mut offset = 0;
    for c in text.chars() {
        let len = c.len_utf16();
        if !c.is_whitespace() {
            let folded = if c.is_ascii() { c.to_string() } else { nfkc(c) };
            for f in folded.chars().flat_map(char::to_lowercase) {
                if !f.is_whitespace() {
                    chars.push(f);
                    origin.push((offset, len));
                }
            }
        }
        offset += len;
    }
    FoldedText { chars, origin }
}

impl FoldedText {
    /// Every occurrence of `needle`, as UTF-16 ranges `(start, end)` of the
    /// original text.
    pub fn find_utf16(&self, needle: &FoldedText) -> Vec<(usize, usize)> {
        let n = needle.chars.len();
        if n == 0 || n > self.chars.len() {
            return Vec::new();
        }
        (0..=self.chars.len() - n)
            .filter(|&i| self.chars[i..i + n] == needle.chars[..])
            .map(|i| {
                let (start, _) = self.origin[i];
                let (last, len) = self.origin[i + n - 1];
                (start, last + len)
            })
            .collect()
    }
}

fn temp_sibling(target: &Path, tag: &str) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export.pdf");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    parent.join(format!(
        ".{name}.kalamos-{tag}-{}-{nanos}-{seq}.pdf",
        std::process::id()
    ))
}

fn file_meta(path: &Path) -> Result<FileMeta, AppError> {
    let meta = fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileMeta {
        path: path.to_string_lossy().into_owned(),
        mtime_ms,
        size: meta.len(),
    })
}

fn validate_out_path(out_path: &str) -> Result<PathBuf, AppError> {
    if out_path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let target = PathBuf::from(out_path);
    if target.is_dir() {
        return Err(AppError::invalid_path("Target path is a directory"));
    }
    let parent = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    if !parent.is_dir() {
        return Err(AppError::not_found(format!(
            "Parent directory does not exist: {}",
            parent.display()
        )));
    }
    Ok(target)
}

struct BusyGuard;

impl BusyGuard {
    fn acquire() -> Result<Self, AppError> {
        EXPORT_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| BusyGuard)
            .map_err(|_| AppError::new(ErrorKind::Io, "已有 PDF 匯出正在進行"))
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        EXPORT_BUSY.store(false, Ordering::Release);
    }
}

/// Bookmark entry read back from a PDF (for tests / verification).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineEntry {
    pub depth: usize,
    pub label: String,
    pub page: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfSummary {
    pub page_count: usize,
    pub page_width_pt: i64,
    pub page_height_pt: i64,
    pub outline: Vec<OutlineEntry>,
}

/// Blocking export (must not run on the main thread). Used by the command and
/// by `examples/export_pdf_smoke.rs`.
pub fn export_pdf_blocking(
    html: &str,
    out_path: &str,
    headings: &[ExportHeading],
    timeout: Duration,
) -> Result<FileMeta, AppError> {
    let target = validate_out_path(out_path)?;
    let _busy = BusyGuard::acquire()?;
    imp::export(html, &target, headings, timeout)
}

#[tauri::command]
pub async fn export_pdf(
    html: String,
    out_path: String,
    headings: Vec<ExportHeading>,
) -> Result<FileMeta, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        export_pdf_blocking(&html, &out_path, &headings, EXPORT_TIMEOUT)
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

/// Page count, page size and bookmark tree of a PDF file (macOS / PDFKit).
pub fn inspect_pdf(path: &Path) -> Result<PdfSummary, AppError> {
    imp::inspect(path)
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;

    pub fn export(
        _html: &str,
        _target: &Path,
        _headings: &[ExportHeading],
        _timeout: Duration,
    ) -> Result<FileMeta, AppError> {
        Err(AppError::new(
            ErrorKind::Io,
            "PDF export is only supported on macOS",
        ))
    }

    pub fn inspect(_path: &Path) -> Result<PdfSummary, AppError> {
        Err(AppError::new(
            ErrorKind::Io,
            "PDF inspection is only supported on macOS",
        ))
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{mpsc, Mutex};
    use std::time::Instant;

    use dispatch2::DispatchQueue;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject};
    use objc2::{define_class, msg_send, sel, AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{
        NSBackingStoreType, NSPaperOrientation, NSPrintHeaderAndFooter, NSPrintInfo,
        NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode,
        NSWindow, NSWindowStyleMask,
    };
    use objc2_foundation::{
        NSCopying, NSNumber, NSPoint, NSRange, NSRect, NSSize, NSString, NSURL,
    };
    use objc2_pdf_kit::{PDFDestination, PDFDisplayBox, PDFDocument, PDFOutline, PDFPage};
    use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

    const POLL_INTERVAL: Duration = Duration::from_millis(40);
    /// Grace period after the load finished (layout of images / SVG).
    const SETTLE_DELAY: Duration = Duration::from_millis(150);

    static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

    struct Job {
        window: Retained<NSWindow>,
        webview: Retained<WKWebView>,
        delegate: Retained<PrintDelegate>,
        operation: Option<Retained<NSPrintOperation>>,
    }

    /// Print results by job id. WebKit's print operation calls the delegate
    /// on its own thread, so this cannot live in `JOBS`.
    static PRINT_RESULTS: Mutex<Vec<(u64, bool)>> = Mutex::new(Vec::new());

    fn take_print_result(id: u64) -> Option<bool> {
        let mut results = PRINT_RESULTS.lock().unwrap_or_else(|e| e.into_inner());
        let index = results.iter().position(|(job, _)| *job == id)?;
        Some(results.swap_remove(index).1)
    }

    thread_local! {
        // Only ever touched on the main thread.
        static JOBS: RefCell<HashMap<u64, Job>> = RefCell::new(HashMap::new());
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; no Drop impl.
        #[unsafe(super(NSObject))]
        #[name = "KalamosPdfPrintDelegate"]
        struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn print_operation_did_run(
                &self,
                _operation: &NSPrintOperation,
                success: Bool,
                context: *mut c_void,
            ) {
                let id = context as usize as u64;
                PRINT_RESULTS
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push((id, success.as_bool()));
            }
        }
    );

    impl PrintDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    fn timeout_error() -> AppError {
        AppError::new(
            ErrorKind::Io,
            format!("匯出 PDF 逾時（{} 秒）", EXPORT_TIMEOUT.as_secs()),
        )
    }

    fn remaining(deadline: Instant) -> Result<Duration, AppError> {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(timeout_error)
    }

    /// Run `f` on the main thread (through the GCD main queue, which the
    /// Tauri / AppKit run loop services) and wait for its result.
    fn on_main<R, F>(deadline: Instant, f: F) -> Result<R, AppError>
    where
        R: Send + 'static,
        F: FnOnce(MainThreadMarker) -> R + Send + 'static,
    {
        let wait = remaining(deadline)?;
        let (tx, rx) = mpsc::channel();
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue runs on the main thread");
            let _ = tx.send(f(mtm));
        });
        rx.recv_timeout(wait).map_err(|_| timeout_error())
    }

    fn wait_until<F>(deadline: Instant, mut check: F) -> Result<(), AppError>
    where
        F: FnMut() -> Result<bool, AppError>,
    {
        loop {
            if check()? {
                return Ok(());
            }
            remaining(deadline)?;
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn file_url(path: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    fn content_size() -> NSSize {
        NSSize::new(
            A4_WIDTH_PT - MARGIN_LEFT_PT - MARGIN_RIGHT_PT,
            A4_HEIGHT_PT - MARGIN_TOP_PT - MARGIN_BOTTOM_PT,
        )
    }

    fn create_job(mtm: MainThreadMarker, id: u64, html_path: PathBuf) {
        let size = content_size();
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                mtm.alloc(),
                NSRect::new(NSPoint::new(-20000.0, -20000.0), size),
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        unsafe { window.setReleasedWhenClosed(false) };
        let webview = unsafe {
            let config = WKWebViewConfiguration::new(mtm);
            // The page is static: never run scripts from exported content.
            let prefs = config.defaultWebpagePreferences();
            prefs.setAllowsContentJavaScript(false);
            config.setDefaultWebpagePreferences(Some(&prefs));
            WKWebView::initWithFrame_configuration(
                mtm.alloc(),
                NSRect::new(NSPoint::new(0.0, 0.0), size),
                &config,
            )
        };
        window.setContentView(Some(&webview));
        unsafe {
            // Read access to `/` so local images (file:// URLs) can load.
            let root = NSURL::fileURLWithPath(&NSString::from_str("/"));
            webview.loadFileURL_allowingReadAccessToURL(&file_url(&html_path), &root);
        }
        let delegate = PrintDelegate::new();
        JOBS.with(|jobs| {
            jobs.borrow_mut().insert(
                id,
                Job {
                    window,
                    webview,
                    delegate,
                    operation: None,
                },
            );
        });
    }

    fn job_loaded(id: u64) -> Option<bool> {
        JOBS.with(|jobs| {
            jobs.borrow().get(&id).map(|job| unsafe {
                !job.webview.isLoading() && job.webview.estimatedProgress() >= 1.0
            })
        })
    }

    fn start_print(id: u64, pdf_path: PathBuf, title: String) -> Result<(), AppError> {
        let (window, webview, delegate) = JOBS
            .with(|jobs| {
                jobs.borrow().get(&id).map(|job| {
                    (
                        job.window.clone(),
                        job.webview.clone(),
                        job.delegate.clone(),
                    )
                })
            })
            .ok_or_else(|| AppError::new(ErrorKind::Io, "export job vanished"))?;

        let info = NSPrintInfo::new();
        info.setPaperSize(NSSize::new(A4_WIDTH_PT, A4_HEIGHT_PT));
        info.setOrientation(NSPaperOrientation::Portrait);
        info.setTopMargin(MARGIN_TOP_PT);
        info.setBottomMargin(MARGIN_BOTTOM_PT);
        info.setLeftMargin(MARGIN_LEFT_PT);
        info.setRightMargin(MARGIN_RIGHT_PT);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        info.setHorizontallyCentered(false);
        info.setVerticallyCentered(false);
        unsafe {
            info.setJobDisposition(NSPrintSaveJob);
            let dict = info.dictionary();
            let url = file_url(&pdf_path);
            let url_obj: &AnyObject = &url;
            dict.insert(NSPrintJobSavingURL, url_obj);
            // No header / footer (URL, date, page numbers).
            let no: Retained<NSNumber> = NSNumber::new_bool(false);
            let no_obj: &AnyObject = &no;
            dict.insert(NSPrintHeaderAndFooter, no_obj);
        }

        let operation = unsafe { webview.printOperationWithPrintInfo(&info) };
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        operation.setJobTitle(Some(&NSString::from_str(&title)));
        if let Some(view) = operation.view() {
            // WKWebView's print view needs a non-empty frame or pages come out blank.
            view.setFrame(webview.frame());
        }
        JOBS.with(|jobs| {
            if let Some(job) = jobs.borrow_mut().get_mut(&id) {
                job.operation = Some(operation.clone());
            }
        });
        let delegate_obj: &AnyObject = &delegate;
        // The sheet-modal print run needs the window ordered in; keep it
        // invisible, offscreen and click-through (borderless: never key).
        window.setAlphaValue(0.0);
        window.setIgnoresMouseEvents(true);
        window.orderFrontRegardless();
        unsafe {
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                &window,
                Some(delegate_obj),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                id as usize as *mut c_void,
            );
        }
        Ok(())
    }

    /// Close the hidden window and drop everything belonging to the job.
    fn cleanup_job(id: u64) {
        let job = JOBS.with(|jobs| jobs.borrow_mut().remove(&id));
        if let Some(job) = job {
            unsafe { job.webview.stopLoading() };
            job.window.setContentView(None);
            job.window.orderOut(None);
            job.window.close();
            drop(job);
        }
    }

    /// Number of export jobs (hidden windows) still alive; main thread only.
    pub fn live_jobs() -> usize {
        JOBS.with(|jobs| jobs.borrow().len())
    }

    fn render_to_pdf(
        html: &str,
        pdf_path: &Path,
        title: &str,
        deadline: Instant,
    ) -> Result<(), AppError> {
        if MainThreadMarker::new().is_some() {
            return Err(AppError::new(
                ErrorKind::Io,
                "export must not run on the main thread",
            ));
        }
        let id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
        let work_dir = std::env::temp_dir().join(format!(
            "kalamos-export-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&work_dir)?;
        let html_path = work_dir.join("index.html");

        let result = (|| -> Result<(), AppError> {
            fs::write(&html_path, html)?;
            let html_path = html_path.clone();
            on_main(deadline, move |mtm| create_job(mtm, id, html_path))?;
            wait_until(deadline, || {
                on_main(deadline, move |_| job_loaded(id))?
                    .ok_or_else(|| AppError::new(ErrorKind::Io, "export job vanished"))
            })?;
            std::thread::sleep(SETTLE_DELAY);
            let pdf = pdf_path.to_path_buf();
            let title = title.to_string();
            on_main(deadline, move |_| start_print(id, pdf, title))??;
            let mut printed = None;
            wait_until(deadline, || {
                printed = take_print_result(id);
                Ok(printed.is_some())
            })?;
            if printed != Some(true) {
                return Err(AppError::new(ErrorKind::Io, "列印成 PDF 失敗"));
            }
            Ok(())
        })();

        // Always close the hidden window, even after a timeout (the block then
        // runs as soon as the main thread is free again), and drop any PDF the
        // print operation may still write after we gave up.
        let leftover = if result.is_err() {
            Some(pdf_path.to_path_buf())
        } else {
            None
        };
        DispatchQueue::main().exec_async(move || {
            cleanup_job(id);
            if let Some(path) = leftover {
                let _ = fs::remove_file(path);
            }
        });
        let _ = fs::remove_dir_all(&work_dir);

        result?;
        let size = fs::metadata(pdf_path).map(|m| m.len()).unwrap_or(0);
        if size == 0 {
            return Err(AppError::new(ErrorKind::Io, "列印成 PDF 失敗（檔案是空的）"));
        }
        Ok(())
    }

    fn open_pdf(path: &Path) -> Result<Retained<PDFDocument>, AppError> {
        unsafe { PDFDocument::initWithURL(PDFDocument::alloc(), &file_url(path)) }
            .ok_or_else(|| AppError::parse(format!("Cannot open PDF: {}", path.display())))
    }

    fn page_height(page: &PDFPage) -> (f64, f64) {
        let b = unsafe { page.boundsForBox(PDFDisplayBox::MediaBox) };
        (b.origin.y, b.size.height)
    }

    /// NFKC of one character via Foundation, cached (PDF text from WebKit
    /// uses e.g. Kangxi radicals such as U+2F00 for 一).
    struct Nfkc(HashMap<char, String>);

    impl Nfkc {
        fn fold(&mut self, c: char) -> String {
            self.0
                .entry(c)
                .or_insert_with(|| {
                    let mut buf = [0u8; 4];
                    NSString::from_str(c.encode_utf8(&mut buf))
                        .precomposedStringWithCompatibilityMapping()
                        .to_string()
                })
                .clone()
        }
    }

    struct PageText {
        page: Retained<PDFPage>,
        folded: FoldedText,
    }

    fn page_texts(doc: &PDFDocument, nfkc: &mut Nfkc) -> Vec<PageText> {
        let count = unsafe { doc.pageCount() };
        (0..count)
            .filter_map(|i| unsafe { doc.pageAtIndex(i) })
            .map(|page| {
                let text = unsafe { page.string() }
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let folded = fold_text(&text, &mut |c| nfkc.fold(c));
                PageText { page, folded }
            })
            .collect()
    }

    fn find_hits(pages: &[PageText], needle: &str, nfkc: &mut Nfkc) -> Vec<TextHit> {
        let needle = fold_text(needle, &mut |c| nfkc.fold(c));
        let mut hits = Vec::new();
        for (index, page) in pages.iter().enumerate() {
            for (start, end) in page.folded.find_utf16(&needle) {
                let range = NSRange::new(start, end - start);
                let Some(selection) = (unsafe { page.page.selectionForRange(range) }) else {
                    continue;
                };
                let bounds = unsafe { selection.boundsForPage(&page.page) };
                let (origin_y, height) = page_height(&page.page);
                let top = origin_y + height - (bounds.origin.y + bounds.size.height);
                if !in_printable_area(top + bounds.size.height / 2.0, height) {
                    continue;
                }
                hits.push(TextHit { page: index, top });
            }
        }
        hits
    }

    /// Write `src` + bookmarks to `dst`; returns the number of bookmarks.
    fn add_outline(
        src: &Path,
        dst: &Path,
        headings: &[ExportHeading],
    ) -> Result<usize, AppError> {
        let doc = open_pdf(src)?;
        let page_count = unsafe { doc.pageCount() };
        if page_count == 0 {
            return Err(AppError::parse("Exported PDF has no pages"));
        }
        let mut nfkc = Nfkc(HashMap::new());
        let pages = page_texts(&doc, &mut nfkc);
        let destinations =
            resolve_destinations(headings, |needle| find_hits(&pages, needle, &mut nfkc));
        let levels: Vec<u8> = headings.iter().map(|h| h.level).collect();
        let parents = outline_parents(&levels);

        unsafe {
            // PDFKit writes an unmodified document's original bytes back and
            // drops an outline added to it, so copy the pages into a fresh
            // document and attach the outline root there before adding children.
            let out = PDFDocument::init(PDFDocument::alloc());
            for i in 0..page_count {
                if let Some(page) = doc.pageAtIndex(i) {
                    out.insertPage_atIndex(&page.copy(), out.pageCount());
                }
            }
            if let Some(attributes) = doc.documentAttributes() {
                out.setDocumentAttributes(Some(&attributes));
            }
            let page_count = out.pageCount();
            let root = PDFOutline::init(PDFOutline::alloc());
            out.setOutlineRoot(Some(&root));
            let mut nodes: Vec<Retained<PDFOutline>> = Vec::with_capacity(headings.len());
            for (i, heading) in headings.iter().enumerate() {
                let node = PDFOutline::init(PDFOutline::alloc());
                node.setLabel(Some(&NSString::from_str(&heading.text)));
                let hit = destinations[i];
                let page_index = hit.page.min(page_count - 1);
                if let Some(page) = out.pageAtIndex(page_index) {
                    let (origin_y, height) = page_height(&page);
                    // Land a little above the heading's top edge.
                    let y = (origin_y + height - hit.top + 8.0).min(origin_y + height);
                    let dest = PDFDestination::initWithPage_atPoint(
                        PDFDestination::alloc(),
                        &page,
                        NSPoint::new(0.0, y),
                    );
                    node.setDestination(Some(&dest));
                }
                let parent: &PDFOutline = match parents[i] {
                    Some(p) => &nodes[p],
                    None => &root,
                };
                parent.insertChild_atIndex(&node, parent.numberOfChildren());
                nodes.push(node);
            }
            if !out.writeToURL(&file_url(dst)) {
                return Err(AppError::new(ErrorKind::Io, "Cannot write PDF bookmarks"));
            }
            Ok(nodes.len())
        }
    }

    pub fn export(
        html: &str,
        target: &Path,
        headings: &[ExportHeading],
        timeout: Duration,
    ) -> Result<FileMeta, AppError> {
        let deadline = Instant::now() + timeout;
        let title = target
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Kalamos")
            .to_string();
        let printed = temp_sibling(target, "print");
        let outlined = temp_sibling(target, "outline");
        let result = (|| -> Result<FileMeta, AppError> {
            render_to_pdf(html, &printed, &title, deadline)?;
            if headings.is_empty() {
                fs::rename(&printed, target)?;
            } else {
                add_outline(&printed, &outlined, headings)?;
                remaining(deadline)?;
                fs::rename(&outlined, target)?;
            }
            file_meta(target)
        })();
        let _ = fs::remove_file(&printed);
        let _ = fs::remove_file(&outlined);
        result
    }

    fn collect_outline(
        doc: &PDFDocument,
        node: &PDFOutline,
        depth: usize,
        out: &mut Vec<OutlineEntry>,
    ) {
        let count = unsafe { node.numberOfChildren() };
        for i in 0..count {
            let Some(child) = (unsafe { node.childAtIndex(i) }) else {
                continue;
            };
            let label = unsafe { child.label() }
                .map(|s| s.to_string())
                .unwrap_or_default();
            let page = unsafe { child.destination() }
                .and_then(|d| unsafe { d.page() })
                .map(|p| unsafe { doc.indexForPage(&p) })
                .unwrap_or(usize::MAX);
            out.push(OutlineEntry { depth, label, page });
            collect_outline(doc, &child, depth + 1, out);
        }
    }

    pub fn inspect(path: &Path) -> Result<PdfSummary, AppError> {
        let doc = open_pdf(path)?;
        let page_count = unsafe { doc.pageCount() };
        let (w, h) = match unsafe { doc.pageAtIndex(0) } {
            Some(page) => {
                let b = unsafe { page.boundsForBox(PDFDisplayBox::MediaBox) };
                (b.size.width.round() as i64, b.size.height.round() as i64)
            }
            None => (0, 0),
        };
        let mut outline = Vec::new();
        if let Some(root) = unsafe { doc.outlineRoot() } {
            collect_outline(&doc, &root, 0, &mut outline);
        }
        Ok(PdfSummary {
            page_count,
            page_width_pt: w,
            page_height_pt: h,
            outline,
        })
    }
}

/// Hidden export windows still alive (call on the main thread; 0 elsewhere).
#[cfg(target_os = "macos")]
pub fn live_export_windows() -> usize {
    imp::live_jobs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(level: u8, text: &str) -> ExportHeading {
        ExportHeading {
            level,
            text: text.to_string(),
            id: text.to_lowercase(),
        }
    }

    #[test]
    fn outline_parents_follow_heading_levels() {
        // h1, h2, h3, h2, h1
        assert_eq!(
            outline_parents(&[1, 2, 3, 2, 1]),
            vec![None, Some(0), Some(1), Some(0), None]
        );
    }

    #[test]
    fn outline_parents_handle_skipped_levels() {
        // h1 → h3 nests directly; a later h2 is a sibling of that h3 under h1;
        // a leading h3 (before any h1) is a root.
        assert_eq!(
            outline_parents(&[3, 1, 3, 2, 4, 1]),
            vec![None, None, Some(1), Some(1), Some(3), None]
        );
        assert_eq!(outline_parents(&[]), Vec::<Option<usize>>::new());
    }

    #[test]
    fn duplicate_headings_map_to_successive_occurrences() {
        let headings = [h(1, "Intro"), h(2, "Notes"), h(1, "Next"), h(2, "Notes")];
        let hits = |needle: &str| match needle {
            "Intro" => vec![TextHit { page: 0, top: 10.0 }],
            "Notes" => vec![
                TextHit { page: 2, top: 50.0 },
                TextHit { page: 0, top: 300.0 },
            ],
            "Next" => vec![TextHit { page: 1, top: 20.0 }],
            _ => vec![],
        };
        let dests = resolve_destinations(&headings, hits);
        assert_eq!(
            dests,
            vec![
                TextHit { page: 0, top: 10.0 },
                TextHit { page: 0, top: 300.0 },
                TextHit { page: 1, top: 20.0 },
                TextHit { page: 2, top: 50.0 },
            ]
        );
    }

    #[test]
    fn missing_heading_points_at_previous_heading() {
        let headings = [h(1, "A"), h(2, "Gone"), h(2, "B")];
        let dests = resolve_destinations(&headings, |needle| match needle {
            "A" => vec![TextHit { page: 1, top: 5.0 }],
            "B" => vec![TextHit { page: 3, top: 7.0 }],
            _ => vec![],
        });
        assert_eq!(
            dests,
            vec![
                TextHit { page: 1, top: 5.0 },
                TextHit { page: 1, top: 5.0 },
                TextHit { page: 3, top: 7.0 },
            ]
        );
        // Nothing found at all → page 1.
        let none = resolve_destinations(&[h(1, "X")], |_| vec![]);
        assert_eq!(none, vec![TextHit { page: 0, top: 0.0 }]);
    }

    #[test]
    fn search_needles_normalise_and_add_prefix_for_long_titles() {
        assert_eq!(search_needles("  a\t b  "), vec!["a b".to_string()]);
        assert!(search_needles("   ").is_empty());
        let long = search_needles("A very long heading that will wrap");
        assert_eq!(long.len(), 2);
        assert_eq!(long[1], "A very long head");
    }

    #[test]
    fn folded_search_ignores_whitespace_case_and_compat_forms() {
        // Fake NFKC: Kangxi radical one → CJK unified 一.
        let mut nfkc = |c: char| if c == '\u{2F00}' { "一".into() } else { c.to_string() };
        let page = fold_text("Intro\n第\u{2F00}章 Intro-\nduction\nnotes", &mut nfkc);
        let needle = fold_text("第一章 INTRO-duction", &mut nfkc);
        // "第" starts at UTF-16 offset 6; "n" of "duction" ends at 6+3+1+6+1+7.
        assert_eq!(page.find_utf16(&needle), vec![(6, 24)]);
        let intro = fold_text("intro", &mut nfkc);
        assert_eq!(page.find_utf16(&intro).len(), 2);
        assert!(page.find_utf16(&fold_text("   ", &mut nfkc)).is_empty());
        // Astral chars count as two UTF-16 units.
        let emoji = fold_text("😀 Title", &mut nfkc);
        assert_eq!(emoji.find_utf16(&fold_text("title", &mut nfkc)), vec![(3, 8)]);
    }

    #[test]
    fn hits_inside_the_page_margins_are_ignored() {
        // A4: the clipped copy of a heading at the bottom margin (centre ~38 pt
        // above the page bottom) is not a real occurrence; the body area is.
        assert!(!in_printable_area(A4_HEIGHT_PT - 38.0, A4_HEIGHT_PT));
        assert!(!in_printable_area(20.0, A4_HEIGHT_PT));
        assert!(in_printable_area(MARGIN_TOP_PT + 10.0, A4_HEIGHT_PT));
        assert!(in_printable_area(A4_HEIGHT_PT - MARGIN_BOTTOM_PT - 10.0, A4_HEIGHT_PT));
    }

    #[test]
    fn rejects_bad_output_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = export_pdf_blocking("<p>x</p>", "  ", &[], EXPORT_TIMEOUT).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        let err = export_pdf_blocking(
            "<p>x</p>",
            dir.path().to_str().unwrap(),
            &[],
            EXPORT_TIMEOUT,
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        let missing = dir.path().join("nope").join("out.pdf");
        let err =
            export_pdf_blocking("<p>x</p>", missing.to_str().unwrap(), &[], EXPORT_TIMEOUT)
                .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
    }

    #[test]
    fn headings_deserialize_from_camel_case_json() {
        let v: Vec<ExportHeading> =
            serde_json::from_str(r#"[{"level":2,"text":"標題","id":"標題"}]"#).unwrap();
        assert_eq!(v, vec![h(2, "標題")].into_iter().map(|mut x| { x.id = "標題".into(); x }).collect::<Vec<_>>());
    }
}
