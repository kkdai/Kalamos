#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(target_os = "windows", target_env = "gnu"))]
mod webview2_embed;

fn main() {
    kalamos_lib::run()
}
