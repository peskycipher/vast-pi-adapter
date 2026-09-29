# vast-pi-adapter

Vast.ai Serverless adapter for the [pi coding agent](https://github.com/earendil-works/pi). Discovers your Vast.ai Serverless endpoints (vLLM deployments) and exposes each one as an OpenAI-compatible chat model in `/model`.

## Install

```bash
ln -sfn /home/loki/projects.io/vast-pi-adapter ~/.pi/agent/extensions/vast
```

`~/.pi/agent/extensions/` is already in pi's extension discovery path, and pi loads symlinked directories (verified with pi 0.87.1).

## Authentication

The adapter resolves the Vast API key in this order:

1. `VAST_API_KEY` environment variable
2. `~/.config/vastai/vast_api_key` — the file the `vastai` CLI writes (`pip install vastai` + `vastai set api-key ...`)

Create a key at https://cloud.vast.ai/account/ or https://console.vast.ai/manage-keys/.

## How it works

- **Discovery**: on refresh, `POST https://console.vast.ai/api/v0/endptjobs/` (the same call `vastai show endpoints` makes) lists your endpoint groups; each `endpoint_name` becomes one model with id = endpoint name. The list is persisted to pi's `models-store.json` so it survives restarts and works offline (`--list-models`, `--offline`).
- **Serving**: requests go to Vast's OpenAI-compatible proxy `https://openai.vast.ai/<ENDPOINT_NAME>/v1/chat/completions` with Bearer auth. Streaming, tool calls, usage accounting, and cancellation are all handled by pi's built-in OpenAI Chat Completions API — this adapter contains no custom streaming code.
- **The `model` field is ignored** by Vast's proxy; the served model is fixed by the endpoint's own configuration (`MODEL_NAME` in the endpoint template). That is why one endpoint = one model here.

## Refresh cadence

pi refreshes providers offline at startup (restore snapshot) and with network when you open `/model` in a session. So:

- First time: open `/model` → select `vast` → your endpoints appear (requires network).
- After that, `pi --list-models` shows them from the persisted snapshot even offline.

To re-derive model metadata after editing env defaults, open `/model` again (refresh runs then).

## Metadata defaults (overridable)

Vast's proxy does not advertise context limits or pricing, so the adapter uses conservative values. Override via env when your deployed model needs different values:

| Env var | Default | Meaning |
| --- | --- | --- |
| `VAST_DEFAULT_CONTEXT_WINDOW` | 131072 | advertised context window (tokens) |
| `VAST_DEFAULT_MAX_TOKENS` | 8192 | max output tokens |

Costs are reported as zero (pricing unknown). Thinking is off (`reasoning: false`); images are not claimed (`input: ["text"]`).

## Limitations (from Vast's proxy, verified in their docs)

- **Text in, text out only** — no image input, no audio, no embeddings.
- Only `/v1/chat/completions` and `/v1/completions` are proxied.
- Token counts come from vLLM, so they differ from OpenAI's tokenizer.

https://docs.vast.ai/guides/serverless/openai-compatible-api

## Development

```bash
bun test                          # unit + mock-server tests (11)
bun run e2e.ts <mockConsoleUrl> [--offline] [--store <dir>]   # real ModelRuntime E2E
bunx tsc --noEmit                 # type check
```

- `test.ts` — mocks the Vast console API and an OpenAI SSE server locally; proves discovery mapping, fail-closed behavior, key resolution, and the streaming delegation path.
- `e2e.ts` — drives pi's real `ModelRuntime` (same `registerProvider` path the extension runner uses) against a mock console; `--offline` proves snapshot restore.
- `VAST_CONSOLE_URL` (env) overrides `https://console.vast.ai` — test hook only; do not set in normal use.
- Source of truth is this directory; `~/.pi/agent/extensions/vast` is a symlink. `node_modules/` here symlinks to pi's globally installed `@earendil-works/*` packages (no dependencies are copied); `bun-types` + `typescript` are the only devDependencies.