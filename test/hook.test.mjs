/*
 * Tests for lib/hook.mjs — the hook API surface that mpp-remote exposes
 * via the --hook flag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	loadHook,
	injectHookTools,
	hookOwnsTool,
	dispatchHookCall,
	forwardWithHook,
} from '../lib/hook.mjs';

// ---- helpers ------------------------------------------------------------

async function withHookFile(source, fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mpp-hook-'));
	const filePath = path.join(dir, 'hook.mjs');
	await fs.writeFile(filePath, source);
	try {
		return await fn(filePath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const VALID_HOOK_SRC = `
export default {
  mppRemoteApi: 1,
  tools: [
    { name: 'upload', description: 'd', inputSchema: { type: 'object' } },
  ],
  async handle({ name, args }) {
    if (name === 'upload') {
      return { content: [{ type: 'text', text: 'ok: ' + JSON.stringify(args) }] };
    }
    return null;
  },
};
`;

function callReq(id, name, args = {}) {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name, arguments: args },
	};
}

// ---- loadHook -----------------------------------------------------------

test('loadHook: valid hook returns the export', async () => {
	await withHookFile(VALID_HOOK_SRC, async (p) => {
		const h = await loadHook(p);
		assert.equal(h.mppRemoteApi, 1);
		assert.equal(h.tools.length, 1);
		assert.equal(h.tools[0].name, 'upload');
		assert.equal(typeof h.handle, 'function');
	});
});

test('loadHook: missing default export rejects', async () => {
	await withHookFile(`export const foo = 1;`, async (p) => {
		await assert.rejects(loadHook(p), /default export/);
	});
});

test('loadHook: unsupported mppRemoteApi rejects', async () => {
	await withHookFile(
		`export default { mppRemoteApi: 99, tools: [], async handle(){} };`,
		async (p) => {
			await assert.rejects(loadHook(p), /mppRemoteApi/);
		},
	);
});

test('loadHook: tools must be array', async () => {
	await withHookFile(
		`export default { mppRemoteApi: 1, tools: 'nope', async handle(){} };`,
		async (p) => {
			await assert.rejects(loadHook(p), /tools: Array/);
		},
	);
});

test('loadHook: tools entry missing name rejects', async () => {
	await withHookFile(
		`export default { mppRemoteApi: 1, tools: [{}], async handle(){} };`,
		async (p) => {
			await assert.rejects(loadHook(p), /missing name/);
		},
	);
});

test('loadHook: handle must be function', async () => {
	await withHookFile(
		`export default { mppRemoteApi: 1, tools: [], handle: 'not a fn' };`,
		async (p) => {
			await assert.rejects(loadHook(p), /handle: async function/);
		},
	);
});

test('loadHook: failed import surfaces the error', async () => {
	await withHookFile(`syntax error garbage`, async (p) => {
		await assert.rejects(loadHook(p), /failed to load hook/);
	});
});

test('loadHook: nonexistent path rejects', async () => {
	await assert.rejects(loadHook('/tmp/does-not-exist-xyz.mjs'), /failed to load hook/);
});

// ---- injectHookTools ----------------------------------------------------

test('injectHookTools: appends hook tools after upstream', () => {
	const out = injectHookTools(
		{ tools: [{ name: 'a' }, { name: 'b' }] },
		[{ name: 'c' }],
	);
	assert.deepEqual(out.tools.map((t) => t.name), ['a', 'b', 'c']);
});

test('injectHookTools: hook overrides upstream on name collision', () => {
	const out = injectHookTools(
		{ tools: [{ name: 'a', from: 'upstream' }] },
		[{ name: 'a', from: 'hook' }],
	);
	assert.equal(out.tools.length, 1);
	assert.equal(out.tools[0].from, 'hook');
});

test('injectHookTools: empty hookTools is a no-op', () => {
	const original = { tools: [{ name: 'a' }] };
	const out = injectHookTools(original, []);
	// Returns the same shape (we don't require identity, but content matches).
	assert.deepEqual(out.tools, original.tools);
});

test('injectHookTools: malformed toolsList returns unchanged', () => {
	assert.equal(injectHookTools(null, [{ name: 'a' }]), null);
	const noTools = { something: 'else' };
	assert.equal(injectHookTools(noTools, [{ name: 'a' }]), noTools);
});

// ---- hookOwnsTool -------------------------------------------------------

test('hookOwnsTool: matches by name', () => {
	const hook = { tools: [{ name: 'foo' }, { name: 'bar' }] };
	assert.equal(hookOwnsTool(hook, callReq(1, 'foo')), true);
	assert.equal(hookOwnsTool(hook, callReq(1, 'bar')), true);
	assert.equal(hookOwnsTool(hook, callReq(1, 'other')), false);
});

test('hookOwnsTool: non-tools/call method returns false', () => {
	const hook = { tools: [{ name: 'foo' }] };
	const req = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
	assert.equal(hookOwnsTool(hook, req), false);
});

test('hookOwnsTool: null hook returns false', () => {
	assert.equal(hookOwnsTool(null, callReq(1, 'foo')), false);
});

// ---- dispatchHookCall ---------------------------------------------------

test('dispatchHookCall: matching tool runs handle()', async () => {
	const hook = {
		tools: [{ name: 'foo' }],
		async handle({ name, args }) {
			return { content: [{ type: 'text', text: 'echo: ' + name + ' ' + JSON.stringify(args) }] };
		},
	};
	const out = await dispatchHookCall(hook, callReq(42, 'foo', { x: 1 }), {});
	assert.equal(out.id, 42);
	assert.equal(out.jsonrpc, '2.0');
	assert.match(out.result.content[0].text, /echo: foo \{"x":1\}/);
	assert.equal(out.result.isError, undefined);
});

test('dispatchHookCall: handle thrown error becomes isError tool result', async () => {
	const hook = {
		tools: [{ name: 'foo' }],
		async handle() {
			throw new Error('boom');
		},
	};
	const out = await dispatchHookCall(hook, callReq(1, 'foo'), {});
	assert.equal(out.result.isError, true);
	assert.match(out.result.content[0].text, /handle threw.*boom/);
	assert.match(out.result.structuredContent.error, /boom/);
});

test('dispatchHookCall: null return becomes isError', async () => {
	const hook = {
		tools: [{ name: 'foo' }],
		async handle() {
			return null;
		},
	};
	const out = await dispatchHookCall(hook, callReq(1, 'foo'), {});
	assert.equal(out.result.isError, true);
	assert.match(out.result.content[0].text, /returned null/);
});

test('dispatchHookCall: undefined return becomes isError', async () => {
	const hook = {
		tools: [{ name: 'foo' }],
		async handle() {
			// no return
		},
	};
	const out = await dispatchHookCall(hook, callReq(1, 'foo'), {});
	assert.equal(out.result.isError, true);
	assert.match(out.result.content[0].text, /returned undefined/);
});

test('dispatchHookCall: handle receives narrowed { callTool, logger } context', async () => {
	const seen = {};
	const hook = {
		tools: [{ name: 'foo' }],
		async handle(ctx) {
			seen.keys = Object.keys(ctx).sort();
			seen.callToolIsFn = typeof ctx.callTool === 'function';
			ctx.logger('hello from hook');
			return { content: [{ type: 'text', text: 'ok' }] };
		},
	};
	const logs = [];
	const fakeClient = { callTool: async () => ({ result: { content: [] } }) };
	await dispatchHookCall(hook, callReq(1, 'foo', { a: 1 }), {
		client: fakeClient,
		logger: (m) => logs.push(m),
	});
	assert.deepEqual(seen.keys, ['args', 'callTool', 'logger', 'name']);
	assert.equal(seen.callToolIsFn, true);
	assert.deepEqual(logs, ['hello from hook']);
});

test('dispatchHookCall: callTool delegates to client.callTool', async () => {
	const fakeClient = {
		called: null,
		async callTool(name, args, extraMeta) {
			this.called = { name, args, extraMeta };
			return { jsonrpc: '2.0', id: 99, result: { content: [{ type: 'text', text: 'upstream-said-hi' }] } };
		},
	};
	const hook = {
		tools: [{ name: 'wrap' }],
		async handle({ callTool }) {
			const r = await callTool('upstream_tool', { x: 7 });
			return { content: [{ type: 'text', text: r.result.content[0].text }] };
		},
	};
	const out = await dispatchHookCall(hook, callReq(1, 'wrap'), { client: fakeClient });
	assert.equal(fakeClient.called.name, 'upstream_tool');
	assert.deepEqual(fakeClient.called.args, { x: 7 });
	assert.equal(out.result.content[0].text, 'upstream-said-hi');
});

test('dispatchHookCall: handle is awaited (async work resolves before response)', async () => {
	const hook = {
		tools: [{ name: 'foo' }],
		async handle() {
			await new Promise((r) => setTimeout(r, 5));
			return { content: [{ type: 'text', text: 'late' }] };
		},
	};
	const out = await dispatchHookCall(hook, callReq(1, 'foo'), {});
	assert.equal(out.result.content[0].text, 'late');
});

// ---- end-to-end: loaded hook + dispatch ---------------------------------

test('end-to-end: loadHook then dispatchHookCall', async () => {
	await withHookFile(VALID_HOOK_SRC, async (p) => {
		const h = await loadHook(p);
		assert.equal(hookOwnsTool(h, callReq(1, 'upload')), true);
		const out = await dispatchHookCall(h, callReq(7, 'upload', { path: '/tmp/x' }), {});
		assert.equal(out.id, 7);
		assert.match(out.result.content[0].text, /\/tmp\/x/);
	});
});

// ---- forwardWithHook (bridge dispatch) ----------------------------------

// Minimal McpClient stand-in for forwardWithHook tests. forwardRequest just
// records what it received and returns whatever the test set as `nextResponse`.
function fakeClient({ nextResponse, callToolImpl } = {}) {
	const seen = [];
	return {
		seen,
		async forwardRequest(req) {
			seen.push(req);
			return nextResponse;
		},
		async callTool(name, args, extraMeta) {
			if (callToolImpl) return callToolImpl(name, args, extraMeta);
			return { jsonrpc: '2.0', id: 0, result: { content: [] } };
		},
	};
}

test('forwardWithHook: no hook → forwards everything verbatim', async () => {
	const client = fakeClient({ nextResponse: { jsonrpc: '2.0', id: 1, result: { ok: true } } });
	const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'anything', arguments: {} } };
	const out = await forwardWithHook(req, { client, hook: null });
	assert.deepEqual(client.seen, [req]);
	assert.deepEqual(out.result, { ok: true });
});

test('forwardWithHook: tools/call for hook-owned tool short-circuits', async () => {
	const hook = {
		tools: [{ name: 'mine' }],
		async handle() {
			return { content: [{ type: 'text', text: 'handled locally' }] };
		},
	};
	const client = fakeClient({ nextResponse: { jsonrpc: '2.0', result: { ok: 'upstream' } } });
	const out = await forwardWithHook(callReq(3, 'mine'), { client, hook });
	assert.equal(client.seen.length, 0); // upstream NOT contacted
	assert.equal(out.result.content[0].text, 'handled locally');
});

test('forwardWithHook: tools/call for unrelated tool forwards upstream', async () => {
	const hook = {
		tools: [{ name: 'mine' }],
		async handle() {
			throw new Error('should not be called');
		},
	};
	const upstreamResp = { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'upstream ok' }] } };
	const client = fakeClient({ nextResponse: upstreamResp });
	const out = await forwardWithHook(callReq(4, 'other'), { client, hook });
	assert.equal(client.seen.length, 1);
	assert.equal(client.seen[0].params.name, 'other');
	assert.equal(out, upstreamResp);
});

test('forwardWithHook: tools/list response is augmented with hook tools', async () => {
	const hook = { tools: [{ name: 'mine', description: 'd' }], async handle() {} };
	const upstreamResp = {
		jsonrpc: '2.0',
		id: 5,
		result: { tools: [{ name: 'a' }, { name: 'b' }] },
	};
	const client = fakeClient({ nextResponse: upstreamResp });
	const req = { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} };
	const out = await forwardWithHook(req, { client, hook });
	assert.deepEqual(out.result.tools.map((t) => t.name), ['a', 'b', 'mine']);
});

test('forwardWithHook: tools/list name collision resolves to hook entry', async () => {
	const hook = { tools: [{ name: 'a', source: 'hook' }], async handle() {} };
	const upstreamResp = {
		jsonrpc: '2.0',
		id: 6,
		result: { tools: [{ name: 'a', source: 'upstream' }, { name: 'b' }] },
	};
	const client = fakeClient({ nextResponse: upstreamResp });
	const out = await forwardWithHook(
		{ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} },
		{ client, hook },
	);
	const aEntry = out.result.tools.find((t) => t.name === 'a');
	assert.equal(aEntry.source, 'hook');
});

test('forwardWithHook: non-tools methods pass through untouched', async () => {
	const hook = { tools: [{ name: 'mine' }], async handle() {} };
	const upstreamResp = { jsonrpc: '2.0', id: 7, result: { protocolVersion: '2025-06-18' } };
	const client = fakeClient({ nextResponse: upstreamResp });
	const req = { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} };
	const out = await forwardWithHook(req, { client, hook });
	assert.equal(out, upstreamResp);
});
