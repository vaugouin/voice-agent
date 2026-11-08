// Offline check of the result-representation helpers of app/static/app.js (VOICE-AGENT-246,
// -247, -248; contract: fastapi-text2sql README, "Result representations: the contract for both
// fronts"). app.js is a browser script with no module system, so this loads the pure functions
// out of it by name, plus the block of value-card, chip and summary-line helpers, and runs them
// in a sandbox against the fixtures in tools/fixtures/result-representations/ (real API
// responses of the FASTAPI-TEXT2SQL-354 campaign, trimmed to the fields the front reads).
//
// Run from the repo root:  node tools/check-result-representations.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "app", "static", "app.js"), "utf8").replace(/\r\n/g, "\n");
const fixturesDir = join(root, "tools", "fixtures", "result-representations");

// Index just past the brace or parenthesis that closes the one opened at `start`, skipping
// strings, template literals (with their ${} parts) and comments.
function matchClose(text, start) {
  const open = text[start];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i) + 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      for (i += 1; text[i] !== ch; i += 1) {
        if (text[i] === "\\") i += 1;
      }
      continue;
    }
    if (ch === "`") {
      for (i += 1; text[i] !== "`"; i += 1) {
        if (text[i] === "\\") i += 1;
        else if (text[i] === "$" && text[i + 1] === "{") i = matchClose(text, i + 1) - 1;
      }
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`unbalanced from ${start}`);
}

function extractFunction(name) {
  const at = source.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`function ${name} not found in app.js`);
  const paramsStart = source.indexOf("(", at);
  const bodyStart = source.indexOf("{", matchClose(source, paramsStart));
  return source.slice(at + 1, matchClose(source, bodyStart));
}

function extractRegion(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`region ${startMarker} not found`);
  return source.slice(start, end);
}

const code = [
  ...["normalizeUiLanguage", "uiText", "prettyLabel", "formatDate", "formatMoney", "formatMinutes",
    "formatMetric", "text2SqlResultColumns", "pickBarMetric"].map(extractFunction),
  extractRegion("// VOICE-AGENT-246 / -247 / -248 (FASTAPI-TEXT2SQL-354)", "// One result row as a poster card"),
  "globalThis.api = { text2SqlRepresentationOptions, text2SqlChipOptions, resolveText2SqlRepresentation,",
  "  text2SqlValueColumns, formatCardValue, spokenMetricValue, text2SqlSummaryLine, text2SqlSpokenSummary,",
  "  pickBarMetric, text2SqlRepresentationLabel, setLang: (l) => { activeUiLanguage = l; } };",
].join("\n\n");
const sandbox = { Intl, console };
vm.createContext(sandbox);
vm.runInContext(`let activeUiLanguage = "en";\n${code}`, sandbox);
const api = sandbox.api;

let failures = 0;
let passes = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passes += 1;
  } else {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  }
}

const fixtures = Object.fromEntries(
  readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(fixturesDir, f), "utf8"))])
);
const fx = (name) => {
  if (!fixtures[name]) throw new Error(`fixture ${name} missing`);
  return fixtures[name];
};
const caption = (name, lang, extra = {}) => api.text2SqlSummaryLine(fx(name), { lang, ...extra });
const spoken = (name, lang, extra = {}) => api.text2SqlSummaryLine(fx(name), { lang, spoken: true, ...extra });

// Card values: short display forms, nothing for a missing or unknown value.
check("minutes card", api.formatCardValue(138, { unit: "minutes", role: "metric" }), "2 h 18");
check("minutes under an hour", api.formatCardValue(45, { unit: "minutes", role: "metric" }), "45 min");
check("usd card", api.formatCardValue(150000000, { unit: "usd", role: "metric" }), "$150M");
check("usd billions", api.formatCardValue(1671537444, { unit: "usd", role: "metric" }), "$1.7B");
check("rating card", api.formatCardValue(8.1, { unit: null, role: "metric" }), "8.1");
check("count card", api.formatCardValue(405, { unit: "count", role: "metric" }), "405");
check("count zero is real", api.formatCardValue(0, { unit: "count", role: "metric" }), "0");
check("runtime zero is unknown", api.formatCardValue(0, { unit: "minutes", role: "metric" }), "");
check("null shows nothing", api.formatCardValue(null, { unit: "usd", role: "metric" }), "");
check("birth year is a year, not a duration", api.formatCardValue(1899, { unit: "years", role: "date" }), "1899");

// Spoken values: units spelled out.
check("spoken minutes en", api.spokenMetricValue(138, "minutes", "en"), "2 hours 18 minutes");
check("spoken minutes fr", api.spokenMetricValue(138, "minutes", "fr"), "2 heures 18 minutes");
check("spoken usd en", api.spokenMetricValue(150000000, "usd", "en"), "150 million dollars");
check("spoken usd fr", api.spokenMetricValue(2900000000, "usd", "fr"), "2,9 milliards de dollars");

// Value columns: first focus; every focus on a comparison, weighted variant dropped; else ordered.
const names = (cols) => cols.map((c) => c.name);
check("value col, runtime", names(api.text2SqlValueColumns(fx("2560-en-value-cards-runtime").result_columns, fx("2560-en-value-cards-runtime").intent)), ["RUNTIME"]);
check("value cols, two focus", names(api.text2SqlValueColumns(fx("2599-en-compare-two-focus").result_columns, fx("2599-en-compare-two-focus").intent)), ["BUDGET", "REVENUE"]);
check("value col, birth year", names(api.text2SqlValueColumns(fx("2596-en-compare-birth-year").result_columns, fx("2596-en-compare-birth-year").intent)), ["BIRTH_YEAR"]);
check("value col, rating rank keeps one", names(api.text2SqlValueColumns(fx("2573-en-ranked-bars-rating").result_columns, fx("2573-en-ranked-bars-rating").intent)), ["IMDB_RATING"]);
check("value col, no focus: ordered metric", names(api.text2SqlValueColumns([
  { name: "A", role: "metric" }, { name: "B", role: "metric", ordered: "desc" }], null)), ["B"]);
check("value col, older API", names(api.text2SqlValueColumns([], null)), []);

// Bars: ordered first, then focus, then the first metric.
check("bar metric ordered", api.pickBarMetric([], fx("2571-en-ranked-bars-runtime").result_columns).name, "RUNTIME");
check("bar metric focus when nothing ordered", api.pickBarMetric([], fx("2560-en-value-cards-runtime").result_columns).name, "RUNTIME");

// Chips: the switchable options, none on one-form shapes or an older API.
check("chips value-cards", api.text2SqlChipOptions(fx("2560-en-value-cards-runtime")), ["value-cards", "card-grid", "ranked-bars", "table"]);
check("chips card-grid sequence", api.text2SqlChipOptions(fx("2601-en-card-grid-sequence")), ["card-grid", "table"]);
check("no chips on a number card", api.text2SqlChipOptions(fx("2554-en-number-card")), []);
check("no chips on a lone table", api.text2SqlChipOptions(fx("2610-en-table-trend")), []);
check("no chips without options", api.text2SqlChipOptions({ representation: "card-grid" }), []);
check("preference applied when offered", api.resolveText2SqlRepresentation(fx("2571-en-ranked-bars-runtime"), "table"), "table");
check("preference ignored when not offered", api.resolveText2SqlRepresentation(fx("2601-en-card-grid-sequence"), "ranked-bars"), "card-grid");
check("preference ignored on a number card", api.resolveText2SqlRepresentation(fx("2554-en-number-card"), "table"), "number-card");
check("chip label fr", api.text2SqlRepresentationLabel("table", "fr"), "Tableau");

// Summary line, EN and FR, caption and spoken.
check("caption value-cards en", caption("2560-en-value-cards-runtime", "en"),
  "Three films in collection order; the longest is The Lord of the Rings: The Return of the King, 3 h 21.");
check("caption value-cards fr", caption("2560-fr-value-cards-runtime", "fr"),
  "Trois films dans l'ordre de la collection ; le plus long est Le Seigneur des anneaux : Le Retour du roi, 3 h 21.");
check("spoken value-cards en", spoken("2560-en-value-cards-runtime", "en"),
  "Three films in collection order; the longest is The Lord of the Rings: The Return of the King, 3 hours 21 minutes.");
check("caption ranking en", caption("2571-en-ranked-bars-runtime", "en"),
  "The first five films by runtime; the longest is The Concert for New York City, 4 h 56.");
check("caption ranking fr", caption("2571-fr-ranked-bars-runtime", "fr"),
  "Les cinq premiers films par durée ; le plus long est The Concert for New York City, 4 h 56.");
check("caption rating ranking en", caption("2573-en-ranked-bars-rating", "en"),
  "The first eight films by IMDb rating; the best rated is Harry Potter and the Deathly Hallows: Part 2, 8.1.");
check("caption grouped ranking en", caption("2576-en-ranked-bars-grouped", "en"),
  "The first 20 people by number of films; Kevin Dunn leads with 405.");
check("caption grouped ranking fr", caption("2576-fr-ranked-bars-grouped", "fr"),
  "Les 20 premières personnes par nombre de films ; Kevin Dunn arrive en tête avec 405.");
check("caption compare en", caption("2590-en-compare-runtime", "en"),
  "Two films; the longest is Titanic, 3 h 14.");
check("caption two focus en", caption("2599-en-compare-two-focus", "en"),
  "Two films; the most expensive is Jurassic World, $150M.");
check("caption birth year en", caption("2596-en-compare-birth-year", "en"),
  "Two people in chronological order.");
check("caption budget release order fr", caption("2568-fr-value-cards-budget-release-order", "fr"),
  `13 films dans l'ordre chronologique ; le plus cher est ${fx("2568-fr-value-cards-budget-release-order").summary_facts.top.label}, $490M.`);
check("caption has more en", caption("2568-en-value-cards-budget-release-order", "en", { hasMore: true }),
  "The first 13 films in chronological order; the most expensive is Star Wars: The Rise of Skywalker, $490M.");
check("caption sequence en", caption("2601-en-card-grid-sequence", "en"), "Three films.");
check("caption trend en", caption("2610-en-table-trend", "en"), "Seven results in chronological order.");
check("no caption on a number card", caption("2554-en-number-card", "en"), "");
check("caption follows the chip", caption("2560-en-value-cards-runtime", "en", { rep: "number-card" }), "");
check("no caption without facts", api.text2SqlSummaryLine({ representation: "card-grid" }, { lang: "en" }), "");
check("spoken summary from a tool output", api.text2SqlSpokenSummary({ upstream: fx("2590-fr-compare-runtime"), has_more: false }),
  "Deux films ; le plus long est Titanic, 3 heures 14 minutes.");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
