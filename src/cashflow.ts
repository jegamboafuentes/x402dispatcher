import { randomUUID } from "node:crypto";
import { atomicToUsd, getNetworkCaip2 } from "./config.js";
import { getDb, getLedgerUpdatedAt, persistLedger, touchMeta } from "./db.js";
import { getSqlitePath } from "./paths.js";

export type CashflowDirection = "in" | "out" | "markup";

export type CashflowEntry = {
  id: string;
  at: string;
  direction: CashflowDirection;
  amount_usd: number;
  amount_atomic?: string;
  network: string;
  tool?: string;
  task?: string;
  from?: string;
  to?: string;
  tx_hash?: string;
  explorer_url?: string;
  upstream_url?: string;
  correlation_id?: string;
  status: "success" | "failed" | "skipped";
  note?: string;
};

const MAX_ENTRIES = 2_000;

type CashflowRow = {
  id: string;
  at: string;
  direction: CashflowDirection;
  amount_usd: number;
  amount_atomic: string | null;
  network: string;
  tool: string | null;
  task: string | null;
  from_addr: string | null;
  to_addr: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  upstream_url: string | null;
  correlation_id: string | null;
  status: CashflowEntry["status"];
  note: string | null;
};

function rowToEntry(row: CashflowRow): CashflowEntry {
  return {
    id: row.id,
    at: row.at,
    direction: row.direction,
    amount_usd: row.amount_usd,
    amount_atomic: row.amount_atomic ?? undefined,
    network: row.network,
    tool: row.tool ?? undefined,
    task: row.task ?? undefined,
    from: row.from_addr ?? undefined,
    to: row.to_addr ?? undefined,
    tx_hash: row.tx_hash ?? undefined,
    explorer_url: row.explorer_url ?? undefined,
    upstream_url: row.upstream_url ?? undefined,
    correlation_id: row.correlation_id ?? undefined,
    status: row.status,
    note: row.note ?? undefined,
  };
}

function trimOldRows(): void {
  const count = getDb().prepare("SELECT COUNT(*) AS n FROM cashflow").get() as { n: number };
  const extra = count.n - MAX_ENTRIES;
  if (extra > 0) {
    getDb()
      .prepare(
        "DELETE FROM cashflow WHERE id IN (SELECT id FROM cashflow ORDER BY at ASC, id ASC LIMIT ?)",
      )
      .run(extra);
  }
}

export function getCashflowPath(): string {
  return getSqlitePath();
}

export async function recordCashflow(
  input: Omit<CashflowEntry, "id" | "at" | "network"> & {
    network?: string;
    id?: string;
    at?: string;
  },
): Promise<CashflowEntry> {
  const entry: CashflowEntry = {
    id: input.id ?? randomUUID(),
    at: input.at ?? new Date().toISOString(),
    direction: input.direction,
    amount_usd: Number(input.amount_usd.toFixed(6)),
    amount_atomic: input.amount_atomic,
    network: input.network ?? getNetworkCaip2(),
    tool: input.tool,
    task: input.task,
    from: input.from,
    to: input.to,
    tx_hash: input.tx_hash,
    explorer_url: input.explorer_url,
    upstream_url: input.upstream_url,
    correlation_id: input.correlation_id,
    status: input.status,
    note: input.note,
  };

  getDb()
    .prepare(
      `INSERT INTO cashflow (
        id, at, direction, amount_usd, amount_atomic, network, tool, task,
        from_addr, to_addr, tx_hash, explorer_url, upstream_url, correlation_id, status, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.id,
      entry.at,
      entry.direction,
      entry.amount_usd,
      entry.amount_atomic ?? null,
      entry.network,
      entry.tool ?? null,
      entry.task ?? null,
      entry.from ?? null,
      entry.to ?? null,
      entry.tx_hash ?? null,
      entry.explorer_url ?? null,
      entry.upstream_url ?? null,
      entry.correlation_id ?? null,
      entry.status,
      entry.note ?? null,
    );
  trimOldRows();
  touchMeta();
  await persistLedger();
  return entry;
}

export function listCashflow(options?: {
  limit?: number;
  direction?: CashflowDirection;
  since?: string;
}): CashflowEntry[] {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options?.direction) {
    clauses.push("direction = ?");
    params.push(options.direction);
  }
  if (options?.since) {
    const sinceMs = Date.parse(options.since);
    if (Number.isFinite(sinceMs)) {
      clauses.push("at >= ?");
      params.push(options.since);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const rows = getDb()
    .prepare(`SELECT * FROM cashflow ${where} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...params) as CashflowRow[];
  return rows.map(rowToEntry);
}

export type PnLSummary = {
  network: string;
  entry_count: number;
  revenue_usd: number;
  cogs_usd: number;
  markup_usd: number;
  gross_profit_usd: number;
  inbound_count: number;
  outbound_count: number;
  markup_count: number;
  cashflow_path: string;
  updated_at: string;
};

export function getPnL(options?: { since?: string }): PnLSummary {
  const clauses = ["status = 'success'"];
  const params: string[] = [];
  if (options?.since) {
    const sinceMs = Date.parse(options.since);
    if (Number.isFinite(sinceMs)) {
      clauses.push("at >= ?");
      params.push(options.since);
    }
  }
  const rows = getDb()
    .prepare(
      `SELECT direction, COUNT(*) AS n, COALESCE(SUM(amount_usd), 0) AS usd
       FROM cashflow WHERE ${clauses.join(" AND ")} GROUP BY direction`,
    )
    .all(...params) as Array<{ direction: CashflowDirection; n: number; usd: number }>;

  let revenue = 0;
  let cogs = 0;
  let markup = 0;
  let inboundCount = 0;
  let outboundCount = 0;
  let markupCount = 0;
  for (const row of rows) {
    if (row.direction === "in") {
      revenue = row.usd;
      inboundCount = row.n;
    } else if (row.direction === "out") {
      cogs = row.usd;
      outboundCount = row.n;
    } else if (row.direction === "markup") {
      markup = row.usd;
      markupCount = row.n;
    }
  }

  return {
    network: getNetworkCaip2(),
    entry_count: inboundCount + outboundCount + markupCount,
    revenue_usd: Number(revenue.toFixed(6)),
    cogs_usd: Number(cogs.toFixed(6)),
    markup_usd: Number(markup.toFixed(6)),
    gross_profit_usd: Number((revenue - cogs).toFixed(6)),
    inbound_count: inboundCount,
    outbound_count: outboundCount,
    markup_count: markupCount,
    cashflow_path: getSqlitePath(),
    updated_at: getLedgerUpdatedAt(),
  };
}

export function amountAtomicToUsd(amount: string | bigint | undefined): number | undefined {
  if (amount === undefined || amount === null || amount === "") {
    return undefined;
  }
  try {
    return atomicToUsd(amount);
  } catch {
    return undefined;
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}
