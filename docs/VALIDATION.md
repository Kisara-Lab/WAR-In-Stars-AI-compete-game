# Open-source validation / 开源验证

The public copy is tested without real API credentials or production saves. This record concerns the distributable source; the selected historical campaign is documented separately in the [case study](case-studies/120-rounds.en.md).

## Local checks — 2026-10-26

| Check | Result |
|---|---|
| Clean `npm ci` on Node.js 24 / Windows | Passed |
| TypeScript and production build | Passed |
| Vitest mechanisms and integration | 282 tests passed, 16 files |
| Playwright browser suite, isolated port8790 | 19 tests passed |
| No-key CLI demo, four factions / 12 rounds / two workers | Passed |
| Anonymous GitHub clone, clean install, documentation checks and build | Passed |

Coverage includes economy and employment, rule revisions, warfare and treaties, institutions and welfare, emergency recovery, SSE correction, batch rollback, state recovery, audit export, information isolation and the observer UI. Model calls in automated tests are mocked; no paid inference was requested for this release preparation.

CI runs Node.js24 typechecking, tests, documentation checks and build on Linux and Windows. A separate Linux/Chromium job exercises the full browser suite. Current results are available in [GitHub Actions](https://github.com/Kisara-Lab/WAR-In-Stars-AI-compete-game/actions/workflows/ci.yml).

The first CI run exposed a CPU-dependent worker limit and a five-second assertion deadline for completing five rounds. The public copy now retains conservative automatic worker sizing while permitting explicit eight-worker reproducibility runs on smaller hosts. The browser completion assertion allows 20 seconds for simulation and persistence, retaining every result and replay assertion. No gameplay rules were changed or tests removed.

## Reproduce

```bash
npm ci
npm run typecheck
npm test -- --maxWorkers=2
npm run docs:check
npm run build
npx playwright install chromium
npm run test:e2e
```

On Linux, use `npx playwright install --with-deps chromium` when installing system dependencies is needed. Standard testing never needs `AIKEY.env`; do not copy live credentials into CI.

本地测试结果来自独立开源副本，不包含原私有生产目录。公开案例的历史审计核验结果不等于在此副本重新执行了完整真实比赛。新克隆可复现机制与脚本测试；真实模型输出和服务商用量需由新的运行重新记录。
