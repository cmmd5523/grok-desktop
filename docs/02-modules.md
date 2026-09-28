# 02 · 主要模块职责

本页按文件逐个说明模块职责、关键内部结构与依赖关系。函数级细节见 [03-api-reference.md](./03-api-reference.md)。

---

## 2.1 主进程 `src/main.js`(886 行)

应用的"特权中枢",负责所有需要系统能力与网络的逻辑。可划分为以下职责块:

| 职责块 | 关键函数 / 常量 | 说明 |
| --- | --- | --- |
| 配置装载 | `loadDefaultConfig()` | 优先 `require('./config.local')`,缺失时回退 `config.example`,再缺失返回空占位。导出 `DEFAULT_BASE_URL / DEFAULT_API_KEY / DEFAULT_AUTH_URL` |
| 密钥加密 | `encryptSecret` / `decryptSecret` / `maskSecret` | 基于 `safeStorage` 的 `enc:` / `plain:` 前缀编码,见 [05-data-storage.md](./05-data-storage.md) |
| 认证 | `authFetch` / `authToken` / `authUser` / `saveAuth` + `auth:*` IPC | 与登录服务器通信,持久化 token 与用户信息 |
| 文件 | `MIME_MAP` / `mimeOf` / `sanitizeContent` / `formatBytes` / `buildMarkdownExport` | 文件 MIME 推断、消息内容块净化、导出 Markdown 生成 |
| 窗口与菜单 | `createWindow` / `buildMenu` / `restoreWindowBounds` / `saveWindowBounds` | 窗口创建(含沙箱 webPreferences)、中文菜单、窗口尺寸/位置记忆 |
| 自动更新 | `semverGt` / `pickUpdateAsset` + `update:*` IPC | 语义化版本比较、按平台/架构挑选安装包、下载与启动安装 |
| 设置 | `settings:get` / `settings:set` | 读写设置并对 `baseUrl` 做协议校验 |
| 会话 | `conversations:list/get/save/delete` + `ssoConvFetch` / `ssoOrigin` | 本地 JSON 持久化 + 云端合并 |
| 聊天 | `chat:start` / `chat:stop` + `friendlyNetError` | 组织消息、调用 `streamChat`、转发 delta、网络错误中文化 |
| 压缩 / 导出 / 模型 / 文件选择 | `chat:compact` / `conversation:export` / `models:list` / `files:select` | 会话压缩摘要、Markdown 导出对话框、模型列表、文件选择对话框 |
| 生命周期 | `app.requestSingleInstanceLock` / `whenReady` / `window-all-closed` / `will-quit` | 单实例、初始化 store、退出时中止活动流 |

**关键模块级状态**

- `mainWindow` — 主窗口引用。
- `settingsStore` / `conversationsStore` — 由 `store.js` 创建的两个持久化实例。
- `activeStream = { controller, requestId }` — 当前活动的流式请求,用于 `chat:stop` 与退出中止。
- `MAX_FILE_BYTES = 25MB`,`MAX_PERSIST_DATA_URI = 4MB` — 附件大小与落盘上限。

**依赖关系**:`main.js` → `./store`、`./api`、`electron`、Node `fs`/`path`/`stream/promises`。

---

## 2.2 预加载桥 `src/preload.js`(40 行)

在沙箱环境下通过 `contextBridge.exposeInMainWorld('grokAPI', {...})` 暴露**唯一**的渲染进程 API 面。

- 所有方法均为 `ipcRenderer.invoke('<channel>', args)` 的薄封装。
- 事件订阅(返回取消订阅函数):
  - `onUpdateProgress(cb)` → 监听 `update:progress`
  - `onChatDelta(cb)` → 监听 `chat:delta`

> 这是安全边界:渲染进程只能调用此处列出的能力,无法直接访问 Node / Electron API。完整清单见 [03-api-reference.md](./03-api-reference.md#33-windowgrokapi-预加载桥)。

---

## 2.3 API 客户端 `src/api.js`(238 行)

封装 OpenAI 兼容协议的 HTTP 客户端,**仅在主进程使用**。

| 函数 / 类 | 作用 |
| --- | --- |
| `doFetch(url, options)` | 优先 `electron.net.fetch`,否则回退全局 `fetch` |
| `fetchWithConnectTimeout(url, options, signal)` | 连接超时 + 大包超时 + 瞬时网络错误重试一次 + 用户取消透传 |
| `normalizeBaseUrl(baseUrl)` | 去尾斜杠,空值回退 `https://api.x.ai/v1` |
| `jsonOrText(response)` | 解析 JSON,失败返回原始文本 |
| `friendlyStatus(status, body)` | 将 401/403/404/429/5xx 转为中文提示 |
| `parseSseDataLine(line, onDelta, onUsage, onError)` | 解析单行 SSE:提取 `delta.content`、`usage`、`error` |
| `streamChat({...})` | 流式对话主函数,返回 usage(或 `null`) |
| `completeChat({...})` | 非流式对话,返回首条消息文本(用于压缩历史) |
| `listModels(baseUrl, apiKey)` | 拉取 `/models`,返回 id 数组 |
| `ApiError` | 携带 `status` / `body` 的自定义错误类 |

**超时常量**:`CONNECT_TIMEOUT_MS = 20000`,`LARGE_BODY_TIMEOUT_MS = 180000`(body > 1MB 时启用)。

---

## 2.4 持久化 `src/store.js`(39 行)

`createStore(filePath, defaults)` 返回一个极简 JSON 存储对象:

- `get()` — 返回内存数据副本(浅拷贝)。
- `set(patch)` — 合并补丁、原子保存、返回最新副本。
- `save()` — 写 `filePath + '.tmp'` 后 `rename` 覆盖,保证原子性;`mkdir -p` 父目录。

> 启动时读取一次,后续全部内存操作 + 落盘,避免频繁 IO。任何读写异常只 `console.error`,不抛出。

---

## 2.5 渲染进程 `src/renderer/renderer.js`(1593 行)

纯 UI 层,由 esbuild 打包(入口含 `import`)。按功能分区:

| 分区 | 主要函数 | 说明 |
| --- | --- | --- |
| 状态 | `state` 对象 | 当前设置、权限、模型列表、会话、流式标志、待发附件、认证状态 |
| token 估算 / 统计 | `estimateTokens` / `computeSessionStats` / `fmtDuration` / `fmtTokens` / `renderStatsLine` | CJK≈1 token、拉丁≈4 字符/token 的启发式估算;会话统计栏 |
| 菜单系统 | `closeMenus` / `toggleMenu` / `openModelMenu` / `showModelSub` / `showEffortSub` / `selectEffort` | 命令 / 权限 / 模型 / 上下文四类弹出菜单 |
| 权限 | `PERMISSIONS` / `applyPermissionUI` / `setPermission` | readonly / readwrite / full 三档 |
| 模型 | `resolveModel` / `currentSendModel` / `modelGroups` / `renderModelChip` / `populateModelList` / `applyModels` / `refreshModels` | 基础模型 + 推理等级 → 实际发送模型 |
| 上下文环 | `updateContextMeter` | 环形指示 + 分段占用明细(系统 / 消息 / 附件) |
| Markdown | `renderMarkdown` | `marked` 解析 → `DOMPurify` 消毒 → 代码块复制按钮、外链 `target=_blank` |
| 会话渲染 | `renderConvList` / `renderConversation` / `showEmptyState` / `appendUserMessageEl` / `appendAssistantMessageEl` | 侧边栏列表、消息气泡、空态 |
| 会话操作 | `refreshConversations` / `openConversation` / `newConversation` / `persistConversation` / `deleteConversation` / `ensureConversation` | 增删查改 |
| 附件 | `selectFiles` / `renderPendingFiles` / `renderAttachmentChips` / `fileKind` / `fileIcon` | 待发附件 chip、消息内附件 chip |
| 发送 / 流式 | `send` / `streamReply` / `schedulePendingRender` / `stopStreaming` / `setStreamingUI` / `appendMetaLine` | 发送主流程与增量渲染节流 |
| 压缩 / 导出 | `compactConversation` / `exportConversation` | 调用对应 IPC |
| 设置 / 更新 | `openSettings` / `closeSettings` / `saveSettings` / `runUpdateCheck` / `downloadUpdate` / `installUpdate` / `updateUi` | 设置弹窗与自研更新 UI |
| 认证 UI | `bindAuthEvents` / `checkAuth` / `showAuthScreen` / `showAppScreen` / `setAuthTab` / `maybeRenderTurnstile` | 登录 / 注册 / 验证 / 设备码登录 / Turnstile |
| 初始化 | `init` / `wireEvents` / `resizeInput` / `updateComposerButtons` | 启动装配与事件绑定 |

**关键常量**

- `DEFAULT_MODELS` — 网关不可用时的回退模型列表(已排除 `console` 类)。
- `CONTEXT_WINDOW = 131072` — 上下文占用环使用的 128K 窗口。
- `EFFORT_LABELS = { off:'关', low:'低', medium:'中', high:'高' }`。
- `state.effort` — 推理等级(与 `state.settings.effort` 分开维护,UI 直接读 `state.effort`)。

**依赖关系**:`renderer.js` → `marked`、`dompurify`、`window.grokAPI`、浏览器 DOM API。

---

## 2.6 界面结构 `src/renderer/index.html`(307 行)

单页 DOM 骨架,主要区块:

| 区块 | id | 说明 |
| --- | --- | --- |
| 登录页 | `#authScreen` | 登录 / 注册 / 设备码登录 / 验证码激活四个面板 |
| 侧边栏 | `#sidebar` | 品牌、新对话、会话列表 `#convList`、设置 / 退出 |
| 主区 | `#main` | 顶栏 `#topbar`、滚动体 `#scrollBody`、消息区 `#messages`、空态 `#emptyState` |
| 输入卡 | `#composer` / `#composerCard` | 附件行、textarea、工具条(＋ / 权限 / 模型 / 上下文环 / 发送 / 停止)、四类弹出菜单、上下文面板 |
| 设置弹窗 | `#settingsModal` | Base URL / API Key / System Prompt / 清 Key / 自动更新区 |
| 提示 | `#toast` | 轻提示 |

- 引入 CSP(限制 `script-src`、`frame-src` 到 `challenges.cloudflare.com` 以支持 Turnstile)。
- 末尾加载 `../../dist/renderer.bundle.js` 与 Cloudflare Turnstile 脚本。

---

## 2.7 样式 `src/renderer/styles.css`(1700 行)

基于 **DeepSeek Harness Desktop(DSH)** 设计系统的暗色主题:

- `:root` 定义调色板令牌(`--bluish-*`、`--deepseek-*`、`--green/red/amber-*`)与语义别名(`--bg-base`、`--bubble`、`--label-primary` 等)。
- 尺寸令牌:`--chat-content-width: 748px`、`--composer-card-max: 780px`、`--scrollbar-width: 8px`。
- 动效令牌:`--ease`、`--dur / --dur-fast / --dur-slow`。
- 组件样式:侧边栏(223 行起)、消息气泡、Markdown 代码块与复制按钮、胶囊输入卡、弹出菜单(1158 行起:r12 + hairline + 阴影)、上下文环、设置弹窗、登录页、toast。

> 说明:本文件除少数段落注释外整体未细分章节标题,样式以"令牌 + 语义类名"组织。

---

## 2.8 配置模板 `src/config.example.js` / `config.local.js`

| 文件 | 是否入库 | 作用 |
| --- | --- | --- |
| `config.example.js` | ✅ 提交 | 占位模板,导出 `DEFAULT_BASE_URL` / `DEFAULT_API_KEY` / `DEFAULT_AUTH_URL`(默认全空) |
| `config.local.js` | ❌ `.gitignore` 排除 | 开发者本地真实网关地址与 Key;首次启动时被 `main.js` seed 到加密存储 |

`loadDefaultConfig()` 的加载顺序:`config.local` → `config.example` → 空对象。

---

## 2.9 模块依赖图

```
                    ┌──────────────┐
                    │  config.local│ (可选,真实密钥)
                    └──────┬───────┘
                           │ require
┌──────────────┐    ┌──────▼───────────────────┐     ┌──────────────┐
│  store.js    │◀───│        main.js           │────▶│   api.js     │──▶ 网关 / 登录服务器
│ (JSON 持久化) │    │ 窗口 / IPC / 加密 / 更新   │     │ SSE / REST   │
└──────────────┘    └──────┬───────────────────┘     └──────────────┘
                           │ ipcMain.handle
                    ┌──────▼───────┐
                    │  preload.js  │  contextBridge → window.grokAPI
                    └──────┬───────┘
                           │ invoke / on
                    ┌──────▼───────────────────────────┐
                    │ renderer.js (bundle)              │
                    │  ├─ marked    (Markdown→HTML)     │
                    │  ├─ DOMPurify (消毒)              │
                    │  └─ index.html / styles.css       │
                    └───────────────────────────────────┘
```
