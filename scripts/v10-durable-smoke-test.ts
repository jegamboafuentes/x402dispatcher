/**
 * V10 durable ledger smoke (no paid call).
 *
 *   $env:PUBLIC_BASE_URL='http://127.0.0.1:8080'; npm run test:v10
 *   $env:PUBLIC_BASE_URL='https://402dispatcher.com'; npm run test:v10
 */
const BASE = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

async function main() {
  console.log(`V10 durable ledger smoke against ${BASE}`);

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) {
    throw new Error(`/health failed: ${health.status}`);
  }
  const json = (await health.json()) as {
    version?: string;
    ledger?: { driver?: string; durable?: boolean; gcs_bucket?: string | null; path?: string };
    pnl?: { entry_count?: number };
  };
  if (!String(json.version ?? "").startsWith("10.")) {
    throw new Error(`Expected version 10.x, got ${json.version}`);
  }
  if (json.ledger?.driver !== "sqlite") {
    throw new Error(`Expected sqlite ledger, got ${JSON.stringify(json.ledger)}`);
  }
  console.log(
    `ledger driver=${json.ledger.driver} durable=${json.ledger.durable} bucket=${json.ledger.gcs_bucket ?? "local"} path=${json.ledger.path}`,
  );
  if (BASE.includes("402dispatcher.com") && !json.ledger.durable) {
    throw new Error("Production should have GCS_DATA_BUCKET set (durable=true)");
  }
  console.log(`pnl entries=${json.pnl?.entry_count ?? 0}`);
  console.log("V10 DURABLE LEDGER SMOKE TEST PASSED");
}

main().catch((error) => {
  console.error("V10 DURABLE LEDGER SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
