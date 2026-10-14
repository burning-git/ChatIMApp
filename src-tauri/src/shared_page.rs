use super::{html_escape, ChatMessage, ChatSession};

pub fn render(session: &ChatSession, messages: &[ChatMessage]) -> String {
    let mut cards = String::new();
    for message in messages {
        let (class, role) = if message.role == "assistant" {
            ("assistant", "AI")
        } else {
            ("user", "你")
        };
        let images = message
            .images
            .iter()
            .map(|src| format!("<img src=\"{}\" alt=\"会话图片\">", html_escape(src)))
            .collect::<String>();
        let tools = if message.content.is_empty() {
            String::new()
        } else {
            let text = html_escape(&message.content)
                .replace('\r', "&#13;")
                .replace('\n', "&#10;");
            format!("<div class=\"copy-tools\"><button class=\"copy-button\" type=\"button\" data-copy-text=\"{text}\">复制</button><span class=\"copy-status\" role=\"status\" aria-live=\"polite\"></span></div>")
        };
        cards.push_str(&format!("<article class=\"{class}\"><small>{role} · {}</small><p class=\"message-content\">{}</p><div class=\"images\">{images}</div>{tools}</article>", html_escape(&message.created_at), html_escape(&message.content)));
    }
    format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{} · 回声</title><style>{}</style></head><body><main><header><small>回声 · 只读分享</small><h1>{}</h1><div class="hint">可查看、复制会话文字，刷新页面获取最新记录。</div></header>{}</main><script>{}</script></body></html>"#,
        html_escape(&session.title),
        include_str!("shared-page.css"),
        html_escape(&session.title),
        cards,
        include_str!("shared-copy.js")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_message_content_and_provides_exact_copy_text() {
        let session = ChatSession {
            id: "s".into(),
            title: "<script>bad()</script>".into(),
            system_prompt: "private".into(),
            stream: true,
            temperature: Some(0.0),
            created_at: "now".into(),
            updated_at: "now".into(),
            last_message: "".into(),
        };
        let text = "\n第一行\r\n<script>alert(1)</script>\n\"&'  空格";
        let message = ChatMessage {
            id: "m".into(),
            session_id: "s".into(),
            role: "user".into(),
            content: text.into(),
            images: vec![],
            created_at: "now".into(),
            reply_to_id: None,
        };
        let mut image_only = message.clone();
        image_only.content.clear();
        image_only
            .images
            .push("data:image/png;base64,aGVsbG8=".into());
        let html = render(&session, &[message, image_only]);
        assert_eq!(html.matches("data-copy-text=").count(), 1);
        assert!(html.contains("&#10;第一行&#13;&#10;&lt;script&gt;"));
        assert!(html.contains("&quot;&amp;&#39;  空格"));
        assert!(!html.contains("<script>alert"));
        assert!(!html.contains("private"));
        assert!(html.contains("execCommand('copy')"));
    }
}
