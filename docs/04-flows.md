# 04 · 关键业务流程与依赖关系

本页串联"一次操作从 UI 到外部服务再回到 UI"的完整链路,是理解模块协作的主线。

---

## 4.1 应用启动

```
main.js: app.requestSingleInstanceLock()
   │ 获取锁失败 → app.quit()
   └─ app.whenReady()
        ├─ settingsStore   = createStore(userData/settings.json, 默认值)
        ├─ 首启且存在 DEFAULT_API_KEY → settingsStore.set({ apiKeyEnc: encryptSecret(...) })
        ├─ conversationsStore = createStore(userData/conversations.json, { items: [] })
        ├─ buildMenu() → createWindow() → 加载 renderer/index.html
        └─ 渲染进程 init():
             getSettings → bindAuthEvents → checkAuth()
                ├─ 已登录 → showAppScreen()
                └─ 未登录 → showAuthScreen()
             → 装配事件/模型/权限 → refreshConversations() → 打开首个会话或空态
             → refreshModels(true)   // 静默拉取模型
```

> `--smoke-test` 参数:窗口 `did-finish-load` 后打印日志并 1.5s 后退出(用于 CI/本地冒烟)。

---

## 4.2 认证流程

### 4.2.1 邮箱注册 → 验证 → 登录

```
渲染进程 authFormRegister.submit
  → grokAPI.authRegister({ email, name, password, turnstileToken })
  → main: auth:register → POST /api/auth/register
  → 返回 { email }  → 切到验证码面板
  → grokAPI.authVerify({ email, code })
  → main: auth:verify → POST /api/auth/verify → 返回 { token, user }
  → saveAuth(token,user) 加密写入 settings → showAppScreen()
```

- 登录(`auth:login`)返回 `{ token, user }` 后同样 `saveAuth`。
- 桌面端 **Turnstile 不可用**,注册页提示改用「打开网页版注册」(`auth:openRegister` → `shell.openExternal`)。
- 验证码由管理员在网页管理后台查看并告知用户。

### 4.2.2 设备码浏览器登录

```
点击「使用浏览器登录」
  → grokAPI.authDeviceLogin()
  → main: auth:deviceLogin → crypto.randomUUID() 生成 deviceId
       → shell.openExternal('{AUTH_BASE}/#/login?device=<deviceId>')
       → 返回 { deviceId }
  → 渲染进程隐藏表单,显示等待面板,每 1.5s 轮询:
       grokAPI.authDevicePoll({ deviceId })
       → main: auth:devicePoll → GET /api/auth/device/poll?device=...
            ├─ approved && token && user → saveAuth(...) → { approved:true, user }
            └─ 否则 { approved:false }
  → 收到 approved → showAppScreen()
  → 超过 2 分钟 → 停止轮询,提示「等待超时」
```

### 4.2.3 退出登录

`grokAPI.authLogout()` → `auth:logout` → `saveAuth('', null)`(清空 token/用户),渲染进程重置会话状态并 `showAuthScreen()`。

---

## 4.3 聊天流式流程(核心链路)

```
[渲染进程] send()
  ├─ 校验:已登录、hasApiKey、非流式中
  ├─ ensureConversation() / push user message(含 attachments)
  ├─ 增量渲染用户气泡 + persistConversation()
  └─ streamReply(conv)
       ├─ 追加空 assistant 消息 + 显示「正在思考…」(含附件时提示「正在上传文件…」)
       ├─ payload = buildPayloadMessages(conv)   // 附件转 text/file/image_url/input_audio 内容块
       ├─ inTokens = estimateTokens(JSON.stringify(payload))
       └─ grokAPI.startChat({ requestId, model: currentSendModel(), messages: payload })
                │
                ▼  [主进程] chat:start
             ├─ 校验已登录(ssoToken)、消息非空、已选模型
             ├─ 组装 fullMessages(可选 systemPrompt + sanitizeContent 后的消息)
             ├─ resolvedBaseUrl = settings.baseUrl || DEFAULT_BASE_URL
             ├─ ssoOrigin = new URL(resolvedBaseUrl).origin
             ├─ ssoUrl = ssoToken && ssoOrigin ? `${origin}/api/chat` : ''
             ├─ controller = new AbortController(); activeStream = { controller, requestId }
             └─ api.streamChat({
                  baseUrl, apiKey: ssoUrl ? ssoToken : decrypt(apiKeyEnc),
                  url: ssoUrl || undefined, model, messages, signal,
                  onDelta: d => win.webContents.send('chat:delta', { requestId, delta })
                })
                     │
                     ▼  HTTP POST(SSE)
                ├─ 逐行解析 data: → onDelta / onUsage / onError
                └─ 返回 usage(或 null);异常 → friendlyNetError → 抛回渲染进程
                │
                ▼  [渲染进程] onChatDelta
             ├─ 校验 requestId 匹配 state.requestId
             ├─ 累积 assistantMsg.content 与 p.raw;首次 delta 记录 firstTokenAt
             └─ schedulePendingRender(p)   // rAF 或 250ms 节流重渲染 Markdown
                │
                ▼  startChat 返回
             ├─ usage → metrics = { firstTokenMs, genMs, inTokens:(realIn||估算), outTokens:(realOut||估算), real }
             ├─ persistConversation(conv)
             ├─ 非 SSO 时 reportUsage({ model, inTokens, outTokens })   // SSO 由服务器内部记账
             ├─ renderStatsLine() / updateContextMeter() / scrollToBottom()
             └─ refreshConversations()
```

**停止生成**:点击停止 → `stopStreaming()` 置 `stoppedByUser` 并 `grokAPI.stopChat()` → 主进程 `activeStream.controller.abort()` → `streamReply` 捕获后标注「⏹ 已停止生成」。

**空响应/上游错误**:见 [api.js 异常语义](./03-api-reference.md#32-api-客户端-srcapijs)。

---

## 4.4 会话持久化与云端同步

```
conversations:save
  ├─ 清洗消息:
  │    • 仅保留 role ∈ {user, assistant}
  │    • attachments:dataUri 长度 ≤ 4MB 才保留,否则置空(气泡显示「⚠ 未保存」)
  │    • metrics:归一化数值
  │    • title 截断 60 字符
  ├─ 写本地 conversationsStore(items 按 updatedAt 降序)
  └─ ssoConvFetch(`/${id}`, 'PUT', { title, messages, model })  // 失败静默降级
```

```
conversations:list
  ├─ remote = ssoConvFetch('', 'GET')
  ├─ 若 remote 有效: 本地 + 云端按 id 合并(本地优先保留历史),按 updatedAt 降序
  └─ 否则:返回本地摘要

conversations:get(id)
  ├─ 优先云端 remote.conversation
  └─ 回退本地 items.find(id)
```

> 设计意图:桌面端与网页版共用同一账号历史;`ssoOrigin` 取自 `baseUrl` 的 origin,因此直连 IP 部署不依赖 Cloudflare 域名。

---

## 4.5 模型列表流程

```
models:list
  ├─ 有 token 且有 origin:
  │    GET {origin}/api/chat/models (Bearer JWT)
  │    → (j.data).map(m=>m.id).filter(id => !/console/i.test(id))
  │    → 空则返回 []
  └─ 否则(直连网关):
       需要本地 apiKey → api.listModels(baseUrl, apiKey)
       → 过滤掉含 console 的模型
```

- 渲染进程 `refreshModels(silent)`:成功则 `applyModels()` 并按需修正当前模型(不在列表则回退首个),状态点置 `online`;失败置 `offline` 或提示。

---

## 4.6 附件上传与压缩历史

**上传**:`files:select`(dialog 多选)→ 逐文件 `statSync` 校验 25MB → `readFileSync` 转 `data:${mime};base64,...` → 渲染进程暂存 `state.pendingFiles` → 发送时并入 `buildPayloadMessages`。

**压缩历史**(`chat:compact`):取最近 4 条之外的全部消息,交由模型生成中文摘要,本地把旧消息替换为一条 `🗜 已压缩历史` 的 assistant 消息(保留最近 4 条)。使用 `completeChat`(非流式)。

---

## 4.7 自动更新流程

```
设置弹窗打开 / 点击「检查更新」
  → grokAPI.checkUpdate()  → update:check
       GET https://api.github.com/repos/cmmd5523/grok-desktop/releases/latest
       → semverGt(latest, app.getVersion()) 判定;pickUpdateAsset(assets) 选安装包
       → UpdateInfo
  ├─ 有新版本 → 显示「⬇ 下载更新」
  └─ 下载(当前实现:优先走浏览器)
       grokAPI.openUpdateDownload(assetUrl) → update:openDownload
          → 校验 /^https?:\/\// → shell.openExternal(url)   // 浏览器下载更可靠(代理/续传)
```

> 主进程仍保留 `update:download`(应用内下载 + `update:progress` 进度事件)与 `update:install`(启动安装包),`opendownload-e2e.js` 覆盖了 `openUpdateDownload` 的 URL 校验。

---

## 4.8 依赖关系总览

```
渲染进程(renderer.js)
   │  仅依赖 window.grokAPI(经 preload contextBridge)
   ▼
preload.js ── ipcRenderer.invoke ──▶ 主进程 main.js
                                        │
                                        ├── api.js ──▶ grok2api 网关 / 登录服务器 /api/chat
                                        ├── authFetch / ssoConvFetch ──▶ 登录服务器 REST
                                        ├── net.fetch ──▶ GitHub Releases API
                                        ├── safeStorage ──▶ 系统密钥库(DPAPI / Keychain)
                                        ├── dialog / shell ──▶ 系统能力
                                        └── store.js ──▶ 本地 JSON 文件
```

**不可逆的依赖方向**:渲染进程 → preload → 主进程 → 外部服务。反向只通过事件(`chat:delta` / `update:progress`)推送。
