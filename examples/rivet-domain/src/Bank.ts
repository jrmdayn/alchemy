import * as DomainRivet from "@alchemy.run/rivet/Domain";
import { Bank, BankHandlers } from "@bank/domain/Bank.model";
import { SiftFraudCheck } from "@bank/server/Fraud/SiftFraudCheck";
import { StripePayments } from "@bank/server/Settlement/StripePayments";
import type { Input } from "alchemy/Input";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { PgLedgerStore } from "./PgLedgerStore.ts";

export interface BankOptions<PoolReq> {
  /** The module that exports the Layer this returns: the pool's nodes load it. */
  readonly main: string;
  /** The export of `main` that holds it. */
  readonly handler: string;
  /** Where the nodes run: a Docker swarm, Cloud Run, … */
  readonly pool: DomainRivet.LayerOptions<PoolReq>["pool"];
  /** The Postgres the Ledger projection writes, as the nodes reach it. */
  readonly ledgerUrl: Input<Redacted.Redacted<string>>;
}

/**
 * The same Bank model as `examples/cloudflare-domain`, hosted on Rivet
 * Durable Objects instead: `DomainRivet.layer` replaces
 * `DomainCloudflare.layer()`, and the ledger moves from D1 to Postgres.
 * Nothing in `@bank/domain` changes.
 */
export const makeBank = <PoolReq>(options: BankOptions<PoolReq>) =>
  Bank.layer(BankHandlers).pipe(
    Layer.provide(
      Layer.mergeAll(
        DomainRivet.layer({
          name: "Bank",
          main: options.main,
          handler: options.handler,
          pool: options.pool,
          env: { LEDGER_DATABASE_URL: options.ledgerUrl },
        }),
        PgLedgerStore,
        SiftFraudCheck,
        StripePayments,
      ),
    ),
  );
