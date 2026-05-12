#!/usr/bin/env node
/*
 * mpp-remote — stdio MCP bridge with x402 v1 payment handling.
 *
 * Reads JSON-RPC requests from Claude Code (or any MCP client) over stdin,
 * forwards them to a remote HTTP MCP server, and transparently handles
 * x402 v1 MCP-transport payment-required responses by signing an EIP-3009
 * authorization and retrying.
 *
 * Wire protocol: coinbase/x402 specs/transports-v1/mcp.md.
 *   Payment-required: CallToolResult { isError: true, structuredContent: PaymentRequirementsResponse }
 *   Payment payload : _meta["x402/payment"]        = PaymentPayload object
 *   Settled receipt : _meta["x402/payment-response"] = SettlementResponse object
 *
 * mpp-remote signs only — it does NOT broadcast transactions. The resource
 * server's facilitator does that.
 *
 * Configuration:
 *
 *   Positional:
 *     URL                       remote MCP server URL (required)
 *
 *   Flags:
 *     --proxy <url>             proxy for upstream HTTP, takes precedence
 *                               over HTTPS_PROXY/ALL_PROXY. Supports
 *                               http://, https://, socks5://, socks5h://
 *     --help                    print this help
 *
 *   Environment:
 *     HTTPS_PROXY / ALL_PROXY   proxy URL if --proxy not given
 *     MPP_WALLET_PRIVATE_KEY    0x-prefixed hex key used to SIGN EIP-3009
 *                               authorizations (no gas needed; the facilitator
 *                               broadcasts). Name kept for back-compat.
 *     MPP_MAX_AMOUNT_USD        per-call spending cap (default: 1.0). Compared
 *                               against decoded maxAmountRequired / decimals.
 *     MPP_DEBUG                 if set, log forwarded JSON-RPC to stderr
 */

import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const USAGE = `Usage: mpp-remote [options] <url>

Options:
  --proxy <url>   proxy for upstream HTTP (http://, https://, socks5://, socks5h://)
  --help          show this help

Env:
  HTTPS_PROXY / ALL_PROXY    proxy URL (if --proxy not set)
  MPP_WALLET_PRIVATE_KEY     wallet key for signing x402 EIP-3009 authorizations
  MPP_MAX_AMOUNT_USD         per-call spending cap (default 1.0)
  MPP_DEBUG                  log forwarded JSON-RPC to stderr
`;

// ---- arg parsing ---------------------------------------------------------

function parseArgs(argv) {
	let proxy;
	let url;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') {
			process.stdout.write(USAGE);
			process.exit(0);
		} else if (a === '--proxy') {
			proxy = argv[++i];
		} else if (a.startsWith('--proxy=')) {
			proxy = a.slice('--proxy='.length);
		} else if (!url && !a.startsWith('-')) {
			url = a;
		} else {
			console.error(`mpp-remote: unknown argument: ${a}`);
			process.stderr.write(USAGE);
			process.exit(2);
		}
	}
	if (!url) {
		process.stderr.write(USAGE);
		process.exit(2);
	}
	return { url, proxy };
}

const args = parseArgs(process.argv.slice(2));
const PROXY = args.proxy || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
const PK = process.env.MPP_WALLET_PRIVATE_KEY;
const MAX_AMOUNT = parseFloat(process.env.MPP_MAX_AMOUNT_USD ?? '1.0');
const DEBUG = !!process.env.MPP_DEBUG;

function log(...m) {
	if (DEBUG) console.error('[mpp-remote]', ...m);
}

// ---- proxy agent ---------------------------------------------------------

function makeAgent(url) {
	if (!url) return undefined;
	if (url.startsWith('socks')) return new SocksProxyAgent(url);
	return new HttpsProxyAgent(url);
}

const proxyAgent = makeAgent(PROXY);
if (PROXY) log(`using proxy: ${PROXY}`);

const upstream = axios.create({
	baseURL: args.url,
	timeout: 60_000,
	validateStatus: () => true,
	httpsAgent: proxyAgent,
	httpAgent: proxyAgent,
	proxy: false,
	headers: {
		Accept: 'application/json, text/event-stream',
		'Content-Type': 'application/json',
	},
});

// ---- wallet --------------------------------------------------------------

const account = PK ? privateKeyToAccount(PK) : null;
if (account) log(`wallet: ${account.address}`);

// x402 v1 EVM network → chainId. Subset of EVM_NETWORK_CHAIN_ID_MAP from
// coinbase/x402 mechanisms/evm/v1. Extend if servers advertise more.
const CHAIN_ID_BY_NETWORK = {
	base: 8453,
	'base-sepolia': 84532,
	ethereum: 1,
	sepolia: 11155111,
	polygon: 137,
	'polygon-amoy': 80002,
};

// EIP-3009 TransferWithAuthorization typed-data structure (x402 v1 §6.1.1).
const EIP3009_TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
};

// USDC and most x402 assets are 6 decimals. If/when we add non-6-decimal assets
// we'll need to fetch decimals() from chain or accept a config table.
const DEFAULT_DECIMALS = 6;

// ---- x402 detection + signing -------------------------------------------

// Pull a PaymentRequirementsResponse out of a tools/call result, returning null
// if this isn't an x402 payment-required signal. The MCP transport spec puts it
// in result.structuredContent; clients SHOULD fall back to content[0].text.
function extractX402Requirements(result) {
	if (!result || result.isError !== true) return null;

	const structured = result.structuredContent;
	if (structured && typeof structured === 'object' && structured.x402Version) {
		return structured;
	}

	const text = result.content?.[0]?.text;
	if (typeof text === 'string' && text.length > 0) {
		try {
			const parsed = JSON.parse(text);
			if (parsed && parsed.x402Version) return parsed;
		} catch {
			// Not JSON, not x402 — fall through.
		}
	}

	return null;
}

// Convert a PaymentRequirements maxAmountRequired (atomic units string) to a
// human-readable USD-ish number for the spending cap check. USDC = 6 decimals.
function atomicToFloat(amountAtomic) {
	const n = BigInt(amountAtomic);
	const divisor = 10n ** BigInt(DEFAULT_DECIMALS);
	const whole = Number(n / divisor);
	const frac = Number(n % divisor) / Number(divisor);
	return whole + frac;
}

async function signPayment(requirementsResponse) {
	if (!account) {
		throw new Error('MPP_WALLET_PRIVATE_KEY is not set; cannot sign x402 payment');
	}

	const accepts = requirementsResponse.accepts;
	if (!Array.isArray(accepts) || accepts.length === 0) {
		throw new Error('x402 PaymentRequirementsResponse has no accepts[]');
	}

	// Find the first scheme/network we can satisfy. We only sign "exact" on supported chains today.
	const req = accepts.find(
		(r) =>
			r.scheme === 'exact' &&
			CHAIN_ID_BY_NETWORK[r.network] !== undefined &&
			r.payTo &&
			r.asset,
	);
	if (!req) {
		const summary = accepts.map((r) => `${r.scheme}/${r.network}`).join(', ');
		throw new Error(`no satisfiable x402 requirement (have: ${summary})`);
	}

	if (!req.extra?.name || !req.extra?.version) {
		throw new Error(
			`PaymentRequirements.extra must include name and version for EIP-712 domain (got: ${JSON.stringify(req.extra)})`,
		);
	}

	const amountFloat = atomicToFloat(req.maxAmountRequired);
	if (amountFloat > MAX_AMOUNT) {
		throw new Error(
			`charge ${amountFloat} ${req.extra.name} exceeds MPP_MAX_AMOUNT_USD=${MAX_AMOUNT}`,
		);
	}

	const now = Math.floor(Date.now() / 1000);
	const authorization = {
		from: account.address,
		to: getAddress(req.payTo),
		value: req.maxAmountRequired,
		// 10 min in the past for clock-skew headroom; matches x402 reference impl.
		validAfter: String(now - 600),
		validBefore: String(now + (req.maxTimeoutSeconds ?? 60)),
		nonce: '0x' + randomBytes(32).toString('hex'),
	};

	const domain = {
		name: req.extra.name,
		version: req.extra.version,
		chainId: CHAIN_ID_BY_NETWORK[req.network],
		verifyingContract: getAddress(req.asset),
	};

	console.error(
		`[mpp-remote] signing x402 payment ${req.maxAmountRequired} atomic ` +
			`(${req.extra.name}, ${req.network}, resource=${req.resource ?? '?'})`,
	);

	// EIP-712 signing is purely off-chain — no wallet client or RPC needed.
	const signature = await account.signTypedData({
		domain,
		types: EIP3009_TYPES,
		primaryType: 'TransferWithAuthorization',
		message: authorization,
	});

	return {
		x402Version: 1,
		scheme: 'exact',
		network: req.network,
		payload: {
			signature,
			authorization,
		},
	};
}

// ---- MCP forwarding ------------------------------------------------------

let sessionId = null;

async function post(body) {
	const headers = sessionId ? { 'Mcp-Session-Id': sessionId } : {};
	const r = await upstream.post('', body, { headers });
	if (body.method === 'initialize' && r.headers['mcp-session-id']) {
		sessionId = r.headers['mcp-session-id'];
		log(`session: ${sessionId}`);
	}
	return r.data;
}

async function forward(req) {
	const res = await post(req);
	if (req.method !== 'tools/call') return res;

	const reqs = extractX402Requirements(res?.result);
	if (!reqs) return res;

	try {
		const paymentPayload = await signPayment(reqs);
		return await post({
			...req,
			params: {
				...req.params,
				_meta: {
					...(req.params?._meta ?? {}),
					'x402/payment': paymentPayload,
				},
			},
		});
	} catch (e) {
		// Surface as an x402-shaped tool result so MCP clients see the error in-context.
		return {
			jsonrpc: '2.0',
			id: req.id,
			result: {
				isError: true,
				structuredContent: {
					x402Version: 1,
					error: `mpp-remote: ${e.message}`,
					accepts: reqs.accepts ?? [],
				},
				content: [
					{
						type: 'text',
						text: JSON.stringify({
							x402Version: 1,
							error: `mpp-remote: ${e.message}`,
							accepts: reqs.accepts ?? [],
						}),
					},
				],
			},
		};
	}
}

// ---- stdio loop ----------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
	if (!line.trim()) return;
	let req;
	try {
		req = JSON.parse(line);
	} catch (e) {
		log(`drop non-JSON line: ${line.slice(0, 80)}`);
		return;
	}
	if (DEBUG) log('->', req.method, req.id ?? '(notif)');

	// Notifications have no id; forward fire-and-forget, no reply.
	if (req.id === undefined || req.id === null) {
		post(req).catch((e) => log(`notification forward error: ${e.message}`));
		return;
	}

	try {
		const resp = await forward(req);
		process.stdout.write(JSON.stringify(resp) + '\n');
	} catch (e) {
		process.stdout.write(
			JSON.stringify({
				jsonrpc: '2.0',
				id: req.id,
				error: { code: -32603, message: `bridge error: ${e.message}` },
			}) + '\n',
		);
	}
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
