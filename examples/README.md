# Connect a local AI client to JPYdf

This local alpha example exposes offline LP simulation and SDK reads through
MCP over stdio. Production mode reads through the public production descriptor;
the `TEST_ONLY_NOT_FOR_PRODUCTION` canary and staging modes use separately
pinned, access-controlled manifests.

For Japanese instructions, see [日本語の接続手順](README.jp.md).

## Start the read-only server

Use Node 22+ for this example and the SDK. To run it from a source checkout,
build the SDK from the repository root. In the public `deltaforesight/jpydf-sdk`
repository:

```sh
npm ci
npm run build
```

In the monorepo:

```sh
pnpm install --frozen-lockfile
pnpm --filter @jpydf/sdk build
```

A standalone trial bundle can also be tested outside the repository. From the extracted
bundle directory, run `npm ci --ignore-scripts`, then use its `examples/mcp-stdio.mjs`
path in the client configuration. The bundle includes the SDK tarball and examples;
its root README records the applicable release boundary.

For offline simulation, create a local configuration file containing
`JPYDF_MODE=offline`. No manifest, RPC, account, or wallet is required.

For chain reads, have the local operator create an owner-readable configuration
file outside the repository with the following variables:

| Variable | Trusted startup value |
| --- | --- |
| `JPYDF_MODE` | `production`, `mainnet-staging` or `mainnet-canary` (default when omitted) |
| `JPYDF_MANIFEST_PATH` | Absolute path to the unmodified file for that mode: `descriptors/jpydf-production.json` from the SDK source repository for `production`, or the access-controlled manifest for staging or canary |
| `JPYDF_RPC_URL` | Operator-approved Ethereum mainnet HTTPS RPC endpoint |
| `JPYDF_ACCOUNT` | Address assigned to this local user's session; no private key |

Do not put these values in model prompts or tool arguments. Give the MCP client
the following local server entry, replacing the executable and file paths:

```json
{
  "mcpServers": {
    "jpydf-read-only": {
      "command": "/absolute/path/to/node",
      "args": [
        "--env-file=/absolute/path/to/private/jpydf-agent.env",
        "/absolute/path/to/bundle/examples/mcp-stdio.mjs"
      ]
    }
  }
}
```

The client launches one process; each chain session binds one locally trusted user/account. There is
no network listener or remote authentication. Do not wrap this example in a
public HTTP endpoint or create unbounded subprocesses per request. The existing
SDK transport bounds physical RPC work within each process; independent
processes have independent limits. A hosted service needs authenticated sessions,
global admission, and externally verified monitoring before launch.

## Discover tools and read one bounded result

For a chain mode, the MCP client initializes the server, lists tools, then calls `integration.get`
with `{}`. `tools/list` combines the SDK simulation catalog and the selected session's read catalog;
input validation and typed errors come from the SDK. No copied schemas or ABIs
are required in the client.

Then call `protocol.get` to obtain branch bindings, `account.get` for the configured
account, or `market.get` with `{"branchId":1}`. For a liquidation discovery page:

```json
{"name":"liquidation.scan","arguments":{"branchId":1,"maxIterations":32,"startId":"0"}}
```

Production sessions also list `jpydfUsdc.pool`, which reads the JPYdf/USDC
Uniswap v4 pool, and `jpydfUsdc.quote`, which quotes an exact-input swap. The pool
price is the JPYdf market price and can differ from the ¥1 reference; a quote is
not a guaranteed fill.

Chain results include the SDK's `testOnly` flag (`false` only in production),
deployment identity, and raw decimal-string amounts. Preserve the block identity
returned with market and liquidation data.
Both MCP text and `structuredContent` carry the same SDK response. A failed SDK
operation sets `isError: true`; branch on `error.code`, `retryable`, and
`retryAfterMs`, not the message. The adapter neither retries nor paginates.

For multi-page scans, set a finite page/iteration budget, stop on a repeated
cursor, deduplicate by branch ID and trove ID, and report incomplete results
when the budget runs out. Preserve each page's block identity; the aggregate
is not an atomic snapshot. Candidates never authorize, select, enqueue, or
trigger liquidation. Execution belongs to the separately governed Rust bot
with fresh revalidation and an approved target.

## Simulate an LP scenario

Offline mode lists only `lp.simulate`; chain modes include it alongside reads.
Call it with all seven human-unit decimal strings:

```json
{
  "name": "lp.simulate",
  "arguments": {
    "budgetJpy": "1000000",
    "fxJpyPerUsd": "150",
    "spotJpydfPerUsdc": "150",
    "lowerJpydfPerUsdc": "140",
    "upperJpydfPerUsdc": "160",
    "futureFxJpyPerUsd": "155",
    "futureJpydfJpy": "1"
  }
}
```

`budgetJpy` is the yen budget. FX fields are yen per dollar; spot and range
fields are JPYdf per USDC; `futureJpydfJpy` is yen per JPYdf. Values must be
positive, use at most six fractional digits, and contain no exponent notation.
The budget limit is 1e12 yen, FX/range/spot limits are 1e6, and the future JPYdf
price limit is 10 yen. Lower must be below upper; the implied future JPYdf/USDC
ratio must be between 0.000001 and 1000000. Numbers and unknown fields are rejected.

The shared LP Lab calculation assumes USDC=$1 and excludes fees, rewards, gas,
and rebalancing. It returns initial token amounts, invested and unused yen,
effective price range, and future value compared with holding the initial basket.
Initial amounts include integer base-unit strings; future values are numeric
estimates. The response declares units, assumptions, `simulationOnly: true`,
and `liveData: false`; it has no deployment or observed block identity.

This server offers simulation and reads only. It returns no executable ticks,
liquidity, or calldata and exposes no LP placement, rebalancing, Earn preparation,
finalization, wallet, or broadcast tools. Writes are rejected even if the adapter
receives a write-enabled SDK model capability.

Source examples are excluded from the SDK tarball. Third-party trials use a reviewed
standalone bundle with its own startup and dependency checks. Ask the bundle
provider for the trial support contact and the approved staging manifest handoff;
chain configuration is delivered separately. Canary is internal testing only.
Passing a site-readiness scanner does not satisfy the requirements for a hosted
service.

## Verify the connection

In the public SDK repository, `npm test` builds the package and runs the unit
tests and the release-boundary check. The compatibility runner then checks the
packed tarball; set `JPYDF_SDK_VIEM` to `2.31.4` (minimum) or `2` (current):

```sh
npm test
dir="$(mktemp -d)"
tarball="$(npm pack --ignore-scripts --pack-destination "$dir")"
JPYDF_SDK_TARBALL="$dir/$tarball" JPYDF_SDK_VIEM=2 node scripts/check-compatibility.mjs
```

In the monorepo:

```sh
pnpm --filter @jpydf/sdk test
pnpm --filter @jpydf/sdk test:release-boundary
JPYDF_SDK_VIEM=2 pnpm --filter @jpydf/sdk test:compatibility
```

In an extracted controlled bundle, run `node --test test/mcp-modes.test.mjs`
after `npm ci --ignore-scripts`. This checks offline stdio using the installed
tarball and does not require live RPC credentials.

The tests exercise MCP initialization, tool discovery, SDK reads and validation,
error propagation, and write rejection using the official MCP client over an
in-memory transport with mocked RPC. A separate subprocess test checks stdio
startup failures for missing configuration or an unreadable manifest. These
checks do not verify live RPC reads. Offline stdio and clean-consumer checks must
be verified through the compatibility runner; passing SDK unit tests alone is
not evidence of either. No wallet or live RPC credentials are needed. For connection failures, first check the
local paths, build output, and SDK manifest pin; never paste credentials into
an issue or chat.
