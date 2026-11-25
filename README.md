[中文](README.md) | [English](README_EN.md)

# verity-tool

[![Tests](https://github.com/saru54/verity-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/saru54/verity-tool/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.15-43853d)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

一个基于 Node.js (ESM) 构建的自动化验证流程工作台，集成 Web 控制台、并发任务队列、浏览器表单交互适配器、请求隔离代理桥接以及本地 PDF 模板渲染与归档能力，适用于软件工程教学、UI/状态机自动化测试与获得明确授权的流程验证研究。

> **合规与授权声明：** 本项目仅面向技术学习、本地测试及**已获明确授权**的验证流程调试使用。严禁用于伪造身份与证明文件、冒用他人资料、绕过平台访问控制或实施未经授权的批量请求。使用真实接口前请确保已取得相关主体与平台授权并遵守适用法律与服务条款；交互式真人验证步骤应由操作者自行完成。详见 [用途说明与免责声明](DISCLAIMER.md)。

---

## 核心特性

- **Web 控制台与并发任务队列**
  - 内置任务队列管理器（`WebJobs`），支持按 `web.concurrency` 控制并发、FIFO 排队、暂停/取消、恢复及任务清理。
  - 每个任务分配独立的 24 位十六进制随机 `taskId`，实时记录结构化事件流并落盘为 `.runs/<taskId>.events.json`，支持界面查看与导出。
- **Web 安全鉴权**
  - **强制账号密码登录**：未配置任何账号时服务端拒绝启动；支持单账号（`ONE_WEB_USERNAME` / `ONE_WEB_PASSWORD`）与多账号（`ONE_WEB_USERS`，支持 `sha256:<64 hex>` 预哈希）。
  - 服务端仅存密码 SHA-256 摘要，登录失败按来源地址递增退避（最高 2 秒）；使用 `HttpOnly`、`SameSite=Strict` 会话 Cookie（配置 `ONE_WEB_PUBLIC_ORIGIN` 时自动启用 `Secure`），并在写接口校验 `Host`、`Origin`、`Sec-Fetch-Site` 与 `X-Local-Token`。
- **双浏览器引擎与拟人表单交互**
  - 默认集成 **Camoufox**（基于 `playwright-core`），并支持可选 **ShardBrowser**（Windows CDP 启动器接入）。
  - 封装了分步鼠标移动、控件内随机落点点击、按键随机间隔及自然停顿机制，支持原生 `<select>` 与 ARIA 下拉组合框的选项稳定性校验与重试。
- **代理路由隔离与连通性检测**
  - 基于 Node.js `AsyncLocalStorage` 与 `undici` / `proxy-chain` 实现单任务级网络隔离，确保浏览器流量与服务端 API 状态轮询共用同一代理出口。
  - 支持直连（`direct`）、静态 HTTP/SOCKS5 代理，以及可选动态代理配置（`nodemaven` / `dataimpulse`）与连通性/IP 检测前置步骤。
- **多区域示例模板渲染与归档**
  - 内置纯 Node.js PDF 渲染器与 `opentype.js` 矢量签名绘制，包含 `US` / `CA` / `GB` / `DE` 四国高校测试数据集与示例文档模板（用于测试渲染与归档链路），同时支持通过 `--file` 或 `--url` 挂载外部已授权文档。
  - 归档按 `taskId` 独立存储并校验文件 SHA-256，支持在 Web 界面「材料存档」中预览、下载与查看历史尝试记录。

---

## 环境要求

- **Node.js >= 22.15**（启用 ESM 与 `--experimental-test-module-mocks` 测试支持）
- **npm**
- Windows / Linux / macOS（Linux 下运行有界面模式需可用 X11/桌面环境；无桌面可使用无头模式）

---

## 快速开始

### 1. 克隆项目并安装依赖

```bash
git clone https://github.com/saru54/verity-tool.git
cd verity-tool
npm ci
npm run browser:install
```

### 2. 初始化配置

复制示例配置文件并按需编辑（`config/*.local.json` 与 `shardbrowser.json` 已加入 `.gitignore`，不会提交到 Git）：

```bash
# Linux / macOS
cp -n config/sheerid.example.json config/sheerid.local.json
chmod 600 config/sheerid.local.json

# Windows PowerShell
Copy-Item config/sheerid.example.json config/sheerid.local.json
```

> 配置文件必须为标准 JSON（不支持注释或尾随逗号）。使用 `npm run web` 首次启动时，如 `config/sheerid.local.json` 不存在也会自动从 `config/sheerid.example.json` 复制生成。

如需使用 ShardBrowser，可复制 `shardbrowser.example.json` 为 `shardbrowser.json` 并填入本地 API Token（也可通过环境变量 `SHARDBROWSER_TOKEN` / `SHARDBROWSER_ENDPOINT` 提供）。

### 3. 配置登录账号并启动 Web 工作台

Web 服务要求至少配置一个登录账号：

```bash
# Linux / macOS
export ONE_WEB_USERNAME=ops
export ONE_WEB_PASSWORD="replace-with-a-strong-password"
npm run web

# Windows PowerShell
$env:ONE_WEB_USERNAME = "ops"
$env:ONE_WEB_PASSWORD = "replace-with-a-strong-password"
npm run web
```

多账号配置可使用逗号分隔形式（支持明文或 `sha256:` 预哈希）：

```bash
ONE_WEB_USERS=ops:strong-password,audit:sha256:<64位十六进制摘要>
```

启动后在浏览器访问 `http://127.0.0.1:8787` 登录使用（可通过 `ONE_WEB_HOST=127.0.0.1` 限制仅本机监听，公网反代部署请务必配置 `ONE_WEB_PUBLIC_ORIGIN=https://your-domain`）。

### 4. CLI 命令行入口

```bash
# 仅自动填写表单并保留浏览器窗口（不自动提交）
npm start -- --config config/sheerid.local.json

# 查询配置 URL 当前状态
npm run status -- --config config/sheerid.local.json

# 执行完整提交流程
npm run submit -- --config config/sheerid.local.json
```

---

## 测试

项目自带基于 `node:test` 的离线单元测试套件，使用模拟接口与本地夹具，不访问真实外部验证服务：

```bash
npm test
```

> 未安装本地 Camoufox 二进制时，依赖真实浏览器窗口的 UI 测试会自动跳过；GitHub Actions CI 默认在 Node.js 24 上执行 `npm test -- --test-timeout=30000`。

---

## 目录结构

```text
verity-tool/
├── config/                 # 示例配置模板 (sheerid.example.json)
├── deploy/                 # Linux systemd 与 Nginx 部署模板
├── docs/                   # 部署指南、浏览器流程与文档归档说明
├── examples/               # 静态示例渲染文件
├── scripts/                # 浏览器安装与辅助脚本
├── src/
│   ├── apps/sheerid/       # 表单适配器、状态查询、页面上传与语言切换
│   ├── browser/            # Camoufox / ShardBrowser 会话与拟人表单交互
│   ├── core/               # 配置校验、任务锁、代理隔离、IP 检查与状态机
│   ├── data/               # 示例高校测试数据集
│   ├── materials/          # PDF 模板渲染、签名生成与身份数据工具
│   └── web/                # HTTP 服务、鉴权、队列调度与前端控制台
└── tests/                  # 单元测试与夹具
```

---

## 相关文档

- [部署指南（Linux / systemd / Nginx）](docs/DEPLOYMENT.md)
- [浏览器流程说明](docs/browser-workflow.md)
- [模板渲染与归档说明](docs/materials.md)
- [ShardBrowser 接入说明](docs/shardbrowser.md)
- [安全说明](SECURITY.md) · [贡献指南](CONTRIBUTING.md) · [免责声明](DISCLAIMER.md)

## 开源协议

基于 [ISC License](LICENSE) 开源。请在使用前阅读并遵守 [用途说明与免责声明](DISCLAIMER.md)。
