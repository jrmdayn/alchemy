import * as GCP from "@alchemy.run/gcp";
import * as Rivet from "@alchemy.run/rivet";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import BankApi from "./src/gcp/BankApi.ts";

/** The Bank on Google Cloud: `alchemy deploy --config alchemy.gcp.ts`. */
export default Alchemy.Stack(
  "RivetDomainExample",
  {
    providers: Layer.mergeAll(GCP.providers(), Rivet.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* BankApi;
    return { url: api.uri, mcp: api.uri.pipe(Output.map((uri) => `${uri}/mcp`)) };
  }),
);
