# 06 · 运行方式与开发指南

## 6.1 环境要求

- **Node.js 18+**(仅开发/构建打包需要;安装好的客户端不需要 Node)
- **Windows 10 / 11 x64**,或 **macOS 12+**(Intel / Apple Silicon)
- 依赖安装:首次 `npm install` 若 Electron 二进制未下载,可执行 `node node_modules/electron/install.js`

## 6.2 npm 脚本

`package.json` 中的脚本:

| 脚本 | 命令 | 说明 |
| --- | --- | --- |
| `build` | `esbuild src/renderer/renderer.js --bundle --minify --format=iife --outfile=dist/renderer.bundle.js` | 打包渲染进程(必须先于启动/打包) |
| `start` | `npm run build && electron .` | 本地运行(开发) |
| `smoke` | `npm run build && electron . --smoke-test` | 冒烟启动:渲染进程加载成功后自动退出 |
| `dist` | `npm run build && electron-builder --win nsis` | 构建 Windows NSIS 安装程序 |
| `dist:portable` | `npm run build && electron-builder --win portable` | 构建免安装便携版 |
| `release` | `node tools/release.js` | 一键发布(版本 bump + tag + push) |

## 6.3 快速开始

```bash
npm install
npm start        # 等价于 npm run build && electron .
```

### 首次配置(网关地址与 Key)

应用支持"开箱即用"与"手动配置"两种方式:

1. **内置配置**:复制 `src/config.example.js` 为 `src/config.local.js`,填写:
   ```js
   module.exports = {
     DEFAULT_BASE_URL: 'http://127.0.0.1:8000/v1',
     DEFAULT_API_KEY:  'sk-...',
     DEFAULT_AUTH_URL: 'http://127.0.0.1:8001',
   };
   ```
   首次启动会把 `DEFAULT_API_KEY` 用 `safeStorage` 加密写入本地设置。
2. **界面配置**:直接运行应用,在「⚙ 设置」中填写 Base URL 与 API Key(同样加密保存)。

> `src/config.local.js` 已被 `.gitignore` 排除,不会入库;仓库只提交空的 `config.example.js`。

## 6.4 打包

```bash
npm run dist           # Windows NSIS → release/
npm run dist:portable  # Windows 便携版 exe
npx electron-builder --mac --publish never   # macOS dmg + zip
```

**electron-builder 关键配置**(`package.json > build`):

- `appId: com.local.grokdesktop`,`productName: GrokDesktop`,输出目录 `release/`。
- `files`: `src/**/*`、`dist/**/*`、`package.json`。
- Windows:`nsis`(x64),`oneClick:false`、允许改安装目录、创建桌面快捷方式;图标 `build/icon.ico`。
- macOS:`dmg` + `zip`(x64 与 arm64),图标 `build/icon.png`;类别 `social-networking`。
- **未签名**:CI 设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`;macOS 首次打开需右键「打开」或 `sudo xattr -dr com.apple.quarantine /Applications/GrokDesktop.app`。

## 6.5 CI 工作流 `.github/workflows/build.yml`

触发条件:推送到 `main`、打 `v*` tag、或手动 `workflow_dispatch`。

| Job | Runner | 步骤 |
| --- | --- | --- |
| `build-windows` | `windows-latest` | checkout → setup-node(22, npm 缓存)→ `npm ci` → `npm run build` → `npx electron-builder --win nsis --publish never` → 上传 `release/*.exe|blockmap|yml` |
| `build-macos` | `macos-latest` | 同上 → `npx electron-builder --mac --publish never` → 上传 `release/*.dmg|zip` |

- 打 `v*` tag 时额外用 `softprops/action-gh-release@v2` 发布 GitHub Release。
- `permissions.contents: write` 允许创建 Release;artifact 保留 30 天。

## 6.6 发布流程

```bash
npm run release -- patch    # 或 minor / major
npm run release -- patch --dry-run   # 仅预览,不执行
```

`tools/release.js` 会:

1. 校验工作区干净(`git status --porcelain`);
2. `npm version <kind> -m "release: %s"`(更新 `package.json` 与锁文件并提交);
3. `git push origin main`;
4. `git push origin --tags` → 触发 CI 打包并发布 Release。

## 6.7 数据重置

删除以下文件(见 [05-data-storage.md](./05-data-storage.md#51-存储位置))即完全重置:

- `%APPDATA%/grok-desktop/settings.json`(Windows)
- `%APPDATA%/grok-desktop/conversations.json`

## 6.8 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 「服务器返回了空响应」 | 检查 API 地址是否真正指向 grok2api;若任意路径只返回字面 `OK`,说明 nginx 未转发到应用 |
| 「上游服务返回错误:…Console API…403」 | 推理等级模型(`grok-4.3-low/medium/high`)被上游拒绝(账号无 reasoning 权限)。把推理等级切回「关」即可 |
| 统计栏显示 `≈` 而非真实 token | 网关未返回 `usage`(补丁被覆盖或使用第三方网关),回退为客户端估算 |
| `401` | API Key 无效,与网关后台不一致 |
| `429` | 限流;console 免费模型已默认过滤,可稍后重试或换账号池 |
| 模型列表为空 | 网关 `/v1/models` 未返回标准 OpenAI 格式;此时使用内置 `DEFAULT_MODELS` 回退 |
| 无法连接 / 超时 | 本机网络或代理问题;`api.js` 使用 `electron.net.fetch` 以遵循系统代理(Clash 等) |

## 6.9 版本与许可证

- 当前版本:**1.1.15**(`package.json`)
- 许可证:**MIT**(`LICENSE`)
