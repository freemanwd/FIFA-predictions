#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "predictions.json");
const htmlPath = path.join(root, "fifa-predictions.html");
const indexPath = path.join(root, "index.html");
const mdPath = path.join(root, "predictions.md");
const apiUrl = "https://gamma-api.polymarket.com/events?series_slug=soccer-fifwc&limit=500";

function readData() {
  return JSON.parse(fs.readFileSync(dataPath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function parseJsonMaybe(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function pct(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 1)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function moneylineMarkets(event) {
  return (event.markets || [])
    .filter((market) => market.sportsMarketType === "moneyline")
    .map((market) => {
      const prices = parseJsonMaybe(market.outcomePrices);
      const yesPrice = Number(prices?.[0]);
      const title = market.groupItemTitle?.startsWith("Draw") ? "Draw" : market.groupItemTitle;
      return {
        title,
        price: yesPrice,
        closed: Boolean(market.closed),
        question: market.question,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk
      };
    })
    .filter((market) => Number.isFinite(market.price));
}

function isMatchEvent(event) {
  return (
    event &&
    typeof event.title === "string" &&
    event.title.includes(" vs. ") &&
    !event.title.includes(" - ") &&
    moneylineMarkets(event).length >= 3
  );
}

function eventStart(event) {
  return event.startTime || event.endDate || event.eventDate;
}

function leadingOutcome(markets) {
  return [...markets].sort((a, b) => b.price - a.price)[0];
}

function resolvedOutcome(markets) {
  const winner = markets.find((market) => market.closed && market.price >= 0.999);
  return winner?.title || null;
}

function statusFor(match) {
  if (!match.pickedOutcome || !match.resolvedOutcome) return "pending";
  return match.resolvedOutcome === match.pickedOutcome ? "correct" : "missed";
}

function record(data) {
  const wins = data.baseRecord.wins + data.matches.filter((match) => statusFor(match) === "correct").length;
  const losses = data.baseRecord.losses + data.matches.filter((match) => statusFor(match) === "missed").length;
  return { wins, losses, exactScores: data.baseRecord.exactScores };
}

function mergeEvent(existing, event, now) {
  const markets = moneylineMarkets(event);
  const leader = leadingOutcome(markets);
  const resolved = resolvedOutcome(markets);
  const startTime = eventStart(event);
  const match = existing || {};

  const isResolved = Boolean(match.resolvedOutcome || resolved);
  const shouldRefreshPick = !isResolved;

  return {
    ...match,
    slug: event.slug,
    match: event.title,
    startTime,
    pickedOutcome: shouldRefreshPick ? leader.title : match.pickedOutcome,
    pickedProbability: shouldRefreshPick ? leader.price : match.pickedProbability,
    resolvedOutcome: match.resolvedOutcome || resolved || undefined,
    status: statusFor({ ...match, resolvedOutcome: match.resolvedOutcome || resolved }),
    marketSnapshot: markets.map(({ title, price, bestBid, bestAsk }) => ({ title, price, bestBid, bestAsk })),
    url: `https://polymarket.com/event/${event.slug}`,
    lastChecked: now
  };
}

function makeMarkdown(data) {
  const totals = record(data);
  const lines = [
    "# FIFA Predictions",
    "",
    `Running total: ${totals.wins}-${totals.losses}`,
    `Exact scores: ${totals.exactScores}`,
    `Last updated: ${data.lastUpdated}`,
    "",
    "## Completed Picks",
    ""
  ];

  for (const pick of data.completedPicks) {
    lines.push(`${pick.match} ${pick.pick} - ${pick.status}`);
  }

  lines.push("", "## Polymarket Moneyline Picks", "");
  for (const match of data.matches) {
    const result = match.resolvedOutcome ? `, result: ${match.resolvedOutcome}, ${statusFor(match)}` : "";
    lines.push(`${match.match.replace(" vs. ", "/")} - ${match.pickedOutcome}, ${pct(match.pickedProbability)}${result}`);
  }

  lines.push("", `Shareable page: fifa-predictions.html`);
  return `${lines.join("\n")}\n`;
}

function makeHtml(data) {
  const totals = record(data);
  const pending = data.matches.filter((match) => !match.resolvedOutcome).length;
  const rows = data.matches
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .map((match) => {
      const status = statusFor(match);
      const marketText = (match.marketSnapshot || [])
        .map((market) => `${market.title} ${pct(market.price)}`)
        .join(" | ");
      return `<tr>
        <td><a href="${escapeHtml(match.url)}">${escapeHtml(match.match)}</a><span>${escapeHtml(new Date(match.startTime).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }))} ET</span></td>
        <td>${escapeHtml(match.pickedOutcome)}</td>
        <td>${escapeHtml(pct(match.pickedProbability))}</td>
        <td class="status ${escapeHtml(status)}">${escapeHtml(status)}</td>
        <td>${escapeHtml(match.resolvedOutcome || "TBD")}</td>
        <td>${escapeHtml(marketText)}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FIFA Predictions</title>
  <style>
    :root { color-scheme: light; --ink: #17202a; --muted: #637083; --line: #d9e1ea; --bg: #f6f8fb; --panel: #fff; --accent: #0f6b5f; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    header { padding: 32px 24px 20px; background: #0d2b3e; color: white; }
    main { max-width: 1120px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 34px; line-height: 1.1; letter-spacing: 0; }
    p { margin: 0; color: #d5e2ea; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 22px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
    .metric strong { display: block; font-size: 28px; line-height: 1.1; }
    .metric span { color: var(--muted); font-size: 13px; }
    .table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    table { border-collapse: collapse; width: 100%; min-width: 920px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; font-size: 14px; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; background: #fbfcfe; }
    tr:last-child td { border-bottom: 0; }
    a { color: #0b5cad; text-decoration: none; font-weight: 650; }
    td span { display: block; color: var(--muted); margin-top: 3px; font-size: 12px; }
    .status { font-weight: 700; text-transform: capitalize; }
    .correct { color: #16794c; }
    .missed { color: #b42318; }
    .pending { color: #8a5a00; }
    footer { color: var(--muted); font-size: 13px; margin-top: 16px; }
    @media (max-width: 760px) {
      header { padding: 24px 18px 18px; }
      main { padding: 18px; }
      h1 { font-size: 28px; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <header>
    <h1>FIFA Predictions</h1>
    <p>Polymarket moneyline leaders with a running prediction total through the July 19, 2026 final.</p>
  </header>
  <main>
    <section class="summary">
      <div class="metric"><strong>${totals.wins}-${totals.losses}</strong><span>Running total</span></div>
      <div class="metric"><strong>${totals.exactScores}</strong><span>Exact scores</span></div>
      <div class="metric"><strong>${pending}</strong><span>Pending tracked matches</span></div>
      <div class="metric"><strong>${escapeHtml(new Date(data.lastUpdated).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</strong><span>Last updated ET</span></div>
    </section>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Match</th>
            <th>Pick</th>
            <th>Implied</th>
            <th>Status</th>
            <th>Result</th>
            <th>Moneyline Snapshot</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <footer>Source: Polymarket FIFA World Cup moneyline markets. Prices are market-implied probabilities at update time and can move before kickoff.</footer>
  </main>
</body>
</html>
`;
}

async function main() {
  const data = readData();
  const now = new Date().toISOString();
  const stopAfter = new Date(`${data.finalDate}T23:59:59-04:00`);
  if (new Date(now) > stopAfter) {
    console.log(`Tournament final date has passed; no update needed after ${data.finalDate}.`);
    return;
  }

  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`Polymarket API failed: ${response.status} ${response.statusText}`);
  }

  const events = await response.json();
  const eventBySlug = new Map(events.filter(isMatchEvent).map((event) => [event.slug, event]));
  const existingBySlug = new Map(data.matches.map((match) => [match.slug, match]));
  const finalDate = new Date(`${data.finalDate}T23:59:59Z`);

  for (const event of eventBySlug.values()) {
    const start = new Date(eventStart(event));
    if (Number.isNaN(start.getTime()) || start > finalDate) continue;
    const existing = existingBySlug.get(event.slug);
    const markets = moneylineMarkets(event);
    if (!existing && resolvedOutcome(markets)) continue;
    if (existing || start >= new Date("2026-06-27T00:00:00Z")) {
      existingBySlug.set(event.slug, mergeEvent(existing, event, now));
    }
  }

  data.matches = [...existingBySlug.values()].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  data.lastUpdated = now;

  writeJson(dataPath, data);
  fs.writeFileSync(mdPath, makeMarkdown(data));
  const html = makeHtml(data);
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(indexPath, html);

  const totals = record(data);
  console.log(`Updated predictions: ${data.matches.length} matches, record ${totals.wins}-${totals.losses}`);
  console.log(`Wrote ${path.relative(root, mdPath)}, ${path.relative(root, htmlPath)}, and ${path.relative(root, indexPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
