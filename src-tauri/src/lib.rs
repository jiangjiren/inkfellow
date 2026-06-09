use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, RunEvent};

const EXCLUDED_DIRECTORY_NAMES: &[&str] =
    &[".git", ".obsidian", ".claude", ".claudian", "node_modules"];

const NOTE_EXTENSIONS: &[&str] = &[
    "md", "html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "avif",
];

const TEXT_NOTE_EXTENSIONS: &[&str] = &["md", "html", "htm"];
const IMAGE_NOTE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];

struct AppState {
    processes: Mutex<Vec<Child>>,
    claude_port: u16,
}

#[derive(Serialize, Deserialize)]
struct Config {
    vault_path: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum NoteTreeNode {
    Directory {
        name: String,
        path: String,
        children: Vec<NoteTreeNode>,
    },
    File {
        name: String,
        path: String,
        size: u64,
        #[serde(rename = "updatedAt")]
        updated_at: u64,
        extension: String,
    },
}

#[derive(Serialize)]
struct TreeResponse {
    root: NoteTreeNode,
    #[serde(rename = "generatedAt")]
    generated_at: u64,
}

#[derive(Serialize)]
struct NoteResponse {
    name: String,
    path: String,
    content: String,
    size: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    extension: String,
}

#[derive(Serialize)]
struct AssetResponse {
    name: String,
    path: String,
    #[serde(rename = "dataUrl")]
    data_url: String,
    mime: String,
    size: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    extension: String,
}

#[derive(Serialize)]
struct DesktopState {
    #[serde(rename = "vaultPath")]
    vault_path: String,
    #[serde(rename = "agentUrl")]
    agent_url: String,
    #[serde(rename = "agentPort")]
    agent_port: u16,
    #[serde(rename = "agentReady")]
    agent_ready: bool,
}

#[derive(Serialize)]
struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

#[derive(Serialize)]
struct GitFileStatus {
    name: String,
    path: String,
    state: String,
    kind: String,
}

#[derive(Serialize)]
struct GitStatus {
    initialized: bool,
    clean: bool,
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    entries: Vec<String>,
    files: Vec<GitFileStatus>,
    #[serde(rename = "lastSync")]
    last_sync: Option<String>,
    raw: String,
}

#[derive(Serialize)]
struct GitCommitRecord {
    hash: String,
    message: String,
    author: String,
    date: String,
}

#[derive(Serialize)]
struct GitDiffLine {
    #[serde(rename = "type")]
    line_type: String,
    content: String,
}

#[derive(Serialize)]
struct GitFileDiff {
    path: String,
    binary: bool,
    lines: Vec<GitDiffLine>,
    #[serde(rename = "addCount")]
    add_count: u32,
    #[serde(rename = "removeCount")]
    remove_count: u32,
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    name: String,
    snippet: String,
}

#[derive(Clone)]
struct ResolvedPath {
    absolute: PathBuf,
    relative: String,
}

fn unix_secs(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_secs()
}

fn now_secs() -> u64 {
    unix_secs(SystemTime::now())
}

fn is_excluded_segment(value: &str) -> bool {
    EXCLUDED_DIRECTORY_NAMES
        .iter()
        .any(|excluded| excluded.eq_ignore_ascii_case(value))
}

fn has_excluded_segment(relative_path: &str) -> bool {
    relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .any(is_excluded_segment)
}

fn path_extension(value: &Path) -> String {
    value
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_note_file(value: &Path) -> bool {
    let ext = path_extension(value);
    NOTE_EXTENSIONS.iter().any(|allowed| *allowed == ext)
}

fn is_text_note(value: &Path) -> bool {
    let ext = path_extension(value);
    TEXT_NOTE_EXTENSIONS.iter().any(|allowed| *allowed == ext)
}

fn is_image_note(value: &Path) -> bool {
    let ext = path_extension(value);
    IMAGE_NOTE_EXTENSIONS.iter().any(|allowed| *allowed == ext)
}

fn mime_for_extension(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn to_slash_path(value: &Path) -> String {
    value
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_relative_path(input: &str, allow_empty: bool) -> Result<String, String> {
    let normalized_input = input.replace('\\', "/");
    let trimmed = normalized_input.trim().trim_start_matches('/');

    if trimmed.is_empty() {
        if allow_empty {
            return Ok(String::new());
        }
        return Err("Missing path.".to_string());
    }

    if trimmed.contains('\0') {
        return Err("Invalid path.".to_string());
    }

    let mut parts = Vec::new();
    for raw_segment in trimmed.split('/') {
        let segment = raw_segment.trim();
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("Path traversal is not allowed.".to_string());
        }
        if is_excluded_segment(segment) {
            return Err("This path is excluded.".to_string());
        }
        parts.push(segment.to_string());
    }

    Ok(parts.join("/"))
}

fn relative_to_path_buf(relative_path: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for part in relative_path.split('/').filter(|part| !part.is_empty()) {
        path.push(part);
    }
    path
}

fn sanitize_name_segment(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("Missing name.".to_string());
    }
    if name.contains('\0') || name.contains('/') || name.contains('\\') {
        return Err("Invalid name.".to_string());
    }
    if name == "." || name == ".." || is_excluded_segment(name) {
        return Err("Invalid name.".to_string());
    }
    if name
        .chars()
        .any(|ch| matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("Invalid name.".to_string());
    }
    Ok(name.to_string())
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let mut config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&config_dir);
    config_dir.push("config.json");
    config_dir
}

fn save_vault_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    let config_path = get_config_path(app);
    let config = Config {
        vault_path: Some(path.to_string_lossy().to_string()),
    };
    let content = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    fs::write(config_path, content).map_err(|err| err.to_string())
}

fn get_saved_vault_path(app: &AppHandle) -> Option<PathBuf> {
    let config_path = get_config_path(app);
    let content = fs::read_to_string(config_path).ok()?;
    let config = serde_json::from_str::<Config>(&content).ok()?;
    let path = PathBuf::from(config.vault_path?);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn default_vault_path(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("inkfellow_notes")
}

fn ensure_vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = get_saved_vault_path(app) {
        fs::create_dir_all(&path).map_err(|err| err.to_string())?;
        return Ok(path);
    }

    let path = default_vault_path(app);
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    save_vault_path(app, &path)?;
    Ok(path)
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = ensure_vault_path(app)?;
    fs::canonicalize(configured).map_err(|_| "Vault path is unavailable.".to_string())
}

fn assert_inside_vault(path: &Path, root: &Path) -> Result<(), String> {
    if path == root || path.starts_with(root) {
        Ok(())
    } else {
        Err("Path traversal is not allowed.".to_string())
    }
}

fn resolve_existing_path(
    app: &AppHandle,
    relative_path: &str,
    allow_empty: bool,
) -> Result<ResolvedPath, String> {
    let root = vault_root(app)?;
    let relative = normalize_relative_path(relative_path, allow_empty)?;
    let candidate = if relative.is_empty() {
        root.clone()
    } else {
        root.join(relative_to_path_buf(&relative))
    };

    let canonical = fs::canonicalize(&candidate).map_err(|_| "File not found.".to_string())?;
    assert_inside_vault(&canonical, &root)?;

    let real_relative = canonical
        .strip_prefix(&root)
        .map(to_slash_path)
        .unwrap_or_else(|_| String::new());
    if has_excluded_segment(&real_relative) {
        return Err("This path is excluded.".to_string());
    }

    Ok(ResolvedPath {
        absolute: canonical,
        relative: real_relative,
    })
}

fn resolve_new_path(app: &AppHandle, relative_path: &str) -> Result<ResolvedPath, String> {
    let root = vault_root(app)?;
    let relative = normalize_relative_path(relative_path, false)?;
    let path = root.join(relative_to_path_buf(&relative));
    assert_inside_vault(&path, &root)?;

    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path.".to_string())?
        .to_path_buf();
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| "Parent folder not found.".to_string())?;
    assert_inside_vault(&canonical_parent, &root)?;

    Ok(ResolvedPath {
        absolute: path,
        relative,
    })
}

fn node_name_for_directory(root: &Path, absolute: &Path, relative_path: &str) -> String {
    if relative_path.is_empty() {
        return root
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("Vault")
            .to_string();
    }
    absolute
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("Folder")
        .to_string()
}

fn node_sort(left: &NoteTreeNode, right: &NoteTreeNode) -> Ordering {
    let left_is_file = matches!(left, NoteTreeNode::File { .. });
    let right_is_file = matches!(right, NoteTreeNode::File { .. });
    if left_is_file != right_is_file {
        return if left_is_file {
            Ordering::Greater
        } else {
            Ordering::Less
        };
    }

    let left_name = match left {
        NoteTreeNode::Directory { name, .. } => name,
        NoteTreeNode::File { name, .. } => name,
    };
    let right_name = match right {
        NoteTreeNode::Directory { name, .. } => name,
        NoteTreeNode::File { name, .. } => name,
    };
    left_name.to_lowercase().cmp(&right_name.to_lowercase())
}

fn walk_directory(
    root: &Path,
    absolute: &Path,
    relative_path: &str,
) -> Result<NoteTreeNode, String> {
    let mut children = Vec::new();
    let entries = fs::read_dir(absolute).map_err(|err| err.to_string())?;

    for entry_result in entries {
        let entry = entry_result.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        if has_excluded_segment(&child_relative) {
            continue;
        }

        let child_absolute = entry.path();
        if file_type.is_dir() {
            children.push(walk_directory(root, &child_absolute, &child_relative)?);
            continue;
        }

        if !file_type.is_file() || !is_note_file(&child_absolute) {
            continue;
        }

        let metadata = fs::metadata(&child_absolute).map_err(|err| err.to_string())?;
        children.push(NoteTreeNode::File {
            name,
            path: child_relative,
            size: metadata.len(),
            updated_at: metadata.modified().map(unix_secs).unwrap_or(0),
            extension: path_extension(&child_absolute),
        });
    }

    children.sort_by(node_sort);

    Ok(NoteTreeNode::Directory {
        name: node_name_for_directory(root, absolute, relative_path),
        path: relative_path.to_string(),
        children,
    })
}

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

fn get_free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .ok()
}

fn workspace_root() -> PathBuf {
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if current_dir.ends_with("src-tauri") {
        current_dir.parent().unwrap_or(&current_dir).to_path_buf()
    } else {
        current_dir
    }
}

fn get_node_path(app: &AppHandle) -> PathBuf {
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("bin").join("node.exe");
        if bundled.exists() {
            return bundled;
        }
    }

    let root = workspace_root();
    let installed_bundled = root.join("bin").join("node.exe");
    if installed_bundled.exists() {
        return installed_bundled;
    }

    let local_bundled = root.join("src-tauri").join("bin").join("node.exe");
    if local_bundled.exists() {
        return local_bundled;
    }

    PathBuf::from("node")
}

fn find_chat_dir(app: &AppHandle) -> PathBuf {
    let root = workspace_root();
    let mut candidates = vec![
        root.join("_up_").join("desktop-bundle").join("claude-chat"),
        root.join("claude-chat"),
        root.join("desktop-bundle").join("claude-chat"),
    ];

    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(
            res_dir
                .join("_up_")
                .join("desktop-bundle")
                .join("claude-chat"),
        );
        candidates.push(res_dir.join("desktop-bundle").join("claude-chat"));
        candidates.push(res_dir.join("_up_").join("claude-chat"));
        candidates.push(res_dir.join("claude-chat"));
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.join("server.js").exists())
        .unwrap_or_else(|| root.join("claude-chat"))
}

fn kill_processes(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut processes = state.processes.lock().unwrap();
        for mut child in processes.drain(..) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_agent(app: &AppHandle) {
    let state = app.state::<AppState>();
    let claude_port = state.claude_port;
    let vault = match ensure_vault_path(app) {
        Ok(path) => path,
        Err(err) => {
            eprintln!("[inkfellow] Cannot resolve vault path: {err}");
            return;
        }
    };

    let node_path = get_node_path(app);
    let chat_dir = find_chat_dir(app);
    let server_js = chat_dir.join("server.js");
    if !server_js.exists() {
        eprintln!("[inkfellow] claude-chat server not found at {server_js:?}");
        return;
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| workspace_root().join(".desktop-data"))
        .join("claude-chat");
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| workspace_root().join(".desktop-config"));
    let _ = fs::create_dir_all(&data_dir);
    let _ = fs::create_dir_all(&config_dir);
    let auth_profile_file = config_dir.join("claude-chat-auth-profile.json");

    let mut command = Command::new(&node_path);
    command
        .arg(&server_js)
        .current_dir(&chat_dir)
        .env("PORT", claude_port.to_string())
        .env("HOST", "127.0.0.1")
        .env("VAULT_PATH", &vault)
        .env("DESKTOP_MODE", "true")
        .env("CLAUDE_PERMISSION_MODE", "auto")
        .env("CLAUDE_CHAT_DATA_DIR", &data_dir)
        .env("CLAUDE_CHAT_AUTH_PROFILE_FILE", &auth_profile_file);
    hide_command_window(&mut command);

    match command.spawn() {
        Ok(child) => {
            eprintln!(
                "[inkfellow] claude-chat sidecar spawned on 127.0.0.1:{claude_port}, PID {}",
                child.id()
            );
            let mut processes = state.processes.lock().unwrap();
            processes.push(child);
        }
        Err(err) => eprintln!("[inkfellow] Failed to spawn claude-chat: {err:?}"),
    }
}

fn restart_agent(app: &AppHandle) {
    kill_processes(app);
    spawn_agent(app);
}

fn agent_ready(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn ensure_git_repo(path: &Path) {
    if path.join(".git").exists() {
        return;
    }
    let mut command = Command::new("git");
    command.arg("-C").arg(path).arg("init");
    hide_command_window(&mut command);
    let _ = command.output();
}

fn run_git(path: &Path, args: &[&str]) -> Result<GitOutput, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(path);
    for arg in args {
        command.arg(arg);
    }
    hide_command_window(&mut command);
    let output = command.output().map_err(|err| err.to_string())?;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code(),
    })
}

fn parse_branch_status(first_line: &str) -> (Option<String>, u32, u32) {
    let clean = first_line.trim_start_matches("## ").trim();
    if clean.is_empty() {
        return (None, 0, 0);
    }

    let branch = clean
        .split("...")
        .next()
        .unwrap_or(clean)
        .split(' ')
        .next()
        .map(|value| value.to_string());

    let ahead = clean
        .split("ahead ")
        .nth(1)
        .and_then(|rest| rest.split(|ch| ch == ',' || ch == ']').next())
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0);

    let behind = clean
        .split("behind ")
        .nth(1)
        .and_then(|rest| rest.split(|ch| ch == ',' || ch == ']').next())
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0);

    (branch, ahead, behind)
}

fn git_name_from_path(path: &str) -> String {
    path.split('/').next_back().unwrap_or(path).to_string()
}

fn git_file_kind(root: &Path, relative_path: &str) -> String {
    let path = root.join(relative_to_path_buf(relative_path));
    if path.is_dir() {
        "folder".to_string()
    } else {
        "file".to_string()
    }
}

fn parse_git_status_entries(root: &Path, entries: &[String]) -> Vec<GitFileStatus> {
    entries
        .iter()
        .filter_map(|entry| {
            if entry.len() < 3 {
                return None;
            }
            let code = entry.get(0..2).unwrap_or("").trim();
            let raw_path = entry.get(3..).unwrap_or("").trim();
            if raw_path.is_empty() {
                return None;
            }

            let (state, path) = if raw_path.contains(" -> ") {
                ("renamed", raw_path.split(" -> ").last().unwrap_or(raw_path))
            } else if code == "??" || code.contains('A') {
                ("added", raw_path)
            } else if code.contains('D') {
                ("deleted", raw_path)
            } else {
                ("modified", raw_path)
            };

            let path = path.replace('\\', "/");
            Some(GitFileStatus {
                name: git_name_from_path(&path),
                kind: git_file_kind(root, &path),
                path,
                state: state.to_string(),
            })
        })
        .collect()
}

fn git_last_sync(path: &Path) -> Option<String> {
    let output = run_git(path, &["log", "-1", "--format=%cI"]).ok()?;
    if !output.success {
        return None;
    }
    let value = output.stdout.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_git_diff(path: &str, raw: &str) -> GitFileDiff {
    let binary = raw.lines().any(|line| line.starts_with("Binary files "));
    let mut lines = Vec::new();
    let mut add_count = 0;
    let mut remove_count = 0;

    for line in raw.lines() {
        if line.starts_with("diff --git ")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
        {
            continue;
        }

        let line_type = if line.starts_with("@@") {
            "hunk"
        } else if line.starts_with('+') {
            add_count += 1;
            "add"
        } else if line.starts_with('-') {
            remove_count += 1;
            "remove"
        } else {
            "context"
        };

        let content = if line_type == "add" || line_type == "remove" {
            line.chars().skip(1).collect::<String>()
        } else {
            line.to_string()
        };

        lines.push(GitDiffLine {
            line_type: line_type.to_string(),
            content,
        });
    }

    GitFileDiff {
        path: path.to_string(),
        binary,
        lines,
        add_count,
        remove_count,
    }
}

#[tauri::command]
fn get_desktop_state(app: AppHandle) -> Result<DesktopState, String> {
    let vault = ensure_vault_path(&app)?;
    let state = app.state::<AppState>();
    let port = state.claude_port;
    Ok(DesktopState {
        vault_path: vault.to_string_lossy().to_string(),
        agent_url: format!("http://127.0.0.1:{port}"),
        agent_port: port,
        agent_ready: agent_ready(port),
    })
}

#[tauri::command]
fn agent_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    Ok(agent_ready(state.claude_port))
}

#[tauri::command]
fn select_and_set_vault(app: AppHandle) -> Result<DesktopState, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Select notes vault")
        .pick_folder()
    else {
        return Err("User cancelled selection.".to_string());
    };

    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    save_vault_path(&app, &path)?;
    ensure_git_repo(&path);
    restart_agent(&app);
    get_desktop_state(app)
}

#[tauri::command]
fn set_vault_path(app: AppHandle, path: String) -> Result<DesktopState, String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.exists() {
        return Err("Path does not exist.".to_string());
    }
    if !path_buf.is_dir() {
        return Err("Path is not a folder.".to_string());
    }
    save_vault_path(&app, &path_buf)?;
    ensure_git_repo(&path_buf);
    restart_agent(&app);
    get_desktop_state(app)
}

#[tauri::command]
fn list_notes_tree(app: AppHandle) -> Result<TreeResponse, String> {
    let root = vault_root(&app)?;
    Ok(TreeResponse {
        root: walk_directory(&root, &root, "")?,
        generated_at: now_secs(),
    })
}

#[tauri::command]
fn read_note(app: AppHandle, path: String) -> Result<NoteResponse, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    if !is_text_note(&resolved.absolute) {
        return Err("Only Markdown and HTML files can be read as text.".to_string());
    }

    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    let content = fs::read_to_string(&resolved.absolute).map_err(|err| err.to_string())?;
    Ok(NoteResponse {
        name: resolved
            .absolute
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("note")
            .to_string(),
        path: resolved.relative,
        content,
        size: metadata.len(),
        updated_at: metadata.modified().map(unix_secs).unwrap_or(0),
        extension: path_extension(&resolved.absolute),
    })
}

#[tauri::command]
fn read_asset(app: AppHandle, path: String) -> Result<AssetResponse, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    if !is_image_note(&resolved.absolute) {
        return Err("Only image files can be previewed.".to_string());
    }

    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    let bytes = fs::read(&resolved.absolute).map_err(|err| err.to_string())?;
    let extension = path_extension(&resolved.absolute);
    let mime = mime_for_extension(&extension).to_string();
    let data_url = format!(
        "data:{mime};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    );

    Ok(AssetResponse {
        name: resolved
            .absolute
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("image")
            .to_string(),
        path: resolved.relative,
        data_url,
        mime,
        size: metadata.len(),
        updated_at: metadata.modified().map(unix_secs).unwrap_or(0),
        extension,
    })
}

#[tauri::command]
fn write_note(app: AppHandle, path: String, content: String) -> Result<NoteResponse, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    if !is_text_note(&resolved.absolute) {
        return Err("Only Markdown and HTML files can be edited.".to_string());
    }

    fs::write(&resolved.absolute, content.as_bytes()).map_err(|err| err.to_string())?;
    read_note(app, resolved.relative)
}

#[tauri::command]
fn create_note(app: AppHandle, folder: String, title: String) -> Result<NoteResponse, String> {
    let clean_folder = normalize_relative_path(&folder, true)?;
    let mut clean_name = sanitize_name_segment(&title)?;
    if path_extension(Path::new(&clean_name)).is_empty() {
        clean_name.push_str(".md");
    }

    if !is_text_note(Path::new(&clean_name)) {
        return Err("Only Markdown and HTML notes can be created.".to_string());
    }

    let relative = if clean_folder.is_empty() {
        clean_name.clone()
    } else {
        format!("{clean_folder}/{clean_name}")
    };
    let resolved = resolve_new_path(&app, &relative)?;
    if resolved.absolute.exists() {
        return Err("A note with this name already exists.".to_string());
    }

    let title_without_ext = Path::new(&clean_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("Untitled");
    let initial = if path_extension(Path::new(&clean_name)) == "md" {
        format!("# {title_without_ext}\n\n")
    } else {
        String::new()
    };

    fs::write(&resolved.absolute, initial.as_bytes()).map_err(|err| err.to_string())?;
    read_note(app, resolved.relative)
}

#[tauri::command]
fn create_folder(app: AppHandle, parent: String, name: String) -> Result<(), String> {
    let clean_parent = normalize_relative_path(&parent, true)?;
    let clean_name = sanitize_name_segment(&name)?;
    let relative = if clean_parent.is_empty() {
        clean_name
    } else {
        format!("{clean_parent}/{clean_name}")
    };
    let resolved = resolve_new_path(&app, &relative)?;
    if resolved.absolute.exists() {
        return Err("A folder with this name already exists.".to_string());
    }
    fs::create_dir_all(&resolved.absolute).map_err(|err| err.to_string())?;
    let keep_file = resolved.absolute.join(".gitkeep");
    let _ = fs::write(keep_file, b"");
    Ok(())
}

#[tauri::command]
fn rename_entry(app: AppHandle, path: String, name: String) -> Result<String, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    let clean_name = sanitize_name_segment(&name)?;
    if metadata.is_file() && !is_note_file(Path::new(&clean_name)) {
        return Err("Only supported note files can be renamed.".to_string());
    }
    if metadata.is_dir() && resolved.relative.is_empty() {
        return Err("The root folder cannot be renamed.".to_string());
    }

    let parent = resolved
        .absolute
        .parent()
        .ok_or_else(|| "Invalid path.".to_string())?;
    let target = parent.join(&clean_name);
    if target.exists() {
        return Err("A file or folder with this name already exists.".to_string());
    }
    fs::rename(&resolved.absolute, &target).map_err(|err| err.to_string())?;

    let root = vault_root(&app)?;
    let relative = target
        .strip_prefix(root)
        .map(to_slash_path)
        .map_err(|err| err.to_string())?;
    Ok(relative)
}

#[tauri::command]
fn delete_entry(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        if resolved.relative.is_empty() {
            return Err("The root folder cannot be deleted.".to_string());
        }
        fs::remove_dir_all(&resolved.absolute).map_err(|err| err.to_string())?;
    } else if metadata.is_file() {
        fs::remove_file(&resolved.absolute).map_err(|err| err.to_string())?;
    } else {
        return Err("Only files and folders can be deleted.".to_string());
    }
    Ok(())
}

#[tauri::command]
fn search_notes(app: AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(Vec::new());
    }

    let root = vault_root(&app)?;
    let mut hits = Vec::new();
    search_walk(&root, &root, "", &needle, &mut hits)?;
    Ok(hits)
}

fn search_walk(
    root: &Path,
    absolute: &Path,
    relative_path: &str,
    needle: &str,
    hits: &mut Vec<SearchHit>,
) -> Result<(), String> {
    if hits.len() >= 80 {
        return Ok(());
    }

    for entry_result in fs::read_dir(absolute).map_err(|err| err.to_string())? {
        let entry = entry_result.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        if has_excluded_segment(&child_relative) {
            continue;
        }

        let path = entry.path();
        if file_type.is_dir() {
            search_walk(root, &path, &child_relative, needle, hits)?;
            continue;
        }
        if !file_type.is_file() || !is_text_note(&path) {
            continue;
        }

        let name_hit = name.to_lowercase().contains(needle);
        let content = fs::read_to_string(&path).unwrap_or_default();
        let content_lower = content.to_lowercase();
        if !name_hit && !content_lower.contains(needle) {
            continue;
        }

        let snippet = content
            .lines()
            .find(|line| line.to_lowercase().contains(needle))
            .unwrap_or("")
            .trim()
            .chars()
            .take(180)
            .collect::<String>();
        let rel = path
            .strip_prefix(root)
            .map(to_slash_path)
            .unwrap_or(child_relative);
        hits.push(SearchHit {
            path: rel,
            name,
            snippet,
        });
    }
    Ok(())
}

#[tauri::command]
fn git_status(app: AppHandle) -> Result<GitStatus, String> {
    let path = ensure_vault_path(&app)?;
    let initialized = path.join(".git").exists();
    if !initialized {
        return Ok(GitStatus {
            initialized: false,
            clean: true,
            branch: None,
            ahead: 0,
            behind: 0,
            entries: Vec::new(),
            files: Vec::new(),
            last_sync: None,
            raw: "Git repository is not initialized.".to_string(),
        });
    }

    let output = run_git(&path, &["status", "--porcelain=v1", "-b"])?;
    let raw = if output.stdout.trim().is_empty() {
        output.stderr.clone()
    } else {
        output.stdout.clone()
    };
    let mut lines = raw.lines();
    let first = lines.next().unwrap_or("");
    let (branch, ahead, behind) = parse_branch_status(first);
    let entries = lines.map(|line| line.to_string()).collect::<Vec<_>>();
    let files = parse_git_status_entries(&path, &entries);
    Ok(GitStatus {
        initialized: true,
        clean: files.is_empty() && ahead == 0 && behind == 0,
        branch,
        ahead,
        behind,
        entries,
        files,
        last_sync: git_last_sync(&path),
        raw,
    })
}

#[tauri::command]
fn git_init(app: AppHandle) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    run_git(&path, &["init"])
}

#[tauri::command]
fn git_pull(app: AppHandle) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    run_git(&path, &["pull", "--rebase", "--autostash"])
}

#[tauri::command]
fn git_push(app: AppHandle) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    run_git(&path, &["push"])
}

#[tauri::command]
fn git_commit(app: AppHandle, message: String) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    let add = run_git(&path, &["add", "-A"])?;
    if !add.success {
        return Ok(add);
    }

    let mut diff = Command::new("git");
    diff.arg("-C")
        .arg(&path)
        .arg("diff")
        .arg("--cached")
        .arg("--quiet");
    hide_command_window(&mut diff);
    let diff_status = diff.status().map_err(|err| err.to_string())?;
    if diff_status.success() {
        return Ok(GitOutput {
            success: true,
            stdout: "No staged changes to commit.".to_string(),
            stderr: String::new(),
            code: Some(0),
        });
    }

    let clean_message = if message.trim().is_empty() {
        "Update notes".to_string()
    } else {
        message.trim().to_string()
    };
    run_git(
        &path,
        &[
            "-c",
            "user.name=Inkfellow Desktop",
            "-c",
            "user.email=desktop@inkfellow.local",
            "commit",
            "-m",
            &clean_message,
        ],
    )
}

#[tauri::command]
fn git_commit_and_push(app: AppHandle, message: String) -> Result<Vec<GitOutput>, String> {
    let commit = git_commit(app.clone(), message)?;
    if !commit.success {
        return Ok(vec![commit]);
    }
    let push = git_push(app)?;
    Ok(vec![commit, push])
}

#[tauri::command]
fn git_history(app: AppHandle) -> Result<Vec<GitCommitRecord>, String> {
    let path = ensure_vault_path(&app)?;
    if !path.join(".git").exists() {
        return Ok(Vec::new());
    }

    let output = run_git(
        &path,
        &[
            "log",
            "-30",
            "--pretty=format:%h%x1f%s%x1f%an%x1f%ad",
            "--date=format-local:%Y-%m-%d %H:%M",
        ],
    )?;
    if !output.success {
        return Err(if output.stderr.trim().is_empty() {
            "Failed to load git history.".to_string()
        } else {
            output.stderr
        });
    }

    Ok(output
        .stdout
        .lines()
        .filter_map(|line| {
            let parts = line.split('\x1f').collect::<Vec<_>>();
            if parts.len() < 4 {
                return None;
            }
            Some(GitCommitRecord {
                hash: parts[0].to_string(),
                message: parts[1].to_string(),
                author: parts[2].to_string(),
                date: parts[3].to_string(),
            })
        })
        .collect())
}

#[tauri::command]
fn git_diff(app: AppHandle, path: String) -> Result<GitFileDiff, String> {
    let root = ensure_vault_path(&app)?;
    let relative = normalize_relative_path(&path, false)?;

    let status = run_git(&root, &["status", "--porcelain=v1", "--", &relative])?;
    let is_untracked = status.stdout.lines().any(|line| line.starts_with("??"));
    if is_untracked {
        let absolute = root.join(relative_to_path_buf(&relative));
        assert_inside_vault(
            &absolute,
            &fs::canonicalize(&root).map_err(|err| err.to_string())?,
        )?;
        let content = fs::read_to_string(&absolute).unwrap_or_default();
        let raw = content
            .lines()
            .map(|line| format!("+{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(parse_git_diff(&relative, &raw));
    }

    let output = run_git(&root, &["diff", "--", &relative])?;
    if !output.success {
        return Err(if output.stderr.trim().is_empty() {
            "Failed to load diff.".to_string()
        } else {
            output.stderr
        });
    }
    Ok(parse_git_diff(&relative, &output.stdout))
}

#[tauri::command]
fn git_discard(app: AppHandle, path: String) -> Result<(), String> {
    let root = ensure_vault_path(&app)?;
    let relative = normalize_relative_path(&path, false)?;

    let status = run_git(&root, &["status", "--porcelain=v1", "--", &relative])?;
    let is_untracked = status.stdout.lines().any(|line| line.starts_with("??"));

    if is_untracked {
        let root_canonical = fs::canonicalize(&root).map_err(|err| err.to_string())?;
        let target = root.join(relative_to_path_buf(&relative));
        let canonical = if target.exists() {
            fs::canonicalize(&target).map_err(|err| err.to_string())?
        } else {
            target.clone()
        };
        assert_inside_vault(&canonical, &root_canonical)?;
        if target.is_dir() {
            fs::remove_dir_all(&target).map_err(|err| err.to_string())?;
        } else if target.exists() {
            fs::remove_file(&target).map_err(|err| err.to_string())?;
        }
        return Ok(());
    }

    let restore = run_git(
        &root,
        &["restore", "--staged", "--worktree", "--", &relative],
    )?;
    if restore.success {
        return Ok(());
    }

    let checkout = run_git(&root, &["checkout", "--", &relative])?;
    if checkout.success {
        Ok(())
    } else {
        Err(if checkout.stderr.trim().is_empty() {
            restore.stderr
        } else {
            checkout.stderr
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let claude_port = get_free_port().unwrap_or(8089);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState {
            processes: Mutex::new(Vec::new()),
            claude_port,
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_state,
            agent_status,
            select_and_set_vault,
            set_vault_path,
            list_notes_tree,
            read_note,
            read_asset,
            write_note,
            create_note,
            create_folder,
            rename_entry,
            delete_entry,
            search_notes,
            git_status,
            git_init,
            git_pull,
            git_push,
            git_commit,
            git_commit_and_push,
            git_history,
            git_diff,
            git_discard
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(vault) = ensure_vault_path(&handle) {
                ensure_git_repo(&vault);
            }
            spawn_agent(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            kill_processes(app_handle);
        }
    });
}
