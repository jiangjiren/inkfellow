use serde::Deserialize;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryResponse {
    is_ai: bool,
    message: Option<String>,
    reason: Option<String>,
}

fn parse_response(response: &str) -> Result<String, String> {
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or("AI 摘要服务响应无效")?;
    if headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        != Some("200")
    {
        return Err("AI 摘要服务暂不可用".into());
    }
    let data: SummaryResponse = serde_json::from_str(body).map_err(|_| "AI 摘要响应格式无效")?;
    if !data.is_ai {
        return Err(data.reason.unwrap_or_else(|| "AI 未生成摘要".into()));
    }
    let message = data
        .message
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if message.is_empty() {
        return Err("AI 返回了空摘要".into());
    }
    Ok(message.chars().take(80).collect())
}

pub fn request(port: u16, token: &str, diff: &str) -> Result<String, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| "AI 服务尚未就绪")?;
    stream
        .set_read_timeout(Some(Duration::from_secs(25)))
        .map_err(|_| "AI 连接配置失败")?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|_| "AI 连接配置失败")?;
    let body =
        serde_json::json!({ "diff": diff.chars().take(16000).collect::<String>() }).to_string();
    let request = format!(
        "POST /api/sync-summary?token={token} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "AI 摘要请求发送失败")?;
    let mut response = String::new();
    stream
        .take(65536)
        .read_to_string(&mut response)
        .map_err(|_| "AI 摘要请求超时或连接中断")?;
    parse_response(&response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_ai_fallback_and_invalid_responses() {
        assert_eq!(
            parse_response("HTTP/1.0 200 OK\r\n\r\n{\"isAi\":true,\"message\":\"补充阅读感悟\"}")
                .unwrap(),
            "补充阅读感悟"
        );
        assert_eq!(
            parse_response("HTTP/1.0 200 OK\r\n\r\n{\"isAi\":false,\"reason\":\"AI 额度不足\"}")
                .unwrap_err(),
            "AI 额度不足"
        );
        assert!(parse_response("HTTP/1.0 403 Forbidden\r\n\r\n{}").is_err());
        assert!(
            parse_response("HTTP/1.0 200 OK\r\n\r\n{\"isAi\":true,\"message\":\"  \"}").is_err()
        );
    }
}
