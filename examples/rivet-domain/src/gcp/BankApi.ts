import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { frontLayer, serveBank } from "../Front.ts";
import { BankLive, LedgerDatabase } from "./Bank.ts";

/**
 * The Api, MCP server and agent as a public Cloud Run service. It reaches the
 * Bank's objects through the control plane's `run.app` gateway.
 */
export default class BankApi extends GCP.Run.Service<BankApi>()(
  "BankApi",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      invokerIamDisabled: true,
      env: { LEDGER_DATABASE_URL: yield* LedgerDatabase },
      // Only the nodes load RivetKit; the Api reaches the objects over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }),
  Effect.gen(function* () {
    return { fetch: yield* serveBank };
  }).pipe(Effect.provide(frontLayer(BankLive))),
) {}
