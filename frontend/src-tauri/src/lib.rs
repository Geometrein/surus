use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use tauri::{Manager, RunEvent};

/// Process-group id of the spawned backend, so we can tear down the whole tree
/// (uv → python in dev, or the PyInstaller bootloader → python child in release)
/// when the app exits. Killing just the direct child would orphan the grandchild
/// that actually holds the port.
struct Backend(Mutex<Option<i32>>);

const BACKEND_PORT: u16 = 8765;

/// Start the FastAPI backend and return its pid (== its process-group id, since
/// we make it a group leader).
fn spawn_backend() -> std::io::Result<u32> {
    let mut cmd = if cfg!(debug_assertions) {
        // Dev: run the real Python via uv from the repo root. The terminal that
        // launched `tauri dev` has the file permissions the repo needs.
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent() // frontend/
            .and_then(|p| p.parent()) // repo root
            .expect("repo root")
            .to_path_buf();
        let mut c = Command::new("uv");
        c.args(["run", "python", "-m", "backend.server"]);
        c.current_dir(repo_root);
        c
    } else {
        // Release: the self-contained sidecar bundled next to this executable
        // (Contents/MacOS/surus-backend). No repo or Python needed.
        let exe_dir = std::env::current_exe()?
            .parent()
            .expect("exe dir")
            .to_path_buf();
        Command::new(exe_dir.join("surus-backend"))
    };

    // The backend watches this pid and exits if we (the shell) go away — the
    // primary, crash-proof guard against orphaning the server on :8765.
    cmd.env("SURUS_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(unix)]
    {
        // Put the backend in its own process group so a single killpg() takes
        // down the whole subtree on exit.
        cmd.process_group(0);
    }

    let child = cmd.spawn()?;
    Ok(child.id())
}

#[cfg(unix)]
fn kill_backend(pgid: i32) {
    // Negative pid would target the group via kill(); killpg is the explicit form.
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_backend(_pgid: i32) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Backend(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let pid = spawn_backend().expect("failed to start backend") as i32;
            *app.state::<Backend>().0.lock().unwrap() = Some(pid);

            // Reveal the window once the backend is accepting connections.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for _ in 0..160 {
                    if std::net::TcpStream::connect(("127.0.0.1", BACKEND_PORT)).is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Belt-and-suspenders: kill the backend group immediately on exit
            // (the backend's own parent-watchdog is the crash-proof backstop).
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                if let Some(pgid) = app_handle.state::<Backend>().0.lock().unwrap().take() {
                    kill_backend(pgid);
                }
            }
        });
}
