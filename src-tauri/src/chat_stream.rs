use serde_json::Value;

#[derive(Default)]
pub struct ChatStream {
    pending: Vec<u8>,
    data: Vec<String>,
    pub content: String,
    finished: bool,
    done: bool,
}

impl ChatStream {
    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.pending.extend_from_slice(bytes);
        let mut deltas = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line = self.pending.drain(..=end).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line[..line.len() - 1])
                .map_err(|_| "流式响应包含无效文字编码".to_string())?;
            self.line(line.trim_end_matches('\r'), &mut deltas)?;
        }
        Ok(deltas)
    }

    pub fn finish(&mut self) -> Result<Vec<String>, String> {
        let mut deltas = Vec::new();
        if !self.pending.is_empty() {
            let bytes = std::mem::take(&mut self.pending);
            let line =
                std::str::from_utf8(&bytes).map_err(|_| "流式响应包含无效文字编码".to_string())?;
            self.line(line.trim_end_matches('\r'), &mut deltas)?;
        }
        self.event(&mut deltas)?;
        if !self.finished {
            return Err("流式响应意外中断，请重试；原回复已保留".into());
        }
        if self.content.is_empty() {
            return Err("服务响应中没有找到回复内容".into());
        }
        Ok(deltas)
    }

    fn line(&mut self, line: &str, deltas: &mut Vec<String>) -> Result<(), String> {
        let line = line.trim_start_matches('\u{feff}');
        if line.is_empty() {
            self.event(deltas)?;
        } else if let Some(data) = line.strip_prefix("data:") {
            self.data
                .push(data.strip_prefix(' ').unwrap_or(data).to_string());
        }
        Ok(())
    }

    fn event(&mut self, deltas: &mut Vec<String>) -> Result<(), String> {
        let data = std::mem::take(&mut self.data).join("\n");
        if self.done || data.is_empty() {
            return Ok(());
        }
        if data.trim() == "[DONE]" {
            self.finished = true;
            self.done = true;
            return Ok(());
        }
        let body: Value = serde_json::from_str(&data)
            .map_err(|_| "流式响应格式不正确，请检查服务是否支持 OpenAI 流式协议".to_string())?;
        if let Some(error) = body.get("error") {
            return Err(format!(
                "流式请求失败：{}",
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .or_else(|| error.as_str())
                    .unwrap_or("服务返回了错误")
            ));
        }
        if let Some(choice) = body
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| {
                choices
                    .iter()
                    .find(|choice| choice.get("index").and_then(Value::as_u64).unwrap_or(0) == 0)
            })
        {
            if choice
                .get("finish_reason")
                .is_some_and(|reason| !reason.is_null())
            {
                self.finished = true;
            }
            if let Some(text) = choice.pointer("/delta/content").and_then(Value::as_str) {
                if !text.is_empty() {
                    self.content.push_str(text);
                    deltas.push(text.to_string());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_split_utf8_crlf_comments_and_done() {
        let input = ": ping\r\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\r\n\r\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"🌍\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]";
        let mut stream = ChatStream::default();
        let mut pieces = Vec::new();
        for byte in input.as_bytes() {
            pieces.extend(stream.push(&[*byte]).unwrap());
        }
        pieces.extend(stream.finish().unwrap());
        assert_eq!(pieces, ["你好", "🌍"]);
        assert_eq!(stream.content, "你好🌍");
    }

    #[test]
    fn rejects_truncation_malformed_events_and_service_errors() {
        let mut stream = ChatStream::default();
        stream
            .push(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
            .unwrap();
        assert!(stream.finish().unwrap_err().contains("中断"));
        assert!(ChatStream::default().push(b"data: not-json\n\n").is_err());
        assert!(ChatStream::default()
            .push(b"data: {\"error\":{\"message\":\"quota exceeded\"}}\n\n")
            .unwrap_err()
            .contains("quota exceeded"));
        assert!(ChatStream::default().push(b"data: [DONE]\n\n").is_ok());
        let mut finished = ChatStream::default();
        finished.push(b"data: [DONE]\n\n").unwrap();
        assert!(finished.finish().unwrap_err().contains("没有找到"));
    }
}
