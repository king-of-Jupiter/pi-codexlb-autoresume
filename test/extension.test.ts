import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext from "../src/extension.ts";

const URL = "https://lb.example.com/v1/usage";

// ---- clock control (the extension reads Date.now for throttle/cooldown) ----
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
beforeEach(() => { clockOffset = 0; });
const advance = (sec: number) => { clockOffset += sec * 1000; };

/** Fake host: records handlers, commands, notifications, injected messages. */
function fakeHost(opts: { withSend?: boolean } = {}) {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, Function> = {};
	const defs: Record<string, any> = {};
	const notes: { msg: string; level?: string }[] = [];
	const sent: { text: string; opts?: unknown }[] = [];
	const ctx: any = {
		hasUI: true,
		model: { provider: "openai-codex", id: "gpt-5" },
		ui: {
			notify: (m: string, level?: string) => notes.push({ msg: m, level }),
		},
	};
	const api: any = {
		on: (e: string, h: Function) => (handlers[e] ??= []).push(h),
		registerCommand: (n: string, d: any) => { commands[n] = d.handler; defs[n] = d; },
	};
	if (opts.withSend !== false) {
		api.sendUserMessage = (text: string, o?: unknown) => { sent.push({ text, opts: o }); };
	}
	ext(api as any);
	const fire = async (e: string, ev: any) => { for (const h of handlers[e] ?? []) await h(ev, ctx); };
	return { fire, commands, defs, notes, sent, ctx };
}

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
	const saved: Record<string, string | undefined> = {};
	for (const k of Object.keys(env)) {
		saved[k] = process.env[k];
		if (env[k] === undefined) delete process.env[k];
		else process.env[k] = env[k];
	}
	return fn().finally(() => {
		for (const k of Object.keys(env)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});
}

function mockFetch(get: () => { json: unknown; status?: number }) {
	const orig = globalThis.fetch;
	let seenAuth: string | undefined;
	let seenUrl: string | undefined;
	let calls = 0;
	globalThis.fetch = (async (u: any, init: any) => {
		calls++;
		seenUrl = String(u);
		seenAuth = init?.headers?.Authorization;
		const { json, status = 200 } = get();
		return { status, ok: status >= 200 && status < 300, json: async () => json };
	}) as any;
	return { restore: () => { globalThis.fetch = orig; }, seenAuth: () => seenAuth, seenUrl: () => seenUrl, calls: () => calls };
}

const usage = (used5h: number, used7d = 0.1) => ({
	limits: [
		{ limit_window: "5h", max_value: 100, current_value: used5h * 100 },
		{ limit_window: "7d", max_value: 100, current_value: used7d * 100 },
	],
});
const EXHAUSTED = () => usage(0.95);
const HEALTHY = () => usage(0.2);

const BASE_ENV = { CODEXLB_URL: URL, CODEXLB_TOKEN: "tok-123" };

test("session_start polls with Bearer token and stays silent when healthy", async () => {
	await withEnv(BASE_ENV, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", { reason: "startup" });
			assert.equal(f.seenAuth(), "Bearer tok-123");
			assert.equal(h.sent.length, 0);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("fresh session with exhausted limits stays silent; pause goes out once work starts", async () => {
	await withEnv(BASE_ENV, async () => {
		const f = mockFetch(() => ({ json: EXHAUSTED() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			assert.equal(h.sent.length, 0); // nothing in-flight to checkpoint
			assert.match(h.notes.at(-1)!.msg, /limits exhausted/);
			assert.equal(h.notes.at(-1)!.level, "warning");
			// First turn activity: now there is something to hold off.
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0]!.text, /закончились лимиты/);
			assert.deepEqual(h.sent[0]!.opts, { attribution: "agent", deliverAs: "steer" });
			// Second observation of the same exhaustion: no duplicate.
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 1);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("resume fires once when credit refills past the resume line", async () => {
	await withEnv(BASE_ENV, async () => {
		let payload: unknown = EXHAUSTED();
		const f = mockFetch(() => ({ json: payload }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			assert.equal(h.sent.length, 0); // silent fresh-session pause
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 1); // pause announced once work exists
			payload = HEALTHY();
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 2);
			assert.match(h.sent[1]!.text, /Продолжи с места остановки/);
			assert.deepEqual(h.sent[1]!.opts, { attribution: "agent" });
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("refill after a silent fresh-session pause notifies the human only", async () => {
	await withEnv(BASE_ENV, async () => {
		let payload: unknown = EXHAUSTED();
		const f = mockFetch(() => ({ json: payload }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			assert.equal(h.sent.length, 0);
			payload = HEALTHY();
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 0); // nothing was announced, nothing to continue
			assert.match(h.notes.at(-1)!.msg, /refilled, session was never held/);
			await h.commands.autoresume("status", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /state=normal/);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("hysteresis: mid-band readings change nothing", async () => {
	await withEnv(BASE_ENV, async () => {
		let payload: unknown = EXHAUSTED();
		const f = mockFetch(() => ({ json: payload }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			assert.equal(h.sent.length, 0); // silent fresh-session pause
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 1); // pause at 5% remaining
			payload = usage(0.8); // 20% remaining: above pause, below resume
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 1);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("retry-on-error is off by default: provider 429 alone sends nothing", async () => {
	await withEnv(BASE_ENV, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.fire("after_provider_response", { status: 429, headers: {} });
			assert.equal(h.sent.length, 0);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("retry-on-error: 429 with healthy API continues instantly", async () => {
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			const callsBefore = f.calls();
			await h.fire("after_provider_response", { status: 429, headers: {} });
			assert.ok(f.calls() > callsBefore); // fresh fetch, not throttled
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0]!.text, /Продолжи с места остановки/);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("retry-on-error: cooldown blocks the second instant retry", async () => {
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.fire("after_provider_response", { status: 503, headers: {} });
			assert.equal(h.sent.length, 1);
			await h.fire("after_provider_response", { status: 503, headers: {} });
			assert.equal(h.sent.length, 1); // cooldown
			advance(130);
			await h.fire("after_provider_response", { status: 503, headers: {} });
			assert.equal(h.sent.length, 2);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("retry-on-error: exhausted budget warns instead of sending", async () => {
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1", AUTORESSUME_RETRY_MAX: "1" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.fire("after_provider_response", { status: 429, headers: {} });
			assert.equal(h.sent.length, 1);
			advance(130);
			await h.fire("after_provider_response", { status: 429, headers: {} });
			assert.equal(h.sent.length, 1);
			assert.match(h.notes.at(-1)!.msg, /budget exhausted/);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("retry-on-error: skipped while paused; refill path owns the resume", async () => {
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1" }, async () => {
		const f = mockFetch(() => ({ json: EXHAUSTED() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			assert.equal(h.sent.length, 0); // silent fresh-session pause
			await h.fire("after_provider_response", { status: 429, headers: {} });
			assert.equal(h.sent.length, 1); // pause announced (turn activity), but no resume
			assert.match(h.sent[0]!.text, /закончились лимиты/);
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 1); // no duplicate, no resume while paused
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("retry-on-error: failed turn with quota wording continues; other failures do not", async () => {
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.fire("turn_end", { outcome: { kind: "failed", error: { message: "Rate limit hit, try again later" } } });
			assert.equal(h.sent.length, 1);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.fire("turn_end", { outcome: { kind: "failed", error: { message: "Something broke badly" } } });
			assert.equal(h.sent.length, 0);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("successful turn resets the retry budget", async () => {
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.fire("after_provider_response", { status: 429, headers: {} });
			assert.equal(h.sent.length, 1);
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } }); // clears budget
			await h.fire("after_provider_response", { status: 429, headers: {} });
			assert.equal(h.sent.length, 2); // no cooldown: budget was reset
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("non-retryable statuses never trigger instant retry", async () => {
	await withEnv({ ...BASE_ENV, AUTORESSUME_RETRY_ON_ERROR: "1" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			for (const status of [200, 400, 401, 403, 404]) {
				await h.fire("after_provider_response", { status, headers: {} });
			}
			assert.equal(h.sent.length, 0);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("without sendUserMessage the host warns instead of crashing", async () => {
	await withEnv(BASE_ENV, async () => {
		const f = mockFetch(() => ({ json: EXHAUSTED() }));
		try {
			const h = fakeHost({ withSend: false });
			await h.fire("session_start", {});
			assert.match(h.notes.at(-1)!.msg, /limits exhausted/); // silent path needs no injection
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.match(h.notes.at(-1)!.msg, /NOT delivered/);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("unconfigured session shows a setup hint and stays quiet", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoresume-ext-"));
	await withEnv({
		CODEXLB_URL: undefined, CODEXLB_USAGE_URL: undefined,
		CODEXLB_TOKEN: undefined, CODEXLB_BEARER_TOKEN: undefined,
		AUTORESSUME_CONFIG: join(dir, "cfg.json"), CODEXLB_CONFIG: join(dir, "shared.json"),
	}, async () => {
		const h = fakeHost();
		await h.fire("session_start", {});
		assert.match(h.notes.at(-1)!.msg, /not configured/);
		assert.equal(h.sent.length, 0);
		await h.commands.autoresume("", h.ctx);
		assert.equal(h.notes.at(-1)!.level, "warning");
		await h.fire("session_shutdown", {});
	});
});

test("/autoresume status shows thresholds without leaking the token", async () => {
	await withEnv({ ...BASE_ENV, CODEXLB_LABEL: "MyLB" }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.commands.autoresume("status", h.ctx);
			const msg = h.notes.at(-1)!.msg;
			assert.match(msg, /armed/);
			assert.match(msg, /pause below 10%/);
			assert.match(msg, /resume above 30%/);
			assert.match(msg, /5h=80% remaining/);
			assert.doesNotMatch(msg, /tok-123/);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("/autoresume setters validate; toggle arms/disarms", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoresume-ext-"));
	const cfg = join(dir, "cfg.json");
	await withEnv({ ...BASE_ENV, AUTORESSUME_CONFIG: cfg }, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.commands.autoresume("pause 5", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /pause line set to 5%/);
			await h.commands.autoresume("resume 4", h.ctx);
			assert.equal(h.notes.at(-1)!.level, "warning"); // must stay above pause
			await h.commands.autoresume("poll 5", h.ctx);
			assert.equal(h.notes.at(-1)!.level, "warning"); // min 15s
			await h.commands.autoresume("watch foo", h.ctx);
			assert.equal(h.notes.at(-1)!.level, "warning");
			await h.commands.autoresume("watch 5h", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /watching 5h/);
			await h.commands.autoresume("retry maybe", h.ctx);
			assert.equal(h.notes.at(-1)!.level, "warning");
			await h.commands.autoresume("retry on", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /enabled/);
			await h.commands.autoresume("status", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /pause below 5%/);
			assert.match(h.notes.at(-1)!.msg, /retry-on-error: on/);
			await h.commands.autoresume("toggle", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /disabled/);
			await h.commands.autoresume("status", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /OFF/);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("/autoresume set-url + set-token persist and poll; config masks the token", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoresume-ext-"));
	const cfg = join(dir, "cfg.json");
	await withEnv({
		CODEXLB_URL: undefined, CODEXLB_USAGE_URL: undefined,
		CODEXLB_TOKEN: undefined, CODEXLB_BEARER_TOKEN: undefined,
		AUTORESSUME_CONFIG: cfg, CODEXLB_CONFIG: join(dir, "shared.json"),
	}, async () => {
		let payload: unknown = HEALTHY();
		const f = mockFetch(() => ({ json: payload }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.commands.autoresume("set-url ://missing-scheme", h.ctx);
			assert.equal(h.notes.at(-1)!.level, "warning");
			await h.commands.autoresume(`set-url ${URL}`, h.ctx);
			assert.match(h.notes.at(-1)!.msg, /lb\.example\.com/);
			await h.commands.autoresume("set-token tok-abc-def", h.ctx);
			assert.equal(h.notes.at(-1)!.level, "info");
			payload = EXHAUSTED();
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 1); // persisted config drives the monitor
			await h.commands.autoresume("config", h.ctx);
			const msg = h.notes.at(-1)!.msg;
			assert.match(msg, /config file/);
			assert.match(msg, /••••-def/);
			assert.doesNotMatch(msg, /tok-abc-def/);
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("/autoresume set-url accepts a bare host and polls the normalized /v1/usage URL", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoresume-ext-"));
	const cfg = join(dir, "cfg.json");
	await withEnv({
		CODEXLB_URL: undefined, CODEXLB_USAGE_URL: undefined,
		CODEXLB_TOKEN: "tok-123", CODEXLB_BEARER_TOKEN: undefined,
		AUTORESSUME_CONFIG: cfg, CODEXLB_CONFIG: join(dir, "shared.json"),
	}, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.commands.autoresume("set-url codexlb.viperrr.ru", h.ctx);
			assert.equal(h.notes.at(-1)!.level, "info");
			assert.match(h.notes.at(-1)!.msg, /codexlb\.viperrr\.ru/);
			assert.equal(f.seenUrl(), "https://codexlb.viperrr.ru/v1/usage");
			const { readFile } = await import("node:fs/promises");
			const saved = JSON.parse(await readFile(cfg, "utf8"));
			assert.equal(saved.endpointUrl, "https://codexlb.viperrr.ru/v1/usage");
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("/autoresume registers Tab completions for subcommands and values", async () => {
	const h = fakeHost();
	const complete = h.defs.autoresume?.getArgumentCompletions;
	assert.equal(typeof complete, "function");
	assert.ok(complete("").length > 10);
	assert.deepEqual(complete("tog").map((i: any) => i.value), ["toggle"]);
	assert.deepEqual(complete("watch ").map((i: any) => i.value), ["any", "5h", "7d"]);
	await h.fire("session_shutdown", {});
});

test("/autoresume test-pause/test-resume deliver without changing state", async () => {
	await withEnv(BASE_ENV, async () => {
		const f = mockFetch(() => ({ json: HEALTHY() }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.commands.autoresume("test-pause", h.ctx);
			assert.match(h.sent.at(-1)!.text, /закончились лимиты/);
			await h.commands.autoresume("test-resume", h.ctx);
			assert.match(h.sent.at(-1)!.text, /Продолжи с места остановки/);
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.length, 2); // healthy: no real transitions
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});

test("/autoresume msg-pause/msg-resume update texts used for delivery", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoresume-ext-"));
	await withEnv({ ...BASE_ENV, AUTORESSUME_CONFIG: join(dir, "cfg.json") }, async () => {
		let payload: unknown = HEALTHY();
		const f = mockFetch(() => ({ json: payload }));
		try {
			const h = fakeHost();
			await h.fire("session_start", {});
			await h.commands.autoresume("msg-pause hold on, saving now", h.ctx);
			assert.match(h.notes.at(-1)!.msg, /pause message updated/);
			await h.commands.autoresume("msg-resume keep going buddy", h.ctx);
			payload = EXHAUSTED();
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.at(-1)!.text, "hold on, saving now");
			payload = HEALTHY();
			advance(61);
			await h.fire("turn_end", { outcome: { kind: "completed" } });
			assert.equal(h.sent.at(-1)!.text, "keep going buddy");
			await h.fire("session_shutdown", {});
		} finally { f.restore(); }
	});
});
