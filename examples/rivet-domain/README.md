# rivet-domain

The bank from [`cloudflare-domain`](../cloudflare-domain), hosted on Rivet Durable Objects instead of Cloudflare's, and served over MCP to agents. The model in `@bank/domain` is reused unchanged: only the platform layer and the ledger store differ.

```ts
// examples/cloudflare-domain              // here
Bank.layer(BankHandlers).pipe(             Bank.layer(BankHandlers).pipe(
  Layer.provide(DomainCloudflare.layer()),   Layer.provide(DomainRivet.layer({ name: "Bank", main, handler, pool })),
  Layer.provide(D1LedgerStore),              Layer.provide(PgLedgerStore),
)                                          )
```

## Layout

```text
src/Bank.ts              makeBank(): the model on Rivet, ledger in Postgres (shared by both targets)
src/PgLedgerStore.ts     the Ledger projection's store: a `ledger` table you can psql
src/Front.ts             the routes: /api (CustomerApi), /support, /mcp, /api/agent, /api/session
src/docker/Bank.ts       Docker target: swarm control plane + pool, Postgres service
src/docker/BankApi.ts    the front as a swarm service on localhost:3000
src/gcp/Bank.ts          GCP target: Compute Engine control plane, Cloud Run worker pool
src/gcp/BankApi.ts       the front as a public Cloud Run service
alchemy.docker.ts        the stack for Docker
alchemy.gcp.ts           the stack for GCP
scripts/demo.ts          drives the deployed bank through MCP
```

Each target has its own `BankLive` export, the module the pool's nodes load, so a Docker deploy never bundles GCP code and the other way round. Switching target is a different `--config`, nothing else.

## Run it on Docker

Needs Docker with swarm mode (`docker swarm init`).

```sh
pnpm deploy:docker     # alchemy deploy --config alchemy.docker.ts
pnpm demo              # bun scripts/demo.ts http://localhost:3000
psql postgres://bank:bank@localhost:15432/ledger -c 'SELECT * FROM ledger ORDER BY at'
pnpm destroy:docker
```

## Run it on GCP

Needs GCP credentials (see [GCP setup](https://alchemy.run/gcp/setup)) and a Postgres the Cloud Run services can reach (Cloud SQL with a public IP, AlloyDB, Neon, …):

```sh
LEDGER_DATABASE_URL=postgres://… pnpm deploy:gcp
pnpm demo https://bankapi-….run.app
pnpm destroy:gcp
```

The control plane runs on three Compute Engine instances with 100 GB disks, as Rivet recommends for production. Its bucket has no versioning, and `forceDestroy` deletes the actor data on destroy.

## Agents: MCP and in-app

`DomainAi.toMcp` serves the `CustomerApi` calls listed in `src/Front.ts` (`expose`) as MCP tools on `/mcp`. Each call runs the Api's own middleware, `decide` and `validate`, with the MCP request's headers, so an agent acts as the customer whose token it sends:

```sh
TOKEN=$(curl -s -X POST localhost:3000/api/session -d '{"customerId":"alice"}' | jq -r .token)
claude mcp add --transport http bank http://localhost:3000/mcp \
  --header "Authorization: Bearer $TOKEN" --header "x-mfa-code: 000000"
```

Then ask Claude Code "what's my balance?" or "deposit 50 dollars into my main account". `x-mfa-code: 000000` is the demo MFA code that `WithdrawMoney` and `RequestTransfer` require.

`POST /api/agent` runs the same tools inside the app with `DomainAi.toToolkit` and Claude, acting for the signed-in caller. Set `ANTHROPIC_API_KEY` when deploying to turn it on:

```sh
curl -X POST localhost:3000/api/agent -H "authorization: Bearer $TOKEN" -H "x-mfa-code: 000000" \
  -d '{"prompt":"Deposit 20 dollars into my main account, then tell me my balance"}'
```

More: [MCP](https://alchemy.run/domain/mcp), [Rivet](https://alchemy.run/domain/rivet).

## Not carried over from cloudflare-domain

- The foldkit web app: it reads live over WebSockets, and Rivet actors hold none. Live reads here go through `Domain.protocolHttp`.
- The Stripe webhook and Axiom telemetry: both need accounts. `StripePayments` and `SiftFraudCheck` are the same stand-ins.
