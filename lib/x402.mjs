/*
 * x402 v1 helpers — chain map, EIP-712 typed data, asset allowlist, payment
 * signing.
 *
 * Wire shape matches the x402 v1 MCP transport spec
 * (coinbase/x402 specs/transports-v1/mcp.md). Pure helpers — no axios, no
 * stdin, no module-level mutable state.
 */

import { randomBytes } from 'node:crypto';
import { getAddress } from 'viem';

// x402 v1 EVM network → chainId. Subset of EVM_NETWORK_CHAIN_ID_MAP from
// coinbase/x402 mechanisms/evm/v1. Extend if servers advertise more.
export const CHAIN_ID_BY_NETWORK = {
	base: 8453,
	'base-sepolia': 84532,
	ethereum: 1,
	sepolia: 11155111,
	polygon: 137,
	'polygon-amoy': 80002,
};

// EIP-3009 TransferWithAuthorization typed-data structure (x402 v1 §6.1.1).
export const EIP3009_TYPES = {
	TransferWithAuthorization: [
		{ name: 'from', type: 'address' },
		{ name: 'to', type: 'address' },
		{ name: 'value', type: 'uint256' },
		{ name: 'validAfter', type: 'uint256' },
		{ name: 'validBefore', type: 'uint256' },
		{ name: 'nonce', type: 'bytes32' },
	],
};

// Cap on signed authorization validity, regardless of what the server requests.
// Each signed auth is independently replayable on-chain until validBefore (or
// until first submission). An unbounded window turns one approved payment into
// a long-lived blank check; 5 minutes is generous for facilitator latency.
export const MAX_AUTH_LIFETIME_SECONDS = 300;

// Per-chain allowlist of acceptable assets. The bridge refuses to sign for any
// (chainId, asset) pair not in this map. Each entry pins:
//   - decimals: used for the MPP_MAX_AMOUNT_USD cap math. A misconfigured
//     decimals lets a server quote a "0.20"-looking integer that signs away
//     orders of magnitude more on-chain value.
//   - domain.name / domain.version: the EIP-712 domain the bridge will sign
//     under. These are server-supplied in PaymentRequirements.extra and the
//     bridge must verify them, otherwise the server picks the domain
//     separator and gets a signing oracle for arbitrary EIP-712-shaped data.
// To extend without patching this file, callers can merge additional entries
// via loadAssetAllowlist(env) — see below.
export const BUILTIN_ASSET_ALLOWLIST = {
	// Base mainnet — native USDC (Circle).
	8453: {
		'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': {
			decimals: 6,
			domain: { name: 'USDC', version: '2' },
		},
	},
	// Base Sepolia testnet — USDC.
	84532: {
		'0x036CbD53842c5426634e7929541eC2318f3dCF7e': {
			decimals: 6,
			domain: { name: 'USDC', version: '2' },
		},
	},
};

function checksumAllowlist(raw) {
	const out = {};
	for (const [chainId, assets] of Object.entries(raw)) {
		out[Number(chainId)] = {};
		for (const [addr, entry] of Object.entries(assets)) {
			out[Number(chainId)][getAddress(addr)] = entry;
		}
	}
	return out;
}

// Build the effective asset allowlist by merging the built-in entries with
// the optional MPP_ASSET_ALLOWLIST JSON env var. Throws on malformed JSON;
// callers should surface the message to stderr and exit non-zero.
export function loadAssetAllowlist(rawJson) {
	const merged = JSON.parse(JSON.stringify(BUILTIN_ASSET_ALLOWLIST));
	if (rawJson) {
		let extra;
		try {
			extra = JSON.parse(rawJson);
		} catch (e) {
			throw new Error(`MPP_ASSET_ALLOWLIST is not valid JSON: ${e.message}`);
		}
		for (const [chainId, assets] of Object.entries(extra)) {
			merged[chainId] = { ...(merged[chainId] ?? {}), ...assets };
		}
	}
	return checksumAllowlist(merged);
}

// Pull a PaymentRequirementsResponse out of a tools/call result, returning
// null if this isn't an x402 payment-required signal. The MCP transport spec
// puts it in result.structuredContent; clients SHOULD fall back to
// content[0].text.
export function extractX402Requirements(result) {
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
// human-readable number for the spending cap check, using the decimals from
// the matched allowlist entry. Using a fixed default here would let a server
// quote a value in a non-6-decimal asset whose 6-decimal interpretation
// passes the cap.
export function atomicToFloat(amountAtomic, decimals) {
	const n = BigInt(amountAtomic);
	const divisor = 10n ** BigInt(decimals);
	const whole = Number(n / divisor);
	const frac = Number(n % divisor) / Number(divisor);
	return whole + frac;
}

// Sign an x402 PaymentRequirementsResponse and return the PaymentPayload that
// goes into params._meta["x402/payment"]. Throws on any safety check failure:
//   - no satisfiable requirement (unknown network or scheme)
//   - missing extra.name / extra.version
//   - asset not in allowlist
//   - domain mismatch vs allowlist entry
//   - charge exceeds maxAmount
//
// `logger(msg)` is called once per sign with an info-level one-liner.
export async function signPayment(requirementsResponse, account, maxAmount, assetAllowlist, logger = () => {}) {
	if (!account) {
		throw new Error('no signer configured; cannot sign x402 payment');
	}

	const accepts = requirementsResponse.accepts;
	if (!Array.isArray(accepts) || accepts.length === 0) {
		throw new Error('x402 PaymentRequirementsResponse has no accepts[]');
	}

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

	const chainId = CHAIN_ID_BY_NETWORK[req.network];
	const assetAddress = getAddress(req.asset);
	const allowlistEntry = assetAllowlist[chainId]?.[assetAddress];
	if (!allowlistEntry) {
		throw new Error(
			`asset ${assetAddress} on chain ${chainId} (${req.network}) is not in the asset allowlist; ` +
				`extend BUILTIN_ASSET_ALLOWLIST or set MPP_ASSET_ALLOWLIST`,
		);
	}
	if (
		req.extra.name !== allowlistEntry.domain.name ||
		req.extra.version !== allowlistEntry.domain.version
	) {
		throw new Error(
			`EIP-712 domain for ${assetAddress} (${req.network}) must be ` +
				`name=${JSON.stringify(allowlistEntry.domain.name)} version=${JSON.stringify(allowlistEntry.domain.version)}, ` +
				`server quoted name=${JSON.stringify(req.extra.name)} version=${JSON.stringify(req.extra.version)}`,
		);
	}

	const amountFloat = atomicToFloat(req.maxAmountRequired, allowlistEntry.decimals);
	if (amountFloat > maxAmount) {
		throw new Error(
			`charge ${amountFloat} ${allowlistEntry.domain.name} exceeds MPP_MAX_AMOUNT_USD=${maxAmount}`,
		);
	}

	const now = Math.floor(Date.now() / 1000);
	const requestedLifetime = req.maxTimeoutSeconds ?? 60;
	const lifetime = Math.min(requestedLifetime, MAX_AUTH_LIFETIME_SECONDS);
	const authorization = {
		from: account.address,
		to: getAddress(req.payTo),
		value: req.maxAmountRequired,
		// 10 min in the past for clock-skew headroom; matches x402 reference impl.
		validAfter: String(now - 600),
		validBefore: String(now + lifetime),
		nonce: '0x' + randomBytes(32).toString('hex'),
	};

	const domain = {
		name: allowlistEntry.domain.name,
		version: allowlistEntry.domain.version,
		chainId,
		verifyingContract: assetAddress,
	};

	logger(
		`signing x402 payment ${amountFloat} ${allowlistEntry.domain.name} ` +
			`(${req.network}, asset=${assetAddress}, resource=${req.resource ?? '?'})`,
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
