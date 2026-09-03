/**
 * V8 operator console smoke test (no paid call).
 *
 *   $env:PUBLIC_BASE_URL='http://127.0.0.1:8080'; npm run test:v8
 *   $env:PUBLIC_BASE_URL='https://402dispatcher.com'; npm run test:v8
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
    "info-open",
    "information",
    "GLOSSARY",
    "MCP links",
    "mcp-link",
    "health-link",
    "copy-btn",
    "402dispatcherright.png",
    "402dispatcherLogo.png",
    "402dispatcherMascot.png",
    'name="description"',
    'property="og:image"',
    "application/ld+json",
  ]) {
    if (!html.includes(needle)) {
      throw new Error(`Console HTML missing expected content: ${needle}`);
    }
  }
  if (html.includes("__ORIGIN__")) {
    throw new Error("Console HTML still contains unresolved __ORIGIN__ placeholders");
  }
  console.log("console HTML ok");

  for (const asset of [
    "/console/console.css",
    "/console/console.js",
    "/images/402dispatcherright.png",
    "/images/402dispatcherLogo.png",
    "/images/402dispatcherMascot.png",
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
  ]) {
    const res = await fetch(`${BASE}${asset}`);
    if (!res.ok) {
      throw new Error(`${asset} failed: ${res.status}`);
    }
  }
  console.log("console assets + SEO endpoints ok");

  const js = await fetch(`${BASE}/console/console.js`);
  if (!js.ok) {
    throw new Error(`/console/console.js failed: ${js.status}`);
  }
  const jsText = await js.text();
  for (const needle of [
    "WALLETS",
    "PNL",
    "RECENT SETTLEMENTS",
    "/v1/wallets",
    "America/New_York",
    "basescan.org",
  ]) {
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
  if (!String(healthJson.version ?? "").startsWith("10.")) {
    throw new Error(`Expected version 10.x, got ${healthJson.version}`);
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
