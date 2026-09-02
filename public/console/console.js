(() => {
  const REFRESH_MS = 5000;
  const TZ = "America/New_York";

  const metaEl = document.getElementById("meta");
  const walletsEl = document.getElementById("wallets-frame");
  const pnlEl = document.getElementById("pnl-frame");
  const ledgerEl = document.getElementById("ledger-frame");
  const infoModal = document.getElementById("info-modal");
  const infoOpen = document.getElementById("info-open");
  const infoClose = document.getElementById("info-close");
  const infoBackdrop = document.getElementById("info-close-backdrop");

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

  function pad(label, width) {
    const s = String(label);
    return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
  }

  function formatEastern(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value ?? "");
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "short",
    })
      .format(date)
      .replace(",", "");
  }

  function clock() {
    return formatEastern(new Date());
  }

  function explorerAddressUrl(address, network) {
    if (!address) return "";
    const isSepolia = String(network ?? "").includes("84532") || String(network ?? "").includes("sepolia");
    const base = isSepolia ? "https://sepolia.basescan.org" : "https://basescan.org";
    return `${base}/address/${address}`;
  }

  function addrLink(address, explorerUrl, network) {
    if (!address) return "—";
    const href = explorerUrl || explorerAddressUrl(address, network);
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(address)}</a>`;
  }

  function box(title, lines) {
    const width = Math.min(
      96,
      Math.max(48, ...lines.map((l) => l.replace(/<[^>]+>/g, "").length), title.length + 4),
    );
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
    const network = wallets.network;
    const lines = [
      "role      USDC           ETH",
      "────────  ─────────────  ──────────────",
      `treasury  ${pad(money(t.usdc), 13)}  ${esc(eth(t.eth))}`,
      `  Basescan ${addrLink(t.address, t.explorer_url, network)}`,
      `merchant  ${pad(money(m.usdc), 13)}  ${esc(eth(m.eth))}`,
      `  Basescan ${addrLink(m.address, m.explorer_url, network)}`,
      "",
      `updated ${esc(formatEastern(wallets.updated_at))}`,
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
      `ledger updated ${esc(formatEastern(pnl.updated_at ?? ""))}`,
    ];
    pnlEl.innerHTML = box("PNL", lines);
  }

  function renderLedger(cashflow) {
    const entries = cashflow?.entries ?? [];
    const network = cashflow?.pnl?.network;
    if (!entries.length) {
      ledgerEl.innerHTML = box("RECENT SETTLEMENTS", ["(no ledger entries yet)"]);
      return;
    }
    const lines = [
      `${pad("time (ET)", 22)} ${pad("dir", 7)} ${pad("usd", 12)} recipient / tx`,
      `${pad("──────────────────────", 22)} ${pad("───────", 7)} ${pad("────────────", 12)} ────────────────`,
    ];
    for (const e of entries.slice(0, 20)) {
      const when = formatEastern(e.at);
      const dir = e.direction ?? "?";
      const recipient = e.to
        ? addrLink(e.to, explorerAddressUrl(e.to, e.network || network), e.network || network)
        : "—";
      const tx = e.explorer_url
        ? `<a href="${esc(e.explorer_url)}" target="_blank" rel="noopener">tx</a>`
        : "";
      lines.push(
        `${pad(when, 22)} ${pad(dir, 7)} ${pad(money(e.amount_usd), 12)} ${recipient}${tx ? `  ${tx}` : ""}`,
      );
    }
    ledgerEl.innerHTML = box("RECENT SETTLEMENTS", lines);
  }

  function openInfo() {
    infoModal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    infoClose.focus();
  }

  function closeInfo() {
    infoModal.classList.add("hidden");
    document.body.classList.remove("modal-open");
    infoOpen.focus();
  }

  infoOpen.addEventListener("click", openInfo);
  infoClose.addEventListener("click", closeInfo);
  infoBackdrop.addEventListener("click", closeInfo);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !infoModal.classList.contains("hidden")) {
      closeInfo();
    }
  });

  function absoluteUrl(path) {
    return new URL(path, window.location.origin).toString();
  }

  function wireMcpLinks() {
    const mcp = document.getElementById("mcp-link");
    const health = document.getElementById("health-link");
    if (mcp) {
      const url = absoluteUrl("/mcp");
      mcp.href = url;
      mcp.textContent = url;
    }
    if (health) {
      const url = absoluteUrl("/health");
      health.href = url;
      health.textContent = url;
    }
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
  }

  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetId = btn.getAttribute("data-copy-target");
      const link = targetId ? document.getElementById(targetId) : null;
      const status = targetId
        ? document.querySelector(`[data-copy-status="${targetId}"]`)
        : null;
      if (!link) return;
      try {
        await copyText(link.href || link.textContent || "");
        if (status) {
          status.textContent = "copied";
          setTimeout(() => {
            status.textContent = "";
          }, 1400);
        }
      } catch {
        if (status) status.textContent = "failed";
      }
    });
  });

  wireMcpLinks();

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
        `tz=ET (Boston)`,
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
