export const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const LOCAL_IMAGE_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,/;

export function validateImageUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try { url = new URL(trimmed); }
  catch { throw new Error("请输入有效的图片链接"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("图片链接须以 http:// 或 https:// 开头，且不能包含账号密码");
  }
  return trimmed;
}

export function validateImages(images: string[]): void {
  if (images.length > MAX_IMAGES) throw new Error(`每条消息最多添加 ${MAX_IMAGES} 张图片`);
  for (const image of images) {
    if (!image.startsWith("data:")) { validateImageUrl(image); continue; }
    const prefix = image.match(LOCAL_IMAGE_PREFIX)?.[0];
    if (!prefix) throw new Error("本地图片仅支持 PNG、JPEG、WebP 和 GIF");
    const encoded = image.slice(prefix.length);
    if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("本地图片数据无效或超过 12 MB");
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new Error("本地图片数据无效，请重新选择图片");
    }
    const bytes = encoded.length / 4 * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw new Error("本地图片超过 12 MB");
  }
}
