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
const upcomingScheduleDays = 7;

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

function upcomingEasternDateKeys(now, days) {
  const date = new Date(now);
  const keys = [];
  for (let offset = 0; offset <= days; offset += 1) {
    const next = new Date(date);
    next.setUTCDate(date.getUTCDate() + offset);
    keys.push(easternDateKey(next.toISOString()));
  }
  return keys;
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

function manualLeaderboardEntries(data) {
  return [...(data.manualLeaderboard?.entries || [])]
    .map((entry, index) => ({ ...entry, smsOrder: index }))
    .sort((a, b) => b.points - a.points || a.smsOrder - b.smsOrder);
}

function rankedEntries(entries) {
  let previousPoints = null;
  let previousRank = 0;
  return entries.map((entry, index) => {
    const rank = entry.points === previousPoints ? previousRank : index + 1;
    previousPoints = entry.points;
    previousRank = rank;
    return { ...entry, rank };
  });
}

function scoreTextForMatch(match, score) {
  if (!score) return "";
  const teams = matchTeams(match.match);
  const left = teams[0];
  const right = teams[1];
  if (left && right && Number.isFinite(score[left]) && Number.isFinite(score[right])) {
    return `${left} ${score[left]}-${score[right]} ${right}`;
  }
  return Object.entries(score)
    .map(([team, goals]) => `${team} ${goals}`)
    .join(", ");
}

function scorePickRows(data) {
  const matchesBySlug = new Map(data.matches.map((match) => [match.slug, match]));
  return data.players
    .filter((player) => player.id !== "freeman")
    .flatMap((player) =>
      Object.entries(player.picks || [])
        .filter(([, pick]) => pick.score)
        .map(([slug, pick]) => {
          const match = matchesBySlug.get(slug);
          if (!match) return null;
          const scored = pickScoreStatus(pick, match);
          return {
            player,
            match,
            pick,
            scored,
            pickText: scoreTextForMatch(match, pick.score)
          };
        })
        .filter(Boolean)
    )
    .sort((a, b) => new Date(a.match.startTime) - new Date(b.match.startTime) || a.player.name.localeCompare(b.player.name));
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

function espnEventTeams(event) {
  return (event?.competitions?.[0]?.competitors || [])
    .map((competitor) => competitor.team?.displayName)
    .filter(Boolean);
}

function espnMatchSlug(event) {
  return `espn-${event.id}`;
}

function matchFromEspnEvent(event, now) {
  const teams = espnEventTeams(event);
  if (teams.length !== 2 || !event.id || !event.date) return null;
  const match = {
    slug: espnMatchSlug(event),
    match: `${teams[0]} vs. ${teams[1]}`,
    startTime: event.date,
    status: "pending",
    url: `https://www.espn.com/soccer/match/_/gameId/${event.id}`,
    espnId: event.id,
    resultSource: "ESPN FIFA World Cup scoreboard",
    resultLastChecked: now
  };
  return mergeEspnScore(match, event, now);
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

function upcomingScheduleRows(data) {
  return data.matches
    .filter((match) => !match.pickedOutcome && !match.finalScore)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

function makeMarkdown(data) {
  const smsStandings = rankedEntries(manualLeaderboardEntries(data));
  const smsScorePicks = scorePickRows(data);
  const upcomingRows = upcomingScheduleRows(data);
  const lines = [
    "# Freeman's FIFA Predictions and Tally",
    "",
    `Last updated: ${data.lastUpdated}`,
    ""
  ];

  if (smsStandings.length) {
    lines.push(`## ${data.manualLeaderboard.title || "SMS Leaderboard"}`, "");
    lines.push(`As of: ${data.manualLeaderboard.asOfLabel || data.manualLeaderboard.asOf}`);
    lines.push("");
    for (const entry of smsStandings) {
      lines.push(`#${entry.rank} ${entry.points} pts - ${entry.name}`);
    }
  }

  if (smsScorePicks.length) {
    lines.push("", "## SMS Score Picks", "");
    for (const row of smsScorePicks) {
      const finalScore = row.match.finalScore ? `, final: ${row.match.finalScore}` : "";
      lines.push(`${row.player.name}: ${row.match.match} - ${row.pickText} (${row.scored.status}${finalScore})`);
    }
  }

  if (upcomingRows.length) {
    lines.push("", "## Upcoming Matches", "");
    for (const match of upcomingRows) {
      const kickoff = new Date(match.startTime).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
      lines.push(`${match.match} - ${kickoff} ET (${match.resultStatus || "Scheduled"})`);
    }
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
  for (const match of data.matches.filter((match) => match.pickedOutcome)) {
    const score = match.finalScore ? `, score: ${match.finalScore}` : "";
    const result = match.resolvedOutcome ? `, result: ${match.resolvedOutcome}, ${statusFor(match)}` : "";
    lines.push(`${match.match.replace(" vs. ", "/")} - ${match.pickedOutcome}, ${pct(match.pickedProbability)}${score}${result}`);
  }

  lines.push("", `Shareable page: fifa-predictions.html`);
  return `${lines.join("\n")}\n`;
}

function makeHtml(data) {
  const smsStandings = rankedEntries(manualLeaderboardEntries(data));
  const smsScorePicks = scorePickRows(data);
  const upcomingRows = upcomingScheduleRows(data);
  const smsRows = smsStandings
    .map(
      (entry) => `<tr>
        <td>${entry.rank}</td>
        <td>${entry.points}</td>
        <td>${escapeHtml(entry.name)}</td>
      </tr>`
    )
    .join("\n");
  const smsScoreRows = smsScorePicks
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.player.name)}<span>${escapeHtml(row.player.source || "")}</span></td>
        <td>${escapeHtml(row.match.match)}<span>${escapeHtml(new Date(row.match.startTime).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }))} ET</span></td>
        <td>${escapeHtml(row.pickText)}<span>${escapeHtml(row.pick.outcome)}</span></td>
        <td class="status ${escapeHtml(row.scored.status)}">${escapeHtml(row.scored.status)}</td>
        <td>${escapeHtml(row.match.finalScore || "TBD")}<span>${escapeHtml(row.match.resultStatus || "Awaiting final")}</span></td>
      </tr>`
    )
    .join("\n");
  const upcomingMatchRows = upcomingRows
    .map(
      (match) => `<tr>
        <td><a href="${escapeHtml(match.url || "#")}">${escapeHtml(match.match)}</a></td>
        <td>${escapeHtml(new Date(match.startTime).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }))} ET</td>
        <td>${escapeHtml(match.resultStatus || "Scheduled")}</td>
      </tr>`
    )
    .join("\n");
  const rows = data.matches
    .filter((match) => match.pickedOutcome)
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
    .section-title { margin: 0 0 10px; font-size: 18px; }
    .section-title + .section-note { margin-top: -4px; }
    .table-wrap + .section-title { margin-top: 26px; }
    .section-note { color: var(--muted); margin: -4px 0 12px; font-size: 13px; }
    .table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    table { border-collapse: collapse; width: 100%; min-width: 920px; }
    .leaderboard { min-width: 0; table-layout: fixed; }
    .leaderboard th:nth-child(1), .leaderboard td:nth-child(1) { width: 56px; }
    .leaderboard th:nth-child(2), .leaderboard td:nth-child(2) { width: 116px; }
    .leaderboard th, .leaderboard td { padding: 10px 12px; }
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
    }
  </style>
</head>
<body>
  <header>
    <h1>Freeman's FIFA Predictions and Tally</h1>
    <p>Polymarket moneyline picks, ESPN final scores, and a running pool tally through the July 19, 2026 final.</p>
  </header>
  <main>
    ${smsRows ? `<h2 class="section-title">${escapeHtml(data.manualLeaderboard?.title || "SMS Leaderboard")}</h2>
    <p class="section-note">As of ${escapeHtml(data.manualLeaderboard?.asOfLabel || data.manualLeaderboard?.asOf || "")}. Source: ${escapeHtml(data.manualLeaderboard?.source || "SMS thread")}.</p>
    <div class="table-wrap">
      <table class="leaderboard">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Total points</th>
            <th>Name</th>
          </tr>
        </thead>
        <tbody>${smsRows}</tbody>
      </table>
    </div>` : ""}
    ${smsScoreRows ? `<h2 class="section-title">SMS Score Picks</h2>
    <p class="section-note">From the SMS thread. ESPN final scores will grade winner and exact-score points as matches complete.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Match</th>
            <th>Pick</th>
            <th>Status</th>
            <th>Final Score</th>
          </tr>
        </thead>
        <tbody>${smsScoreRows}</tbody>
      </table>
    </div>` : ""}
    ${upcomingMatchRows ? `<h2 class="section-title">Upcoming Matches</h2>
    <p class="section-note">ESPN schedule for the next week. Use these match names when sending new SMS predictions.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Match</th>
            <th>Kickoff</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${upcomingMatchRows}</tbody>
      </table>
    </div>` : ""}
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
    const dateKeys = [
      ...new Set([
        ...data.matches.map((match) => easternDateKey(match.startTime)),
        ...upcomingEasternDateKeys(now, upcomingScheduleDays)
      ])
    ];
    const espnEvents = await fetchEspnEvents(dateKeys);
    const existingEspnIds = new Set(data.matches.map((match) => String(match.espnId || "")).filter(Boolean));
    for (const espnEvent of espnEvents) {
      if (existingEspnIds.has(String(espnEvent.id))) continue;
      const espnMatch = matchFromEspnEvent(espnEvent, now);
      if (espnMatch) {
        data.matches.push(espnMatch);
        existingEspnIds.add(String(espnEvent.id));
      }
    }
    data.matches = data.matches.map((match) => {
      const espnEvent = match.espnId
        ? espnEvents.find((event) => String(event.id) === String(match.espnId))
        : findEspnEvent(match, espnEvents);
      return espnEvent ? mergeEspnScore(match, espnEvent, now) : match;
    });
  } catch (error) {
    console.warn(`ESPN score refresh skipped: ${error.message}`);
  }
  data.matches = data.matches.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
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
