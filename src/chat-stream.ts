export async function readChatStream(response: Response, onChunk?: (delta: string) => void): Promise<string> {
  if (!response.body) throw new Error("服务没有返回可读取的流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let data: string[] = [];
  let content = "";
  let finished = false;
  let done = false;

  function event() {
    const raw = data.join("\n");
    data = [];
    if (done || !raw) return;
    if (raw.trim() === "[DONE]") { finished = true; done = true; return; }
    let body;
    try { body = JSON.parse(raw); }
    catch { throw new Error("流式响应格式不正确，请检查服务是否支持 OpenAI 流式协议"); }
    if (body.error) throw new Error(`流式请求失败：${body.error.message || body.error || "服务返回了错误"}`);
    const choice = body.choices?.find((item: { index?: number }) => (item.index ?? 0) === 0);
    if (choice?.finish_reason != null) finished = true;
    const text = choice?.delta?.content;
    if (typeof text === "string" && text) { content += text; onChunk?.(text); }
  }

  function line(value: string) {
    value = value.replace(/^\uFEFF/, "").replace(/\r$/, "");
    if (!value) event();
    else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  }

  try {
    for (;;) {
      const result = await reader.read();
      pending += decoder.decode(result.value, { stream: !result.done });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (result.done || done) break;
    }
    if (pending) line(pending);
    event();
    if (!finished) throw new Error("流式响应意外中断，请重试；原回复已保留");
    if (!content) throw new Error("服务响应中没有找到回复内容");
    return content;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
