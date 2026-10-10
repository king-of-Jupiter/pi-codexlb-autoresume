import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configFilePath,
	loadFileConfig,
	maskToken,
	normalizeEndpointUrl,
	resolveConfig,
	saveFileConfig,
	sharedUsageFilePath,
} from "../src/config.ts";

async function sandbox() {
	const dir = await mkdtemp(join(tmpdir(), "autoresume-cfg-"));
	return { dir, file: join(dir, "sub", "config.json") };
}

test("configFilePath: AUTORESSUME_CONFIG wins, XDG respected, default under home", () => {
	assert.equal(configFilePath({ AUTORESSUME_CONFIG: "/tmp/x.json" }), "/tmp/x.json");
	assert.equal(configFilePath({ XDG_CONFIG_HOME: "/xdg" }), join("/xdg", "pi-codexlb-autoresume", "config.json"));
	assert.match(configFilePath({}), /pi-codexlb-autoresume[\\/]config\.json$/);
});

test("sharedUsageFilePath: CODEXLB_CONFIG wins, default under home", () => {
	assert.equal(sharedUsageFilePath({ CODEXLB_CONFIG: "/tmp/u.json" }), "/tmp/u.json");
	assert.match(sharedUsageFilePath({}), /pi-codexlb-usage[\\/]config\.json$/);
});

test("save/load round-trip; file created with mode 0600", async () => {
	const { file } = await sandbox();
	const p = await saveFileConfig({ pausePct: 15, resumePct: 40, watch: "5h", retryOnError: true }, file);
	assert.equal(p, file);
	const loaded = await loadFileConfig(file);
	assert.equal(loaded.values.pausePct, 15);
	assert.equal(loaded.values.resumePct, 40);
	assert.equal(loaded.values.watch, "5h");
	assert.equal(loaded.values.retryOnError, true);
	assert.equal(loaded.exists, true);
	assert.equal(loaded.corrupt, false);
	if (process.platform !== "win32") {
		assert.equal((await stat(file)).mode & 0o777, 0o600);
	}
});

test("saveFileConfig merges over existing values", async () => {
	const { file } = await sandbox();
	await saveFileConfig({ pausePct: 5, pauseMsg: "hold" }, file);
	await saveFileConfig({ pausePct: 8 }, file);
	const loaded = await loadFileConfig(file);
	assert.equal(loaded.values.pausePct, 8);
	assert.equal(loaded.values.pauseMsg, "hold");
});

test("loadFileConfig: missing file and corrupt file", async () => {
	const { dir } = await sandbox();
	const missing = await loadFileConfig(join(dir, "nope.json"));
	assert.deepEqual([missing.exists, missing.corrupt], [false, false]);
	const { writeFile } = await import("node:fs/promises");
	const file = join(dir, "config.json");
	await writeFile(file, "{not json", "utf8");
	const bad = await loadFileConfig(file);
	assert.equal(bad.exists, true);
	assert.equal(bad.corrupt, true);
	assert.match(bad.error!, /JSON/);
});

test("resolveConfig: env wins per-field over the file", async () => {
	const { file } = await sandbox();
	await saveFileConfig({ pausePct: 5, pollMs: 20000 }, file);
	const env = { AUTORESSUME_CONFIG: file, AUTORESSUME_PAUSE_PCT: "12" };
	const r = await resolveConfig(env);
	assert.equal(r.settings.pausePct, 12);
	assert.equal(r.settings.pollMs, 20000);
	assert.equal(r.settings.resumePct, 30);
});

test("resolveConfig: connection falls back to the shared usage file", async () => {
	const { dir } = await sandbox();
	const own = join(dir, "own.json");
	const shared = join(dir, "shared.json");
	const { writeFile } = await import("node:fs/promises");
	await writeFile(shared, JSON.stringify({ endpointUrl: "https://lb/shared", bearerToken: "shared-tok", label: "Shared" }), "utf8");
	const r = await resolveConfig({ AUTORESSUME_CONFIG: own, CODEXLB_CONFIG: shared });
	assert.equal(r.url, "https://lb/shared");
	assert.equal(r.token, "shared-tok");
	assert.equal(r.label, "Shared");
	assert.equal(r.urlFrom, "shared");
	assert.equal(r.tokenFrom, "shared");
});

test("resolveConfig: own file beats the shared file; env beats both", async () => {
	const { dir } = await sandbox();
	const own = join(dir, "own.json");
	const shared = join(dir, "shared.json");
	const { writeFile } = await import("node:fs/promises");
	await writeFile(shared, JSON.stringify({ endpointUrl: "https://lb/shared", bearerToken: "shared-tok" }), "utf8");
	await saveFileConfig({ endpointUrl: "https://lb/own", bearerToken: "own-tok" }, own);
	const fromOwn = await resolveConfig({ AUTORESSUME_CONFIG: own, CODEXLB_CONFIG: shared });
	assert.equal(fromOwn.url, "https://lb/own");
	const fromEnv = await resolveConfig({ AUTORESSUME_CONFIG: own, CODEXLB_CONFIG: shared, CODEXLB_URL: "https://lb/env" });
	assert.equal(fromEnv.url, "https://lb/env");
	assert.equal(fromEnv.urlFrom, "env");
	assert.equal(fromEnv.token, "own-tok");
});

test("resolveConfig: invalid pause/resume combination falls back to defaults", async () => {
	const r = await resolveConfig({ AUTORESSUME_PAUSE_PCT: "50", AUTORESSUME_RESUME_PCT: "40" });
	assert.equal(r.settings.pausePct, 10);
	assert.equal(r.settings.resumePct, 30);
});

test("resolveConfig: poll interval clamped to the minimum", async () => {
	const r = await resolveConfig({ AUTORESSUME_POLL_MS: "1000" });
	assert.equal(r.settings.pollMs, 15000);
});

test("resolveConfig surfaces a corrupt own file as fileError", async () => {
	const { dir } = await sandbox();
	const file = join(dir, "config.json");
	const { writeFile } = await import("node:fs/promises");
	await writeFile(file, "[1,2]", "utf8"); // valid JSON, not an object
	const r = await resolveConfig({ AUTORESSUME_CONFIG: file, AUTORESSUME_ENABLED: "0" });
	assert.match(r.fileError!, /JSON object/);
	assert.equal(r.settings.enabled, false); // env still works
});

test("normalizeEndpointUrl accepts host, /v1 and /v1/usage forms", () => {
	assert.equal(normalizeEndpointUrl("codexlb.viperrr.ru"), "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(normalizeEndpointUrl("https://codexlb.viperrr.ru"), "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(normalizeEndpointUrl("https://codexlb.viperrr.ru/"), "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(normalizeEndpointUrl("https://codexlb.viperrr.ru/v1"), "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(normalizeEndpointUrl("https://codexlb.viperrr.ru/v1/"), "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(normalizeEndpointUrl("https://codexlb.viperrr.ru/v1/usage"), "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(normalizeEndpointUrl("https://codexlb.viperrr.ru/v1/usage/"), "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(normalizeEndpointUrl("http://192.168.1.10:8080"), "http://192.168.1.10:8080/v1/usage");
	assert.equal(normalizeEndpointUrl(""), "");
});

test("normalizeEndpointUrl leaves custom paths and garbage alone", () => {
	assert.equal(normalizeEndpointUrl("https://example.com/lb/prefix"), "https://example.com/lb/prefix");
	assert.equal(normalizeEndpointUrl("ftp://example.com/v1/usage"), "ftp://example.com/v1/usage");
	assert.equal(normalizeEndpointUrl("://missing-scheme"), "://missing-scheme");
	assert.equal(normalizeEndpointUrl("not a url at all"), "not a url at all");
});

test("resolveConfig normalizes the endpoint URL from env", async () => {
	const { dir } = await sandbox();
	const r = await resolveConfig({ AUTORESSUME_CONFIG: join(dir, "nope.json"), CODEXLB_URL: "codexlb.viperrr.ru/v1" });
	assert.equal(r.url, "https://codexlb.viperrr.ru/v1/usage");
	assert.equal(r.urlFrom, "env");
});

test("maskToken never reveals more than 4 chars", () => {
	assert.equal(maskToken(""), "(missing)");
	assert.equal(maskToken("abcd"), "••••");
	assert.equal(maskToken("super-secret-token"), "••••oken");
});

test("resolveConfig: no files and no env means unconfigured but sane defaults", async () => {
	const { dir } = await sandbox();
	const r = await resolveConfig({ AUTORESSUME_CONFIG: join(dir, "nope.json"), CODEXLB_CONFIG: join(dir, "nope2.json") });
	assert.deepEqual([r.url, r.token], ["", ""]);
	assert.equal(r.settings.enabled, true);
	assert.equal(r.settings.retryOnError, false);
	const raw = await readFile(join(dir, "nope.json")).catch(() => null);
	assert.equal(raw, null); // resolve never writes
});
