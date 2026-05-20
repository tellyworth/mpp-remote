/*
 * Hook API — lets a caller of `mpp-remote --hook <path>` add tools and
 * intercept tools/call from inside the bridge process. The hook is a small
 * ESM module:
 *
 *   // my-hook.mjs
 *   export default {
 *     mppRemoteApi: 1,
 *     tools: [
 *       { name: 'upload', description: '...', inputSchema: { ... } },
 *     ],
 *     async handle({ name, args, callTool, logger }) {
 *       if (name === 'upload') {
 *         // run safeguards, reach upstream tools via `callTool(...)`,
 *         // return a CallToolResult-shaped object.
 *         const begin = await callTool('begin_upload', { ... });
 *         return { content: [...], structuredContent: { ... } };
 *       }
 *       return null; // not handled — but only `tools[].name` get dispatched
 *     },
 *   };
 *
 * Contract:
 *   - The bridge appends `tools[]` to upstream's tools/list response.
 *   - Hook tool names override upstream on collision (the hook wins).
 *   - tools/call where name matches a hook tool is dispatched to handle();
 *     calls to any other tool are forwarded upstream unchanged.
 *   - handle() receives the narrowed surface `{ name, args, callTool, logger }`.
 *     `callTool(name, args, extraMeta?)` reaches upstream tools and handles
 *     x402 payment retry internally — the hook never sees signing.
 *   - handle() must return a CallToolResult-shaped object (with content[]
 *     and/or structuredContent, optionally isError). Returning null when the
 *     bridge dispatched is treated as an error.
 *   - Exceptions in handle() become isError tool results, never JSON-RPC
 *     errors. The bridge keeps running.
 *
 * mppRemoteApi is the contract version. v1 is what's documented above.
 * Future incompatible changes bump the integer; hooks that don't match the
 * bridge's supported version are rejected at load time. Additive changes
 * (e.g. extra fields on the context object) don't bump the version.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SUPPORTED_API_VERSIONS = new Set([1]);

export async function loadHook(hookPath) {
	const abs = path.resolve(hookPath);
	let mod;
	try {
		mod = await import(pathToFileURL(abs).href);
	} catch (e) {
		throw new Error(`failed to load hook ${hookPath}: ${e.message}`);
	}
	const h = mod.default;
	if (!h || typeof h !== 'object') {
		throw new Error(`hook ${hookPath} must have a default export`);
	}
	if (!SUPPORTED_API_VERSIONS.has(h.mppRemoteApi)) {
		throw new Error(
			`hook ${hookPath} declares mppRemoteApi=${JSON.stringify(h.mppRemoteApi)}; ` +
				`bridge supports ${[...SUPPORTED_API_VERSIONS].join(', ')}`,
		);
	}
	if (!Array.isArray(h.tools)) {
		throw new Error(`hook ${hookPath} must export tools: Array`);
	}
	for (const t of h.tools) {
		if (!t || typeof t.name !== 'string' || t.name === '') {
			throw new Error(`hook ${hookPath} tool entry missing name: ${JSON.stringify(t)}`);
		}
	}
	if (typeof h.handle !== 'function') {
		throw new Error(`hook ${hookPath} must export handle: async function`);
	}
	return h;
}

// Merge the hook's tools into a tools/list result. Hook tools win on name
// collision — see contract note above.
//
// Pagination: MCP tools/list supports server-side pagination via nextCursor.
// We must inject hook tools exactly once across the cursor walk; injecting on
// every page would duplicate them in the client's aggregate. We inject only
// when the server has indicated this is the final page (no nextCursor). For
// servers that don't paginate at all, nextCursor is absent and injection
// happens on the single response — same behavior.
export function injectHookTools(toolsList, hookTools) {
	if (!toolsList || !Array.isArray(toolsList.tools)) return toolsList;
	if (!Array.isArray(hookTools) || hookTools.length === 0) return toolsList;
	if (toolsList.nextCursor != null && toolsList.nextCursor !== '') return toolsList;
	const hookNames = new Set(hookTools.map((t) => t.name));
	const filtered = toolsList.tools.filter((t) => !hookNames.has(t?.name));
	return { ...toolsList, tools: [...filtered, ...hookTools] };
}

// Returns true if a tools/call request is for one of the hook's tools.
export function hookOwnsTool(hook, req) {
	if (!hook || req?.method !== 'tools/call') return false;
	const name = req.params?.name;
	if (typeof name !== 'string') return false;
	return hook.tools.some((t) => t.name === name);
}

// Run the hook's handle() for a tools/call request and shape the response
// into JSON-RPC. Exceptions and null returns become isError tool results so
// the bridge never propagates them as JSON-RPC errors. The handle receives a
// narrowed context — only callTool from the McpClient, not the whole
// instance — so the contract is the stable v1 surface, not McpClient's
// internals.
export async function dispatchHookCall(hook, req, { client, logger = () => {} } = {}) {
	const name = req.params?.name;
	const args = req.params?.arguments ?? {};
	const callTool = (toolName, toolArgs, extraMeta) =>
		client.callTool(toolName, toolArgs, extraMeta);
	let result;
	try {
		result = await hook.handle({ name, args, callTool, logger });
	} catch (e) {
		return toolErrorResponse(req.id, `hook handle threw: ${e.message}`);
	}
	if (result == null) {
		return toolErrorResponse(
			req.id,
			`hook claimed tool "${name}" but handle() returned ${result === null ? 'null' : 'undefined'}`,
		);
	}
	return { jsonrpc: '2.0', id: req.id, result };
}

// Top-level bridge dispatch: hook intercept for tools/call name in hook.tools,
// otherwise client.forwardRequest, with tools/list augmentation on the way
// back. Extracted from bin/mpp-remote.mjs so unit tests can drive the
// orchestration without spawning the bridge.
export async function forwardWithHook(req, { client, hook = null, logger = () => {} } = {}) {
	if (hook && hookOwnsTool(hook, req)) {
		return dispatchHookCall(hook, req, { client, logger });
	}
	const res = await client.forwardRequest(req);
	if (hook && req.method === 'tools/list' && res?.result) {
		res.result = injectHookTools(res.result, hook.tools);
	}
	return res;
}

function toolErrorResponse(id, message) {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			isError: true,
			content: [{ type: 'text', text: message }],
			structuredContent: { error: message },
		},
	};
}
