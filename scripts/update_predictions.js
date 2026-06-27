#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dataPath = path.join(root, "data", "predictions.json");
const htmlPath = path.join(root, "fifa-predictions.html");
const indexPath = path.join(root, "index.html");
const mdPath = path.join(root, "predictions.md");
const apiUrl = "https://gamma-api.polymarket.com/events?series_slug=soccer-fifwc&limit=500";
const espnScoreboardUrl = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

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

function normalizeTeam(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replaceAll("&", "and")
    .replace(/[^a-z0-9]/g, "");
  const aliases = {
    congodr: "drcongo",
    democraticrepublicofcongo: "drcongo",
    czechrepublic: "czechia",
    usa: "unitedstates",
    us: "unitedstates"
  };
  return aliases[normalized] || normalized;
}

function matchTeams(matchName) {
  return String(matchName || "").split(" vs. ").map((team) => team.trim()).filter(Boolean);
}

function easternDateKey(isoDate) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(isoDate));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}${part("month")}${part("day")}`;
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

function scoreStatusFor(match) {
  if (!match.score) return "pending";
  return statusFor(match);
}

function pickScoreStatus(pick, match) {
  if (!match.resolvedOutcome) return { status: "pending", points: 0, correct: false, exact: false };
  const correct = pick?.outcome === match.resolvedOutcome;
  const exact =
    correct &&
    pick?.score &&
    match.score &&
    Object.entries(pick.score).every(([team, goals]) => match.score[team] === goals);
  return {
    status: exact ? "exact" : correct ? "correct" : "missed",
    points: (correct ? 1 : 0) + (exact ? 1 : 0),
    correct,
    exact
  };
}

function playerStats(data) {
  ensurePlayers(data);
  return data.players
    .map((player) => {
      const base = player.baseRecord || {};
      const stats = {
        id: player.id,
        name: player.name,
        source: player.source,
        points: base.points || 0,
        correct: base.correct || 0,
        missed: base.missed || 0,
        exactScores: base.exactScores || 0,
        pending: 0
      };

      for (const match of data.matches) {
        const pick = player.picks?.[match.slug];
        if (!pick) continue;
        const scored = pickScoreStatus(pick, match);
        if (scored.status === "pending") {
          stats.pending += 1;
          continue;
        }
        stats.points += scored.points;
        if (scored.correct) stats.correct += 1;
        if (!scored.correct) stats.missed += 1;
        if (scored.exact) stats.exactScores += 1;
      }

      return stats;
    })
    .sort((a, b) => b.points - a.points || b.correct - a.correct || b.exactScores - a.exactScores || a.name.localeCompare(b.name));
}

function record(data) {
  const freeman = playerStats(data).find((player) => player.id === "freeman");
  if (freeman) {
    return {
      wins: freeman.correct,
      losses: freeman.missed,
      exactScores: freeman.exactScores,
      points: freeman.points
    };
  }
  const wins = data.baseRecord.wins + data.matches.filter((match) => scoreStatusFor(match) === "correct").length;
  const losses = data.baseRecord.losses + data.matches.filter((match) => scoreStatusFor(match) === "missed").length;
  return { wins, losses, exactScores: data.baseRecord.exactScores, points: wins + data.baseRecord.exactScores };
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

function ensurePlayers(data) {
  if (!Array.isArray(data.players)) {
    data.players = [
      {
        id: "freeman",
        name: "Freeman",
        source: "Polymarket moneyline leaders",
        baseRecord: {
          points: (data.baseRecord?.wins || 0) + (data.baseRecord?.exactScores || 0),
          correct: data.baseRecord?.wins || 0,
          missed: data.baseRecord?.losses || 0,
          exactScores: data.baseRecord?.exactScores || 0
        },
        picks: {}
      }
    ];
  }

  let freeman = data.players.find((player) => player.id === "freeman");
  if (!freeman) {
    freeman = {
      id: "freeman",
      name: "Freeman",
      source: "Polymarket moneyline leaders",
      baseRecord: {
        points: (data.baseRecord?.wins || 0) + (data.baseRecord?.exactScores || 0),
        correct: data.baseRecord?.wins || 0,
        missed: data.baseRecord?.losses || 0,
        exactScores: data.baseRecord?.exactScores || 0
      },
      picks: {}
    };
    data.players.unshift(freeman);
  }

  freeman.picks ||= {};
  for (const match of data.matches || []) {
    if (!match.slug || !match.pickedOutcome) continue;
    freeman.picks[match.slug] = {
      ...(freeman.picks[match.slug] || {}),
      outcome: match.pickedOutcome,
      probability: match.pickedProbability,
      source: "Polymarket"
    };
  }
}

async function fetchEspnEvents(dateKeys) {
  const events = [];
  for (const dateKey of dateKeys) {
    const url = `${espnScoreboardUrl}?dates=${dateKey}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ESPN scoreboard failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    events.push(...(payload.events || []));
  }
  return events;
}

function findEspnEvent(match, events) {
  const teams = matchTeams(match.match).map(normalizeTeam);
  if (teams.length !== 2) return null;
  const key = [...teams].sort().join("|");
  return events.find((event) => {
    const competitors = event.competitions?.[0]?.competitors || [];
    const eventKey = competitors
      .map((competitor) => normalizeTeam(competitor.team?.displayName))
      .sort()
      .join("|");
    return eventKey === key;
  });
}

function scoreFromEspnEvent(event) {
  const competition = event?.competitions?.[0];
  if (!competition) return null;
  const competitors = competition.competitors || [];
  const status = competition.status?.type || event.status?.type || {};
  const scores = {};
  for (const competitor of competitors) {
    const team = competitor.team?.displayName;
    const score = Number(competitor.score);
    if (team && Number.isFinite(score)) {
      scores[normalizeTeam(team)] = score;
    }
  }
  return {
    id: event.id,
    completed: Boolean(status.completed),
    status: status.description || "Scheduled",
    detail: status.detail || status.shortDetail || "",
    scores
  };
}

function mergeEspnScore(match, espnEvent, now) {
  const scoreEvent = scoreFromEspnEvent(espnEvent);
  if (!scoreEvent) return match;

  const teams = matchTeams(match.match);
  const left = teams[0];
  const right = teams[1];
  const leftScore = scoreEvent.scores[normalizeTeam(left)];
  const rightScore = scoreEvent.scores[normalizeTeam(right)];
  const hasScore = Number.isFinite(leftScore) && Number.isFinite(rightScore);

  const next = {
    ...match,
    espnId: scoreEvent.id,
    resultStatus: scoreEvent.status,
    resultDetail: scoreEvent.detail,
    resultSource: "ESPN FIFA World Cup scoreboard",
    resultLastChecked: now
  };

  if (scoreEvent.completed && hasScore) {
    next.score = { [left]: leftScore, [right]: rightScore };
    next.finalScore = `${left} ${leftScore}-${rightScore} ${right}`;
    next.resolvedOutcome = leftScore === rightScore ? "Draw" : leftScore > rightScore ? left : right;
    next.status = statusFor(next);
  }

  return next;
}

function makeMarkdown(data) {
  const totals = record(data);
  const standings = playerStats(data);
  const lines = [
    "# Freeman's FIFA Predictions and Tally",
    "",
    `Freeman: ${totals.points} pts, ${totals.wins}-${totals.losses}`,
    `Exact scores: ${totals.exactScores}`,
    `Last updated: ${data.lastUpdated}`,
    "",
    "## Leaderboard",
    ""
  ];

  for (const player of standings) {
    lines.push(`${player.name}: ${player.points} pts, ${player.correct}-${player.missed}, ${player.exactScores} exact`);
  }

  lines.push(
    "",
    "## Completed Picks",
    ""
  );

  for (const pick of data.completedPicks) {
    lines.push(`${pick.match} ${pick.pick} - ${pick.status}`);
  }

  lines.push("", "## Polymarket Moneyline Picks", "");
  for (const match of data.matches) {
    const score = match.finalScore ? `, score: ${match.finalScore}` : "";
    const result = match.resolvedOutcome ? `, result: ${match.resolvedOutcome}, ${statusFor(match)}` : "";
    lines.push(`${match.match.replace(" vs. ", "/")} - ${match.pickedOutcome}, ${pct(match.pickedProbability)}${score}${result}`);
  }

  lines.push("", `Shareable page: fifa-predictions.html`);
  return `${lines.join("\n")}\n`;
}

function makeHtml(data) {
  const totals = record(data);
  const standings = playerStats(data);
  const leader = standings[0];
  const pending = data.matches.filter((match) => !match.resolvedOutcome).length;
  const standingsRows = standings
    .map(
      (player, index) => `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(player.name)}<span>${escapeHtml(player.source || "")}</span></td>
        <td>${player.points}</td>
        <td>${player.correct}-${player.missed}</td>
        <td>${player.exactScores}</td>
        <td>${player.pending}</td>
      </tr>`
    )
    .join("\n");
  const rows = data.matches
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    .map((match) => {
      const status = statusFor(match);
      const freeman = data.players.find((player) => player.id === "freeman");
      const freemanPick = freeman?.picks?.[match.slug];
      const freemanStatus = freemanPick ? pickScoreStatus(freemanPick, match).status : status;
      const marketText = (match.marketSnapshot || [])
        .map((market) => `${market.title} ${pct(market.price)}`)
        .join(" | ");
      return `<tr>
        <td><a href="${escapeHtml(match.url)}">${escapeHtml(match.match)}</a><span>${escapeHtml(new Date(match.startTime).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }))} ET</span></td>
        <td>${escapeHtml(freemanPick?.outcome || match.pickedOutcome)}<span>${escapeHtml(pct(freemanPick?.probability || match.pickedProbability))}</span></td>
        <td>${escapeHtml(pct(match.pickedProbability))}</td>
        <td class="status ${escapeHtml(freemanStatus)}">${escapeHtml(freemanStatus)}</td>
        <td>${escapeHtml(match.finalScore || match.resolvedOutcome || "TBD")}<span>${escapeHtml(match.resultStatus || "Awaiting final")}</span></td>
        <td>${escapeHtml(marketText)}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Freeman's FIFA Predictions and Tally</title>
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
    .section-title { margin: 26px 0 10px; font-size: 18px; }
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
    .exact { color: #0f6b5f; }
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
    <h1>Freeman's FIFA Predictions and Tally</h1>
    <p>Polymarket moneyline picks, ESPN final scores, and a running pool tally through the July 19, 2026 final.</p>
  </header>
  <main>
    <section class="summary">
      <div class="metric"><strong>${escapeHtml(leader?.name || "Freeman")}</strong><span>Current leader</span></div>
      <div class="metric"><strong>${totals.points}</strong><span>Freeman points</span></div>
      <div class="metric"><strong>${totals.exactScores}</strong><span>Exact scores</span></div>
      <div class="metric"><strong>${pending}</strong><span>Pending matches</span></div>
    </section>
    <h2 class="section-title">Leaderboard</h2>
    <div class="table-wrap">
      <table class="leaderboard">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Player</th>
            <th>Pts</th>
            <th>Record</th>
            <th>Exact</th>
            <th>Pending</th>
          </tr>
        </thead>
        <tbody>${standingsRows}</tbody>
      </table>
    </div>
    <h2 class="section-title">Match Picks</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Match</th>
            <th>Freeman Pick</th>
            <th>Implied</th>
            <th>Status</th>
            <th>Final Score</th>
            <th>Moneyline Snapshot</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <footer>Sources: Polymarket FIFA World Cup moneyline markets for picks; ESPN FIFA World Cup scoreboard for final scores. Prices can move before kickoff.</footer>
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
  try {
    const dateKeys = [...new Set(data.matches.map((match) => easternDateKey(match.startTime)))];
    const espnEvents = await fetchEspnEvents(dateKeys);
    data.matches = data.matches.map((match) => {
      const espnEvent = findEspnEvent(match, espnEvents);
      return espnEvent ? mergeEspnScore(match, espnEvent, now) : match;
    });
  } catch (error) {
    console.warn(`ESPN score refresh skipped: ${error.message}`);
  }
  ensurePlayers(data);
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
