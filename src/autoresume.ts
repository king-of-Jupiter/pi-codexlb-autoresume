/**
 * Auto-pause / auto-continue core: pure logic, no host calls.
 *
 * Thresholds are expressed as REMAINING percent (0..100): the pause line
 * trips when `remaining < pausePct`, the resume line when
 * `remaining > resumePct`. `resumePct` must stay above `pausePct`
 * (hysteresis), otherwise the agent would flap between the two messages.
 */
import type { Subscription } from "./sources/codexlb.ts";

export type WatchWindow = "any" | "5h" | "7d";

export interface AutoresumeSettings {
	enabled: boolean;
	/** Pause when remaining % drops strictly below this. */
	pausePct: number;
	/** Resume when remaining % rises strictly above this. Must exceed pausePct. */
	resumePct: number;
	/** Poll interval, ms. Enforced minimum below. */
	pollMs: number;
	watch: WatchWindow;
	pauseMsg: string;
	resumeMsg: string;
	retryOnError: boolean;
	/** Minimum seconds between instant retry-on-error continuations. */
	retryCooldownSec: number;
	/** Max retry-on-error continuations per RETRY_WINDOW_MS. */
	retryMax: number;
}

export const MIN_POLL_MS = 15_000;
export const MIN_POLL_GAP_MS = 30_000;
export const RETRY_WINDOW_MS = 30 * 60_000;

export const DEFAULT_PAUSE_MSG =
	"У тебя закончились лимиты (Codex LB). Срочно сохрани промежуточный результат: что сделано, что осталось, какие файлы изменены. Затем остановись и жди моего сообщения — ничего не продолжай сам.";

export const DEFAULT_RESUME_MSG = "Лимиты восстановлены. Продолжи с места остановки.";

export const DEFAULTS: AutoresumeSettings = {
	enabled: true,
	pausePct: 10,
	resumePct: 30,
	pollMs: 60_000,
	watch: "any",
	pauseMsg: DEFAULT_PAUSE_MSG,
	resumeMsg: DEFAULT_RESUME_MSG,
	retryOnError: false,
	retryCooldownSec: 120,
	retryMax: 3,
};

export type MonitorState = "normal" | "paused";

export interface LimitsSnapshot {
	/** Remaining fraction 0..1, null when the window was not reported. */
	remaining5h: number | null;
	remaining7d: number | null;
	fetchedAt: number;
}

function minRemaining(windows: { label: string; used: number }[], prefix: string): number | null {
	let best: number | null = null;
	for (const w of windows) {
		if (!w.label.toLowerCase().startsWith(prefix)) continue;
		const remaining = 1 - Math.max(0, Math.min(1, w.used));
		if (best === null || remaining < best) best = remaining;
	}
	return best;
}

/** Subscription windows → remaining per period. Model-filtered labels (`5h·opus`) fold into their base. */
export function snapshotFromSubscription(sub: Subscription, now: number): LimitsSnapshot {
	return {
		remaining5h: minRemaining(sub.windows, "5h"),
		remaining7d: minRemaining(sub.windows, "7d"),
		fetchedAt: now,
	};
}

/** Worst remaining fraction for the watched scope, null when nothing watched was reported. */
export function worstRemaining(snap: LimitsSnapshot, watch: WatchWindow): number | null {
	const vals: number[] = [];
	if ((watch === "any" || watch === "5h") && snap.remaining5h !== null) vals.push(snap.remaining5h);
	if ((watch === "any" || watch === "7d") && snap.remaining7d !== null) vals.push(snap.remaining7d);
	if (!vals.length) return null;
	return Math.min(...vals);
}

export type PollDecision = "pause" | "resume" | null;

/**
 * Hysteresis decision for a fresh remaining reading.
 * `remaining` is a fraction 0..1; null (no data) never decides.
 */
export function decideOnPoll(state: MonitorState, remaining: number | null, cfg: Pick<AutoresumeSettings, "pausePct" | "resumePct">): PollDecision {
	if (remaining === null) return null;
	if (state === "normal" && remaining < cfg.pausePct / 100) return "pause";
	if (state === "paused" && remaining > cfg.resumePct / 100) return "resume";
	return null;
}

// ---- retry-on-error budget ----

/** Drop attempts outside the rolling window. Mutates nothing; returns a new array. */
export function pruneAttempts(attempts: number[], now: number): number[] {
	return attempts.filter((t) => now - t < RETRY_WINDOW_MS);
}

export interface RetryVerdict {
	ok: boolean;
	/** Machine-readable reason when rejected: "cooldown" | "exhausted". */
	reason?: string;
	/** Seconds until a retry would be allowed (cooldown case). */
	retryInSec?: number;
}

export function retryAllowed(
	attempts: number[],
	now: number,
	cfg: Pick<AutoresumeSettings, "retryCooldownSec" | "retryMax">,
): RetryVerdict {
	const live = pruneAttempts(attempts, now);
	if (live.length >= Math.max(0, cfg.retryMax)) return { ok: false, reason: "exhausted" };
	const last = live.length ? live[live.length - 1]! : null;
	if (last !== null) {
		const waitMs = Math.max(0, cfg.retryCooldownSec) * 1000 - (now - last);
		if (waitMs > 0) return { ok: false, reason: "cooldown", retryInSec: Math.ceil(waitMs / 1000) };
	}
	return { ok: true };
}

// ---- provider error classification ----

/** Retryable HTTP statuses from after_provider_response: rate-limited or server-side. */
export function isRetryableStatus(status: unknown): boolean {
	return status === 429 || (typeof status === "number" && Number.isInteger(status) && status >= 500 && status < 600);
}

const RETRYABLE_TEXT =
	/rate.?limit|too many requests|429|overloaded|capacity|temporarily unavailable|try again|quota|throttl|529|503/i;

/** Best-effort text match for quota/overload failures (turn_end payloads vary by host). */
export function isRetryableText(text: unknown): boolean {
	return typeof text === "string" && text.length > 0 && text.length < 10_000 && RETRYABLE_TEXT.test(text);
}

/** Collect plausible error strings from an unknown turn_end payload without throwing. */
export function errorTextFromEvent(event: unknown): string {
	if (typeof event !== "object" || event === null) return "";
	const parts: string[] = [];
	const walk = (v: unknown, depth: number): void => {
		if (depth > 3 || parts.join(" ").length > 4000) return;
		if (typeof v === "string") {
			if (v.length > 0 && v.length < 2000) parts.push(v);
			return;
		}
		if (typeof v !== "object" || v === null) return;
		// "kind" carries status enums ("completed"/"failed") — not error wording.
		for (const [k, item] of Object.entries(v)) if (k !== "kind") walk(item, depth + 1);
	};
	walk(event, 0);
	return parts.join(" ");
}

// ---- validation for /autoresume setters ----

export interface PatchCheck {
	ok: boolean;
	error?: string;
}

/** Validate a partial settings patch against the effective config. Pure; caller persists. */
export function validatePatch(patch: Partial<AutoresumeSettings>, effective: AutoresumeSettings): PatchCheck {
	const next = { ...effective, ...patch };
	if (patch.pausePct !== undefined && (!Number.isFinite(patch.pausePct) || patch.pausePct < 1 || patch.pausePct > 99)) {
		return { ok: false, error: "pause must be 1..99" };
	}
	if (patch.resumePct !== undefined && (!Number.isFinite(patch.resumePct) || patch.resumePct < 2 || patch.resumePct > 100)) {
		return { ok: false, error: "resume must be 2..100" };
	}
	if (next.resumePct <= next.pausePct) return { ok: false, error: `resume (${next.resumePct}%) must stay above pause (${next.pausePct}%)` };
	if (patch.pollMs !== undefined && (!Number.isFinite(patch.pollMs) || patch.pollMs < MIN_POLL_MS)) {
		return { ok: false, error: `poll interval must be >= ${MIN_POLL_MS / 1000}s` };
	}
	if (patch.watch !== undefined && patch.watch !== "any" && patch.watch !== "5h" && patch.watch !== "7d") {
		return { ok: false, error: "watch must be any, 5h or 7d" };
	}
	if (patch.retryCooldownSec !== undefined && (!Number.isFinite(patch.retryCooldownSec) || patch.retryCooldownSec < 0)) {
		return { ok: false, error: "retry-cooldown must be >= 0" };
	}
	if (
		patch.retryMax !== undefined &&
		(!Number.isFinite(patch.retryMax) || !Number.isInteger(patch.retryMax) || patch.retryMax < 0 || patch.retryMax > 100)
	) {
		return { ok: false, error: "retry-max must be an integer 0..100" };
	}
	return { ok: true };
}

export function formatPct(fraction: number | null): string {
	return fraction === null ? "n/a" : `${Math.round(fraction * 100)}%`;
}

// ---- /autoresume argument completions (host Tab completion) ----

export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

interface SubcommandDef {
	name: string;
	description: string;
	/** Fixed value vocabulary for the second token; absent = free text (no completion). */
	values?: string[];
}

export const AUTORESSUME_SUBCOMMANDS: SubcommandDef[] = [
	{ name: "status", description: "Thresholds, state, poll freshness, retry budget" },
	{ name: "toggle", description: "Arm/disarm auto-pause" },
	{ name: "pause", description: "Pause line, remaining % (e.g. 10)" },
	{ name: "resume", description: "Resume line, remaining % (e.g. 30)" },
	{ name: "poll", description: "Poll interval in seconds (min 15)" },
	{ name: "watch", description: "Windows to watch", values: ["any", "5h", "7d"] },
	{ name: "retry", description: "Instant retry-on-error", values: ["on", "off"] },
	{ name: "retry-cooldown", description: "Cooldown between auto-continues (sec)" },
	{ name: "retry-max", description: "Retry budget per 30 min window" },
	{ name: "msg-pause", description: "Custom pause text" },
	{ name: "msg-resume", description: "Custom resume text" },
	{ name: "set-url", description: "Save endpoint and poll now" },
	{ name: "set-token", description: "Save token (0600) and poll now" },
	{ name: "config", description: "Config files, field sources, masked token" },
	{ name: "test-pause", description: "Send pause text without changing state" },
	{ name: "test-resume", description: "Send resume text without changing state" },
	{ name: "help", description: "Show command help" },
];

/**
 * Complete `/autoresume` arguments for host Tab completion.
 * First token: subcommand names filtered by prefix. Second token: fixed
 * values of an exactly-typed subcommand. Anything else: null (host fallback).
 */
export function completeAutoresumeArgs(argumentPrefix: string): CompletionItem[] | null {
	const parts = argumentPrefix.split(/\s+/);
	const first = parts[0] ?? "";
	if (parts.length <= 1) {
		const matches = AUTORESSUME_SUBCOMMANDS.filter((s) => s.name.startsWith(first));
		return matches.length
			? matches.map((s) => ({ value: s.name, label: s.name, description: s.description }))
			: null;
	}
	if (parts.length === 2) {
		const sub = AUTORESSUME_SUBCOMMANDS.find((s) => s.name === first);
		if (!sub?.values) return null;
		const second = parts[1] ?? "";
		const matches = sub.values.filter((v) => v.startsWith(second));
		return matches.length ? matches.map((v) => ({ value: v, label: v })) : null;
	}
	return null;
}
