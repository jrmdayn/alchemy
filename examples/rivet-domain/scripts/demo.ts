/**
 * Drive the deployed Bank through its MCP server, as an agent would.
 *
 *   bun scripts/demo.ts [url]         # default http://localhost:3000
 *
 * 1. sign in as a customer (POST /api/session) and keep the bearer token
 * 2. register the customer with the Api's own client (MCP exposes only what is listed)
 * 3. open an MCP session on /mcp, list the tools
 * 4. call tools: read the dashboard, deposit money, read the summary, page the ledger
 * 5. call a tool without a token: the Session middleware rejects it
 */
import * as Domain from "@alchemy.run/domain";
import { mainAccountId } from "@bank/domain/Account/Account.id";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { Username } from "@bank/domain/Customer/Username";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { sessionClient } from "@bank/domain/Session.middleware";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

const url = process.argv[2] ?? "http://localhost:3000";
const customerId = `demo-${Math.random().toString(36).slice(2, 8)}`;

const signIn = Effect.tryPromise(async () => {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customerId }),
  });
  if (!response.ok) throw new Error(`sign in: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { token: string }).token;
});

/** A minimal MCP client over Streamable HTTP: JSON-RPC requests, SSE or JSON answers. */
const mcpClient = (headers: Record<string, string> = {}) => {
  let session: string | undefined;
  let id = 0;
  const post = async (method: string, params: unknown, notification = false) => {
    const response = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...(session ? { "mcp-session-id": session } : {}),
        ...headers,
      },
      body: JSON.stringify(
        notification
          ? { jsonrpc: "2.0", method, params }
          : { jsonrpc: "2.0", id: ++id, method, params },
      ),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    if (notification || text.length === 0) return undefined;
    const json = text.startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1)!;
    return JSON.parse(json) as { result?: any; error?: any };
  };
  return {
    connect: Effect.tryPromise(async () => {
      await post("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "bank-demo", version: "1.0.0" },
      });
      await post("notifications/initialized", {}, true);
    }),
    request: (method: string, params: unknown) => Effect.tryPromise(() => post(method, params)),
    call: (name: string, args: unknown) =>
      Effect.tryPromise(() => post("tools/call", { name, arguments: args })).pipe(
        Effect.map((answer) => answer?.result),
      ),
  };
};

const show = (title: string, value: unknown) =>
  Effect.log(`\n── ${title}\n${JSON.stringify(value, null, 2)}`);

const program = Effect.gen(function* () {
  // Fresh services take a few seconds to answer.
  const token = yield* signIn.pipe(
    Effect.retry({ schedule: Schedule.exponential("1 second"), times: 8 }),
  );
  yield* show("signed in", { customerId, token: `${token.slice(0, 16)}…` });

  // Registration isn't exposed to the agent: the app does it with the Api's client.
  const bank = yield* CustomerApi.client.pipe(
    Effect.provide(
      Layer.mergeAll(
        Domain.protocolHttp(`${url}/api`).pipe(Layer.provide(FetchHttpClient.layer)),
        sessionClient(token),
      ),
    ),
  );
  yield* bank.RegisterCustomer(CustomerId.make(customerId), {
    name: "Demo Customer",
    username: Username.make(customerId),
  });
  yield* show("RegisterCustomer (Api client)", "accepted");

  // An agent signs in to the MCP server with the same bearer token the Api's
  // Session middleware reads. `x-mfa-code` satisfies MfaChallenge for writes
  // that need it (WithdrawMoney, RequestTransfer); demo code 000000.
  const mcp = mcpClient({ authorization: `Bearer ${token}`, "x-mfa-code": "000000" });
  yield* mcp.connect;
  const listed = yield* mcp.request("tools/list", {});
  yield* show(
    "tools/list",
    listed?.result.tools.map((tool: any) => ({
      name: tool.name,
      readOnly: tool.annotations?.readOnlyHint,
      description: tool.description,
    })),
  );

  // MainAccountProvisioning opens the main account after registration:
  // wait for the dashboard to show it.
  const accountId = mainAccountId(CustomerId.make(customerId));
  const dashboard = yield* mcp.call("CustomerApi_CustomerDashboard_get", { key: customerId }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (result) => accountId in (result?.structuredContent?.value?.balances ?? {}),
      times: 30,
    }),
  );
  yield* show("CustomerDashboard.get", dashboard.structuredContent);

  const deposit = yield* mcp.call("CustomerApi_DepositMoney_send", {
    target: accountId,
    input: { amount: 12_500 },
  });
  yield* show("DepositMoney (a write tool)", deposit.structuredContent);

  // A rejection comes back as the tool's typed failure, for the agent to explain.
  const overdraw = yield* mcp.call("CustomerApi_WithdrawMoney_send", {
    target: accountId,
    input: { amount: 1_000_000 },
  });
  yield* show("WithdrawMoney more than the balance", overdraw);

  const summary = yield* mcp.call("CustomerApi_AccountSummary_get", { key: accountId });
  yield* show("AccountSummary.get", summary.structuredContent);

  // The ledger is the Postgres projection: wait until it caught up with the deposit.
  const ledger = yield* mcp
    .call("CustomerApi_AccountLedger_ask", { input: { account: accountId } })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (result) => (result?.structuredContent?.entries?.length ?? 0) > 0,
        times: 20,
      }),
    );
  yield* show("AccountLedger (from Postgres)", ledger.structuredContent);

  const anonymous = mcpClient();
  yield* anonymous.connect;
  const refused = yield* anonymous.call("CustomerApi_AccountSummary_get", { key: accountId });
  yield* show("the same read without a token", refused);
});

program.pipe(Effect.scoped, Effect.runPromise).catch((error) => {
  console.error(error);
  process.exit(1);
});
