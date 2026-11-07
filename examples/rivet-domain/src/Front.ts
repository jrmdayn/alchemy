import * as DomainAi from "@alchemy.run/domain/Ai";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { SupportApi } from "@bank/domain/SupportApi.api";
import { MfaChallengeLive } from "@bank/server/MfaChallenge";
import { SessionKey, SessionKeyLive, SessionLive, sessionRoute } from "@bank/server/Session";
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { Chat, McpProtocol, McpServer } from "effect/ai";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What an agent may do for a signed-in customer: open and move money, and
 * read what the customer may read. Anything not listed is not a tool.
 * Every call still runs the Api's middleware, `decide` and `validate`.
 */
const expose = [
  "DepositMoney",
  "WithdrawMoney",
  "RequestTransfer",
  "CustomerDashboard.get",
  "AccountSummary.get",
  "Statement.get",
  "AccountTransfers.get",
  "AccountLedger",
] as const;

/** The middleware both Apis declare, over the hosted model. */
export const frontLayer = <A, E, R>(bank: Layer.Layer<A, E, R>) =>
  Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(
    Layer.provideMerge(SessionKeyLive),
    Layer.provideMerge(bank),
  );

const AgentRequest = Schema.Struct({ prompt: Schema.String });

/**
 * The Api's routes, the MCP server and the in-app agent, served by whatever
 * runs the front: a Docker service or a Cloud Run service.
 *
 * - `POST /api/session`       sign in as a customer: `{ customerId }` → `{ token }`
 * - `/api/*`                  the CustomerApi (Effect RPC over HTTP)
 * - `/support/*`              the SupportApi
 * - `POST /mcp`               the CustomerApi's tools over MCP, for agents outside the app
 * - `POST /api/agent`         an agent inside the app: `{ prompt }` → `{ answer }`
 */
export const serveBank = Effect.gen(function* () {
  const customerApi = yield* CustomerApi;
  const supportApi = yield* SupportApi;
  const sessionKey = yield* SessionKey;

  // One MCP server for every request. Each tool call carries the HTTP
  // request's headers (`Authorization: Bearer <token>`) to the Session
  // middleware, so an MCP client signs in like any other client.
  const mcp = yield* DomainAi.toMcp(CustomerApi, { expose }).pipe(
    Layer.provide(
      McpServer.layerHttp({
        name: "bank",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_11_25],
        instructions:
          "A bank. Amounts are in cents. Read CustomerDashboard first to find the customer's accounts.",
      }),
    ),
    HttpRouter.toHttpEffect,
    // A bad MCP server definition is a bug, not something to serve around.
    Effect.orDie,
  );

  // The same tools for an agent inside the app, acting for the caller.
  const { toolkit, layer: tools } = DomainAi.toToolkit(CustomerApi, { expose });
  const apiKey = yield* Config.option(Config.Redacted("ANTHROPIC_API_KEY"));
  const model = yield* Config.String("ANTHROPIC_MODEL").pipe(Config.withDefault("claude-opus-5-5"));
  const languageModel = AnthropicLanguageModel.layer({ model }).pipe(
    Layer.provide(
      AnthropicClient.layer({ apiKey: Option.getOrUndefined(apiKey) }).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
  );

  const agent = Effect.gen(function* () {
    if (Option.isNone(apiKey)) {
      return HttpServerResponse.text("Set ANTHROPIC_API_KEY to enable the agent", { status: 501 });
    }
    const request = yield* HttpServerRequest;
    const { prompt } = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AgentRequest)),
      Effect.orDie,
    );
    const session = yield* Chat.fromPrompt([
      {
        role: "system",
        content:
          "You help a bank customer with their accounts. Amounts are in cents. " +
          "Use the tools; read CustomerDashboard first to find the customer's accounts.",
      },
      { role: "user", content: prompt },
    ]);
    // Let the model call tools until it answers, at most 8 turns.
    for (let turn = 0; turn < 8; turn++) {
      const response = yield* session.generateText({ prompt: [], toolkit });
      if (response.toolCalls.length === 0) {
        return yield* HttpServerResponse.json({ answer: response.text });
      }
    }
    return yield* HttpServerResponse.json({ answer: "I could not finish within 8 steps." });
  }).pipe(
    Effect.provide(tools),
    Effect.provide(languageModel),
    Effect.catchTag("AiError", (error) =>
      HttpServerResponse.json({ error: error.message }, { status: 502 }),
    ),
  );

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/api/session") {
      return yield* sessionRoute.pipe(Effect.provideService(SessionKey, sessionKey));
    }
    if (path === "/api/agent" && request.method === "POST") return yield* agent;
    if (path === "/mcp") return yield* mcp;
    if (path.startsWith("/api")) return yield* customerApi.fetch;
    if (path.startsWith("/support")) return yield* supportApi.fetch;
    if (path === "/health") return HttpServerResponse.text("ok");
    return HttpServerResponse.text("Not Found", { status: 404 });
  });
});
