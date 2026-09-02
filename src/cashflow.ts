import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicToUsd, getNetworkCaip2 } from "./config.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");
const CASHFLOW_PATH = path.join(DATA_DIR, "cashflow.json");

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

type CashflowFile = {
  version: 1;
  updated_at: string;
  entries: CashflowEntry[];
};

const MAX_ENTRIES = 2_000;

function emptyFile(): CashflowFile {
  return { version: 1, updated_at: new Date().toISOString(), entries: [] };
}

function readFile(): CashflowFile {
  try {
    if (!fs.existsSync(CASHFLOW_PATH)) {
      return emptyFile();
    }
    const parsed = JSON.parse(fs.readFileSync(CASHFLOW_PATH, "utf8")) as CashflowFile;
    if (!Array.isArray(parsed.entries)) {
      return emptyFile();
    }
    return parsed;
  } catch {
    return emptyFile();
  }
}

function writeFile(file: CashflowFile): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  file.updated_at = new Date().toISOString();
  if (file.entries.length > MAX_ENTRIES) {
    file.entries = file.entries.slice(-MAX_ENTRIES);
  }
  fs.writeFileSync(CASHFLOW_PATH, JSON.stringify(file, null, 2), "utf8");
}

export function getCashflowPath(): string {
  return CASHFLOW_PATH;
}

export function recordCashflow(
  input: Omit<CashflowEntry, "id" | "at" | "network"> & {
    network?: string;
    id?: string;
    at?: string;
  },
): CashflowEntry {
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

  const file = readFile();
  file.entries.push(entry);
  writeFile(file);
  return entry;
}

export function listCashflow(options?: {
  limit?: number;
  direction?: CashflowDirection;
  since?: string;
}): CashflowEntry[] {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
  let entries = readFile().entries;
  if (options?.direction) {
    entries = entries.filter((e) => e.direction === options.direction);
  }
  if (options?.since) {
    const sinceMs = Date.parse(options.since);
    if (Number.isFinite(sinceMs)) {
      entries = entries.filter((e) => Date.parse(e.at) >= sinceMs);
    }
  }
  return entries.slice(-limit).reverse();
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
  const file = readFile();
  let entries = file.entries.filter((e) => e.status === "success");
  if (options?.since) {
    const sinceMs = Date.parse(options.since);
    if (Number.isFinite(sinceMs)) {
      entries = entries.filter((e) => Date.parse(e.at) >= sinceMs);
    }
  }

  let revenue = 0;
  let cogs = 0;
  let markup = 0;
  let inboundCount = 0;
  let outboundCount = 0;
  let markupCount = 0;

  for (const e of entries) {
    if (e.direction === "in") {
      revenue += e.amount_usd;
      inboundCount += 1;
    } else if (e.direction === "out") {
      cogs += e.amount_usd;
      outboundCount += 1;
    } else if (e.direction === "markup") {
      markup += e.amount_usd;
      markupCount += 1;
    }
  }

  return {
    network: getNetworkCaip2(),
    entry_count: entries.length,
    revenue_usd: Number(revenue.toFixed(6)),
    cogs_usd: Number(cogs.toFixed(6)),
    markup_usd: Number(markup.toFixed(6)),
    /** When inbound paywall is on: revenue - cogs. Markup is internal Treasury→Merchant. */
    gross_profit_usd: Number((revenue - cogs).toFixed(6)),
    inbound_count: inboundCount,
    outbound_count: outboundCount,
    markup_count: markupCount,
    cashflow_path: CASHFLOW_PATH,
    updated_at: file.updated_at,
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
