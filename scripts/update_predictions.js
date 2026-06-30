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

function decisionLabel(pick) {
  return pick?.decision || pick?.decisionWindow || "";
}

const teamFlagCodes = {
  algeria: "dz",
  argentina: "ar",
  australia: "au",
  austria: "at",
  belgium: "be",
  bosniaherzegovina: "ba",
  brazil: "br",
  canada: "ca",
  capeverde: "cv",
  colombia: "co",
  congodr: "cd",
  coteivoire: "ci",
  ctedivoire: "ci",
  croatia: "hr",
  drcongo: "cd",
  ecuador: "ec",
  egypt: "eg",
  england: "gb-eng",
  france: "fr",
  germany: "de",
  ghana: "gh",
  ivorycoast: "ci",
  japan: "jp",
  mexico: "mx",
  morocco: "ma",
  netherlands: "nl",
  norway: "no",
  panama: "pa",
  paraguay: "py",
  portugal: "pt",
  senegal: "sn",
  southafrica: "za",
  spain: "es",
  sweden: "se",
  switzerland: "ch",
  unitedstates: "us",
  uzbekistan: "uz"
};

const knockoutTeamOrder = [
  "Brazil",
  "Japan",
  "Ivory Coast",
  "Norway",
  "Mexico",
  "Ecuador",
  "England",
  "DR Congo",
  "Argentina",
  "Cape Verde",
  "Australia",
  "Egypt",
  "Switzerland",
  "Algeria",
  "Colombia",
  "Ghana",
  "Senegal",
  "Belgium",
  "United States",
  "Bosnia-Herzegovina",
  "Spain",
  "Austria",
  "Portugal",
  "Croatia",
  "Netherlands",
  "Morocco",
  "Canada",
  "South Africa",
  "France",
  "Sweden",
  "Germany",
  "Paraguay"
];

const knockoutOrderIndex = new Map(knockoutTeamOrder.map((team, index) => [normalizeTeam(team), index]));

function flagCodeForTeam(team) {
  return teamFlagCodes[normalizeTeam(team)] || "";
}

function teamInitials(team) {
  return String(team || "")
    .split(/\s+|-/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function formatKickoff(startTime) {
  return `${new Date(startTime).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short"
  })} ET`;
}

function round32Matches(data) {
  const cutoff = new Date("2026-06-28T00:00:00Z");
  return data.matches
    .filter((match) => {
      const teams = matchTeams(match.match);
      const indexes = teams.map((team) => knockoutOrderIndex.get(normalizeTeam(team)));
      return (
        teams.length === 2 &&
        new Date(match.startTime) >= cutoff &&
        !teams.some((team) => /round of 32/i.test(team)) &&
        indexes.every(Number.isFinite) &&
        Math.floor(indexes[0] / 2) === Math.floor(indexes[1] / 2)
      );
    })
    .sort((a, b) => {
      const aOrder = Math.min(...matchTeams(a.match).map((team) => knockoutOrderIndex.get(normalizeTeam(team)) ?? 999));
      const bOrder = Math.min(...matchTeams(b.match).map((team) => knockoutOrderIndex.get(normalizeTeam(team)) ?? 999));
      return aOrder - bOrder || new Date(a.startTime) - new Date(b.startTime);
    });
}

function orderedKnockoutTeams(match) {
  return matchTeams(match.match).sort((a, b) => {
    return (knockoutOrderIndex.get(normalizeTeam(a)) ?? 999) - (knockoutOrderIndex.get(normalizeTeam(b)) ?? 999);
  });
}

function winnerForMatch(match) {
  return match.advancingOutcome || (match.resolvedOutcome && match.resolvedOutcome !== "Draw" ? match.resolvedOutcome : "");
}

function flagHtml(team) {
  const code = flagCodeForTeam(team);
  if (!code) return `<span class="flag-fallback">${escapeHtml(teamInitials(team))}</span>`;
  return `<img class="team-flag" src="https://flagcdn.com/${escapeHtml(code)}.svg" alt="">`;
}

function polarPoint(angle, radius) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: 50 + Math.cos(radians) * radius,
    y: 50 + Math.sin(radians) * radius
  };
}

function svgPoint(angle, radius) {
  const point = polarPoint(angle, radius);
  return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}

function svgCircle(angle, radius, className = "bracket-wire__dot") {
  const point = polarPoint(angle, radius);
  return `<circle class="${className}" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r=".46"></circle>`;
}

function bracketWireHtml(roundMatches) {
  const slotCount = Math.max(roundMatches.length, 16);
  const teamCount = slotCount * 2;
  const slotAngles = Array.from({ length: slotCount }, (_, index) => -90 + ((index * 2 + 0.5) * 360) / teamCount);
  const paths = [];
  const dots = [];

  slotAngles.forEach((slotAngle, index) => {
    const leftAngle = -90 + ((index * 2) * 360) / teamCount;
    const rightAngle = -90 + ((index * 2 + 1) * 360) / teamCount;
    for (const teamAngle of [leftAngle, rightAngle]) {
      paths.push(`<path d="M ${svgPoint(teamAngle, 39.4)} L ${svgPoint(teamAngle, 35.7)} L ${svgPoint(slotAngle, 31.8)}"></path>`);
      dots.push(svgCircle(teamAngle, 35.7));
    }
    paths.push(`<path class="bracket-wire__trunk" d="M ${svgPoint(slotAngle, 31.8)} L ${svgPoint(slotAngle, 29)}"></path>`);
    dots.push(svgCircle(slotAngle, 31.8, "bracket-wire__merge"));
  });

  const connectRound = (sourceAngles, fromRadius, toRadius) => {
    const nextAngles = [];
    for (let index = 0; index < sourceAngles.length; index += 2) {
      const left = sourceAngles[index];
      const right = sourceAngles[index + 1];
      if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
      const mid = (left + right) / 2;
      const bendRadius = (fromRadius + toRadius) / 2;
      paths.push(`<path d="M ${svgPoint(left, fromRadius)} L ${svgPoint(left, bendRadius)} L ${svgPoint(mid, toRadius)}"></path>`);
      paths.push(`<path d="M ${svgPoint(right, fromRadius)} L ${svgPoint(right, bendRadius)} L ${svgPoint(mid, toRadius)}"></path>`);
      dots.push(svgCircle(left, bendRadius));
      dots.push(svgCircle(right, bendRadius));
      dots.push(svgCircle(mid, toRadius, "bracket-wire__merge"));
      nextAngles.push(mid);
    }
    return nextAngles;
  };

  const r16Angles = connectRound(slotAngles, 29, 21.8);
  const qfAngles = connectRound(r16Angles, 21.8, 14.8);
  const sfAngles = connectRound(qfAngles, 14.8, 8.2);
  connectRound(sfAngles, 8.2, 2.3);

  return `<g class="bracket-wire">${paths.join("\n")}${dots.join("\n")}</g>`;
}

function angleForTeam(team, totalTeams = knockoutTeamOrder.length) {
  const index = knockoutOrderIndex.get(normalizeTeam(team));
  if (!Number.isFinite(index)) return null;
  return -90 + (index * 360) / totalTeams;
}

function angleForMatch(match) {
  const angles = orderedKnockoutTeams(match)
    .map((team) => angleForTeam(team))
    .filter(Number.isFinite);
  if (!angles.length) return null;
  return angles.reduce((total, angle) => total + angle, 0) / angles.length;
}

function matchRound(match) {
  const start = new Date(match.startTime);
  if (start < new Date("2026-07-04T07:00:00Z")) return "R32";
  if (start < new Date("2026-07-09T07:00:00Z")) return "R16";
  if (start < new Date("2026-07-14T07:00:00Z")) return "QF";
  if (start < new Date("2026-07-18T07:00:00Z")) return "SF";
  return "F";
}

function advancementNodes(data, roundMatches) {
  const round32Nodes = roundMatches
    .map((match) => {
      const winner = winnerForMatch(match);
      const angle = winner ? angleForMatch(match) : null;
      if (!winner || !Number.isFinite(angle)) return null;
      return { team: winner, round: "R16", angle, radius: 29, source: match.finalScore || match.resultStatus || "" };
    })
    .filter(Boolean);

  const laterNodes = data.matches
    .filter((match) => winnerForMatch(match) && matchRound(match) !== "R32")
    .map((match) => {
      const winner = winnerForMatch(match);
      const angle = angleForTeam(winner);
      const round = matchRound(match);
      const radiusByRound = { R16: 20, QF: 13, SF: 7, F: 0 };
      if (!winner || !Number.isFinite(angle) || round === "F") return null;
      return { team: winner, round: round === "R16" ? "QF" : round === "QF" ? "SF" : "Final", angle, radius: radiusByRound[round], source: match.finalScore || match.resultStatus || "" };
    })
    .filter(Boolean);

  return [...round32Nodes, ...laterNodes]
    .map((node) => {
      const point = polarPoint(node.angle, node.radius);
      return `<div class="advance-node advance-node--${escapeHtml(node.round.toLowerCase())}" style="--x:${point.x.toFixed(2)}%;--y:${point.y.toFixed(2)}%;" title="${escapeHtml(`${node.round}: ${node.team}${node.source ? ` (${node.source})` : ""}`)}">
          ${flagHtml(node.team)}
          <span>${escapeHtml(node.round)}</span>
        </div>`;
    })
    .join("\n");
}

function knockoutVisualHtml(data, smsStandings, upcomingRows) {
  const roundMatches = round32Matches(data);
  const teams = roundMatches.flatMap((match) => orderedKnockoutTeams(match));
  const totalTeams = teams.length || 1;
  const topThree = smsStandings.slice(0, 3);
  const nextMatches = upcomingRows.slice(0, 3);
  const advances = advancementNodes(data, roundMatches);
  const bracketWire = bracketWireHtml(roundMatches);
  const teamNodes = teams
    .map((team, index) => {
      const angle = -90 + (index * 360) / totalTeams;
      const { x, y } = polarPoint(angle, 43);
      const match = roundMatches[Math.floor(index / 2)];
      const winner = winnerForMatch(match);
      const isWinner = winner && normalizeTeam(winner) === normalizeTeam(team);
      const isEliminated = winner && !isWinner;
      return `<div class="team-node ${isWinner ? "team-node--winner" : ""} ${isEliminated ? "team-node--eliminated" : ""}" style="--x:${x.toFixed(2)}%;--y:${y.toFixed(2)}%;" title="${escapeHtml(team)}">
          ${flagHtml(team)}
          <span>${escapeHtml(teamInitials(team))}</span>
        </div>`;
    })
    .join("\n");
  const matchCards = roundMatches
    .map((match, index) => {
      const teams = orderedKnockoutTeams(match);
      const winner = winnerForMatch(match);
      const finalText = match.finalScore || match.resultStatus || "Scheduled";
      return `<article class="knockout-card ${winner ? "knockout-card--final" : ""}">
          <div class="knockout-card__round">R32 ${index + 1}</div>
          <div class="knockout-card__teams">
            ${teams
              .map(
                (team) => `<div class="knockout-card__team ${winner && normalizeTeam(winner) === normalizeTeam(team) ? "is-winner" : ""}">
                  ${flagHtml(team)}
                  <span>${escapeHtml(team)}</span>
                </div>`
              )
              .join("")}
          </div>
          <div class="knockout-card__meta">${escapeHtml(finalText)}</div>
        </article>`;
    })
    .join("\n");
  const podium = topThree
    .map((entry) => `<div class="podium-item"><span>#${entry.rank}</span><strong>${escapeHtml(entry.points)}</strong><em>${escapeHtml(entry.name)}</em></div>`)
    .join("\n");
  const nextUp = nextMatches
    .map((match) => `<li><span>${escapeHtml(match.match)}</span><em>${escapeHtml(formatKickoff(match.startTime))}</em></li>`)
    .join("\n");

  return `<section class="knockout-hero" aria-label="Knockout round visual">
      <aside class="knockout-sidebar">
        <p class="eyebrow">Final knockout rounds</p>
        <h1>${escapeHtml(data.title || "FIFA Predictions, MaletasUnited Rankings,")}</h1>
        <p class="hero-copy">Polymarket moneyline picks, ESPN final scores.</p>
        <div class="podium">${podium}</div>
        ${nextUp ? `<div class="next-up"><h2>Next up</h2><ul>${nextUp}</ul></div>` : ""}
      </aside>
      <div class="knockout-main">
        <div class="orbit-board">
          <svg class="orbit-lines" viewBox="0 0 100 100" aria-hidden="true">
            ${bracketWire}
            <g class="orbit-rings">
              <circle cx="50" cy="50" r="43"></circle>
              <circle cx="50" cy="50" r="29"></circle>
              <circle cx="50" cy="50" r="21.8"></circle>
              <circle cx="50" cy="50" r="14.8"></circle>
              <circle cx="50" cy="50" r="8.2"></circle>
            </g>
          </svg>
          ${teamNodes}
          ${advances}
          <div class="trophy-mark"><span>2026</span><strong>Final</strong><em>Jul 19</em></div>
        </div>
        <div class="knockout-card-grid">${matchCards}</div>
      </div>
    </section>`;
}

function scorePickRows(data) {
  const matchesBySlug = new Map(data.matches.map((match) => [match.slug, match]));
  return data.players
    .filter((player) => player.id !== "freeman")
    .flatMap((player) =>
      Object.entries(player.picks || [])
        .filter(([, pick]) => pick.score || pick.label || pick.note)
        .map(([slug, pick]) => {
          const match = matchesBySlug.get(slug);
          if (!match) return null;
          const scored = pickScoreStatus(pick, match);
          return {
            player,
            match,
            pick,
            scored,
            pickText: pick.score ? scoreTextForMatch(match, pick.score) : pick.label || pick.note || pick.outcome,
            decision: decisionLabel(pick)
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
  const shootoutScores = {};
  let advancingOutcome = "";
  for (const competitor of competitors) {
    const team = competitor.team?.displayName;
    const score = Number(competitor.score);
    if (team && Number.isFinite(score)) {
      scores[normalizeTeam(team)] = score;
    }
    const shootoutScore = Number(competitor.shootoutScore);
    if (team && Number.isFinite(shootoutScore)) {
      shootoutScores[normalizeTeam(team)] = shootoutScore;
    }
    if (team && (competitor.advance || competitor.winner)) {
      advancingOutcome = team;
    }
  }
  return {
    id: event.id,
    completed: Boolean(status.completed),
    status: status.description || "Scheduled",
    detail: status.detail || status.shortDetail || "",
    scores,
    shootoutScores,
    advancingOutcome
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
    const leftShootout = scoreEvent.shootoutScores[normalizeTeam(left)];
    const rightShootout = scoreEvent.shootoutScores[normalizeTeam(right)];
    const hasShootout = Number.isFinite(leftShootout) && Number.isFinite(rightShootout);
    next.finalScore = hasShootout
      ? `${left} ${leftScore}-${rightScore} ${right} (${leftShootout}-${rightShootout} PK)`
      : `${left} ${leftScore}-${rightScore} ${right}`;
    next.shootoutScore = hasShootout ? { [left]: leftShootout, [right]: rightShootout } : undefined;
    next.advancingOutcome = scoreEvent.advancingOutcome || undefined;
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
    `# ${data.title || "FIFA Predictions, MaletasUnited Rankings,"}`,
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
      const decision = row.decision ? `, decision: ${row.decision}` : "";
      lines.push(`${row.player.name}: ${row.match.match} - ${row.pickText} (${row.scored.status}${decision}${finalScore})`);
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
  const knockoutVisual = knockoutVisualHtml(data, smsStandings, upcomingRows);
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
        <td>${escapeHtml(row.match.match)}<span>${escapeHtml(formatKickoff(row.match.startTime))}</span></td>
        <td>${escapeHtml(row.pickText)}<span>${escapeHtml(row.pick.outcome)}</span></td>
        <td>${escapeHtml(row.decision || "")}</td>
        <td class="status ${escapeHtml(row.scored.status)}">${escapeHtml(row.scored.status)}</td>
        <td>${escapeHtml(row.match.finalScore || "TBD")}<span>${escapeHtml(row.match.resultStatus || "Awaiting final")}</span></td>
      </tr>`
    )
    .join("\n");
  const upcomingMatchRows = upcomingRows
    .map(
      (match) => `<tr>
        <td><a href="${escapeHtml(match.url || "#")}">${escapeHtml(match.match)}</a></td>
        <td>${escapeHtml(formatKickoff(match.startTime))}</td>
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
        <td><a href="${escapeHtml(match.url)}">${escapeHtml(match.match)}</a><span>${escapeHtml(formatKickoff(match.startTime))}</span></td>
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
  <title>${escapeHtml(data.title || "FIFA Predictions, MaletasUnited Rankings,")}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #e8e9e5;
      --ink: #111312;
      --muted: #5c625f;
      --subtle: #7b817d;
      --line: #cfd4d0;
      --line-strong: #a8afaa;
      --bracket-line: #272b29;
      --bracket-dot: #272b29;
      --surface: #f7f8f5;
      --surface-raised: #ffffff;
      --surface-muted: rgba(255,255,255,.58);
      --accent: #0f6b5f;
      --accent-soft: rgba(15,107,95,.12);
      --danger: #b42318;
      --success: #16794c;
      --warning: #8a5a00;
      --shadow: 0 18px 50px rgba(17,19,18,.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at 78% 18%, rgba(15,107,95,.14), transparent 30%),
        linear-gradient(135deg, #ece8e2 0%, #e7ece8 46%, #dde5e9 100%);
    }
    a { color: inherit; text-decoration: none; }
    .page-shell { min-height: 100vh; }
    .knockout-hero {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(248px, 320px) minmax(0, 1fr);
      gap: 18px;
      padding: 28px;
    }
    .knockout-sidebar {
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - 56px);
      padding: 4px 8px 4px 0;
    }
    .eyebrow {
      margin: 0 0 14px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0 0 14px;
      max-width: 11ch;
      font-size: clamp(30px, 4.8vw, 56px);
      line-height: .98;
      letter-spacing: 0;
      font-weight: 760;
    }
    .hero-copy {
      margin: 0;
      max-width: 28rem;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.45;
    }
    .podium {
      display: grid;
      gap: 8px;
      margin: 28px 0;
    }
    .podium-item {
      display: grid;
      grid-template-columns: 44px 44px 1fr;
      align-items: center;
      gap: 8px;
      padding: 9px 10px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface-muted);
    }
    .podium-item span,
    .podium-item em {
      color: var(--muted);
      font-size: 13px;
      font-style: normal;
    }
    .podium-item strong {
      font-size: 18px;
      line-height: 1;
    }
    .next-up {
      margin-top: auto;
      border-top: 1px solid var(--line);
      padding-top: 18px;
    }
    .next-up h2 {
      margin: 0 0 10px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--muted);
    }
    .next-up ul {
      list-style: none;
      display: grid;
      gap: 10px;
      padding: 0;
      margin: 0;
    }
    .next-up li span,
    .next-up li em {
      display: block;
      font-size: 13px;
      line-height: 1.35;
    }
    .next-up li em { color: var(--subtle); font-style: normal; margin-top: 2px; }
    .knockout-main {
      min-width: 0;
      display: grid;
      grid-template-rows: minmax(360px, 1fr) auto;
      gap: 16px;
      align-items: center;
    }
    .orbit-board {
      position: relative;
      aspect-ratio: 1;
      width: min(100%, calc(100vh - 210px), 820px);
      min-width: 320px;
      margin: 0 auto;
      color: var(--ink);
    }
    .orbit-lines {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .orbit-rings circle {
      fill: none;
      stroke: var(--line-strong);
      stroke-width: .22;
      stroke-dasharray: 1.2 1.8;
      vector-effect: non-scaling-stroke;
    }
    .bracket-wire {
      opacity: .86;
    }
    .bracket-wire path {
      fill: none;
      stroke: var(--bracket-line);
      stroke-width: .38;
      stroke-linecap: round;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    .bracket-wire__trunk {
      stroke-width: .52;
    }
    .bracket-wire circle {
      fill: var(--bracket-dot);
      stroke: var(--surface);
      stroke-width: .14;
      vector-effect: non-scaling-stroke;
    }
    .bracket-wire__merge {
      r: .58;
    }
    .team-node {
      position: absolute;
      left: var(--x);
      top: var(--y);
      width: clamp(28px, 3.2vw, 36px);
      height: clamp(28px, 3.2vw, 36px);
      transform: translate(-50%, -50%);
      border-radius: 999px;
      border: 2px solid var(--bg);
      background: var(--surface-raised);
      box-shadow: 0 6px 16px rgba(17,19,18,.16);
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .team-node span {
      display: none;
    }
    .team-node--winner { border-color: var(--accent); box-shadow: 0 0 0 5px var(--accent-soft), 0 10px 24px rgba(15,107,95,.24); }
    .team-node--eliminated { opacity: .42; filter: grayscale(.8); }
    .advance-node {
      position: absolute;
      left: var(--x);
      top: var(--y);
      width: clamp(26px, 3.1vw, 36px);
      height: clamp(26px, 3.1vw, 36px);
      transform: translate(-50%, -50%);
      border-radius: 999px;
      border: 2px solid var(--accent);
      background: var(--surface-raised);
      box-shadow: 0 0 0 5px var(--accent-soft), 0 12px 24px rgba(17,19,18,.16);
      display: grid;
      place-items: center;
      overflow: hidden;
      z-index: 4;
    }
    .advance-node span {
      display: none;
    }
    .advance-node--qf { width: clamp(28px, 3.4vw, 40px); height: clamp(28px, 3.4vw, 40px); z-index: 5; }
    .advance-node--sf { width: clamp(30px, 3.6vw, 42px); height: clamp(30px, 3.6vw, 42px); z-index: 6; }
    .advance-node--final { width: clamp(32px, 3.8vw, 44px); height: clamp(32px, 3.8vw, 44px); z-index: 7; }
    .team-flag {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .flag-fallback {
      display: grid;
      place-items: center;
      width: 100%;
      height: 100%;
      background: #202523;
      color: #fff;
      font-weight: 800;
      font-size: 12px;
    }
    .trophy-mark {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: clamp(104px, 14vw, 160px);
      aspect-ratio: 1;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(247,248,245,.86);
      display: grid;
      place-items: center;
      align-content: center;
      box-shadow: var(--shadow);
    }
    .trophy-mark span,
    .trophy-mark em {
      color: var(--muted);
      font-size: 12px;
      font-style: normal;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .trophy-mark strong {
      margin: 4px 0;
      font-size: clamp(24px, 4vw, 42px);
      line-height: .9;
    }
    .knockout-card-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .knockout-card {
      min-width: 0;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface-muted);
      padding: 9px;
    }
    .knockout-card--final { border-color: rgba(15,107,95,.34); background: rgba(255,255,255,.76); }
    .knockout-card__round {
      color: var(--subtle);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 7px;
    }
    .knockout-card__teams { display: grid; gap: 5px; }
    .knockout-card__team {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.1;
    }
    .knockout-card__team .team-flag,
    .knockout-card__team .flag-fallback {
      width: 20px;
      height: 20px;
      border-radius: 999px;
      flex: 0 0 auto;
    }
    .knockout-card__team.is-winner { color: var(--ink); font-weight: 800; }
    .knockout-card__meta {
      margin-top: 7px;
      color: var(--subtle);
      font-size: 11px;
      line-height: 1.25;
    }
    main.content {
      max-width: 1180px;
      margin: 0 auto;
      padding: 22px 28px 34px;
    }
    .section-title { margin: 0 0 10px; font-size: 18px; }
    .section-title + .section-note { margin-top: -4px; }
    .table-wrap + .section-title { margin-top: 26px; }
    .section-note { color: var(--muted); margin: -4px 0 12px; font-size: 13px; }
    .table-wrap { overflow-x: auto; background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 10px 28px rgba(17,19,18,.04); }
    table { border-collapse: collapse; width: 100%; min-width: 920px; }
    .leaderboard { min-width: 0; table-layout: fixed; }
    .leaderboard th:nth-child(1), .leaderboard td:nth-child(1) { width: 56px; }
    .leaderboard th:nth-child(2), .leaderboard td:nth-child(2) { width: 116px; }
    .leaderboard th, .leaderboard td { padding: 10px 12px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; font-size: 14px; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0; background: #fbfcf9; }
    tr:last-child td { border-bottom: 0; }
    td a { color: #0b5cad; font-weight: 650; }
    td span { display: block; color: var(--muted); margin-top: 3px; font-size: 12px; }
    .status { font-weight: 700; text-transform: capitalize; }
    .correct { color: var(--success); }
    .missed { color: var(--danger); }
    .pending { color: var(--warning); }
    .exact { color: var(--accent); }
    footer { color: var(--muted); font-size: 13px; margin-top: 16px; }
    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --bg: #121316;
        --ink: #ede8e4;
        --muted: #b8aea8;
        --subtle: #8f8480;
        --line: #3d3835;
        --line-strong: #54504b;
        --bracket-line: #d1cbc6;
        --bracket-dot: #d1cbc6;
        --surface: #1f1c1a;
        --surface-raised: #2a2623;
        --surface-muted: rgba(255,255,255,.06);
        --accent: #6fcfbd;
        --accent-soft: rgba(111,207,189,.16);
        --danger: #ff7b72;
        --success: #6fcf97;
        --warning: #ffd166;
        --shadow: 0 18px 50px rgba(0,0,0,.28);
      }
      body {
        background:
          radial-gradient(circle at 78% 18%, rgba(111,207,189,.1), transparent 30%),
          linear-gradient(135deg, #121316 0%, #181615 54%, #202321 100%);
      }
      th { background: #211e1c; }
      .team-node { border-color: #121316; }
      .trophy-mark { background: rgba(31,28,26,.9); }
    }
    @media (max-width: 1180px) {
      .knockout-hero { grid-template-columns: 1fr; min-height: 0; }
      .knockout-sidebar { min-height: 0; padding-right: 0; }
      h1 { max-width: 16ch; }
      .next-up { margin-top: 0; }
      .knockout-card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .orbit-board { width: min(100%, 760px); }
    }
    @media (max-width: 760px) {
      .knockout-hero { padding: 20px 16px 14px; gap: 14px; }
      h1 { font-size: 36px; max-width: 12ch; }
      .podium { margin: 20px 0; }
      .knockout-main { grid-template-rows: auto auto; }
      .orbit-board { min-width: 0; width: min(100%, 540px); }
      .team-node { width: 26px; height: 26px; }
      .advance-node { width: 24px; height: 24px; }
      .trophy-mark { width: 94px; }
      .knockout-card-grid { grid-template-columns: 1fr; max-height: 360px; overflow: auto; padding-right: 2px; }
      main.content { padding: 18px 16px 28px; }
      table { min-width: 760px; }
      .leaderboard { min-width: 0; }
      .leaderboard th:nth-child(1), .leaderboard td:nth-child(1) { width: 48px; }
      .leaderboard th:nth-child(2), .leaderboard td:nth-child(2) { width: 84px; }
    }
  </style>
</head>
<body>
  <div class="page-shell">
  ${knockoutVisual}
  <main class="content">
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
    <p class="section-note">From the SMS thread. Decision shows whether the pick is for 90 min, 120 min/ET, or PK.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Match</th>
            <th>Pick</th>
            <th>Decision</th>
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
  </div>
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
