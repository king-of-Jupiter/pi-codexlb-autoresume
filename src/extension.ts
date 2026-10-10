/**
 * pi / oh-my-pi extension: auto-pause and auto-continue on codex-lb limits.
 *
 * Polls the balancer's usage endpoint (`limits[]` with 5h/7d credit windows)
 * and injects agent-attributed follow-ups into the SAME session:
 * a pause message (steer: interrupts the running turn) when remaining credit
 * drops below the pause line, and the resume message once credit refills past
 * the resume line. Optional instant retry-on-error continues the turn when the
 * provider fails but the API says limits remain.
 *
 * No widget, no /limits command — those belong to the companion
 * pi-codexlb-usage plugin. This module owns only /autoresume.
 */
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
	MIN_POLL_GAP_MS,
	type CompletionItem,
	type LimitsSnapshot,
	type MonitorState,
} from "./autoresume.ts";
import { loadFileConfig, maskToken, normalizeEndpointUrl, resolveConfig, saveFileConfig } from "./config.ts";
import { endpointHost, fetchCodexLbUsage } from "./sources/codexlb.ts";

// ---- minimal host surface (pi and omp both satisfy this) ----
interface HostCtx {
	model?: { provider?: string; id?: string };
	hasUI?: boolean;
	ui: {
		notify: (msg: string, level?: "info" | "warning" | "error") => void;
	};
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
}
interface HostAPI {
	on: (event: string, handler: (event: any, ctx: HostCtx) => unknown) => void;
	registerCommand: (
		name: string,
		def: {
			description: string;
			getArgumentCompletions?: (argumentPrefix: string) => CompletionItem[] | null;
			handler: (args: string, ctx: HostCtx) => Promise<void> | void;
		},
	) => void;
	sendUserMessage?: (content: string, opts?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside"; attribution?: "user" | "agent" }) => unknown;
}

interface Monitor {
	paused: boolean;
	/**
	 * Whether the agent itself was told about the pause. A fresh session has
	 * nothing to checkpoint, so the session_start poll records the state and
	 * notifies the human instead of messaging the agent.
	 */
	announced: boolean;
	lastSnap: LimitsSnapshot | null;
	lastPollAt: number;
	lastError: string;
	retryAttempts: number[];
	lastRetryAt: number;
	lastRetrySource: string;
}

const now = () => Math.floor(Date.now() / 1000);
const debug = (...a: unknown[]) => {
	if ((process.env.AUTORESSUME_DEBUG ?? "").trim() !== "") console.error("[codexlb-autoresume]", ...a);
};

const HELP =
	"autoresume: status | toggle | pause <pct> | resume <pct> | poll <sec> | watch <any|5h|7d> | retry <on|off> | retry-cooldown <sec> | retry-max <n> | msg-pause <text> | msg-resume <text> | set-url <url> | set-token <tok> | config | test-pause | test-resume";

export default function codexlbAutoresume(api: HostAPI): void {
	let ctx: HostCtx | undefined;
	let timer: unknown | undefined;
	let hintShown = false;
	const mon: Monitor = {
		paused: false,
		announced: false,
		lastSnap: null,
		lastPollAt: 0,
		lastError: "",
		retryAttempts: [],
		lastRetryAt: 0,
		lastRetrySource: "",
	};

	function sendPause(text: string): void {
		if (typeof api.sendUserMessage !== "function") {
			debug("sendUserMessage unavailable; pause not delivered");
			ctx?.ui.notify("autoresume: host cannot inject messages — pause NOT delivered", "warning");
			return;
		}
		debug("sending pause (steer)");
		void api.sendUserMessage(text, { attribution: "agent", deliverAs: "steer" });
	}

	function sendResume(text: string): void {
		if (typeof api.sendUserMessage !== "function") {
			debug("sendUserMessage unavailable; resume not delivered");
			ctx?.ui.notify("autoresume: host cannot inject messages — continue NOT delivered", "warning");
			return;
		}
		debug("sending resume (idle starts a turn)");
		void api.sendUserMessage(text, { attribution: "agent" });
	}

	/** Poll the endpoint and run the pause/resume state machine. Returns remaining fraction or null. */
	async function pollAndEvaluate(opts: { force?: boolean; source?: string; silent?: boolean } = {}): Promise<number | null> {
		if (!ctx) return null;
		const t = now();
		if (!opts.force && t - mon.lastPollAt < MIN_POLL_GAP_MS / 1000) {
			debug(`poll skipped (throttled, source=${opts.source ?? "?"})`);
			return mon.lastSnap ? worstRemaining(mon.lastSnap, (await resolveConfig()).settings.watch) : null;
		}
		const cfg = await resolveConfig();
		if (!cfg.settings.enabled) {
			debug("poll skipped (disabled)");
			return null;
		}
		if (!cfg.url || !cfg.token) {
			mon.lastError = "not configured — set CODEXLB_URL and CODEXLB_TOKEN";
			debug("codexlb:", mon.lastError);
			return null;
		}
		try {
			const r = await fetchCodexLbUsage(cfg.url, cfg.token, t, { label: cfg.label });
			mon.lastPollAt = t;
			if (!r.subscription) {
				mon.lastError = r.error ?? "unknown error";
				debug("poll error:", mon.lastError);
				return null;
			}
			mon.lastError = "";
			mon.lastSnap = snapshotFromSubscription(r.subscription, t);
		} catch (e) {
			mon.lastError = e instanceof Error ? e.message : String(e);
			debug("poll exception:", mon.lastError);
			return null;
		}
		const cfg2 = await resolveConfig();
		const remaining = worstRemaining(mon.lastSnap, cfg2.settings.watch);
		const state: MonitorState = mon.paused ? "paused" : "normal";
		const decision = decideOnPoll(state, remaining, cfg2.settings);
		debug(`poll (${opts.source ?? "?"}): state=${state} remaining=${remaining === null ? "n/a" : `${Math.round(remaining * 100)}%`} → ${decision ?? "none"}`);
		if (decision === "pause") {
			mon.paused = true;
			if (opts.silent || mon.announced) {
				// Fresh session (or repeat): nothing in-flight to checkpoint —
				// record the state and tell the human, not the agent.
				if (opts.silent) {
					ctx.ui.notify(
						`autoresume: limits exhausted (${formatPct(remaining)} remaining) — the agent will be told to hold off once it starts working`,
						"warning",
					);
				}
			} else {
				mon.announced = true;
				sendPause(cfg2.settings.pauseMsg);
			}
		} else if (decision === "resume") {
			mon.paused = false;
			if (mon.announced) {
				mon.announced = false;
				sendResume(cfg2.settings.resumeMsg);
			} else {
				// Pause was never announced (fresh session): nothing was stopped,
				// so there is nothing to continue — tell the human only.
				ctx.ui.notify("autoresume: limits refilled, session was never held", "info");
			}
		}
		return remaining;
	}

	/** Tell a working agent about a silently recorded pause, exactly once. */
	async function announceIfNeeded(): Promise<void> {
		// A poll may record "paused" while the agent never heard about it
		// (silent fresh-session start). Turn activity means there is now
		// something worth holding off — tell the agent exactly once.
		if (!ctx || !mon.paused || mon.announced) return;
		const cfg = await resolveConfig();
		if (!ctx || !mon.paused || mon.announced || !cfg.settings.enabled) return;
		mon.announced = true;
		sendPause(cfg.settings.pauseMsg);
	}

	/** Instant path: provider failed — continue at once if the API says limits remain. */	async function handleErrorTrigger(kind: string): Promise<void> {
		if (!ctx) return;
		const cfg = await resolveConfig();
		if (!cfg.settings.enabled || !cfg.settings.retryOnError) return;
		if (mon.paused) {
			debug(`retry skipped (session is paused; refill path owns it, kind=${kind})`);
			return;
		}
		const t = now();
		mon.retryAttempts = pruneAttempts(mon.retryAttempts, t * 1000);
		const verdict = retryAllowed(mon.retryAttempts, t * 1000, cfg.settings);
		if (!verdict.ok) {
			debug(`retry rejected (${verdict.reason}, kind=${kind})`);
			if (verdict.reason === "exhausted") {
				ctx.ui.notify("autoresume: retry budget exhausted (3 per 30 min) — continue manually", "warning");
			}
			return;
		}
		// Fresh reading, bypassing the poll throttle: the point is immediacy.
		if (!cfg.url || !cfg.token) return;
		let snap: LimitsSnapshot | null = null;
		try {
			const r = await fetchCodexLbUsage(cfg.url, cfg.token, t, { label: cfg.label });
			mon.lastPollAt = t;
			if (r.subscription) {
				mon.lastError = "";
				snap = snapshotFromSubscription(r.subscription, t);
				mon.lastSnap = snap;
			} else {
				mon.lastError = r.error ?? "unknown error";
			}
		} catch (e) {
			mon.lastError = e instanceof Error ? e.message : String(e);
		}
		if (!snap) {
			debug(`retry skipped (no API data, kind=${kind})`);
			return;
		}
		const cfg2 = await resolveConfig();
		const remaining = worstRemaining(snap, cfg2.settings.watch);
		if (remaining === null || remaining < cfg2.settings.pausePct / 100) {
			debug(`retry skipped (limits actually low, kind=${kind})`);
			// Limits really are low: run the normal path so a pause goes out if due.
			await pollAndEvaluate({ source: `retry-${kind}` });
			return;
		}
		mon.retryAttempts.push(t * 1000);
		mon.lastRetryAt = t;
		mon.lastRetrySource = kind;
		sendResume(cfg2.settings.resumeMsg);
	}

	function startTimer(pollMs: number): void {
		stopTimer();
		const set = ctx?.setInterval
			? (fn: () => void, ms: number) => ctx!.setInterval!(fn, ms)
			: (fn: () => void, ms: number) => {
					const h = setInterval(() => {
						try {
							fn();
						} catch (e) {
							debug("timer callback threw:", e instanceof Error ? e.message : String(e));
						}
					}, ms);
					(h as any).unref?.();
					return h;
				};
		timer = set(() => void pollAndEvaluate({ source: "tick" }), Math.max(pollMs, 15_000));
	}

	function stopTimer(): void {
		if (timer !== undefined) {
			if (ctx?.clearTimer) ctx.clearTimer(timer);
			else clearInterval(timer as any);
			timer = undefined;
		}
	}

	api.on("session_start", async (_e, c) => {
		ctx = c;
		hintShown = false;
		const cfg = await resolveConfig();
		startTimer(cfg.settings.pollMs);
		await pollAndEvaluate({ force: true, source: "session_start", silent: true });
		if (!hintShown && ctx.hasUI !== false && !cfg.url && !cfg.token) {
			hintShown = true;
			ctx.ui.notify(
				"CodexLB autoresume: not configured — run /autoresume set-url <url> and /autoresume set-token <token> (or set CODEXLB_URL/CODEXLB_TOKEN)",
				"info",
			);
		}
	});
	api.on("session_shutdown", () => stopTimer());

	api.on("after_provider_response", async (e, c) => {
		ctx = c;
		if (e == null || typeof e !== "object") return;
		const status = (e as Record<string, unknown>).status;
		if (isRetryableStatus(status)) {
			await handleErrorTrigger(`provider-status-${String(status)}`);
		} else {
			// Fast pause path: the turn that just burned the quota pauses without waiting for the tick.
			await pollAndEvaluate({ source: "after-response" });
		}
		await announceIfNeeded();
	});

	api.on("turn_end", async (e, c) => {
		ctx = c;
		try {
			const outcome = (e as Record<string, unknown> | null)?.outcome ?? (e as Record<string, unknown> | null);
			const kind = typeof outcome === "object" && outcome !== null ? (outcome as Record<string, unknown>).kind : undefined;
			if (kind === "completed" || kind === "idle") {
				if (mon.retryAttempts.length) {
					mon.retryAttempts = [];
					debug("retry budget reset (successful turn)");
				}
				await pollAndEvaluate({ source: "turn_end" });
				await announceIfNeeded();
				return;
			}
			if (kind === "canceled" || kind === "cancelled") return;
			// Failed (or unknown shape): look for quota/overload wording.
			const text = errorTextFromEvent(e);
			if (isRetryableText(text)) {
				await handleErrorTrigger("turn-failed");
			} else {
				await pollAndEvaluate({ source: "turn_end" });
			}
			await announceIfNeeded();
		} catch (err) {
			debug("turn_end handler:", err instanceof Error ? err.message : String(err));
		}
	});

	function statusLines(
		cfg: Awaited<ReturnType<typeof resolveConfig>>,
	): { text: string; level: "info" | "warning" } {
		const s = cfg.settings;
		const t = now();
		const lines = [
			`autoresume: ${s.enabled ? "armed" : "OFF"} — state=${mon.paused ? (mon.announced ? "PAUSED (agent notified)" : "PAUSED (silent — fresh session)") : "normal"}`,
			`thresholds: pause below ${s.pausePct}% remaining, resume above ${s.resumePct}% remaining (watch: ${s.watch})`,
			`limits: 5h=${formatPct(mon.lastSnap?.remaining5h ?? null)} remaining, 7d=${formatPct(mon.lastSnap?.remaining7d ?? null)} remaining`,
			`poll: every ${Math.round(s.pollMs / 1000)}s${mon.lastPollAt ? `, last ${Math.max(0, t - mon.lastPollAt)}s ago` : ", never"}${mon.lastError ? `, last error: ${mon.lastError}` : ""}`,
			`retry-on-error: ${s.retryOnError ? `on (${mon.retryAttempts.length}/${s.retryMax} used in 30m${mon.lastRetryAt ? `, last ${Math.max(0, t - mon.lastRetryAt)}s ago [${mon.lastRetrySource}]` : ""})` : "off"}`,
			`endpoint: ${cfg.url ? `${endpointHost(cfg.url)} (${cfg.urlFrom})` : "(missing)"} as ${cfg.label}`,
		];
		return { text: lines.join("\n"), level: s.enabled ? "info" : "warning" };
	}

	api.registerCommand("autoresume", {
		description: "CodexLB auto-pause/continue: /autoresume [status|toggle|pause|resume|poll|watch|retry|...]",
		getArgumentCompletions: completeAutoresumeArgs,
		handler: async (args, c) => {
			ctx = c;
			const trimmed = args.trim();
			const space = trimmed.indexOf(" ");
			const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
			const rest = (space === -1 ? "" : trimmed.slice(space + 1)).trim();
			const needCfg = await resolveConfig();
			const s = needCfg.settings;

			const save = async (patch: Parameters<typeof saveFileConfig>[0], note: string): Promise<void> => {
				const check = validatePatch(patch as Partial<import("./autoresume.ts").AutoresumeSettings>, s);
				if (!check.ok) return c.ui.notify(`autoresume: ${check.error}`, "warning");
				await saveFileConfig(patch);
				const fresh = await resolveConfig();
				stopTimer();
				startTimer(fresh.settings.pollMs);
				c.ui.notify(`autoresume: ${note}`, "info");
			};

			if (!cmd || cmd === "status" || cmd === "help") {
				if (!cmd && !needCfg.url && !needCfg.token) {
					return c.ui.notify(
						"autoresume: not configured — run /autoresume set-url <url> and /autoresume set-token <token> (or set CODEXLB_URL/CODEXLB_TOKEN)",
						"warning",
					);
				}
				const st = statusLines(needCfg);
				return c.ui.notify(st.text, st.level);
			}
			if (cmd === "toggle") {
				await saveFileConfig({ enabled: !s.enabled });
				return c.ui.notify(`autoresume: ${!s.enabled ? "armed" : "disabled"}`, "info");
			}
			if (cmd === "pause") {
				const n = Number(rest);
				if (!Number.isFinite(n)) return c.ui.notify("autoresume: usage: /autoresume pause <pct>  (e.g. /autoresume pause 10)", "warning");
				return save({ pausePct: n }, `pause line set to ${n}% remaining`);
			}
			if (cmd === "resume") {
				const n = Number(rest);
				if (!Number.isFinite(n)) return c.ui.notify("autoresume: usage: /autoresume resume <pct>  (e.g. /autoresume resume 30)", "warning");
				return save({ resumePct: n }, `resume line set to ${n}% remaining`);
			}
			if (cmd === "poll") {
				const n = Number(rest);
				if (!Number.isFinite(n)) return c.ui.notify("autoresume: usage: /autoresume poll <sec>  (min 15)", "warning");
				return save({ pollMs: Math.round(n * 1000) }, `poll interval set to ${Math.round(n)}s`);
			}
			if (cmd === "watch") {
				const w = rest.toLowerCase();
				if (w !== "any" && w !== "5h" && w !== "7d") return c.ui.notify("autoresume: usage: /autoresume watch <any|5h|7d>", "warning");
				return save({ watch: w }, `watching ${w}`);
			}
			if (cmd === "retry") {
				const v = rest.toLowerCase();
				if (v !== "on" && v !== "off") return c.ui.notify("autoresume: usage: /autoresume retry <on|off>", "warning");
				await saveFileConfig({ retryOnError: v === "on" });
				return c.ui.notify(`autoresume: instant retry-on-error ${v === "on" ? "enabled" : "disabled"}`, "info");
			}
			if (cmd === "retry-cooldown") {
				const n = Number(rest);
				if (!Number.isFinite(n)) return c.ui.notify("autoresume: usage: /autoresume retry-cooldown <sec>", "warning");
				return save({ retryCooldownSec: Math.max(0, Math.round(n)) }, `retry cooldown set to ${Math.max(0, Math.round(n))}s`);
			}
			if (cmd === "retry-max") {
				const n = Number(rest);
				if (!Number.isFinite(n)) return c.ui.notify("autoresume: usage: /autoresume retry-max <n>", "warning");
				return save({ retryMax: Math.round(n) }, `retry budget set to ${Math.round(n)} per 30 min`);
			}
			if (cmd === "msg-pause") {
				if (!rest) return c.ui.notify("autoresume: usage: /autoresume msg-pause <text>", "warning");
				return save({ pauseMsg: rest }, "pause message updated");
			}
			if (cmd === "msg-resume") {
				if (!rest) return c.ui.notify("autoresume: usage: /autoresume msg-resume <text>", "warning");
				return save({ resumeMsg: rest }, "resume message updated");
			}
			if (cmd === "set-url") {
				const normalized = normalizeEndpointUrl(rest);
				if (!/^https?:\/\/.+/i.test(normalized)) {
					return c.ui.notify(
						"autoresume: give an endpoint like codexlb.example.com, https://codexlb.example.com/v1 or https://codexlb.example.com/v1/usage",
						"warning",
					);
				}
				await saveFileConfig({ endpointUrl: normalized });
				await pollAndEvaluate({ force: true, source: "set-url" });
				return c.ui.notify(
					mon.lastSnap ? `autoresume: endpoint saved (${endpointHost(normalized)}), limits polled` : `autoresume: endpoint saved (${endpointHost(normalized)}) but poll failed: ${mon.lastError}`,
					mon.lastSnap ? "info" : "warning",
				);
			}
			if (cmd === "set-token") {
				if (!rest) return c.ui.notify("autoresume: give a token, e.g. /autoresume set-token <token> (stored with mode 0600)", "warning");
				await saveFileConfig({ bearerToken: rest });
				await pollAndEvaluate({ force: true, source: "set-token" });
				return c.ui.notify(
					mon.lastSnap ? "autoresume: token saved, limits polled" : `autoresume: token saved but poll failed: ${mon.lastError}`,
					mon.lastSnap ? "info" : "warning",
				);
			}
			if (cmd === "config") {
				const cfg = await resolveConfig();
				const loaded = await loadFileConfig();
				return c.ui.notify(
					[
						`config file: ${cfg.path}${loaded.exists ? "" : " (absent — env/defaults only)"}`,
						`endpoint: ${cfg.url ? `${endpointHost(cfg.url)} (${cfg.urlFrom})` : "(missing)"}`,
						`token: ${cfg.token ? `${maskToken(cfg.token)} (${cfg.tokenFrom})` : "(missing)"}`,
						`label: ${cfg.label} (${cfg.labelFrom})`,
						`shared usage file: ${cfg.sharedPath}`,
						...(cfg.fileError ? [`file error: ${cfg.fileError}`] : []),
					].join("\n"),
					"info",
				);
			}
			if (cmd === "test-pause") {
				sendPause(s.enabled ? s.pauseMsg : "autoresume is OFF — this is only a delivery test");
				return c.ui.notify("autoresume: pause message sent (state unchanged)", "info");
			}
			if (cmd === "test-resume") {
				sendResume(s.resumeMsg);
				return c.ui.notify("autoresume: resume message sent (state unchanged)", "info");
			}
			return c.ui.notify(HELP, "warning");
		},
	});
}
