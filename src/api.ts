import type { ChatMessage, ChatSession, ModelProfile, Settings } from "./types";
import { readChatStream } from "./chat-stream";
import { validateImages, validateImageUrl } from "./image-url";

type RequestOptions = Pick<ChatSession, "stream" | "temperature" | "modelId">;

type TauriGlobal = {
  core?: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>; Channel?: new () => { onmessage: (delta: string) => void } };
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

const tauri = (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__;
const tauriInternals = (window as Window & { __TAURI_INTERNALS__?: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> } }).__TAURI_INTERNALS__;
const invoke = <T>(command: string, args?: Record<string, unknown>) => tauri?.core?.invoke<T>(command, args) || tauri?.invoke?.<T>(command, args) || tauriInternals?.invoke<T>(command, args) || Promise.reject(new Error("桌面桥接未就绪"));
export const desktop = Boolean(tauri?.core?.invoke || tauri?.invoke || tauriInternals?.invoke);
const LEGACY_MODEL_ID = "legacy-default";
const DEFAULT_SETTINGS: Settings = {
  baseUrl: "", apiKey: "", model: "gpt-4o-mini", defaultModelId: LEGACY_MODEL_ID,
  models: [{ id: LEGACY_MODEL_ID, name: "默认模型", baseUrl: "", apiKey: "", model: "gpt-4o-mini" }],
};
const prefix = "echo-day-";
const pending = new Set<string>();

function validateTemperature(value: number | null) {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 2)) {
    throw new Error("温度必须在 0 到 2 之间，或留空使用模型默认值");
  }
}

function normalizeSettings(value: Partial<Settings> & { models?: ModelProfile[] }): Settings {
  const legacyId = LEGACY_MODEL_ID;
  const models = value.models?.length ? value.models : [{
    id: legacyId, name: "默认模型", baseUrl: value.baseUrl || "", apiKey: value.apiKey || "", model: value.model || "gpt-4o-mini",
  }];
  const selected = models.find(profile => profile.id === value.defaultModelId) || models[0];
  return { baseUrl: selected.baseUrl, apiKey: selected.apiKey, model: selected.model, models, defaultModelId: selected.id };
}

function selectedProfile(settings: Settings, modelId: string): ModelProfile {
  const profile = settings.models.find(item => item.id === modelId);
  if (!profile) throw new Error("这个会话使用的模型已不存在，请在会话设置中重新选择");
  return profile;
}

async function invokeMessage(command: string, args: Record<string, unknown>, onChunk?: (delta: string) => void) {
  const Channel = tauri?.core?.Channel;
  if (!Channel) throw new Error("桌面流式桥接未就绪，请重新启动应用");
  const channel = new Channel();
  let active = true;
  channel.onmessage = delta => { if (active) onChunk?.(delta); };
  try { return await invoke<ChatMessage>(command, { ...args, onChunk: channel }); }
  finally { active = false; }
}

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readDay(key = prefix + today()): { sessions: ChatSession[]; messages: ChatMessage[] } {
  const value = localStorage.getItem(key);
  return value ? JSON.parse(value) : { sessions: [], messages: [] };
}

function allDays() {
  return Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort().map(key => ({ key, ...readDay(key) }));
}

function writeSession(session: ChatSession) {
  const day = readDay();
  day.sessions = day.sessions.filter(item => item.id !== session.id);
  day.sessions.push(session);
  localStorage.setItem(prefix + today(), JSON.stringify(day));
}

function append(session: ChatSession, role: ChatMessage["role"], content: string, images: string[], replyToId?: string, model?: string): ChatMessage {
  const message: ChatMessage = { id: crypto.randomUUID(), sessionId: session.id, role, content, images, createdAt: new Date().toISOString(), ...(replyToId ? { replyToId } : {}), ...(model ? { model } : {}) };
  const day = readDay();
  day.messages.push(message);
  day.sessions = day.sessions.filter(item => item.id !== session.id);
  day.sessions.push({ ...session, updatedAt: message.createdAt, lastMessage: content });
  localStorage.setItem(prefix + today(), JSON.stringify(day));
  return message;
}

function orderedMessages(messages: ChatMessage[]): ChatMessage[] {
  const linked = messages.filter(message => message.replyToId);
  return messages.filter(message => !message.replyToId).flatMap(message => [message, ...linked.filter(reply => reply.replyToId === message.id)]);
}

function retryContext(history: ChatMessage[], messageId: string) {
  const selectedIndex = history.findIndex(message => message.id === messageId);
  if (selectedIndex < 0) throw new Error("找不到要重试的消息，请刷新会话后重试");
  const selected = history[selectedIndex];
  const user = selected.role === "user" ? selected
    : selected.replyToId ? history.find(message => message.role === "user" && message.id === selected.replyToId)
    : history.slice(0, selectedIndex).reverse().find(message => message.role === "user");
  if (!user) throw new Error("找不到这条回复对应的提问");
  const userIndex = history.indexOf(user);
  const following = history.slice(userIndex + 1);
  const nextUser = following.findIndex(message => message.role === "user");
  const oldReply = selected.role === "assistant" ? selected : following.slice(0, nextUser < 0 ? undefined : nextUser).find(message => message.role === "assistant");
  return { user, oldReply, history: history.slice(0, userIndex + 1) };
}

async function saveReply(session: ChatSession, userId: string, oldReply: ChatMessage | undefined, content: string, model: string): Promise<ChatMessage> {
  let saved: ChatMessage;
  if (oldReply) {
    const day = allDays().find(day => day.messages.some(message => message.id === oldReply.id && message.sessionId === session.id));
    if (!day) throw new Error("原回复不存在，请刷新会话后重试");
    saved = { ...oldReply, content, images: [], replyToId: userId, model };
    day.messages = day.messages.map(message => message.id === oldReply.id ? saved : message);
    localStorage.setItem(day.key, JSON.stringify({ sessions: day.sessions, messages: day.messages }));
  } else {
    saved = append(session, "assistant", content, [], userId, model);
  }
  const history = await api.messages(session.id);
  writeSession({ ...session, updatedAt: new Date().toISOString(), lastMessage: history[history.length - 1]?.content || "" });
  return saved;
}

export const api = {
  async imageFromUrl(value: string): Promise<string> {
    return validateImageUrl(value);
  },
  async copyText(text: string): Promise<void> {
    if (desktop) return invoke<void>("plugin:clipboard-manager|write_text", { text });
    if (!navigator.clipboard?.writeText) throw new Error("此浏览器无法访问剪贴板，请选中文字后复制");
    await navigator.clipboard.writeText(text);
  },
  async settings(): Promise<Settings> {
    if (desktop) return normalizeSettings(await invoke<Settings>("get_settings"));
    const value = localStorage.getItem("echo-settings");
    return value ? normalizeSettings(JSON.parse(value)) : DEFAULT_SETTINGS;
  },
  async saveSettings(settings: Settings): Promise<void> {
    const normalized = normalizeSettings(settings);
    if (desktop) return invoke<void>("set_settings", { settings: normalized });
    const sessions = await api.sessions();
    const ids = new Set(normalized.models.map(profile => profile.id));
    if (ids.size !== normalized.models.length || normalized.models.some(profile => !profile.id)) throw new Error("模型 ID 重复或无效，请重新添加模型");
    const inUse = sessions.find(session => !ids.has(session.modelId));
    if (inUse) throw new Error(`「${inUse.title}」正在使用被删除的模型，请先在会话设置中更换模型`);
    localStorage.setItem("echo-settings", JSON.stringify(normalized));
  },
  async sessions(): Promise<ChatSession[]> {
    if (desktop) return invoke<ChatSession[]>("list_sessions");
    const map = new Map<string, ChatSession>();
    const prefs = await api.settings();
    allDays().forEach(day => {
      let migrated = false;
      day.sessions = day.sessions.map(saved => {
        if (!saved.modelId) { saved = { ...saved, modelId: prefs.defaultModelId }; migrated = true; }
        const session = { ...saved, stream: saved.stream ?? true, temperature: saved.temperature === undefined ? 0 : saved.temperature };
        const old = map.get(session.id);
        if (!old || session.updatedAt >= old.updatedAt) map.set(session.id, session);
        return saved;
      });
      if (migrated) localStorage.setItem(day.key, JSON.stringify({ sessions: day.sessions, messages: day.messages }));
    });
    return [...map.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async create(title = "新对话", systemPrompt = ""): Promise<ChatSession> {
    if (desktop) return invoke<ChatSession>("create_session", { title, systemPrompt });
    const time = new Date().toISOString();
    const prefs = await api.settings();
    const session: ChatSession = { id: crypto.randomUUID(), title, systemPrompt, stream: true, temperature: 0, modelId: prefs.defaultModelId, createdAt: time, updatedAt: time, lastMessage: "" };
    writeSession(session);
    return session;
  },
  async update(sessionId: string, title: string, systemPrompt: string, requestOptions?: RequestOptions): Promise<void> {
    if (requestOptions) validateTemperature(requestOptions.temperature);
    if (desktop) return invoke<void>("update_session", { sessionId, title, systemPrompt, requestOptions: requestOptions || null });
    const session = (await api.sessions()).find(item => item.id === sessionId);
    if (!session) throw new Error("找不到这个会话");
    if (requestOptions?.modelId) selectedProfile(await api.settings(), requestOptions.modelId);
    writeSession({ ...session, ...requestOptions, modelId: requestOptions?.modelId || session.modelId, title, systemPrompt, updatedAt: new Date().toISOString() });
  },
  async remove(sessionId: string): Promise<void> {
    if (desktop) {
      await invoke<void>("unshare_session", { sessionId });
      return invoke<void>("delete_session", { sessionId });
    }
    if (pending.has(sessionId)) throw new Error("请等这个会话的回复完成后再删除");
    allDays().forEach(day => {
      const sessions = day.sessions.filter(item => item.id !== sessionId);
      const messages = day.messages.filter(item => item.sessionId !== sessionId);
      if (sessions.length || messages.length) localStorage.setItem(day.key, JSON.stringify({ sessions, messages }));
      else localStorage.removeItem(day.key);
    });
  },
  async messages(sessionId: string): Promise<ChatMessage[]> {
    if (desktop) return invoke<ChatMessage[]>("get_messages", { sessionId });
    return orderedMessages(allDays().flatMap(day => day.messages).filter(message => message.sessionId === sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  },
  async retry(sessionId: string, messageId: string, onChunk?: (delta: string) => void): Promise<ChatMessage> {
    return api.send(sessionId, "", [], messageId, onChunk);
  },
  async send(sessionId: string, content: string, images: string[], retryMessageId?: string, onChunk?: (delta: string) => void): Promise<ChatMessage> {
    if (!retryMessageId) validateImages(images);
    if (desktop) return retryMessageId
      ? invokeMessage("retry_message", { sessionId, messageId: retryMessageId }, onChunk)
      : invokeMessage("send_message", { sessionId, content, images }, onChunk);
    if (pending.has(sessionId)) throw new Error("此会话正在回复中");
    if (pending.size >= 8) throw new Error("最多同时进行 8 个对话，请等待一个回复完成");
    pending.add(sessionId);
    try {
      const settings = await api.settings();
      const session = (await api.sessions()).find(item => item.id === sessionId);
      if (!session) throw new Error("找不到这个会话");
      const profile = selectedProfile(settings, session.modelId);
      if (!profile.baseUrl || !profile.apiKey) throw new Error("请先在设置中填写所选模型的 API 地址和 API Key");
      validateTemperature(session.temperature);
      let oldReply: ChatMessage | undefined;
      let history: ChatMessage[];
      if (retryMessageId) {
        const retry = retryContext(await api.messages(sessionId), retryMessageId);
        history = retry.history;
        oldReply = retry.oldReply;
      } else {
        append(session, "user", content, images);
        history = await api.messages(sessionId);
      }
      const userId = history[history.length - 1].id;
      const messages: unknown[] = session.systemPrompt ? [{ role: "system", content: session.systemPrompt }] : [];
      history.forEach(message => messages.push({
        role: message.role,
        content: message.images.length ? [{ type: "text", text: message.content }, ...message.images.map(url => ({ type: "image_url", image_url: { url } }))] : message.content,
      }));
      const base = profile.baseUrl.trim().replace(/\/$/, "");
      const endpoint = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
      const request = { model: profile.model, messages, stream: session.stream, ...(session.temperature !== null ? { temperature: session.temperature } : {}) };
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}`, Accept: session.stream ? "text/event-stream" : "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(180000) });
      const isJson = response.headers?.get("content-type")?.toLowerCase().includes("application/json");
      let reply: string;
      if (response.ok && session.stream && !isJson) {
        reply = await readChatStream(response, onChunk);
      } else {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message || `请求失败（${response.status}）`);
        const raw = body.choices?.[0]?.message?.content;
        reply = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part: { text?: string }) => part.text || "").join("\n") : "";
      }
      if (!reply) throw new Error("服务响应中没有找到回复内容");
      const latest = (await api.sessions()).find(item => item.id === sessionId);
      if (!latest) throw new Error("找不到这个会话");
      return await saveReply(latest, userId, oldReply, reply, profile.model);
    } finally {
      pending.delete(sessionId);
    }
  },
  async share(sessionId: string): Promise<string> {
    if (!desktop) throw new Error("局域网分享需要在桌面应用中开启；浏览器预览支持聊天和设置");
    return invoke<string>("share_session", { sessionId });
  },
  async unshare(sessionId: string): Promise<void> {
    if (desktop) return invoke<void>("unshare_session", { sessionId });
  },
};
