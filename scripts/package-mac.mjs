import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("macOS 安装包需要在 Mac 上构建");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildTools = join(root, ".build-tools");
const toolchainBin = join(buildTools, "rustup", "toolchains", `stable-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`, "bin");
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "11.0", CI: "true" };
if (existsSync(join(toolchainBin, "cargo"))) {
  env.RUSTUP_HOME = join(buildTools, "rustup");
  env.CARGO_HOME = join(buildTools, "cargo");
  env.PATH = `${toolchainBin}:${process.env.PATH || ""}`;
}
const result = spawnSync(join(root, "node_modules", ".bin", "tauri"), [
  "build", "--target", "universal-apple-darwin", "--bundles", "app,dmg", "--", "--locked",
], { cwd: root, env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
const collect = spawnSync(process.execPath, [join(root, "scripts", "collect-installers.mjs"), "universal-apple-darwin"], { cwd: root, env, stdio: "inherit" });
if (collect.error) throw collect.error;
process.exit(collect.status || 0);
