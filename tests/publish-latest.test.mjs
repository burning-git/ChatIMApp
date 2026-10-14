import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareAssets, publishLatest, selectBuilds } from "../scripts/publish-latest.mjs";

const repository = "example/echo";
const commit = "a".repeat(40);
const version = "0.1.6";
const sourceRuns = { windows: 11, macos: 12 };
const run = { id: 11, conclusion: "success", event: "push", head_sha: commit, head_branch: "main", head_repository: { full_name: repository } };
const event = { repository: { full_name: repository, default_branch: "main" }, workflow_run: run };

async function fixture(t) {
  const inputDir = await mkdtemp(join(tmpdir(), "echo-release-"));
  t.after(() => rm(inputDir, { recursive: true, force: true }));
  for (const [key, target, suffixes] of [
    ["windows", "x86_64-pc-windows-msvc", ["windows-x64-setup.exe", "windows-x64.msi"]],
    ["macos", "universal-apple-darwin", ["macos-universal.dmg"]],
  ]) {
    const folder = join(inputDir, key);
    await mkdir(folder);
    const files = [];
    for (const suffix of suffixes) {
      const name = `Echo-${version}-${suffix}`;
      const data = Buffer.from(`Installer fixture: ${suffix}`);
      await writeFile(join(folder, name), data);
      files.push({ name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
    await writeFile(join(folder, "manifest.json"), JSON.stringify({ version, commit, target, files }));
  }
  return { repository, branch: "main", commit, inputDir, sourceRuns };
}

function githubMock({ existing = false, draft = false, head = commit } = {}) {
  const calls = [];
  const release = { id: 7, tag_name: "latest", upload_url: "https://uploads.github.com/repos/example/echo/releases/7/assets{?name,label}" };
  const assets = [
    { id: 101, name: "Echo-windows-x64-setup.exe" },
    { id: 102, name: "Echo-windows-x64.msi" },
    { id: 103, name: "Echo-macos-universal.dmg" },
    { id: 104, name: "SHA256SUMS.txt" },
    { id: 105, name: "manifest.json" },
    { id: 106, name: "manual-notes.txt" },
  ];
  return {
    calls,
    request: async (method, path, options = {}) => {
      calls.push({ method, path, ...options });
      if (method === "GET" && path.includes("/branches/")) return { commit: { sha: head } };
      if (method === "GET" && path.endsWith("/releases/tags/latest")) return existing && !draft ? release : null;
      if (method === "GET" && path.includes("/releases?")) return draft ? [release] : [];
      if (method === "GET" && path.includes("/releases/7/assets")) return existing ? assets : [];
      if (method === "GET" && path.endsWith("/git/ref/tags/latest")) return existing ? { object: { sha: "old" } } : null;
      if (method === "POST" && path.endsWith("/releases")) return release;
      if (method === "GET") throw new Error(`Unexpected read: ${path}`);
      return {};
    },
  };
}

test("发布仅接受默认分支的成功构建，PR、fork 和其他分支不访问发布接口", async () => {
  for (const changed of [
    { event: "pull_request" }, { head_repository: { full_name: "other/fork" } },
    { head_branch: "feature" }, { conclusion: "failure" },
  ]) {
    const result = await selectBuilds({ ...event, workflow_run: { ...run, ...changed } }, () => { throw new Error("Unexpected API request"); });
    assert.equal(result.ready, false);
  }
});

test("等待两个平台同一提交成功，只选择可信构建", async () => {
  const request = async (_method, path) => {
    if (path.includes("/branches/")) return { commit: { sha: commit } };
    return { workflow_runs: [
      { ...run, event: "pull_request" },
      { ...run, head_sha: "old" },
      { ...run, id: path.includes("build-windows.yml") ? 11 : 12 },
    ] };
  };
  assert.deepEqual(await selectBuilds(event, request), { ready: true, commit, windows_run_id: 11, macos_run_id: 12 });
  const waiting = await selectBuilds(event, async (method, path) => path.includes("build.yml") ? { workflow_runs: [] } : request(method, path));
  assert.equal(waiting.ready, false);
  assert.match(waiting.reason, /macos/);
});

test("发布统一的固定文件名，校验清单与下载文件完全对应", async t => {
  const options = await fixture(t);
  const { assets } = await prepareAssets(options.inputDir, commit, sourceRuns);
  assert.deepEqual(assets.map(asset => asset.name), [
    "Echo-windows-x64-setup.exe", "Echo-windows-x64.msi", "Echo-macos-universal.dmg", "SHA256SUMS.txt", "manifest.json",
  ]);
  const manifest = JSON.parse(assets.find(asset => asset.name === "manifest.json").data.toString());
  const checksumLines = assets.find(asset => asset.name === "SHA256SUMS.txt").data.toString();
  assert.equal(manifest.version, version);
  assert.equal(manifest.commit, commit);
  assert.deepEqual(manifest.sourceRuns, sourceRuns);
  for (const file of manifest.files) {
    const asset = assets.find(asset => asset.name === file.name);
    const sha256 = createHash("sha256").update(asset.data).digest("hex");
    assert.equal(sha256, file.sha256);
    assert.ok(checksumLines.includes(`${sha256}  ${file.name}\n`));
  }
});

test("安装包损坏、缺失或跨平台版本与提交不一致时，在任何远端写入之前拒绝发布", async t => {
  for (const change of ["checksum", "commit", "version", "missing"]) {
    const options = await fixture(t);
    const path = join(options.inputDir, "macos", "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (change === "checksum") manifest.files[0].sha256 = "0".repeat(64);
    if (change === "commit") manifest.commit = "b".repeat(40);
    if (change === "version") manifest.version = "0.1.7";
    if (change === "missing") manifest.files = [];
    await writeFile(path, JSON.stringify(manifest));
    const mock = githubMock();
    await assert.rejects(publishLatest(options, mock.request));
    assert.equal(mock.calls.length, 0);
  }
});

test("旧提交重新运行不会覆盖最新版", async t => {
  const mock = githubMock({ head: "b".repeat(40) });
  assert.equal((await selectBuilds(event, mock.request)).ready, false);
  const options = await fixture(t);
  const result = await publishLatest(options, mock.request);
  assert.equal(result.published, false);
  assert.ok(mock.calls.every(call => call.method === "GET"));
});

test("首次发布先上传全部安装包，再公开并标记为 GitHub 最新版", async t => {
  const options = await fixture(t);
  const mock = githubMock();
  const result = await publishLatest(options, mock.request);
  assert.deepEqual(result, { published: true, version, url: "https://github.com/example/echo/releases/latest" });
  const create = mock.calls.find(call => call.method === "POST" && call.path.endsWith("/releases"));
  assert.equal(create.body.draft, true);
  assert.equal(create.body.target_commitish, commit);
  assert.equal(mock.calls.filter(call => call.data).length, 5);
  const last = mock.calls.at(-1);
  assert.equal(last.method, "PATCH");
  assert.equal(last.body.draft, false);
  assert.equal(last.body.make_latest, "true");
  assert.ok(last.body.body.includes("/releases/latest/download/Echo-windows-x64-setup.exe"));
  assert.ok(mock.calls.some(call => call.body?.ref === "refs/tags/latest" && call.body.sha === commit));
});

test("再次发布替换固定下载文件并更新 latest 标签，保留用户上传的其他附件", async t => {
  const options = await fixture(t);
  const mock = githubMock({ existing: true });
  await publishLatest(options, mock.request);
  assert.equal(mock.calls.filter(call => call.data).length, 5);
  assert.equal(mock.calls.filter(call => call.method === "DELETE").length, 5);
  assert.ok(!mock.calls.some(call => call.method === "DELETE" && call.path.endsWith("/106")));
  assert.ok(mock.calls.some(call => call.path.endsWith("/git/refs/tags/latest") && call.body.sha === commit));
  assert.ok(!mock.calls.some(call => call.method === "POST" && call.path.endsWith("/releases")));
});

test("首次上传中断后重新运行会继续现有草稿，不创建重复 Release", async t => {
  const options = await fixture(t);
  const mock = githubMock({ existing: true, draft: true });
  const result = await publishLatest(options, mock.request);
  assert.equal(result.published, true);
  assert.ok(!mock.calls.some(call => call.method === "POST" && call.path.endsWith("/releases")));
  assert.equal(mock.calls.at(-1).body.draft, false);
});
