# agentic-endpoints

Client for [agentic-endpoints](https://ai.oliverkiss.com) — pay-per-call HTTP
utilities for autonomous AI agents, settled in USDC on Base via
[x402](https://x402.org). No signup, no API key, no invoice.

The reason to install this is `exactlyOnce`.

```bash
npm install agentic-endpoints
```

## Run an action exactly once across a fleet of agents

When several agents share a queue, two of them will eventually pick up the
same job. If that job charges a card or sends an email, you have a real
problem, and you cannot solve it inside one agent: an in-process lock only
knows about itself.

```ts
import { AgenticEndpoints } from "agentic-endpoints";

const client = new AgenticEndpoints({ creditToken: process.env.CREDIT_TOKEN });

const { outcome, result } = await client.exactlyOnce(
  {
    namespace: "billing",
    actionKey: `charge:${order.id}`,
    namespaceToken: process.env.NAMESPACE_TOKEN,
    leaseTtl: 300,
  },
  async () => stripe.charges.create({ amount: order.total }),
);

// outcome === "performed" — you did it.
// outcome === "replayed"  — another agent already did, and `result` is what
//                           it got. The card was charged exactly once.
```

That is the whole API surface for the hard part. By hand you would have to
get four branches right — you won, you lost, it is in flight, the key was
reused with different inputs — and remember to record the result on success
and release the claim on failure. Any one of those wrong and you are back to
the duplicate charge you were paying to avoid.

### What it does for you

| Situation | Behaviour |
|---|---|
| You win the claim | Runs your work, stores the return value, returns `performed` |
| Your work throws | Releases the claim so a retry can start at once, rethrows your error unchanged |
| Someone already finished | Never runs your work; returns their result as `replayed` |
| They finished but recorded no result | Returns `replayed` with `hasResult: false` and `result` null, so an empty result is never mistaken for a lost one |
| Someone holds it but never finished | Throws `HeldError`. The work may be in flight or may have been abandoned; it is **not** a completed action and must not be treated as one |
| The stored result cannot be decoded | Throws `ResultUnavailableError`. The work **did** run — do not repeat it — but its recorded outcome is lost |
| Your lease lapsed and someone took over | Throws `LeaseLostError`. Your side effect has now run twice; carries both your result and the recorded one |
| Someone is mid-flight | Throws `InProgressError` with `retryAfter`. Pass `waitAttempts` to wait instead |
| Same key, different inputs | Throws `ConflictError`. Never retryable — your key derivation is wrong |

### `leaseTtl` is opt-in on purpose

Without it, a claim is held for its full `ttl` and **nothing** can ever run
your side effect twice — but if you crash holding it, that key stays held.

With it, a crashed claimant is presumed dead once the lease lapses and
another agent takes over. Set it only if your work is safe to run again
after a crash.

The unsafe default would have been to turn leases on for everyone.

## Paying

This library never touches your keys. A package that quietly wants your
wallet is a package nobody should install. You have two options:

**Prepaid credits** — buy a balance once, pass the token:

```ts
new AgenticEndpoints({ creditToken: "ae_..." });
```

**Per call** — bring an x402-aware `fetch`:

```ts
import { wrapFetchWithPayment } from "x402-fetch";

new AgenticEndpoints({ fetch: wrapFetchWithPayment(fetch, wallet) });
```

Without either, paid endpoints throw `PaymentRequiredError`, which carries
the raw x402 challenge from the `payment-required` response header. (Under
x402 v2 the 402 body is legitimately empty — the challenge is in the header.)

## Deciding whether to depend on this

```ts
await client.status();
// { uptime_24h, error_rate_48h, latency_ms: { p95_at_most }, ... }
```

Derived from the service's own request log and cron ticks, and returns
`null` rather than a flattering default when there is not yet enough data.

## Keep your namespace token

The first call that touches a namespace mints a token and returns it **once**,
as `namespaceToken`. It is required by every later call. There is no recovery
if you lose it, and no way to reclaim the namespace. Store it before you do
anything else, and use a high-entropy namespace name so nobody can squat it.

## License

MIT
