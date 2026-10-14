use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, Url};

const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;

fn image_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "请输入有效的图片链接".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("图片链接须以 http:// 或 https:// 开头，且不能包含账号密码".into());
    }
    Ok(url)
}

fn as_data_url(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 12 MB".into());
    }
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("链接未返回支持的图片，仅支持 PNG、JPEG、WebP 和 GIF".into());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn load_image_url(url: String) -> Result<String, String> {
    let url = image_url(&url)?;
    let client = Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("无法下载图片，请检查链接或网络：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("图片下载失败（{}）", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IMAGE_BYTES as u64)
    {
        return Err("图片超过 12 MB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取图片失败：{e}"))?
    {
        if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err("图片超过 12 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    as_data_url(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn downloads_images_without_auth_and_rejects_bad_http_results() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let png = include_bytes!("../icons/32x32.png");
        let server = tokio::spawn(async move {
            for attempt in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let mut buffer = [0; 4096];
                    let read = socket.read(&mut buffer).await.unwrap();
                    assert!(read > 0 && request.len() < 16384);
                    request.extend_from_slice(&buffer[..read]);
                }
                let header = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(header.starts_with("get /image.png"));
                assert!(!header.contains("authorization:"));
                assert!(!header.contains("cookie:"));
                let (status, body, size) = match attempt {
                    0 => ("200 OK", png.as_slice(), png.len()),
                    1 => ("200 OK", b"<html>not an image</html>".as_slice(), 25),
                    2 => ("404 Not Found", b"missing".as_slice(), 7),
                    _ => ("200 OK", b"".as_slice(), MAX_IMAGE_BYTES + 1),
                };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: image/png\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n");
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.write_all(body).await.unwrap();
            }
        });
        let url = format!("http://{address}/image.png");
        assert_eq!(
            load_image_url(url.clone()).await.unwrap(),
            as_data_url(png).unwrap()
        );
        assert!(load_image_url(url.clone())
            .await
            .unwrap_err()
            .contains("链接未返回支持的图片"));
        assert!(load_image_url(url.clone())
            .await
            .unwrap_err()
            .contains("404"));
        assert!(load_image_url(url).await.unwrap_err().contains("12 MB"));
        server.await.unwrap();
    }

    #[test]
    fn validates_urls_and_image_bytes_without_trusting_extensions() {
        assert!(image_url(" https://example.test/download?image=1 ").is_ok());
        for url in [
            "file:///tmp/a.png",
            "javascript:alert(1)",
            "https://user:secret@example.test/a.png",
            "not a url",
        ] {
            assert!(image_url(url).is_err());
        }
        assert!(as_data_url(b"\x89PNG\r\n\x1a\nimage")
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(as_data_url(&[0xff, 0xd8, 0xff, 0x00])
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        assert!(as_data_url(b"GIF89aimage")
            .unwrap()
            .starts_with("data:image/gif;base64,"));
        assert!(as_data_url(b"RIFF0000WEBPimage")
            .unwrap()
            .starts_with("data:image/webp;base64,"));
        assert!(as_data_url(b"<html>not an image</html>").is_err());
        assert!(as_data_url(&vec![0; MAX_IMAGE_BYTES + 1])
            .unwrap_err()
            .contains("12 MB"));
    }
}
