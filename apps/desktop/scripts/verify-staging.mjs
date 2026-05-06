/**
 * Post-staging smoke test.
 *
 * Spawns the staged server exactly the way the packaged desktop app will:
 *   <node> <staging/server/node_modules/tsx/dist/cli.mjs> <staging/server/src/index.ts>
 *
 * Polls /api/health until it responds OK (or times out), then kills the
 * child. If the server can't boot, we dump its stderr and exit non-zero
 * so `electron-builder` never wraps a known-broken sidecar.
 *
 * Run with `--no-llm-toml` to exercise the "user has no config yet" path
 * — the server must still boot and answer /api/health via the built-in
 * default.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const stagingDir = path.join(desktopRoot, "staging");
const serverStaging = path.join(stagingDir, "server");

const noLlmToml = process.argv.includes("--no-llm-toml");
const TIMEOUT_MS = 30_000;

function die(msg, code = 1) {
	console.error(`[smoke] ${msg}`);
	process.exit(code);
}

if (!fs.existsSync(serverStaging)) {
	die(
		`staging/server missing at ${serverStaging}. Run the build script first.`,
	);
}

const tsxCli = path.join(serverStaging, "node_modules/tsx/dist/cli.mjs");
const entry = path.join(serverStaging, "src/index.ts");
if (!fs.existsSync(tsxCli)) die(`tsx CLI missing at ${tsxCli}`);
if (!fs.existsSync(entry)) die(`server entry missing at ${entry}`);

// If smoke test needs to simulate "no llm.toml", rename it for the duration
// and restore on exit.
const stagedLlmToml = path.join(serverStaging, "llm.toml");
const hiddenLlmToml = stagedLlmToml + ".smoke-hidden";
let restoreLlmToml = () => {};
if (noLlmToml && fs.existsSync(stagedLlmToml)) {
	fs.renameSync(stagedLlmToml, hiddenLlmToml);
	restoreLlmToml = () => {
		try {
			if (fs.existsSync(hiddenLlmToml))
				fs.renameSync(hiddenLlmToml, stagedLlmToml);
		} catch {
			/* best effort */
		}
	};
	process.on("exit", restoreLlmToml);
	process.on("SIGINT", () => {
		restoreLlmToml();
		process.exit(130);
	});
}

async function findFreePort() {
	return await new Promise((resolve, reject) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				s.close(() => resolve(port));
			} else {
				s.close(() => reject(new Error("could not pick free port")));
			}
		});
		s.on("error", reject);
	});
}

async function poll(url, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let interval = 150;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			/* not ready */
		}
		await new Promise((r) => setTimeout(r, interval));
		interval = Math.min(1000, Math.round(interval * 1.35));
	}
	throw new Error(`server did not respond at ${url} within ${timeoutMs}ms`);
}

const port = await findFreePort();
const tmpDb = path.join(desktopRoot, "staging", `.smoke-${port}.db`);
const tmpUserRoot = path.join(stagingDir, `.smoke-user-${port}`);
const userPluginsDir = path.join(tmpUserRoot, "plugins");
const userWorldsDir = path.join(tmpUserRoot, "worlds");
const userConfigDir = path.join(tmpUserRoot, "config");
const logsDir = path.join(tmpUserRoot, "logs");
for (const dir of [userPluginsDir, userWorldsDir, userConfigDir, logsDir]) {
	fs.mkdirSync(dir, { recursive: true });
}

// The smoke env intentionally avoids any DEEPSEEK_API_KEY or similar: we're
// verifying the server *boots* with whatever config it finds (or doesn't).
const env = {
	...process.env,
	SERVER_PORT: String(port),
	STORE_BACKEND: "sqlite",
	SQLITE_PATH: tmpDb,
	NODE_ENV: "production",
	COVEL_DESKTOP_REST: "1",
	COVEL_DESKTOP_REST_TOKEN: `smoke-${port}`,
	COVEL_PLUGINS_DIR: path.join(serverStaging, "plugins"),
	COVEL_WORLDS_DIR: path.join(serverStaging, "worlds"),
	COVEL_USER_PLUGINS_DIR: userPluginsDir,
	COVEL_USER_WORLDS_DIR: userWorldsDir,
	COVEL_USER_CONFIG_DIR: userConfigDir,
	COVEL_LOGS_DIR: logsDir,
	STATIC_DIR: path.join(stagingDir, "web-dist"),
};

console.log(
	`[smoke] spawning staged server on port ${port}` +
		(noLlmToml ? " (without llm.toml)" : ""),
);

const stderrBuf = [];
const child = spawn(process.execPath, [tsxCli, entry], {
	cwd: serverStaging,
	env,
	stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (data) => process.stdout.write(`[server] ${data}`));
child.stderr.on("data", (data) => {
	const text = data.toString();
	process.stderr.write(`[server:err] ${text}`);
	stderrBuf.push(text);
	// Cap retention so a chatty server doesn't balloon memory
	if (stderrBuf.length > 400) stderrBuf.shift();
});

let booted = false;
child.on("exit", (code, signal) => {
	if (!booted) {
		restoreLlmToml();
		cleanupDb();
		const tail = stderrBuf.slice(-80).join("");
		die(
			`server exited during boot (code=${code}, signal=${signal})\n--- stderr tail ---\n${tail}`,
		);
	}
});

function cleanupDb() {
	try {
		if (fs.existsSync(tmpDb)) fs.rmSync(tmpDb, { force: true });
		for (const suffix of ["-shm", "-wal"]) {
			const p = tmpDb + suffix;
			if (fs.existsSync(p)) fs.rmSync(p, { force: true });
		}
		if (fs.existsSync(tmpUserRoot))
			fs.rmSync(tmpUserRoot, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

function assertNoStartupPathErrors() {
	const stderr = stderrBuf.join("");
	if (/\bENOENT\b|\bENOTDIR\b/.test(stderr)) {
		throw new Error(
			`server reported startup path errors\n--- stderr tail ---\n${stderrBuf.slice(-80).join("")}`,
		);
	}
}

try {
	await poll(`http://127.0.0.1:${port}/api/health`, TIMEOUT_MS);
	assertNoStartupPathErrors();
	booted = true;
	console.log("[smoke] ✓ /api/health OK");
} catch (err) {
	const tail = stderrBuf.slice(-80).join("");
	child.kill("SIGKILL");
	restoreLlmToml();
	cleanupDb();
	die(
		`${err instanceof Error ? err.message : err}\n--- stderr tail ---\n${tail}`,
	);
}

child.kill("SIGTERM");
// Give the process a moment to exit cleanly
await new Promise((r) => setTimeout(r, 500));
if (!child.killed) child.kill("SIGKILL");
restoreLlmToml();
cleanupDb();
console.log("[smoke] ✓ staging server is bootable");
