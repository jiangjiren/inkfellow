use super::*;
use crate::video_workbench_logic as logic;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::process::{ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU32},
    Arc, OnceLock,
};

fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn thumbs_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}
struct Job {
    project: String,
    kind: String,
    beat: Option<String>,
    pid: AtomicU32,
    cancelled: AtomicBool,
}

fn project(app: &AppHandle, path: &str) -> Result<ResolvedPath, String> {
    let resolved = resolve_existing_path(app, path, false)?;
    if !resolved.absolute.is_dir() || !resolved.absolute.join("edl.json").is_file() {
        return Err("Video project not found.".into());
    }
    Ok(resolved)
}
fn modified(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(unix_secs)
        .unwrap_or(0)
}
fn read_json(path: &Path) -> Option<Value> {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}
fn abs(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let vault = vault_root(app)?;
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    vault.hash(&mut hash);
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("video-workbench")
        .join(format!("{:016x}", hash.finish()));
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&base, true)
        .map_err(|e| e.to_string())?;
    Ok(base)
}
pub(super) fn allow_cache(app: &AppHandle) {
    if let Err(e) = cache_root(app) {
        eprintln!("[video-workbench] cache scope: {e}");
    }
}
fn project_cache(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    let path = cache_root(app)?.join(relative_to_path_buf(relative));
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn allow_media(app: &AppHandle, path: &Path) {
    static ALLOWED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    if !logic::is_media_extension(&path_extension(path)) {
        return;
    }
    let allowed = ALLOWED.get_or_init(|| Mutex::new(HashSet::new()));
    if allowed.lock().unwrap().contains(path) {
        return;
    }
    if let Ok(p) = fs::canonicalize(path) {
        if p.is_file() && app.asset_protocol_scope().allow_file(&p).is_ok() {
            allowed.lock().unwrap().insert(path.to_path_buf());
        }
    }
}
fn media_paths(value: &Value, output: &mut HashSet<PathBuf>) {
    match value {
        Value::Object(map) => {
            for key in ["path", "src", "video", "thumb", "audio"] {
                if let Some(s) = map.get(key).and_then(Value::as_str) {
                    let p = PathBuf::from(s);
                    if p.is_absolute() && logic::is_media_extension(&path_extension(&p)) {
                        output.insert(p);
                    }
                }
            }
            for v in map.values() {
                media_paths(v, output);
            }
        }
        Value::Array(items) => {
            for v in items {
                media_paths(v, output);
            }
        }
        _ => {}
    }
}
fn allow_project_media(app: &AppHandle, project_dir: &Path, paths: HashSet<PathBuf>) {
    let mut remote = VecDeque::new();
    for path in paths {
        if path.starts_with(project_dir) {
            allow_media(app, &path);
        } else {
            remote.push_back(path);
        }
    }
    let queue = Arc::new(Mutex::new(remote));
    let count = queue.lock().unwrap().len();
    let (tx, rx) = mpsc::channel();
    for _ in 0..count.min(8) {
        let queue = queue.clone();
        let tx = tx.clone();
        let app = app.clone();
        std::thread::spawn(move || loop {
            let path = queue.lock().unwrap().pop_front();
            let Some(path) = path else { break };
            allow_media(&app, &path);
            if tx.send(()).is_err() {
                break;
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + Duration::from_secs(2);
    for _ in 0..count {
        if rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            break;
        }
    }
}
fn plan_for(dir: &Path, version: Option<&str>) -> (Option<Value>, &'static str) {
    let snapshot = version.map(|v| {
        dir.join("work/versions")
            .join(format!("{}.plan.json", v.trim_end_matches(".mp4")))
    });
    let snap = snapshot.as_deref().and_then(read_json);
    if snap.is_some() {
        return (snap, "snapshot");
    }
    let latest = read_json(&dir.join("work/plan.json"));
    let source = logic::plan_choice(false, latest.is_some());
    (latest, source)
}
fn versions(dir: &Path, base: &str) -> Vec<Value> {
    let mut names = Vec::new();
    let mut paths = HashMap::new();
    if let Ok(entries) = fs::read_dir(dir.join("out")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(v) = logic::classify_version(&name, base) {
                paths.insert(name.clone(), path);
                names.push(v);
            }
        }
    }
    logic::sort_versions(&mut names);
    names.into_iter().filter_map(|v| {let p=paths.get(&v.name)?;let m=fs::metadata(p).ok()?;
        Some(json!({"name":v.name,"abs":abs(p),"n":v.n,"kind":v.kind,"size":m.len(),"mtime":modified(p),"hasPlan":dir.join("work/versions").join(format!("{}.plan.json",p.file_stem()?.to_string_lossy())).is_file()}))
    }).collect()
}
fn latest_version(vs: &[Value], base: &str) -> Option<String> {
    let names: Vec<_> = vs
        .iter()
        .filter_map(|v| v["name"].as_str())
        .filter_map(|name| logic::classify_version(name, base))
        .collect();
    let mtime_of = |name: &str| {
        vs.iter()
            .find(|v| v["name"].as_str() == Some(name))
            .and_then(|v| v["mtime"].as_u64())
            .unwrap_or(0)
    };
    let chosen = logic::latest(&names).map(str::to_owned);
    if let Some(name) = &chosen {
        // AI 正在迭代时预览比正式版新，这时最新的画面、时间表都在预览上
        if let Some(preview) = names.iter().find(|v| v.kind == "preview") {
            if mtime_of(&preview.name) > mtime_of(name) {
                return Some(preview.name.clone());
            }
        }
        return chosen;
    }
    // 没有规范命名的成片时（比如 xxx_v1.2.mp4）取最新的文件，不能显示成「还没出片」
    names
        .iter()
        .max_by_key(|v| mtime_of(&v.name))
        .map(|v| v.name.clone())
}

fn plan_duration(path: &Path) -> Option<f64> {
    read_json(path)?["duration"].as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

fn latest_duration(dir: &Path, latest: Option<&str>) -> Option<f64> {
    let name = latest?;
    let video = dir.join("out").join(name);
    if !video.is_file() { return None; }
    if let Some(last) = read_json(&dir.join("work/last_render.json")) {
        if let Some(recorded) = last["video"].as_str() {
            let recorded = PathBuf::from(recorded);
            let recorded = if recorded.is_absolute() { recorded }
                else if recorded.components().count() == 1 { dir.join("out").join(recorded) }
                else { dir.join(recorded) };
            if fs::canonicalize(&recorded).ok() == fs::canonicalize(&video).ok() {
                if let Some(duration) = last["duration"].as_f64().filter(|n| n.is_finite() && *n >= 0.0) {
                    return Some(duration);
                }
            }
        }
    }
    let stem = Path::new(name).file_stem()?.to_str()?;
    plan_duration(&dir.join("work/versions").join(format!("{stem}.plan.json")))
        .or_else(|| plan_duration(&dir.join("work/plan.json")))
}

fn latest_cover(dir: &Path) -> Option<String> {
    fs::read_dir(dir.join("out")).ok()?.flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            ((name.contains("封面") || name.contains("cover") || name.contains("thumbnail"))
                && matches!(path_extension(&path).as_str(), "jpg" | "jpeg" | "png" | "webp")
                && path.is_file()).then(|| (modified(&path), path))
        })
        .max_by_key(|(mtime, _)| *mtime)
        .map(|(_, path)| abs(&path))
}
fn pid_alive(pid: u64) -> bool {
    if pid == 0 || pid > u32::MAX as u64 {
        return false;
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("tasklist");
        c.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
        hide_command_window(&mut c);
        c.output()
            .map(|o| {
                o.status.success()
                    && String::from_utf8_lossy(&o.stdout).lines().any(|line| {
                        line.split_whitespace()
                            .any(|word| word.replace(',', "") == pid.to_string())
                    })
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn running(events: &[Value]) -> Option<Value> {
    let pending = logic::unfinished_run(events)?;
    let pid = pending.get("pid")?.as_u64()?;
    if !pid_alive(pid) {
        return None;
    }
    let run = pending.get("run").and_then(Value::as_str).unwrap_or("");
    let start = events.iter().find(|e| {
        e.get("run").and_then(Value::as_str) == Some(run)
            && e.get("stage").and_then(Value::as_str) == Some("run")
            && e.get("status").and_then(Value::as_str) == Some("start")
    });
    Some(
        json!({"pid":pid,"cmd":pending.get("cmd"),"stage":pending.get("stage"),"done":pending.get("done"),"total":pending.get("total"),"preview":pending.get("preview"),"startedAt":start.and_then(|e|e.get("ts"))}),
    )
}
fn missing_sources(edl: &Value, plan: Option<&Value>) -> Vec<String> {
    let mut candidates = HashSet::new();
    let mut add = |shots: &Value, key: &str| {
        if let Some(shots) = shots.as_array() {
            for shot in shots {
                if let Some(s) = shot.get(key).and_then(Value::as_str) {
                    let p = PathBuf::from(s);
                    if p.is_absolute() {
                        candidates.insert(s.to_owned());
                    }
                }
            }
        }
    };
    if let Some(shots) = plan.and_then(|p| p.get("shots")) {
        add(shots, "path");
    } else {
        if let Some(shots) = edl.get("shots") {
            add(shots, "src");
        }
        if let Some(beats) = edl.get("beats").and_then(Value::as_array) {
            for beat in beats {
                if let Some(shots) = beat.get("shots") {
                    add(shots, "src");
                }
            }
        }
    }
    let queue = Arc::new(Mutex::new(candidates.into_iter().collect::<VecDeque<_>>()));
    let count = queue.lock().unwrap().len();
    let (tx, rx) = mpsc::channel();
    for _ in 0..count.min(8) {
        let tx = tx.clone();
        let queue = queue.clone();
        std::thread::spawn(move || loop {
            let item = queue.lock().unwrap().pop_front();
            let Some(path) = item else { break };
            let missing = !Path::new(&path).exists();
            if tx.send((path, missing)).is_err() {
                break;
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut result = Vec::new();
    for _ in 0..count {
        let left = deadline.saturating_duration_since(Instant::now());
        if let Ok((path, missing)) = rx.recv_timeout(left) {
            if missing {
                result.push(path);
            }
        } else {
            // 没查完不等于找不到（机械盘唤醒要几秒），不能报成缺失，下次刷新再查
            break;
        }
    }
    result.sort();
    result
}
fn read_project_sync(app: &AppHandle, path: &str) -> Result<Value, String> {
    let p = project(app, path)?;
    let dir = &p.absolute;
    let edl = read_json(&dir.join("edl.json")).ok_or("Invalid edl.json")?;
    let base = logic::sanitize_base(
        edl.get("project")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dir.file_name().and_then(OsStr::to_str).unwrap_or("video")),
    );
    let base = base.as_str();
    let vs = versions(dir, base);
    let latest = latest_version(&vs, base);
    let (plan, source) = plan_for(dir, latest.as_deref());
    let edits = read_json(&dir.join("edits.json"));
    let status = read_json(&dir.join("work/edits_status.json"));
    let journal = fs::read_to_string(dir.join("work/journal.jsonl"))
        .ok()
        .map(|s| logic::journal_tail(&s, 200))
        .unwrap_or_default();
    let mut covers = Vec::new();
    if let Ok(entries) = fs::read_dir(dir.join("out")) {
        for e in entries.flatten() {
            let file = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            let lower = file.to_lowercase();
            if (file.contains("封面") || lower.contains("cover") || lower.contains("thumbnail"))
                && matches!(
                    path_extension(&path).as_str(),
                    "jpg" | "jpeg" | "png" | "webp"
                )
            {
                if let Ok(m) = e.metadata() {
                    covers.push(json!({"name":file,"abs":abs(&path),"mtime":modified(&path),"size":m.len()}));
                    allow_media(app, &path);
                }
            }
        }
    }
    let mut media = HashSet::new();
    media_paths(&edl, &mut media);
    if let Some(ref plan) = plan {
        media_paths(plan, &mut media);
    }
    // 人工换上的素材可能在别的文件夹，重启后预览也要能读到
    if let Some(ref edits) = edits {
        media_paths(edits, &mut media);
    }
    allow_project_media(app, dir, media);
    for v in &vs {
        if let Some(s) = v["abs"].as_str() {
            allow_media(app, Path::new(s));
        }
    }
    let find_doc = |predicate: &dyn Fn(&str) -> bool| -> Option<String> {
        fs::read_dir(dir).ok()?.flatten().find_map(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            predicate(&n).then(|| format!("{}/{}", p.relative, n))
        })
    };
    let script = find_doc(&|n| n.starts_with("口播") && n.ends_with(".md"));
    let notes = find_doc(&|n| n == "制作说明.md");
    let publish = find_doc(&|n| n == "发布文案.md");
    let voice_count = fs::read_dir(dir.join("work/voice"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| matches!(path_extension(&e.path()).as_str(), "mp3" | "wav" | "m4a"))
                .count()
        })
        .unwrap_or(0);
    let facts = json!({"manifest":dir.join("manifest.json").is_file(),"script":script.is_some(),"notes":notes.is_some(),"publish":publish.is_some(),"voiceCount":voice_count,"plan":plan.is_some(),"preview":vs.iter().any(|v|v["kind"]=="preview"),"qa":dir.join("out/qa").is_dir()||dir.join("work/qa.json").exists(),"final":vs.iter().any(|v|v["kind"]=="final"),"cover":!covers.is_empty(),"buildScript":dir.join("build_edl.py").is_file()||dir.join("work/build_edl.py").is_file()});
    let missing = missing_sources(&edl, plan.as_ref());
    Ok(
        json!({"path":p.relative,"abs":abs(dir),"name":dir.file_name().and_then(OsStr::to_str).unwrap_or(""),"edl":edl,"edlMtime":modified(&dir.join("edl.json")),"edits":edits,"editsStatus":status,"versions":vs,"latest":latest,"plan":plan,"planSource":source,"journal":journal,"running":running(&journal),"facts":facts,"files":{"script":script,"publish":publish,"notes":notes},"covers":covers,"missingSources":missing}),
    )
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn video_list_projects(app: AppHandle) -> Result<Value, String> {
    blocking(move||{
    let root=vault_root(&app)?;let mut stack=vec![(root.clone(),0)];let mut projects=Vec::new();
    while let Some((dir,depth))=stack.pop(){if depth>12{continue;}if dir.join("edl.json").is_file(){
        let rel=dir.strip_prefix(&root).map(to_slash_path).unwrap_or_default();let edl=read_json(&dir.join("edl.json"));let name=dir.file_name().and_then(OsStr::to_str).unwrap_or("");let title=edl.as_ref().and_then(|v|v.get("project")).and_then(Value::as_str).filter(|s|!s.trim().is_empty()).unwrap_or(name);let base=logic::sanitize_base(title);let vs=versions(&dir,&base);let latest=latest_version(&vs,&base);
        let latest_mtime=latest.as_deref().map(|n|modified(&dir.join("out").join(n))).unwrap_or(0);
        let cover=latest_cover(&dir);if let Some(ref cover_path)=cover{allow_media(&app,Path::new(cover_path));}
        projects.push(json!({"path":rel,"name":name,"title":title,"cover":cover,"durationSec":latest_duration(&dir,latest.as_deref()),"updatedAt":modified(&dir.join("edl.json")).max(latest_mtime),"latestVideo":latest,"hasPlan":dir.join("work/plan.json").is_file() || latest.as_deref().map(|n|dir.join("work/versions").join(format!("{}.plan.json",n.trim_end_matches(".mp4"))).is_file()).unwrap_or(false)}));continue;
    }if let Ok(entries)=fs::read_dir(&dir){for e in entries.flatten(){let path=e.path();let n=e.file_name().to_string_lossy().to_ascii_lowercase();if e.file_type().map(|t|t.is_dir()&&!t.is_symlink()).unwrap_or(false)&&!EXCLUDED_DIRECTORY_NAMES.contains(&n.as_str())&&!matches!(n.as_str(),"work"|"out"|"hf"|"clips"|".hyperframes")&&fs::canonicalize(&path).map(|p|p.starts_with(&root)).unwrap_or(false){stack.push((path,depth+1));}}}}
    projects.sort_by(|a,b|b["updatedAt"].as_u64().cmp(&a["updatedAt"].as_u64()));Ok(json!({"projects":projects}))
}).await
}

#[tauri::command]
pub async fn video_read_project(app: AppHandle, path: String) -> Result<Value, String> {
    blocking(move || read_project_sync(&app, &path)).await
}
#[tauri::command]
pub async fn video_read_plan(
    app: AppHandle,
    path: String,
    version: String,
) -> Result<Value, String> {
    blocking(move || {
        let p = project(&app, &path)?;
        if !logic::valid_video_name(&version) || !p.absolute.join("out").join(&version).is_file() {
            return Err("Invalid video version.".into());
        }
        let (plan, source) = plan_for(&p.absolute, Some(&version));
        Ok(json!({"plan":plan,"planSource":source}))
    })
    .await
}

fn write_edits_file(target: &Path, edits: Value, expected_revision: u64) -> Result<Value, String> {
    static EDITS_LOCK: Mutex<()> = Mutex::new(());
    let _guard = EDITS_LOCK.lock().unwrap();
    let current = if target.exists() {
        Some(read_json(target).ok_or("Invalid edits.json")?)
    } else {
        None
    };
    let revision = current
        .as_ref()
        .and_then(|v| v.get("revision"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if revision != expected_revision {
        return Err("REVISION_CONFLICT".into());
    }
    let mut value = edits;
    if !value.is_object() {
        return Err("Invalid edits.".into());
    }
    value["version"] = json!(1);
    value["revision"] = json!(revision + 1);
    let temp = target
        .parent()
        .ok_or("Invalid edits path")?
        .join(format!(".edits.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temp,
        serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(e.to_string());
    }
    Ok(json!({"revision":revision+1}))
}
#[tauri::command]
pub async fn video_write_edits(
    app: AppHandle,
    path: String,
    edits: Value,
    expected_revision: u64,
) -> Result<Value, String> {
    blocking(move || {
        let p = project(&app, &path)?;
        write_edits_file(&p.absolute.join("edits.json"), edits, expected_revision)
    })
    .await
}

#[tauri::command]
pub async fn video_list_sources(app: AppHandle, path: String) -> Result<Value, String> {
    blocking(move||{
    let p=project(&app,&path)?;let manifest=read_json(&p.absolute.join("manifest.json"));let edl=read_json(&p.absolute.join("edl.json")).unwrap_or(Value::Null);
    let mut used:HashMap<String,Vec<String>>=HashMap::new();if let Some(beats)=edl.get("beats").and_then(Value::as_array){for (i,beat) in beats.iter().enumerate(){let id=beat.get("id").and_then(Value::as_str).map(str::to_owned).unwrap_or(format!("b{:02}",i+1));if let Some(shots)=beat.get("shots").and_then(Value::as_array){for shot in shots{if let Some(src)=shot.get("src").and_then(Value::as_str){used.entry(src.into()).or_default().push(id.clone());}}}}}
    let mut folders=Vec::new();let mut seen=HashSet::new();let mut assets=manifest.as_ref().and_then(|m|m.get("assets")).and_then(Value::as_array).cloned().unwrap_or_default();
    for asset in &mut assets{if let Some(obj)=asset.as_object_mut(){let src=obj.get("path").and_then(Value::as_str).unwrap_or("").to_owned();let id=obj.get("id").and_then(Value::as_str).unwrap_or("");obj.insert("used".into(),json!(used.get(&src).or_else(||used.get(id)).cloned().unwrap_or_default()));let source=PathBuf::from(&src);if source.is_absolute(){if let Some(parent)=source.parent(){if seen.insert(parent.to_path_buf()){let exists=parent.is_dir();folders.push(json!({"abs":abs(parent),"label":parent.file_name().and_then(OsStr::to_str).unwrap_or(""),"exists":exists}));if exists{let _=app.asset_protocol_scope().allow_directory(parent,false);}}}}}}
    {let mut media=HashSet::new();media_paths(&edl,&mut media);if let Some(plan)=read_json(&p.absolute.join("work/plan.json")){media_paths(&plan,&mut media);}for source in media {if source.starts_with(&p.absolute){continue;}if let Some(parent)=source.parent(){if seen.insert(parent.to_path_buf()){let exists=parent.is_dir();folders.push(json!({"abs":abs(parent),"label":parent.file_name().and_then(OsStr::to_str).unwrap_or(""),"exists":exists}));if exists{let _=app.asset_protocol_scope().allow_directory(parent,false);}}}}}
    Ok(json!({"folders":folders,"assets":assets}))
}).await
}

#[tauri::command]
pub async fn video_pick_source(
    app: AppHandle,
    path: String,
    mode: Option<String>,
) -> Result<Option<Value>, String> {
    blocking(move || {
        let _ = project(&app, &path)?;
        if mode.as_deref() == Some("folder") {
            let folder = rfd::FileDialog::new()
                .set_title("选择素材文件夹")
                .pick_folder();
            if let Some(p) = folder {
                app.asset_protocol_scope()
                    .allow_directory(&p, false)
                    .map_err(|e| e.to_string())?;
                return Ok(Some(json!({"abs":abs(&p),"isFolder":true})));
            }
            return Ok(None);
        }
        let picked = rfd::FileDialog::new().set_title("选择视频素材").pick_file();
        if let Some(p) = picked {
            if !logic::is_media_extension(&path_extension(&p)) {
                return Err("Unsupported media file.".into());
            }
            allow_media(&app, &p);
            return Ok(Some(json!({"abs":abs(&p),"isFolder":false})));
        }
        Ok(None)
    })
    .await
}

#[tauri::command]
pub async fn video_cache_dir(app: AppHandle, path: String) -> Result<Value, String> {
    blocking(move || {
        let p = project(&app, &path)?;
        Ok(json!({"abs":abs(&project_cache(&app,&p.relative)?)}))
    })
    .await
}

fn vd_path() -> PathBuf {
    std::env::var_os("INKFELLOW_VD_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".claude/skills/video-director/scripts/vd.py")
        })
}
fn python_choice() -> Option<(PathBuf, Vec<String>)> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let venv = home.join(".video-director/venv/Scripts/python.exe");
    if venv.is_file() {
        return Some((venv, vec![]));
    }
    for (name, args) in [("py", vec!["-3".into()]), ("python", vec![])] {
        let mut c = Command::new(name);
        c.args(&args).arg("--version");
        hide_command_window(&mut c);
        if c.output().map(|o| o.status.success()).unwrap_or(false) {
            return Some((PathBuf::from(name), args));
        }
    }
    None
}
#[tauri::command]
pub async fn video_env() -> Result<Value, String> {
    blocking(move||{let vd=vd_path();let py=python_choice();let ok=vd.is_file()&&py.is_some();let message=if !vd.is_file(){format!("vd.py 不存在：{}",abs(&vd))}else if py.is_none(){"找不到可用的 Python 3（venv、py -3 或 python）".into()}else{"就绪".into()};Ok(json!({"ok":ok,"vdPath":abs(&vd),"python":py.map(|(p,a)|format!("{} {}",abs(&p),a.join(" ")).trim().to_string()),"message":message}))}).await
}

fn emit_job(app: &AppHandle, id: &str, job: &Job, status: &str, extra: Value) {
    let mut event = json!({"jobId":id,"project":job.project,"kind":job.kind,"status":status});
    if let (Some(o), Some(e)) = (event.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    let _ = app.emit("video-job", event);
}
fn terminate_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/T", "/F", "/PID", &pid.to_string()]);
        hide_command_window(&mut c);
        let _ = c.output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
    }
}
pub(super) fn cancel_all_jobs() {
    let active: Vec<_> = jobs().lock().unwrap().values().cloned().collect();
    for job in active {
        job.cancelled.store(true, AtomicOrdering::SeqCst);
        terminate_tree(job.pid.load(AtomicOrdering::SeqCst));
    }
}
fn run_process<F>(
    mut c: Command,
    job: &Arc<Job>,
    emit: F,
) -> Result<(ExitStatus, Option<Value>), String>
where
    F: Fn(&str, Value) + Send + Sync + 'static,
{
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    job.pid.store(child.id(), AtomicOrdering::SeqCst);
    let result = Arc::new(Mutex::new(None::<Value>));
    let last_lines = Arc::new(Mutex::new(VecDeque::<String>::new()));
    let mut readers = Vec::new();
    let emit = Arc::new(emit);
    let streams: Vec<Box<dyn Read + Send>> = vec![
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    for stream in streams {
        let emit = emit.clone();
        let result = result.clone();
        let last_lines = last_lines.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stream).split(b'\n') {
                let Ok(bytes) = line else { break };
                let line = String::from_utf8_lossy(&bytes)
                    .trim_end_matches('\r')
                    .to_owned();
                if let Some(raw) = line.strip_prefix("@@VD ") {
                    if let Ok(event) = serde_json::from_str::<Value>(raw) {
                        if event.get("video").is_some() {
                            *result.lock().unwrap() = Some(event.clone());
                        }
                        emit("event", json!({"event":event}));
                        continue;
                    }
                }
                if !line.trim().is_empty() {
                    let mut lines = last_lines.lock().unwrap();
                    lines.push_back(line.clone());
                    if lines.len() > 4 {
                        lines.pop_front();
                    }
                }
                emit("line", json!({"line":line}));
            }
        }));
    }
    let status = loop {
        if job.cancelled.load(AtomicOrdering::SeqCst) {
            terminate_tree(child.id());
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    job.pid.store(0, AtomicOrdering::SeqCst);
    for r in readers {
        let _ = r.join();
    }
    let mut value = result.lock().unwrap().clone();
    if !status.success() {
        // 失败时把最后几行输出带回去，界面才能告诉用户真正的原因
        let tail = last_lines.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
        value = Some(json!({"failureTail": tail}));
    }
    Ok((status, value))
}
fn run_command(
    app: &AppHandle,
    id: &str,
    job: &Arc<Job>,
    dir: &Path,
    args: &[String],
) -> Result<(ExitStatus, Option<Value>), String> {
    let (python, pre) = python_choice().ok_or("Python not found")?;
    let vd = vd_path();
    if !vd.is_file() {
        return Err("vd.py not found".into());
    }
    let mut c = Command::new(python);
    c.args(pre)
        .arg(vd)
        .args(args)
        .current_dir(dir)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8");
    configure_proxy_environment(&mut c);
    hide_command_window(&mut c);
    let app = app.clone();
    let id = id.to_owned();
    let job_clone = job.clone();
    run_process(c, job, move |status, extra| {
        emit_job(&app, &id, &job_clone, status, extra)
    })
}

fn job_conflicts(map: &HashMap<String, Arc<Job>>, job: &Job) -> bool {
    map.values().any(|j| {
        j.project == job.project
            && ((j.kind == "render" && job.kind == "render")
                || (j.kind == "sample" && job.kind == "sample" && j.beat == job.beat))
    })
}
fn execute_job(app: AppHandle, id: String, job: Arc<Job>, dir: PathBuf, args: Value) {
    let _thumb_guard = if job.kind.starts_with("thumbs_") {
        loop {
            if job.cancelled.load(AtomicOrdering::SeqCst) {
                emit_job(&app, &id, &job, "cancelled", json!({}));
                jobs().lock().unwrap().remove(&id);
                return;
            }
            match thumbs_lock().try_lock() {
                Ok(guard) => break Some(guard),
                Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(20)),
                Err(std::sync::TryLockError::Poisoned(error)) => break Some(error.into_inner()),
            }
        }
    } else {
        None
    };
    if job.cancelled.load(AtomicOrdering::SeqCst) {
        emit_job(&app, &id, &job, "cancelled", json!({}));
        jobs().lock().unwrap().remove(&id);
        return;
    }
    emit_job(&app, &id, &job, "start", json!({}));
    let edl = abs(&dir.join("edl.json"));
    let arguments: Result<Vec<String>, String> = match job.kind.as_str() {
        "render" => Ok(vec!["render".into(), edl.clone()]),
        "sample" => Ok(vec![
            "render".into(),
            edl.clone(),
            "--beat".into(),
            job.beat.clone().unwrap_or_default(),
        ]),
        "edits_status" => Ok(vec![
            "edits".into(),
            "status".into(),
            edl.clone(),
            "--json".into(),
        ]),
        "thumbs_shots" => {
            let video = args["video"].as_str().unwrap_or("");
            if !logic::valid_video_name(video) || !dir.join("out").join(video).is_file() {
                Err("Invalid video.".into())
            } else {
                let out = project_cache(&app, &job.project).and_then(|p| {
                    let p = p.join("shots").join(video);
                    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
                    Ok(p)
                });
                out.map(|out| {
                    vec![
                        "thumbs".into(),
                        "shots".into(),
                        edl.clone(),
                        "--video".into(),
                        abs(&dir.join("out").join(video)),
                        "--out".into(),
                        abs(&out),
                    ]
                })
            }
        }
        "thumbs_sources" => {
            let folder = args["folder"].as_str().unwrap_or("");
            let p = PathBuf::from(folder);
            if !p.is_absolute() || !p.exists() {
                Err("Invalid source folder.".into())
            } else {
                project_cache(&app, &job.project).and_then(|base| {
                    let out = base.join("sources");
                    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                    Ok(vec![
                        "thumbs".into(),
                        "sources".into(),
                        folder.into(),
                        "--out".into(),
                        abs(&out),
                        "--strips".into(),
                        "10".into(),
                    ])
                })
            }
        }
        _ => Err("Invalid job kind.".into()),
    };
    let result = arguments.and_then(|argv| run_command(&app, &id, &job, &dir, &argv));
    match result {
        Ok((status, _)) if job.cancelled.load(AtomicOrdering::SeqCst) => {
            emit_job(&app, &id, &job, "cancelled", json!({"code":status.code()}))
        }
        Ok((status, vd)) if status.success() => {
            if job.kind == "render" {
                if let Some(video) = vd.as_ref().and_then(|v| v["video"].as_str()) {
                    let file = PathBuf::from(video);
                    let file = if file.is_absolute() {
                        file
                    } else {
                        dir.join(file)
                    };
                    let qa = run_command(&app, &id, &job, &dir, &["qa".into(), abs(&file), edl]);
                    if let Ok((qa_status, _)) = qa {
                        if !qa_status.success() {
                            emit_job(
                                &app,
                                &id,
                                &job,
                                "event",
                                json!({"event":{"qaFailed":true,"code":qa_status.code()}}),
                            );
                        }
                    } else if let Err(e) = qa {
                        emit_job(
                            &app,
                            &id,
                            &job,
                            "event",
                            json!({"event":{"qaFailed":true,"message":e}}),
                        );
                    }
                } else {
                    emit_job(
                        &app,
                        &id,
                        &job,
                        "event",
                        json!({"event":{"qaFailed":true,"message":"render result has no video"}}),
                    );
                }
            }
            if job.cancelled.load(AtomicOrdering::SeqCst) {
                emit_job(&app, &id, &job, "cancelled", json!({"code":status.code()}));
            } else {
                emit_job(&app, &id, &job, "done", json!({"code":status.code()}));
            }
        }
        Ok((status, vd)) => {
            let tail = vd
                .as_ref()
                .and_then(|v| v["failureTail"].as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("vd exited with error")
                .to_owned();
            emit_job(
                &app,
                &id,
                &job,
                "error",
                json!({"code":status.code(),"message":tail}),
            )
        }
        Err(e) => emit_job(&app, &id, &job, "error", json!({"message":e})),
    };
    jobs().lock().unwrap().remove(&id);
}
#[tauri::command]
pub async fn video_start_job(
    app: AppHandle,
    path: String,
    kind: String,
    args: Value,
) -> Result<Value, String> {
    let p = blocking({
        let app = app.clone();
        move || project(&app, &path)
    })
    .await?;
    let beat = if kind == "sample" {
        let beat = args["beat"].as_str().ok_or("Invalid beat.")?;
        if !logic::valid_beat(beat) {
            return Err("Invalid beat.".into());
        }
        Some(beat.to_owned())
    } else {
        None
    };
    if !matches!(
        kind.as_str(),
        "render" | "sample" | "edits_status" | "thumbs_shots" | "thumbs_sources"
    ) {
        return Err("Invalid job kind.".into());
    }
    if kind == "thumbs_shots" {
        let video = args["video"].as_str().unwrap_or("");
        if !logic::valid_video_name(video) || !p.absolute.join("out").join(video).is_file() {
            return Err("Invalid video.".into());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(Job {
        project: p.relative,
        kind,
        beat,
        pid: AtomicU32::new(0),
        cancelled: AtomicBool::new(false),
    });
    {
        let mut map = jobs().lock().unwrap();
        if job_conflicts(&map, &job) {
            return Err("JOB_BUSY".into());
        }
        map.insert(id.clone(), job.clone());
    }
    let return_id = id.clone();
    std::thread::spawn(move || execute_job(app, id, job, p.absolute, args));
    Ok(json!({"jobId":return_id}))
}
#[tauri::command]
pub async fn video_cancel_job(job_id: String) -> Result<Value, String> {
    let job = jobs().lock().unwrap().get(&job_id).cloned();
    if let Some(job) = job {
        job.cancelled.store(true, AtomicOrdering::SeqCst);
        let pid = job.pid.load(AtomicOrdering::SeqCst);
        if pid > 0 {
            tauri::async_runtime::spawn_blocking(move || terminate_tree(pid))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(json!({"cancelled":true}))
    } else {
        Ok(json!({"cancelled":false}))
    }
}

pub(super) fn watcher_event(app: &AppHandle, root: &Path, paths: &[PathBuf]) {
    static PENDING: OnceLock<Mutex<HashMap<String, (HashSet<String>, Instant)>>> = OnceLock::new();
    let pending = PENDING.get_or_init(|| Mutex::new(HashMap::new()));
    let mut changed = false;
    {
        let mut map = pending.lock().unwrap();
        for p in paths {
            if let Ok(rel) = p.strip_prefix(root) {
                if let Some((project, kind)) = logic::watcher_path(&to_slash_path(rel)) {
                    if kind == "edl"
                        || root
                            .join(relative_to_path_buf(&project))
                            .join("edl.json")
                            .is_file()
                    {
                        let entry = map
                            .entry(project)
                            .or_insert_with(|| (HashSet::new(), Instant::now()));
                        entry.0.insert(kind.into());
                        entry.1 = Instant::now();
                        changed = true;
                    }
                }
            }
        }
    }
    if changed {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(320));
            let ready = {
                let mut map = pending.lock().unwrap();
                let keys: Vec<_> = map
                    .iter()
                    .filter(|(_, (_, at))| at.elapsed() >= Duration::from_millis(300))
                    .map(|(k, _)| k.clone())
                    .collect();
                keys.into_iter()
                    .filter_map(|k| map.remove(&k).map(|(kinds, _)| (k, kinds)))
                    .collect::<Vec<_>>()
            };
            for (project, kinds) in ready {
                let mut kinds: Vec<_> = kinds.into_iter().collect();
                kinds.sort();
                let _ = app.emit(
                    "video-project-changed",
                    json!({"project":project,"kinds":kinds}),
                );
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job(kind: &str, beat: Option<&str>) -> Arc<Job> {
        Arc::new(Job {
            project: "sample/project".into(),
            kind: kind.into(),
            beat: beat.map(str::to_owned),
            pid: AtomicU32::new(0),
            cancelled: AtomicBool::new(false),
        })
    }
    #[test]
    fn project_duration_ignores_stale_last_render_and_reads_only_latest_snapshot() {
        let dir = std::env::temp_dir().join(format!("inkfellow-duration-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("out")).unwrap();
        fs::create_dir_all(dir.join("work/versions")).unwrap();
        fs::write(dir.join("out/new_v2.mp4"), b"video").unwrap();
        fs::write(dir.join("work/last_render.json"), br#"{"video":"out/deleted_v3.mp4","duration":90}"#).unwrap();
        fs::write(dir.join("work/versions/new_v2.plan.json"), br#"{"duration":72.25}"#).unwrap();
        fs::write(dir.join("work/plan.json"), br#"{"duration":80}"#).unwrap();
        assert_eq!(latest_duration(&dir, Some("new_v2.mp4")), Some(72.25));
        fs::write(dir.join("work/last_render.json"), br#"{"video":"new_v2.mp4","duration":73}"#).unwrap();
        assert_eq!(latest_duration(&dir, Some("new_v2.mp4")), Some(73.0));
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn queued_source_thumbnails_can_be_cancelled_before_start() {
        let id = format!("queued-thumbs-{}", uuid::Uuid::new_v4());
        let queued = job("thumbs_sources", None);
        jobs().lock().unwrap().insert(id.clone(), queued.clone());
        let result = tauri::async_runtime::block_on(video_cancel_job(id.clone())).unwrap();
        assert_eq!(result["cancelled"], true);
        assert!(queued.cancelled.load(AtomicOrdering::SeqCst));
        jobs().lock().unwrap().remove(&id);
    }
    #[test]
    fn edits_revision_and_atomic_replacement() {
        let dir =
            std::env::temp_dir().join(format!("inkfellow-edits-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("edits.json");
        assert_eq!(
            write_edits_file(&target, json!({"edits":[],"notes":[]}), 0).unwrap()["revision"],
            1
        );
        assert_eq!(
            write_edits_file(&target, json!({"edits":[{"id":"e1"}],"notes":[]}), 0).unwrap_err(),
            "REVISION_CONFLICT"
        );
        assert_eq!(
            write_edits_file(&target, json!({"edits":[{"id":"e1"}],"notes":[]}), 1).unwrap()
                ["revision"],
            2
        );
        let value = read_json(&target).unwrap();
        assert_eq!(value["revision"], 2);
        assert_eq!(value["edits"][0]["id"], "e1");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    #[ignore = "Runs a temporary fake vd.py with the installed Python and taskkill"]
    fn fake_vd_runner_lines_busy_cancel_exit() {
        let dir = std::env::temp_dir().join(format!("inkfellow-vd-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("vd.py");
        fs::write(&script,"import sys,time\nprint('ordinary line',flush=True)\nprint('@@VD {\"video\":\"clip.mp4\",\"beat\":\"b03\"}',flush=True)\nprint('stderr line',file=sys.stderr,flush=True)\nif sys.argv[-1]=='sleep': time.sleep(30)\nif sys.argv[-1]=='fail': sys.exit(7)\n").unwrap();
        let old = std::env::var_os("INKFELLOW_VD_PATH");
        std::env::set_var("INKFELLOW_VD_PATH", &script);
        let (python, pre) = python_choice().expect("Python required for fake vd test");
        let make_command = |mode: &str| {
            let mut c = Command::new(&python);
            c.args(&pre)
                .arg(vd_path())
                .arg(mode)
                .current_dir(&dir)
                .env("PYTHONUTF8", "1")
                .env("PYTHONIOENCODING", "utf-8");
            hide_command_window(&mut c);
            c
        };
        let events = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let captured = events.clone();
        let (ok, result) = run_process(
            make_command("ok"),
            &job("render", None),
            move |status, value| captured.lock().unwrap().push((status.into(), value)),
        )
        .unwrap();
        assert!(ok.success());
        assert_eq!(result.unwrap()["video"], "clip.mp4");
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|(s, v)| s == "line" && v["line"] == "ordinary line"));
        assert!(events
            .iter()
            .any(|(s, v)| s == "line" && v["line"] == "stderr line"));
        assert!(events
            .iter()
            .any(|(s, v)| s == "event" && v["event"]["video"] == "clip.mp4"));
        drop(events);
        let (failed, _) =
            run_process(make_command("fail"), &job("render", None), |_, _| {}).unwrap();
        assert_eq!(failed.code(), Some(7));
        let active = job("sample", Some("b03"));
        let mut map = HashMap::new();
        map.insert("first".into(), active.clone());
        assert!(job_conflicts(&map, &job("sample", Some("b03"))));
        assert!(!job_conflicts(&map, &job("sample", Some("b04"))));
        assert!(!job_conflicts(&map, &job("render", None)));
        let sleeping = job("render", None);
        let running = sleeping.clone();
        let c = make_command("sleep");
        let task = std::thread::spawn(move || run_process(c, &running, |_, _| {}).unwrap().0);
        let start = Instant::now();
        while sleeping.pid.load(AtomicOrdering::SeqCst) == 0
            && start.elapsed() < Duration::from_secs(3)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let pid = sleeping.pid.load(AtomicOrdering::SeqCst);
        assert!(pid > 0);
        sleeping.cancelled.store(true, AtomicOrdering::SeqCst);
        terminate_tree(pid);
        assert!(!task.join().unwrap().success());
        match old {
            Some(v) => std::env::set_var("INKFELLOW_VD_PATH", v),
            None => std::env::remove_var("INKFELLOW_VD_PATH"),
        };
        let _ = fs::remove_dir_all(&dir);
    }
}
