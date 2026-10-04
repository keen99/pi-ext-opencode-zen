import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Cache dir computed at import time — set env before import.
const cacheRoot = mkdtempSync(join(tmpdir(), "zen-cache-"));
process.env.XDG_CACHE_HOME = cacheRoot;
// getExtensionSetting reads ~/.pi/agent/settings-extensions.json — isolate HOME.
const fakeHome = mkdtempSync(join(tmpdir(), "zen-home-"));
process.env.HOME = fakeHome;

const zen = await import("../index.js");
const {
	getExtensionSetting,
	loadZenModelsFromCache,
	saveZenModelsToCache,
	getCompatForModel,
	getBackendFromNpmPackage,
	loadModelsFromCache,
	saveModelsToCache,
	loadFreeModelIds,
	saveFreeModelIds,
	buildModels,
	default: zenExtension,
} = zen as any;

// ── getBackendFromNpmPackage ────────────────────────────────────────────
test("backend mapping: npm packages, provider default, unknown", () => {
	assert.equal(getBackendFromNpmPackage("@ai-sdk/anthropic", undefined), "anthropic");
	assert.equal(getBackendFromNpmPackage("@ai-sdk/openai", undefined), "openai-responses");
	assert.equal(getBackendFromNpmPackage("@ai-sdk/google", undefined), "google");
	assert.equal(getBackendFromNpmPackage("@ai-sdk/openai-compatible", undefined), "openai-completions");
	assert.equal(getBackendFromNpmPackage(undefined, "@ai-sdk/anthropic"), "anthropic");
	assert.equal(getBackendFromNpmPackage(undefined, "@ai-sdk/openai"), "openai-responses");
	assert.equal(getBackendFromNpmPackage(undefined, "@ai-sdk/google"), "google");
	assert.equal(getBackendFromNpmPackage(undefined, undefined), "openai-completions");
	assert.equal(getBackendFromNpmPackage(undefined, "weird"), "openai-completions");
});

// ── getCompatForModel ───────────────────────────────────────────────────
test("compat: openai-completions base + model-specific quirks; other backends undefined", () => {
	const base = getCompatForModel("codebuff-instruct", "openai-completions");
	assert.deepEqual(base, { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" });

	const ds = getCompatForModel("deepseek-v3", "openai-completions");
	assert.equal(ds.requiresReasoningContentOnAssistantMessages, true);

	const kimi = getCompatForModel("kimi-k2.6", "openai-completions");
	assert.equal(kimi.thinkingFormat, "deepseek");
	assert.equal(kimi.supportsReasoningEffort, false);

	const grok = getCompatForModel("grok-build-0.1", "openai-completions");
	assert.equal(grok.supportsReasoningEffort, false);

	assert.equal(getCompatForModel("anything", "anthropic"), undefined);
});

// ── buildModels ─────────────────────────────────────────────────────────
const ZEN_IDS = ["codebuff-big", "codebuff-free", "mystery-model"];
const DEV = {
	provider: { npm: "@ai-sdk/anthropic" },
	models: {
		"codebuff-big": {
			id: "codebuff-big", name: "Codebuff Big",
			cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
			limit: { context: 200000, output: 64000 },
			reasoning: true, attachment: true,
		},
		"codebuff-free": {
			id: "codebuff-free", name: "Codebuff Free",
			cost: { input: 0, output: 0 },
			limit: { context: 128000, output: 16384 },
			modalities: ["text", "image"],
		},
	},
};

test("buildModels: enrichment, defaults for unknown ids, free filter without key", () => {
	const all = buildModels(ZEN_IDS, DEV, true);
	assert.equal(all.length, 3);

	const big = all.find((m: any) => m.id === "codebuff-big");
	assert.equal(big.backend, "anthropic", "provider-level npm default");
	assert.equal(big.reasoning, true);
	assert.deepEqual(big.input, ["text", "image"], "attachment implies image");
	assert.equal(big.contextWindow, 200000);
	assert.equal(big.maxTokens, 64000);
	assert.equal(big.cost.input, 3);

	const free = all.find((m: any) => m.id === "codebuff-free");
	assert.equal(free.backend, "anthropic", "no npm → provider-level default (anthropic)");
	assert.deepEqual(free.input, ["text", "image"], "modalities image implies image input");

	const mystery = all.find((m: any) => m.id === "mystery-model");
	assert.equal(mystery.contextWindow, 128000, "default context");
	assert.equal(mystery.cost.input, 0);

	const freeOnly = buildModels(ZEN_IDS, DEV, false);
	assert.deepEqual(freeOnly.map((m: any) => m.id), ["codebuff-free", "mystery-model"], "no key → free only");

	// cache written by buildModels
	assert.ok(existsSync(join(cacheRoot, "pi-ext-opencode-zen", "models.json")));
});

// ── caches ──────────────────────────────────────────────────────────────
test("cache roundtrips + validation", () => {
	saveZenModelsToCache(["a", "b"]);
	assert.deepEqual(loadZenModelsFromCache(), ["a", "b"]);
	writeFileSync(join(cacheRoot, "pi-ext-opencode-zen", "zen-models.json"), "[]");
	assert.equal(loadZenModelsFromCache(), null, "empty array → null");

	saveModelsToCache([{ id: "x", name: "X", backend: "anthropic" }]);
	assert.equal(loadModelsFromCache()!.length, 1);
	saveModelsToCache([{ name: "broken" } as any]);
	assert.equal(loadModelsFromCache(), null, "missing id → null");

	assert.deepEqual(loadFreeModelIds(), []);
	saveFreeModelIds(["f1"]);
	assert.deepEqual(loadFreeModelIds(), ["f1"]);
});

// ── getExtensionSetting ─────────────────────────────────────────────────
test("getExtensionSetting: reads settings-extensions.json, falls back cleanly", () => {
	assert.equal(getExtensionSetting("opencode-zen", "notify-free-model-changes", "on"), "on", "no file → default");
	mkdirSync(join(fakeHome, ".pi", "agent"), { recursive: true });
	writeFileSync(
		join(fakeHome, ".pi", "agent", "settings-extensions.json"),
		JSON.stringify({ "opencode-zen": { "notify-free-model-changes": "off" } }),
	);
	assert.equal(getExtensionSetting("opencode-zen", "notify-free-model-changes", "on"), "off");
	writeFileSync(join(fakeHome, ".pi", "agent", "settings-extensions.json"), "{ broken");
	assert.equal(getExtensionSetting("opencode-zen", "notify-free-model-changes", "on"), "on", "malformed → default");
});

// ── extension closure ───────────────────────────────────────────────────
function fakePi() {
	const providers: Record<string, any> = {};
	const notifies: any[] = [];
	const handlers: Record<string, any> = {};
	const pi: any = {
		events: { emit: () => {} },
		registerProvider: (name: string, cfg: any) => { providers[name] = cfg; },
		on: (ev: string, fn: any) => { handlers[ev] = fn; },
	};
	const ctx = (hasUI = false) => ({ hasUI, ui: { notify: (m: string, l: string) => notifies.push({ m, l }), setWidget: (k: string, v: any) => {} } });
	return { pi, providers, notifies, handlers, ctx };
}

function stubFetch(routes: Array<{ match: (url: string) => boolean; body: any }>) {
	const orig = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		const route = routes.find((r) => r.match(String(url)));
		if (!route) return { ok: false, status: 404 } as any;
		return { ok: true, json: async () => route.body } as any;
	}) as any;
	return orig;
}

test("cold start: fetch succeeds → provider registered, free ids saved, no key → free only", async () => {
	rmSync(join(cacheRoot, "pi-ext-opencode-zen"), { recursive: true, force: true });
	delete process.env.OPENCODE_API_KEY;
	const orig = stubFetch([
		{ match: (u) => u.includes("models.dev"), body: { opencode: DEV } },
		{ match: (u) => u.includes("/models"), body: { object: "list", data: [{ id: "codebuff-big" }, { id: "codebuff-free" }] } },
	]);
	try {
		const { pi, providers } = fakePi();
		await zenExtension(pi);
		assert.ok(providers["opencode"]);
		const ids = providers["opencode"].models.map((m: any) => m.id);
		assert.deepEqual(ids, ["codebuff-free"], "no OPENCODE_API_KEY → free only");
		assert.deepEqual(loadFreeModelIds(), ["codebuff-free"]);
	} finally {
		globalThis.fetch = orig;
	}
});

test("cold start: fetch fails → provider NOT registered", async () => {
	rmSync(join(cacheRoot, "pi-ext-opencode-zen"), { recursive: true, force: true });
	delete process.env.OPENCODE_API_KEY;
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => ({ ok: false, status: 500 })) as any;
	try {
		const { pi, providers } = fakePi();
		await zenExtension(pi);
		assert.equal(providers["opencode"], undefined);
	} finally {
		globalThis.fetch = orig;
	}
});

test("warm cache with key: paid models registered; model_select warns on gone model", async () => {
	const { pi, providers, notifies, handlers } = fakePi();
	// seed models cache with a paid model
	mkdirSync(join(cacheRoot, "pi-ext-opencode-zen"), { recursive: true });
	writeFileSync(
		join(cacheRoot, "pi-ext-opencode-zen", "models.json"),
		JSON.stringify([{ id: "paid-model", name: "Paid", backend: "openai-completions", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }]),
	);
	process.env.OPENCODE_API_KEY = "sk-test";
	try {
		const orig = stubFetch([
			{ match: (u) => u.includes("/models"), body: { object: "list", data: [{ id: "paid-model" }] } },
			{ match: (u) => u.includes("models.dev"), body: {} },
		]);
		try {
			await zenExtension(pi);
		} finally {
			globalThis.fetch = orig;
		}
		assert.ok(providers["opencode"]);
		assert.ok(providers["opencode"].models.some((m: any) => m.id === "paid-model"));

		await handlers.model_select({ model: { id: "paid-model", provider: "opencode" } }, { ui: { notify: (m: string, l: string) => notifies.push({ m, l }) } });
		assert.equal(notifies.length, 0, "known model → no warning");
		await handlers.model_select({ model: { id: "gone-model", provider: "opencode" } }, { ui: { notify: (m: string, l: string) => notifies.push({ m, l }) } });
		assert.match(notifies[0].m, /no longer available/);
	} finally {
		delete process.env.OPENCODE_API_KEY;
	}
});

test("streamOpenCodeZen: unknown model → error event with message", async () => {
	const { streamOpenCodeZen } = zen as any;
	const stream = streamOpenCodeZen({ id: "nope", api: "openai-completions", provider: "opencode" }, { messages: [] });
	let last: any;
	for await (const ev of stream) last = ev;
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /Unknown model/);
});

test("streamOpenCodeZen: paid model without key → key-required error", async () => {
	const { streamOpenCodeZen } = zen as any;
	// populate MODEL_MAP via registerModels side effect: registerModels is internal;
	// use buildModels + extension warm path? Simplest: unknown-model path covers error plumbing;
	// here use a model id that exists in MODEL_MAP after warm-cache registration above — but map
	// state is module-global; re-register via a fresh extension run.
	const { pi } = fakePi();
	writeFileSync(
		join(cacheRoot, "pi-ext-opencode-zen", "models.json"),
		JSON.stringify([{ id: "paid-model", name: "Paid", backend: "openai-completions", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }]),
	);
	process.env.OPENCODE_API_KEY = "sk-test";
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => ({ ok: false, status: 500 })) as any;
	try {
		await zenExtension(pi); // warm cache path, no fetch needed (fetch fail → background noop)
	} finally {
		globalThis.fetch = orig;
	}
	const stream = streamOpenCodeZen({ id: "paid-model", api: "openai-completions", provider: "opencode" }, { messages: [] }, {});
	let last: any;
	for await (const ev of stream) last = ev;
	assert.equal(last.type, "error");
	assert.match(last.error.errorMessage, /requires an API key/);
	delete process.env.OPENCODE_API_KEY;
});
