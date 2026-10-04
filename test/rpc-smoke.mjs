#!/usr/bin/env node
// Deep pinned-pi smoke for opencode-zen. Boots real pi in RPC mode with the
// extension loaded (ZEN_DEBUG=1), a seeded warm cache, and a stubbed global
// fetch (no network). The marker records the opencode provider's registered
// model count and free-model count on the real process.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-zen-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
const MARKER = join(agentDir, 'zen-loaded.json');

// Warm models cache so the extension registers instantly without network.
const cacheDir = join(dir, 'xdg', 'pi-ext-opencode-zen');
mkdirSync(cacheDir, { recursive: true });
writeFileSync(join(cacheDir, 'models.json'), JSON.stringify([
	{ id: 'codebuff-free', name: 'Codebuff Free', backend: 'openai-completions', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 },
	{ id: 'codebuff-paid', name: 'Codebuff Paid', backend: 'openai-completions', reasoning: true, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 64000 },
]));

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ZEN_DEBUG: '1', XDG_CACHE_HOME: join(dir, 'xdg') }, cwd: dir },
);
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const t0 = Date.now();
const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
const poll = setInterval(() => {
	if (existsSync(MARKER)) {
		clearInterval(poll);
		finish(true);
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(poll);
		finish(false);
	}
}, 200);

function finish(ok) {
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(killTimer);
		try {
			assert2(ok, `timed out; stderr tail: ${err.slice(-800)}`);
			const m = JSON.parse(readFileSync(MARKER, 'utf8'));
			assert2(m.loaded === true, `loaded flag: ${JSON.stringify(m)}`);
			assert2(m.models >= 1, `registered model count: ${JSON.stringify(m)}`);
			console.log(`Deep smoke PASS: real pi loaded opencode-zen; models=${m.models} free=${m.free} (${(Date.now() - t0) / 1000 | 0}s).`);
		} catch (e) {
			console.error('FAIL', e.message);
			console.error(`stdout tail: ${out.slice(-400)}`);
			process.exitCode = 1;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
function assert2(cond, msg) { if (!cond) throw new Error(msg); }
