# 使用与接口 / Usage and interfaces

[中文首页](../README.md) · [English home](../README.en.md)

## 无密钥启动 / Start without credentials

```bash
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8787`, choose **＋ 新比赛 → 控制方式 → 脚本演示**, then start or step the match. The scripted controller requires no API key. Startup does not automatically run a match.

默认新局是模型控制；无密钥时请创建脚本演示局。开发模式 `npm run dev` 提供5173前端和8787后端。服务只绑定本机地址，公开托管前请阅读 [安全说明](../SECURITY.md)。

## 模型接口

复制 `AIKEY.env.example` 为根目录 `AIKEY.env`，在本机填入 `base` 与 `key`。这两个字段由后端文件配置读取，不会因在浏览器里填写模型名而自动获得凭据。配置文件不要提交到Git。

## Provider and transport

The backend reads `base` and `key` from the local root-level `AIKEY.env`. It normalizes the base to `/v1`, calls `/v1/models` for selection and `/v1/responses` for inference. It sends:

- `stream: true`, `Accept: text/event-stream`;
- function tools and a forced `submit_turn` function choice;
- `reasoning: { effort: "low" }`;
- up to 8192 output tokens under rules 5.4.

Responses must follow the Responses SSE/tool-calling protocol. Only a completed response is validated. Rejected plans return `function_call_output` so the model can resubmit the entire plan. Multiple compact actions count toward the 48-action budget after expansion. Each faction gets up to three requests, 90 seconds per request and 180 seconds per decision attempt. A failed faction pauses the shared round without submitting the others.

The source adapter is `src/server/provider.ts`; streaming parsing is `src/server/sse.ts`. API-provider-specific requirements should be implemented and tested explicitly. No Chat Completions or plain-JSON fallback is silently enabled.

模型选择页显示服务商列表；名称可用与协议兼容是两项不同检查。服务商不支持请求参数、模型渠道不可用、限流或SSE未完成时，界面会保留错误和未提交状态。修复接口配置后手动重试当前轮，不能把失败计划当作已执行。不要通过反复点击开始制造无意义的付费重试。

## 成本 / Usage

Real inference uses your provider's quota. Usage counters reflect reported values; interrupted responses without usage remain unknown. Pricing is not inferred. An audit can include paid or attempted requests that never committed a game round, especially after process interruption; use the full audit when reconciling a run.

CI, standard tests, scripted simulations and benchmarks do not perform paid inference. The optional `npm run smoke:ai -- --rounds 2` does, and creates a local match and verification report.

## 保存与分支 / Persistence

| Path | Purpose |
|---|---|
| `.data/matches/<id>/initial.json` | Initial state |
| `.data/matches/<id>/round-NNNN.json` | Committed state and accepted decisions |
| `.data/matches/<id>/audit.jsonl` | Append-only audit chain, including failed attempts |
| `.data/matches/<id>/checkpoint.json` | Latest checkpoint |
| `.data/server-session.json` | Current match pointer |

All paths are local runtime output and excluded from Git. The server recovers the last committed round and waits for manual continuation. Old rule revisions are not silently upgraded. Use the explicit **以V5.4创建分支** action when migrating, and preserve the original archive. See [migration](migration/MIGRATION-V5.4.md).

After pausing and allowing the active attempt to exit, back up the whole relevant match directory and session pointer. A raw audit file contains public model text and visible game observations; review it before sharing.

## REST 示例 / REST example

The default `examples/match.json` selects a scripted controller. With the service already running:

```bash
curl -X POST http://127.0.0.1:8787/api/matches \
  -H 'Content-Type: application/json' --data-binary @examples/match.json
curl -X POST http://127.0.0.1:8787/api/step
curl http://127.0.0.1:8787/api/state
```

Windows PowerShell:

```powershell
$match = Get-Content examples/match.json -Raw
Invoke-RestMethod http://127.0.0.1:8787/api/matches -Method Post -ContentType application/json -Body $match
Invoke-RestMethod http://127.0.0.1:8787/api/step -Method Post
```

`POST /api/step` starts an asynchronous attempt; read `/api/state` until `status.busy` and `status.running` are both false before starting another one. A successful POST is not proof the round committed: inspect `state.round` and `status.error`.

| Endpoint | Role |
|---|---|
| `GET /api/health` | Service and worker status |
| `GET /api/state` | Observer snapshot and decision progress |
| `GET /api/rules` | Current rule configuration |
| `GET /api/provider` | Configuration status and model list, never the key |
| `POST /api/matches` | Create a match from a configuration |
| `POST /api/start`, `/api/step`, `/api/pause` | Start, step or cancel/pause |
| `POST /api/save` | Save a completed boundary |
| `POST /api/load` | Restore or explicitly branch a saved match |

The observer UI also exposes audit filtering and exports. These are local observation APIs, not an authenticated multi-user hosting API.

## 开发与验证 / Development

```bash
npm run typecheck
npm test
npm run docs:check
npm run build
npx playwright install chromium
npm run test:e2e
npm run simulate -- --factions 4 --systems 24 --rounds 12 --workers 2 --seed demo
```

Browser tests use port8790 with independent `.data/browser-*` paths. Install Chromium with `--with-deps` on Linux when system libraries are missing; Windows uses installed Edge when available, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to select another executable.

Validate a local match without inference:

```bash
npm run verify:match -- --id YOUR_MATCH_ID
npm run verify:match -- --id YOUR_MATCH_ID --replay --workers 0
```

The first command checks the saved state and audit; only `--replay` executes accepted commands again and checks successive state hashes. These commands require your own local match data.
