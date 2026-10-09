/**
 * codex-lb usage source: polls the balancer's usage endpoint (the `limits[]`
 * payload with `5h` / `7d` credit windows) over HTTPS with a Bearer token and
 * maps each entry to a quota window for the widget.
 *
 * Mapping mirrors paseocodexlbusage (`server/usage.ts`):
 * `used = current_value / max_value` (fallback `max - remaining`), reset from
 * `reset_at`, `model_filter` scopes the label. Zero runtime dependencies.
 */
import type { Window } from "../render.ts";
import type { Subscription } from "../types.ts";

/** One entry of the codex-lb usage payload (`limits[]` / `upstream_limits[]`). */
export interface CodexLbLimit {
	limit_type?: string | null;
	limit_window: string;
	max_value?: number | null;
	current_value?: number | null;
	remaining_value?: number | null;
	model_filter?: string | null;
	reset_at?: string | null;
}

export interface CodexLbConfig {
	url: string;
	token: string;
	label: string;
}

const WINDOW_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3600,
	d: 86400,
	w: 604800,
};

/** "5h" -> 18000, "7d" -> 604800. Null when the string is not a plain duration. */
export function parseWindowSeconds(window: string): number | null {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i.exec(window);
	if (!match) return null;
	const amount = Number(match[1]);
	const unit = WINDOW_SECONDS[(match[2] ?? "").toLowerCase()];
	if (!Number.isFinite(amount) || unit === undefined || amount <= 0) return null;
	return Math.round(amount * unit);
}

function coerceFinite(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** Validate one raw `limits[]` entry. Null when it is not an object with a usable `limit_window`. */
export function normalizeLimit(raw: unknown): CodexLbLimit | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.limit_window !== "string" || r.limit_window.trim() === "") return null;
	return {
		limit_window: r.limit_window,
		limit_type: typeof r.limit_type === "string" ? r.limit_type : null,
		max_value: r.max_value == null ? null : coerceFinite(r.max_value),
		current_value: r.current_value == null ? null : coerceFinite(r.current_value),
		remaining_value: r.remaining_value == null ? null : coerceFinite(r.remaining_value),
		model_filter: typeof r.model_filter === "string" && r.model_filter.trim() !== "" ? r.model_filter.trim() : null,
		reset_at: typeof r.reset_at === "string" && r.reset_at.length > 0 ? r.reset_at : null,
	};
}

/**
 * Pick the limit list from a usage payload: `limits[]` first, `upstream_limits[]`
 * as fallback. Returns null for an unexpected JSON shape, [] for a valid but empty payload.
 */
export function extractLimits(json: unknown): CodexLbLimit[] | null {
	if (typeof json !== "object" || json === null) return null;
	const r = json as Record<string, unknown>;
	const pick = (v: unknown): CodexLbLimit[] | undefined => {
		if (!Array.isArray(v) || v.length === 0) return undefined;
		const out: CodexLbLimit[] = [];
		for (const item of v) {
			const l = normalizeLimit(item);
			if (l) out.push(l);
		}
		return out.length > 0 ? out : undefined;
	};
	const limits = pick(r.limits) ?? pick(r.upstream_limits);
	if (limits) return limits;
	return Array.isArray(r.limits) || Array.isArray(r.upstream_limits) ? [] : null;
}

/** Consumed fraction 0..1+. Null when the entry carries no usable numbers (caller skips it). */
export function usedFraction(limit: CodexLbLimit): number | null {
	const max = limit.max_value;
	if (typeof limit.current_value === "number" && max != null && max > 0) return limit.current_value / max;
	if (max != null && max > 0 && typeof limit.remaining_value === "number") return (max - limit.remaining_value) / max;
	return null;
}

function resetsAtSecs(limit: CodexLbLimit): number | undefined {
	if (!limit.reset_at) return undefined;
	const ms = Date.parse(limit.reset_at);
	return Number.isFinite(ms) ? Math.round(ms / 1000) : undefined;
}

function shortScope(s: string): string {
	const id = s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	return id || "filtered";
}

/** One `limits[]` entry → one widget window. Null when the entry has no usable usage numbers. */
export function limitToWindow(limit: CodexLbLimit): Window | null {
	const used = usedFraction(limit);
	if (used == null) return null;
	const secs = parseWindowSeconds(limit.limit_window);
	const base = secs != null ? limit.limit_window.trim().toLowerCase() : limit.limit_window.trim();
	const label = limit.model_filter ? `${base}·${shortScope(limit.model_filter)}` : base;
	const w: Window = { label, used: Math.max(0, Math.min(1, used)) };
	const resetsAt = resetsAtSecs(limit);
	if (resetsAt !== undefined) w.resetsAt = resetsAt;
	if (secs != null) w.windowSecs = secs;
	return w;
}

/** Limit list → one `codexlb` subscription. Undefined when no entry has usable numbers. */
export function subscriptionFromLimits(limits: CodexLbLimit[], now: number, label = "CodexLB"): Subscription | undefined {
	const seen = new Set<string>();
	const windows: Window[] = [];
	for (const l of limits) {
		const w = limitToWindow(l);
		if (!w) continue;
		let key = w.label;
		for (let i = 2; seen.has(key); i++) key = `${w.label}_${i}`;
		seen.add(key);
		windows.push(key === w.label ? w : { ...w, label: key });
	}
	if (!windows.length) return undefined;
	return { provider: "codexlb", name: label, windows, updatedAt: now, source: "codexlb-api" };
}

/** Raw endpoint JSON → subscription. Undefined for unexpected shapes or unusable entries. */
export function parseCodexLbResponse(json: unknown, now: number, label = "CodexLB"): Subscription | undefined {
	const limits = extractLimits(json);
	if (!limits) return undefined;
	return subscriptionFromLimits(limits, now, label);
}

// ---- fetching ----

/** Minimal fetch surface (the global fetch satisfies it; tests inject a stub). */
export type FetchFn = (
	url: string,
	init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

export interface FetchOptions {
	label?: string;
	fetchFn?: FetchFn;
}

export interface CodexLbFetchResult {
	subscription?: Subscription;
	/** Human-readable failure reason (never contains the token). */
	error?: string;
	authFailed?: boolean;
}

export function isHttpUrl(value: string): boolean {
	try {
		const u = new URL(value);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

export async function fetchCodexLbUsage(
	endpointUrl: string,
	bearerToken: string,
	now: number,
	opts: FetchOptions = {},
): Promise<CodexLbFetchResult> {
	const url = endpointUrl.trim();
	const token = bearerToken.trim();
	const label = (opts.label ?? "").trim() || "CodexLB";
	if (!url) return { error: "CodexLB URL is not configured. Set CODEXLB_URL and CODEXLB_TOKEN." };
	if (!isHttpUrl(url)) return { error: "CodexLB URL must be an absolute http(s) URL." };
	if (!token) return { error: "CodexLB token is not configured. Set CODEXLB_TOKEN." };

	const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
	let res: { status: number; ok: boolean; json(): Promise<unknown> };
	try {
		res = await fetchFn(url, {
			signal: AbortSignal.timeout(15_000),
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		});
	} catch (e) {
		return { error: `CodexLB request failed: ${e instanceof Error ? e.message : String(e)}` };
	}

	if (res.status === 401 || res.status === 403) {
		return { error: `CodexLB rejected the token (HTTP ${res.status}).`, authFailed: true };
	}
	if (!res.ok) return { error: `CodexLB endpoint returned HTTP ${res.status}.` };

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		return { error: "CodexLB endpoint returned invalid JSON." };
	}

	const limits = extractLimits(json);
	if (limits === null) return { error: "CodexLB endpoint returned an unexpected JSON shape." };
	if (limits.length === 0) return { error: "CodexLB endpoint returned no limits[] entries to display." };
	const subscription = subscriptionFromLimits(limits, now, label);
	if (!subscription) return { error: "CodexLB limits[] entries have no usable usage numbers." };
	return { subscription };
}

// ---- env config ----

export function readCodexLbConfig(env: Record<string, string | undefined> = process.env): CodexLbConfig {
	const url = (env.CODEXLB_URL ?? env.CODEXLB_USAGE_URL ?? "").trim();
	const token = (env.CODEXLB_TOKEN ?? env.CODEXLB_BEARER_TOKEN ?? "").trim();
	const label = (env.CODEXLB_LABEL ?? "").trim() || "CodexLB";
	return { url, token, label };
}

export function pollIntervalMs(env: Record<string, string | undefined> = process.env, dflt = 5 * 60_000): number {
	const n = Number(env.CODEXLB_POLL_MS);
	if (!Number.isFinite(n) || n <= 0) return dflt;
	return Math.max(60_000, Math.round(n));
}

/** Host part of the endpoint for status output. Never includes credentials. */
export function endpointHost(url: string): string {
	try {
		return new URL(url).host || "(invalid url)";
	} catch {
		return "(invalid url)";
	}
}
