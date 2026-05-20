/*
 * End-to-end integration tests for bin/mpp-remote.mjs.
 *
 * Spawns the bridge as a subprocess with a temp hook file, points it at a
 * loopback HTTP mock server, feeds JSON-RPC over stdin, and asserts on
 * stdout. The unit tests in hook.test.mjs cover dispatcher logic with a
 * fake McpClient; these tests verify the wiring (stdin → JSON.parse →
 * forwardWithHook → JSON.stringify → stdout) and that the hook actually
 * receives a working callTool that reaches the upstream mock.
 *
 * No real network and no real signing — the mock returns canned MCP results,
 * and we set MPP_WALLET_PRIVATE_KEY to a throwaway hex so the bridge's
 * signer-required gate passes without exercising the x402 path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_BIN = path.resolve(__dirname, '..', 'bin', 'mpp-remote.mjs');
const THROWAWAY_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';

// ---- mock upstream MCP server -------------------------------------------

// Tiny HTTP server that speaks just enough MCP for tools/list and tools/call.
// `handlers` is a method → handler map; each handler returns the JSON-RPC
// `result` field. The transport-level envelope (jsonrpc/id/Mcp-Session-Id) is
// added here. Returns { url, close, calls } — `calls` records every request
// the bridge sent so tests can assert what hit upstream.
async function startMockUpstream(handlers) {
	const calls = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			let msg;
			try {
				msg = JSON.parse(body);
			} catch {
				res.writeHead(400);
				res.end();
				return;
			}
			calls.push(msg);
			const handler = handlers[msg.method];
			if (!handler) {
				res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'mock-session' });
				res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
				return;
			}
			const result = handler(msg);
			res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'mock-session' });
			res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const port = server.address().port;
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		close: () => new Promise((r) => server.close(r)),
	};
}

// ---- bridge driver ------------------------------------------------------

// Spawn the bridge, write each request to stdin separated by newlines, wait
// for `expectedResponses` JSON objects from stdout, then SIGTERM. Returns the
// parsed responses array.
async function driveBridge({ url, hookPath, requests, expectedResponses, timeoutMs = 5000 }) {
	const args = ['--hook', hookPath, url];
	const child = spawn(process.execPath, [BRIDGE_BIN, ...args], {
		env: { ...process.env, MPP_WALLET_PRIVATE_KEY: THROWAWAY_KEY },
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	let stdoutBuf = '';
	const responses = [];
	let resolveAll;
	const allDone = new Promise((r) => (resolveAll = r));

	child.stdout.on('data', (chunk) => {
		stdoutBuf += chunk.toString('utf8');
		let nl;
		while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
			const line = stdoutBuf.slice(0, nl);
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (line.trim()) {
				responses.push(JSON.parse(line));
				if (responses.length >= expectedResponses) resolveAll();
			}
		}
	});

	let stderrBuf = '';
	child.stderr.on('data', (chunk) => (stderrBuf += chunk.toString('utf8')));

	for (const req of requests) {
		child.stdin.write(JSON.stringify(req) + '\n');
	}

	const timeout = new Promise((_, reject) =>
		setTimeout(() => reject(new Error(`bridge timed out after ${timeoutMs}ms; stderr:\n${stderrBuf}`)), timeoutMs),
	);

	try {
		await Promise.race([allDone, timeout]);
	} finally {
		child.kill('SIGTERM');
		await new Promise((r) => child.once('exit', r));
	}
	return { responses, stderr: stderrBuf };
}

// ---- hook fixture -------------------------------------------------------

async function writeHook(body) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mpp-bridge-'));
	const hookPath = path.join(dir, 'hook.mjs');
	await fs.writeFile(hookPath, body);
	return {
		path: hookPath,
		cleanup: () => fs.rm(dir, { recursive: true, force: true }),
	};
}

// ---- tests --------------------------------------------------------------

test('bridge: tools/list response includes hook tools alongside upstream', async () => {
	const mock = await startMockUpstream({
		initialize: () => ({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '0' } }),
		'tools/list': () => ({ tools: [{ name: 'upstream_a' }, { name: 'upstream_b' }] }),
	});
	const hook = await writeHook(`
		export default {
			mppRemoteApi: 1,
			tools: [{ name: 'hook_tool', description: 'd', inputSchema: { type: 'object' } }],
			async handle() { return { content: [{ type: 'text', text: 'unused here' }] }; },
		};
	`);
	try {
		const { responses } = await driveBridge({
			url: mock.url,
			hookPath: hook.path,
			requests: [
				{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
				{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
			],
			expectedResponses: 2,
		});
		const list = responses.find((r) => r.id === 2);
		assert.ok(list, `no tools/list response; got ${JSON.stringify(responses)}`);
		const names = list.result.tools.map((t) => t.name);
		assert.deepEqual(names, ['upstream_a', 'upstream_b', 'hook_tool']);
	} finally {
		await hook.cleanup();
		await mock.close();
	}
});

test('bridge: tools/call for hook tool dispatches locally without upstream contact', async () => {
	const mock = await startMockUpstream({
		initialize: () => ({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '0' } }),
	});
	const hook = await writeHook(`
		export default {
			mppRemoteApi: 1,
			tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
			async handle({ name, args }) {
				return { content: [{ type: 'text', text: 'echo:' + JSON.stringify(args) }] };
			},
		};
	`);
	try {
		const { responses } = await driveBridge({
			url: mock.url,
			hookPath: hook.path,
			requests: [
				{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
				{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { hello: 'world' } } },
			],
			expectedResponses: 2,
		});
		const callResp = responses.find((r) => r.id === 2);
		assert.equal(callResp.result.content[0].text, 'echo:{"hello":"world"}');
		// Upstream saw initialize + notifications/initialized, but NOT tools/call.
		const methods = mock.calls.map((c) => c.method);
		assert.ok(!methods.includes('tools/call'), `tools/call leaked upstream; saw methods: ${methods.join(', ')}`);
	} finally {
		await hook.cleanup();
		await mock.close();
	}
});

test('bridge: hook callTool reaches upstream through the same session', async () => {
	const mock = await startMockUpstream({
		initialize: () => ({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '0' } }),
		'tools/call': (msg) => {
			if (msg.params.name === 'upstream_tool') {
				return { content: [{ type: 'text', text: 'upstream-handled-' + msg.params.arguments.x }] };
			}
			return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
		},
	});
	const hook = await writeHook(`
		export default {
			mppRemoteApi: 1,
			tools: [{ name: 'wrap', inputSchema: { type: 'object' } }],
			async handle({ name, args, callTool }) {
				const r = await callTool('upstream_tool', { x: args.value });
				const innerText = r.result.content[0].text;
				return { content: [{ type: 'text', text: 'wrapped:' + innerText }] };
			},
		};
	`);
	try {
		const { responses } = await driveBridge({
			url: mock.url,
			hookPath: hook.path,
			requests: [
				{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
				{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wrap', arguments: { value: 42 } } },
			],
			expectedResponses: 2,
		});
		const wrapResp = responses.find((r) => r.id === 2);
		assert.equal(wrapResp.result.content[0].text, 'wrapped:upstream-handled-42');
		// Upstream must have been called with the inner tool name + args.
		const upstreamCall = mock.calls.find((c) => c.method === 'tools/call' && c.params.name === 'upstream_tool');
		assert.ok(upstreamCall, `upstream never received tools/call for upstream_tool; saw: ${JSON.stringify(mock.calls.map((c) => c.method))}`);
		assert.deepEqual(upstreamCall.params.arguments, { x: 42 });
	} finally {
		await hook.cleanup();
		await mock.close();
	}
});
