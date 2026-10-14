const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export function validateImageUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("请输入有效的图片链接"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("图片链接须以 http:// 或 https:// 开头，且不能包含账号密码");
  }
  return url.href;
}

export async function readImageUrl(value: string): Promise<string> {
  const url = validateImageUrl(value);
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(45000), credentials: "omit" }); }
  catch { throw new Error("无法下载图片，请检查链接；浏览器预览需图片网站允许跨域访问"); }
  if (!response.ok) throw new Error(`图片下载失败（${response.status}）`);
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("图片超过 12 MB");
  if (!response.body) throw new Error("链接没有返回图片内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > MAX_IMAGE_BYTES) throw new Error("图片超过 12 MB");
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.length; });
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const mime = starts([137, 80, 78, 71, 13, 10, 26, 10]) ? "image/png"
    : starts([255, 216, 255]) ? "image/jpeg"
    : ["GIF87a", "GIF89a"].includes(ascii(0, 6)) ? "image/gif"
    : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "image/webp" : null;
  if (!mime) throw new Error("链接未返回支持的图片，仅支持 PNG、JPEG、WebP 和 GIF");
  const blob = new Blob([bytes], { type: mime });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取这张图片"));
    reader.readAsDataURL(blob);
  });
}
