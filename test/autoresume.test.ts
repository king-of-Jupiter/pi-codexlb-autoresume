import { test } from "node:test";
import assert from "node:assert/strict";
import {
	completeAutoresumeArgs,
	decideOnPoll,
	errorTextFromEvent,
	formatPct,
	isRetryableStatus,
	isRetryableText,
	pruneAttempts,
	retryAllowed,
	snapshotFromSubscription,
	validatePatch,
	worstRemaining,
	DEFAULTS,
	RETRY_WINDOW_MS,
} from "../src/autoresume.ts";

const CFG = { pausePct: 10, resumePct: 30 };

test("decideOnPoll: pause on crossing below, strict boundary", () => {
	assert.equal(decideOnPoll("normal", 0.09, CFG), "pause");
	assert.equal(decideOnPoll("normal", 0.0, CFG), "pause");
	assert.equal(decideOnPoll("normal", 0.10, CFG), null); // exactly at the line: no trip
	assert.equal(decideOnPoll("normal", 0.5, CFG), null);
	assert.equal(decideOnPoll("normal", null, CFG), null);
});

test("decideOnPoll: resume on crossing above, hysteresis holds between lines", () => {
	assert.equal(decideOnPoll("paused", 0.31, CFG), "resume");
	assert.equal(decideOnPoll("paused", 0.30, CFG), null); // exactly at the line: no trip
	assert.equal(decideOnPoll("paused", 0.2, CFG), null); // between lines: hold
	assert.equal(decideOnPoll("paused", 0.05, CFG), null);
	assert.equal(decideOnPoll("paused", null, CFG), null);
});

test("decideOnPoll: no cross-talk between states", () => {
	assert.equal(decideOnPoll("normal", 0.99, CFG), null);
	assert.equal(decideOnPoll("paused", 0.0, CFG), null);
});

test("worstRemaining respects the watch scope", () => {
	const snap = { remaining5h: 0.05, remaining7d: 0.8, fetchedAt: 0 };
	assert.equal(worstRemaining(snap, "any"), 0.05);
	assert.equal(worstRemaining(snap, "5h"), 0.05);
	assert.equal(worstRemaining(snap, "7d"), 0.8);
	assert.equal(worstRemaining({ remaining5h: null, remaining7d: null, fetchedAt: 0 }, "any"), null);
	assert.equal(worstRemaining({ remaining5h: null, remaining7d: 0.8, fetchedAt: 0 }, "any"), 0.8);
	assert.equal(worstRemaining({ remaining5h: null, remaining7d: 0.8, fetchedAt: 0 }, "5h"), null);
});

test("snapshotFromSubscription folds model-filtered labels and takes the min", () => {
	const sub: any = {
		windows: [
			{ label: "5h", used: 0.9 },
			{ label: "5h·opus", used: 0.97 },
			{ label: "7d", used: 0.2 },
		],
	};
	const snap = snapshotFromSubscription(sub, 123);
	assert.equal(snap.remaining5h, 1 - 0.97);
	assert.equal(snap.remaining7d, 0.8);
	assert.equal(snap.fetchedAt, 123);
});

test("snapshotFromSubscription: missing windows become null", () => {
	const snap = snapshotFromSubscription({ windows: [{ label: "credits", used: 0.5 }] } as any, 0);
	assert.equal(snap.remaining5h, null);
	assert.equal(snap.remaining7d, null);
});

test("retryAllowed: fresh ok, cooldown blocks, budget exhausts, window prunes", () => {
	const cfg = { retryCooldownSec: 120, retryMax: 3 };
	const t = 1_000_000_000;
	assert.deepEqual(retryAllowed([], t, cfg), { ok: true });
	// One recent attempt → cooldown.
	const one = retryAllowed([t - 10_000], t, cfg);
	assert.equal(one.ok, false);
	assert.equal(one.reason, "cooldown");
	assert.ok((one.retryInSec ?? 0) > 100);
	// Old attempt outside the window → pruned, ok again.
	assert.deepEqual(retryAllowed([t - RETRY_WINDOW_MS - 1000], t, cfg), { ok: true });
	// Three live attempts → exhausted.
	assert.deepEqual(retryAllowed([t - 1000, t - 2000, t - 3000], t, cfg), { ok: false, reason: "exhausted" });
	// Mixed: only live ones count.
	assert.deepEqual(retryAllowed([t - RETRY_WINDOW_MS - 1, t - 1000, t - 2000, t - 3000], t, cfg), { ok: false, reason: "exhausted" });
});

test("retryAllowed: retryMax 0 disables", () => {
	assert.deepEqual(retryAllowed([], 1000, { retryCooldownSec: 0, retryMax: 0 }), { ok: false, reason: "exhausted" });
});

test("pruneAttempts keeps only the rolling window", () => {
	const t = 5_000_000;
	assert.deepEqual(pruneAttempts([t - RETRY_WINDOW_MS + 1, t - RETRY_WINDOW_MS - 1], t), [t - RETRY_WINDOW_MS + 1]);
});

test("isRetryableStatus: 429 and 5xx only", () => {
	assert.equal(isRetryableStatus(429), true);
	assert.equal(isRetryableStatus(500), true);
	assert.equal(isRetryableStatus(503), true);
	assert.equal(isRetryableStatus(200), false);
	assert.equal(isRetryableStatus(400), false);
	assert.equal(isRetryableStatus(401), false);
	assert.equal(isRetryableStatus(403), false);
	assert.equal(isRetryableStatus(undefined), false);
	assert.equal(isRetryableStatus("429"), false);
});

test("isRetryableText matches quota/overload wording", () => {
	assert.equal(isRetryableText("Rate limit exceeded, retry later"), true);
	assert.equal(isRetryableText("server overloaded, please try again"), true);
	assert.equal(isRetryableText("HTTP 503 from provider"), true);
	assert.equal(isRetryableText("done"), false);
	assert.equal(isRetryableText(""), false);
	assert.equal(isRetryableText(undefined), false);
	assert.equal(isRetryableText(42), false);
});

test("errorTextFromEvent digs out nested messages without throwing", () => {
	assert.match(errorTextFromEvent({ outcome: { kind: "failed", error: { message: "rate limited" } } }), /rate limited/);
	assert.match(errorTextFromEvent({ kind: "failed", reason: "overloaded" }), /overloaded/);
	assert.equal(errorTextFromEvent(null), "");
	assert.equal(errorTextFromEvent("junk"), "");
	assert.equal(errorTextFromEvent({ outcome: { kind: "completed" } }), "");
});

test("validatePatch accepts good values and guards hysteresis", () => {
	assert.deepEqual(validatePatch({ pausePct: 5 }, DEFAULTS), { ok: true });
	assert.deepEqual(validatePatch({ resumePct: 50 }, DEFAULTS), { ok: true });
	const badOrder = validatePatch({ resumePct: 5 }, DEFAULTS);
	assert.equal(badOrder.ok, false);
	assert.match(badOrder.error!, /above pause/);
	const badOrder2 = validatePatch({ pausePct: 40 }, DEFAULTS);
	assert.equal(badOrder2.ok, false);
	assert.deepEqual(validatePatch({ pausePct: 0 }, DEFAULTS).ok, false);
	assert.deepEqual(validatePatch({ pollMs: 1000 }, DEFAULTS).ok, false);
	assert.deepEqual(validatePatch({ pollMs: 15000 }, DEFAULTS), { ok: true });
	assert.deepEqual(validatePatch({ watch: "nope" } as any, DEFAULTS).ok, false);
	assert.deepEqual(validatePatch({ watch: "5h" }, DEFAULTS), { ok: true });
	assert.deepEqual(validatePatch({ retryMax: -1 }, DEFAULTS).ok, false);
	assert.deepEqual(validatePatch({ retryCooldownSec: -5 }, DEFAULTS).ok, false);
});

test("formatPct renders fractions and unknowns", () => {
	assert.equal(formatPct(0.095), "10%");
	assert.equal(formatPct(null), "n/a");
});

test("completeAutoresumeArgs: empty prefix lists all subcommands", () => {
	const all = completeAutoresumeArgs("");
	assert.ok(all && all.length > 10);
	assert.ok(all.some((i) => i.value === "status" && typeof i.description === "string"));
	assert.ok(all.some((i) => i.value === "test-resume"));
});

test("completeAutoresumeArgs: filters subcommands by prefix", () => {
	const retry = completeAutoresumeArgs("retr")!.map((i) => i.value).sort();
	assert.deepEqual(retry, ["retry", "retry-cooldown", "retry-max"]);
	assert.deepEqual(completeAutoresumeArgs("tog")!.map((i) => i.value), ["toggle"]);
	assert.equal(completeAutoresumeArgs("nope"), null);
});

test("completeAutoresumeArgs: second token completes fixed vocabularies", () => {
	assert.deepEqual(completeAutoresumeArgs("watch ")!.map((i) => i.value), ["any", "5h", "7d"]);
	assert.deepEqual(completeAutoresumeArgs("watch 5")!.map((i) => i.value), ["5h"]);
	assert.deepEqual(completeAutoresumeArgs("retry o")!.map((i) => i.value), ["on", "off"]);
	assert.equal(completeAutoresumeArgs("watch x"), null);
	assert.equal(completeAutoresumeArgs("pause "), null); // free text: host fallback
	assert.equal(completeAutoresumeArgs("status "), null);
	assert.equal(completeAutoresumeArgs("a b c"), null);
});
