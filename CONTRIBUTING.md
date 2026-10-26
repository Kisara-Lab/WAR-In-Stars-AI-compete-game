# Contributing / 参与贡献

欢迎中文或英文 Issue、讨论与 PR。We welcome contributions in Chinese or English.

## Local development

Use Node.js 24 or newer. Fork and clone the repository, then run:

```bash
npm ci
npm run dev
```

Backend: `127.0.0.1:8787`; development UI: `127.0.0.1:5173`. Create a **scripted** match for development without API credentials. On Windows use `npm.cmd` / `npx.cmd` if PowerShell blocks the corresponding `.ps1` scripts.

## Before a pull request

```bash
npm run typecheck
npm test
npm run docs:check
npm run build
npx playwright install chromium
npm run test:e2e
```

Linux may need `npx playwright install --with-deps chromium`. Browser tests use an isolated service on port 8790. Standard tests use scripts and mocked model responses, not paid inference.

- Describe the observable behavior, why it changes, and the verification performed.
- Keep game values in the shared rule configuration. For mechanics changes, include a deterministic scenario and identify the applicable revision.
- Preserve old-save behavior unless an explicit migration is part of the change. Test that read-only previews do not mutate state and faction views do not expose hidden information.
- When changing SSE or commands, check budgets, complete-response handling, batch rollback and shared round boundaries.
- Keep Chinese and English READMEs consistent. Detail the actual transport requirements rather than claiming every provider works.
- Do not submit API keys, personal paths, `.data`, raw private model requests or generated dependencies. Use minimal synthetic fixtures for bug reports.
- Do not run paid smoke tests in CI. `npm run smoke:ai` is an explicit local, quota-consuming action.

## 提交建议

围绕一个主题提交：玩法、模型适配、观察界面、测试或文档。机制改动请说明修订、兼容与确定性；文档改动请同时检查中英文入口和链接。报告问题时附版本、复现步骤、实际结果与期望结果，先去掉密钥及私人数据。

Contributions are made under the project's [MIT license](LICENSE). Only contribute code and assets you are entitled to share.
