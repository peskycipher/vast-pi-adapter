/**
 * Vast.ai Serverless adapter for pi.
 *
 * Discovers your Vast.ai Serverless endpoints (vLLM deployments) via the Vast
 * console API and exposes each one as an OpenAI-compatible chat model in /model.
 * All request conversion and streaming is delegated to pi-ai's built-in
 * OpenAI Chat Completions API — no custom streaming code.
 *
 * How it works
 *   - Vast runs an OpenAI-compatible proxy: https://openai.vast.ai/<ENDPOINT_NAME>/v1
 *     (Bearer auth with your Vast API key; the `model` field is IGNORED by the
 *     proxy — the served model is fixed by the endpoint's configuration).
 *     https://docs.vast.ai/guides/serverless/openai-compatible-api
 *   - Your endpoints are listed via the console API:
 *     POST https://console.vast.ai/api/v0/endptjobs/  {client_id:"me", api_key}
 *     (same call `vastai show endpoints` makes).
 *   - Each endpoint becomes one model entry in pi, id = endpoint name, with a
 *     per-model baseUrl pointing at the proxy route for that endpoint.
 *
 * Authentication (checked in order):
 *   1. $VAST_API_KEY environment variable
 *   2. ~/.config/vastai/vast_api_key  (vastai CLI convention)
 *
 * Test hook: VAST_CONSOLE_URL overrides https://console.vast.ai (tests only).
 *
 * Limitations (inherited from Vast's proxy, text-in/text-out only):
 *   no image input, no audio, no embeddings. Context window / max tokens are
 *   conservative guesses (vLLM does not advertise them here) — override with
 *   VAST_DEFAULT_CONTEXT_WINDOW / VAST_DEFAULT_MAX_TOKENS if your deployed
 *   model needs different values. Pricing metadata is zeroed (unknown).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";

const CONSOLE_URL = process.env.VAST_CONSOLE_URL?.replace(/\/+$/, "") || "https://console.vast.ai";
const OPENAI_PROXY = "https://openai.vast.ai";
const API_PATH = "/api/v0/endptjobs/";

// =============================================================================
// Pure helpers (exported for tests)
// =============================================================================

/** Resolve the Vast API key: $VAST_API_KEY, then ~/.config/vastai/vast_api_key. */
export function resolveVastApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.VAST_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const home = env.HOME?.trim() || homedir();
    const fromFile = readFileSync(join(home, ".config/vastai/vast_api_key"), "utf8").trim();
    return fromFile || undefined;
  } catch {
    return undefined;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Extract unique, non-empty endpoint names from a console `endptjobs` result payload. */
export function endpointNamesFromPayload(payload: unknown): string[] {
  const names: string[] = [];
  if (typeof payload !== "object" || payload === null) return names;
  const { success, results } = payload as { success?: unknown; results?: unknown };
  // The console API gates the payload on `success`; anything else fails closed.
  if (success !== true || !Array.isArray(results)) return names;
  for (const row of results) {
    let name: unknown;
    if (typeof row === "string") {
      name = row;
    } else if (typeof row === "object" && row !== null) {
      name = (row as { endpoint_name?: unknown }).endpoint_name;
    }
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return [...new Set(names)];
}

/**
 * Map endpoint names to full Model objects. The upstream proxy ignores the
 * `model` field, so one endpoint == one model, id = endpoint name. Metadata
 * defaults are conservative because vLLM does not advertise limits through
 * the proxy.
 */
export function endpointsToModels(
  endpointNames: readonly string[],
  providerId = "vast",
): Model<"openai-completions">[] {
  const contextWindow = envInt("VAST_DEFAULT_CONTEXT_WINDOW", 131072);
  const maxTokens = envInt("VAST_DEFAULT_MAX_TOKENS", 8192);
  const unique = [...new Set(endpointNames.map((n) => n.trim()).filter(Boolean))];
  return unique.map((name) => ({
    id: name,
    name: `vast: ${name}`,
    api: "openai-completions" as const,
    provider: providerId,
    // Per-model baseUrl: each endpoint has its own proxy route.
    baseUrl: `${OPENAI_PROXY}/${encodeURIComponent(name)}/v1`,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      // Mirror the user's verified RunPod/vLLM entry; do not claim unverified
      // compatibility (vLLM chat route, not OpenAI itself).
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  }));
}

/** POST the console endptjobs listing; returns endpoint names. Fails closed. */
export async function fetchVastEndpoints(
  apiKey: string,
  opts: { signal?: AbortSignal; consoleUrl?: string } = {},
): Promise<string[]> {
  const base = (opts.consoleUrl ?? CONSOLE_URL).replace(/\/+$/, "");
  const response = await fetch(`${base}${API_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ client_id: "me", api_key: apiKey }),
    signal: opts.signal,
  });
  if (!response.ok) return [];
  try {
    return endpointNamesFromPayload(await response.json());
  } catch {
    return [];
  }
}

function modelsToConfigs(models: readonly Model<"openai-completions">[]): ProviderModelConfig[] {
  return models.map(({ id, name, api, baseUrl, reasoning, input, cost, contextWindow, maxTokens, compat }) => ({
    id, name, api, baseUrl, reasoning, input, cost, contextWindow, maxTokens, compat,
  }));
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  const readPersisted = (ctx: RefreshModelsContext): ProviderModelConfig[] => {
    const stored = ctx.stored?.models;
    return Array.isArray(stored) ? modelsToConfigs(stored as Model<"openai-completions">[]) : [];
  };

  pi.registerProvider("vast", {
    name: "Vast.ai",
    // Same interpolation syntax as models.json: env first, then vastai CLI key file.
    apiKey:
      "!sh -c 'if [ -n \"$VAST_API_KEY\" ]; then printf %s \"$VAST_API_KEY\"; else cat \"$HOME/.config/vastai/vast_api_key\" 2>/dev/null; fi'",
    api: "openai-completions",
    models: [],
    refreshModels: async (ctx: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
      // Offline or unconfigured: keep whatever is already known (persisted snapshot).
      const key = resolveVastApiKey();
      if (!ctx.allowNetwork || !key) return readPersisted(ctx);
      try {
        const names = await fetchVastEndpoints(key, { signal: ctx.signal });
        const models = endpointsToModels(names);
        if (models.length) {
          await ctx.publish({ persist: { models, checkedAt: Date.now() } });
        }
        return modelsToConfigs(models);
      } catch {
        // Fail closed: keep previous list, no silent success, never throw.
        return readPersisted(ctx);
      }
    },
  });
}