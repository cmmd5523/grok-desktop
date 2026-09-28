# Grok 桌面客户端 · Code Wiki

> 本目录是 `grok-desktop`(Windows / macOS 桌面端 Grok 聊天客户端)的结构化代码 Wiki。
> 依据仓库当前源码(`v1.1.15`)整理,内容与实现保持一致。

## 项目一句话简介

基于 **Electron** 的跨平台桌面聊天客户端,通过 **OpenAI 兼容 API**(自建 grok2api 网关)与 Grok 对话;
界面复刻 DeepSeek Harness Desktop 设计系统;自 `v1.1.0` 起引入**登录系统**(邮箱注册 + 验证 + 设备码浏览器登录),
并支持**云端会话同步(SSO)**、**用量上报**与**自研自动更新器**。

## 文档目录

| 文档 | 内容 |
| --- | --- |
| [01-architecture.md](./01-architecture.md) | 整体架构:进程模型、技术栈、通信链路、构建产物 |
| [02-modules.md](./02-modules.md) | 主要模块职责:主进程 / 预加载 / API 客户端 / 存储 / 渲染进程 / 静态资源 |
| [03-api-reference.md](./03-api-reference.md) | 关键类与函数说明:核心函数签名、`ApiError`、IPC 通道全表、`window.grokAPI` |
| [04-flows.md](./04-flows.md) | 关键业务流程:聊天流式、认证、云同步、自动更新、附件与 token 统计 |
| [05-data-storage.md](./05-data-storage.md) | 数据存储与密钥安全:文件位置、字段结构、DPAPI 加密、容量限制 |
| [06-development.md](./06-development.md) | 运行方式:环境要求、开发 / 打包 / 发布、CI 工作流、常见问题 |
| [07-tools.md](./07-tools.md) | `tools/` 目录脚本参考:E2E 测试、诊断复现、构建辅助、运维脚本 |

## 快速导航:我想...

- **了解项目怎么跑起来** → [06-development.md](./06-development.md)
- **看懂进程和模块划分** → [01-architecture.md](./01-architecture.md)、[02-modules.md](./02-modules.md)
- **查某个函数 / IPC 通道的作用** → [03-api-reference.md](./03-api-reference.md)
- **理解一次聊天消息是怎么走完的** → [04-flows.md](./04-flows.md)
- **知道配置和会话存在哪、怎么加密** → [05-data-storage.md](./05-data-storage.md)
- **看测试与运维脚本** → [07-tools.md](./07-tools.md)

## 代码地图(顶层)

```
grok-desktop/
├── src/
│   ├── main.js              # Electron 主进程:窗口 / 全部 IPC / 加密 / 更新 / 认证
│   ├── preload.js           # contextBridge 安全桥(window.grokAPI)
│   ├── api.js               # OpenAI 兼容 API 客户端(SSE 流式、错误归一化)
│   ├── store.js             # 极简 JSON 原子持久化
│   ├── config.example.js    # 配置模板(提交到仓库)
│   ├── config.local.js      # 本地真实网关配置(gitignored,不入库)
│   └── renderer/
│       ├── index.html       # 界面结构 + CSP
│       ├── styles.css       # DSH 设计系统(暗色令牌)
│       └── renderer.js      # 渲染进程 UI 逻辑(esbuild 打包入口)
├── build/                   # 应用图标(.ico / 多尺寸 .png)
├── tools/                   # E2E / 诊断 / 构建 / 运维脚本
├── .github/workflows/build.yml  # Windows + macOS 安装包 CI
├── dist/                    # 渲染进程构建产物(自动生成,gitignored)
└── package.json             # 脚本、依赖、electron-builder 配置
```

## 外部依赖概览

| 依赖 | 类型 | 作用 |
| --- | --- | --- |
| `electron` | devDependency | 桌面运行时(Electron 43) |
| `electron-builder` | devDependency | Windows(NSIS / portable)与 macOS(dmg / zip)打包 |
| `esbuild` | devDependency | 将 `renderer.js` 打包压缩为 `dist/renderer.bundle.js` |
| `marked` | dependency | Markdown → HTML |
| `dompurify` | dependency | 渲染前对 HTML 消毒,防 XSS |

> 运行时主进程仅使用 Electron + Node 内置模块(`fs` / `path` / `stream/promises`),无额外后端依赖。
