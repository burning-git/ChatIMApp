import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platforms = [
  {
    key: "windows", workflow: "build-windows.yml", target: "x86_64-pc-windows-msvc",
    files: [
      { suffix: "windows-x64-setup.exe", name: "Echo-windows-x64-setup.exe", type: "application/vnd.microsoft.portable-executable" },
      { suffix: "windows-x64.msi", name: "Echo-windows-x64.msi", type: "application/octet-stream" },
    ],
  },
  {
    key: "macos", workflow: "build.yml", target: "universal-apple-darwin",
    files: [{ suffix: "macos-universal.dmg", name: "Echo-macos-universal.dmg", type: "application/octet-stream" }],
  },
];

function trustedBuild(run, repository, branch) {
  return run.conclusion === "success" && ["push", "workflow_dispatch"].includes(run.event)
    && run.head_repository?.full_name === repository && run.head_branch === branch;
}

export async function selectBuilds(event, request) {
  const repository = event.repository.full_name;
  const branch = event.repository.default_branch;
  const run = event.workflow_run;
  if (!trustedBuild(run, repository, branch)) return { ready: false, reason: "Only successful builds of the default branch are published." };
  const base = `/repos/${repository}`;
  const head = await request("GET", `${base}/branches/${encodeURIComponent(branch)}`);
  if (head.commit.sha !== run.head_sha) return { ready: false, reason: "A newer commit is already on the default branch; this build will not replace latest." };
  const result = { ready: true, commit: run.head_sha };
  for (const platform of platforms) {
    const query = new URLSearchParams({ head_sha: run.head_sha, branch, status: "success", per_page: "100" });
    const runs = await request("GET", `${base}/actions/workflows/${platform.workflow}/runs?${query}`);
    const match = runs.workflow_runs.find(candidate => candidate.head_sha === run.head_sha && trustedBuild(candidate, repository, branch));
    if (!match) return { ready: false, reason: `Waiting for the ${platform.key} build of the same commit to succeed.` };
    result[`${platform.key}_run_id`] = match.id;
  }
  return result;
}

export async function prepareAssets(inputDir, commit, sourceRuns) {
  const assets = [];
  const files = [];
  let version;
  for (const platform of platforms) {
    const folder = join(inputDir, platform.key);
    const manifest = JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"));
    assert.equal(manifest.commit, commit, `${platform.key}: installer commit does not match the selected build`);
    assert.equal(manifest.target, platform.target, `${platform.key}: incorrect installer target`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
    version ??= manifest.version;
    assert.equal(manifest.version, version, "Windows and macOS installer versions must match");
    assert.equal(manifest.files.length, platform.files.length, `${platform.key}: incomplete installer set`);
    for (const expected of platform.files) {
      const source = `Echo-${version}-${expected.suffix}`;
      const entry = manifest.files.find(file => file.name === source);
      assert.ok(entry && basename(entry.name) === entry.name, `${platform.key}: missing ${source}`);
      const data = await readFile(join(folder, entry.name));
      const sha256 = createHash("sha256").update(data).digest("hex");
      assert.equal(data.length, entry.bytes, `${source}: installer size mismatch`);
      assert.equal(sha256, entry.sha256, `${source}: installer checksum mismatch`);
      assets.push({ name: expected.name, type: expected.type, data });
      files.push({ name: expected.name, bytes: data.length, sha256 });
    }
  }
  assets.push({ name: "SHA256SUMS.txt", type: "text/plain", data: Buffer.from(files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n") });
  assets.push({ name: "manifest.json", type: "application/json", data: Buffer.from(JSON.stringify({ version, commit, sourceRuns, files }, null, 2) + "\n") });
  return { version, assets };
}

export async function publishLatest({ repository, branch, commit, inputDir, sourceRuns, serverUrl = "https://github.com" }, request) {
  // Validate both builds before changing any release or tag.
  const { version, assets } = await prepareAssets(inputDir, commit, sourceRuns);
  const base = `/repos/${repository}`;
  const head = await request("GET", `${base}/branches/${encodeURIComponent(branch)}`);
  if (head.commit.sha !== commit) return { published: false, reason: "A newer commit is already on the default branch; latest was left unchanged." };
  const releaseUrl = `${serverUrl}/${repository}/releases/latest`;
  const body = [
    `当前版本：**${version}**。此页面在 Windows 和 macOS 安装包均构建成功后自动更新。`,
    "",
    `- [Windows x64 安装程序（EXE）](${releaseUrl}/download/Echo-windows-x64-setup.exe)`,
    `- [Windows x64 安装程序（MSI）](${releaseUrl}/download/Echo-windows-x64.msi)`,
    `- [macOS 安装镜像（Intel + Apple Silicon）](${releaseUrl}/download/Echo-macos-universal.dmg)`,
    "",
    "也可以从下面的 Assets 下载。SHA256SUMS.txt 提供文件校验值。",
    "",
    "Windows 安装包尚未配置代码签名；macOS 使用本地临时签名，尚未配置 Apple Developer ID 与公证。",
  ].join("\n");
  let release = await request("GET", `${base}/releases/tags/latest`, { allowNotFound: true });
  // Recover an unfinished first publication if the tag endpoint omits drafts.
  for (let page = 1; !release; page++) {
    const releases = await request("GET", `${base}/releases?per_page=100&page=${page}`);
    release = releases.find(item => item.tag_name === "latest");
    if (releases.length < 100) break;
  }
  assert.ok(!release?.immutable, "The latest release is immutable; it cannot be updated in place.");
  if (!release) {
    release = await request("POST", `${base}/releases`, {
      body: { tag_name: "latest", target_commitish: commit, name: `回声 Echo 最新版（${version}）`, body, draft: true, prerelease: false },
    });
  }
  const currentAssets = await request("GET", `${base}/releases/${release.id}/assets?per_page=100`);
  for (const asset of assets) {
    const existing = currentAssets.find(item => item.name === asset.name);
    if (existing) await request("DELETE", `${base}/releases/assets/${existing.id}`);
    const uploadUrl = new URL(release.upload_url.replace(/\{.*$/, ""));
    uploadUrl.searchParams.set("name", asset.name);
    await request("POST", uploadUrl.href, { data: asset.data, type: asset.type });
  }
  const tag = await request("GET", `${base}/git/ref/tags/latest`, { allowNotFound: true });
  if (tag) {
    await request("PATCH", `${base}/git/refs/tags/latest`, { body: { sha: commit, force: true } });
  } else {
    await request("POST", `${base}/git/refs`, { body: { ref: "refs/tags/latest", sha: commit } });
  }
  await request("PATCH", `${base}/releases/${release.id}`, {
    body: { name: `回声 Echo 最新版（${version}）`, body, draft: false, prerelease: false, make_latest: "true" },
  });
  return { published: true, version, url: releaseUrl };
}

function githubRequest(token, apiUrl) {
  return async (method, path, { body, data, type, allowNotFound = false } = {}) => {
    const response = await fetch(path.startsWith("https://") ? path : `${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "Content-Type": type || "application/json",
      },
      body: data ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: AbortSignal.timeout(60_000),
    });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  };
}

async function main() {
  assert.ok(process.env.GH_TOKEN, "GH_TOKEN is required");
  const request = githubRequest(process.env.GH_TOKEN, process.env.GITHUB_API_URL || "https://api.github.com");
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  let result;
  if (process.argv[2] === "select") {
    result = await selectBuilds(event, request);
    await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).filter(([key]) => key !== "reason").map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  } else if (process.argv[2] === "publish") {
    result = await publishLatest({
      repository: event.repository.full_name, branch: event.repository.default_branch,
      commit: process.env.RELEASE_COMMIT, inputDir: resolve("release-input"),
      sourceRuns: { windows: process.env.WINDOWS_RUN_ID, macos: process.env.MACOS_RUN_ID },
      serverUrl: process.env.GITHUB_SERVER_URL,
    }, request);
  } else {
    throw new Error("Use select or publish");
  }
  const summary = result.published ? `最新版 ${result.version} 已发布：[下载安装包](${result.url})` : result.reason || "Windows and macOS builds are ready for publication.";
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
