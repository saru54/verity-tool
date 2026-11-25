# 参与贡献

欢迎参与 [verity-tool](https://github.com/saru54/verity-tool)，改进架构设计、配置校验、错误处理、任务队列、单元测试及文档。参与前请先阅读 [用途说明与免责声明](DISCLAIMER.md)。

## 开发环境

需要 Node.js >= 22.15 与 npm。在仓库根目录执行：

```bash
npm ci
npm run browser:install
npm test
```

`npm run browser:install` 会下载适用于当前系统的 Camoufox 运行时。未安装本地浏览器时，依赖真实浏览器的测试用例会自动跳过；涉及浏览器交互的改动建议在安装浏览器后完成实测验证。

所有单元测试均基于本地测试页、模拟接口和虚构测试数据运行，不得向外部真实服务发送批量请求或提交真实个人资料。

## 报告问题

提交 Issue 时请附带操作系统、Node.js 版本、最小复现步骤、预期与实际行为以及脱敏后的错误日志。**请勿粘贴个人配置、真实验证链接、账号密码、代理凭据或会话 Cookie。**

安全漏洞请按 [安全说明](SECURITY.md) 私下报告。

## 提交规范

1. 从主分支创建特性分支，单次 PR 聚焦一个清晰的问题或改进。
2. 保持项目现有的 ESM 代码风格；新增配置项时同步更新示例配置与文档。
3. 补全对应单元测试并确认 `npm test` 通过。
4. 提交前运行 `git status` 与 `git diff --check`，确认未纳入本地配置（`config/*.local.json`、`shardbrowser.json`、`.env*`）与运行日志（`.runs/`）。

不接受涉及伪造证明、冒用身份、绕过访问控制或未授权自动化请求的功能提交。提交的代码默认按本项目 [ISC 协议](LICENSE) 开源。
