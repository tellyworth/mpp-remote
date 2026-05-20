/*
 * Resolve signer + spending cap + proxy from environment. Both signer modes
 * are mutually exclusive and exactly one must be configured: Privy CLI
 * (PRIVY_WALLET_ADDRESS, optional PRIVY_AGENT_WALLET_BIN) or a local hex key
 * (MPP_WALLET_PRIVATE_KEY).
 *
 * Throws on misconfiguration so the bridge can exit non-zero with a clean
 * message. `logger` receives one info-level line on success.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { privyAccount } from './privy.mjs';

export function loadWalletEnv({ proxyOverride = null, logger = () => {} } = {}) {
	const privyAddress = process.env.PRIVY_WALLET_ADDRESS;
	const privyBin = process.env.PRIVY_AGENT_WALLET_BIN || 'paw';
	const localKey = process.env.MPP_WALLET_PRIVATE_KEY;
	const maxAmount = parseFloat(process.env.MPP_MAX_AMOUNT_USD ?? '1.0');
	const proxy = proxyOverride || process.env.HTTPS_PROXY || process.env.ALL_PROXY || null;

	if (privyAddress && localKey) {
		throw new Error(
			'both PRIVY_WALLET_ADDRESS and MPP_WALLET_PRIVATE_KEY are set. Configure exactly one signer.',
		);
	}
	if (!privyAddress && !localKey) {
		throw new Error(
			'no signer configured. Set PRIVY_WALLET_ADDRESS (after `paw login`) for the ' +
				'Privy CLI path, or MPP_WALLET_PRIVATE_KEY for the local-key path.',
		);
	}

	const account = privyAddress
		? privyAccount({ binary: privyBin, address: privyAddress })
		: privateKeyToAccount(localKey);
	logger(`wallet: ${account.address} (${privyAddress ? 'privy' : 'local'})`);
	if (proxy) logger(`proxy: ${proxy}`);

	return { account, maxAmount, proxy };
}
