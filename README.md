# Echo · AI 对话工作台

一个面向 Windows 与 macOS 的本地优先 AI 桌面工作台。前端使用 React + Vite，桌面层使用 Tauri 2，数据按天写入 SQLite。

项目的六项主要功能已有实现。前端类型检查、生产构建、28 项聊天与发布测试和 20 项 Rust 原生测试已通过。macOS 通用应用与 DMG 支持 Intel 和 Apple Silicon。真实模型调用需要在设置中填写自己的 API 地址、Key 和模型。

当前测试包：`installers/universal-apple-darwin/Echo-0.1.9-macos-universal.dmg`。先退出正在运行的旧版本，打开 DMG，将「回声 Echo.app」拖入 Applications 并替换旧版本；原有设置和会话会保留。设置页底部可确认版本。安装镜像、应用签名和 Intel / Apple Silicon 双架构已通过校验。此版本使用本地临时签名，尚未配置 Apple Developer ID 与公证。

**下载安装包：[GitHub Releases 最新版](https://github.com/burning-git/ChatIMApp/releases/latest)**。默认分支每次提交的 Windows 和 macOS 打包均成功后，会自动更新这个固定页面。

| 平台 | 直接下载最新版 |
| --- | --- |
| Windows x64 | [EXE 安装程序](https://github.com/burning-git/ChatIMApp/releases/latest/download/Echo-windows-x64-setup.exe) · [MSI 安装程序](https://github.com/burning-git/ChatIMApp/releases/latest/download/Echo-windows-x64.msi) |
| macOS（Intel + Apple Silicon） | [DMG 安装镜像](https://github.com/burning-git/ChatIMApp/releases/latest/download/Echo-macos-universal.dmg) |

## 已实现

- OpenAI Chat Completions 协议：模型管理支持添加多个模型，每项独立配置显示名称、API Base URL、API Key 和模型名，并指定新会话的默认模型。
- 会话独立选择模型，发送和重试使用该会话所选模型的地址、Key 和模型名；支持不同模型同时对话。升级自动迁移旧单模型配置，修改默认项不会切换已有会话。被会话使用的模型需先更换会话选择后才能删除。新回复记录实际使用的模型名，切换模型不会重标历史回复；旧回复缺少模型记录时显示「历史回复」。
- 桌面端自动使用系统代理，连接错误显示具体原因，方便检查代理或 API 地址。
- 每条用户消息和 AI 回复下均提供「复制」和「重试」。复制完整文字到系统剪贴板，并显示「已复制」；纯图片消息没有可复制文字，仍可重试。
- 历史消息重试：使用截至原提问的上下文和图片，成功后只替换对应 AI 回复，保留后续消息与原回复的时间位置；失败保留原回复。未回复的提问重试成功后，在该提问后补上回复，不重复写入用户消息；重新启动后也可重试。
- 每个会话独立的 System 提示词、流式请求开关和温度，可随时编辑会话名称。新会话默认开启流式请求，温度为 0；升级保留已保存的会话参数。
- 文字与图片消息：支持选择本地图片、拖入图片或输入 HTTP(S) 图片直链。链接图片会直接保留原 URL 发送，本地选择的图片才会转换为 `data:` Base64；两种来源可以混用，每条消息最多 9 张。链接图片不会被应用下载或缓存。
- macOS 文件窗口的空对象保护：系统无法创建选择窗口时取消本次选择，避免 App 整体崩溃。若窗口未出现，请退出后重新打开应用，再选择图片；也可直接拖入图片。
- 多会话工作区：会话标签、并行生成状态，桌面端最多同时 8 个请求。
- 每日数据库：应用本地数据目录中的 `YYYY-MM-DD.sqlite`，消息与会话按天归档。
- 局域网只读分享：开启后在右侧「局域网访问」标题下方显示当前会话的二维码和临时访问链接，保留原有栏目顺序。其他设备连接同一网络后可扫码打开，二维码在本机生成。访问者可阅读当前会话并逐条复制完整文字；关闭访问后二维码和链接立即失效。
- 浏览器预览：未启动 Tauri 时会退化为 localStorage 预览，便于先走查界面。

## 开发

前置条件：Node.js 20.19+（建议 22）、最新 stable Rust；macOS 安装 Xcode Command Line Tools；Windows 安装 Visual Studio C++ Build Tools 和 WebView2。

```bash
npm ci
npm run dev
```

开发桌面应用：

```bash
npm run tauri dev
```

构建安装包：

```bash
npm run package:mac
```

Tauri 在对应平台上生成安装包：macOS 生成 `.app` / `.dmg`，Windows 生成 NSIS `.exe` / `.msi` 安装包。在 Windows 上可运行：

```bash
npm run package:win
```

Windows 安装包自动收集到 `installers/x86_64-pc-windows-msvc/`，包括 `Echo-0.1.9-windows-x64-setup.exe`、`Echo-0.1.9-windows-x64.msi`、`SHA256SUMS.txt` 和 `manifest.json`。版本号随项目版本更新。当前 Windows 安装包尚未配置代码签名。

MSI 使用 `zh-CN` 语言及对应代码页，以支持「回声 Echo」的中文应用名称。Windows 打包开启详细日志；若 Actions 打包失败，可从 `Echo-windows-packaging-diagnostics` 下载完整日志及 WiX 中间文件，查看具体错误。

GitHub Actions 在推送到 `main` / `master`、推送 `v*` 标签或创建 Pull Request 时自动测试并打包，也支持从 Actions 页面手动启动：

| 平台 | 工作流 | 运行页 Artifacts 下载项 |
| --- | --- | --- |
| Windows x64 | [Build Windows installers](https://github.com/burning-git/ChatIMApp/actions/workflows/build-windows.yml) | `Echo-x86_64-pc-windows-msvc` |
| macOS（Intel + Apple Silicon） | [Build macOS installer](https://github.com/burning-git/ChatIMApp/actions/workflows/build.yml) | `Echo-universal-apple-darwin` |

默认分支同一次提交的两个平台打包都成功后，`Publish latest installers` 工作流会校验版本、提交与 SHA-256，并将安装包上传到固定的 `latest` Release，标记为 GitHub 最新版。Releases 文件名保持固定，上面的直接下载链接在更新后继续有效；校验清单与版本信息也会同步更新。旧提交的重跑、其他分支和 Pull Request 不会覆盖最新版，打包失败时保留上一次发布。

手动打包时打开对应工作流，点击 **Run workflow** 并选择默认分支；两个平台需针对同一次提交都完成构建。日常下载从 **Releases → 最新版 → Assets** 取得 EXE、MSI 或 DMG。每次运行也保留 **Artifacts** ZIP 备份 30 天，Release 安装包不受这个 30 天期限影响。构建与发布使用 GitHub 自带的工具及 `GITHUB_TOKEN`，不需要配置额外 Secrets。

macOS 通用构建需要安装 `aarch64-apple-darwin`、`x86_64-apple-darwin` 两个 Rust target。当前工程已在 `.build-tools` 内安装独立 Rust，`package:mac` 会自动使用它；其他机器可使用自己的最新 stable Rust。构建结束后自动收集 DMG 到 `installers/universal-apple-darwin/` 并生成 SHA-256 校验清单。正式对外分发需要配置 Apple Developer ID 签名与 macOS 公证。

```bash
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml file_picker_regressions
```

前端测试覆盖多模态请求、System 指令、8 路并发、同会话重复请求、错误恢复、设置更新、跨天归档、历史重试、剪贴板写入、会话级 Temperature 与流式 SSE，以及图片链接 URL 保留、9 张混合图片上限、Base64 本地图片校验、跨日删除图片记录和网页复制的 HTTP 兼容与剪贴板失败回退。Rust 测试覆盖跨日数据库合并、图片存储、分享 HTML 转义与复制原文、请求占用释放、旧数据库迁移、新会话默认值落库和既有参数保留，以及通过本地 HTTP 接口验证图片下载不携带认证、非图片和超大响应处理、流式增量、历史回复替换、失败保留原文和后续消息保留。隔离浏览器走查已验证会话默认值、两种图片入口的预览及分享页复制。已验证系统代理下 API 的 DNS/TLS 连通性；真实模型联调及另一台设备的局域网访问仍需用户测试。

0.1.2 使用带空对象保护的本地 Wry 0.57.0 副本，并增加 2 项文件选择回归测试，修复报告中的 `NSOpenPanel::openPanel` 空返回导致的崩溃。独立 Mac 测试应用已验证图片按钮正常打开系统选择窗口，后续界面也已显示图片消息和模型回复。补丁来源、许可证及升级后移除步骤见 `src-tauri/vendor/wry/ECHO-PATCH.md`。

## 使用

1. 打开左下角设置，在「模型管理」中填写显示名称、API 地址（例如 `https://api.openai.com/v1`）、Key、模型名。点击「添加模型」继续添加，并选择新会话使用的默认模型。也支持完整的 `/chat/completions` 地址。
2. 新建会话默认开启流式请求、温度为 0；点击「会话设置」可独立选择模型、修改专属指令、流式请求开关和温度。Enter 发送，Shift + Enter 换行，⌘/Ctrl + K 新建会话，⌘/Ctrl + F 搜索会话。
3. 输入文字，点击「本地图片」选择附件、将图片拖入输入区域，或点击「图片链接」输入 HTTP(S) 图片直链；添加成功后会显示预览，再发送。每条消息最多 9 张图片；本地 PNG/JPEG/WebP/GIF 每张不超过 12 MB，链接图片需能被模型服务访问；图像能力取决于所选模型。
4. 回复生成期间切换标签，可同时发送其他会话。最多 8 个不同会话并发，同一会话每次生成一个回复。
5. 桌面端点击右侧「开启局域网访问」，二维码会直接显示在右栏顶部，无需弹窗。其他设备连接同一局域网后扫码即可访问，也可点击「复制访问链接」分享链接。切换会话时会显示各自的二维码，点击右侧「关闭访问」立即撤销该会话的链接和二维码。网页中可逐条复制完整文字，刷新可看到最新记录；应用需要保持运行，系统防火墙需要允许局域网访问。
6. 点击任意用户消息或 AI 回复下的「复制」，可复制该条完整文字；点击「重试」重新生成该轮回复。重试使用当前连接设置与会话提示词，以及截至原提问的上下文和图片；成功后替换该轮 AI 回复，保留后续消息，失败时原回复不变。重试不影响输入框中的新草稿。发送失败也可以使用错误提示中的「重试」。

每个会话可在「会话设置」中独立选择流式请求；开启后，兼容 OpenAI Chat Completions 的 SSE 增量会逐步显示，只有收到完整回复才写入数据库。流中断会保留旧回复，便于重试。每个会话还可设置 Temperature（0–2，默认 0），留空时不传参数并使用模型默认值。升级保留已保存的参数，只有缺少参数的旧记录使用新默认值。图片链接只需是 HTTP(S) 直链，应用会直接把它交给模型服务；普通网页链接可能无法被模型识别。链接图片预览受目标网站的图片访问策略影响。删除会话会删除消息中的 Base64 和链接记录，并回收本地数据库空间；原始本地图片文件和远程图片不会被删除。

## 数据位置

数据库和连接设置由 Tauri 的 `app_local_data_dir` 管理，数据库文件放在其下的 `data` 子目录。以本机当地日期分库，跨天继续同一个会话时，新消息写入当天数据库，读取时合并该会话所有日期的记录。SQLite WAL 的 `-wal` / `-shm` 文件是同一数据库的临时伴随文件。

`settings.json` 保存多个模型的配置及默认选择，各会话选择保存在每日数据库。当前 Key 为本地明文文件，macOS 下限制为当前用户可读写；界面以密码框显示。浏览器预览使用浏览器 localStorage，不会写入桌面数据库，也不提供局域网分享。桌面端请求通过 Rust 发送，不受浏览器跨域限制。
