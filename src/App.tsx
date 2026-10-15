import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Activity, ArrowUp, AudioLines, Bookmark, Check, ChevronDown, ChevronRight,
  CircleHelp, Command, Copy, FileText, FolderClock, ImagePlus, Link2, LockKeyhole,
  MessageSquarePlus, PanelLeftClose, Plus, RotateCw, Search, Settings2, ShieldCheck,
  Sparkles, SquarePen, Trash2, X,
} from "lucide-react";
import { api, desktop } from "./api";
import { MAX_IMAGES } from "./image-url";
import { version as appVersion } from "../package.json";
import type { ChatMessage, ChatSession, Draft, ModelProfile, Settings } from "./types";

type Modal = "settings" | "prompt" | "delete" | "image-url" | null;
const EMPTY_SETTINGS: Settings = { baseUrl: "", apiKey: "", model: "gpt-4o-mini", defaultModelId: "legacy-default", models: [{ id: "legacy-default", name: "默认模型", baseUrl: "", apiKey: "", model: "gpt-4o-mini" }] };
const EMPTY_DRAFT: Draft = { text: "", images: [] };

function dateLabel(value: string) {
  const then = new Date(value);
  const today = new Date();
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const target = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  if (target.getTime() === day.getTime()) return "今天";
  if (target.getTime() === day.getTime() - 86400000) return "昨天";
  return then.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

async function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取这张图片"));
    reader.readAsDataURL(file);
  });
}

function App() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState("");
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const busyRef = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [retryTargets, setRetryTargets] = useState<Record<string, string>>({});
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [modal, setModal] = useState<Modal>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [streamDraft, setStreamDraft] = useState(true);
  const [temperatureDraft, setTemperatureDraft] = useState("0");
  const [modelDraft, setModelDraft] = useState("legacy-default");
  const [imageUrlDraft, setImageUrlDraft] = useState("");
  const [imageUrlError, setImageUrlError] = useState("");
  const [imageImports, setImageImports] = useState<string[]>([]);
  const imageImportsRef = useRef(new Set<string>());
  const [promptError, setPromptError] = useState("");
  const [streamingText, setStreamingText] = useState<Record<string, string>>({});
  const [settingsDraft, setSettingsDraft] = useState<Settings>(EMPTY_SETTINGS);
  const [copiedShareUrl, setCopiedShareUrl] = useState("");
  const [sharePending, setSharePending] = useState<string[]>([]);
  const sharePendingRef = useRef(new Set<string>());
  const [query, setQuery] = useState("");
  const [isSidebarOpen, setSidebarOpen] = useState(window.innerWidth > 760);
  const [loading, setLoading] = useState(true);
  const [settingsError, setSettingsError] = useState("");
  const [toast, setToast] = useState("");
  const [shareUrls, setShareUrls] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const refreshSessions = useCallback(async () => {
    const rows = await api.sessions();
    setSessions(rows);
    return rows;
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    if (!id) return;
    const rows = await api.messages(id);
    setMessages(current => ({ ...current, [id]: rows }));
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([api.sessions(), api.settings()]).then(async ([rows, prefs]) => {
      if (!mounted) return;
      setSettings(prefs);
      if (!rows.length) {
        const session = await api.create();
        rows = [session];
      }
      if (!mounted) return;
      setSessions(rows);
      setActiveId(rows[0].id);
      setOpenIds([rows[0].id]);
      setLoading(false);
    }).catch(error => {
      if (mounted) { setToast(String(error)); setLoading(false); }
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (activeId && messages[activeId] === undefined) loadMessages(activeId).catch(error => setToast(String(error)));
  }, [activeId, loadMessages, messages]);

  useEffect(() => {
    const node = feed.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [activeId, messages, busy, errors, streamingText]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!copiedMessageId) return;
    const timer = window.setTimeout(() => setCopiedMessageId(""), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedMessageId]);

  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); newSession();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); setSidebarOpen(true); window.setTimeout(() => searchInput.current?.focus(), 0);
      }
      if (event.key === "Escape" && modal) setModal(null);
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [modal, sessions]);

  const current = sessions.find(session => session.id === activeId);
  const currentModel = settings.models.find(profile => profile.id === current?.modelId);
  const shareUrl = shareUrls[activeId] || "";
  useEffect(() => {
    if (shareUrl) document.getElementById("lan-sharing")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [shareUrl]);
  const currentMessages = messages[activeId] || [];
  const lastMessage = currentMessages[currentMessages.length - 1];
  const canRetry = !busy.includes(activeId);
  const draft = drafts[activeId] || EMPTY_DRAFT;
  const visibleSessions = useMemo(() => sessions.filter(session => `${session.title} ${session.lastMessage}`.toLowerCase().includes(query.toLowerCase())), [sessions, query]);
  const groupedSessions = useMemo(() => visibleSessions.reduce<Record<string, ChatSession[]>>((groups, session) => {
    const key = dateLabel(session.updatedAt);
    (groups[key] ||= []).push(session);
    return groups;
  }, {}), [visibleSessions]);

  function selectSession(id: string) {
    setActiveId(id);
    setOpenIds(ids => ids.includes(id) ? ids : [...ids, id]);
  }

  async function newSession() {
    try {
      const session = await api.create();
      setSessions(rows => [session, ...rows]);
      setMessages(rows => ({ ...rows, [session.id]: [] }));
      setActiveId(session.id);
      setOpenIds(ids => [...ids.filter(id => id !== session.id), session.id]);
      setPromptDraft("");
      setTitleDraft(session.title);
      window.setTimeout(() => composer.current?.focus(), 40);
    } catch (error) { setToast(String(error)); }
  }

  function patchDraft(patch: Partial<Draft>) {
    if (!activeId) return;
    setDrafts(current => ({ ...current, [activeId]: { ...(current[activeId] || EMPTY_DRAFT), ...patch } }));
  }

  async function importImages(sessionId: string, count: number, loader: () => Promise<string[]>): Promise<boolean> {
    if (!sessionId || imageImportsRef.current.has(sessionId)) return false;
    if ((drafts[sessionId]?.images.length || 0) + count > MAX_IMAGES) { setToast(`每条消息最多添加 ${MAX_IMAGES} 张图片`); return false; }
    imageImportsRef.current.add(sessionId);
    setImageImports([...imageImportsRef.current]);
    try {
      const images = await loader();
      setDrafts(rows => {
        const previous = rows[sessionId] || EMPTY_DRAFT;
        return { ...rows, [sessionId]: { ...previous, images: [...previous.images, ...images] } };
      });
      return true;
    } finally {
      imageImportsRef.current.delete(sessionId);
      setImageImports([...imageImportsRef.current]);
    }
  }

  async function addImageUrl() {
    const sessionId = activeId;
    setImageUrlError("");
    try {
      const added = await importImages(sessionId, 1, async () => [await api.imageFromUrl(imageUrlDraft)]);
      if (added) { setModal(null); setImageUrlDraft(""); setToast("图片已添加"); }
    } catch (error) { setImageUrlError(error instanceof Error ? error.message : String(error)); }
  }

  async function addFiles(files: FileList | File[]) {
    const sessionId = activeId;
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    const images = [...files].filter(file => allowedTypes.has(file.type));
    if (!images.length) { setToast("请选择 PNG、JPEG、WebP 或 GIF 图片"); return; }
    const tooLarge = images.find(file => file.size > 12 * 1024 * 1024);
    if (tooLarge) { setToast(`${tooLarge.name} 超过 12 MB`); return; }
    try {
      await importImages(sessionId, images.length, () => Promise.all(images.map(fileAsDataUrl)));
    } catch (error) { setToast(String(error)); }
  }

  async function send() {
    const text = draft.text.trim();
    if (!activeId || (!text && !draft.images.length)) return;
    if (imageImportsRef.current.has(activeId)) { setToast("请等图片添加完成再发送"); return; }
    if (!currentModel?.baseUrl.trim() || !currentModel.apiKey.trim()) {
      setSettingsDraft(settings); setSettingsError("请先配置 API 地址和 Key，输入内容会保留"); setModal("settings"); return;
    }
    if (busyRef.current.has(activeId)) return;
    if (busyRef.current.size >= 8) { setToast("最多可同时进行 8 个对话，请等一个回复完成"); return; }
    const id = activeId;
    const outgoing = { text, images: [...draft.images] };
    busyRef.current.add(id);
    setBusy([...busyRef.current]);
    setDrafts(current => ({ ...current, [id]: EMPTY_DRAFT }));
    setErrors(current => ({ ...current, [id]: "" }));
    setRetryTargets(rows => ({ ...rows, [id]: "" }));
    setStreamingText(rows => ({ ...rows, [id]: "" }));
    const optimistic: ChatMessage = { id: crypto.randomUUID(), sessionId: id, role: "user", content: outgoing.text, images: outgoing.images, createdAt: new Date().toISOString() };
    setMessages(current => ({ ...current, [id]: [...(current[id] || []), optimistic] }));
    try {
      if (current?.title === "新对话" && currentMessages.length === 0) {
        const title = outgoing.text ? outgoing.text.replace(/\s+/g, " ").slice(0, 20) : "图片对话";
        await api.update(id, title, current.systemPrompt);
        setSessions(rows => rows.map(session => session.id === id ? { ...session, title } : session));
      }
      await api.send(id, outgoing.text, outgoing.images, undefined, delta => {
        setStreamingText(rows => ({ ...rows, [id]: (rows[id] || "") + delta }));
      });
      await Promise.all([loadMessages(id), refreshSessions()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setErrors(current => ({ ...current, [id]: message }));
      await Promise.all([loadMessages(id), refreshSessions()]).catch(() => undefined);
    } finally {
      setStreamingText(rows => ({ ...rows, [id]: "" }));
      busyRef.current.delete(id);
      setBusy([...busyRef.current]);
    }
  }

  function openPrompt() {
    if (!current) return;
    setTitleDraft(current.title);
    setPromptDraft(current.systemPrompt);
    setStreamDraft(current.stream);
    setTemperatureDraft(current.temperature === null ? "" : String(current.temperature));
    setModelDraft(current.modelId);
    setPromptError("");
    setModal("prompt");
  }

  async function retry(messageId = lastMessage?.id) {
    if (!messageId || !canRetry || busyRef.current.has(activeId)) return;
    if (!current?.modelId || !settings.models.some(profile => profile.id === current.modelId && profile.baseUrl.trim() && profile.apiKey.trim())) {
      setSettingsDraft(settings); setSettingsError("请先配置 API 地址和 Key，再重试"); setModal("settings"); return;
    }
    if (busyRef.current.size >= 8) { setToast("最多可同时进行 8 个对话，请等一个回复完成"); return; }
    const id = activeId;
    busyRef.current.add(id);
    setBusy([...busyRef.current]);
    setErrors(rows => ({ ...rows, [id]: "" }));
    setRetryTargets(rows => ({ ...rows, [id]: messageId }));
    setStreamingText(rows => ({ ...rows, [id]: "" }));
    try {
      await api.retry(id, messageId, delta => {
        setStreamingText(rows => ({ ...rows, [id]: (rows[id] || "") + delta }));
      });
      await Promise.all([loadMessages(id), refreshSessions()]);
    } catch (error) {
      setErrors(rows => ({ ...rows, [id]: error instanceof Error ? error.message : String(error) }));
      await Promise.all([loadMessages(id), refreshSessions()]).catch(() => undefined);
    } finally {
      setStreamingText(rows => ({ ...rows, [id]: "" }));
      busyRef.current.delete(id);
      setBusy([...busyRef.current]);
    }
  }

  async function copyMessage(message: ChatMessage) {
    if (!message.content) { setToast("这条消息只有图片，没有可复制的文字"); return; }
    try {
      await api.copyText(message.content);
      setCopiedMessageId(message.id);
      setToast("已复制到剪贴板");
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }

  async function copyShareLink() {
    if (!shareUrl) return;
    try {
      await api.copyText(shareUrl);
      setCopiedShareUrl(shareUrl);
      window.setTimeout(() => setCopiedShareUrl(value => value === shareUrl ? "" : value), 2000);
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }

  async function savePrompt() {
    if (!current) return;
    const temperature = temperatureDraft.trim() === "" ? null : Number(temperatureDraft);
    if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      setPromptError("温度必须在 0 到 2 之间，或留空使用模型默认值"); return;
    }
    setPromptError("");
    try {
      await api.update(current.id, titleDraft.trim() || "新对话", promptDraft, { stream: streamDraft, temperature, modelId: modelDraft });
      await refreshSessions();
      setModal(null);
      setToast("会话设置已保存");
    } catch (error) { setToast(String(error)); }
  }

  async function saveSettings() {
    if (!settingsDraft.models.length) { setSettingsError("至少保留一个模型"); return; }
    if (!settingsDraft.models.some(profile => profile.id === settingsDraft.defaultModelId)) { setSettingsError("请选择默认模型"); return; }
    for (const profile of settingsDraft.models) {
      if (!profile.name.trim() || !profile.model.trim() || !profile.apiKey.trim()) { setSettingsError("每个模型都需要填写名称、模型名和 API Key"); return; }
      try {
        const url = new URL(profile.baseUrl.trim());
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL");
      } catch { setSettingsError(`「${profile.name || "未命名模型"}」的 API 地址必须是有效的 http:// 或 https:// 地址`); return; }
    }
    const modelIds = new Set(settingsDraft.models.map(profile => profile.id));
    const removedInUse = sessions.find(session => !modelIds.has(session.modelId));
    if (removedInUse) { setSettingsError(`「${removedInUse.title}」正在使用被删除的模型，请先在会话设置中更换模型`); return; }
    setSettingsError("");
    try {
      const models = settingsDraft.models.map(profile => ({ ...profile, name: profile.name.trim(), baseUrl: profile.baseUrl.trim().replace(/\/+$/, ""), apiKey: profile.apiKey.trim(), model: profile.model.trim() }));
      const selected = models.find(profile => profile.id === settingsDraft.defaultModelId)!;
      const saved = { ...settingsDraft, models, baseUrl: selected.baseUrl, apiKey: selected.apiKey, model: selected.model };
      await api.saveSettings(saved);
      setSettings(saved);
      setModal(null);
      setToast("连接设置已保存");
    } catch (error) { setSettingsError(String(error)); }
  }

  function addModel() {
    const profile: ModelProfile = { id: crypto.randomUUID(), name: `模型 ${settingsDraft.models.length + 1}`, baseUrl: settingsDraft.models[0]?.baseUrl || "", apiKey: settingsDraft.models[0]?.apiKey || "", model: "" };
    setSettingsDraft(current => ({ ...current, models: [...current.models, profile] }));
    setSettingsError("");
  }

  function removeModel(id: string) {
    const using = sessions.find(session => session.modelId === id);
    if (using) { setSettingsError(`「${using.title}」正在使用这个模型，请先在会话设置中更换模型`); return; }
    const models = settingsDraft.models.filter(profile => profile.id !== id);
    if (!models.length) { setSettingsError("至少保留一个模型"); return; }
    setSettingsDraft(current => ({ ...current, models, defaultModelId: current.defaultModelId === id ? models[0].id : current.defaultModelId }));
    setSettingsError("");
  }

  function updateModel(id: string, patch: Partial<ModelProfile>) {
    setSettingsDraft(current => ({ ...current, models: current.models.map(profile => profile.id === id ? { ...profile, ...patch } : profile) }));
  }

  async function startShare() {
    if (!current) return;
    const id = current.id;
    if (sharePendingRef.current.has(id)) return;
    if (shareUrls[id]) {
      document.getElementById("lan-sharing")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    sharePendingRef.current.add(id);
    setSharePending([...sharePendingRef.current]);
    try {
      const url = await api.share(id);
      setShareUrls(rows => ({ ...rows, [id]: url }));
    } catch (error) { setToast(String(error)); }
    finally {
      sharePendingRef.current.delete(id);
      setSharePending([...sharePendingRef.current]);
    }
  }

  async function stopShare() {
    if (!current) return;
    const id = current.id;
    if (sharePendingRef.current.has(id)) return;
    sharePendingRef.current.add(id);
    setSharePending([...sharePendingRef.current]);
    try {
      await api.unshare(id);
      setShareUrls(rows => { const copy = { ...rows }; delete copy[id]; return copy; });
      setToast("局域网访问已关闭，旧链接已失效");
    } catch (error) { setToast(String(error)); }
    finally {
      sharePendingRef.current.delete(id);
      setSharePending([...sharePendingRef.current]);
    }
  }

  async function deleteCurrent() {
    if (!current) return;
    const id = current.id;
    if (busyRef.current.has(id) || imageImportsRef.current.has(id) || sharePendingRef.current.has(id)) { setToast("请等这个会话的操作完成后再删除"); setModal(null); return; }
    try {
      await api.remove(id);
      const remaining = sessions.filter(session => session.id !== id);
      setSessions(remaining);
      setOpenIds(ids => {
        const kept = ids.filter(item => item !== id);
        const nextId = remaining[0]?.id;
        return nextId && !kept.includes(nextId) ? [...kept, nextId] : kept;
      });
      setMessages(items => { const copy = { ...items }; delete copy[id]; return copy; });
      setDrafts(items => { const copy = { ...items }; delete copy[id]; return copy; });
      setErrors(items => { const copy = { ...items }; delete copy[id]; return copy; });
      setRetryTargets(items => { const copy = { ...items }; delete copy[id]; return copy; });
      setStreamingText(items => { const copy = { ...items }; delete copy[id]; return copy; });
      setCopiedMessageId("");
      setShareUrls(items => { const copy = { ...items }; delete copy[id]; return copy; });
      if (remaining.length) setActiveId(remaining[0].id);
      else {
        const created = await api.create();
        setSessions([created]); setOpenIds([created.id]); setActiveId(created.id);
      }
      setModal(null);
      setToast("会话及图片记录已删除");
    } catch (error) { setToast(String(error)); }
  }

  function onComposerKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); send();
    }
  }

  return <div className={`app-shell ${isSidebarOpen ? "" : "sidebar-hidden"} ${shareUrl ? "sharing-active" : ""}`}>
    {isSidebarOpen && <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><AudioLines size={19} strokeWidth={2.4} /></div>
        <div className="brand-copy"><strong>echo<span>.</span></strong><small>AI 对话工作台</small></div>
        <button className="icon-button sidebar-collapse" title="收起侧边栏" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17} /></button>
      </div>
      <button className="new-chat-button" onClick={newSession}><SquarePen size={16} /><span>新建对话</span><span className="shortcut">⌘ K</span></button>
      <div className="sidebar-tools">
        <div className="search-box"><Search size={15} /><input ref={searchInput} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话" /><span>⌘ F</span></div>
      </div>
      <div className="history-heading"><span>你的会话</span><span>{sessions.length}</span></div>
      <div className="session-list">
        {Object.entries(groupedSessions).map(([group, rows]) => <section className="session-group" key={group}>
          <div className="group-label">{group}</div>
          {rows.map(session => <button className={`session-row ${session.id === activeId ? "selected" : ""}`} key={session.id} onClick={() => selectSession(session.id)}>
            <span className="session-dot">{busy.includes(session.id) ? <span className="live-dot" /> : <MessageSquarePlus size={15} />}</span>
            <span className="session-info"><span className="session-name">{session.title}</span><span className="session-preview">{session.lastMessage || "开始一段新对话"}</span></span>
            <span className="session-time">{timeLabel(session.updatedAt)}</span>
          </button>)}
        </section>)}
        {!visibleSessions.length && <div className="empty-search">没有找到相关会话</div>}
      </div>
      <div className="sidebar-bottom">
        <button className="library-row" onClick={() => document.querySelector(".session-list")?.scrollTo({ top: 0, behavior: "smooth" })}><FolderClock size={16} /><span>历史记录</span><ChevronRight size={15} /></button>
        <div className="account-card">
          <div className="account-avatar">E</div><div className="account-copy"><strong>本地工作区</strong><small>{currentModel?.model || "尚未配置模型"}</small></div>
          <button className="icon-button" title="连接设置" onClick={() => { setSettingsDraft(settings); setSettingsError(""); setModal("settings"); }}><Settings2 size={17} /></button>
        </div>
      </div>
    </aside>}

    <main className="main-pane">
      <header className="topbar">
        <div className="breadcrumbs">
          {!isSidebarOpen && <button className="icon-button reveal-sidebar" title="展开侧边栏" onClick={() => setSidebarOpen(true)}><PanelLeftClose size={17} /></button>}
          <span className="crumb-muted">工作区</span><ChevronRight size={14} /><span className="crumb-title">{current?.title || "AI 对话"}</span>
          <span className="connection-dot" title={currentModel?.baseUrl ? "已配置连接" : "尚未配置 API"} />
        </div>
        <div className="topbar-actions">
          <button className="icon-button quick-share" title={shareUrl ? "查看局域网二维码" : "开启局域网只读访问"} disabled={sharePending.includes(activeId)} onClick={startShare}><Link2 size={15} /></button>
          <div className={`parallel-indicator ${busy.length ? "working" : ""}`}><Activity size={14} /><span>{busy.length ? `${busy.length} 个对话正在生成` : "最多 8 路并行"}</span></div>
          <span className="topbar-divider" />
          <button className="avatar-button" title="连接设置" onClick={() => { setSettingsDraft(settings); setSettingsError(""); setModal("settings"); }}>E</button>
        </div>
      </header>

      {openIds.length > 0 && <div className="tab-strip">
        <div className="conversation-tabs">{openIds.map(id => {
          const session = sessions.find(item => item.id === id);
          if (!session) return null;
          return <button className={`conversation-tab ${id === activeId ? "active" : ""}`} key={id} onClick={() => setActiveId(id)}>
            <span className={busy.includes(id) ? "tab-pulse" : "tab-mark"} />
            <span>{session.title}</span>
            {busy.includes(id) && <span className="tab-thinking">生成中</span>}
            {openIds.length > 1 && <span className="tab-close" role="button" aria-label="关闭标签" tabIndex={0} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); const remaining = openIds.filter(item => item !== id); setOpenIds(remaining); if (id === activeId) setActiveId(remaining[remaining.length - 1]); } }} onClick={event => { event.stopPropagation(); const remaining = openIds.filter(item => item !== id); setOpenIds(remaining); if (id === activeId) setActiveId(remaining[remaining.length - 1]); }}>×</span>}
          </button>;
        })}</div>
        <button className="icon-button add-tab" title="新建对话" onClick={newSession}><Plus size={16} /></button>
      </div>}

      <section className="chat-view" ref={feed}>
        {loading ? <div className="loading-screen"><span className="loader" />正在准备工作区…</div> : currentMessages.length === 0 ? <div className="welcome-wrap">
          <div className="welcome-glyph"><AudioLines size={27} /></div>
          <div className="eyebrow"><span /> 一个安静、专注的对话空间</div>
          <h1>想从哪里开始？</h1>
          <p className="welcome-subtitle">写下问题、贴一张图片，让思路从这里继续。</p>
          <div className="suggestion-grid">
            <button className="suggestion-card" onClick={() => patchDraft({ text: "帮我把这个想法整理成一份清晰的行动计划：" })}><span className="suggestion-icon violet"><Bookmark size={16} /></span><span><strong>梳理一个想法</strong><small>整理成清晰的行动计划</small></span><ArrowUp size={15} /></button>
            <button className="suggestion-card" onClick={() => patchDraft({ text: "请仔细看看这张图片，并告诉我其中值得注意的内容。" })}><span className="suggestion-icon blue"><ImagePlus size={16} /></span><span><strong>看懂一张图片</strong><small>识别图像里的信息与细节</small></span><ArrowUp size={15} /></button>
            <button className="suggestion-card" onClick={() => patchDraft({ text: "请用简单直白的语言解释一下：" })}><span className="suggestion-icon amber"><Sparkles size={16} /></span><span><strong>解释一个概念</strong><small>用简单直白的语言说明白</small></span><ArrowUp size={15} /></button>
            <button className="suggestion-card" onClick={() => patchDraft({ text: "请帮我审阅这段文字，指出问题并给出改写建议：" })}><span className="suggestion-icon mint"><FileText size={16} /></span><span><strong>打磨一段文字</strong><small>让表达更准确、更自然</small></span><ArrowUp size={15} /></button>
          </div>
          <div className="welcome-note"><LockKeyhole size={13} /> 会话保存在本机，每日单独归档</div>
        </div> : <div className="message-stack">
          <div className="thread-intro"><span className="intro-line" /><span>对话开始于 {new Date(current?.createdAt || Date.now()).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</span><span className="intro-line" /></div>
          {currentMessages.map(message => <article className={`message-row ${message.role}`} key={message.id}>
            <div className={`message-avatar ${message.role}`}>{message.role === "assistant" ? <AudioLines size={15} /> : "E"}</div>
            <div className="message-body"><div className="message-byline"><strong>{message.role === "assistant" ? "Echo" : "你"}</strong><span>{timeLabel(message.createdAt)}</span>{message.role === "assistant" && <span className="model-tag">{message.model || "历史回复"}</span>}</div>
              {message.content && <div className="message-content">{message.content}</div>}
              {!!message.images.length && <div className="message-images">{message.images.map((image, imageIndex) => <img key={imageIndex} src={image} referrerPolicy="no-referrer" alt="消息附件" />)}</div>}
              <div className="message-tools message-actions"><button onClick={() => copyMessage(message)} title={message.content ? "复制这条消息的文字" : "这条消息只有图片，没有可复制的文字"} disabled={!message.content}>{copiedMessageId === message.id ? <Check size={13} /> : <Copy size={13} />}{copiedMessageId === message.id ? "已复制" : "复制"}</button><button onClick={() => retry(message.id)} disabled={!canRetry} title="使用原问题和图片重新生成回复；成功后替换该轮回复，保留后续消息"><RotateCw size={13} />{busy.includes(activeId) && retryTargets[activeId] === message.id ? "重试中…" : "重试"}</button></div>
            </div>
          </article>)}
          {busy.includes(activeId) && <div className="message-row assistant"><div className="message-avatar assistant"><AudioLines size={15} /></div><div className="message-body"><div className="message-byline"><strong>Echo</strong><span className="thinking-label"><i /><i /><i />{streamingText[activeId] ? (retryTargets[activeId] ? "正在重新生成" : "正在生成") : "正在组织语言"}</span></div>{streamingText[activeId] ? <div className="message-content streaming-content" aria-live="off">{streamingText[activeId]}</div> : <div className="thinking-bar"><span /></div>}</div></div>}
          {errors[activeId] && <div className="inline-error" role="alert"><CircleHelp size={15} /><span>{errors[activeId]}</span>{canRetry && lastMessage && <button className="retry-button" onClick={() => retry(retryTargets[activeId] || lastMessage.id)}><RotateCw size={13} />重试</button>}<button title="关闭错误提示" onClick={() => setErrors(row => ({ ...row, [activeId]: "" }))}><X size={14} /></button></div>}
          {busy.includes(activeId) && <div className="parallel-footnote"><span className="live-dot" />你可以切换到其他会话继续工作</div>}
        </div>}
      </section>

      <div className="composer-area" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files); }}>
        {!!draft.images.length && <div className="attachment-strip">{draft.images.map((src, index) => <div className="attachment-preview" key={`${index}-${src.slice(-14)}`}><img src={src} referrerPolicy="no-referrer" alt={`待发送图片 ${index + 1}`} title={src.startsWith("data:") ? "本地图片" : "链接图片"} /><button title="移除图片" onClick={() => patchDraft({ images: draft.images.filter((_, i) => i !== index) })}><X size={13} /></button></div>)}<span className="attachment-hint">{draft.images.length} / {MAX_IMAGES} 张 · 本地图片与链接可混用</span></div>}
        <div className="composer-card">
          <textarea ref={composer} value={draft.text} onChange={event => patchDraft({ text: event.target.value })} onKeyDown={onComposerKey} placeholder="向 Echo 提问，或拖入一张图片…" rows={2} />
          <div className="composer-footer">
          <div className="composer-left"><button className="composer-tool" title="选择本地图片" disabled={imageImports.includes(activeId)} onClick={() => fileInput.current?.click()}><ImagePlus size={16} /><span>本地图片</span></button><button className="composer-tool" disabled={imageImports.includes(activeId)} onClick={() => { setImageUrlDraft(""); setImageUrlError(""); setModal("image-url"); }}><Link2 size={15} /><span>图片链接</span></button><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} /><span className="tool-separator" /><button className="prompt-tool" onClick={openPrompt}><Command size={14} /><span>会话设置</span><span className={`prompt-status ${current?.systemPrompt ? "configured" : ""}`} /></button></div>
            <div className="composer-right"><span className="send-hint">↵ 发送 · ⇧↵ 换行</span><button className="send-button" disabled={!draft.text.trim() && !draft.images.length || busy.includes(activeId) || imageImports.includes(activeId)} title="发送消息" onClick={send}>{busy.includes(activeId) ? <span className="send-spinner" /> : <ArrowUp size={17} />}</button></div>
          </div>
        </div>
        <div className="composer-meta"><span><LockKeyhole size={12} /> 仅你与模型可见</span><span>{imageImports.includes(activeId) ? "正在添加图片…" : "本地图片最大 12 MB · 每条最多 9 张"}</span></div>
      </div>
      <footer className="statusbar"><span className="status-ready"><i /> 本机私有</span><span>{currentModel?.baseUrl ? `已连接 · ${currentModel.model}` : "设置 API 地址以开始对话"}</span><button onClick={() => { setSettingsDraft(settings); setSettingsError(""); setModal("settings"); }}>{currentModel?.baseUrl ? "管理模型" : "配置模型"}<ChevronDown size={12} /></button></footer>
    </main>

    <aside className="detail-pane">
      <div className="detail-header"><div><span className="detail-eyebrow">当前会话</span><h2>{current?.title || "未命名会话"}</h2></div><button className="icon-button" title="删除会话" onClick={() => setModal("delete")}><Trash2 size={16} /></button></div>
      <div className="detail-rule" />
      <div className="detail-section"><div className="detail-section-title"><span>会话上下文</span><button className="text-action" onClick={openPrompt}><SquarePen size={13} />编辑</button></div>
        <button className="request-summary" onClick={openPrompt}><span>模型 · {currentModel?.name || "请选择模型"}</span><ChevronRight size={13} /></button>
        <button className="prompt-card" onClick={openPrompt}><span className="prompt-card-icon"><Command size={15} /></span><span><strong>System 提示词</strong><small>{current?.systemPrompt ? `${current.systemPrompt.slice(0, 58)}${current.systemPrompt.length > 58 ? "…" : ""}` : "定义 AI 在这段会话中的行为"}</small></span><ChevronRight size={15} /></button>
        <button className="request-summary" onClick={openPrompt}><span>{current?.stream ? "流式回复" : "完整回复"} · 温度 {current?.temperature ?? "默认"}</span><ChevronRight size={13} /></button>
      </div>
      <div className="detail-section"><div className="detail-section-title"><span>并行工作</span><span className="count-pill">{busy.length} / 8</span></div>
        <div className="parallel-card"><div className="parallel-card-head"><span className="parallel-orbit"><Activity size={15} /></span><span><strong>多会话同时运行</strong><small>每段会话拥有独立上下文</small></span></div><div className="capacity-row"><div className="capacity-bar">{Array.from({ length: 8 }, (_, index) => <i className={index < busy.length ? "occupied" : ""} key={index} />)}</div><span>{busy.length} 路</span></div>
          {busy.length > 0 ? <div className="running-list">{busy.map(id => { const session = sessions.find(item => item.id === id); return <button key={id} onClick={() => selectSession(id)}><span className="live-dot" /><span>{session?.title || "正在对话"}</span><ChevronRight size={13} /></button>; })}</div> : <div className="parallel-idle"><span className="idle-dot" />最多 8 个会话可同时生成</div>}
        </div>
      </div>
      <div className="detail-section share-section" id="lan-sharing"><div className="detail-section-title"><span>局域网访问</span><span className="read-only-badge"><ShieldCheck size={11} />只读</span></div><div className="share-card">
        {shareUrl ? <>
          <div className="share-qr"><QRCodeSVG value={shareUrl} size={192} level="M" marginSize={4} bgColor="#ffffff" fgColor="#111111" role="img" aria-label="当前会话的局域网访问二维码" title="扫码查看当前会话" /></div>
          <strong>扫码查看会话</strong><p>其他设备连接同一网络后，使用相机或扫码工具打开，只读查看当前会话。</p>
          <div className="share-address">{shareUrl}</div>
          <button className="share-button" onClick={copyShareLink}>{copiedShareUrl === shareUrl ? <Check size={14} /> : <Copy size={14} />}{copiedShareUrl === shareUrl ? "已复制链接" : "复制访问链接"}</button>
          <button className="share-stop-button" disabled={sharePending.includes(activeId)} onClick={stopShare}>{sharePending.includes(activeId) ? "正在关闭…" : "关闭访问"}</button>
          <small className="share-footnote">应用需保持运行；关闭访问后二维码和链接立即失效</small>
        </> : <>
          <div className="share-illustration"><span className="share-center"><AudioLines size={15} /></span><span className="share-node node-a" /><span className="share-node node-b" /><span className="share-node node-c" /><span className="share-ring" /></div><strong>在同一网络中查看记录</strong><p>开启后显示访问二维码。访客只能阅读此会话，不能发送消息或修改内容。</p><button className="share-button" disabled={sharePending.includes(activeId)} onClick={startShare}><Link2 size={15} />{sharePending.includes(activeId) ? "正在开启…" : "开启局域网访问"}</button><small className="share-footnote">二维码和链接在应用运行时有效</small>
        </>}
      </div></div>
      <div className="detail-spacer" />
      <div className="security-note"><ShieldCheck size={15} /><span><strong>你的数据，留在你的设备</strong><small>对话按天保存在本地数据库中</small></span></div>
    </aside>

    {modal && <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null); }}>
      {modal === "settings" && <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="dialog-top"><span className="dialog-icon teal"><Settings2 size={17} /></span><button className="icon-button" onClick={() => setModal(null)}><X size={18} /></button></div><div className="dialog-heading"><h2 id="settings-title">模型管理</h2><p>添加 OpenAI 兼容服务；新会话默认使用所选模型。</p></div>
        <label className="field-label default-model-field">默认模型<select value={settingsDraft.defaultModelId} onChange={event => setSettingsDraft(row => ({ ...row, defaultModelId: event.target.value }))}>{settingsDraft.models.map(profile => <option key={profile.id} value={profile.id}>{profile.name || profile.model || "未命名模型"}</option>)}</select></label>
        <div className="model-profile-list">{settingsDraft.models.map((profile, index) => <section className="model-profile" key={profile.id}>
          <div className="model-profile-heading"><strong>{profile.name || `模型 ${index + 1}`}</strong>{settingsDraft.defaultModelId === profile.id && <span>默认</span>}<button type="button" className="icon-button" title="删除模型" disabled={settingsDraft.models.length === 1 || sessions.some(session => session.modelId === profile.id)} onClick={() => removeModel(profile.id)}><X size={15} /></button></div>
          <label className="field-label">显示名称<input autoFocus={index === 0} value={profile.name} onChange={event => updateModel(profile.id, { name: event.target.value })} placeholder="例如：OpenAI 主力" /></label>
          <label className="field-label">API 地址<span>API Base URL</span><input value={profile.baseUrl} onChange={event => updateModel(profile.id, { baseUrl: event.target.value })} placeholder="https://api.openai.com/v1" /></label>
          <label className="field-label">API Key<span>仅保存在此设备</span><input type="password" autoComplete="new-password" value={profile.apiKey} onChange={event => updateModel(profile.id, { apiKey: event.target.value })} placeholder="sk-…" /></label>
          <label className="field-label">模型名称<span>Model</span><input value={profile.model} onChange={event => updateModel(profile.id, { model: event.target.value })} placeholder="gpt-4o-mini" /></label>
        </section>)}</div>
        <button className="add-model-button" onClick={addModel}><Plus size={15} />添加模型</button>
        {settingsError && <div className="field-error">{settingsError}</div>}
        <div className="settings-callout"><LockKeyhole size={15} /><span>模型连接信息和 Key 保存在本机，只用于向对应服务发送请求。</span></div>
        <div className="dialog-actions"><span className="app-version">回声 Echo · {appVersion}</span><button className="button-quiet" onClick={() => setModal(null)}>取消</button><button className="button-primary" onClick={saveSettings}>保存模型</button></div>
      </section>}
      {modal === "prompt" && <section className="dialog prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-title">
        <div className="dialog-top"><span className="dialog-icon violet"><Command size={17} /></span><button className="icon-button" title="关闭会话设置" onClick={() => setModal(null)}><X size={18} /></button></div>
        <div className="dialog-heading"><h2 id="prompt-title">会话设置</h2><p>为这段对话设置名称、专属指令和回复方式。</p></div>
        <label className="field-label">会话名称<input autoFocus value={titleDraft} onChange={event => setTitleDraft(event.target.value)} placeholder="例如：产品调研" /></label>
        <label className="field-label">使用模型<select value={modelDraft} onChange={event => setModelDraft(event.target.value)}>{settings.models.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>
        <label className="field-label">System 提示词<span>{promptDraft.length} 字符</span><textarea className="prompt-textarea" value={promptDraft} onChange={event => setPromptDraft(event.target.value)} placeholder="例如：你是一位严谨的产品研究员。回答时先总结结论，再列出证据。" /></label>
        <label className="stream-option"><span><strong>流式请求</strong><small>开启后，回复会逐步显示</small></span><input type="checkbox" role="switch" checked={streamDraft} onChange={event => setStreamDraft(event.target.checked)} /></label>
        <label className="field-label">温度（Temperature）<input type="number" min="0" max="2" step="any" value={temperatureDraft} onChange={event => setTemperatureDraft(event.target.value)} placeholder="留空使用模型默认值" /><small className="field-help">范围 0–2，越低越稳定，越高越多样。留空不传此参数。</small></label>
        <div className="prompt-note"><Sparkles size={14} />仅应用于当前会话的下一次发送或重试。</div>
        {promptError && <div className="field-error" role="alert">{promptError}</div>}
        <div className="dialog-actions"><button className="button-quiet" onClick={() => setModal(null)}>取消</button><button className="button-primary" onClick={savePrompt}>保存设置</button></div>
      </section>}

      {modal === "image-url" && <section className="dialog image-url-dialog" role="dialog" aria-modal="true" aria-labelledby="image-url-title">
        <div className="dialog-top"><span className="dialog-icon violet"><Link2 size={17} /></span><button className="icon-button" title="关闭图片链接" onClick={() => setModal(null)}><X size={18} /></button></div>
        <div className="dialog-heading"><h2 id="image-url-title">添加图片链接</h2><p>粘贴图片直链，添加后可预览，发送时保留原链接。</p></div>
        <label className="field-label">图片链接<input autoFocus type="url" value={imageUrlDraft} disabled={imageImports.includes(activeId)} onChange={event => setImageUrlDraft(event.target.value)} placeholder="https://example.com/image.png" onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) addImageUrl(); }} /><small className="field-help">请使用模型服务可访问的图片直链，避免使用需要登录的链接。</small></label>
        {imageUrlError && <div className="field-error" role="alert">{imageUrlError}</div>}
        <div className="dialog-actions"><button className="button-quiet" onClick={() => setModal(null)}>取消</button><button className="button-primary" disabled={!imageUrlDraft.trim() || imageImports.includes(activeId)} onClick={addImageUrl}>{imageImports.includes(activeId) ? "正在添加…" : "添加图片"}</button></div>
      </section>}
      {modal === "delete" && <section className="dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title"><div className="dialog-top"><span className="dialog-icon rose"><Trash2 size={17} /></span><button className="icon-button" onClick={() => setModal(null)}><X size={18} /></button></div><div className="dialog-heading"><h2 id="delete-title">删除这个会话？</h2><p>“{current?.title}”及其消息、图片数据和草稿会从本机移除。此操作无法撤销。</p></div><div className="delete-summary"><MessageSquarePlus size={16} /><span>{currentMessages.length} 条消息</span><span className="summary-divider" /><span>本地记录</span></div><div className="dialog-actions"><button className="button-quiet" onClick={() => setModal(null)}>取消</button><button className="button-danger" onClick={deleteCurrent}>删除会话</button></div></section>}
    </div>}
    {toast && <div className="toast"><span className="toast-mark"><Check size={13} /></span>{toast}</div>}
    {!desktop && <div className="preview-ribbon"><span className="preview-dot" />浏览器预览 · 数据保存在此浏览器</div>}
  </div>;
}

export default App;
