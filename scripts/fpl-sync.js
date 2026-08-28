#!/usr/bin/env node
// Fetches official FPL data server-side (this runs inside a GitHub Actions
// runner, not a browser, so the FPL API's CORS restriction never applies
// here) and writes data/fpl-snapshot.json for the static site to read
// directly with a plain same-origin fetch — no proxy needed.
//
// Reads its input from data/fpl-sync-config.json:
//   { "leagueId": "1459370", "managers": [{ "id": "...", "name": "...", "fplEntryId": 123456 }, ...] }
// That file is normally written by the app's "Push League/Manager Config"
// button (via the GitHub Contents API), but you can also hand-edit it.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "data", "fpl-sync-config.json");
const SNAPSHOT_PATH = path.join(ROOT, "data", "fpl-snapshot.json");
const API = "https://fantasy.premierleague.com/api/";
const SEASON_MONTHS = ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"];

function monthAbbrFromDate(isoDateStr) {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[new Date(isoDateStr).getMonth()];
}

function buildGwMonthMap(events) {
  const map = {};
  (events || []).forEach(function (ev) {
    if (ev.deadline_time) {
      const abbr = monthAbbrFromDate(ev.deadline_time);
      if (SEASON_MONTHS.indexOf(abbr) !== -1) map[ev.id] = abbr;
    }
  });
  return map;
}

async function fetchJson(pathPart) {
  const res = await fetch(API + pathPart, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; fpl-ledger-tracker-action/1.0)",
      "Accept": "application/json"
    }
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + pathPart);
  return res.json();
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function main() {
  let config = { leagueId: "", managers: [] };
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    console.warn("Could not read data/fpl-sync-config.json (" + err.message + ") — writing an empty snapshot.");
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    leagueId: config.leagueId || "",
    leagueName: "",
    currentEventId: null,
    currentMonth: null,
    gwMonthMap: {},
    standings: [],
    managers: {},
    errors: []
  };

  if (!config.leagueId) {
    snapshot.errors.push("No leagueId set in data/fpl-sync-config.json yet — push your config from the app's FPL Sync page first.");
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    console.log("Wrote placeholder snapshot (no league configured yet).");
    return;
  }

  try {
    const bootstrap = await fetchJson("bootstrap-static/");
    snapshot.gwMonthMap = buildGwMonthMap(bootstrap.events || []);
    const currentEvent =
      (bootstrap.events || []).find(function (e) { return e.is_current; }) ||
      (bootstrap.events || []).find(function (e) { return e.is_next; });
    if (currentEvent) {
      snapshot.currentEventId = currentEvent.id;
      snapshot.currentMonth = snapshot.gwMonthMap[currentEvent.id] || null;
    }
  } catch (err) {
    snapshot.errors.push("bootstrap-static fetch failed: " + err.message);
  }

  try {
    const standingsData = await fetchJson("leagues-classic/" + config.leagueId + "/standings/");
    snapshot.leagueName = (standingsData.league && standingsData.league.name) || "";
    snapshot.standings = (standingsData.standings && standingsData.standings.results) || [];
  } catch (err) {
    snapshot.errors.push("standings fetch failed: " + err.message);
  }

  const managers = Array.isArray(config.managers) ? config.managers : [];
  for (const mgr of managers) {
    if (!mgr || !mgr.fplEntryId) continue;
    try {
      const hist = await fetchJson("entry/" + mgr.fplEntryId + "/history/");
      snapshot.managers[String(mgr.fplEntryId)] = {
        current: hist.current || [],
        chips: hist.chips || []
      };
    } catch (err) {
      snapshot.errors.push("entry " + mgr.fplEntryId + " (" + (mgr.name || "unknown") + ") failed: " + err.message);
    }
    await sleep(300); // be polite to FPL's servers
  }

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    "Wrote snapshot: " + Object.keys(snapshot.managers).length + " manager(s), " +
    snapshot.standings.length + " standings row(s), " + snapshot.errors.length + " error(s)."
  );
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
