# 安全说明

本说明适用于 [saru54/verity-tool](https://github.com/saru54/verity-tool)。

## 部署与数据保护

- Web 工作台强制账号密码登录，所有业务 API 均需有效会话；**未配置任何登录账号时服务会拒绝启动**。
- 默认监听 `0.0.0.0`（可通过 `ONE_WEB_HOST=127.0.0.1` 限制为本机）；**对外暴露访问时必须启用 HTTPS**，并配置 `ONE_WEB_PUBLIC_ORIGIN`（自动附加 `Secure` Cookie）或前置 TLS 反向代理。
- 服务端仅在内存中保存密码的 SHA-256 摘要（支持 `sha256:<64 hex>` 预哈希配置），不存明文；登录失败会按来源 IP 递增退避延迟（上限 2 秒）以防爆破。写操作同时校验 `Host`、`Origin`、`Sec-Fetch-Site` 与会话绑定 CSRF 令牌。
- 将 `config/*.local.json`、`shardbrowser.json`、`.env.web` 与 `.runs/` 严格保留为本地私有文件并限制文件权限（如 `chmod 600`），切勿提交至版本库或作为静态资源暴露。

部署与安全配置详情见 [部署指南](docs/DEPLOYMENT.md)。

## 漏洞报告

请通过 GitHub 仓库的 **Security → Advisories → Report a vulnerability** 私下报告安全问题，或先在 Issue 中请求维护者提供私下联系方式，勿公开可被利用的细节或真实配置数据。
