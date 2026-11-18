const ET = "America/New_York";
const FEED = new URL("./data/predictions.json", import.meta.url);
const MODEL_VERSIONS = { V1: "V1_reference", PA3: "PA3_roster" };
const STATUS_NAMES = {
  scheduled: "Scheduled", live: "In progress", final: "Final",
  postponed: "Postponed", canceled: "Canceled", delayed: "Delayed", unknown: "Status unavailable",
};
const dayParts = new Intl.DateTimeFormat("en-US", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" });
const fullDate = new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", month: "long", day: "numeric", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "short", day: "numeric" });
const tipTime = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });
const staleMinutes = 150;

export function easternDay(date) {
  const parts = Object.fromEntries(dayParts.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export const formatTip = value => `${tipTime.format(new Date(value))} ET`;
const formatDay = value => fullDate.format(new Date(`${value}T12:00:00Z`));
const formatStamp = value => `${shortDate.format(new Date(value))}, ${formatTip(value)}`;
export function percentPair(away) {
  const tenths = Math.round(away * 1000);
  return [(tenths / 10).toFixed(1), ((1000 - tenths) / 10).toFixed(1)];
}

const keys = (object, names) => object && typeof object === "object" && !Array.isArray(object)
  && Object.keys(object).length === names.length && names.every(name => Object.hasOwn(object, name));
const integer = value => Number.isInteger(value) && value >= 0;
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;
const stamp = value => typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const dayString = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
const allowed = (obj, name) => Object.hasOwn(obj, name);

function validMetrics(rows, n) {
  return Array.isArray(rows) && rows.length === 2 && new Set(rows.map(r => r?.model)).size === 2
    && rows.every(r => keys(r, ["model", "n", "accuracy", "brier", "log_loss", "margin_mae"])
      && allowed(MODEL_VERSIONS, r.model) && integer(r.n) && r.n > 0 && r.n === n
      && probability(r.accuracy) && probability(r.brier)
      && [r.log_loss, r.margin_mae].every(value => Number.isFinite(value) && value >= 0));
}

export function validateFeed(feed) {
  if (!keys(feed, ["schema_version", "updated_at_utc", "slate_date_et", "ratings_through_et", "teams", "games", "rankings", "historical", "prospective"])
      || feed.schema_version !== 1 || !stamp(feed.updated_at_utc)
      || !dayString(feed.slate_date_et) || easternDay(new Date(feed.updated_at_utc)) !== feed.slate_date_et
      || !dayString(feed.ratings_through_et) || feed.ratings_through_et >= feed.slate_date_et) return false;

  if (!Array.isArray(feed.teams) || feed.teams.length !== 30 || !feed.teams.every(team =>
    keys(team, ["id", "code", "name"]) && typeof team.id === "string" && /^\d{10}$/.test(team.id)
    && typeof team.code === "string" && /^[A-Z]{2,3}$/.test(team.code)
    && typeof team.name === "string" && /^[\w .'-]{3,40}$/.test(team.name))) return false;
  const teamIds = new Set(feed.teams.map(team => team.id));
  if (teamIds.size !== 30 || new Set(feed.teams.map(t => t.code)).size !== 30) return false;

  if (!Array.isArray(feed.rankings) || feed.rankings.length !== 30 || new Set(feed.rankings.map(r => r?.team)).size !== 30
      || !feed.rankings.every((r, i) => keys(r, ["rank", "team", "wins", "losses", "strength", "sos", "offense", "defense", "net"])
        && r.rank === i + 1 && teamIds.has(r.team) && integer(r.wins) && integer(r.losses)
        && [r.strength, r.sos, r.offense, r.defense, r.net].every(Number.isFinite)
        && Math.abs(r.offense - r.defense - r.net) < .001
        && (i === 0 || feed.rankings[i - 1].strength >= r.strength))) return false;

  const runTime = Date.parse(feed.updated_at_utc);
  if (!Array.isArray(feed.games) || new Set(feed.games.map(g => g?.id)).size !== feed.games.length) return false;
  for (const g of feed.games) {
    if (!keys(g, ["id", "tip_at_utc", "away", "home", "status", "score", "forecasts"])
        || typeof g.id !== "string" || !/^\d+$/.test(g.id)
        || !stamp(g.tip_at_utc) || easternDay(new Date(g.tip_at_utc)) !== feed.slate_date_et
        || !teamIds.has(g.away) || !teamIds.has(g.home) || g.away === g.home || !allowed(STATUS_NAMES, g.status)
        || !(g.score === null || (Array.isArray(g.score) && g.status === "final"
          && g.score.length === 2 && g.score.every(integer) && g.score[0] !== g.score[1]))
        || !g.forecasts || typeof g.forecasts !== "object" || Array.isArray(g.forecasts)) return false;
    for (const [key, f] of Object.entries(g.forecasts)) {
      if (!allowed(MODEL_VERSIONS, key)
          || !keys(f, ["model_version", "home_probability", "away_probability", "home_margin", "recorded_at_utc", "injury_report_at_utc"])
          || f.model_version !== MODEL_VERSIONS[key] || !probability(f.home_probability) || !probability(f.away_probability)
          || Math.abs(f.home_probability + f.away_probability - 1) > 1e-12
          || !Number.isFinite(f.home_margin) || !stamp(f.recorded_at_utc)) return false;
      const recorded = Date.parse(f.recorded_at_utc);
      const leadMinutes = (Date.parse(g.tip_at_utc) - recorded) / 60000;
      if (recorded > runTime || leadMinutes < 89.99999 || leadMinutes > 1440.00001
          || (f.injury_report_at_utc !== null && (key !== "PA3" || !stamp(f.injury_report_at_utc)
            || Date.parse(f.injury_report_at_utc) > recorded))) return false;
    }
  }

  const h = feed.historical;
  const p = feed.prospective;
  return keys(h, ["season", "rows"]) && h.season === "2025–26" && validMetrics(h.rows, h.rows?.[0]?.n)
    && keys(p, ["graded", "target", "minimum", "rows"]) && integer(p.graded) && p.target === 200
    && integer(p.minimum) && p.minimum > 0 && p.graded <= p.target && p.minimum <= p.target
    && (p.graded < p.minimum ? Array.isArray(p.rows) && p.rows.length === 0 : validMetrics(p.rows, p.graded));
}

export function freshness(feed, now = new Date(), failed = false) {
  if (!feed) return "unavailable";
  const elapsed = (now - new Date(feed.updated_at_utc)) / 60000;
  if (failed) return "refresh-failed";
  if (elapsed < -5) return "unavailable";
  if (elapsed > staleMinutes || easternDay(now) !== feed.slate_date_et) return "stale";
  return "current";
}

const html = value => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const signed = (value, digits = 1) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}`;
const label = (model, version = "") => `<div class="model-head">
  <span class="model-label ${model === "PA3" ? "experimental" : ""}">${model === "PA3" ? "PA3 · Experimental" : "V1 · Baseline"}</span>
  ${version ? `<span class="version">${html(version)}</span>` : ""}</div>`;
const empty = message => `<p class="empty">${html(message)}</p>`;
const logo = (team, lazy = false) => `<span class="logo" aria-hidden="true"><span>${html(team.code)}</span><img alt="" ${lazy ? 'loading="lazy"' : ''} decoding="async"
  src="https://cdn.nba.com/logos/nba/${team.id}/global/L/logo.svg"></span>`;

function activateLogos(root) {
  for (const image of root.querySelectorAll(".logo img")) {
    if (image.complete && image.naturalWidth) image.classList.add("ready");
    else image.addEventListener("load", () => image.classList.add("ready"), { once: true });
  }
}

function prediction(model, forecast, away, home) {
  if (!forecast) return `<div class="model-card">${label(model)}<p class="prediction-meta">No eligible ${model} forecast was recorded.</p></div>`;
  const [awayProb, homeProb] = percentPair(forecast.away_probability);
  const winner = forecast.away_probability === forecast.home_probability ? "Even"
    : forecast.away_probability > forecast.home_probability ? away.code : home.code;
  const margin = Math.abs(forecast.home_margin).toFixed(1);
  const marginTeam = forecast.home_margin > 0 ? home.code : away.code;
  return `<div class="model-card">${label(model, forecast.model_version)}
    <div class="odds"><span><small>${html(away.code)}</small> ${awayProb}%</span><span><small>${html(home.code)}</small> ${homeProb}%</span></div>
    <div class="split" aria-hidden="true"><span style="width:${awayProb}%"></span></div>
    <div class="prediction-meta"><span>Predicted winner <strong>${html(winner)}</strong></span>
      <span>Projected margin <strong>${Number(margin) ? `${html(marginTeam)} by ${margin}` : "Even"}</strong></span></div>
    <div class="prediction-foot"><p>Recorded <time datetime="${html(forecast.recorded_at_utc)}">${formatStamp(forecast.recorded_at_utc)}</time></p>
      ${forecast.injury_report_at_utc ? `<p>Official injury report used · ${formatStamp(forecast.injury_report_at_utc)}</p>` : ""}</div>
    </div>`;
}

function renderGames(feed, teams, mode, now) {
  const priority = g => g.status === "scheduled" && Date.parse(g.tip_at_utc) > now ? 0 : g.status === "live" ? 1 : 2;
  const ordered = [...feed.games].sort((a, b) => priority(a) - priority(b) || Date.parse(a.tip_at_utc) - Date.parse(b.tip_at_utc));
  if (!ordered.length) return empty("No games appear on the verified slate for this date.");
  return ordered.map(g => {
    const away = teams.get(g.away), home = teams.get(g.home);
    const gamesPassed = g.status === "scheduled" && Date.parse(g.tip_at_utc) <= now;
    const status = gamesPassed ? "Awaiting status update" : STATUS_NAMES[g.status];
    return `<article class="game" aria-label="${html(away.name)} at ${html(home.name)}">
      <div class="game-meta"><span class="state" data-status="${html(g.status)}">${status}</span>
        <time datetime="${html(g.tip_at_utc)}">${formatTip(g.tip_at_utc)}</time></div>
      <div class="matchup">
        <div class="team">${logo(away)}<div><strong>${html(away.code)}</strong><small>${html(away.name)}</small></div></div>
        <span aria-hidden="true">at</span>
        <div class="team">${logo(home)}<div><strong>${html(home.code)}</strong><small>${html(home.name)}</small></div></div>
      </div>
      ${g.score ? `<div class="score"><span>${html(away.code)} ${g.score[0]}</span><span>Verified final</span><span>${html(home.code)} ${g.score[1]}</span></div>` : ""}
      <div class="model-set" data-mode="${mode}">${(mode === "compare" ? ["V1", "PA3"] : [mode]).map(model => prediction(model, g.forecasts[model], away, home)).join("")}</div>
    </article>`;
  }).join("");
}

function metricTable(rows) {
  const find = model => rows.find(row => row.model === model);
  return `<table class="metric-table"><thead><tr>
    <th scope="col">Model</th><th scope="col">Games</th><th scope="col">Accuracy</th><th scope="col">Brier</th><th scope="col">Log loss</th><th scope="col">MAE</th>
    </tr></thead><tbody>${["V1", "PA3"].map(model => {
      const r = find(model);
      return `<tr><th scope="row">${model}</th><td>${r.n.toLocaleString("en-US")}</td>
        <td>${(r.accuracy * 100).toFixed(1)}%</td><td>${r.brier.toFixed(3)}</td>
        <td>${r.log_loss.toFixed(3)}</td><td>${r.margin_mae.toFixed(2)}</td></tr>`;
    }).join("")}</tbody></table>`;
}

function performance(feed) {
  const p = feed.prospective;
  return `<div class="performance"><article class="box">
    <h3>Historical assessment · ${feed.historical.season}</h3>
    <p>Shared past-game sample used in model development. PA3 remains experimental.</p>
    ${metricTable(feed.historical.rows)}
    <p>MAE is average absolute margin error in points. Lower Brier, log loss, and MAE are better.</p>
  </article><article class="box">
    <h3>Prospective tracking</h3>
    <p><strong>${p.graded} of ${p.target} shared games graded</strong></p>
    <div class="progress" aria-hidden="true"><div style="width:${100 * p.graded / p.target}%"></div></div>
    <p>Uses verified finals and the last eligible common V1 and PA3 forecasts recorded at least 90 minutes before tipoff.</p>
    ${p.rows.length ? `<p>Interim scores are descriptive while the cohort fills.</p>${metricTable(p.rows)}`
      : `<p>Scores appear after ${p.minimum} shared games have been graded.</p>`}
  </article></div>`;
}

const record = r => `${r.wins}–${r.losses}`;
const chartValues = r => `<dl class="rank-extra"><div><dt>Adj. offense</dt><dd>${r.offense.toFixed(1)}</dd></div>
  <div><dt>Adj. defense</dt><dd>${r.defense.toFixed(1)}</dd></div>
  <div><dt>Adj. net</dt><dd>${signed(r.net)}</dd></div><div><dt>Schedule</dt><dd>${signed(r.sos)}</dd></div></dl>`;

function compareRows(feed, teams, selected) {
  if (!selected[0] || !selected[1]) return "";
  if (selected[0] === selected[1]) return empty("Choose two different teams to compare.");
  const byTeam = new Map(feed.rankings.map(r => [r.team, r]));
  return `<table class="metric-table"><thead><tr><th scope="col">Team</th><th scope="col">Rank</th><th scope="col">Record</th><th scope="col">Strength</th><th scope="col">Adj. net</th></tr></thead>
    <tbody>${selected.map(id => {
      const r = byTeam.get(id);
      return `<tr><th scope="row">${html(teams.get(id).code)}</th><td>${r.rank}</td><td>${record(r)}</td><td>${signed(r.strength)}</td><td>${signed(r.net)}</td></tr>`;
    }).join("")}</tbody></table>`;
}

function renderRanks(feed, teams, sort, compared) {
  const winPct = r => r.wins / (r.wins + r.losses || 1);
  const compare = sort === "pct" ? (a, b) => winPct(b) - winPct(a)
    : sort === "defense" ? (a, b) => a.defense - b.defense : (a, b) => b[sort] - a[sort];
  const options = (selected) => `<option value="">Select a team</option>${[...teams.values()]
    .sort((a, b) => a.name.localeCompare(b.name)).map(t => `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${html(t.name)}</option>`).join("")}`;
  return `<article class="box comparison"><div class="comparison-heading"><div><h3>Compare teams</h3>
    <p>Adjusted ratings use points per 100 possessions.</p></div>
    <div class="comparison-fields"><label>Team 1<select id="compare-first">${options(compared[0])}</select></label>
    <label>Team 2<select id="compare-second">${options(compared[1])}</select></label></div></div>
    <div class="comparison-results" id="comparison-results" aria-live="polite">${compareRows(feed, teams, compared)}</div></article>
    <div class="box rank-frame"><div class="rank-labels rank-row"><span>Rank / Team</span><span>Record</span><span>Strength</span></div>
    ${[...feed.rankings].sort((a, b) => compare(a, b) || a.rank - b.rank).map(r => {
      const t = teams.get(r.team);
      return `<details class="rank-entry"><summary class="rank-summary rank-row" title="${html(t.name)}">
        <span class="rank-cell"><span>${r.rank}</span>${logo(t, true)}<strong class="rank-full">${html(t.name)}</strong>
          <strong class="rank-code" aria-label="${html(t.name)}">${html(t.code)}</strong></span>
        <span>${record(r)}</span><span class="rank-value">${signed(r.strength)}</span></summary>${chartValues(r)}</details>`;
    }).join("")}</div>`;
}

function startApp() {
  const $ = id => document.getElementById(id);
  const dashboard = { feed: null, teams: new Map(), mode: "V1", compared: ["", ""], failed: false, pending: false };
  const nav = [...document.querySelectorAll("[data-view]")];
  const panels = [...document.querySelectorAll("[data-panel]")];

  function view() {
    const target = location.hash.slice(1);
    const selected = panels.some(p => p.id === target) ? target : "predictions";
    for (const panel of panels) panel.hidden = panel.id !== selected;
    for (const link of nav) {
      if (link.dataset.view === selected) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function predictions(now) {
    $("model-legend").textContent = dashboard.mode === "V1" ? "V1 is the baseline model."
      : dashboard.mode === "PA3" ? "PA3 includes player availability and remains experimental."
        : "V1 is the baseline. PA3 includes player availability and remains experimental.";
    if (!dashboard.feed) return;
    $("games").innerHTML = renderGames(dashboard.feed, dashboard.teams, dashboard.mode, now);
    activateLogos($("games"));
  }

  function rankings() {
    if (!dashboard.feed) return;
    const root = $("ranking-content");
    root.innerHTML = renderRanks(dashboard.feed, dashboard.teams, $("rank-sort").value, dashboard.compared);
    activateLogos(root);
    ["compare-first", "compare-second"].forEach((id, index) => {
      $(id).addEventListener("change", event => {
        dashboard.compared[index] = event.target.value;
        $("comparison-results").innerHTML = compareRows(dashboard.feed, dashboard.teams, dashboard.compared);
      });
    });
  }

  function draw() {
    const now = new Date();
    const feed = dashboard.feed;
    const status = freshness(feed, now, dashboard.failed);
    const messages = {
      unavailable: "Verified predictions are unavailable. Check back after the next successful update.",
      "refresh-failed": "Refresh failed. Showing the last verified update.",
      stale: "This feed is stale. Times, statuses, and predictions reflect the last successful update.",
    };
    $("notice").hidden = status === "current";
    $("notice").textContent = messages[status] || "";
    $("update").dataset.tone = status === "current" ? "good" : "warning";
    $("update").lastElementChild.textContent = feed ? `Updated ${formatStamp(feed.updated_at_utc)}` : "Feed unavailable";
    if (!feed) {
      $("slate-summary").textContent = "No verified slate loaded.";
      $("games").innerHTML = empty("Predictions will appear once the validated feed is available.");
      $("ranking-content").innerHTML = empty("Team ratings are unavailable.");
      $("performance-content").innerHTML = empty("Performance data is unavailable.");
      return;
    }
    const today = easternDay(now) === feed.slate_date_et;
    $("slate-date").textContent = formatDay(feed.slate_date_et);
    $("slate-title").textContent = today ? "Today’s Predictions" : "Last Available Slate";
    $("slate-summary").textContent = `${feed.games.length} ${feed.games.length === 1 ? "game" : "games"} · Eastern Time`;
    $("ratings-date").textContent = `Results through ${formatDay(feed.ratings_through_et)}.`;
    predictions(now);
    rankings();
    $("performance-content").innerHTML = performance(feed);
  }

  async function refresh() {
    if (dashboard.pending) return;
    dashboard.pending = true;
    try {
      const response = await fetch(FEED, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error("Feed unavailable");
      const received = await response.json();
      if (!validateFeed(received) || Date.parse(received.updated_at_utc) > Date.now() + 300000
        || (dashboard.feed && Date.parse(received.updated_at_utc) < Date.parse(dashboard.feed.updated_at_utc))) {
        throw new Error("Feed invalid or older than current snapshot");
      }
      dashboard.feed = received;
      dashboard.teams = new Map(received.teams.map(t => [t.id, t]));
      dashboard.failed = false;
    } catch {
      dashboard.failed = true;
    } finally {
      dashboard.pending = false;
      draw();
    }
  }

  window.addEventListener("hashchange", view);
  document.querySelectorAll("[data-model]").forEach(button => button.addEventListener("click", () => {
    dashboard.mode = button.dataset.model;
    document.querySelectorAll("[data-model]").forEach(choice => {
      choice.setAttribute("aria-pressed", String(choice === button));
    });
    predictions(new Date());
  }));
  $("rank-sort").addEventListener("change", rankings);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  view();
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 300000);
}

if (typeof document !== "undefined") startApp();
