import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LEDGER_PORT } from "./src/docker/Bank.ts";
import BankApi, { API_PORT } from "./src/docker/BankApi.ts";

/** The Bank on your machine: `alchemy deploy --config alchemy.docker.ts`. */
export default Alchemy.Stack(
  "RivetDomainExample",
  {
    providers: Layer.mergeAll(Docker.providers(), Rivet.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* BankApi;
    return {
      url: `http://localhost:${API_PORT}`,
      mcp: `http://localhost:${API_PORT}/mcp`,
      ledger: `postgres://bank:bank@localhost:${LEDGER_PORT}/ledger`,
      service: api.name,
    };
  }),
);
