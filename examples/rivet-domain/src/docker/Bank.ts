/**
 * The Docker target: a Rivet control plane and a pool of nodes on the local
 * swarm, and the ledger in a Postgres service on the control plane's network.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeBank } from "../Bank.ts";

export const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");

export const Pool = RivetDocker.SwarmPool("Default", { replicas: 2 }).pipe(
  Layer.provide(ControlPlane),
);

/** Published on the host, so `psql postgres://bank:bank@localhost:15432/ledger` works. */
export const LEDGER_PORT = 15432;
const LEDGER_HOST = "ledger-db";

/** The ledger's Postgres, joined to the control plane's network so the nodes reach it. */
export const LedgerDatabase = Effect.gen(function* () {
  const cluster = yield* Rivet.Cluster;
  const network = cluster.network?.kind === "docker" ? cluster.network.name : undefined;
  const data = yield* Docker.Volume("LedgerData", {});
  const db = yield* Docker.Service("LedgerDb", {
    image: "postgres:17-alpine",
    environment: { POSTGRES_USER: "bank", POSTGRES_PASSWORD: "bank", POSTGRES_DB: "ledger" },
    ports: [{ external: LEDGER_PORT, internal: 5432 }],
    volumes: [{ hostPath: data.name, containerPath: "/var/lib/postgresql/data" }],
    networks: network === undefined ? [] : [{ name: network, aliases: [LEDGER_HOST] }],
    replicas: 1,
  });
  // Ordered after the service, so nothing connects before it exists.
  return db.name.pipe(
    Output.map(() => Redacted.make(`postgres://bank:bank@${LEDGER_HOST}:5432/ledger`)),
  );
}).pipe(Effect.provide(ControlPlane));

/** The Bank on the swarm's nodes. The nodes load this export. */
export const BankLive = Layer.unwrap(
  Effect.gen(function* () {
    const ledgerUrl = globalThis.__ALCHEMY_RUNTIME__ ? Redacted.make("") : yield* LedgerDatabase;
    return makeBank({ main: import.meta.url, handler: "BankLive", pool: Pool, ledgerUrl });
  }),
);
