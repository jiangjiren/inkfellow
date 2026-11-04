//! Side-effect-free rules shared by the workbench commands and watcher.
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersionName {
    pub name: String,
    pub n: Option<u64>,
    pub kind: &'static str,
}

/// 引擎生成文件名时会把这些字符换成下划线（vdlib/render.py），这里要保持一致，
/// 否则片名带空格的工程，所有成片都认不出版本号。
pub fn sanitize_base(project: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for ch in project.chars() {
        if ch.is_whitespace() || matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            if !in_run {
                out.push('_');
            }
            in_run = true;
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    out
}

pub fn classify_version(name: &str, base: &str) -> Option<VersionName> {
    if !name.to_ascii_lowercase().ends_with(".mp4") {
        return None;
    }
    let stem = &name[..name.len() - 4];
    let (kind, n) = if stem == format!("{base}_preview") {
        ("preview", None)
    } else if let Some(rest) = stem.strip_prefix(&format!("{base}_v")) {
        match rest.parse::<u64>() {
            Ok(n) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()) => {
                ("final", Some(n))
            }
            _ => ("other", None),
        }
    } else {
        ("other", None)
    };
    Some(VersionName {
        name: name.into(),
        n,
        kind,
    })
}

pub fn sort_versions(versions: &mut [VersionName]) {
    versions.sort_by(|a, b| {
        let rank = |v: &VersionName| match v.kind {
            "final" => 0,
            "preview" => 1,
            _ => 2,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| b.n.cmp(&a.n))
            .then_with(|| a.name.cmp(&b.name))
    });
}

pub fn latest(versions: &[VersionName]) -> Option<&str> {
    versions
        .iter()
        .find(|v| v.kind == "final")
        .or_else(|| versions.iter().find(|v| v.kind == "preview"))
        .map(|v| v.name.as_str())
}

pub fn plan_choice(has_snapshot: bool, has_latest_plan: bool) -> &'static str {
    if has_snapshot {
        "snapshot"
    } else if has_latest_plan {
        "latest"
    } else {
        "none"
    }
}

pub fn journal_tail(text: &str, count: usize) -> Vec<Value> {
    let lines: Vec<_> = text
        .lines()
        .rev()
        .take(count)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(Value::is_object)
        .collect();
    lines.into_iter().rev().collect()
}

pub fn unfinished_run(events: &[Value]) -> Option<Value> {
    // Inspect the last command-level event for each run; stage progress is allowed.
    let mut finished = std::collections::HashSet::new();
    for event in events.iter().rev() {
        let cmd = event.get("cmd").and_then(Value::as_str).unwrap_or("");
        if cmd != "render" && cmd != "sample" {
            continue;
        }
        let run = event.get("run").and_then(Value::as_str).unwrap_or("");
        if run.is_empty() || finished.contains(run) {
            continue;
        }
        let status = event.get("status").and_then(Value::as_str).unwrap_or("");
        let stage = event.get("stage").and_then(Value::as_str).unwrap_or("");
        if stage == "run" && (status == "done" || status == "error") {
            finished.insert(run.to_string());
            continue;
        }
        if event.get("pid").and_then(Value::as_u64).unwrap_or(0) > 0 {
            return Some(event.clone());
        }
    }
    None
}

pub fn watcher_path(relative: &str) -> Option<(String, &'static str)> {
    let normalized = relative.replace('\\', "/");
    let (project, tail) = normalized.rsplit_once('/')?;
    let (project, kind) = if matches!(
        tail,
        "edl.json" | "edits.json" | "制作说明.md" | "发布文案.md"
    ) || (tail.starts_with("口播") && tail.ends_with(".md"))
    {
        (
            project,
            match tail {
                "edl.json" => "edl",
                "edits.json" => "edits",
                _ => "docs",
            },
        )
    } else if let Some((parent, _directory)) = project.rsplit_once('/') {
        if project.ends_with("/out")
            && matches!(
                tail.rsplit_once('.')
                    .map(|(_, ext)| ext.to_ascii_lowercase())
                    .as_deref(),
                Some("mp4" | "jpg" | "jpeg" | "png" | "webp")
            )
        {
            (parent, "out")
        } else if project.ends_with("/work") {
            (
                parent,
                match tail {
                    "plan.json" => "plan",
                    "journal.jsonl" => "journal",
                    "edits_status.json" => "status",
                    _ => return None,
                },
            )
        } else if project.ends_with("/work/versions") && tail.ends_with(".plan.json") {
            let grand = parent.strip_suffix("/work")?;
            (grand, "versions")
        } else {
            return None;
        }
    } else {
        return None;
    };
    if project.split('/').any(|part| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            ".git"
                | ".obsidian"
                | ".claude"
                | ".claudian"
                | "node_modules"
                | "work"
                | "out"
                | "hf"
                | "clips"
                | ".hyperframes"
        )
    }) {
        return None;
    }
    Some((project.into(), kind))
}

pub fn is_media_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "mp4"
            | "mov"
            | "m4v"
            | "webm"
            | "mkv"
            | "jpg"
            | "jpeg"
            | "png"
            | "webp"
            | "gif"
            | "avif"
            | "mp3"
            | "wav"
            | "m4a"
            | "aac"
            | "flac"
            | "ogg"
    )
}

pub fn valid_beat(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn valid_video_name(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains(':')
        && value.to_ascii_lowercase().ends_with(".mp4")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_matches_how_the_engine_names_files() {
        assert_eq!(sanitize_base("元江过冬租房"), "元江过冬租房");
        assert_eq!(sanitize_base("My  Video: 1"), "My_Video_1");
        assert_eq!(sanitize_base("a/b\\c"), "a_b_c");
        let base = sanitize_base("My Video");
        assert_eq!(classify_version("My_Video_v3.mp4", &base).unwrap().kind, "final");
    }

    #[test]
    fn a_dotted_version_is_not_a_final_but_still_a_version() {
        let v = classify_version("元江过冬旅居_v1.2.mp4", "元江过冬旅居").unwrap();
        assert_eq!(v.kind, "other");
        assert_eq!(latest(&[v]), None);
    }
    #[test]
    fn versions_and_latest() {
        let mut v = vec![
            classify_version("film_v9.mp4", "film").unwrap(),
            classify_version("film_v10.mp4", "film").unwrap(),
            classify_version("film_preview.mp4", "film").unwrap(),
            classify_version("renamed.mp4", "film").unwrap(),
        ];
        sort_versions(&mut v);
        assert_eq!(
            v.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            [
                "film_v10.mp4",
                "film_v9.mp4",
                "film_preview.mp4",
                "renamed.mp4"
            ]
        );
        assert_eq!(v[3].kind, "other");
        assert_eq!(latest(&v), Some("film_v10.mp4"));
        assert_eq!(latest(&v[2..]), Some("film_preview.mp4"));
    }
    #[test]
    fn snapshot_choice() {
        assert_eq!(plan_choice(true, true), "snapshot");
        assert_eq!(plan_choice(false, true), "latest");
        assert_eq!(plan_choice(false, false), "none");
    }
    #[test]
    fn journal_skips_bad_lines_and_detects_running() {
        let j = journal_tail("{bad}\n{\"run\":\"r\",\"pid\":12,\"cmd\":\"render\",\"stage\":\"run\",\"status\":\"start\"}\n", 200);
        assert_eq!(j.len(), 1);
        assert!(unfinished_run(&j).is_some());
        let mut stage_done = j.clone();
        stage_done.push(
            serde_json::json!({"run":"r","pid":12,"cmd":"render","stage":"shots","status":"done"}),
        );
        assert!(unfinished_run(&stage_done).is_some());
        let mut done = j.clone();
        done.push(serde_json::json!({"run":"r","cmd":"render","stage":"run","status":"done"}));
        assert!(unfinished_run(&done).is_none());
    }
    #[test]
    fn watcher_paths() {
        assert_eq!(watcher_path("旅居/视频/work/segs/xx.mp4"), None);
        assert_eq!(
            watcher_path("旅居\\视频\\out\\a.mp4"),
            Some(("旅居/视频".into(), "out"))
        );
        assert_eq!(
            watcher_path("旅居/视频/work/versions/a.plan.json"),
            Some(("旅居/视频".into(), "versions"))
        );
    }
    #[test]
    fn validates_arguments_and_media() {
        assert!(valid_beat("b_03-x"));
        assert!(!valid_beat("../x"));
        assert!(valid_video_name("片_v2.mp4"));
        assert!(!valid_video_name("../out/a.mp4"));
        assert!(!valid_video_name("C:\\a.mp4"));
        assert!(is_media_extension("JPG"));
        assert!(!is_media_extension("json"));
    }
}
