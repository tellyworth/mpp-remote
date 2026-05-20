/*
 * Privy adapter: signs EIP-712 typed data by shelling out to
 * @privy-io/agent-wallet-cli (`paw rpc --json`). The CLI POSTs to Privy's
 * /v1/wallets/<id>/rpc with the caller's authorization keypair (provisioned
 * by `paw login` and stored in the OS keychain), so no private key ever
 * touches this process or the user's filesystem.
 *
 * The returned object matches viem's Account interface for the one method
 * signPayment needs: signTypedData. That's all the bridge uses.
 */

import { spawnSync } from 'node:child_process';
import { getAddress, isHex } from 'viem';

export function privyAccount({ binary, address }) {
	return {
		address: getAddress(address),
		async signTypedData({ domain, types, primaryType, message }) {
			const body = JSON.stringify({
				method: 'eth_signTypedData_v4',
				params: {
					typed_data: {
						domain,
						types,
						message,
						...(primaryType ? { primary_type: primaryType } : {}),
					},
				},
			});
			const r = spawnSync(binary, ['rpc', '--json', body], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			if (r.error) {
				throw new Error(
					`failed to invoke ${binary}: ${r.error.message}. Install with ` +
						`\`npm i -g @privy-io/agent-wallet-cli\` or set PRIVY_AGENT_WALLET_BIN.`,
				);
			}
			if (r.status !== 0) {
				const detail = (r.stderr || r.stdout || '').trim();
				throw new Error(`${binary} rpc failed (exit ${r.status}): ${detail}`);
			}
			let parsed;
			try {
				parsed = JSON.parse(r.stdout.trim());
			} catch {
				throw new Error(`${binary} rpc returned non-JSON: ${r.stdout.slice(0, 200)}`);
			}
			// Response shape varies — the CLI's own internal helper falls back through
			// .data.signature → .signature → .data, so we do the same.
			const sig = parsed.data?.signature ?? parsed.signature ?? parsed.data;
			if (typeof sig !== 'string' || !isHex(sig)) {
				throw new Error(
					`${binary} rpc returned no signature (got: ${JSON.stringify(parsed).slice(0, 200)})`,
				);
			}
			return sig;
		},
	};
}
