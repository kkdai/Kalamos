//! Single-file portable EXE support on Windows GNU (`x86_64-pc-windows-gnu`):
//!
//! Under MSVC, `webview2-com-sys` statically links `WebView2LoaderStatic.lib`.
//! Under GNU, `webview2-com-sys` links `WebView2Loader.dll` dynamically.
//! By embedding `WebView2Loader.dll` (~160 KB) and exporting the loader entry
//! points directly from the executable, `ld` resolves them locally without
//! adding `WebView2Loader.dll` to the PE import table — making `kalamos.exe`
//! completely self-contained.

#![cfg(all(target_os = "windows", target_env = "gnu"))]

use std::ffi::c_void;
use std::sync::OnceLock;

static WEBVIEW2_LOADER_BYTES: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/WebView2Loader.dll"));

const E_FAIL: i32 = -2147467259_i32; // 0x80004005

#[link(name = "kernel32")]
extern "system" {
    fn LoadLibraryW(lp_lib_file_name: *const u16) -> *mut c_void;
    fn GetProcAddress(h_module: *mut c_void, lp_proc_name: *const u8) -> *mut c_void;
}

fn load_embedded_dll() -> Option<usize> {
    static HANDLE: OnceLock<Option<usize>> = OnceLock::new();
    *HANDLE.get_or_init(|| {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join("io.kalamos.app");
        let _ = std::fs::create_dir_all(&base);
        let dll_path = base.join("WebView2Loader.dll");
        let needs_write = match std::fs::metadata(&dll_path) {
            Ok(m) => m.len() != WEBVIEW2_LOADER_BYTES.len() as u64,
            Err(_) => true,
        };
        if needs_write {
            let _ = std::fs::write(&dll_path, WEBVIEW2_LOADER_BYTES);
        }
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = dll_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let h = unsafe { LoadLibraryW(wide.as_ptr()) };
        if h.is_null() {
            None
        } else {
            Some(h as usize)
        }
    })
}

unsafe fn proc_addr(name: &[u8]) -> Option<*mut c_void> {
    let h = load_embedded_dll()? as *mut c_void;
    let p = GetProcAddress(h, name.as_ptr());
    if p.is_null() {
        None
    } else {
        Some(p)
    }
}

#[no_mangle]
pub unsafe extern "system" fn CompareBrowserVersions(
    version1: *const u16,
    version2: *const u16,
    result: *mut i32,
) -> i32 {
    type Fn = unsafe extern "system" fn(*const u16, *const u16, *mut i32) -> i32;
    match proc_addr(b"CompareBrowserVersions\0") {
        Some(p) => core::mem::transmute::<*mut c_void, Fn>(p)(version1, version2, result),
        None => E_FAIL,
    }
}

#[no_mangle]
pub unsafe extern "system" fn CreateCoreWebView2Environment(
    environment_created_handler: *mut c_void,
) -> i32 {
    type Fn = unsafe extern "system" fn(*mut c_void) -> i32;
    match proc_addr(b"CreateCoreWebView2Environment\0") {
        Some(p) => core::mem::transmute::<*mut c_void, Fn>(p)(environment_created_handler),
        None => E_FAIL,
    }
}

#[no_mangle]
pub unsafe extern "system" fn CreateCoreWebView2EnvironmentWithOptions(
    browser_executable_folder: *const u16,
    user_data_folder: *const u16,
    environment_options: *mut c_void,
    environment_created_handler: *mut c_void,
) -> i32 {
    type Fn =
        unsafe extern "system" fn(*const u16, *const u16, *mut c_void, *mut c_void) -> i32;
    match proc_addr(b"CreateCoreWebView2EnvironmentWithOptions\0") {
        Some(p) => core::mem::transmute::<*mut c_void, Fn>(p)(
            browser_executable_folder,
            user_data_folder,
            environment_options,
            environment_created_handler,
        ),
        None => E_FAIL,
    }
}

#[no_mangle]
pub unsafe extern "system" fn GetAvailableCoreWebView2BrowserVersionString(
    browser_executable_folder: *const u16,
    version_info: *mut *mut u16,
) -> i32 {
    type Fn = unsafe extern "system" fn(*const u16, *mut *mut u16) -> i32;
    match proc_addr(b"GetAvailableCoreWebView2BrowserVersionString\0") {
        Some(p) => core::mem::transmute::<*mut c_void, Fn>(p)(
            browser_executable_folder,
            version_info,
        ),
        None => E_FAIL,
    }
}

#[no_mangle]
pub unsafe extern "system" fn GetAvailableCoreWebView2BrowserVersionStringWithOptions(
    browser_executable_folder: *const u16,
    environment_options: *mut c_void,
    version_info: *mut *mut u16,
) -> i32 {
    type Fn = unsafe extern "system" fn(*const u16, *mut c_void, *mut *mut u16) -> i32;
    match proc_addr(b"GetAvailableCoreWebView2BrowserVersionStringWithOptions\0") {
        Some(p) => core::mem::transmute::<*mut c_void, Fn>(p)(
            browser_executable_folder,
            environment_options,
            version_info,
        ),
        None => E_FAIL,
    }
}
