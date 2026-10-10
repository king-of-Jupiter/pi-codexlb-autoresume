/**
 * Persistent config for pi-codexlb-autoresume.
 *
 * pi / oh-my-pi extensions get no settings/storage API from the host, so the
 * extension keeps its own file:
 *
 *   ~/.config/pi-codexlb-autoresume/config.json   (XDG_CONFIG_HOME respected,
 *                                                  AUTORESSUME_CONFIG override)
 *
 * The codex-lb connection (URL/token) is shared with the companion
 * pi-codexlb-usage plugin when present: its file is consulted as a fallback
 * so credentials live in one place. Env vars win per-field everywhere.
 * Files are created with mode 0600; the token is never logged.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import {
	DEFAULTS,
	MIN_POLL_MS,
	type AutoresumeSettings,
	type WatchWindow,
} from "./autoresume.ts";

export interface FileConfig {
	endpointUrl?: string;
	bearerToken?: string;
	label?: string;
	enabled?: boolean;
	pausePct?: number;
	resumePct?: number;
	pollMs?: number;
	watch?: WatchWindow;
	pauseMsg?: string;
	resumeMsg?: string;
	retryOnError?: boolean;
	retryCooldownSec?: number;
	retryMax?: number;
}

export interface LoadedFile {
	values: FileConfig;
	exists: boolean;
	corrupt: boolean;
	/** Read/parse failure reason (never contains the token). */
	error?: string;
	path: string;
}

export type FieldSource = "env" | "file" | "shared" | "default" | "none";

export interface ResolvedConfig {
	url: string;
	token: string;
	label: string;
	settings: AutoresumeSettings;
	urlFrom: FieldSource;
	tokenFrom: FieldSource;
	labelFrom: FieldSource;
	/** Path of the own config file that was consulted. */
	path: string;
	/** Path of the shared pi-codexlb-usage file that was consulted. */
	sharedPath: string;
	/** Set when the own file exists but could not be read/parsed. */
	fileError?: string;
}

export function configFilePath(env: Record<string, string | undefined> = process.env): string {
	const override = (env.AUTORESSUME_CONFIG ?? "").trim();
	if (override) return override;
	const base = (env.XDG_CONFIG_HOME ?? "").trim() || join(homedir(), ".config");
	return join(base, "pi-codexlb-autoresume", "config.json");
}

export function sharedUsageFilePath(env: Record<string, string | undefined> = process.env): string {
	const override = (env.CODEXLB_CONFIG ?? "").trim();
	if (override) return override;
	const base = (env.XDG_CONFIG_HOME ?? "").trim() || join(homedir(), ".config");
	return join(base, "pi-codexlb-usage", "config.json");
}

const STRING_KEYS = ["endpointUrl", "bearerToken", "label", "watch", "pauseMsg", "resumeMsg"] as const;
const NUMBER_KEYS = ["pausePct", "resumePct", "pollMs", "retryCooldownSec", "retryMax"] as const;
const BOOL_KEYS = ["enabled", "retryOnError"] as const;

function pickKnown(json: unknown): FileConfig | null {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
	const r = json as Record<string, unknown>;
	const out: FileConfig = {};
	for (const k of STRING_KEYS) if (typeof r[k] === "string") (out as Record<string, unknown>)[k] = r[k];
	for (const k of NUMBER_KEYS) if (typeof r[k] === "number" && Number.isFinite(r[k])) (out as Record<string, unknown>)[k] = r[k];
	for (const k of BOOL_KEYS) if (typeof r[k] === "boolean") (out as Record<string, unknown>)[k] = r[k];
	return out;
}

export async function loadFileConfig(
	filePath?: string,
	env: Record<string, string | undefined> = process.env,
): Promise<LoadedFile> {
	const p = filePath ?? configFilePath(env);
	let text: string;
	try {
		text = await readFile(p, "utf8");
	} catch (e: any) {
		if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return { values: {}, exists: false, corrupt: false, path: p };
		return { values: {}, exists: true, corrupt: true, error: `cannot read config file: ${e instanceof Error ? e.message : String(e)}`, path: p };
	}
	try {
		const values = pickKnown(JSON.parse(text));
		if (!values) return { values: {}, exists: true, corrupt: true, error: "config file is not a JSON object", path: p };
		return { values, exists: true, corrupt: false, path: p };
	} catch (e) {
		return { values: {}, exists: true, corrupt: true, error: `config file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, path: p };
	}
}

/** Connection-only fields from the shared pi-codexlb-usage file (best effort, never throws). */
async function loadSharedConnection(env: Record<string, string | undefined>): Promise<{ url: string; token: string; label: string }> {
	const out = { url: "", token: "", label: "" };
	let text: string;
	try {
		text = await readFile(sharedUsageFilePath(env), "utf8");
	} catch {
		return out;
	}
	try {
		const json = JSON.parse(text) as Record<string, unknown>;
		if (typeof json.endpointUrl === "string") out.url = json.endpointUrl.trim();
		if (typeof json.bearerToken === "string") out.token = json.bearerToken.trim();
		if (typeof json.label === "string") out.label = json.label.trim();
	} catch {
		/* corrupt shared file: ignore, own config still works */
	}
	return out;
}

/** Merge patch over the stored own file (absent file = start empty). Returns the file path. */
export async function saveFileConfig(
	patch: FileConfig,
	filePath?: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	const p = filePath ?? configFilePath(env);
	const prev = await loadFileConfig(p, env);
	const next: Record<string, unknown> = {};
	const take = (key: keyof FileConfig, fallback: unknown): void => {
		const v = patch[key] !== undefined ? patch[key] : (prev.values[key] ?? fallback);
		if (typeof v === "string" ? v !== "" : v !== undefined) next[key] = v;
	};
	take("endpointUrl", "");
	take("bearerToken", "");
	take("label", "");
	take("pauseMsg", "");
	take("resumeMsg", "");
	if (patch.enabled !== undefined) next.enabled = patch.enabled;
	else if (prev.values.enabled !== undefined) next.enabled = prev.values.enabled;
	if (patch.pausePct !== undefined) next.pausePct = patch.pausePct;
	else if (prev.values.pausePct !== undefined) next.pausePct = prev.values.pausePct;
	if (patch.resumePct !== undefined) next.resumePct = patch.resumePct;
	else if (prev.values.resumePct !== undefined) next.resumePct = prev.values.resumePct;
	if (patch.pollMs !== undefined) next.pollMs = patch.pollMs;
	else if (prev.values.pollMs !== undefined) next.pollMs = prev.values.pollMs;
	if (patch.watch !== undefined) next.watch = patch.watch;
	else if (prev.values.watch !== undefined) next.watch = prev.values.watch;
	if (patch.retryOnError !== undefined) next.retryOnError = patch.retryOnError;
	else if (prev.values.retryOnError !== undefined) next.retryOnError = prev.values.retryOnError;
	if (patch.retryCooldownSec !== undefined) next.retryCooldownSec = patch.retryCooldownSec;
	else if (prev.values.retryCooldownSec !== undefined) next.retryCooldownSec = prev.values.retryCooldownSec;
	if (patch.retryMax !== undefined) next.retryMax = patch.retryMax;
	else if (prev.values.retryMax !== undefined) next.retryMax = prev.values.retryMax;
	await mkdir(dirname(p), { recursive: true, mode: 0o700 });
	await writeFile(p, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	try {
		await chmod(p, 0o600); // writeFile mode applies only on creation; enforce for existing files (best effort)
	} catch {
		/* e.g. Windows: modes are advisory */
	}
	return p;
}

function num(env: Record<string, string | undefined>, key: string): number | undefined {
	const raw = (env[key] ?? "").trim();
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function bool(env: Record<string, string | undefined>, key: string): boolean | undefined {
	const raw = (env[key] ?? "").trim().toLowerCase();
	if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
	if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
	return undefined;
}

function validWatch(v: string): v is WatchWindow {
	return v === "any" || v === "5h" || v === "7d";
}

/**
 * Normalize a user-supplied endpoint to the codex-lb usage API.
 *
 * Accepts a bare host (`codexlb.example.com`), a host with `/v1`, or the
 * full `/v1/usage` path — with or without scheme and trailing slashes.
 * Anything else (including custom reverse-proxy prefixes) passes through
 * untouched; unparseable input is returned as-is and rejected downstream
 * by the http(s) check.
 */
export function normalizeEndpointUrl(raw: string): string {
	let value = (raw ?? "").trim();
	if (!value) return "";
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return (raw ?? "").trim();
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return (raw ?? "").trim();
	const path = url.pathname.replace(/\/+$/, "");
	if (path === "") {
		url.pathname = "/v1/usage";
	} else if (/\/v1$/i.test(path)) {
		url.pathname = `${path.slice(0, -3)}/v1/usage`;
	} else if (/\/v1\/usage$/i.test(path)) {
		url.pathname = `${path.slice(0, -9)}/v1/usage`;
	} else {
		return (raw ?? "").trim();
	}
	return url.toString();
}

/** Resolve connection + settings. Env wins per-field; own file next; shared usage file for connection; defaults last. Never throws. */
export async function resolveConfig(env: Record<string, string | undefined> = process.env): Promise<ResolvedConfig> {
	const p = configFilePath(env);
	const file = await loadFileConfig(p, env);
	const shared = await loadSharedConnection(env);
	const fv = file.values;

	const envUrl = (env.CODEXLB_URL ?? env.CODEXLB_USAGE_URL ?? "").trim();
	const envToken = (env.CODEXLB_TOKEN ?? env.CODEXLB_BEARER_TOKEN ?? "").trim();
	const envLabel = (env.CODEXLB_LABEL ?? "").trim();
	const fileUrl = (fv.endpointUrl ?? "").trim();
	const fileToken = (fv.bearerToken ?? "").trim();
	const fileLabel = (fv.label ?? "").trim();
	const url = normalizeEndpointUrl(envUrl || fileUrl || shared.url);
	const token = envToken || fileToken || shared.token;
	const label = envLabel || fileLabel || shared.label || "CodexLB";

	const pickNum = (envKey: string, fileVal: number | undefined, dflt: number, min: number, max?: number): number => {
		const e = num(env, envKey);
		if (e !== undefined && e >= min && (max === undefined || e <= max)) return e;
		if (fileVal !== undefined && fileVal >= min && (max === undefined || fileVal <= max)) return fileVal;
		return dflt;
	};
	let pausePct = pickNum("AUTORESSUME_PAUSE_PCT", fv.pausePct, DEFAULTS.pausePct, 1, 99);
	let resumePct = pickNum("AUTORESSUME_RESUME_PCT", fv.resumePct, DEFAULTS.resumePct, 2, 100);
	if (resumePct <= pausePct) {
		// Invalid combination (misconfigured file/env): fall back to defaults rather than flapping.
		pausePct = DEFAULTS.pausePct;
		resumePct = DEFAULTS.resumePct;
	}
	const pollMs = Math.max(MIN_POLL_MS, pickNum("AUTORESSUME_POLL_MS", fv.pollMs, DEFAULTS.pollMs, 1));
	const envWatch = (env.AUTORESSUME_WATCH ?? "").trim();
	const watch: WatchWindow = validWatch(envWatch) ? envWatch : validWatch((fv.watch ?? "").trim()) ? (fv.watch as WatchWindow) : DEFAULTS.watch;
	const envEnabled = bool(env, "AUTORESSUME_ENABLED");
	const envRetry = bool(env, "AUTORESSUME_RETRY_ON_ERROR");
	const settings: AutoresumeSettings = {
		enabled: envEnabled ?? fv.enabled ?? DEFAULTS.enabled,
		pausePct,
		resumePct,
		pollMs,
		watch,
		pauseMsg: (env.AUTORESSUME_PAUSE_MSG ?? "").trim() || (fv.pauseMsg ?? "").trim() || DEFAULTS.pauseMsg,
		resumeMsg: (env.AUTORESSUME_RESUME_MSG ?? "").trim() || (fv.resumeMsg ?? "").trim() || DEFAULTS.resumeMsg,
		retryOnError: envRetry ?? fv.retryOnError ?? DEFAULTS.retryOnError,
		retryCooldownSec: Math.max(0, pickNum("AUTORESSUME_RETRY_COOLDOWN_SEC", fv.retryCooldownSec, DEFAULTS.retryCooldownSec, 0)),
		retryMax: Math.max(0, Math.min(100, Math.round(pickNum("AUTORESSUME_RETRY_MAX", fv.retryMax, DEFAULTS.retryMax, 0, 100)))),
	};

	return {
		url,
		token,
		label,
		settings,
		urlFrom: envUrl ? "env" : fileUrl ? "file" : shared.url ? "shared" : "none",
		tokenFrom: envToken ? "env" : fileToken ? "file" : shared.token ? "shared" : "none",
		labelFrom: envLabel ? "env" : fileLabel ? "file" : shared.label ? "shared" : "default",
		path: p,
		sharedPath: sharedUsageFilePath(env),
		...(file.corrupt && file.error ? { fileError: file.error } : {}),
	};
}

/** Masked token for status output, e.g. "••••abcd". Never reveals more than 4 chars. */
export function maskToken(token: string): string {
	if (!token) return "(missing)";
	return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}
