use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent};
use serde::{Serialize, Deserialize};

struct AppState {
    processes: Mutex<Vec<Child>>,
    next_port: u16,
    claude_port: u16,
}

#[derive(Serialize, Deserialize)]
struct Config {
    vault_path: Option<String>,
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let mut config_dir = app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&config_dir);
    config_dir.push("config.json");
    config_dir
}

fn get_saved_vault_path(app: &AppHandle) -> Option<PathBuf> {
    let config_path = get_config_path(app);
    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(config_path) {
            if let Ok(config) = serde_json::from_str::<Config>(&content) {
                if let Some(path_str) = config.vault_path {
                    let path = PathBuf::from(path_str);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

fn save_vault_path(app: &AppHandle, path: &Path) {
    let config_path = get_config_path(app);
    let config = Config {
        vault_path: Some(path.to_string_lossy().to_string()),
    };
    if let Ok(content) = serde_json::to_string_pretty(&config) {
        let _ = fs::write(config_path, content);
    }
}

fn get_free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .ok()
}

fn get_node_path(app: &AppHandle) -> PathBuf {
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled_node = res_dir.join("bin").join("node.exe");
        if bundled_node.exists() {
            return bundled_node;
        }
    }
    PathBuf::from("node")
}

fn kill_processes(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut procs = state.processes.lock().unwrap();
        for mut child in procs.drain(..) {
            let _ = child.kill();
        }
    }
}

fn spawn_servers(app: &AppHandle) {
    let is_dev = cfg!(debug_assertions);
    let state = app.state::<AppState>();
    let next_port = state.next_port;
    let claude_port = state.claude_port;
    let node_path = get_node_path(app);
    
    let current_dir = std::env::current_dir().unwrap_or_default();
    let workspace_root = if current_dir.ends_with("src-tauri") {
        current_dir.parent().unwrap_or(&current_dir).to_path_buf()
    } else {
        current_dir.clone()
    };

    let vault_path = get_saved_vault_path(app)
        .unwrap_or_else(|| {
            if is_dev {
                let workspace_vault = workspace_root.join("vault");
                let _ = fs::create_dir_all(&workspace_vault);
                workspace_vault
            } else {
                PathBuf::from(".")
            }
        });

    let (standalone_dir, chat_dir) = if is_dev {
        (
            workspace_root.join(".next").join("standalone"),
            workspace_root.join("claude-chat"),
        )
    } else {
        let res_dir = app.path().resource_dir().unwrap_or_default();
        (
            res_dir.join("_up_").join(".next").join("standalone"),
            res_dir.join("_up_").join("claude-chat"),
        )
    };

    let mut new_procs = Vec::new();

    // 1. Spawn Next.js server in production
    if !is_dev {
        let server_js = standalone_dir.join("server.js");
        eprintln!("[inkfellow] Next.js server.js path: {:?}", server_js);
        eprintln!("[inkfellow] standalone_dir exists: {}", standalone_dir.exists());
        eprintln!("[inkfellow] server_js exists: {}", server_js.exists());
        eprintln!("[inkfellow] node_path: {:?}", node_path);
        eprintln!("[inkfellow] PORT: {}, VAULT_PATH: {:?}", next_port, vault_path);
        if server_js.exists() {
            let mut cmd = Command::new(&node_path);
            cmd.arg(&server_js)
                .current_dir(&standalone_dir)
                .env("PORT", next_port.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .env("VAULT_PATH", &vault_path)
                .env("DESKTOP_MODE", "true")
                .env("NEXT_PUBLIC_CLAUDE_CHAT_PORT", claude_port.to_string());
                
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                // CREATE_NO_WINDOW = 0x08000000 to run silently without command shell popup
                cmd.creation_flags(0x08000000);
            }
            
            match cmd.spawn() {
                Ok(child) => { eprintln!("[inkfellow] Next.js server spawned, PID: {}", child.id()); new_procs.push(child) },
                Err(e) => eprintln!("[inkfellow] Failed to spawn Next.js standalone server: {:?}", e),
            }
        } else {
            eprintln!("[inkfellow] Next.js standalone server.js NOT FOUND at: {:?}", server_js);
        }
    }

    // 2. Spawn claude-chat server (WebSocket service)
    let chat_server_js = chat_dir.join("server.js");
    if chat_server_js.exists() {
        let mut cmd = Command::new(&node_path);
        cmd.arg(&chat_server_js)
            .current_dir(&chat_dir)
            .env("PORT", claude_port.to_string())
            .env("HOST", "127.0.0.1")
            .env("VAULT_PATH", &vault_path)
            .env("CLAUDE_PERMISSION_MODE", "auto");
            
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        
        match cmd.spawn() {
            Ok(child) => new_procs.push(child),
            Err(e) => eprintln!("Failed to spawn claude-chat server: {:?}", e),
        }
    } else {
        eprintln!("claude-chat server.js not found at: {:?}", chat_server_js);
    }

    let mut procs = state.processes.lock().unwrap();
    *procs = new_procs;
}

#[tauri::command]
fn get_vault_path_cmd(app: AppHandle) -> Result<String, String> {
    get_saved_vault_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "No vault path set".to_string())
}

#[tauri::command]
fn select_and_set_vault_cmd(app: AppHandle) -> Result<String, String> {
    if let Some(path) = rfd::FileDialog::new()
        .set_title("选择笔记文件夹 (Vault)")
        .pick_folder() {
        let path_str = path.to_string_lossy().to_string();
        save_vault_path(&app, &path);
        
        // Initialize Git inside the new vault directory if it doesn't exist
        let git_dir = path.join(".git");
        if !git_dir.exists() {
            let mut init_cmd = Command::new("git");
            init_cmd.arg("-C").arg(&path).arg("init");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                init_cmd.creation_flags(0x08000000);
            }
            let _ = init_cmd.output();

            let mut add_cmd = Command::new("git");
            add_cmd.arg("-C").arg(&path).arg("add").arg(".");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                add_cmd.creation_flags(0x08000000);
            }
            let _ = add_cmd.output();

            let mut commit_cmd = Command::new("git");
            commit_cmd.arg("-C").arg(&path)
                .arg("-c").arg("user.name=Notes Setup")
                .arg("-c").arg("user.email=setup@localhost")
                .arg("commit").arg("-m").arg("Initial notes");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                commit_cmd.creation_flags(0x08000000);
            }
            let _ = commit_cmd.output();
        }
        
        // Kill and restart servers with the new vault path
        kill_processes(&app);
        spawn_servers(&app);
        
        // Reload parent window
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval("window.location.reload()");
        }
        
        Ok(path_str)
    } else {
        Err("User cancelled selection".to_string())
    }
}

#[tauri::command]
fn set_vault_path_cmd(app: AppHandle, path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.exists() {
        return Err("Path does not exist".to_string());
    }
    
    save_vault_path(&app, &path_buf);
    
    // Initialize Git inside the new vault directory if it doesn't exist
    let git_dir = path_buf.join(".git");
    if !git_dir.exists() {
        let mut init_cmd = Command::new("git");
        init_cmd.arg("-C").arg(&path_buf).arg("init");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            init_cmd.creation_flags(0x08000000);
        }
        let _ = init_cmd.output();

        let mut add_cmd = Command::new("git");
        add_cmd.arg("-C").arg(&path_buf).arg("add").arg(".");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            add_cmd.creation_flags(0x08000000);
        }
        let _ = add_cmd.output();

        let mut commit_cmd = Command::new("git");
        commit_cmd.arg("-C").arg(&path_buf)
            .arg("-c").arg("user.name=Notes Setup")
            .arg("-c").arg("user.email=setup@localhost")
            .arg("commit").arg("-m").arg("Initial notes");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            commit_cmd.creation_flags(0x08000000);
        }
        let _ = commit_cmd.output();
    }
    
    // Kill and restart servers with the new vault path
    kill_processes(&app);
    spawn_servers(&app);
    
    // Reload parent window
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.location.reload()");
    }
    
    Ok(path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let next_port = if cfg!(debug_assertions) { 3000 } else { get_free_port().unwrap_or(3009) };
    let claude_port = if cfg!(debug_assertions) { 8082 } else { get_free_port().unwrap_or(8089) };

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState {
            processes: Mutex::new(Vec::new()),
            next_port,
            claude_port,
        })
        .invoke_handler(tauri::generate_handler![
            get_vault_path_cmd,
            select_and_set_vault_cmd,
            set_vault_path_cmd
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            
            // 1. Vault path resolution on startup
            let is_dev = cfg!(debug_assertions);
            let vault_path = get_saved_vault_path(&app_handle);
            if vault_path.is_none() || !vault_path.as_ref().unwrap().exists() {
                if is_dev {
                    let current_dir = std::env::current_dir().unwrap_or_default();
                    let workspace_root = if current_dir.ends_with("src-tauri") {
                        current_dir.parent().unwrap_or(&current_dir).to_path_buf()
                    } else {
                        current_dir.clone()
                    };
                    let workspace_vault = workspace_root.join("vault");
                    let _ = fs::create_dir_all(&workspace_vault);
                    save_vault_path(&app_handle, &workspace_vault);
                } else {
                    // Do not prompt before app opens. Default to a writable directory.
                    // The user can change this later from the web UI.
                    let default_vault = match app_handle.path().document_dir() {
                        Ok(dir) => dir.join("inkfellow_notes"),
                        Err(_) => std::env::current_dir().unwrap_or_default().join("inkfellow_notes"),
                    };
                    let _ = fs::create_dir_all(&default_vault);
                    save_vault_path(&app_handle, &default_vault);
                }
            }

            // 2. Initialize Git repository in vault_path if it doesn't exist
            if let Some(path) = get_saved_vault_path(&app_handle) {
                let git_dir = path.join(".git");
                if !git_dir.exists() {
                    let mut init_cmd = Command::new("git");
                    init_cmd.arg("-C").arg(&path).arg("init");
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        init_cmd.creation_flags(0x08000000);
                    }
                    let _ = init_cmd.output();

                    let mut add_cmd = Command::new("git");
                    add_cmd.arg("-C").arg(&path).arg("add").arg(".");
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        add_cmd.creation_flags(0x08000000);
                    }
                    let _ = add_cmd.output();

                    let mut commit_cmd = Command::new("git");
                    commit_cmd.arg("-C").arg(&path)
                        .arg("-c").arg("user.name=Notes Setup")
                        .arg("-c").arg("user.email=setup@localhost")
                        .arg("commit").arg("-m").arg("Initial notes");
                    #[cfg(target_os = "windows")]
                    {
                        use std::os::windows::process::CommandExt;
                        commit_cmd.creation_flags(0x08000000);
                    }
                    let _ = commit_cmd.output();
                }
            }

            // 3. Navigate to loading page first (production only), then spawn servers
            if !is_dev {
                // Show loading page immediately so user sees feedback
                if let Some(window) = app.get_webview_window("main") {
                    // loading.html is in the frontendDist (public/) folder
                    let loading_url = format!("tauri://localhost/loading.html");
                    let _ = window.navigate(loading_url.parse().unwrap());
                }
            }

            // 4. Spawn local node services (after loading page is shown)
            spawn_servers(&app_handle);

            // 5. In production, poll in background until server is ready then navigate
            if !is_dev {
                let handle_clone = app_handle.clone();
                let target_url = format!("http://127.0.0.1:{}", next_port);
                std::thread::spawn(move || {
                    let start = std::time::Instant::now();
                    let timeout = std::time::Duration::from_secs(30);
                    loop {
                        if start.elapsed() > timeout {
                            eprintln!("Timed out waiting for Next.js server to start");
                            break;
                        }
                        // Try to connect to the server port
                        match std::net::TcpStream::connect(format!("127.0.0.1:{}", next_port)) {
                            Ok(_) => {
                                // Server is accepting connections - navigate
                                std::thread::sleep(std::time::Duration::from_millis(200));
                                if let Some(window) = handle_clone.get_webview_window("main") {
                                    let _ = window.navigate(target_url.parse().unwrap());
                                }
                                break;
                            }
                            Err(_) => {
                                std::thread::sleep(std::time::Duration::from_millis(300));
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::Exit => {
            kill_processes(app_handle);
        }
        _ => {}
    });
}
