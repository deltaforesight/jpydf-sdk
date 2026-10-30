# `@jpydf/sdk`

Headless ESM TypeScript SDK for JPYdf market/risk reads and Stability Pool
transaction preparation. The root SDK requires Node 22+ or a browser with Web
Crypto. The `/agent` host entrypoint is Node 22+ only because it uses Node's
killable HTTPS request boundary. `viem` is the only peer dependency.

This 0.x public preview supports the read-only production scope loaded from the
public production descriptor, plus offline LP simulation. The separately pinned
mainnet canary and staging deployments remain `TEST_ONLY_NOT_FOR_PRODUCTION` for
internal testing. The package contains no deployment address or RPC URL. Install
it with `viem`:

```sh
npm install @jpydf/sdk viem
```

## Production descriptor

`descriptors/jpydf-production.json` is the sanitized public production descriptor
(SDK-GOV-002 §1). It is outside the package tarball. `loadProductionDeployment({ descriptorJson })` accepts only its exact bytes (the package pins the SHA-256), and the `production` scope is read-only: market and account reads plus `getJpydfUsdcPool` / `quoteJpydfUsdc`, with no transaction preparation (SDK-FR-007).
Rebuild it only from the reviewed production manifest and verify it against mainnet:

```sh
node scripts/build-production-descriptor.mjs /path/to/deployment-manifest.json
RPC_URLS="$RPC_A,$RPC_B" node scripts/verify-production-descriptor.mjs
```

## Public source mirror

The generated `deltaforesight/jpydf-sdk` repository builds and tests with
`npm ci && npm test`. It includes the generated bindings and a dependency lock.
Its `.github/workflows/publish.yml` publishes exact `v0.x` tags to the npm
`latest` tag with trusted publishing, provenance, and human approval. The
published file is the tarball that passed the minimum / current viem matrix.

## Security and support

Report suspected SDK vulnerabilities through
[GitHub Private Vulnerability Reporting](https://github.com/deltaforesight/jpydf-sdk/security/advisories/new).
See the [security policy](https://github.com/deltaforesight/jpydf-sdk/security/policy)
for reporting requirements and the supported alpha version scope.
Use [SDK issues](https://github.com/deltaforesight/jpydf-sdk/issues)
for integration questions and non-sensitive bugs.

## Current feature boundary

| Feature | Current mainnet-canary SDK support |
| --- | --- |
| Borrow | Fixed-block protocol price, average rate, debt, collateral, TCR, MCR, CCR, SCR, minimum debt, and gas compensation. Borrow transaction preparation is not exposed yet. |
| Lend | JPYdf has no separate lending market in this release. `lend` maps to Stability Pool Earn. |
| Earn | Account position and rewards, market APR/coverage, and staged deposit/withdraw/claim/compound preparation. |
| Swap | Product routing remains disabled (`unwired-audit-scope`). A manual test-only helper can quote and prepare unsigned calldata for the retained fixed UniV4 PoolKey; it cannot broadcast. |
| Liquidate | Bounded candidate scanning only. The Rust liquidator remains the execution path and must revalidate every candidate immediately before sending. |
| Rates | Fixed-block protocol price, average borrow rate, Stability Pool APR, coverage, vault backing, and pause/shutdown state. |
| Agent/integration | Strict read operation catalog; Earn writes require host admission and a separate finalization capability. |

Use `client.capabilities` or the agent `integration.get` operation instead of
assuming that an unavailable feature is wired.

## Human developer flow

The caller supplies the exact raw access-controlled manifest text, its own RPC
URL, and an injected wallet provider. Do not parse and reserialize the manifest
before loading it because the SDK verifies its exact SHA-256 bytes.

```ts
import {
  createJpydfClient,
  JpydfSdkError,
  loadMainnetCanaryDeployment,
} from "@jpydf/sdk";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  type EIP1193Provider,
  http,
  parseUnits,
} from "viem";
import { mainnet } from "viem/chains";

export async function depositToJpydf(
  manifestJson: string,
  rpcUrl: string,
  walletProvider: EIP1193Provider,
): Promise<`0x${string}`> {
  const deployment = await loadMainnetCanaryDeployment({ manifestJson });
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    chain: mainnet,
    transport: custom(walletProvider),
  });
  const [account] = await walletClient.requestAddresses();
  const jpydf = createJpydfClient({
    publicClient,
    deployment,
    scope: "mainnet-canary",
  });

  const state = await jpydf.getAccount(account as Address);
  console.log(state.jpydfBalance, state.pools);
  const market = await jpydf.getMarket({ branchId: 1 });
  console.log(market.protocolPriceRaw, market.averageBorrowRateRaw, market.stabilityPoolAprRaw);

  const preview = await jpydf.prepareEarnDeposit({
    account,
    branchId: 1,
    amountRaw: parseUnits("1000", 18),
    claim: false, // Compound accrued rewards; use true to pay them to the account.
  });
  // Show the preview and obtain explicit user confirmation here.
  // `preview` intentionally contains no transaction calldata.

  const ready = await jpydf.prepareForSignature(preview.reference);
  if (await walletClient.getChainId() !== ready.chainId) {
    throw new Error("Wrong wallet chain");
  }
  if (account.toLowerCase() !== ready.actor.toLowerCase()) {
    throw new Error("Wrong wallet account");
  }
  if (await publicClient.getBlockNumber() > ready.validUntilBlock) {
    throw new Error("Action expired");
  }

  const hash = await walletClient.sendTransaction({
    ...ready.transaction,
    chain: mainnet,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Transaction failed");
  return hash;
}

export function handleJpydfError(
  error: unknown,
): "abort" | "prepare-again" | "retry-later" {
  if (!(error instanceof JpydfSdkError)) return "retry-later";
  if (error.code === "STALE_BLOCK" || error.code === "ACTION_EXPIRED") {
    return "prepare-again";
  }
  if (
    error.code === "NEXT_BLOCK_REQUIRED"
    || error.code === "ORACLE_UNAVAILABLE"
    || error.code === "RATE_LIMITED"
  ) {
    return "retry-later";
  }
  return "abort";
}
```

The Stability Pool moves JPYdf through `JpydfToken.sendToPool`, so deposits do
not require an ERC-20 approval. The SDK does not sign, broadcast, hold keys, or
approve spending. It returns calldata only after a fresh final simulation.

Account reads expose `jpydfBalance` and per-pool `compoundedDeposit`,
`hasRecordedDeposit`, and claimable JPYdf/collateral rewards. Token metadata
uses the explicit `dToken` and `underlyingToken` names. All amounts are raw
`bigint`; use viem `parseUnits` and `formatUnits`.

`prepareUniV4WalletSmoke` is limited to a `0.1–1 test-df` sell through the
pinned `test-df/USDC`, fee `500`, spacing `10`, no-hook PoolKey. It returns an
unsigned exact ERC-20 approval, exact Permit2 approval, and Universal Router
calldata with a ten-minute maximum deadline and
`mainnetBroadcastAuthorized: false`. Decode the swap with
`decodeMainnetCanaryUniV4Swap` before requesting a separate transaction
approval. Normal browser wallet submission is not used by the canary drill
because it cannot prove access-controlled dRPC-only delivery.

The route addresses are not embedded in the package. Load the exact
access-controlled route text with `loadMainnetCanaryUniV4Route({ routeJson })`,
then pass the returned frozen route to `prepareUniV4WalletSmoke`. The loader
rejects any byte change against the package-pinned route SHA-256.

Rates and collateral ratios use 18-decimal WAD units. `getMarket` pins its
oracle, debt, vault, and pool reads to one observed block, then rechecks that
block's canonical hash. It resolves the PriceFeed proxy's active source and
requires its JPY provider to match the pinned deployment. It reports JPY/USD
source state as `live` or `frozen`; liquidation discovery fails closed while
frozen or stale. An approved provider rotation therefore needs a reviewed SDK
pin update instead of automatic trust. A `null` derived rate
means its denominator is zero. Stability Pool APR is zero after branch shutdown,
and an unavailable protocol oracle fails closed with `ORACLE_UNAVAILABLE`.

`scanLiquidationCandidates` accepts a cursor and 1–128 iterations. Agent calls
always include the final zombie candidate; the human API exposes the underlying
boolean for advanced pagination. Results are discovery data, not execution
authorization: price, MCR, trove state, Stability Pool capacity, gas, and
profitability can change before inclusion. Deduplicate `troveId` when joining
multiple pages because the final zombie can appear in each page.

Deposit intents use `amountSemantics: "exact"`. Withdrawal intents use
`amountSemantics: "maximum"` because the contract withdraws the lesser of the
requested amount and the deposit available when the transaction executes.
Full withdrawals force reward claiming so compounded yield is not silently
re-deposited. After a withdrawal, reconcile from its successful receipt and a
fresh account read. `validUntilBlock` limits SDK handoff; it is not an on-chain
transaction deadline.

## Offline LP simulation

`simulateLp` from `@jpydf/sdk` uses the same calculation as LP Lab. It accepts
seven positive decimal strings in human units, not token base units. The standalone bundle
includes runnable MCP requests and input-unit documentation in its examples guide.
`createJpydfLpSimulationModel` from `@jpydf/sdk/agent` exposes it as `lp.simulate`.
The result declares its assumptions and `simulationOnly: true`, `liveData: false`.
It contains no executable ticks, liquidity, or calldata. This calculation needs
no deployment manifest, RPC, or wallet.

## Agent host flow

For an MCP client, the source checkout includes a runnable read-only stdio server
in `examples/mcp-stdio.mjs`, with setup in the adjacent `README.md`.
It exposes SDK read and offline simulation catalogs through the official MCP SDK
and delegates input validation to this SDK. Offline mode needs no manifest or RPC;
production mode reads the public production descriptor, and canary and staging
modes use their separate pins. These examples are excluded from the tarball.
Third-party trial distribution needs a reviewed standalone bundle.

Staging uses `loadMainnetStagingDeployment`, scope `"mainnet-staging"`, and
`createJpydfMainnetStagingAgentClient`. It exposes reads only and no `.host`;
root transaction preparation also rejects staging. The canary API below retains
its separate deployment pin and optional host admission.

Agent sessions are read-only by default. The model capability receives typed
operations, JSON input schemas, and intent previews, but never receives
calldata. The separate host capability may opt into bounded writes and call
`finalize` only after user approval.

```ts
import { loadMainnetCanaryDeployment } from "@jpydf/sdk";
import {
  createJpydfMainnetCanaryAgentClient,
  createJpydfMainnetRpcClient,
  getJpydfRpcHealth,
} from "@jpydf/sdk/agent";
import type { JpydfAgentFinalizationAuthorization } from "@jpydf/sdk/agent";
import type { Address } from "viem";

export async function createAgentHost(
  manifestJson: string,
  rpcUrl: string,
  authorizeFinalization: (
    authorization: JpydfAgentFinalizationAuthorization,
  ) => boolean,
) {
  const deployment = await loadMainnetCanaryDeployment({ manifestJson });
  // rpcUrl is trusted startup configuration, never model or tenant input.
  // Create one client at host startup and share it across sessions.
  const sharedRpc = createJpydfMainnetRpcClient({ rpcUrl });

  return {
    createSession(account: Address) {
      return createJpydfMainnetCanaryAgentClient({
        publicClient: sharedRpc,
        deployment,
        scope: "mainnet-canary",
        account,
        authorizeFinalization,
        writeAdmission: {
          allowedOperations: ["earn.deposit"],
          allowedBranchIds: [1],
          allowedRewardModes: ["compound"],
          expiresAtMs: Date.now() + 5 * 60_000,
          maxAmountRaw: 1_000n * 10n ** 18n,
          maxPendingAmountRaw: 2_000n * 10n ** 18n,
        },
      });
    },
    getHealth: () => getJpydfRpcHealth(sharedRpc),
  };
}

declare const consumePreloadedApproval: (
  authorization: JpydfAgentFinalizationAuthorization,
) => boolean;
declare const preloadDurableApproval: (
  revalidationId: string,
  options: { signal: AbortSignal },
) => Promise<void>;
const agentHost = await createAgentHost(manifestJson, rpcUrl, consumePreloadedApproval);
const session = agentHost.createSession(account);

// Pass only this capability to the model runtime.
const modelCapability = session.model;
const capabilities = await modelCapability.invoke({ operation: "integration.get", input: {} });
const market = await modelCapability.invoke({ operation: "market.get", input: { branchId: 1 } });
const candidates = await modelCapability.invoke({
  operation: "liquidation.scan",
  input: { branchId: 1, maxIterations: 32, startId: "0" },
});
const current = await modelCapability.invoke({ operation: "account.get", input: {} });
const preview = await modelCapability.invoke({
  operation: "earn.deposit",
  input: {
    branchId: 1,
    amountRaw: (1_000n * 10n ** 18n).toString(),
    claim: false,
  },
});
// Return the preview to the approval UI and stop here.

// Call this host-only path later, after explicit approval.
export async function finalizeApprovedDeposit(revalidationId: string) {
  await preloadDurableApproval(revalidationId, { signal: AbortSignal.timeout(5_000) });
  return session.host.finalize(revalidationId);
}
```

Create a separate agent client per authenticated principal/account and share the
deadline RPC client. The transport also enforces its physical-work bound across
all clients in the same JavaScript runtime, so an accidental second client
cannot multiply the limit; sharing still keeps endpoint ownership, circuit
state, and monitoring simple. Worker threads and child processes are separate
runtimes, so cap them at the host and monitor each one. Allowlist the configured
RPC origin and independently monitor mainnet chain ID and head through a
separate provider.
Prepared IDs are one-use, process-local, expire after five minutes, and are
capped at 32 per session. `maxPendingAmountRaw` is only an in-process admission
limit; successful finalization or expiry releases it. It is not a durable spend
budget or authorization. Write-enabled sessions therefore require an
`authorizeFinalization` callback. The host must consult authenticated, durable
storage before `finalize`; the callback then synchronously consumes the
preloaded approval and returns `true` only when it matches the exact actor,
prepared reference, and revalidation ID supplied to the callback. The callback
must not perform I/O or return a Promise; a non-boolean result permanently disables authorization for
that session, so create a new session after correcting the host. Bound admission
for the asynchronous preload, cancel its physical work at its deadline, and
monitor it outside the SDK. If a host restarts or routes to another instance,
prepare a new intent. Hosts must still add durable spend budgets, principal rate
limits, explicit wallet confirmation, receipt/idempotency handling, and never
expose wallet secrets.
For amount operations, `claim` is required and the host must explicitly allow
the matching `claim` or `compound` reward mode.

The Node HTTPS RPC transport performs no automatic retries, bounds active HTTP
work and response bytes, and uses closed/open/bounded half-open circuit states.
At the caller deadline it destroys the underlying `ClientRequest` and keeps the
physical request accounted for until the socket closes. Fault tests terminate
all 15 regular requests and two consecutive stuck recovery probes, then verify
automatic recovery while concurrent traffic continues. Monitor active count,
configured limit, oldest outstanding age, circuit state, recovery probe, and
stuck probe externally. Production verification must still run longer than the
configured timeout and cooldown and must verify a test incident reaches the
intended human recipient.

## Deployment and release boundary

The canary and staging loaders each verify their separate manifest SHA-256,
test-only identity, chain ID 1, profile, deployment ID, CREATE2 salt, parameters,
admin separation, and branch 0/1 allowlist. Canary retains its deliberately
unwired product swap route; staging is read-only. Packing in the monorepo
additionally requires the access-controlled canary manifest to be present and
match the pin.

A stable 1.0 release requires a separate decision to freeze the public API and
support window. Offering an agent host on the public production path requires
verified physical RPC work bounds, recovery probes, external monitoring, and a
test incident delivered to a human recipient. The canary identity must not be
renamed or reused as a production preset, descriptor, or package.

## License

The SDK code is MIT-licensed. This does not relicense JPYdf or Liquity V2
contracts, which retain their applicable BUSL-1.1 terms, or any project names,
logos, or trademarks. The `viem` peer dependency retains its own MIT license.
