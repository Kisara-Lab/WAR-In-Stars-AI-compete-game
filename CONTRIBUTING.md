# Contributing / 参与贡献

欢迎中文或英文 Issue、讨论与 PR。We welcome contributions in Chinese or English.

## Branch and PR workflow / 分支与 PR 流程

`main` is protected, including for administrators. Create a topic branch from the latest `main`, commit your changes there, and open a pull request targeting `main`. Do not push directly, force-push, or delete `main`.

Before merging, the branch must be up to date, all review conversations must be resolved, and these GitHub Actions checks must pass:

- `Test and build (ubuntu-latest)`
- `Test and build (windows-latest)`
- `Browser (Linux Chromium)`

An additional approving reviewer is currently optional, so a solo maintainer can merge a PR after the required checks pass. This does not waive the PR or CI requirements. Do not disable protection or bypass checks to merge a change.

`main` 已开启保护，管理员同样受约束。后续修改均从最新 `main` 创建主题分支，通过 PR 合并；禁止直接推送、强制推送或删除主分支。合并前同步主分支、解决全部评审讨论，并通过上述三项 CI。当前不强制第二位维护者批准，单人维护也可以完成 PR 流程；不得因此绕过 PR 或 CI。

```bash
git switch main
git pull --ff-only
git switch -c feat/your-change
# Edit, test and commit on this branch.
git push -u origin feat/your-change
# Open a pull request targeting main on GitHub.
```

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
