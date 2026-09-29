/**
 * E2E through pi's real ModelRuntime:
 *   1. registers the adapter via the same registerProvider(name, config) path
 *      pi's extension runner uses,
 *   2. refreshes with network against a mock console,
 *   3. prints available vast models (or restores from the persisted snapshot
 *      when --offline, proving --list-models would show them).
 *
 * Usage: bun run e2e.ts <mockConsoleUrl> [--offline]
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockUrl = process.argv[2];
const offline = process.argv.includes("--offline");
const storeIdx = process.argv.indexOf("--store");
const storeDir = storeIdx > -1 ? process.argv[storeIdx + 1] : undefined;
if (!mockUrl) {
  console.error("usage: bun run e2e.ts <mockConsoleUrl> [--offline]");
  process.exit(2);
}

// Import the extension source; capture the registerProvider call instead of a live pi.
const mod = await import(new URL("./index.ts", import.meta.url).href);
type CapturedConfig = import("@earendil-works/pi-coding-agent").ProviderConfig;
let captured: { name: string; config: CapturedConfig } | null = null;
const fakePi = {
  registerProvider: (name: string, config: import("@earendil-works/pi-coding-agent").ProviderConfig) => {
    captured = { name, config };
  },
};
await mod.default(fakePi);
const readCaptured = (): { name: string; config: CapturedConfig } | null => captured;
const provider = readCaptured();
if (!provider) {
  console.error("FAIL: extension never registered a provider");
  process.exit(1);
}

const agentDir = storeDir ?? mkdtempSync(join(tmpdir(), "vast-e2e-"));
const rt = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
  modelsStorePath: join(agentDir, "models-store.json"),
});
// Same call the extension runner makes (agent-session-services.js).
rt.registerProvider(provider.name, provider.config);

await rt.refresh({ allowNetwork: !offline });
const models = await rt.getAvailable("vast");
console.log(
  JSON.stringify(
    models.map((m) => ({ provider: m.provider, id: m.id, baseUrl: m.baseUrl })),
    null,
    2,
  ),
);