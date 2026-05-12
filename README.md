# mpp-remote

A stdio↔HTTP MCP bridge that handles
[x402 v1](https://github.com/coinbase/x402) payment-required tool results
transparently, with native SOCKS5 proxy support.

Drop-in replacement for [`mcp-remote`](https://github.com/geelen/mcp-remote)
when the upstream MCP server uses x402 for per-call payments — `mpp-remote`
detects x402-shaped `CallToolResult { isError: true }` responses, signs an
EIP-3009 authorization with the configured wallet, retries the call with
`_meta["x402/payment"]`, and surfaces the facilitator's settlement receipt to
the agent in `_meta["x402/payment-response"]`.

The bridge signs **only** — it does not broadcast transactions. The resource
server's facilitator submits the on-chain `transferWithAuthorization`. Your
wallet needs the asset balance (e.g. USDC) but does **not** need ETH for gas.

## Status

Alpha. x402 v1 "exact" scheme on EVM chains
(Base, Base Sepolia, Ethereum, Sepolia, Polygon, Polygon Amoy).
Tested against the Cloudup MCP server backed by the Coinbase facilitator.

The name remains `mpp-remote` for npm/install URL stability — older versions
spoke MPP `-32042`. The current version speaks x402 v1 MCP transport
(`specs/transports-v1/mcp.md` in `coinbase/x402`). The MPP code path was
removed.

## Install

No install needed; use via `npx`:

```bash
npx -y github:tellyworth/mpp-remote --help
```

## Quick start with Claude Code

```bash
claude mcp add some-paid-mcp \
  -e HTTPS_PROXY=socks5h://127.0.0.1:8080 \
  -e MPP_WALLET_PRIVATE_KEY=0x... \
  -e MPP_MAX_AMOUNT_USD=0.50 \
  -- npx -y github:tellyworth/mpp-remote https://example.com/mcp
```

Once added, the agent calls tools as normal. When a tool returns an x402
payment-required result, `mpp-remote` signs an EIP-3009 authorization (subject
to the per-call cap), retries the call, and forwards the success result
verbatim — including the facilitator's settlement details in
`result._meta["x402/payment-response"]`.

## Configuration

Positional argument:

| Arg   | Description                       |
| ----- | --------------------------------- |
| `URL` | Remote HTTP MCP server (required) |

Flags:

| Flag             | Description                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `--proxy <url>`  | Proxy URL for upstream HTTP. Supports `http://`, `https://`, `socks5://`, `socks5h://`. Wins over env.   |
| `--help`         | Show usage.                                                                                              |

Environment variables:

| Var                       | Description                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| `HTTPS_PROXY`/`ALL_PROXY` | Proxy URL if `--proxy` is not given. Same scheme support as `--proxy`.       |
| `MPP_WALLET_PRIVATE_KEY`  | `0x`-prefixed hex key. Used to **sign** EIP-3009 authorizations (no gas).    |
| `MPP_MAX_AMOUNT_USD`      | Per-call spending cap. Default `1.0`. The bridge refuses any larger charge. |
| `MPP_DEBUG`               | If set, log forwarded JSON-RPC to stderr.                                    |

Env-var names are kept stable across the MPP→x402 transition so existing
configurations work without changes; only the wire protocol changed.

## How it works

```
your agent  ←stdio JSON-RPC→  mpp-remote  ←HTTPS (over SOCKS)→  remote MCP server
                                 │                                       │
                                 └── EIP-712 signing (viem)              └── facilitator
                                       (no chain RPC needed)                  (broadcasts tx)
```

1. The agent calls a tool over stdio.
2. `mpp-remote` forwards the call to the remote MCP server over HTTPS (through
   the configured proxy).
3. If the server replies with `result.isError = true` carrying a
   `PaymentRequirementsResponse` in `structuredContent` (per x402 v1 MCP
   transport), `mpp-remote` picks the first satisfiable `accepts[]` entry,
   signs an EIP-3009 `TransferWithAuthorization` struct with the wallet key,
   and retries the call with `params._meta["x402/payment"]` set to the
   `PaymentPayload`.
4. The success result flows back to the agent with the facilitator's
   `SettlementResponse` in `result._meta["x402/payment-response"]`
   (`{success, transaction, network, payer}`).

The bridge never inspects tool arguments. Any non-x402 error or success
response passes through verbatim.

## Why not just `mcp-remote`?

- **No payment handling.** `mcp-remote` is a plain stdio↔HTTP proxy; it has
  no x402 handler, no wallet, no signer. An agent talking to an x402 server
  through `mcp-remote` will see every paid tool fail with a payment-required
  result and no way to recover.
- **No SOCKS proxy support.** `mcp-remote` honours `HTTPS_PROXY` only when
  launched with `--enable-proxy`, and even then via undici's
  `EnvHttpProxyAgent`, which rejects `socks5://` / `socks5h://` URLs at
  startup. `mpp-remote` uses an explicit `socks-proxy-agent` and handles
  SOCKS schemes natively.

If you don't need payment handling, [`mcp-remote`](https://github.com/geelen/mcp-remote)
is the canonical choice. `mpp-remote` is for the x402-paid case.

## Roadmap

- Receipt caching for tools that accept receipts (`extend_share`-style flows).
- Per-tool allow/deny lists and daily-budget caps in addition to per-call.
- OAuth pass-through for non-anon MCP routes.
- Eventual deprecation, once MCP clients ship native x402 support and a
  separate stdio↔HTTP bridge is unnecessary.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
