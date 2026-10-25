// Smoke test: load index.ts through jiti with the same aliases pi's extension
// loader uses, and verify tools/commands register against a mock ExtensionAPI.
// Run: node test/load.ts

import assert from "node:assert";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LEARNING_HARNESS_HOME = mkdtempSync(join(tmpdir(), "lh-load-"));

const piPkg = "/home/matthew/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(resolve(piPkg, "package.json"));
const { createJiti } = require("jiti");

const jiti = createJiti(import.meta.url, {
  alias: {
    typebox: require.resolve("typebox"),
    "@earendil-works/pi-coding-agent": resolve(piPkg, "index.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  },
});

const factory = await jiti.import(new URL("../index.ts", import.meta.url).pathname, { default: true });
assert.equal(typeof factory, "function", "default export must be a factory function");

const tools: string[] = [];
const handlers: Record<string, (args: string, ctx: any) => Promise<void>> = {};
const events: string[] = [];
const sent: string[] = [];
const notifies: string[] = [];
const mockPi: any = {
  on: (e: string) => events.push(e),
  registerTool: (t: { name: string }) => tools.push(t.name),
  registerCommand: (n: string, o: { handler: any }) => {
    handlers[n] = o.handler;
  },
  sendUserMessage: (m: string) => sent.push(m),
};

factory(mockPi);

assert.deepEqual(tools.sort(), ["learning_forget", "learning_record", "learning_start", "learning_status"]);
assert.deepEqual(Object.keys(handlers).sort(), ["learn", "learning"]);
assert.ok(events.includes("session_start"));

// /learn with a NEW topic should queue a kickoff user message.
await handlers["learn"]("Rust ownership", { mode: "print", ui: { notify: (m: string) => notifies.push(m) }, isIdle: () => true });
assert.equal(sent.length, 1);
assert.ok(sent[0].includes("Rust ownership"), "kickoff mentions the topic");
assert.ok(sent[0].includes("learning_start"), "kickoff instructs to call learning_start");

// /learn with no topics + no arg → usage notify.
await handlers["learn"]("", { mode: "print", ui: { notify: (m: string) => notifies.push(m) }, isIdle: () => true });
assert.ok(notifies.some((n) => n.includes("Usage: /learn")));

// /learning with no topics → friendly empty message.
await handlers["learning"]("", { mode: "print", ui: { notify: (m: string) => notifies.push(m) } });
assert.ok(notifies.some((n) => n.includes("No learning topics yet")));

console.log("tools:", tools.join(", "));
console.log("commands:", Object.keys(handlers).join(", "));
console.log("events:", events.join(", "));
console.log("✅ EXTENSION LOADS CLEANLY — 4 tools, 2 commands, session_start hook, /learn kickoff works");
