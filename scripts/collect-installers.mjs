import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2];
const platforms = {
  "universal-apple-darwin": {
    label: "macOS · Intel + Apple Silicon",
    installers: [{ folder: "dmg", extension: ".dmg", suffix: "macos-universal.dmg" }],
  },
  "x86_64-pc-windows-msvc": {
    label: "Windows · x64",
    installers: [
      { folder: "nsis", extension: ".exe", suffix: "windows-x64-setup.exe" },
      { folder: "msi", extension: ".msi", suffix: "windows-x64.msi" },
    ],
  },
};
const platform = platforms[target];
if (!platform) throw new Error("请指定 universal-apple-darwin 或 x86_64-pc-windows-msvc");

const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const bundleDir = join(root, "src-tauri", "target", target, "release", "bundle");
const outputDir = join(root, "installers", target);
await mkdir(outputDir, { recursive: true });

if (target === "universal-apple-darwin") {
  const apps = (await readdir(join(bundleDir, "macos"))).filter(name => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error("没有找到唯一的 macOS .app，无法确认打包结果");
  const binary = await readFile(join(bundleDir, "macos", apps[0], "Contents", "MacOS", "echo-desktop"));
  if (binary.length < 8 || binary.readUInt32BE(0) !== 0xcafebabe) {
    throw new Error("macOS 应用不是包含双架构的通用二进制");
  }
  const count = binary.readUInt32BE(4);
  const cpuTypes = [];
  for (let index = 0; index < count; index++) {
    if (8 + index * 20 + 20 > binary.length) throw new Error("macOS 通用二进制头不完整");
    cpuTypes.push(binary.readUInt32BE(8 + index * 20));
  }
  if (!cpuTypes.includes(0x01000007) || !cpuTypes.includes(0x0100000c)) {
    throw new Error("macOS 应用缺少 Intel 或 Apple Silicon 架构");
  }
}

const files = [];
for (const format of platform.installers) {
  const names = (await readdir(join(bundleDir, format.folder))).filter(name => name.endsWith(format.extension));
  if (names.length !== 1) throw new Error(`应生成一个 ${format.extension} 安装包，实际找到 ${names.length} 个`);
  const source = join(bundleDir, format.folder, names[0]);
  const bytes = await readFile(source);
  if (format.extension === ".exe" && bytes.subarray(0, 2).toString() !== "MZ") {
    throw new Error("Windows 安装程序的文件头不正确");
  }
  if (format.extension === ".msi" && bytes.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1") {
    throw new Error("MSI 安装包的文件头不正确");
  }
  if (format.extension === ".dmg" && (bytes.length < 512 || bytes.subarray(-512, -508).toString() !== "koly")) {
    throw new Error("DMG 安装包的文件尾不正确");
  }
  const name = `Echo-${version}-${format.suffix}`;
  await copyFile(source, join(outputDir, name));
  files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}

await writeFile(join(outputDir, "SHA256SUMS.txt"), files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n");
await writeFile(join(outputDir, "manifest.json"), JSON.stringify({ version, target, commit: process.env.GITHUB_SHA || null, files }, null, 2) + "\n");
const location = process.env.GITHUB_ACTIONS
  ? `最新版下载：[GitHub Releases](https://github.com/${process.env.GITHUB_REPOSITORY}/releases/latest)（同次提交的 Windows 和 macOS 打包均成功后自动更新）。\n\n本次构建的 ZIP 备份：从 **Artifacts** 下载 \`Echo-${target}\`。`
  : `安装包已保存到 ${outputDir}`;
const summary = `### ${platform.label}\n\n` + files.map(file => `- ${file.name} (${(file.bytes / 1024 / 1024).toFixed(1)} MB)`).join("\n") + `\n\n${location}\n\n`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
