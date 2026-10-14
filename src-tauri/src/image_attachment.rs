use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Url;

pub const MAX_IMAGES: usize = 9;
const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;

fn image_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "请输入有效的图片链接".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("图片链接须以 http:// 或 https:// 开头，且不能包含账号密码".into());
    }
    Ok(url)
}

pub fn validate(images: &[String]) -> Result<(), String> {
    if images.len() > MAX_IMAGES {
        return Err(format!("每条消息最多添加 {MAX_IMAGES} 张图片"));
    }
    for image in images {
        if !image.starts_with("data:") {
            image_url(image)?;
            continue;
        }
        let encoded = [
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/webp;base64,",
            "data:image/gif;base64,",
        ]
        .iter()
        .find_map(|prefix| image.strip_prefix(prefix))
        .ok_or_else(|| "本地图片仅支持 PNG、JPEG、WebP 和 GIF".to_string())?;
        if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return Err("本地图片超过 12 MB".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "本地图片数据无效，请重新选择图片".to_string())?;
        if bytes.is_empty() {
            return Err("本地图片数据无效，请重新选择图片".into());
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("本地图片超过 12 MB".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_nine_mixed_images_without_converting_original_links() {
        let mut images = vec!["data:image/png;base64,aGVsbG8=".to_string()];
        images.extend(
            (0..8).map(|index| format!("https://example.test/photo?index={index}&signature=a%2Fb")),
        );
        let original = images.clone();
        validate(&images).unwrap();
        assert_eq!(images, original);
        images.push("http://example.test/image.jpg".into());
        assert!(validate(&images).unwrap_err().contains("9"));
    }
    #[test]
    fn rejects_invalid_links_and_local_image_payloads() {
        for image in [
            "file:///tmp/a.png",
            "javascript:alert(1)",
            "https://user:secret@example.test/a.png",
            "not a url",
            "data:image/svg+xml;base64,aGVsbG8=",
            "data:image/png;base64,broken!",
            "data:image/png;base64,",
        ] {
            assert!(validate(&[image.into()]).is_err(), "{image}");
        }
        let oversized = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(vec![0; MAX_IMAGE_BYTES + 1])
        );
        assert!(validate(&[oversized]).unwrap_err().contains("12 MB"));
    }
}
