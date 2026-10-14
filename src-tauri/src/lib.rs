use axum::{
    extract::{Path as AxumPath, State as AxumState},
    http::header,
    response::IntoResponse,
    routing::get,
    Router,
};
use chrono::{Local, SecondsFormat, Utc};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, Manager, State};

mod chat_stream;
mod image_attachment;
mod shared_page;
use tokio::{
    net::TcpListener,
    sync::{Mutex as AsyncMutex, RwLock},
};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    base_url: String,
    api_key: String,
    model: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            api_key: String::new(),
            model: "gpt-4o-mini".into(),
        }
    }
}

#[derive(Clone)]
struct AppState {
    data_dir: PathBuf,
    settings: Arc<Mutex<Settings>>,
    shares: Arc<RwLock<HashMap<String, String>>>,
    lan_port: Arc<AsyncMutex<Option<u16>>>,
    parallel_limit: Arc<tokio::sync::Semaphore>,
    pending_sessions: Arc<Mutex<HashSet<String>>>,
}

struct PendingRequest {
    id: String,
    sessions: Arc<Mutex<HashSet<String>>>,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&self.id);
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSession {
    id: String,
    title: String,
    system_prompt: String,
    #[serde(default = "default_stream")]
    stream: bool,
    #[serde(default = "default_temperature")]
    temperature: Option<f64>,
    created_at: String,
    updated_at: String,
    last_message: String,
}

fn default_stream() -> bool {
    true
}
fn default_temperature() -> Option<f64> {
    Some(0.0)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestOptions {
    stream: bool,
    temperature: Option<f64>,
}

fn validate_temperature(temperature: Option<f64>) -> Result<(), String> {
    if temperature.is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value)) {
        return Err("温度必须在 0 到 2 之间，或留空使用模型默认值".into());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessage {
    id: String,
    session_id: String,
    role: String,
    content: String,
    images: Vec<String>,
    created_at: String,
    #[serde(default)]
    reply_to_id: Option<String>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn database_path(state: &AppState, date: &str) -> PathBuf {
    state.data_dir.join(format!("{date}.sqlite"))
}

fn today_path(state: &AppState) -> PathBuf {
    database_path(state, &Local::now().format("%Y-%m-%d").to_string())
}

fn open_database(path: &PathBuf) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS sessions (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           system_prompt TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           last_message TEXT NOT NULL DEFAULT ''
         );
         CREATE TABLE IF NOT EXISTS messages (
           id TEXT PRIMARY KEY,
           session_id TEXT NOT NULL,
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           images TEXT NOT NULL DEFAULT '[]',
           created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS messages_session_time ON messages(session_id, created_at);",
    )
    .map_err(|e| e.to_string())?;
    for (table, column, definition) in [
        ("messages", "reply_to_id", "TEXT"),
        ("sessions", "stream", "INTEGER NOT NULL DEFAULT 1"),
        ("sessions", "temperature", "REAL DEFAULT 0"),
    ] {
        let has_column = {
            let mut columns = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .map_err(|e| e.to_string())?;
            let names = columns
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| e.to_string())?;
            let found = names.filter_map(Result::ok).any(|name| name == column);
            found
        };
        if !has_column {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(conn)
}

fn db_files(state: &AppState) -> Result<Vec<PathBuf>, String> {
    fs::create_dir_all(&state.data_dir).map_err(|e| e.to_string())?;
    let mut paths = fs::read_dir(&state.data_dir)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "sqlite"))
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn save_settings(state: &AppState, settings: &Settings) -> Result<(), String> {
    fs::create_dir_all(&state.data_dir).map_err(|e| e.to_string())?;
    let file = state.data_dir.join("settings.json");
    let temporary = state.data_dir.join("settings.json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    if file.exists() {
        fs::remove_file(&file).map_err(|e| e.to_string())?;
    }
    fs::rename(temporary, file).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    state
        .settings
        .lock()
        .map(|v| v.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    api_endpoint(&settings.base_url)?;
    if settings.api_key.trim().is_empty() || settings.model.trim().is_empty() {
        return Err("API Key 和模型名称不能为空".into());
    }
    save_settings(&state, &settings)?;
    *state.settings.lock().map_err(|e| e.to_string())? = settings;
    Ok(())
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<ChatSession>, String> {
    load_sessions(&state)
}

fn load_sessions(state: &AppState) -> Result<Vec<ChatSession>, String> {
    let mut sessions: HashMap<String, ChatSession> = HashMap::new();
    for path in db_files(&state)? {
        let conn = open_database(&path)?;
        let mut stmt = conn
            .prepare(
                "SELECT id,title,system_prompt,created_at,updated_at,last_message,stream,temperature FROM sessions",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ChatSession {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    system_prompt: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    last_message: r.get(5)?,
                    stream: r.get(6)?,
                    temperature: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let item = row.map_err(|e| e.to_string())?;
            let should_replace = sessions
                .get(&item.id)
                .map_or(true, |old| item.updated_at >= old.updated_at);
            if should_replace {
                sessions.insert(item.id.clone(), item);
            }
        }
    }
    let mut result = sessions.into_values().collect::<Vec<_>>();
    result.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(result)
}

#[tauri::command]
fn create_session(
    state: State<'_, AppState>,
    title: String,
    system_prompt: String,
) -> Result<ChatSession, String> {
    create_session_inner(&state, title, system_prompt)
}

fn create_session_inner(
    state: &AppState,
    title: String,
    system_prompt: String,
) -> Result<ChatSession, String> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let title = if title.trim().is_empty() {
        "新对话".to_string()
    } else {
        title.trim().to_string()
    };
    let conn = open_database(&today_path(&state))?;
    conn.execute("INSERT INTO sessions(id,title,system_prompt,created_at,updated_at,last_message,stream,temperature) VALUES(?1,?2,?3,?4,?4,'',1,0)",
        params![id, title, system_prompt, timestamp]).map_err(|e| e.to_string())?;
    Ok(ChatSession {
        id,
        title,
        system_prompt,
        stream: true,
        temperature: Some(0.0),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        last_message: String::new(),
    })
}

fn load_messages(state: &AppState, session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let mut messages = Vec::new();
    for path in db_files(state)? {
        let conn = open_database(&path)?;
        let mut stmt = conn.prepare("SELECT id,session_id,role,content,images,created_at,reply_to_id FROM messages WHERE session_id=?1 ORDER BY created_at, rowid")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([session_id], |r| {
                let images_json: String = r.get(4)?;
                Ok(ChatMessage {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    images: serde_json::from_str(&images_json).unwrap_or_default(),
                    created_at: r.get(5)?,
                    reply_to_id: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            messages.push(row.map_err(|e| e.to_string())?);
        }
    }
    messages.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut ordered = Vec::new();
    let linked: Vec<_> = messages
        .iter()
        .filter(|message| message.reply_to_id.is_some())
        .collect();
    for message in &messages {
        if message.reply_to_id.is_none() {
            ordered.push(message.clone());
            ordered.extend(
                linked
                    .iter()
                    .filter(|reply| reply.reply_to_id.as_deref() == Some(&message.id))
                    .map(|reply| (*reply).clone()),
            );
        }
    }
    Ok(ordered)
}

#[tauri::command]
fn get_messages(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    load_messages(&state, &session_id)
}

fn append_message(
    state: &AppState,
    session: &ChatSession,
    role: &str,
    content: &str,
    images: &[String],
) -> Result<ChatMessage, String> {
    let timestamp = now();
    let id = Uuid::new_v4().to_string();
    let image_json = serde_json::to_string(images).map_err(|e| e.to_string())?;
    let conn = open_database(&today_path(state))?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO sessions(id,title,system_prompt,created_at,updated_at,last_message,stream,temperature) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,system_prompt=excluded.system_prompt,updated_at=excluded.updated_at,last_message=excluded.last_message,stream=excluded.stream,temperature=excluded.temperature",
        params![session.id, session.title, session.system_prompt, session.created_at, timestamp, content, session.stream, session.temperature])
        .map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO messages(id,session_id,role,content,images,created_at) VALUES(?1,?2,?3,?4,?5,?6)",
        params![id, session.id, role, content, image_json, timestamp]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ChatMessage {
        id,
        session_id: session.id.clone(),
        role: role.into(),
        content: content.into(),
        images: images.to_vec(),
        created_at: timestamp,
        reply_to_id: None,
    })
}

fn retry_context(
    history: &[ChatMessage],
    message_id: &str,
) -> Result<(usize, Option<ChatMessage>), String> {
    let selected = history
        .iter()
        .position(|message| message.id == message_id)
        .ok_or_else(|| "找不到要重试的消息，请刷新会话后重试".to_string())?;
    let user_index = if history[selected].role == "user" {
        selected
    } else if let Some(user_id) = &history[selected].reply_to_id {
        history
            .iter()
            .position(|message| message.role == "user" && &message.id == user_id)
            .ok_or_else(|| "找不到这条回复对应的提问".to_string())?
    } else {
        (0..selected)
            .rev()
            .find(|&index| history[index].role == "user")
            .ok_or_else(|| "找不到这条回复对应的提问".to_string())?
    };
    let old_reply = if history[selected].role == "assistant" {
        Some(history[selected].clone())
    } else {
        history[user_index + 1..]
            .iter()
            .take_while(|message| message.role != "user")
            .find(|message| message.role == "assistant")
            .cloned()
    };
    Ok((user_index, old_reply))
}

fn save_reply(
    state: &AppState,
    session: &ChatSession,
    user_id: &str,
    old_reply: Option<ChatMessage>,
    content: &str,
) -> Result<ChatMessage, String> {
    let timestamp = now();
    let history = load_messages(state, &session.id)?;
    let preview = history
        .last()
        .map(|message| {
            if message.id == user_id || old_reply.as_ref().is_some_and(|old| old.id == message.id) {
                content.to_string()
            } else {
                message.content.clone()
            }
        })
        .unwrap_or_default();
    let today = today_path(state);
    let (mut saved, target) = if let Some(mut old) = old_reply {
        let mut target = None;
        for path in db_files(state)? {
            let conn = open_database(&path)?;
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND session_id=?2 AND role='assistant')",
                params![old.id, session.id], |row| row.get(0)
            ).map_err(|e| e.to_string())?;
            if exists {
                target = Some(path);
                break;
            }
        }
        let target = target.ok_or_else(|| "原回复不存在，请刷新会话后重试".to_string())?;
        old.content = content.into();
        old.images.clear();
        old.reply_to_id = Some(user_id.into());
        (old, target)
    } else {
        (
            ChatMessage {
                id: Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                role: "assistant".into(),
                content: content.into(),
                images: Vec::new(),
                created_at: timestamp.clone(),
                reply_to_id: Some(user_id.into()),
            },
            today.clone(),
        )
    };
    // Keep replacing a historic reply and updating today's session preview in
    // one transaction. The original message ID/time and later turns stay intact.
    let conn = open_database(&target)?;
    let sessions_table = if target != today {
        drop(open_database(&today)?);
        conn.execute(
            "ATTACH DATABASE ?1 AS current_day",
            [today.to_string_lossy().as_ref()],
        )
        .map_err(|e| e.to_string())?;
        "current_day.sessions"
    } else {
        "sessions"
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO messages(id,session_id,role,content,images,created_at,reply_to_id) VALUES(?1,?2,'assistant',?3,'[]',?4,?5)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content,images=excluded.images,reply_to_id=excluded.reply_to_id",
        params![saved.id, session.id, content, saved.created_at, user_id]).map_err(|e| e.to_string())?;
    tx.execute(&format!("INSERT INTO {sessions_table}(id,title,system_prompt,created_at,updated_at,last_message,stream,temperature) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,system_prompt=excluded.system_prompt,updated_at=excluded.updated_at,last_message=excluded.last_message,stream=excluded.stream,temperature=excluded.temperature"),
        params![session.id, session.title, session.system_prompt, session.created_at, timestamp, preview, session.stream, session.temperature]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    saved.reply_to_id = Some(user_id.into());
    Ok(saved)
}

fn find_session(state: &AppState, session_id: &str) -> Result<Option<ChatSession>, String> {
    let mut found = None;
    for path in db_files(state)? {
        let conn = open_database(&path)?;
        let row = conn.query_row("SELECT id,title,system_prompt,created_at,updated_at,last_message,stream,temperature FROM sessions WHERE id=?1", [session_id], |r| Ok(ChatSession {
            id: r.get(0)?, title: r.get(1)?, system_prompt: r.get(2)?, created_at: r.get(3)?, updated_at: r.get(4)?, last_message: r.get(5)?, stream: r.get(6)?, temperature: r.get(7)?,
        })).optional().map_err(|e| e.to_string())?;
        if let Some(item) = row {
            if found
                .as_ref()
                .map_or(true, |old: &ChatSession| item.updated_at >= old.updated_at)
            {
                found = Some(item);
            }
        }
    }
    Ok(found)
}

#[tauri::command]
fn update_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    system_prompt: String,
    request_options: Option<RequestOptions>,
) -> Result<(), String> {
    update_session_inner(&state, &session_id, &title, &system_prompt, request_options)
}

fn update_session_inner(
    state: &AppState,
    session_id: &str,
    title: &str,
    system_prompt: &str,
    request_options: Option<RequestOptions>,
) -> Result<(), String> {
    let session = find_session(state, session_id)?.ok_or_else(|| "找不到这个会话".to_string())?;
    let options = request_options.unwrap_or(RequestOptions {
        stream: session.stream,
        temperature: session.temperature,
    });
    validate_temperature(options.temperature)?;
    let cleaned_title = if title.trim().is_empty() {
        "新对话"
    } else {
        title.trim()
    };
    let mut updated = false;
    for path in db_files(&state)? {
        let conn = open_database(&path)?;
        let changed = conn
            .execute(
                "UPDATE sessions SET title=?2,system_prompt=?3,updated_at=?4,stream=?5,temperature=?6 WHERE id=?1",
                params![session_id, cleaned_title, system_prompt, now(), options.stream, options.temperature],
            )
            .map_err(|e| e.to_string())?;
        updated |= changed > 0;
    }
    if !updated {
        return Err("找不到这个会话".into());
    }
    Ok(())
}

#[tauri::command]
fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    if state
        .pending_sessions
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&session_id)
    {
        return Err("请等这个会话的回复完成后再删除".into());
    }
    for path in db_files(&state)? {
        let conn = open_database(&path)?;
        conn.execute("DELETE FROM messages WHERE session_id=?1", [&session_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM sessions WHERE id=?1", [&session_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn api_endpoint(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先在设置中填写 API 地址".into());
    }
    let parsed = reqwest::Url::parse(base).map_err(|_| "API 地址格式不正确".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
        return Err("API 地址必须以 http:// 或 https:// 开头".into());
    }
    if base.ends_with("/chat/completions") {
        Ok(base.into())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}

#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    images: Vec<String>,
    on_chunk: Channel<String>,
) -> Result<ChatMessage, String> {
    send_message_with_progress(&state, session_id, content, images, None, move |delta| {
        let _ = on_chunk.send(delta.to_string());
    })
    .await
}

#[tauri::command]
async fn retry_message(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
    on_chunk: Channel<String>,
) -> Result<ChatMessage, String> {
    send_message_with_progress(
        &state,
        session_id,
        String::new(),
        Vec::new(),
        Some(message_id),
        move |delta| {
            let _ = on_chunk.send(delta.to_string());
        },
    )
    .await
}

fn network_error(error: &reqwest::Error) -> String {
    let mut details = Vec::new();
    let mut cause = std::error::Error::source(error);
    while let Some(value) = cause {
        let detail = value.to_string();
        if !details.contains(&detail) {
            details.push(detail);
        }
        cause = value.source();
    }
    let reason = details.last().cloned().unwrap_or_else(|| error.to_string());
    if error.is_timeout() {
        format!("请求超时，请检查网络或系统代理后重试。{reason}")
    } else if error.is_connect() {
        format!("连接失败：{reason}。请确认系统代理正在运行，或检查 API 地址后重试")
    } else {
        format!("请求失败：{reason}")
    }
}

#[cfg(test)]
async fn send_message_inner(
    state: &AppState,
    session_id: String,
    content: String,
    images: Vec<String>,
    retry_message_id: Option<String>,
) -> Result<ChatMessage, String> {
    send_message_with_progress(state, session_id, content, images, retry_message_id, |_| {}).await
}

async fn send_message_with_progress(
    state: &AppState,
    session_id: String,
    content: String,
    images: Vec<String>,
    retry_message_id: Option<String>,
    mut on_chunk: impl FnMut(&str) + Send,
) -> Result<ChatMessage, String> {
    if retry_message_id.is_none() && content.trim().is_empty() && images.is_empty() {
        return Err("请先输入文字或添加图片".into());
    }
    if images.len() > 4
        || images.iter().any(|image| {
            image.len() > 17 * 1024 * 1024
                || !(image.starts_with("data:image/png;base64,")
                    || image.starts_with("data:image/jpeg;base64,")
                    || image.starts_with("data:image/webp;base64,")
                    || image.starts_with("data:image/gif;base64,"))
        })
    {
        return Err(
            "每条消息最多 4 张图片，仅支持 PNG、JPEG、WebP 和 GIF，每张不超过 12 MB".into(),
        );
    }
    let _permit = state
        .parallel_limit
        .clone()
        .try_acquire_owned()
        .map_err(|_| "最多可同时进行 8 个对话，请等一个回复完成".to_string())?;
    {
        let mut sessions = state.pending_sessions.lock().map_err(|e| e.to_string())?;
        if !sessions.insert(session_id.clone()) {
            return Err("此会话正在回复中".into());
        }
    }
    let _pending = PendingRequest {
        id: session_id.clone(),
        sessions: state.pending_sessions.clone(),
    };
    let session = find_session(&state, &session_id)?.ok_or_else(|| "找不到这个会话".to_string())?;
    let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
    let endpoint = api_endpoint(&settings.base_url)?;
    validate_temperature(session.temperature)?;
    if settings.api_key.trim().is_empty() {
        return Err("请先在设置中填写 API Key".into());
    }

    let (history, old_reply) = if let Some(message_id) = retry_message_id {
        let mut history = load_messages(state, &session_id)?;
        let (user_index, old_reply) = retry_context(&history, &message_id)?;
        history.truncate(user_index + 1);
        (history, old_reply)
    } else {
        append_message(state, &session, "user", &content, &images)?;
        (load_messages(state, &session_id)?, None)
    };
    let user_id = history
        .last()
        .ok_or_else(|| "找不到提问内容".to_string())?
        .id
        .clone();
    let mut prompt_messages = Vec::new();
    if !session.system_prompt.trim().is_empty() {
        prompt_messages.push(json!({ "role": "system", "content": session.system_prompt.clone() }));
    }
    for message in history {
        if message.role == "user" && !message.images.is_empty() {
            let mut parts = vec![json!({"type":"text", "text": message.content})];
            parts.extend(
                message
                    .images
                    .iter()
                    .map(|url| json!({"type":"image_url", "image_url":{"url":url}})),
            );
            prompt_messages.push(json!({"role":"user", "content":parts}));
        } else {
            prompt_messages.push(json!({"role":message.role, "content":message.content}));
        }
    }
    let client = Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let mut body =
        json!({ "model": settings.model, "messages": prompt_messages, "stream": session.stream });
    if let Some(temperature) = session.temperature {
        body["temperature"] = json!(temperature);
    }
    let mut response = client
        .post(endpoint)
        .json(&body)
        .bearer_auth(settings.api_key.trim())
        .send()
        .await
        .map_err(|e| network_error(&e))?;
    let status = response.status();
    let json_response = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("application/json"));
    let reply = if status.is_success() && session.stream && !json_response {
        let mut stream = chat_stream::ChatStream::default();
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|e| format!("读取流式响应失败：{}", network_error(&e)))?
        {
            for delta in stream.push(&bytes)? {
                on_chunk(&delta);
            }
            if stream.is_done() {
                break;
            }
        }
        for delta in stream.finish()? {
            on_chunk(&delta);
        }
        stream.content
    } else {
        let raw = response
            .text()
            .await
            .map_err(|e| format!("无法读取服务响应：{e}"))?;
        let body: Value = serde_json::from_str(&raw).map_err(|_| {
            format!("服务返回非 JSON 响应（{status}），请检查 API 地址或代理网关后重试")
        })?;
        if !status.is_success() {
            let detail = body
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .or_else(|| body.get("message").and_then(Value::as_str))
                .unwrap_or("服务返回了错误");
            return Err(format!("请求失败（{status}）：{detail}"));
        }
        body.pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                body.pointer("/choices/0/message/content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(|p| p.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "服务响应中没有找到回复内容".to_string())?
    };
    let latest_session =
        find_session(&state, &session_id)?.ok_or_else(|| "找不到这个会话".to_string())?;
    save_reply(state, &latest_session, &user_id, old_reply, &reply)
}

#[tauri::command]
async fn share_session(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    if find_session(&state, &session_id)?.is_none() {
        return Err("找不到这个会话".into());
    }
    let ip = local_ip_address::local_ip().map_err(|e| format!("无法读取本机局域网地址：{e}"))?;
    let mut port_guard = state.lan_port.lock().await;
    if port_guard.is_none() {
        let listener = TcpListener::bind(std::net::SocketAddr::new(ip, 0))
            .await
            .map_err(|e| format!("无法开启局域网访问：{e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let server_state = Arc::new(state.inner().clone());
        tauri::async_runtime::spawn(async move {
            let router = Router::new()
                .route("/s/:token", get(shared_page))
                .with_state(server_state);
            let _ = axum::serve(listener, router).await;
        });
        *port_guard = Some(port);
    }
    let port = (*port_guard).unwrap();
    drop(port_guard);
    let token = Uuid::new_v4().simple().to_string();
    state.shares.write().await.insert(token.clone(), session_id);
    let host = if ip.is_ipv6() {
        format!("[{ip}]")
    } else {
        ip.to_string()
    };
    Ok(format!("http://{host}:{port}/s/{token}"))
}

#[tauri::command]
async fn unshare_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.shares.write().await.retain(|_, id| id != &session_id);
    Ok(())
}

async fn shared_page(
    AxumPath(token): AxumPath<String>,
    AxumState(state): AxumState<Arc<AppState>>,
) -> impl IntoResponse {
    let session_id = state.shares.read().await.get(&token).cloned();
    let Some(session_id) = session_id else {
        return (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "链接无效或已失效".to_string(),
        );
    };
    let session = match find_session(&state, &session_id) {
        Ok(Some(value)) => value,
        _ => {
            return (
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "会话不存在".to_string(),
            )
        }
    };
    let messages = match load_messages(&state, &session_id) {
        Ok(value) => value,
        _ => {
            return (
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                "无法读取会话记录".to_string(),
            )
        }
    };
    let html = shared_page::render(&session, &messages);
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html)
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?.join("data");
            fs::create_dir_all(&data_dir)?;
            let settings = fs::read(data_dir.join("settings.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
                .unwrap_or_default();
            app.manage(AppState {
                data_dir,
                settings: Arc::new(Mutex::new(settings)),
                shares: Arc::new(RwLock::new(HashMap::new())),
                lan_port: Arc::new(AsyncMutex::new(None)),
                parallel_limit: Arc::new(tokio::sync::Semaphore::new(8)),
                pending_sessions: Arc::new(Mutex::new(HashSet::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            image_attachment::load_image_url,
            get_settings,
            set_settings,
            list_sessions,
            create_session,
            update_session,
            delete_session,
            get_messages,
            send_message,
            retry_message,
            share_session,
            unshare_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Echo desktop app");
}

// Compile the patched dependency's cancellation tests in our own test suite,
// without adding Wry's unrelated example/GPU development dependencies.
#[cfg(test)]
#[allow(dead_code)]
#[rustfmt::skip]
#[path = "../vendor/wry/src/util.rs"]
mod file_picker_regressions;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_sessions_persist_defaults_even_with_old_schema_defaults() {
        let state = test_state();
        let conn = Connection::open(today_path(&state)).unwrap();
        conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,system_prompt TEXT,created_at TEXT,updated_at TEXT,last_message TEXT,stream INTEGER NOT NULL DEFAULT 0,temperature REAL);
            INSERT INTO sessions VALUES('saved','已设置','','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z','',0,NULL);").unwrap();
        drop(conn);
        let session = create_session_inner(&state, "  新会话  ".into(), "专属指令".into()).unwrap();
        assert!(session.stream);
        assert_eq!(session.temperature, Some(0.0));
        let stored = find_session(&state, &session.id).unwrap().unwrap();
        assert!(stored.stream);
        assert_eq!(stored.temperature, Some(0.0));
        assert_eq!(stored.title, "新会话");
        assert_eq!(stored.system_prompt, "专属指令");
        let saved = find_session(&state, "saved").unwrap().unwrap();
        assert!(!saved.stream);
        assert_eq!(saved.temperature, None);
        fs::remove_dir_all(state.data_dir).unwrap();
    }

    #[test]
    fn request_options_migrate_and_stay_independent_across_days() {
        let state = test_state();
        let legacy = Connection::open(database_path(&state, "2000-01-01")).unwrap();
        legacy.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,system_prompt TEXT,created_at TEXT,updated_at TEXT,last_message TEXT);
            INSERT INTO sessions VALUES('first','旧会话','','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z','');").unwrap();
        drop(legacy);
        let first = find_session(&state, "first").unwrap().unwrap();
        assert!(first.stream);
        assert_eq!(first.temperature, Some(0.0));
        update_session_inner(
            &state,
            "first",
            "旧会话",
            "指令",
            Some(RequestOptions {
                stream: true,
                temperature: Some(0.0),
            }),
        )
        .unwrap();
        update_session_inner(&state, "first", "自动改名", "指令", None).unwrap();
        let first = find_session(&state, "first").unwrap().unwrap();
        append_message(&state, &first, "user", "跨日消息", &[]).unwrap();
        let mut second = first.clone();
        second.id = "second".into();
        second.stream = false;
        second.temperature = Some(2.0);
        append_message(&state, &second, "user", "另一个会话", &[]).unwrap();
        let sessions = load_sessions(&state).unwrap();
        let saved = sessions
            .iter()
            .find(|session| session.id == "first")
            .unwrap();
        assert!(saved.stream);
        assert_eq!(saved.temperature, Some(0.0));
        assert_eq!(saved.title, "自动改名");
        assert_eq!(
            sessions
                .iter()
                .find(|session| session.id == "second")
                .unwrap()
                .temperature,
            Some(2.0)
        );
        for temperature in [-0.1, 2.1, f64::NAN, f64::INFINITY] {
            assert!(update_session_inner(
                &state,
                "first",
                "错误配置",
                "",
                Some(RequestOptions {
                    stream: false,
                    temperature: Some(temperature)
                })
            )
            .is_err());
        }
        assert_eq!(
            find_session(&state, "first").unwrap().unwrap().temperature,
            Some(0.0)
        );
        fs::remove_dir_all(state.data_dir).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streamed_http_updates_before_completion_and_failed_retry_keeps_original() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = requests.clone();
        let (progress_tx, progress_rx) = tokio::sync::oneshot::channel();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut progress_rx = Some(progress_rx);
            for attempt in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (header_end, length) = loop {
                    let mut buffer = [0u8; 4096];
                    let read = socket.read(&mut buffer).await.unwrap();
                    assert!(read > 0);
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&request[..end]);
                        let length: usize = header
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|length| length.trim().parse().unwrap())
                            })
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            break (end + 4, length);
                        }
                    }
                };
                captured.lock().unwrap().push(
                    serde_json::from_slice(&request[header_end..header_end + length]).unwrap(),
                );
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
                let piece = format!("data: {{\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"片段{attempt}你好\"}}}}]}}\n\n");
                socket
                    .write_all(format!("{:x}\r\n{}\r\n", piece.len(), piece).as_bytes())
                    .await
                    .unwrap();
                if attempt == 0 {
                    // The server cannot finish until the client displays a delta.
                    progress_rx.take().unwrap().await.unwrap();
                }
                if attempt != 1 {
                    let end = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                    socket
                        .write_all(format!("{:x}\r\n{}\r\n", end.len(), end).as_bytes())
                        .await
                        .unwrap();
                }
                socket.write_all(b"0\r\n\r\n").await.unwrap();
            }
        });
        let state = test_state();
        *state.settings.lock().unwrap() = Settings {
            base_url: format!("http://{address}/v1"),
            api_key: "test".into(),
            model: "test".into(),
        };
        let session = ChatSession {
            id: "s".into(),
            title: "流式测试".into(),
            system_prompt: "".into(),
            stream: true,
            temperature: Some(0.7),
            created_at: now(),
            updated_at: now(),
            last_message: "".into(),
        };
        let question = append_message(&state, &session, "user", "原问题", &[]).unwrap();
        let mut progress_tx = Some(progress_tx);
        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            send_message_with_progress(
                &state,
                "s".into(),
                "".into(),
                vec![],
                Some(question.id.clone()),
                |delta| {
                    assert_eq!(delta, "片段0你好");
                    assert_eq!(load_messages(&state, "s").unwrap().len(), 1);
                    progress_tx.take().unwrap().send(()).unwrap();
                },
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(reply.content, "片段0你好");
        append_message(&state, &session, "user", "后续问题", &[]).unwrap();
        append_message(&state, &session, "assistant", "后续回复", &[]).unwrap();
        let original = load_messages(&state, "s").unwrap();
        let error = send_message_with_progress(
            &state,
            "s".into(),
            "".into(),
            vec![],
            Some(reply.id.clone()),
            |_| {},
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("中断"));
        assert_eq!(
            serde_json::to_value(load_messages(&state, "s").unwrap()).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        send_message_with_progress(
            &state,
            "s".into(),
            "".into(),
            vec![],
            Some(reply.id.clone()),
            |_| {
                // Changes during generation apply to the next request and survive saving this reply.
                update_session_inner(
                    &state,
                    "s",
                    "新名称",
                    "新指令",
                    Some(RequestOptions {
                        stream: false,
                        temperature: None,
                    }),
                )
                .unwrap();
            },
        )
        .await
        .unwrap();
        let saved = load_messages(&state, "s").unwrap();
        assert_eq!(saved[1].id, reply.id);
        assert_eq!(saved[1].content, "片段2你好");
        assert_eq!(
            serde_json::to_value(&saved[2..]).unwrap(),
            serde_json::to_value(&original[2..]).unwrap()
        );
        let latest = find_session(&state, "s").unwrap().unwrap();
        assert!(!latest.stream);
        assert_eq!(latest.temperature, None);
        assert_eq!(latest.last_message, "后续回复");
        assert_eq!(state.parallel_limit.available_permits(), 8);
        assert!(state.pending_sessions.lock().unwrap().is_empty());
        for body in requests.lock().unwrap().iter() {
            assert_eq!(body["stream"], true);
            assert_eq!(body["temperature"], 0.7);
            assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        }
        server.await.unwrap();
        fs::remove_dir_all(state.data_dir).unwrap();
    }

    fn test_state() -> AppState {
        let data_dir = std::env::temp_dir().join(format!("echo-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&data_dir).unwrap();
        AppState {
            data_dir,
            settings: Arc::new(Mutex::new(Settings::default())),
            shares: Arc::new(RwLock::new(HashMap::new())),
            lan_port: Arc::new(AsyncMutex::new(None)),
            parallel_limit: Arc::new(tokio::sync::Semaphore::new(8)),
            pending_sessions: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    #[test]
    fn merges_one_session_across_daily_databases() {
        let state = test_state();
        let old = open_database(&database_path(&state, "2000-01-01")).unwrap();
        old.execute("INSERT INTO sessions(id,title,system_prompt,created_at,updated_at,last_message) VALUES('s','跨天会话','独立指令','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z','昨日问题')", []).unwrap();
        old.execute(
            "INSERT INTO messages(id,session_id,role,content,images,created_at) VALUES('m','s','user','昨日问题','[]','2000-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        drop(old);
        let session = find_session(&state, "s").unwrap().unwrap();
        let reply = append_message(&state, &session, "assistant", "今日回复", &[]).unwrap();
        let sessions = load_sessions(&state).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].created_at, "2000-01-01T00:00:00Z");
        assert_eq!(sessions[0].updated_at, reply.created_at);
        assert_eq!(sessions[0].last_message, "今日回复");
        let messages = load_messages(&state, "s").unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "昨日问题");
        assert_eq!(messages[1].content, "今日回复");
        fs::remove_dir_all(state.data_dir).unwrap();
    }

    #[test]
    fn serializes_base64_images_and_keeps_session_metadata() {
        let state = test_state();
        let session = ChatSession {
            id: "test".into(),
            title: "视觉测试".into(),
            system_prompt: "看图回答".into(),
            stream: false,
            temperature: None,
            created_at: now(),
            updated_at: now(),
            last_message: String::new(),
        };
        let images = vec!["data:image/png;base64,aGVsbG8=".into()];
        append_message(&state, &session, "user", "这是什么？", &images).unwrap();
        assert_eq!(load_messages(&state, "test").unwrap()[0].images, images);
        assert_eq!(
            find_session(&state, "test").unwrap().unwrap().system_prompt,
            "看图回答"
        );
        fs::remove_dir_all(state.data_dir).unwrap();
    }

    #[test]
    fn escapes_shared_html_and_accepts_valid_endpoint_variants() {
        assert_eq!(
            html_escape("<script>\"&'</script>"),
            "&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;"
        );
        assert_eq!(
            api_endpoint("https://example.test/v1/").unwrap(),
            "https://example.test/v1/chat/completions"
        );
        assert_eq!(
            api_endpoint("http://localhost:8080/v1/chat/completions").unwrap(),
            "http://localhost:8080/v1/chat/completions"
        );
        assert!(api_endpoint("file:///secret").is_err());
        assert!(api_endpoint("invalid URL").is_err());
    }

    #[test]
    fn pending_request_releases_session_on_drop() {
        let sessions = Arc::new(Mutex::new(HashSet::from(["s".to_string()])));
        {
            let _pending = PendingRequest {
                id: "s".into(),
                sessions: sessions.clone(),
            };
            assert!(sessions.lock().unwrap().contains("s"));
        }
        assert!(sessions.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retry_preserves_one_user_message_and_its_images() {
        let captured = Arc::new(Mutex::new(Vec::<Value>::new()));
        let capture = captured.clone();
        let router = Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let capture = capture.clone();
                async move {
                    let attempt = {
                        let mut requests = capture.lock().unwrap();
                        requests.push(body);
                        requests.len()
                    };
                    if attempt == 1 {
                        (
                            axum::http::StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(json!({"error":{"message":"临时故障"}})),
                        )
                    } else {
                        (
                            axum::http::StatusCode::OK,
                            axum::Json(json!({"choices":[{"message":{"content":"恢复成功"}}]})),
                        )
                    }
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let state = test_state();
        *state.settings.lock().unwrap() = Settings {
            base_url: format!("http://{address}/v1"),
            api_key: "test-key".into(),
            model: "test".into(),
        };
        let conn = open_database(&today_path(&state)).unwrap();
        conn.execute(
            "INSERT INTO sessions(id,title,system_prompt,created_at,updated_at,last_message) VALUES('s','重试会话','看图回答',?1,?1,'')",
            [now()],
        )
        .unwrap();
        drop(conn);
        let image = "data:image/png;base64,aGVsbG8=".to_string();
        let failure = send_message_inner(
            &state,
            "s".into(),
            "保留这个问题".into(),
            vec![image.clone()],
            None,
        )
        .await;
        assert!(failure.err().unwrap().contains("临时故障"));
        assert!(state.pending_sessions.lock().unwrap().is_empty());
        assert_eq!(state.parallel_limit.available_permits(), 8);
        let original = load_messages(&state, "s").unwrap().remove(0);
        let reply = send_message_inner(
            &state,
            "s".into(),
            String::new(),
            Vec::new(),
            Some(original.id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(reply.content, "恢复成功");
        let history = load_messages(&state, "s").unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].id, original.id);
        assert_eq!(history[0].images, vec![image]);
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
        drop(requests);
        assert!(send_message_inner(
            &state,
            "s".into(),
            String::new(),
            Vec::new(),
            Some("missing-message".into())
        )
        .await
        .is_err());
        assert_eq!(captured.lock().unwrap().len(), 2);
        server.abort();
        fs::remove_dir_all(state.data_dir).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn retries_historic_turns_without_losing_later_messages_across_daily_databases() {
        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let capture = requests.clone();
        let router = Router::new().route("/v1/chat/completions", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let capture = capture.clone();
            async move {
                let attempt = { let mut requests = capture.lock().unwrap(); requests.push(body); requests.len() };
                if attempt == 1 {
                    (axum::http::StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({"error":{"message":"临时故障"}})))
                } else {
                    (axum::http::StatusCode::OK, axum::Json(json!({"choices":[{"message":{"content":format!("新回复{attempt}")}}]})))
                }
            }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let state = test_state();
        *state.settings.lock().unwrap() = Settings {
            base_url: format!("http://{address}/v1"),
            api_key: "test".into(),
            model: "vision".into(),
        };
        // Build a pre-0.1.3 daily database without reply_to_id.
        let conn = Connection::open(database_path(&state, "2000-01-01")).unwrap();
        conn.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,system_prompt TEXT,created_at TEXT,updated_at TEXT,last_message TEXT);
            CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,images TEXT,created_at TEXT);
            INSERT INTO sessions VALUES('s','历史会话','看图回答','2000-01-01T00:00:00Z','2000-01-01T00:00:03Z','原回复');
            INSERT INTO messages VALUES('u0','s','user','尚未回复','[]','2000-01-01T00:00:00Z');
            INSERT INTO messages VALUES('u1','s','user','看图','[\"data:image/png;base64,aGVsbG8=\"]','2000-01-01T00:00:01Z');
            INSERT INTO messages VALUES('a1','s','assistant','原回复','[]','2000-01-01T00:00:02Z');").unwrap();
        drop(conn);
        let conn = open_database(&database_path(&state, "2000-01-02")).unwrap();
        conn.execute_batch("INSERT INTO sessions(id,title,system_prompt,created_at,updated_at,last_message) VALUES('s','历史会话','看图回答','2000-01-01T00:00:00Z','2000-01-02T00:00:02Z','后续回复');
            INSERT INTO messages(id,session_id,role,content,images,created_at) VALUES('u2','s','user','后续问题','[]','2000-01-02T00:00:01Z');
            INSERT INTO messages(id,session_id,role,content,images,created_at) VALUES('a2','s','assistant','后续回复','[]','2000-01-02T00:00:02Z');").unwrap();
        drop(conn);
        let original = load_messages(&state, "s").unwrap();
        let failed = send_message_inner(
            &state,
            "s".into(),
            String::new(),
            Vec::new(),
            Some("a1".into()),
        )
        .await;
        assert!(failed.is_err());
        assert_eq!(
            serde_json::to_value(load_messages(&state, "s").unwrap()).unwrap(),
            serde_json::to_value(&original).unwrap()
        );
        assert_eq!(state.parallel_limit.available_permits(), 8);
        send_message_inner(
            &state,
            "s".into(),
            String::new(),
            Vec::new(),
            Some("u1".into()),
        )
        .await
        .unwrap();
        send_message_inner(
            &state,
            "s".into(),
            String::new(),
            Vec::new(),
            Some("a1".into()),
        )
        .await
        .unwrap();
        let saved = load_messages(&state, "s").unwrap();
        assert_eq!(
            saved.iter().map(|message| &message.id).collect::<Vec<_>>(),
            original
                .iter()
                .map(|message| &message.id)
                .collect::<Vec<_>>()
        );
        assert_eq!(saved[2].content, "新回复3");
        assert_eq!(saved[2].created_at, original[2].created_at);
        assert_eq!(
            serde_json::to_value(&saved[3..]).unwrap(),
            serde_json::to_value(&original[3..]).unwrap()
        );
        assert_eq!(saved[1].images, original[1].images);
        assert_eq!(
            find_session(&state, "s").unwrap().unwrap().last_message,
            "后续回复"
        );
        {
            let requests = requests.lock().unwrap();
            assert_eq!(requests[0], requests[1]);
            assert_eq!(requests[1], requests[2]);
            assert_eq!(requests[2]["messages"].as_array().unwrap().len(), 3);
            assert_eq!(
                requests[2]["messages"][2]["content"][1]["image_url"]["url"],
                "data:image/png;base64,aGVsbG8="
            );
        }
        // Filling an older unanswered turn inserts its new reply after that
        // question, even though the physical row belongs to today's database.
        send_message_inner(
            &state,
            "s".into(),
            String::new(),
            Vec::new(),
            Some("u0".into()),
        )
        .await
        .unwrap();
        let filled = load_messages(&state, "s").unwrap();
        assert_eq!(filled.len(), 6);
        assert_eq!(filled[0].id, "u0");
        assert_eq!(filled[1].content, "新回复4");
        assert_eq!(
            serde_json::to_value(&filled[2..]).unwrap(),
            serde_json::to_value(&saved[1..]).unwrap()
        );
        assert_eq!(
            find_session(&state, "s").unwrap().unwrap().last_message,
            "后续回复"
        );
        assert!(state.pending_sessions.lock().unwrap().is_empty());
        server.abort();
        fs::remove_dir_all(state.data_dir).unwrap();
    }
}
