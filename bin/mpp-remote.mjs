#!/usr/bin/env node
/*
 * mpp-remote — stdio MCP bridge with MPP payment handling.
 *
 * Reads JSON-RPC requests from Claude Code (or any MCP client) over stdin,
 * forwards them to a remote HTTP MCP server, and transparently handles MPP
 * payment challenges (JSON-RPC -32042) by settling on-chain and retrying.
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
 *     MPP_WALLET_PRIVATE_KEY    0x-prefixed hex key for settlement
 *     MPP_MAX_AMOUNT_USD        per-call spending cap (default: 1.0)
 *     RPC_URL                   override blockchain RPC (default: chain's
 *                               viem-built-in public RPC)
 *     MPP_DEBUG                 if set, log forwarded JSON-RPC to stderr
 */

import readline from 'node:readline';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
	createWalletClient,
	createPublicClient,
	http,
	encodeFunctionData,
	parseUnits,
	getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as chains from 'viem/chains';

const USAGE = `Usage: mpp-remote [options] <url>

Options:
  --proxy <url>   proxy for upstream HTTP (http://, https://, socks5://, socks5h://)
  --help          show this help

Env:
  HTTPS_PROXY / ALL_PROXY    proxy URL (if --proxy not set)
  MPP_WALLET_PRIVATE_KEY     wallet key for settling MPP challenges
  MPP_MAX_AMOUNT_USD         per-call spending cap (default 1.0)
  RPC_URL                    override blockchain RPC
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

// Map MPP method.network strings to viem chain objects. The MPP spec leaves
// network naming loose; this covers the common shorthand used by x402-era
// servers. Extend as new networks appear.
const CHAIN_BY_NETWORK = {
	base: chains.base,
	'base-sepolia': chains.baseSepolia,
	mainnet: chains.mainnet,
	ethereum: chains.mainnet,
	sepolia: chains.sepolia,
	polygon: chains.polygon,
	optimism: chains.optimism,
	'optimism-sepolia': chains.optimismSepolia,
	arbitrum: chains.arbitrum,
};

const ERC20_TRANSFER_ABI = [
	{
		type: 'function',
		name: 'transfer',
		stateMutability: 'nonpayable',
		inputs: [
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
		],
		outputs: [{ name: '', type: 'bool' }],
	},
];

// Settle a challenge by sending an ERC20 transfer on-chain. This matches the
// x402-style "pay then submit tx hash as credential" pattern used by many
// MPP servers today. EIP-3009 transferWithAuthorization support is on the
// roadmap — see README.
async function settle(challenge) {
	if (!account) {
		throw new Error('MPP_WALLET_PRIVATE_KEY is not set; cannot settle challenge');
	}
	const amount = parseFloat(challenge.amount);
	if (!Number.isFinite(amount)) {
		throw new Error(`invalid challenge.amount: ${challenge.amount}`);
	}
	if (amount > MAX_AMOUNT) {
		throw new Error(
			`charge ${challenge.amount} exceeds MPP_MAX_AMOUNT_USD=${MAX_AMOUNT}`,
		);
	}

	// First method we know how to handle.
	const method = challenge.methods.find(
		(m) =>
			m.id?.startsWith('eip3009-usdc-') ||
			m.id?.startsWith('erc20-') ||
			m.currency_contract,
	);
	if (!method) {
		const ids = challenge.methods.map((m) => m.id).join(', ');
		throw new Error(`no installed method matches challenge methods: ${ids}`);
	}

	const chain = CHAIN_BY_NETWORK[method.network];
	if (!chain) {
		throw new Error(`unsupported network: ${method.network}`);
	}
	const rpc = process.env.RPC_URL ?? chain.rpcUrls?.default?.http?.[0];
	if (!rpc) {
		throw new Error(`no RPC URL for network ${method.network} (set RPC_URL)`);
	}

	console.error(
		`[mpp-remote] settling ${challenge.amount} ${method.currency} ` +
			`(sku=${challenge.sku}, network=${method.network})`,
	);

	const wallet = createWalletClient({ account, chain, transport: http(rpc) });
	const pub = createPublicClient({ chain, transport: http(rpc) });

	const data = encodeFunctionData({
		abi: ERC20_TRANSFER_ABI,
		functionName: 'transfer',
		args: [
			getAddress(method.recipient_address),
			parseUnits(challenge.amount, method.currency_decimals),
		],
	});
	const txHash = await wallet.sendTransaction({
		to: getAddress(method.currency_contract),
		data,
	});
	console.error(`[mpp-remote] tx submitted: ${txHash}`);

	const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
	if (receipt.status !== 'success') {
		throw new Error(`tx ${txHash} reverted`);
	}
	console.error(`[mpp-remote] settled in block ${receipt.blockNumber}`);

	return {
		method: method.id,
		challenge_id: challenge.challenge_id,
		opaque: challenge.opaque,
		settlement_tx_hash: txHash,
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
	if (req.method !== 'tools/call' || res?.error?.code !== -32042) {
		return res;
	}
	const challenges = res.error.data?.challenges;
	if (!Array.isArray(challenges) || challenges.length === 0) {
		return res;
	}
	try {
		const credential = await settle(challenges[0]);
		return await post({
			...req,
			params: {
				...req.params,
				_meta: {
					...(req.params?._meta ?? {}),
					'org.paymentauth/credential': credential,
				},
			},
		});
	} catch (e) {
		return {
			jsonrpc: '2.0',
			id: req.id,
			error: {
				code: -32042,
				message: `MPP settlement failed: ${e.message}`,
				data: res.error.data,
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
