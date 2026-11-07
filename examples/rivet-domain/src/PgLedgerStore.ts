import {
  cursorOf,
  type LedgerRow,
  LedgerStore,
  parseCursor,
} from "@bank/domain/Ledger/LedgerStore";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import pg from "pg";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_account_at ON ledger (account_id, at, id);`;

// One pool per process, opened on first use: the nodes (where the Ledger
// projection writes) and the Api (where AccountLedger reads) are long-lived
// servers, and nothing is read until a request needs it.
let pool: Promise<pg.Pool> | undefined;

const connect = Effect.gen(function* () {
  const url = yield* Config.Redacted("LEDGER_DATABASE_URL");
  return yield* Effect.promise(async () => {
    const created = new pg.Pool({ connectionString: Redacted.value(url), max: 4 });
    await created.query(CREATE_TABLE);
    return created;
  });
});

const ledgerPool = Effect.suspend(() => {
  if (pool === undefined) {
    pool = Effect.runPromise(connect.pipe(Effect.orDie)).catch((cause) => {
      pool = undefined;
      throw cause;
    });
  }
  const current = pool;
  return Effect.promise(() => current);
});

const query = <Row>(text: string, values: ReadonlyArray<unknown>) =>
  Effect.flatMap(ledgerPool, (client) =>
    Effect.promise(() => client.query(text, [...values]).then((result) => result.rows as Row[])),
  );

/**
 * The ledger in Postgres: the table the Ledger projection keeps and the
 * AccountLedger query pages through. Open it with psql like any other table.
 */
export const PgLedgerStore = Layer.succeed(LedgerStore, {
  record: (rows) =>
    rows.length === 0
      ? Effect.void
      : query(
          `INSERT INTO ledger (id, account_id, kind, amount, balance_after, at)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[])
           ON CONFLICT (id) DO NOTHING`,
          [
            rows.map((row) => row.id),
            rows.map((row) => row.accountId),
            rows.map((row) => row.kind),
            rows.map((row) => row.amount),
            rows.map((row) => row.balanceAfter),
            rows.map((row) => row.at),
          ],
        ).pipe(Effect.asVoid),
  // Keyset paging on (at, id): one row more than asked says whether a next page exists.
  forAccount: (accountId, { after, take }) => {
    const from = after === undefined ? undefined : parseCursor(after);
    return query<{
      id: string;
      accountId: string;
      kind: string;
      amount: string;
      balanceAfter: string;
      at: string;
    }>(
      `SELECT id, account_id AS "accountId", kind, amount, balance_after AS "balanceAfter", at
       FROM ledger WHERE account_id = $1
       ${from ? "AND (at > $3 OR (at = $3 AND id > $4))" : ""}
       ORDER BY at, id LIMIT $2`,
      from ? [accountId, take + 1, from.at, from.id] : [accountId, take + 1],
    ).pipe(
      Effect.map((results) => {
        // BIGINT columns come back as strings.
        const rows: LedgerRow[] = results.map((row) => ({
          ...row,
          amount: Number(row.amount) as LedgerRow["amount"],
          balanceAfter: Number(row.balanceAfter) as LedgerRow["balanceAfter"],
          at: Number(row.at),
        }));
        const entries = rows.slice(0, take);
        return { entries, cursor: rows.length > take ? cursorOf(entries[take - 1]!) : null };
      }),
    );
  },
});
