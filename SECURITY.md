# Security / 安全说明

## Local operation

WAR IN STARS is a local observer application. Its server binds to `127.0.0.1` and checks browser origins. It does not provide multi-user authentication or tenant separation. Keep it on your own machine; do not expose the API through a public tunnel or reverse proxy without adding an appropriate authentication and access-control layer.

The model key is read on the server from `AIKEY.env`. Never put it in frontend code, a Git URL, a screenshot, an issue or a committed configuration file. The repository includes only `AIKEY.env.example`; local environment files and `.data` are ignored.

Audit records can contain visible game observations and public model output. Review exports before sharing them. If a key is disclosed, revoke or rotate it at the provider first; deleting a file does not revoke the credential.

## Reporting

Use the repository's private vulnerability reporting feature under **Security → Report a vulnerability** when available. Do not post exploit details, keys or private logs in a public issue. If private reporting is unavailable, open a minimal issue requesting a private contact route without including sensitive details.

## 中文

本项目面向本机使用，默认仅监听环回地址；浏览器来源校验不等于用户认证。公开托管需要另行配置身份验证与访问控制。模型密钥只放在本机 `AIKEY.env`，共享日志、截图和复盘前检查其中内容；泄露后先撤销或轮换密钥。

安全问题优先使用仓库 Security 页的私密漏洞报告，不在公开 Issue 中贴密钥或敏感日志。
