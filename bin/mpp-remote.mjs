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
 * Hooks (--hook <path>): a hook is a small ESM module that adds tools to
 * tools/list and intercepts tools/call for those tools. See lib/hook.mjs
 * for the contract.
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
 *     --hook <path>             ESM module exposing additional tools and a
 *                               handler. See lib/hook.mjs for the contract.
 *     --help                    print this help
 *
 *   Environment (exactly one signer must be configured):
 *     PRIVY_WALLET_ADDRESS      address of a Privy agent wallet to sign
 *                               with. User must have run `paw login` once
 *                               so the CLI has a session. Preferred on
 *                               dev machines — the signing key never
 *                               leaves Privy.
 *     PRIVY_AGENT_WALLET_BIN    override the CLI binary (default: paw).
 *     MPP_WALLET_PRIVATE_KEY    0x-prefixed hex private key. Signs locally
 *                               with viem. Suitable for unattended
 *                               contexts (CI, build agents) where Privy's
 *                               browser login can't run.
 *
 *   Other environment:
 *     HTTPS_PROXY / ALL_PROXY   proxy URL if --proxy not given
 *     MPP_MAX_AMOUNT_USD        per-call spending cap (default: 1.0). Compared
 *                               against maxAmountRequired decoded with the
 *                               decimals of the matched allowlist entry.
 *     MPP_ASSET_ALLOWLIST       JSON object merged over the built-in
 *                               per-chain asset allowlist. Required to add
 *                               assets beyond the built-in entries. See
 *                               BUILTIN_ASSET_ALLOWLIST in lib/x402.mjs.
 *     MPP_DEBUG                 if set, log forwarded JSON-RPC to stderr
 */

import readline from 'node:readline';

import { McpClient } from '../lib/mcp-client.mjs';
import { loadWalletEnv } from '../lib/cli-env.mjs';
import { loadAssetAllowlist } from '../lib/x402.mjs';
import { loadHook, injectHookTools, hookOwnsTool, dispatchHookCall } from '../lib/hook.mjs';

const USAGE = `Usage: mpp-remote [options] <url>

Options:
  --proxy <url>   proxy for upstream HTTP (http://, https://, socks5://, socks5h://)
  --hook <path>   ESM module adding tools + a handler (see lib/hook.mjs)
  --help          show this help

Env (set exactly one signer):
  PRIVY_WALLET_ADDRESS       sign via Privy agent-wallet CLI (dev machines)
  PRIVY_AGENT_WALLET_BIN     override the CLI binary (default: paw)
  MPP_WALLET_PRIVATE_KEY     0x-hex key signed locally with viem (CI/headless)

Other env:
  HTTPS_PROXY / ALL_PROXY    proxy URL (if --proxy not set)
  MPP_MAX_AMOUNT_USD         per-call spending cap (default 1.0)
  MPP_ASSET_ALLOWLIST        JSON map of additional accepted assets per chain
  MPP_DEBUG                  log forwarded JSON-RPC to stderr
`;

// ---- arg parsing ---------------------------------------------------------

function parseArgs(argv) {
	let proxy;
	let hook;
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
		} else if (a === '--hook') {
			hook = argv[++i];
		} else if (a.startsWith('--hook=')) {
			hook = a.slice('--hook='.length);
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
	return { url, proxy, hook };
}

const args = parseArgs(process.argv.slice(2));
const DEBUG = !!process.env.MPP_DEBUG;

// Info-level events (signer choice, session id, x402 signing trace, hook
// load) — unconditional. The DEBUG flag is for the JSON-RPC frame trace only.
function info(m) {
	console.error('[mpp-remote]', m);
}
function debug(...m) {
	if (DEBUG) console.error('[mpp-remote]', ...m);
}

// ---- env loading ---------------------------------------------------------

let wallet;
try {
	wallet = loadWalletEnv({ proxyOverride: args.proxy, logger: info });
} catch (e) {
	console.error(`mpp-remote: ${e.message}`);
	process.exit(2);
}

let assetAllowlist;
try {
	assetAllowlist = loadAssetAllowlist(process.env.MPP_ASSET_ALLOWLIST);
} catch (e) {
	console.error(`mpp-remote: ${e.message}`);
	process.exit(2);
}

const client = new McpClient({
	url: args.url,
	proxy: wallet.proxy,
	account: wallet.account,
	maxAmount: wallet.maxAmount,
	assetAllowlist,
	logger: info,
});

// ---- hook ----------------------------------------------------------------

let hook = null;
if (args.hook) {
	try {
		hook = await loadHook(args.hook);
		info(`hook: loaded ${args.hook} (${hook.tools.length} tool${hook.tools.length === 1 ? '' : 's'})`);
	} catch (e) {
		console.error(`mpp-remote: ${e.message}`);
		process.exit(2);
	}
}

// ---- MCP forwarding ------------------------------------------------------

async function forward(req) {
	// Hook intercept first: tools/call for a hook-owned tool short-circuits
	// the upstream forward entirely.
	if (hook && hookOwnsTool(hook, req)) {
		return dispatchHookCall(hook, req, { client, logger: info });
	}

	const res = await client.forwardRequest(req);

	// Augment tools/list with hook-provided tools on the way back.
	if (hook && req.method === 'tools/list' && res?.result) {
		res.result = injectHookTools(res.result, hook.tools);
	}

	return res;
}

// ---- stdio loop ----------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
	if (!line.trim()) return;
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		debug(`drop non-JSON line: ${line.slice(0, 80)}`);
		return;
	}
	debug('->', req.method, req.id ?? '(notif)');

	// Notifications have no id; forward fire-and-forget, no reply.
	if (req.id === undefined || req.id === null) {
		client.post(req).catch((e) => debug(`notification forward error: ${e.message}`));
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
