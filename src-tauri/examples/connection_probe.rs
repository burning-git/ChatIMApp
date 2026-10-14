use std::{error::Error, time::Duration};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let endpoint = std::env::args().nth(1).expect("需要 API 地址");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    match client.head(endpoint).send().await {
        Ok(response) => println!("HTTP {}", response.status()),
        Err(error) => {
            eprintln!("{error}");
            let mut cause = error.source();
            while let Some(value) = cause {
                eprintln!("原因：{value}");
                cause = value.source();
            }
            std::process::exit(1);
        }
    }
}
