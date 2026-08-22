# Grok 桌面客户端

![Build](https://github.com/cmmd5523/grok-desktop/actions/workflows/build.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Windows 10 / 11 桌面端 Grok 聊天应用,基于 **Electron**,通过 OpenAI 兼容 API(grok2api 自建网关)与 Grok 对话。界面采用 DeepSeek Harness Desktop 设计系统(暗色令牌、圆角气泡、粘性输入区),应用与界面统一使用 **Grok 星形品牌标记**(深色渐变底 + 白色 8 芒星,`.ico` 全尺寸 16–256)。

> 🚀 每次推送到 `main` 或打 `v*` tag,GitHub Actions 会自动构建 Windows 安装包(产物见仓库 Actions 页面 artifact;打 tag 会自动发布 GitHub Release)。

## 发布新版本

一条命令搞定版本号 + tag + 推送(GitHub Actions 随后自动构建安装包并发布 Release):

```powershell
npm run release              # patch: 1.0.0 -> 1.0.1
npm run release -- minor     # minor: 1.0.0 -> 1.1.0
npm run release -- major     # major: 1.0.0 -> 2.0.0
npm run release -- --dry-run # 只预览,不实际执行
```

发布前请确保工作区无未提交改动(脚本会检查);发布后约 3-5 分钟,仓库 Releases 页出现带安装包的版本。

## 功能

- 🪟 独立桌面窗口,深色主题,适配 Windows 10 / 11,界面完整复刻 DeepSeek Harness Desktop 布局(侧边栏 + 消息列 + 悬浮胶囊输入卡);窗口尺寸/位置自动记忆
- 🎛 **composer 工具栏**(照抄 DSH InputBar):左下角「＋」命令菜单(上传文件 / 压缩历史 / 导出会话 / 模型)、权限选择(只读 / 读写 / 完全访问)、右下角模型选择(模型 + 推理等级 关/低/中/高)、上下文占用圆环、34px 蓝色发送键
- 🗜 **压缩历史**:把较旧对话交给 Grok 生成摘要并折叠(compact)
- ⤓ **导出会话**:一键保存为 Markdown 文件
- 📊 **上下文占用环**:输入框右下角环形指示器,点击查看明细(百分比 + 系统/消息/附件分段)
- 📊 **会话统计栏**(输入框下方):轮数 · 消息数 | 生成耗时 · 首 token 延迟 | 输出速度 tok/s | 输入/输出 token 计数。token 数为**网关 tiktoken(o200k_base)真实分词**(已为 grok2api 流式响应补发 usage chunk);旧对话或第三方网关无 usage 时回退为客户端估算并标注 `≈`
- 📎 **文件上传**:支持 PDF / PPT / PPTX / DOC / XLS / TXT / MD / CSV / 图片 / 音频 / ZIP 等,可多选,让 Grok 读取文件内容后按要求回答
- ⚡ 流式回复(SSE),逐字显示(品牌蓝"正在思考…"指示器),可随时停止生成;超长回复自动降频渲染防卡顿
- 💬 多轮对话,会话历史本地持久化(自动保存,含附件;**>3 MB 的附件内容不落盘**,仅保留名称/大小,气泡内标注「⚠ 未保存」,防止存档无限膨胀)
- 📝 Markdown 渲染(代码块、表格、引用等),代码块一键复制
- 🧠 可切换模型(grok-4.3 / grok-4.20 系列),自动拉取网关可用模型(已过滤 console 类模型)
- 🔑 API Key 使用 Windows DPAPI 加密存储(`safeStorage`),不落明文
- ⚙️ API 地址可配置,默认指向自建 grok2api 网关
- 🔒 渲染进程沙箱化(contextIsolation + sandbox),外部链接走系统浏览器
- ⚡ 发送消息时增量渲染(只追加新气泡,不重排历史),大对话不卡

## 内置配置与密钥安全

软件支持「开箱即用」:构建/打包时若存在 `src/config.local.js`,其内置网关地址与 API Key 会在首次启动时写入本地并用 **Windows DPAPI 加密**存储(`safeStorage`),不落明文。

> ⚠️ 本仓库是**公开源码**,`src/config.local.js` 已被 `.gitignore` 排除,**不会**上传 GitHub。仓库内只提交占位模板 `src/config.example.js`。克隆后请:
>
> 1. 复制 `src/config.example.js` 为 `src/config.local.js`,填写你的 grok2api 网关地址与 Key;或
> 2. 直接运行应用,在「⚙ 设置」中填写(同样 DPAPI 加密保存)。

| 配置项 | 说明 |
| --- | --- |
| API 地址 | `src/config.local.js` 的 `DEFAULT_BASE_URL` 或「设置」中填写,支持任意 OpenAI 兼容网关 |
| API Key | `src/config.local.js` 的 `DEFAULT_API_KEY` 或「设置」中填写,DPAPI 加密落盘 |
| 默认模型 | `grok-4.3-fast`(可在模型菜单中切换) |

## 环境要求

- Windows 10 / 11 x64
- Node.js 18+(仅开发/构建时需要;打包后的安装包无需 Node)

## 快速开始

```powershell
npm install
npm start
```

> 首次安装如遇 Electron 二进制未下载,可手动执行:`node node_modules/electron/install.js`

### 打包成安装程序

```powershell
npm run dist          # NSIS 安装程序 → release/
npm run dist:portable # 免安装便携版 exe
```

## 常用操作

| 操作 | 方式 |
| --- | --- |
| 发送消息 | `Enter` |
| 换行 | `Shift + Enter` |
| 上传文件 / 压缩历史 / 导出 / 模型 | 输入框左下角「＋」命令菜单 |
| 切换权限(只读/读写/完全) | 「＋」右侧权限 chip |
| 切换模型 / 推理等级 | 输入框右下角模型 chip(模型 → 分组列表;推理等级 → 关/低/中/高) |
| 查看上下文占用 | 模型右侧圆环 |
| 停止生成 | 发送键变「■」时点击 |
| 新建对话 | 侧边栏「＋ 新对话」 |
| 切换对话 | 点击左侧会话列表 |
| 删除对话 | 悬停会话条目,点「×」 |

## 数据存储位置

- 设置:`%APPDATA%/grok-desktop/settings.json`(API Key 为 DPAPI 密文)
- 会话:`%APPDATA%/grok-desktop/conversations.json`(含附件数据)

删除这两个文件即可完全重置应用。

## 常见问题

**发送后提示「服务器返回了空响应」** — 检查 API 地址是否真正指向 grok2api 服务。若访问地址的任意路径都只返回字面 `OK`,说明 nginx 反代尚未连接到 grok2api 应用。

**提示「上游服务返回错误:Console API returned 403」** — 推理等级(低/中/高)模型(即 `grok-4.3-low/medium/high` 等)在当前网关账号下被 xAI Console API 拒绝(账号无 reasoning 档位权限,属上游限制,非应用故障)。请把推理等级切回「关」(使用 `grok-4.3-fast`)即可正常对话与上传文件。换用有 reasoning 权限的网关账号后可解锁该档位。

**统计栏显示 `≈` 而不是真实 token** — 本应用已为自建 grok2api 打上「流式补发 usage」补丁(修改 `app/products/openai/chat.py`,在 `[DONE]` 前发射含 usage 的空 choices chunk)。若重新部署/重建镜像覆盖了该改动,或连接第三方网关,则会回退为客户端估算并显示 `≈`。

**上传文件没有效果** — grok.com 系模型(如 grok-4.3-fast)支持文件读取;单个文件上限 25MB,格式支持 PDF/Office/文本/图片/音频等。

**401 错误** — API Key 无效,与网关后台 `app.api_key` 不一致。

**429 限流** — 请求过于频繁;console 免费模型已默认过滤,可稍后再试或换账号池。

**模型列表为空** — 网关 `/v1/models` 需返回标准 OpenAI 格式 JSON;暂不可用时使用内置默认模型列表。

**无法连接 / 超时** — 检查本机能否访问 API 地址;部分网络环境需代理。

## 技术栈

- Electron 43(主进程负责网络请求、文件读取与安全存储,渲染进程纯 UI)
- marked + DOMPurify(Markdown 渲染与消毒)
- esbuild(前端打包)
- electron-builder(Windows 安装包)

## 目录结构

```
grok-desktop/
├── src/
│   ├── main.js            # 主进程:窗口、IPC、DPAPI 加密、文件选择、流式转发
│   ├── api.js             # OpenAI 兼容 API 客户端(SSE 流式、错误处理)
│   ├── store.js           # JSON 原子持久化
│   ├── preload.js         # 安全桥接(contextBridge)
│   └── renderer/          # 渲染进程 UI
│       ├── index.html
│       ├── styles.css     # DSH 设计系统
│       └── renderer.js
├── dist/                  # 构建产物(自动生成)
├── tools/                 # 服务器诊断/测试脚本(ssh.py、test-*.js)
└── package.json
```
