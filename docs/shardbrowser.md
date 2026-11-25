# ShardBrowser 接入说明

本项目的默认浏览器引擎是 **ShardBrowser**（本机指纹浏览器启动器，`shardx-launcher`）。
Camoufox 保留为可选回退引擎（`browser.engine = "camoufox"`），仅在离线实验时使用。

## 1. 运行前置条件

1. 本机安装并启动 **ShardBrowser Launcher**（本次联调版本 `2.1.5`）。
2. 启动器设置里开启 **API**，记下监听端口（默认 `40325`）。
3. 在启动器“API”页面生成本机 **Bearer 密钥**，形如：

   ```
   <jwt-header>.<payload>.<signature>
   ```

4. 把密钥写进**项目根目录的配置文件** `shardbrowser.json`（该文件已在 `.gitignore` 中，
   不会提交）：

   ```bash
   cp -n shardbrowser.example.json shardbrowser.json   # Windows: Copy-Item shardbrowser.example.json shardbrowser.json
   ```

   ```json
   {
     "endpoint": "http://127.0.0.1:40325",
     "token": "<KEY>",
     "platform": "Windows",
     "timeoutMs": 20000
   }
   ```

   其它提供方式（按优先级）：

   | 优先级 | 来源 | 说明 |
   |---|---|---|
   | 1 | `config/sheerid.local.json` 的 `shardBrowser.{endpoint,token,platform,timeoutMs}` | 单次覆盖，优先于文件 |
   | 2 | **根目录 `shardbrowser.json`** | 默认凭据来源 |
   | 3 | 环境变量 `SHARDBROWSER_TOKEN` / `SHARDX_API_TOKEN` / `SHARDBROWSER_API_KEY`、`SHARDBROWSER_ENDPOINT` | 只在文件未提供时生效 |

   - 换用别的凭据文件：主配置写 `"shardBrowser": { "configFile": "D:/secrets/shardbrowser.json" }`，
     或用 `SHARDBROWSER_CONFIG` 指定路径。显式指定的文件不存在会直接报错
     `INVALID_SHARDBROWSER_CONFIG`；默认文件缺失则视为未配置（走环境变量）。
   - 凭据文件只接受 `endpoint`/`token`/`platform`/`timeoutMs` 四个键，多余键会被拒绝。
   - 运行时日志会记录 `tokenSource`（`file`/`config`/`env`）但不打印 token 本身。

## 2. 与启动器交互的接口契约

所有接口都在 `http://127.0.0.1:<api_port>`，除 `/health` 外都必须带
`Authorization: Bearer <KEY>`。实现见 `src/browser/shardbrowser.js`。

| 步骤 | 请求 | 用途 |
|---|---|---|
| 健康检查 | `GET /health` | 返回 `{"ok":true,"name":"shardx-launcher","version":"2.1.5"}`；启动器没开时直接失败 |
| 指纹列表 | `GET /fingerprints` | 平台字段为 `Windows`/`macOS`/`Linux`/`Android`，含 `gpu` 描述 |
| 建临时配置 | `POST /profiles/temporary` | body `{platform, name?, fingerprint_id?, proxy?}`；返回 `{id, fingerprint_id, proxy_inline}` |
| 启动 | `POST /profiles/:id/start` | body `{headless?}`；返回 `{pid, headless, cdp:{port,http_url,web_socket_debugger_url}}` |
| 停止 | `POST /profiles/:id/stop` | 释放浏览器进程 |
| 删除 | `DELETE /profiles/:id` | 删除临时配置（临时配置不出现在 `GET /profiles` 列表里） |
| 运行中 | `GET /running` | 排查残留会话 |

Playwright 通过 `chromium.connectOverCDP(web_socket_debugger_url)` 接管该窗口，
复用其默认 context（`browser.contexts()[0]`），再 `newPage()` 访问 SheerID。

## 3. 指纹策略（对应需求 5）

| 项 | 取值 | 说明 |
|---|---|---|
| 操作系统 | **固定 `Windows`** | `platform: "Windows"`；配置里填其它平台会直接报错 `ShardBrowser 平台固定为 Windows` |
| 硬件指纹 | 每次任务随机 | 优先挑笔记本 GPU（`Laptop/Notebook`），其次核显（`UHD/HD/Iris/Vega`），再退回全部 Windows 指纹；也可用 `browser.fingerprintId` 固定 |
| 时区 / 地理位置 | **随出口 IP 自动** | 指纹里 `timezone` 与 `geolocation` 固定为 `auto`，启动器按出口 IP 解析（实测出口在法兰克福时 `Europe/Berlin`） |
| 浏览器语言 | **强制 `en-US`** | 不随 IP：`shardBrowser.language` 默认 `en-US`（`auto` 可改回跟随）。英文 UI 保证国家选项渲染为 `Germany`。中文营销活动页面由表单内置语言选择器再切回 English（见 `src/apps/sheerid/language.js`） |
| 屏幕 | 主流笔记本档位 | 实测 `1280x800 @1.5`（对应 1920x1200 面板 150% 缩放）；`LAPTOP_RESOLUTIONS` 常量记录可接受档位用于校验 |

任务开始时新建临时配置，任务结束（成功、失败、取消均如此）按
`stop → delete` 顺序回收，不残留配置文件。

## 4. 代理（对应需求 6）

- 代理来自项目既有配置：`proxy`（字符串或 `{server,username,password}`），也支持
  `AUTOMATION_PROXY` 覆盖与 Windows 系统代理回退。
- `proxyString()` 把解析后的代理拼成启动器接受的形态并填入临时配置：
  - HTTP：`http://user:pass@host:port`（凭证 URL 编码）
  - SOCKS5：`socks5://host:port`
- 启动结果里 `proxy_inline: true` 表示代理确实挂在该临时配置上。
- SheerID 接口请求仍走项目原有的本地转接（`src/core/network.js`），与浏览器出口 IP 一致。

## 5. 失败模式与错误码

| 错误码 | 触发条件 | 处理 |
|---|---|---|
| `SHARDBROWSER_UNREACHABLE` | 启动器未运行 / 端口不对 | 提示检查启动器 API 与 `shardBrowser.endpoint` |
| `SHARDBROWSER_UNAUTHORIZED` | 401 | 提示重新生成 Bearer 密钥 |
| `SHARDBROWSER_TIMEOUT` | API 响应超时 | 检查启动器是否卡住 |
| `SHARDBROWSER_ERROR` | 其它非 2xx | 带上状态码与启动器返回的 error |
| `SHARDBROWSER_CDP_FAILED` | 调试端口接管失败 | 已确保 `stop + delete` 回收后报错 |
| `INVALID_CONFIG` | 未配置密钥 / 平台非 Windows | 启动前拒绝，不打开浏览器 |

## 6. 已知限制

- 启动器只允许 `GET` 访问指纹库（`PUT/POST /fingerprints` 返回 405），因此本实现**不能**把
  自定义指纹写回库里；时区/语言依赖启动器自身的自动地理定位（实测：库内指纹写着 Europe/Warsaw 与 pl-PL，启动后按出口 IP 变为 Europe/Berlin 与 de-DE）。
- `headless` 由 `start` 的 body 控制（`{headless:true}` → 响应 `headless:true`），
  无界面模式下窗口不可见，但指纹不变。
- 手工填写模式（`browser.autoFill:false`）下浏览器会保持打开，由操作者关闭窗口结束任务。
