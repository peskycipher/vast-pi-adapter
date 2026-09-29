/**
 * Offline verification for the Vast.ai pi adapter.
 * Run: bun test test.ts   (from vast-pi-adapter/)
 *
 * No real Vast credentials are used. The console API and the OpenAI proxy are
 * both mocked with local HTTP servers.
 */

import { describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	endpointNamesFromPayload,
	endpointsToModels,
	fetchVastEndpoints,
	resolveVastApiKey,
} from "./index.ts";

// =============================================================================
// Unit: endpoint -> model mapping
// =============================================================================

describe("endpointNamesFromPayload", () => {
	test("extracts unique non-empty endpoint_name fields", () => {
		const payload = {
			success: true,
			results: [
				{ endpoint_name: "qwen-coder", id: 1, min_load: 100 },
				{ endpoint_name: "llama-70b", id: 2 },
				{ endpoint_name: "qwen-coder" }, // duplicate
				{ endpoint_name: "" }, // blank
				{ endpoint_name: null }, // missing
				"plain-string-name", // tolerated shape
			],
		};
		expect(endpointNamesFromPayload(payload)).toEqual(["qwen-coder", "llama-70b", "plain-string-name"]);
	});

	test("fails closed on malformed payloads", () => {
		expect(endpointNamesFromPayload(null)).toEqual([]);
		expect(endpointNamesFromPayload({ success: false })).toEqual([]);
		expect(endpointNamesFromPayload({ results: "not-an-array" })).toEqual([]);
	});
});

describe("endpointsToModels", () => {
	test("one model per endpoint, per-model baseUrl, text-only, conservative metadata", () => {
		const models = endpointsToModels(["qwen-coder", "llama-70b", "qwen-coder"]);
		expect(models).toHaveLength(2);
		const qwen = models[0]!;
		expect(qwen.id).toBe("qwen-coder");
		expect(qwen.name).toBe("vast: qwen-coder");
		expect(qwen.baseUrl).toBe("https://openai.vast.ai/qwen-coder/v1");
		expect(qwen.api).toBe("openai-completions");
		expect(qwen.input).toEqual(["text"]);
		expect(qwen.reasoning).toBe(false);
		expect(qwen.contextWindow).toBe(131072);
		expect(qwen.maxTokens).toBe(8192);
		expect(qwen.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(qwen.compat).toEqual({ supportsDeveloperRole: false, supportsReasoningEffort: false });
		expect(models[1]!.baseUrl).toBe("https://openai.vast.ai/llama-70b/v1");
	});

	test("encodes special characters in endpoint names", () => {
		const [model] = endpointsToModels(["my endpoint"]);
		expect(model!.baseUrl).toBe("https://openai.vast.ai/my%20endpoint/v1");
	});
});

// =============================================================================
// Unit: API key resolution (no key values printed anywhere)
// =============================================================================

describe("resolveVastApiKey", () => {
	const savedHome = process.env.HOME;

	test("env wins over file", () => {
		process.env.VAST_API_KEY = "env-key-value";
		expect(resolveVastApiKey()).toBe("env-key-value");
	});

	test("file fallback", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "vast-test-"));
		mkdirSync(join(fakeHome, ".config/vastai"), { recursive: true });
		writeFileSync(join(fakeHome, ".config/vastai/vast_api_key"), "file-key-value\n");
		process.env.HOME = fakeHome;
		delete process.env.VAST_API_KEY;
		expect(resolveVastApiKey()).toBe("file-key-value");
		process.env.HOME = savedHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	test("undefined when neither source exists", () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "vast-test-"));
		process.env.HOME = fakeHome;
		delete process.env.VAST_API_KEY;
		expect(resolveVastApiKey()).toBeUndefined();
		process.env.HOME = savedHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});
});

// =============================================================================
// Integration: console API discovery against a local mock
// =============================================================================

function startMockConsole(payload: unknown, status = 200): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(payload));
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
		});
	});
}

describe("fetchVastEndpoints", () => {
	test("returns endpoint names from a successful console response", async () => {
		const { server, port } = await startMockConsole({
			success: true,
			results: [{ endpoint_name: "qwen-coder" }, { endpoint_name: "llama-70b" }],
		});
		const names = await fetchVastEndpoints("test-key", { consoleUrl: `http://127.0.0.1:${port}` });
		expect(names).toEqual(["qwen-coder", "llama-70b"]);
		server.close();
	});

	test("fails closed on HTTP errors and unsuccessful payloads", async () => {
		const bad = await startMockConsole({ error: "unauthorized" }, 401);
		expect(await fetchVastEndpoints("test-key", { consoleUrl: `http://127.0.0.1:${bad.port}` })).toEqual([]);
		bad.server.close();

		const failed = await startMockConsole({ success: false, results: [{ endpoint_name: "x" }] });
		expect(await fetchVastEndpoints("test-key", { consoleUrl: `http://127.0.0.1:${failed.port}` })).toEqual([]);
		failed.server.close();
	});

	test("sends the credentials the console API expects (bearer header + api_key body)", async () => {
		const seen: { auth?: string; body?: string } = {};
		const server = await new Promise<{ server: Server; port: number }>((resolve) => {
			const s = createServer((req, res) => {
				seen.auth = req.headers.authorization;
				let body = "";
				req.on("data", (c) => (body += c));
				req.on("end", () => {
					seen.body = body;
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ success: true, results: [] }));
				});
			});
			s.listen(0, "127.0.0.1", () => {
				const addr = s.address();
				resolve({ server: s, port: typeof addr === "object" && addr ? addr.port : 0 });
			});
		});
		await fetchVastEndpoints("test-key", { consoleUrl: `http://127.0.0.1:${server.port}` });
		expect(seen.auth).toBe("Bearer test-key");
		let parsedBody: { client_id?: string; api_key?: string } = {};
		try {
			parsedBody = JSON.parse(seen.body ?? "{}") as { client_id?: string; api_key?: string };
		} catch {
			// leave empty; the client_id/api_key assertions below will fail and report it
		}
		expect(parsedBody.client_id).toBe("me");
		expect(parsedBody.api_key).toBe("test-key");
		server.server.close();
	});
});

// =============================================================================
// End-to-end: streaming through the built-in openai-completions API with a
// per-model baseUrl — the exact delegation path the provider relies on.
// =============================================================================

describe("streamSimple delegation via per-model baseUrl", () => {
	test("streams a chat completion from a mock OpenAI SSE server", async () => {
		// Mock SSE server serving POST /v1/chat/completions
		const chunks = [
			{ id: "c1", object: "chat.completion.chunk", created: 1, model: "", choices: [{ index: 0, delta: { role: "assistant", content: "Hello " } }] },
			{ id: "c1", object: "chat.completion.chunk", created: 1, model: "", choices: [{ index: 0, delta: { content: "vast" } }] },
			{ id: "c1", object: "chat.completion.chunk", created: 1, model: "", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
		];
		const server = await new Promise<{ server: Server; port: number }>((resolve) => {
			const s = createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
				res.write("data: [DONE]\n\n");
				res.end();
			});
			s.listen(0, "127.0.0.1", () => {
				const addr = s.address();
				resolve({ server: s, port: typeof addr === "object" && addr ? addr.port : 0 });
			});
		});

		const { openAICompletionsApi } = await import("@earendil-works/pi-ai/compat");
		const model = {
			...endpointsToModels(["mock-endpoint"])[0]!,
			provider: "vast",
			// Point the per-model baseUrl at the mock instead of openai.vast.ai
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		} as Parameters<typeof openAICompletionsApi>[0] extends never ? never : any;

		const context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
			tools: [],
		} as any;

		const stream = openAICompletionsApi().streamSimple(model, context, { apiKey: "test-key" });
		const events: any[] = [];
		for await (const event of stream) events.push(event);

		const start = events.find((e) => e.type === "start");
		const done = events.find((e) => e.type === "done");
		const result = await stream.result();

		expect(start).toBeDefined();
		expect(done ?? events.find((e) => e.type === "error")).toBeDefined();
		// The assistant text assembled from the message result:
		const resultText = (result.content ?? [])
			.filter((b: any) => b.type === "text")
			.map((b: any) => b.text)
			.join("");
		expect(resultText).toContain("vast");
		expect(result.stopReason).toBe("stop");
		server.server.close();
	});
});