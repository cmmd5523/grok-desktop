# 07 · `tools/` 脚本参考

`tools/` 目录是围绕应用与后端网关的**测试、诊断、构建、运维脚本**集合,不参与应用打包(不在 `build.files` 中)。
多数脚本需要真实网关 / 登录服务器,含有硬编码的测试域名与账号,仅供开发调试使用。

> ⚠️ 共享凭据文件 `tools/creds.json`(含 `host`/`port`/`user`/`password`)已被 `.gitignore` 排除,勿提交。

## 7.1 E2E / 集成测试(Electron 全链路或渲染层)

| 脚本 | 运行 | 用途与要点 |
| --- | --- | --- |
| `auth-e2e.js` | `npx electron tools/auth-e2e.js` | 认证全链路:管理员建号 → 真实登录页 → 填表提交 → 进入主界面并显示邮箱;注入全部 IPC stub |
| `device-e2e.js` | `npx electron tools/device-e2e.js` | 设备码登录:模拟 web 端批准 → 桌面端轮询自动登录,断言 `pollCount>=1` |
| `sso-e2e.js` | `npx electron tools/sso-e2e.js` | SSO:`require('../src/main.js')` 真实主进程;登录后 `chat:start` 走 `/api/chat`(`result.sso===true`)流式返回;并复测 IP 直连 |
| `csync-e2e.js` | `npx electron tools/csync-e2e.js` | 云端会话同步:登录前存本地、登录后存云、列出/获取、校验本地旧会话合并 |
| `opendownload-e2e.js` | `npx electron tools/opendownload-e2e.js` | 验证 `update:openDownload` 拒绝 `javascript:` 等非法 URL(报「链接无效」) |
| `update-e2e.js` | `npx electron tools/update-e2e.js` | 访问真实 GitHub API 校验 `checkUpdate` 字段形状;打开设置弹窗、触发检查、下载真实 README 校验大小 |
| `ui-check.js` | `npx electron tools/ui-check.js` | UI 回归脚手架:工具栏布局、四类菜单、模型/推理等级、上下文环、权限、增量发送与持久化、无 console 错误 |

> `-e2e.js` 脚本普遍把 `userData` 重定向到 `os.tmpdir()/grok-*`,避免污染真实配置;`ui-check` / `auth-e2e` / `device-e2e` 通过 `ipcMain.handle` 注入 stub,而 `csync/sso/update/opendownload` 直接 `require('../src/main.js')` 使用真实 IPC。

## 7.2 网关 / API 集成测试(Node 直连 `chat/completions`)

| 脚本 | 运行 | 用途与要点 |
| --- | --- | --- |
| `test-chat.json` | — | 非流式对话请求体夹具(`grok-4.3-fast`,含 `stream:false`) |
| `test-tools.js` | `node tools/test-tools.js` | 测试模型是否支持 OpenAI 工具调用(两轮:`tool_calls` → 回填 `tool` 结果) |
| `test-tools-stream.js` | `node tools/test-tools-stream.js` | 流式工具调用测试(累积 `content` 与 `tool_calls`、打印 `finish_reason`) |
| `test-roundtrip.js` | `node tools/test-roundtrip.js` | 流式工具调用往返(tool_calls → tool 结果 → 最终回答) |
| `test-upload.js` | `node tools/test-upload.js` | 手工构造最小合法 PDF,以 `type:'file'` 上传并让模型读取 |
| `test-image.js` | `node tools/test-image.js` | 手工构造真实 PNG,以 `type:'image_url'` 上传测试 |
| `test-usage.js` | `node tools/test-usage.js` | 验证 `src/api.js` 的 `streamChat` 能取到真实 `usage` 且流不中断 |
| `test-compact.js` | `node tools/test-compact.js` | 验证压缩路径:`completeChat` 摘要 + `resolveModel` 的 effort→model 解析 |

**共用环境变量**:`BASE_URL`(默认 `http://127.0.0.1:8000/v1`)、`API_KEY`(默认 `sk-placeholder`)、`MODEL`(视脚本而定)。

## 7.3 诊断 / 复现(repro)

| 脚本 | 运行 | 用途与要点 |
| --- | --- | --- |
| `diag-pdf.js` | `node tools/diag-pdf.js [pdfPath] [model]` | 逐行 dump 网关 SSE 原始响应,判定 PDF 上传失败是报错、空 chunk 还是未发 usage |
| `repro-electron.js` | `npx electron tools/repro-electron.js` | 在 Electron 主进程(应用实际路径)用多个模型复现 PDF 失败 |
| `scope-check.js` | `npx electron tools/scope-check.js` | 判定上游 403 是否仅限"推理模型 + 文件",还是纯文本/图片也会命中 |
| `webchat-browser-repro.js` | `npx electron tools/webchat-browser-repro.js` | 在真实 Chromium 中复现网页端 `/api/chat` 流式问题(同网络栈 + Cloudflare) |

## 7.4 构建 / 图标 / 发布辅助

| 脚本 | 运行 | 用途与要点 |
| --- | --- | --- |
| `make-icon.js` | `npx electron tools/make-icon.js` | 生成 Grok 风格图标(深色圆角 + 白色 8 芒星):输出 `build/icon-<size>.png`(16/24/32/48/64/128/256)、`icon.png`、`icon.ico` |
| `check-icon.js` | `node tools/check-icon.js <pngFile>` | 内置极简 PNG 解码器,对生成图标做像素抽样合理性检查(角暗、中心白) |
| `release.js` | `npm run release -- <patch\|minor\|major> [--dry-run]` | 一键发布:校验工作区 → `npm version` → push main + tags |

## 7.5 服务端 / 运维 Python 工具

| 脚本 | 运行 | 用途与要点 |
| --- | --- | --- |
| `patch-stream-usage.py` | `python tools/patch-stream-usage.py` | 给 grok2api 的 `app/products/openai/chat.py` 打补丁,在流式末尾补发含 `usage` 的空 `choices` chunk;先备份、锚点唯一匹配、写入前 `ast.parse` 校验 |
| `ssh.py` | `python tools/ssh.py "command"` | 基于 paramiko 在远程服务器执行命令(读取 `tools/creds.json`;支持多命令 `;`) |
| `ssh-put.py` | `python tools/ssh-put.py <local_dir> <remote_dir>` | 通过 SFTP 递归上传本地目录到远端(自动逐级建目录) |

> 两个 SSH 脚本依赖第三方库 **paramiko**,并读取同目录 `tools/creds.json`。

## 7.6 硬编码的测试资产与变量(注意)

- 域名:`md-grok.de5.net`;IP 直连:`http://154.9.253.182/v1`。
- GitHub raw:`raw.githubusercontent.com/cmmd5523/grok-desktop`。
- 测试账号 / 密钥:`admin@grok.local`、`cmd13590675523`、`test123456`、`sk-mdchen`、`sk-placeholder`。
- 常用环境变量:`BASE_URL`、`API_KEY`、`AUTH_BASE`、`AUTH_ADMIN_EMAIL`、`ADMIN_TEST_PASSWORD`、`MODEL`、`FORCE`。

> 这些值均为开发期硬编码,与运行时的 `src/config.local.js` / settings 无关。
