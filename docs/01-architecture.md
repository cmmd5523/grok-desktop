# 01 · 整体架构

## 1. 定位与技术栈

`grok-desktop` 是一个 **Electron 桌面应用**,本身不实现模型推理,而是作为客户端:

- 与 **grok2api 网关**(OpenAI 兼容 `/v1/chat/completions`)通信获取流式回复;
- 与配套 **登录服务器(grok-server)** 通信完成注册 / 验证 / 登录 / 用量上报 / 会话云同步。

| 层面 | 选型 |
| --- | --- |
| 桌面运行时 | Electron `^43.4.1` |
| 主进程语言 | Node.js(CommonJS,`require`) |
| 渲染进程 | 原生 DOM + 少量模块(`marked` / `dompurify`),由 esbuild 打包为 IIFE |
| 安全模型 | `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false` + CSP |
| 密钥存储 | Electron `safeStorage`(Windows DPAPI / macOS Keychain) |
| 打包 | electron-builder(Windows NSIS / portable;macOS dmg / zip,Intel + arm64) |
| CI | GitHub Actions(`.github/workflows/build.yml`) |

## 2. 进程模型

Electron 的三层结构,本项目严格遵循"渲染进程纯 UI、主进程负责特权操作"的分工。

```
┌──────────────────────────────────────────────────────────────────────┐
│                          主进程 (src/main.js)                          │
│  • BrowserWindow / 应用菜单 / 单实例锁                                  │
│  • 全部 ipcMain.handle 业务:认证、设置、会话、聊天、文件、更新           │
│  • safeStorage 加解密、fs 读写、dialog、shell.openExternal             │
│  • 通过 api.js 发起对外 HTTP(优先 Electron net.fetch,走系统代理)       │
└───────────────▲─────────────────────────────────────────────┬────────┘
                │ ipcMain.handle / webContents.send            │ net.fetch
     ┌──────────┴───────────┐                       ┌───────────▼──────────┐
     │ preload.js (沙箱预加载) │                       │  外部服务             │
     │ contextBridge 暴露     │                       │  • grok2api 网关       │
     │ window.grokAPI         │                       │  • 登录服务器(grok-server)│
     └──────────┬───────────┘                       │  • GitHub Releases API │
                │ 受控 API                             └──────────────────────┘
     ┌──────────▼──────────────────────────────────┐
     │ 渲染进程 (src/renderer/*)  sandbox + contextIsolation │
     │ index.html + styles.css + renderer.bundle.js  │
     │ 纯 UI:状态机、DOM 渲染、Markdown、事件绑定       │
     └───────────────────────────────────────────────┘
```

要点:

- **渲染进程无 Node 能力**:`sandbox: true` 且 `nodeIntegration: false`,只能通过 `window.grokAPI`(定义于 [preload.js](../src/preload.js))调用主进程。
- **信息单向受控**:主进程通过 `ipcMain.handle` 暴露能力,通过 `webContents.send('chat:delta' | 'update:progress', ...)` 向渲染进程推送流式数据与进度。
- **网络集中在主进程**:`api.js` 的 `doFetch` 优先使用 `electron.net.fetch`(Chromium 网络栈,遵循系统代理),避免纯 Node `fetch`(undici)忽略代理导致 `https` 请求失败。
- **主进程直接调用外部 fetch**:认证(`authFetch`)和云同步(`ssoConvFetch`)使用全局 `fetch` / `net.fetch`,附带超时 `AbortSignal.timeout`。

## 3. 外部服务交互

### 3.1 grok2api 网关(模型推理)

- 端点:`{baseUrl}/chat/completions`(流式 / 非流式)、`{baseUrl}/models`(模型列表)。
- 认证:`Authorization: Bearer <API key>`。
- 流式格式:OpenAI SSE(`data: {...}\n\n`,以 `data: [DONE]` 结束)。
- 本项目依赖网关的一项补丁:**在 `[DONE]` 前补发含 `usage` 的 chunk**,以获得真实 token 计数(见 `tools/patch-stream-usage.py`)。

### 3.2 登录服务器(grok-server,默认 `https://md-grok.de5.net`)

由 `DEFAULT_AUTH_URL` 指定(`src/config.local.js`,缺省回退 `https://md-grok.de5.net`)。提供:

| 路径 | 用途 |
| --- | --- |
| `POST /api/auth/register` | 邮箱注册(返回 `email`,可能带 `demoCode`) |
| `POST /api/auth/verify` | 验证码激活并签发 token |
| `POST /api/auth/login` | 邮箱 + 密码登录 |
| `GET /api/auth/config` | 获取 Turnstile site key |
| `GET /api/auth/device/poll?device=<id>` | 设备码登录轮询 |
| `POST /api/me/usage/report` | 上报每次对话的 token 用量 |
| `GET|PUT|DELETE /api/conversations[/:id]` | 云端会话同步(基于 `baseUrl` 的 origin) |
| `GET /api/chat/models` | 经 JWT 校验的模型列表 |
| `POST /api/chat` | **SSO 模式聊天入口**:校验 JWT 后内部转发到 grok2api |

### 3.3 GitHub Releases

- 自动更新直接从 `https://api.github.com/repos/cmmd5523/grok-desktop/releases/latest` 拉取最新版本信息与安装包资产(见 [04-flows.md](./04-flows.md#47-自动更新流程))。

## 4. 两种"直连 / SSO"运行模式

应用支持两种网关接入方式,由是否已登录决定:

| 模式 | 条件 | 聊天请求路径 | 凭证 |
| --- | --- | --- | --- |
| **直连网关** | 未配置登录服务器 / 无 token | `{baseUrl}/chat/completions` | 本地 `apiKeyEnc`(DPAPI 加密的 API Key) |
| **SSO 模式** | 已登录且 `baseUrl` 可解析出 origin | `{origin}/api/chat` | 会话 JWT(`authTokenEnc`) |

> 但注意:`chat:start` 中无论何种模式都要求**已登录**(`if (!ssoToken) throw`),且模型列表优先走 SSO。
> 直连模式主要用于 `tools/` 中的诊断脚本与本地调试。

## 5. 构建与产物

```
src/renderer/renderer.js  ──esbuild──▶  dist/renderer.bundle.js  ─┐
src/renderer/index.html   ────────────────────────────────────────┤
src/renderer/styles.css   ────────────────────────────────────────┤
src/main.js / preload.js / api.js / store.js / config.example.js ─┴─▶ electron-builder
                                                                        │
                                    ┌───────────────────────────────────┤
                                    ▼                                   ▼
                             release/*.exe (Win NSIS)            release/*.dmg|zip (mac)
```

- `npm run build` 只做渲染进程打包(esbuild,`--bundle --minify --format=iife`)。
- 打包时 `package.json > build.files` 收录 `src/**`、`dist/**`、`package.json`,因此 `dist/renderer.bundle.js` 必须先生成。
- `index.html` 通过 `<script src="../../dist/renderer.bundle.js">` 引用打包结果(相对 `src/renderer/`)。

## 6. 相关文档

- 模块细节 → [02-modules.md](./02-modules.md)
- 函数与 IPC 全表 → [03-api-reference.md](./03-api-reference.md)
- 业务流程 → [04-flows.md](./04-flows.md)
