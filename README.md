# mpp-remote

A stdio↔HTTP MCP bridge that handles [MPP](https://mpp.dev) payment challenges
transparently, with native SOCKS5 proxy support.

Drop-in replacement for [`mcp-remote`](https://github.com/geelen/mcp-remote)
when the upstream MCP server uses MPP for per-call payments — `mpp-remote`
detects JSON-RPC `-32042` ("Payment Required") responses, settles on-chain,
retries the call with the credential, and surfaces the receipt to the agent.

## Status

Alpha. Single payment method supported: ERC20 transfer on EVM chains
(Base, Base Sepolia, Optimism, Polygon, Arbitrum, Ethereum, Sepolia).
EIP-3009 `transferWithAuthorization` and managed-wallet methods (Tempo, Privy)
are on the roadmap.

## Install

No install needed; use via `npx`:

```bash
npx -y mpp-remote --help
```

## Quick start with Claude Code

```bash
claude mcp add some-paid-mcp \
  -e HTTPS_PROXY=socks5h://127.0.0.1:8080 \
  -e MPP_WALLET_PRIVATE_KEY=0x... \
  -e MPP_MAX_AMOUNT_USD=0.50 \
  -- npx -y mpp-remote https://example.com/mcp
```

Once added, the agent calls tools as normal. When a tool returns `-32042`,
`mpp-remote` pays out of the wallet (subject to the per-call cap), retries,
and returns the success result with `_meta["org.paymentauth/receipt"]`.

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
| `MPP_WALLET_PRIVATE_KEY`  | `0x`-prefixed hex key. Required to settle challenges.                        |
| `MPP_MAX_AMOUNT_USD`      | Per-call spending cap. Default `1.0`. The bridge refuses any larger charge. |
| `RPC_URL`                 | Override the blockchain RPC URL. Default: viem's built-in public RPC for the chain. |
| `MPP_DEBUG`               | If set, log forwarded JSON-RPC to stderr.                                    |

## How it works

```
your agent  ←stdio JSON-RPC→  mpp-remote  ←HTTPS (over SOCKS)→  remote MCP server
                                 │
                                 ├── EVM wallet (viem)
                                 └── blockchain RPC
```

1. The agent calls a tool over stdio.
2. `mpp-remote` forwards the call to the remote MCP server over HTTPS (through
   the configured proxy).
3. If the server replies with `error.code = -32042` and an MPP challenge in
   `error.data.challenges[]`, `mpp-remote` picks the first method it knows
   how to settle, sends the on-chain payment, and retries the call with the
   credential in `params._meta["org.paymentauth/credential"]`.
4. The success result (with the server's signed receipt in
   `result._meta["org.paymentauth/receipt"]`) flows back to the agent
   unchanged.

The bridge never inspects tool arguments — it only intercepts `-32042`. Any
non-payment error or success response passes through verbatim.

## Why not just `mcp-remote`?

- **No payment handling.** `mcp-remote` is a plain stdio↔HTTP proxy; it has
  no `-32042` handler, no wallet, no method registry. An agent talking to an
  MPP server through `mcp-remote` will see payment challenges surface as
  tool errors with no way to recover.
- **No SOCKS proxy support.** `mcp-remote` honours `HTTPS_PROXY` only when
  launched with `--enable-proxy`, and even then via undici's
  `EnvHttpProxyAgent`, which rejects `socks5://` / `socks5h://` URLs at
  startup. `mpp-remote` uses an explicit `socks-proxy-agent` and handles
  SOCKS schemes natively.

If you don't need payment handling, [`mcp-remote`](https://github.com/geelen/mcp-remote)
is the canonical choice. `mpp-remote` is for the MPP-paid case.

## Roadmap

- EIP-3009 `transferWithAuthorization` (gas-free for the user).
- Managed-wallet methods: Tempo session keys, Privy agent CLI.
- Receipt caching for tools that accept receipts (`extend_share`-style flows).
- Per-tool allow/deny lists and daily-budget caps in addition to per-call.
- OAuth pass-through for non-anon MCP routes.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
