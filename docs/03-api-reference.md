# 03 · 关键类与函数 / 接口参考

本页汇总核心函数签名、数据结构与全部 IPC 接口。行号对应仓库当前版本。

---

## 3.1 主进程 `src/main.js`

### 3.1.1 配置与密钥

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `loadDefaultConfig` | `() => { DEFAULT_BASE_URL, DEFAULT_API_KEY, DEFAULT_AUTH_URL }` | 依次尝试 `config.local` → `config.example` → 空占位 |
| `encryptSecret` | `(value: string) => string` | 返回 `'enc:' + base64(ciphertext)`,加密不可用时 `'plain:' + value`,空值返回 `''` |
| `decryptSecret` | `(value: string) => string` | 按 `enc:` / `plain:` 前缀解析;失败原样返回 |
| `maskSecret` | `(value: string) => string` | 展示用掩码,`≤8` 位返回 `****`,否则 `前4…后4` |

### 3.1.2 认证

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `authFetch` | `(path, { body?, token?, method='POST' }) => Promise<any>` | 向 `AUTH_BASE` 发 JSON 请求,20s 超时;`!res.ok` 时抛 `json.error` 或 `服务器错误(status)` |
| `authToken` | `() => string` | 解密并返回已保存的会话 token |
| `authUser` | `() => object \| null` | 解析已保存的用户 JSON |
| `saveAuth` | `(token, user) => void` | 加密保存 token 与用户信息到 settings |

`AUTH_BASE` = `(DEFAULT_AUTH_URL || 'https://md-grok.de5.net')`,尾部斜杠已去除。

### 3.1.3 文件与内容

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `mimeOf` | `(filename) => string` | 按扩展名查 `MIME_MAP`,未知回退 `application/octet-stream` |
| `sanitizeContent` | `(content) => ContentBlock[] \| string` | 白名单化消息内容块:仅保留 `text` / `file` / `image_url` / `input_audio` 且字段合法者 |
| `formatBytes` | `(bytes) => string` | `B` / `KB` / `MB` 友好显示 |
| `buildMarkdownExport` | `(conv) => string` | 生成会话导出 Markdown(标题、导出时间、逐条 `## 🧑 你` / `## 🤖 Grok`、附件清单) |

### 3.1.4 窗口 / 菜单 / 更新

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `createWindow` | `() => void` | 创建 `BrowserWindow`,应用记忆尺寸/位置、沙箱 webPreferences;外链一律 `shell.openExternal`;`--smoke-test` 时加载后自动退出 |
| `buildMenu` | `() => void` | 中文菜单:文件 / 编辑 / 视图 |
| `restoreWindowBounds` | `() => { width,height,x?,y? }` | 读取记忆尺寸;仅当窗口落在可见显示器时恢复坐标 |
| `saveWindowBounds` | `(win) => void` | 关闭时持久化窗口 `bounds` |
| `semverGt` | `(a, b) => boolean` | 简易三段语义化版本比较(是否 `a > b`) |
| `pickUpdateAsset` | `(assets) => asset \| null` | Windows 选 `Setup*.exe`;macOS 按 `process.arch` 选对应 `.dmg` |
| `friendlyNetError` | `(err) => Error` | 把 `net::ERR_*` 转成可操作的中文提示(超时 / DNS / 拒绝 / 证书等) |

### 3.1.5 云同步辅助

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `ssoOrigin` | `() => string` | 由 `baseUrl` 解析 origin,失败返回 `''` |
| `ssoConvFetch` | `(path, method, body?) => Promise<any\|null>` | 以会话 JWT 请求 `{origin}/api/conversations{path}`,15s 超时;任何失败返回 `null`(降级为本地) |

---

## 3.2 API 客户端 `src/api.js`

| 函数 / 类 | 签名 | 说明 |
| --- | --- | --- |
| `doFetch` | `(url, options) => Promise<Response>` | 优先 `electron.net.fetch`,回退全局 `fetch` |
| `fetchWithConnectTimeout` | `(url, options, signal) => Promise<Response>` | 见下 |
| `normalizeBaseUrl` | `(baseUrl) => string` | 去尾斜杠,空值回退 `https://api.x.ai/v1` |
| `friendlyStatus` | `(status, body) => string` | 中文错误文案 |
| `parseSseDataLine` | `(line, onDelta, onUsage, onError) => void` | 解析一行 SSE |
| `streamChat` | `async (opts) => usage \| null` | 流式对话 |
| `completeChat` | `async (opts) => string` | 非流式对话 |
| `listModels` | `async (baseUrl, apiKey) => string[]` | 模型 id 列表 |
| `ApiError` | `class extends Error` | `{ name='ApiError', status, body }` |

**`fetchWithConnectTimeout` 行为**

1. body 超过 1MB 用 `LARGE_BODY_TIMEOUT_MS`(180s),否则 `CONNECT_TIMEOUT_MS`(20s)。
2. 通过内部 `AbortController` 组合用户 `signal` 与超时定时器。
3. 捕获 `TypeError`(瞬时网络错误)时等待 800ms 重试一次;用户取消(`AbortError`)与超时不重试。

**`streamChat({ baseUrl, apiKey, model, messages, signal, onDelta, url? })`**

- `url` 存在时直连该端点(SSO 模式传 `{origin}/api/chat`),否则 `{baseUrl}/chat/completions`。
- 请求体:`{ model, messages, stream: true }`,`Authorization: Bearer <apiKey>`。
- 逐行拼接 SSE buffer,回调:
  - `onDelta(content)` — 文本增量
  - `onUsage(usage)` — 捕获 `chunk.usage`
  - `onError(error)` — 捕获 `{"error":{...}}` chunk(grok2api 会以 SSE 形式透传上游失败)
- **异常语义**:
  - 非 2xx → `ApiError`(friendlyStatus)。
  - 流内出现 error → 抛含"上游服务返回错误…推理等级…"提示的 `ApiError`。
  - `deltaCount === 0 && !usage` → 抛"服务器返回了空响应…"。
- 正常返回 `usage`(可能为 `null`)。

**`completeChat({ baseUrl, apiKey, model, messages, signal })`** — 请求 `stream:false`,返回 `choices[0].message.content`(用于压缩历史)。

---

## 3.3 `window.grokAPI`(预加载桥)

渲染进程唯一可用的 API 面,全部定义于 [preload.js](../src/preload.js)。

### 设置 / 模型

| 方法 | 底层通道 | 说明 |
| --- | --- | --- |
| `getSettings()` | `settings:get` | 返回 `{ baseUrl, model, effort, systemPrompt, hasApiKey, apiKeyMask }`(不含明文 Key) |
| `setSettings(patch)` | `settings:set` | 局部更新设置,返回同 `getSettings` 结构 |
| `listModels()` | `models:list` | 模型 id 数组 |

### 会话

| 方法 | 底层通道 | 说明 |
| --- | --- | --- |
| `listConversations()` | `conversations:list` | 会话摘要数组(本地 + 云端合并) |
| `getConversation(id)` | `conversations:get` | 完整会话(优先云端,回退本地) |
| `saveConversation(conv)` | `conversations:save` | 清洗 + 本地持久化 + 云端 PUT |
| `deleteConversation(id)` | `conversations:delete` | 本地删除 + 云端 DELETE |
| `compactChat(payload)` | `chat:compact` | `{ model, messages } → { summary }` |
| `exportConversation(conv)` | `conversation:export` | 弹保存对话框导出 Markdown |

### 聊天

| 方法 | 底层通道 | 说明 |
| --- | --- | --- |
| `startChat(payload)` | `chat:start` | `{ requestId, model, messages }`;消息经 `chat:delta` 事件流式返回;结果 `{ ok, usage, sso }` |
| `stopChat()` | `chat:stop` | 中止活动流 |
| `onChatDelta(cb)` | 事件 `chat:delta` | `cb({ requestId, delta })`;返回取消订阅函数 |

### 文件 / 认证 / 用量 / 更新

| 方法 | 底层通道 | 说明 |
| --- | --- | --- |
| `selectFiles()` | `files:select` | 返回文件数组(每项含 `name/size/mime/dataUri`,或 `{error,name,message}`) |
| `authStatus()` | `auth:status` | `{ loggedIn, user }` |
| `authRegister(p)` | `auth:register` | `{ email, name, password, turnstileToken? } → { message, demoCode, email }` |
| `authVerify(p)` | `auth:verify` | `{ email, code } → { user, token }` |
| `authLogin(p)` | `auth:login` | `{ email, password } → { user, token }` |
| `authLogout()` | `auth:logout` | 清除本地认证信息 |
| `authConfig()` | `auth:config` | `{ turnstileSiteKey }` |
| `authOpenRegister()` | `auth:openRegister` | 用系统浏览器打开网页版注册页 |
| `authDeviceLogin()` | `auth:deviceLogin` | 打开浏览器登录页,返回 `{ deviceId }` |
| `authDevicePoll(p)` | `auth:devicePoll` | `{ deviceId } → { approved, user? }` |
| `reportUsage(p)` | `usage:report` | `{ model, inTokens, outTokens }` |
| `checkUpdate()` | `update:check` | 见下方 UpdateInfo |
| `openUpdateDownload(url)` | `update:openDownload` | 用系统浏览器打开安装包直链(仅允许 `http(s)://`) |
| `downloadUpdate(p)` | `update:download` | `{ url, fileName } → { path, size }`(应用内下载,带进度事件) |
| `installUpdate(p)` | `update:install` | `{ path }` 启动安装包 |
| `onUpdateProgress(cb)` | 事件 `update:progress` | `cb({ percent, received, total })` |

---

## 3.4 IPC 通道全表(主进程注册)

| 通道 | 入参 | 返回 / 副作用 |
| --- | --- | --- |
| `auth:status` | — | `{ loggedIn, user }` |
| `auth:register` | `{ email, password, name, turnstileToken }` | `{ message, demoCode, email }` |
| `auth:config` | — | `{ turnstileSiteKey }`(失败为空) |
| `auth:openRegister` | — | `{ ok }`,打开浏览器注册页 |
| `auth:deviceLogin` | — | `{ deviceId }`,打开浏览器登录页 |
| `auth:devicePoll` | `{ deviceId }` | `{ approved, user? }`;批准时保存 token |
| `auth:verify` | `{ email, code }` | `{ user, token }`;保存 token |
| `auth:login` | `{ email, password }` | `{ user, token }`;保存 token |
| `auth:logout` | — | `{ ok }`,清空认证 |
| `usage:report` | `{ model, inTokens, outTokens }` | `{ ok }`,失败静默 |
| `settings:get` | — | 设置视图(掩码 Key) |
| `settings:set` | `patch` | 更新后返回设置视图;`baseUrl` 必须 `http(s)://` |
| `conversations:list` | — | 摘要数组(本地 + 云端合并、按 `updatedAt` 降序) |
| `conversations:get` | `id` | 完整会话或 `null` |
| `conversations:save` | `conv` | 清洗持久化 + 云端 PUT,返回 `true` |
| `conversations:delete` | `id` | 本地删除 + 云端 DELETE,返回 `true` |
| `chat:compact` | `{ model, messages }` | `{ summary }`(非流式) |
| `conversation:export` | `conv` | `{ ok, path }` 或 `{ canceled }` |
| `models:list` | — | 模型 id 数组(SSO 优先;过滤含 `console` 的 id) |
| `files:select` | — | 文件数组(>25MB 或读取失败返回 error 项) |
| `chat:start` | `{ requestId, model, messages }` | `{ ok, usage, sso }`;流式经 `chat:delta` 推送 |
| `chat:stop` | — | `true`,中止 `activeStream` |
| `update:check` | — | `UpdateInfo` |
| `update:download` | `{ url, fileName }` | `{ path, size }`;进度经 `update:progress` |
| `update:install` | `{ path }` | `{ ok }`,启动安装程序 |
| `update:openDownload` | `url` | `{ ok }`,浏览器下载 |

**主进程 → 渲染进程事件**

| 事件 | payload | 触发点 |
| --- | --- | --- |
| `chat:delta` | `{ requestId, delta }` | `streamChat` 的 `onDelta` |
| `update:progress` | `{ percent, received, total }` | `update:download` 读取流时 |

---

## 3.5 渲染进程关键函数 `src/renderer/renderer.js`

### 模型解析

```js
// base: 基础模型 id;effort: 'off'|'low'|'medium'|'high'
// 例:('grok-4.3-fast','high') → 'grok-4.3-high'(若在可用列表内)
resolveModel(base, effort) → string
currentSendModel() → string   // resolveModel(state.settings.model, state.effort)
```

### token 统计

| 函数 | 说明 |
| --- | --- |
| `estimateTokens(text)` | CJK 每字 ≈1 token,ASCII 每 4 字符 ≈1 token,`+1` 修正;用于无真实 usage 时回退估算 |
| `computeSessionStats(conv)` | 汇总轮数 / 消息数 / 生成耗时 / 平均首 token 延迟 / 输入输出 token / 速度;`allReal` 表示是否每轮都有真实 usage |
| `fmtDuration(ms)` / `fmtTokens(n)` | 时长与 token 友好格式 |

### 流式渲染节流

| 函数 | 说明 |
| --- | --- |
| `schedulePendingRender(p)` | `p.raw.length > 20000` 时改用 250ms 定时重渲染;否则按 `requestAnimationFrame` 每帧渲染,防止长回复卡顿 |
| `renderMarkdown(text)` | `marked.parse` → `DOMPurify.sanitize` → 为 `<pre>` 注入复制按钮、给 `<a>` 加 `target=_blank rel=noopener noreferrer`,返回 DOM 容器 |

### 生命周期

| 函数 | 说明 |
| --- | --- |
| `init()` | 读设置 → `bindAuthEvents` → `checkAuth` → 装配模型/事件/权限 → 加载会话列表并打开首个或显示空态 → 静默刷新模型 |
| `wireEvents()` | 统一注册 DOM 事件(发送、菜单、设置、更新、会话列表、`onChatDelta`) |
| `send()` | 校验登录与 Key → 建会话 → 追加用户消息 → 清空输入与待发附件 → 增量渲染 → `streamReply` → 刷新列表 |
| `streamReply(conv)` | 创建助手消息占位 → `startChat` → 依 `chat:delta` 累积 → 结束后写 `metrics`、持久化、按需上报用量 |

---

## 3.6 核心数据结构

### Settings(持久化于 `settings.json`)

```js
{
  baseUrl: string,        // API 地址
  model: string,          // 基础模型
  effort: 'off'|'low'|'medium'|'high',
  systemPrompt: string,
  apiKeyEnc: string,      // 'enc:...' | 'plain:...' | ''
  authTokenEnc: string,   // 会话 JWT(加密)
  authUser: string,       // 用户 JSON 字符串
  windowBounds: { x, y, width, height }
}
```

### Conversation / Message(持久化于 `conversations.json`)

```js
Conversation = {
  id: string, title: string, createdAt: number, updatedAt: number,
  messages: Message[]
}
Message = {
  role: 'user'|'assistant',
  content: string,
  ts: number,
  attachments?: [{ name, size, mime, dataUri }], // dataUri 超过 4MB 时为空串
  metrics?: { firstTokenMs, genMs, inTokens, outTokens, real }
}
```

### Usage(网关返回的 usage)

```js
{ prompt_tokens: number, completion_tokens: number, total_tokens?: number }
```

### UpdateInfo

```js
{ current, latest, hasUpdate, assetName, assetUrl, assetSize, releaseUrl }
```
