use std::path::Path;

pub struct WindowActivity {
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
}

pub fn should_notify(window: Option<WindowActivity>) -> bool {
    window.is_some_and(|window| !window.visible || window.minimized || !window.focused)
}

/// 只有安装版注册过自己的 AppUserModelID；没安装的开发版用它发通知，Windows 不会显示。
pub fn has_registered_app_id(exe_dir: &Path) -> bool {
    !(exe_dir.ends_with("target/debug") || exe_dir.ends_with("target/release"))
}

/// 通知协议只接收本应用的对话 ID，拒绝路径、查询参数和转义字符。
pub fn valid_conversation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub fn conversation_url(scheme: &str, id: &str) -> Option<String> {
    valid_conversation_id(id).then(|| format!("{scheme}://conversation/{id}"))
}

pub fn conversation_id_from_url<'a>(scheme: &str, url: &'a str) -> Option<&'a str> {
    let id = url.strip_prefix(&format!("{scheme}://conversation/"))?;
    valid_conversation_id(id).then_some(id)
}

pub fn conversation_id_from_args(scheme: &str, args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter()
        .find_map(|arg| conversation_id_from_url(scheme, &arg).map(str::to_string))
}

/// XML 文本和属性共用转义；无效 XML 控制字符直接丢弃。
pub fn escape_xml(value: &str) -> String {
    let mut escaped = String::new();
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\t' | '\n' | '\r' => escaped.push(ch),
            c if c.is_control() || matches!(c, '\u{fffe}' | '\u{ffff}') => {}
            c => escaped.push(c),
        }
    }
    escaped
}

pub fn toast_xml(body: &str, launch: Option<&str>) -> String {
    let activation = launch
        .map(|url| format!(" activationType=\"protocol\" launch=\"{}\"", escape_xml(url)))
        .unwrap_or_default();
    format!(
        "<toast{activation}><visual><binding template=\"ToastGeneric\"><text>Fellow 已完成</text><text>{}</text></binding></visual><audio src=\"ms-winsoundevent:Notification.Default\"/></toast>",
        escape_xml(body)
    )
}

#[cfg(test)]
mod tests {
    use super::{conversation_id_from_args, conversation_id_from_url, conversation_url, escape_xml, has_registered_app_id, should_notify, toast_xml, WindowActivity};
    use std::path::Path;

    #[test]
    fn only_builds_outside_cargo_target_use_the_app_identity() {
        assert!(has_registered_app_id(Path::new("D:/Program Files/inkfellow")));
        assert!(!has_registered_app_id(Path::new("D:/work/inkfellow/src-tauri/target/debug")));
        assert!(!has_registered_app_id(Path::new("D:/work/inkfellow/src-tauri/target/release")));
    }

    #[test]
    fn foreground_app_is_silent_even_if_another_chat_finishes() {
        assert!(!should_notify(Some(WindowActivity {
            visible: true,
            minimized: false,
            focused: true,
        })));
    }

    #[test]
    fn unfocused_minimized_and_hidden_windows_allow_completion_alerts() {
        for (visible, minimized, focused) in [
            (true, false, false),
            (true, true, false),
            (true, true, true),
            (false, false, false),
        ] {
            assert!(should_notify(Some(WindowActivity {
                visible,
                minimized,
                focused,
            })));
        }
    }

    #[test]
    fn missing_or_unreadable_window_state_stays_silent() {
        assert!(!should_notify(None));
    }

    #[test]
    fn protocol_accepts_only_exact_conversation_urls() {
        let scheme = "com.inkfellow.vwtest";
        let id = "toast-m123_A";
        let url = conversation_url(scheme, id).unwrap();
        assert_eq!(conversation_id_from_url(scheme, &url), Some(id));
        assert_eq!(conversation_id_from_args(scheme, ["app.exe".into(), url]), Some(id.into()));
        for bad in [
            "com.inkfellow.app://conversation/toast-m123_A",
            "com.inkfellow.vwtest://other/toast-m123_A",
            "com.inkfellow.vwtest://conversation/toast-m123_A/extra",
            "com.inkfellow.vwtest://conversation/toast-m123_A?x=1",
            "com.inkfellow.vwtest://conversation/%2e%2e",
            "com.inkfellow.vwtest://conversation/a.md",
            "com.inkfellow.vwtest://conversation/中文",
            "com.inkfellow.vwtest://conversation/a#fragment",
            "com.inkfellow.vwtest://conversation/",
        ] {
            assert_eq!(conversation_id_from_url(scheme, bad), None, "{bad}");
        }
        assert!(conversation_url(scheme, &"a".repeat(129)).is_none());
    }

    #[test]
    fn toast_escapes_user_text_and_launch_attribute() {
        assert_eq!(escape_xml("&<>\"'中文"), "&amp;&lt;&gt;&quot;&apos;中文");
        let xml = toast_xml("&<>\"'中文", Some("com.inkfellow.app://conversation/a&\"'"));
        assert!(xml.contains("<text>&amp;&lt;&gt;&quot;&apos;中文</text>"));
        assert!(xml.contains("launch=\"com.inkfellow.app://conversation/a&amp;&quot;&apos;\""));
        assert!(xml.contains("ms-winsoundevent:Notification.Default"));
    }
}
