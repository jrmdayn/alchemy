import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { frontLayer, serveBank } from "../Front.ts";
import { BankLive, ControlPlane, LedgerDatabase } from "./Bank.ts";

export const API_PORT = 3000;

/**
 * The Api, MCP server and agent, as a swarm service on the control plane's
 * network. It reaches the Bank's objects through the Rivet gateway, and the
 * ledger (for the AccountLedger query) directly.
 */
export default class BankApi extends Docker.Service<BankApi>()(
  "BankApi",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: API_PORT,
      ports: [{ external: API_PORT, internal: API_PORT }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
      environment: { LEDGER_DATABASE_URL: yield* LedgerDatabase },
      // Only the nodes load RivetKit; the Api reaches the objects over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }).pipe(Effect.provide(ControlPlane)),
  Effect.gen(function* () {
    return { fetch: yield* serveBank };
  }).pipe(Effect.provide(frontLayer(BankLive))),
) {}
