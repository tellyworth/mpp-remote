/*
 * Stateful MCP client over HTTP. Holds the upstream session id, posts
 * JSON-RPC, and handles x402 payment-required retries for tools/call.
 *
 * Two interfaces are exposed:
 *
 *   forwardRequest(req)    — used by the bridge for passthrough. Preserves the
 *                            caller's JSON-RPC id, params, and method exactly.
 *   callTool(name, args)   — used by internal callers (hook handlers). Generates
 *                            a fresh id.
 *
 * Both go through the same x402 retry path. Sign-side failures (no key, charge
 * over cap, unsatisfiable accepts[], asset not allowlisted, domain mismatch)
 * are returned as an x402-shaped CallToolResult so clients that read
 * `accepts[]` can react.
 */

import axios from 'axios';
import { makeAgent } from './proxy.mjs';
import { extractX402Requirements, signPayment } from './x402.mjs';

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
	constructor({ url, proxy, account, maxAmount, assetAllowlist, logger = () => {}, debugLogger = () => {}, timeoutMs = 60_000 }) {
		this.url = url;
		this.account = account;
		this.maxAmount = maxAmount;
		this.assetAllowlist = assetAllowlist;
		// Two loggers: `log` is info-level (always-on by convention; signing trace
		// uses it), `debug` is gated on the caller's debug flag (session-id
		// capture uses it). Matches trunk's mixed logging model.
		this.log = logger;
		this.debug = debugLogger;
		this.sessionId = null;
		this.nextId = 1;

		const agent = makeAgent(proxy);
		this.http = axios.create({
			baseURL: url,
			timeout: timeoutMs,
			validateStatus: () => true,
			httpsAgent: agent,
			httpAgent: agent,
			proxy: false,
			headers: {
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json',
			},
		});
	}

	async post(body) {
		const headers = this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {};
		const r = await this.http.post('', body, { headers });
		if (body.method === 'initialize' && r.headers['mcp-session-id']) {
			this.sessionId = r.headers['mcp-session-id'];
			this.debug(`session: ${this.sessionId}`);
		}
		return r.data;
	}

	async forwardRequest(req) {
		const res = await this.post(req);
		if (req.method !== 'tools/call') return res;

		const reqs = extractX402Requirements(res?.result);
		if (!reqs) return res;

		let paymentPayload;
		try {
			paymentPayload = await signPayment(reqs, this.account, this.maxAmount, this.assetAllowlist, this.log);
		} catch (e) {
			// Prefix matches the pre-extraction bridge's error envelope so clients
			// reading structuredContent.error see a stable identifier for the source.
			return x402ErrorResponse(req.id, `mpp-remote: ${e.message}`, reqs.accepts ?? []);
		}
		return this.post({
			...req,
			params: {
				...req.params,
				_meta: {
					...(req.params?._meta ?? {}),
					'x402/payment': paymentPayload,
				},
			},
		});
	}

	async initialize({ clientName = 'mpp-remote', clientVersion = '0.1.0' } = {}) {
		const r = await this.post({
			jsonrpc: '2.0',
			id: this.nextId++,
			method: 'initialize',
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: clientName, version: clientVersion },
			},
		});
		if (r.error) throw new Error(`initialize failed: ${JSON.stringify(r.error)}`);
		await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
		return r.result;
	}

	async callTool(name, args, extraMeta = null) {
		const params = { name, arguments: args };
		if (extraMeta) params._meta = extraMeta;
		const req = { jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params };
		return this.forwardRequest(req);
	}

	async listTools() {
		const r = await this.post({
			jsonrpc: '2.0',
			id: this.nextId++,
			method: 'tools/list',
			params: {},
		});
		if (r.error) throw new Error(`tools/list failed: ${JSON.stringify(r.error)}`);
		return r.result;
	}
}

function x402ErrorResponse(id, message, accepts) {
	const body = { x402Version: 1, error: message, accepts };
	return {
		jsonrpc: '2.0',
		id,
		result: {
			isError: true,
			structuredContent: body,
			content: [{ type: 'text', text: JSON.stringify(body) }],
		},
	};
}
