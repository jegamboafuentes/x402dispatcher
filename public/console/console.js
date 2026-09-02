(() => {
  const REFRESH_MS = 5000;

  const metaEl = document.getElementById("meta");
  const walletsEl = document.getElementById("wallets-frame");
  const pnlEl = document.getElementById("pnl-frame");
  const ledgerEl = document.getElementById("ledger-frame");

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function money(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return "n/a";
    return `$${num.toFixed(6)}`;
  }

  function eth(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return "n/a";
    return `${num.toFixed(6)} ETH`;
  }

  function shortAddr(addr) {
    if (!addr || addr.length < 12) return addr ?? "";
    return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
  }

  function pad(label, width) {
    const s = String(label);
    return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
  }

  function clock() {
    return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  }

  function box(title, lines) {
    const width = Math.min(78, Math.max(40, ...lines.map((l) => l.replace(/<[^>]+>/g, "").length), title.length + 4));
    const top = `┌─ ${title} ${"─".repeat(Math.max(1, width - title.length - 3))}┐`;
    const bottom = `└${"─".repeat(width)}┘`;
    const body = lines.map((line) => {
      const plain = line.replace(/<[^>]+>/g, "");
      const padRight = " ".repeat(Math.max(0, width - 2 - plain.length));
      return `│ ${line}${padRight} │`;
    });
    return [top, ...body, bottom].join("\n");
  }

  async function getJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`${path} → HTTP ${res.status}`);
    }
    return res.json();
  }

  function renderWallets(wallets) {
    if (!wallets?.treasury || !wallets?.merchant) {
      walletsEl.textContent = "wallets unavailable";
      return;
    }
    const t = wallets.treasury;
    const m = wallets.merchant;
    const lines = [
      `${pad("role", 10)} ${pad("address", 18)} ${pad("USDC", 14)} ETH`,
      `${pad("──────────", 10)} ${pad("──────────────────", 18)} ${pad("──────────────", 14)} ──────────────`,
      `${pad("treasury", 10)} <a href="${esc(t.explorer_url)}" target="_blank" rel="noopener">${esc(shortAddr(t.address))}</a> ${pad(money(t.usdc), 14)} ${esc(eth(t.eth))}`,
      `${pad("merchant", 10)} <a href="${esc(m.explorer_url)}" target="_blank" rel="noopener">${esc(shortAddr(m.address))}</a> ${pad(money(m.usdc), 14)} ${esc(eth(m.eth))}`,
      "",
      `updated ${esc(wallets.updated_at)}`,
    ];
    walletsEl.innerHTML = box("WALLETS", lines);
  }

  function renderPnl(pnl) {
    if (!pnl) {
      pnlEl.textContent = "pnl unavailable";
      return;
    }
    const profitClass = Number(pnl.gross_profit_usd) >= 0 ? "ok" : "err";
    const lines = [
      `${pad("revenue (in)", 18)} ${money(pnl.revenue_usd)}   [${pnl.inbound_count ?? 0} txs]`,
      `${pad("cogs (out)", 18)} ${money(pnl.cogs_usd)}   [${pnl.outbound_count ?? 0} txs]`,
      `${pad("markup", 18)} ${money(pnl.markup_usd)}   [${pnl.markup_count ?? 0} txs]`,
      `${pad("gross profit", 18)} <span class="${profitClass}">${money(pnl.gross_profit_usd)}</span>`,
      "",
      `entries=${pnl.entry_count ?? 0}  network=${esc(pnl.network ?? "")}`,
      `ledger updated ${esc(pnl.updated_at ?? "")}`,
    ];
    pnlEl.innerHTML = box("PNL", lines);
  }

  function renderLedger(cashflow) {
    const entries = cashflow?.entries ?? [];
    if (!entries.length) {
      ledgerEl.innerHTML = box("RECENT SETTLEMENTS", ["(no ledger entries yet)"]);
      return;
    }
    const lines = [
      `${pad("time", 20)} ${pad("dir", 7)} ${pad("usd", 12)} ${pad("status", 8)} tool / tx`,
      `${pad("────────────────────", 20)} ${pad("───────", 7)} ${pad("────────────", 12)} ${pad("────────", 8)} ────────────────`,
    ];
    for (const e of entries.slice(0, 20)) {
      const when = String(e.at ?? "").replace("T", " ").slice(0, 19);
      const dir = e.direction ?? "?";
      const tool = e.tool || e.task || e.note || "";
      const tx = e.explorer_url
        ? `<a href="${esc(e.explorer_url)}" target="_blank" rel="noopener">${esc((e.tx_hash || "tx").slice(0, 10))}…</a>`
        : "—";
      lines.push(
        `${pad(when, 20)} ${pad(dir, 7)} ${pad(money(e.amount_usd), 12)} ${pad(e.status ?? "", 8)} ${esc(tool)} ${tx}`,
      );
    }
    ledgerEl.innerHTML = box("RECENT SETTLEMENTS", lines);
  }

  async function refresh() {
    try {
      const [health, pnl, cashflow, wallets] = await Promise.all([
        getJson("/health"),
        getJson("/v1/pnl"),
        getJson("/v1/cashflow?limit=25"),
        getJson("/v1/wallets"),
      ]);

      metaEl.textContent = [
        `v${health.version ?? "?"}`,
        `env=${health.x402_env ?? "?"}`,
        `net=${health.network_label ?? health.network ?? "?"}`,
        `apis=${health.warmed_apis ?? 0}`,
        `inbound=${health.inbound_paywall?.enabled ? "ON" : "OFF"}`,
        `refresh=${clock()}`,
      ].join("  ·  ");

      renderWallets(wallets);
      renderPnl(pnl);
      renderLedger(cashflow);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      metaEl.innerHTML = `<span class="err">ERROR ${esc(msg)}</span>  ·  ${clock()}`;
    }
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
})();
