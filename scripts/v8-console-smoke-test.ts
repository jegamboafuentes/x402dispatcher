/**
 * V8 operator console smoke test (no paid call).
 *
 *   $env:PUBLIC_BASE_URL='http://127.0.0.1:8080'; npm run test:v8
 *   $env:PUBLIC_BASE_URL='https://YOUR-SERVICE.run.app'; npm run test:v8
 */
const BASE = (process.env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");

async function main() {
  console.log(`V8 console smoke against ${BASE}`);

  const home = await fetch(`${BASE}/`);
  if (!home.ok) {
    throw new Error(`/ failed: ${home.status}`);
  }
  const html = await home.text();
  for (const needle of [
    "x402dispatcher",
    "/console/console.js",
    "metaverseprofessional.tech",
    "enriquegamboa.info",
    "wallets-frame",
    "pnl-frame",
    "ledger-frame",
  ]) {
    if (!html.includes(needle)) {
      throw new Error(`Console HTML missing expected content: ${needle}`);
    }
  }
  console.log("console HTML ok");

  const css = await fetch(`${BASE}/console/console.css`);
  if (!css.ok) {
    throw new Error(`/console/console.css failed: ${css.status}`);
  }

  const js = await fetch(`${BASE}/console/console.js`);
  if (!js.ok) {
    throw new Error(`/console/console.js failed: ${js.status}`);
  }
  const jsText = await js.text();
  for (const needle of ["WALLETS", "PNL", "RECENT SETTLEMENTS", "/v1/wallets"]) {
    if (!jsText.includes(needle)) {
      throw new Error(`console.js missing expected content: ${needle}`);
    }
  }
  console.log("console assets ok");

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) {
    throw new Error(`/health failed: ${health.status}`);
  }
  const healthJson = (await health.json()) as { version?: string; ok?: boolean };
  if (!String(healthJson.version ?? "").startsWith("8.")) {
    throw new Error(`Expected version 8.x, got ${healthJson.version}`);
  }
  console.log(`health version=${healthJson.version}`);

  const pnl = await fetch(`${BASE}/v1/pnl`);
  if (!pnl.ok) {
    throw new Error(`/v1/pnl failed: ${pnl.status}`);
  }
  const pnlJson = (await pnl.json()) as { revenue_usd?: number };
  if (typeof pnlJson.revenue_usd !== "number") {
    throw new Error("pnl missing revenue_usd");
  }
  console.log(`pnl revenue=${pnlJson.revenue_usd}`);

  const wallets = await fetch(`${BASE}/v1/wallets`);
  if (!wallets.ok) {
    throw new Error(`/v1/wallets failed: ${wallets.status}`);
  }
  const walletsJson = (await wallets.json()) as {
    treasury?: { address?: string; usdc?: number };
    merchant?: { address?: string; usdc?: number };
  };
  if (!walletsJson.treasury?.address || !walletsJson.merchant?.address) {
    throw new Error(`wallets missing addresses: ${JSON.stringify(walletsJson)}`);
  }
  if (typeof walletsJson.treasury.usdc !== "number" || typeof walletsJson.merchant.usdc !== "number") {
    throw new Error(`wallets missing usdc balances: ${JSON.stringify(walletsJson)}`);
  }
  console.log(
    `wallets treasury=${walletsJson.treasury.address} usdc=${walletsJson.treasury.usdc} merchant_usdc=${walletsJson.merchant.usdc}`,
  );

  console.log("V8 CONSOLE SMOKE TEST PASSED");
}

main().catch((error) => {
  console.error("V8 CONSOLE SMOKE TEST FAILED");
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
