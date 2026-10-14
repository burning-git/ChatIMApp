import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const code = await readFile(new URL("../src-tauri/src/shared-copy.js", import.meta.url), "utf8");

async function copyScenario({ secure = false, clipboardRejects = false, legacyWorks = true }) {
  const text = "\n中文与 **Markdown**\r\n<script>文本</script> & \"引号\"  尾部空格  ";
  let handler, written, fallback, selected, removed = false;
  const status = {};
  const body = { appendChild() {} };
  const button = { disabled: false, getAttribute: () => text, parentElement: { querySelector: () => status }, closest: () => ({ querySelector: () => ({ content: text }) }) };
  const navigator = { clipboard: { writeText: async value => { if (clipboardRejects) throw new Error("denied"); written = value; } } };
  const document = {
    body, activeElement: { focus() {} }, addEventListener: (type, callback) => { handler = callback; },
    createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { removed = true; }, set value(value) { fallback = value; } }),
    execCommand: command => { assert.equal(command, "copy"); return legacyWorks; },
    createRange: () => ({ selectNodeContents: node => { selected = node.content; } }),
  };
  const window = { isSecureContext: secure, setTimeout() {}, getSelection: () => ({ removeAllRanges() {}, addRange() {} }) };
  runInNewContext(code, { document, navigator, window });
  await handler({ target: { closest: () => button } });
  return { text, written, fallback, selected, removed, button, status };
}

test("分享页面通过 HTTPS 剪贴板复制原始多行文字", async () => {
  const result = await copyScenario({ secure: true });
  assert.equal(result.written, result.text);
  assert.equal(result.fallback, undefined);
  assert.equal(result.button.textContent, "已复制");
});

test("局域网 HTTP 和剪贴板拒绝时使用备用复制，保持原文并清理临时元素", async () => {
  for (const options of [{ secure: false }, { secure: true, clipboardRejects: true }]) {
    const result = await copyScenario(options);
    assert.equal(result.fallback, result.text);
    assert.equal(result.removed, true);
    assert.equal(result.button.textContent, "已复制");
    assert.equal(result.button.disabled, false);
  }
});

test("网页无法自动复制时选中正文并提示手动复制", async () => {
  const result = await copyScenario({ legacyWorks: false });
  assert.equal(result.selected, result.text);
  assert.match(result.status.textContent, /已选中的文字/);
  assert.equal(result.button.disabled, false);
});
