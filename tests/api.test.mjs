import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { webcrypto } from "node:crypto";

const compiled = await build({ entryPoints: [new URL("../src/api.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm" });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`;
globalThis.window = {};
if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.localStorage = {};
Object.defineProperties(localStorage, {
  getItem: { value: key => localStorage[key] ?? null },
  setItem: { value: (key, value) => { localStorage[key] = value; } },
  removeItem: { value: key => { delete localStorage[key]; } },
});
const { api } = await import(moduleUrl);
const reset = () => Object.keys(localStorage).forEach(key => delete localStorage[key]);

test("OpenAI 请求携带独立 system 提示词和 Base64 图片，回复持久化", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1/", apiKey: "test-key", model: "test-vision" });
  const session = await api.create("图像分析", "只回答图片中的颜色");
  const image = "data:image/png;base64,aGVsbG8=";
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body), authorization: options.headers.Authorization };
    return { ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "蓝色" } }] }) };
  };
  await api.send(session.id, "这是什么颜色？", [image]);
  assert.equal(captured.url, "https://example.test/v1/chat/completions");
  assert.equal(captured.authorization, "Bearer test-key");
  assert.deepEqual(captured.body.messages[0], { role: "system", content: "只回答图片中的颜色" });
  assert.equal(captured.body.messages[1].content[1].image_url.url, image);
  assert.deepEqual((await api.messages(session.id)).map(row => row.role), ["user", "assistant"]);
});

test("8 个会话并行，拒绝第 9 个及同一会话的重复请求，并在结束后释放", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test" });
  const sessions = await Promise.all(Array.from({ length: 9 }, (_, index) => api.create(`会话 ${index}`)));
  const releases = [];
  globalThis.fetch = () => new Promise(resolve => releases.push(() => resolve({ ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "完成" } }] }) })));
  const requests = sessions.slice(0, 8).map(session => api.send(session.id, "独立请求", []));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 8);
  await assert.rejects(api.send(sessions[8].id, "第九路", []), /8/);
  await assert.rejects(api.send(sessions[0].id, "重复请求", []), /回复中/);
  releases.forEach(release => release());
  await Promise.all(requests);
  assert.equal((await api.messages(sessions[8].id)).length, 0);
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "第九路完成" } }] }) });
  await api.send(sessions[8].id, "现在可以了", []);
  assert.equal((await api.messages(sessions[8].id)).at(-1).content, "第九路完成");
});

test("请求失败保留已发送消息，释放并发位；回复期间改名不会被旧设置覆盖", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1/chat/completions", apiKey: "test-key", model: "test" });
  const session = await api.create("旧名称", "旧提示词");
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "无效 Key" } }) });
  await assert.rejects(api.send(session.id, "保留这个问题", []), /无效 Key/);
  assert.equal((await api.messages(session.id)).length, 1);
  globalThis.fetch = async () => {
    await api.update(session.id, "新名称", "新提示词");
    return { ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "成功回复" } }] }) };
  };
  await api.send(session.id, "再次发送", []);
  const saved = (await api.sessions())[0];
  assert.equal(saved.title, "新名称");
  assert.equal(saved.systemPrompt, "新提示词");
  await api.remove(session.id);
  assert.equal((await api.sessions()).length, 0);
  assert.equal((await api.messages(session.id)).length, 0);
});

test("跨日消息分别归档，同一会话读取时合并，并保留最初创建时间", async () => {
  reset();
  const RealDate = Date;
  let clock = "2026-10-13T15:59:00.000Z";
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return new RealDate(clock).getTime(); }
  };
  try {
    await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test" });
    const session = await api.create("跨天会话", "保持上下文");
    globalThis.fetch = async () => ({ ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "归档回复" } }] }) });
    await api.send(session.id, "第一天的消息", []);
    clock = "2026-10-14T16:01:00.000Z";
    await api.send(session.id, "后一天的消息", []);
    assert.equal(Object.keys(localStorage).filter(key => key.startsWith("echo-day-")).length, 2);
    assert.equal((await api.sessions()).length, 1);
    assert.equal((await api.messages(session.id)).length, 4);
    assert.equal((await api.sessions())[0].createdAt, session.createdAt);
  } finally { globalThis.Date = RealDate; }
});

test("失败重试复用原始消息和图片，多次失败不重复入库，成功后可重新生成", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "vision" });
  const session = await api.create("重试测试", "看图回答");
  const image = "data:image/png;base64,aGVsbG8=";
  const requests = [];
  let attempts = 0;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    attempts++;
    if (attempts < 3) throw new Error("连接重置");
    return { ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "恢复成功" } }] }) };
  };
  await assert.rejects(api.send(session.id, "保留图片的问题", [image]), /连接重置/);
  const original = (await api.messages(session.id))[0];
  await assert.rejects(api.retry(session.id, "不存在的消息"), /找不到/);
  await assert.rejects(api.retry(session.id, original.id), /连接重置/);
  assert.equal((await api.messages(session.id)).length, 1);
  await api.retry(session.id, original.id);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  const saved = await api.messages(session.id);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].id, original.id);
  assert.deepEqual(saved[0].images, [image]);
  assert.equal(saved[1].content, "恢复成功");
  await api.retry(session.id, original.id);
  assert.equal((await api.messages(session.id)).length, 2);
  assert.equal((await api.messages(session.id))[1].id, saved[1].id);
  assert.equal(attempts, 4);
});

test("历史用户消息与AI回复均可重试，只替换对应回复，失败保留原文，后续消息与跨天位置不变", async () => {
  reset();
  const RealDate = Date;
  let clock = "2026-10-12T16:01:00.000Z";
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return new RealDate(clock).getTime(); }
  };
  try {
    await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "vision" });
    const session = await api.create("历史重试", "看图回答");
    const image = "data:image/png;base64,aGVsbG8=";
    globalThis.fetch = async () => ({ ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "原回复" } }] }) });
    await api.send(session.id, "第一轮", [image]);
    clock = "2026-10-13T16:01:00.000Z";
    await api.send(session.id, "后续问题", []);
    const original = await api.messages(session.id);
    // Simulate a pre-0.1.3 answer, which has no explicit reply linkage.
    for (const key of Object.keys(localStorage).filter(key => key.startsWith("echo-day-"))) {
      const day = JSON.parse(localStorage.getItem(key));
      day.messages.forEach(message => delete message.replyToId);
      localStorage.setItem(key, JSON.stringify(day));
    }
    const legacy = await api.messages(session.id);
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      throw new Error("临时故障");
    };
    await assert.rejects(api.retry(session.id, original[1].id), /临时故障/);
    assert.deepEqual(await api.messages(session.id), legacy);
    clock = "2026-10-14T16:01:00.000Z";
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "新回复" } }] }) };
    };
    await api.retry(session.id, original[0].id);
    await api.retry(session.id, original[1].id);
    const saved = await api.messages(session.id);
    assert.deepEqual(saved.map(message => message.id), original.map(message => message.id));
    assert.equal(saved[1].content, "新回复");
    assert.equal(saved[1].createdAt, original[1].createdAt);
    assert.deepEqual(saved[0].images, [image]);
    assert.deepEqual(saved.slice(2), legacy.slice(2));
    assert.equal((await api.sessions())[0].lastMessage, "原回复");
    assert.deepEqual(requests[0], requests[1]);
    assert.deepEqual(requests[1], requests[2]);
    assert.equal(requests[2].messages.length, 2);
    assert.equal(requests[2].messages[1].content[1].image_url.url, image);
  } finally { globalThis.Date = RealDate; }
});

test("历史未回复问题在重试成功后插入对应位置，同会话不能并发重试", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test" });
  const session = await api.create("未回复问题");
  globalThis.fetch = async () => { throw new Error("断网"); };
  await assert.rejects(api.send(session.id, "第一轮失败", []), /断网/);
  const unanswered = (await api.messages(session.id))[0];
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "第二轮回复" } }] }) });
  await api.send(session.id, "第二轮", []);
  const subsequent = (await api.messages(session.id)).slice(1);
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = () => resolve({ ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "第一轮补回" } }] }) }); });
  const request = api.retry(session.id, unanswered.id);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(api.retry(session.id, unanswered.id), /回复中/);
  release();
  await request;
  const saved = await api.messages(session.id);
  assert.equal(saved.length, 4);
  assert.equal(saved[0].id, unanswered.id);
  assert.equal(saved[1].content, "第一轮补回");
  assert.deepEqual(saved.slice(2), subsequent);
  assert.equal((await api.sessions())[0].lastMessage, "第二轮回复");
});

test("复制完整多行文字，并将剪贴板失败反馈给界面", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let copied;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async text => { copied = text; } } } });
  try {
    await api.copyText("自己发送的内容\nAI **回答**");
    assert.equal(copied, "自己发送的内容\nAI **回答**");
    navigator.clipboard.writeText = async () => { throw new Error("剪贴板不可用"); };
    await assert.rejects(api.copyText("复制失败"), /剪贴板不可用/);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
});

test("每个会话独立保存请求模式和温度，旧记录使用默认值，改名与跨日发送保留配置", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test" });
  const first = await api.create("会话一");
  const second = await api.create("会话二");
  assert.equal(first.stream, true);
  assert.equal(first.temperature, 0);
  for (const key of Object.keys(localStorage).filter(key => key.startsWith("echo-day-"))) {
    const day = JSON.parse(localStorage.getItem(key));
    day.sessions.forEach(session => { delete session.stream; delete session.temperature; });
    localStorage.setItem(key, JSON.stringify(day));
  }
  assert.equal((await api.sessions()).find(row => row.id === first.id).stream, true);
  assert.equal((await api.sessions()).find(row => row.id === first.id).temperature, 0);
  await api.update(first.id, first.title, "指令", { stream: true, temperature: 0 });
  await api.update(first.id, "自动改名", "指令");
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "普通 JSON 回复" } }] }), { headers: { "content-type": "application/json" } });
  };
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ["2099-01-01T12:00:00.000Z"])); } };
  try { await api.send(first.id, "跨日消息", []); }
  finally { globalThis.Date = RealDate; }
  await api.update(second.id, second.title, "", { stream: false, temperature: null });
  await api.send(second.id, "默认请求", []);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].temperature, 0);
  assert.equal(requests[1].stream, false);
  assert.equal("temperature" in requests[1], false);
  const saved = (await api.sessions()).find(row => row.id === first.id);
  assert.equal(saved.stream, true);
  assert.equal(saved.temperature, 0);
  for (const temperature of [-1, 2.1, NaN, Infinity]) {
    await assert.rejects(api.update(first.id, "改名", "", { stream: false, temperature }), /温度/);
  }
  assert.equal((await api.sessions()).find(row => row.id === first.id).temperature, 0);
});

const sse = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\r\n\r\n`;
const completed = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

test("真实流式读取在完成前展示增量，支持拆分中文与多会话独立进度，完成后入库", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test" });
  const sessions = await Promise.all([api.create("流式一"), api.create("流式二")]);
  for (const session of sessions) await api.update(session.id, session.title, "", { stream: true, temperature: 0.7 });
  const controllers = [];
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controllers.push(controller); } }), { headers: { "content-type": "text/event-stream" } });
  const chunks = [[], []];
  const requests = sessions.map((session, index) => api.send(session.id, "问题", [], undefined, delta => chunks[index].push(delta)));
  await new Promise(resolve => setImmediate(resolve));
  const bytes = new TextEncoder().encode(`: heartbeat\r\n${sse("你好🌍")}`);
  for (const byte of bytes) controllers[0].enqueue(new Uint8Array([byte]));
  controllers[1].enqueue(new TextEncoder().encode(sse("独立进度")));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(chunks, [["你好🌍"], ["独立进度"]]);
  assert.equal((await api.messages(sessions[0].id)).length, 1);
  await assert.rejects(api.retry(sessions[0].id, (await api.messages(sessions[0].id))[0].id), /回复中/);
  for (const controller of controllers) controller.enqueue(new TextEncoder().encode(completed));
  const replies = await Promise.all(requests);
  assert.equal(replies[0].content, "你好🌍");
  assert.equal(replies[1].content, "独立进度");
  assert.equal((await api.messages(sessions[0].id)).length, 2);
});

test("流式历史重试中断或报错保留原回复与后续消息，成功才替换并使用当前会话参数", async () => {
  reset();
  await api.saveSettings({ baseUrl: "https://example.test/v1", apiKey: "test-key", model: "test" });
  const session = await api.create("流式重试");
  globalThis.fetch = async () => ({ ok: true, headers: new Headers({"content-type": "application/json"}), json: async () => ({ choices: [{ message: { content: "原回复" } }] }) });
  await api.send(session.id, "原问题", []);
  await api.send(session.id, "后续问题", []);
  const original = await api.messages(session.id);
  await api.update(session.id, session.title, "", { stream: true, temperature: 2 });
  const requests = [];
  function response(text) {
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(text, { headers: { "content-type": "text/event-stream" } });
    };
  }
  response(sse("未完成回复"));
  await assert.rejects(api.retry(session.id, original[1].id), /中断/);
  assert.deepEqual(await api.messages(session.id), original);
  response(sse("部分内容") + 'data: {"error":{"message":"服务中断"}}\n\n');
  await assert.rejects(api.retry(session.id, original[0].id), /服务中断/);
  assert.deepEqual(await api.messages(session.id), original);
  response(sse("新回复") + completed);
  await api.retry(session.id, original[1].id);
  const saved = await api.messages(session.id);
  assert.equal(saved[1].id, original[1].id);
  assert.equal(saved[1].content, "新回复");
  assert.deepEqual(saved.slice(2), original.slice(2));
  assert.equal(requests[2].temperature, 2);
  assert.equal(requests[2].messages.length, 1);
  assert.equal((await api.sessions())[0].stream, true);
});

test("桌面发送与重试使用独立 IPC 通道转发流式片段", async () => {
  const browserWindow = globalThis.window;
  const calls = [];
  const channels = [];
  class Channel { constructor() { channels.push(this); } }
  window = { __TAURI__: { core: { Channel, invoke: async (command, args) => {
    calls.push({ command, args });
    args.onChunk.onmessage(command === "send_message" ? "发送增量" : "重试增量");
    return { content: "最终回复" };
  } } } };
  try {
    const { api: nativeApi } = await import(moduleUrl + "#desktop-stream");
    const deltas = [];
    await nativeApi.send("one", "问题", [], undefined, delta => deltas.push(delta));
    await nativeApi.retry("two", "historic", delta => deltas.push(delta));
    assert.deepEqual(deltas, ["发送增量", "重试增量"]);
    assert.equal(calls[0].command, "send_message");
    assert.equal(calls[1].command, "retry_message");
    assert.equal(calls[1].args.messageId, "historic");
    assert.notEqual(channels[0], channels[1]);
  } finally { globalThis.window = browserWindow; }
});

test("图片链接下载为 Base64 附件，拒绝无效链接、非图片和超大图片", async () => {
  const previousReader = globalThis.FileReader;
  const previousFetch = globalThis.fetch;
  class Reader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
        this.onload();
      });
    }
  }
  globalThis.FileReader = Reader;
  try {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRxkAAAAASUVORK5CYII=", "base64");
    let requested;
    globalThis.fetch = async (url, options) => { requested = { url, options }; return new Response(png); };
    const image = await api.imageFromUrl(" https://example.test/image?version=1 " );
    assert.equal(image, `data:image/png;base64,${png.toString("base64")}`);
    assert.equal(requested.options.credentials, "omit");
    assert.equal(requested.url, "https://example.test/image?version=1");
    assert.equal(requested.options.headers, undefined);
    for (const url of ["file:///tmp/image.png", "javascript:alert(1)", "https://user:secret@example.test/a.png", "bad url"]) {
      await assert.rejects(api.imageFromUrl(url), /图片链接/);
    }
    globalThis.fetch = async () => new Response("<html>not an image</html>", { headers: { "content-type": "image/png" } });
    await assert.rejects(api.imageFromUrl("https://example.test/a.png"), /未返回支持的图片/);
    globalThis.fetch = async () => new Response("", { headers: { "content-length": String(12 * 1024 * 1024 + 1) } });
    await assert.rejects(api.imageFromUrl("https://example.test/a.png"), /12 MB/);
    globalThis.fetch = async () => new Response(new Uint8Array(12 * 1024 * 1024 + 1));
    await assert.rejects(api.imageFromUrl("https://example.test/a.png"), /12 MB/);
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    await assert.rejects(api.imageFromUrl("https://example.test/a.png"), /404/);
  } finally { globalThis.FileReader = previousReader; globalThis.fetch = previousFetch; }
});
