# 05 · 数据存储与密钥安全

## 5.1 存储位置

运行时数据目录 = Electron `app.getPath('userData')`:

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%/grok-desktop/` |
| macOS | `~/Library/Application Support/grok-desktop/` |

| 文件 | 内容 | 由谁读写 |
| --- | --- | --- |
| `settings.json` | 设置、加密后的 API Key 与认证 token、窗口尺寸 | `store.js` ← `main.js` |
| `conversations.json` | 会话列表(含消息与附件) | `store.js` ← `main.js` |

> 删除这两个文件即可完全重置应用(会同时清除加密存储的凭据与窗口记忆)。

## 5.2 原子写入

`createStore` 的 `save()` 采用"临时文件 + rename"策略:

```
写入 filePath + '.tmp'  →  fs.renameSync(tmp, filePath)
```

- 写入前 `fs.mkdirSync(dirname, { recursive: true })`。
- 加载失败或保存失败只打印 `console.error`,不抛异常,保证应用不因存储问题崩溃。
- `get()` 返回浅拷贝,调用方修改不会污染内存中的原始对象。

## 5.3 密钥加密(`safeStorage`)

主进程通过 Electron `safeStorage` 加密敏感值(Windows 走 DPAPI,macOS 走 Keychain):

| 前缀 | 含义 |
| --- | --- |
| `enc:<base64>` | `safeStorage.encryptString()` 的密文 |
| `plain:<value>` | 加密不可用时的明文降级(仅兜底) |
| `''` | 未设置 |

- 加密:`encryptSecret(value)`;解密:`decryptSecret(value)`。
- 展示:`maskSecret(value)` 只返回 `前4…后4` 掩码,渲染进程永远拿不到明文 Key(`settings:get` 返回 `hasApiKey` + `apiKeyMask`)。
- **首启 seed**:若 settings 中无 `apiKeyEnc` 且构建时存在 `DEFAULT_API_KEY`,则自动加密写入。

**受保护的值**

- `apiKeyEnc` — 直连网关用的 API Key。
- `authTokenEnc` — 登录服务器会话 JWT。
- `authUser` — 用户信息 JSON(非密文,仅含 `email`/`role` 等非敏感字段)。

## 5.4 settings.json 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `baseUrl` | string | API 网关地址(以 `http(s)://` 开头) |
| `model` | string | 基础模型,默认 `grok-4.3-fast` |
| `effort` | `off`/`low`/`medium`/`high` | 推理等级 |
| `systemPrompt` | string | 可选系统提示 |
| `apiKeyEnc` | string | 加密 API Key |
| `authTokenEnc` | string | 加密会话 token |
| `authUser` | string | 用户 JSON |
| `windowBounds` | `{x,y,width,height}` | 窗口位置尺寸记忆(仅当落在可见显示器时恢复坐标) |

## 5.5 conversations.json 结构

```js
{
  items: [
    {
      id: string,
      title: string,           // 最多 60 字符
      createdAt: number,       // 时间戳
      updatedAt: number,
      messages: [
        {
          role: 'user' | 'assistant',
          content: string,
          ts: number,
          attachments?: [ { name, size, mime, dataUri } ],
          metrics?: { firstTokenMs, genMs, inTokens, outTokens, real }
        }
      ]
    }
  ]
}
```

> 云端同步时另带 `model` 字段(PUT `/api/conversations/:id`),本地结构不保存该字段。

## 5.6 容量与大小限制

| 常量 | 值 | 位置 | 作用 |
| --- | --- | --- | --- |
| `MAX_FILE_BYTES` | 25 MB | `main.js` | 单个上传文件上限,超出返回 error 项 |
| `MAX_PERSIST_DATA_URI` | 4 MB | `main.js` | 附件的 base64 dataUri 超过此值**不落盘**,仅保留名称/大小/mime |
| `title` 截断 | 60 字符 | `conversations:save` | 防标题过长 |
| `estimateTokens` 上限参考 | — | `renderer.js` | 无真实 usage 时的回退估算 |

> 大附件不落盘的原因:避免 `conversations.json` 无限膨胀。此类附件在当前会话内仍可用,重新打开后会显示「⚠ 未保存」提示。

## 5.7 渲染进程安全

- `webPreferences`: `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`spellcheck: true`。
- 所有跨进程能力仅经 `contextBridge` 暴露的 `window.grokAPI`。
- `index.html` 内嵌 **CSP**:
  - `default-src 'self'`
  - `script-src 'self' https://challenges.cloudflare.com`(Turnstile)
  - `img-src 'self' data: https:`(支持附件 data URI 预览)
  - `frame-src https://challenges.cloudflare.com`
  - `connect-src https://challenges.cloudflare.com`
- 外链治理:主进程 `setWindowOpenHandler` 与 `will-navigate` 拦截,`http(s)` 链接一律 `shell.openExternal`,应用内不导航到外部页面。
- Markdown 渲染先经 `DOMPurify.sanitize` 再插入 DOM,防止模型输出注入脚本。
