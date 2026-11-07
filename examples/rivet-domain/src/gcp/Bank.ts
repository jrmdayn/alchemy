/**
 * The GCP target: a Rivet control plane on Compute Engine, a pool of nodes on
 * a Cloud Run worker pool, and the ledger in a Postgres you bring
 * (Cloud SQL with a public IP, AlloyDB, Neon, …), named by
 * `LEDGER_DATABASE_URL` when you deploy.
 */
import * as RivetGCP from "@alchemy.run/rivet/GCP";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeBank } from "../Bank.ts";

export const ControlPlane = RivetGCP.ComputeEngineControlPlane("Rivet", {
  instances: 3,
  diskSize: 100,
});

export const Pool = RivetGCP.CloudRunPool("Default").pipe(Layer.provide(ControlPlane));

/** Read once, while deploying: the nodes and the Api get it as their own env. */
export const LedgerDatabase = Config.Redacted("LEDGER_DATABASE_URL");

/** The Bank on Cloud Run. The nodes load this export. */
export const BankLive = Layer.unwrap(
  Effect.gen(function* () {
    const ledgerUrl = globalThis.__ALCHEMY_RUNTIME__ ? Redacted.make("") : yield* LedgerDatabase;
    return makeBank({ main: import.meta.url, handler: "BankLive", pool: Pool, ledgerUrl });
  }),
);
