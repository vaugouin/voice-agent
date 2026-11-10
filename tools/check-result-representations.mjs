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

// VOICE-AGENT-249 to -251 added the phase 2 helpers (timeline, sequence, trend columns), the
// "as a table" matcher, which reads its word lists from app/lexicons.json like the page does
// (window.__LEXICONS__), and the table links, which need detailRequestFromRecord().
const lexicons = readFileSync(join(root, "app", "lexicons.json"), "utf8");
const code = [
  ...["normalizeUiLanguage", "uiText", "prettyLabel", "formatDate", "formatMoney", "formatMinutes",
    "formatMetric", "text2SqlResultColumns", "pickBarMetric", "foldedWords", "isSourceWorkRecord",
    "detailRequestFromRecord"].map(extractFunction),
  extractRegion("// VOICE-AGENT-246 / -247 / -248 (FASTAPI-TEXT2SQL-354)", "// One result row as a poster card"),
  "globalThis.api = { text2SqlRepresentationOptions, text2SqlChipOptions, resolveText2SqlRepresentation,",
  "  text2SqlValueColumns, formatCardValue, spokenMetricValue, text2SqlSummaryLine, text2SqlSpokenSummary,",
  "  pickBarMetric, text2SqlRepresentationLabel, text2SqlYearOf, text2SqlDateColumn, text2SqlYearSpan,",
  "  text2SqlIsDecadeColumn, text2SqlPeriodLabel, text2SqlTrendModel, text2SqlTimelineModel,",
  "  text2SqlRequestedView, text2SqlRepresentationForView, text2SqlRequestedViewReply,",
  "  text2SqlTableLinks, text2SqlTableLinkRecord, T2S_TIMELINE_SLOT_PX, T2S_TIMELINE_MIN_GAP_PX,",
  "  setLang: (l) => { activeUiLanguage = l; } };",
].join("\n\n");
const sandbox = { Intl, console };
vm.createContext(sandbox);
vm.runInContext(`let activeUiLanguage = "en";\nconst LEXICONS = ${lexicons};\n${code}`, sandbox);
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

// VOICE-AGENT-249: timeline, sequence-strip, trend-columns (fixtures lota-*: real rows of phase 2
// lot A, recomputed by the API's new module, EN and FR).
check("known: timeline chips", api.text2SqlChipOptions(fx("lota-timeline-alien-en")), ["timeline", "card-grid", "value-cards", "table"]);
check("known: sequence chips", api.text2SqlChipOptions(fx("lota-sequence-dollars-en")), ["sequence-strip", "card-grid", "table"]);
check("known: trend chips", api.text2SqlChipOptions(fx("lota-trend-woody-allen-decades-en")), ["trend-columns", "table"]);
check("timeline default kept", api.resolveText2SqlRepresentation(fx("lota-timeline-alien-en"), ""), "timeline");
check("table preference applies to a trend", api.resolveText2SqlRepresentation(fx("lota-trend-woody-allen-decades-en"), "table"), "table");
check("chip labels fr", ["timeline", "sequence-strip", "trend-columns"].map((r) => api.text2SqlRepresentationLabel(r, "fr")), ["Frise", "Dans l'ordre", "Colonnes"]);
check("chip labels en", ["timeline", "sequence-strip", "trend-columns"].map((r) => api.text2SqlRepresentationLabel(r, "en")), ["Timeline", "In order", "Columns"]);

check("year of an ISO date", api.text2SqlYearOf("1979-05-25"), 1979);
check("year of a number", api.text2SqlYearOf(1980), 1980);
check("year of a bare year string", api.text2SqlYearOf("2001"), 2001);
check("no year in null", api.text2SqlYearOf(null), null);
check("no year in blank", api.text2SqlYearOf(""), null);
check("no year in text", api.text2SqlYearOf("unknown"), null);
check("span", api.text2SqlYearSpan([1986, 1979, 1997], "en"), "from 1979 to 1997");
check("span fr", api.text2SqlYearSpan([1986, 1979, 1997], "fr"), "de 1979 à 1997");
check("span of one year", api.text2SqlYearSpan([2011, 2011], "en"), "in 2011");
check("decade by name", api.text2SqlIsDecadeColumn("DECENNIE", [1960, 1970]), true);
check("decade by values", api.text2SqlIsDecadeColumn("PERIOD", [1960, 1970, 1990]), true);
check("years are not decades", api.text2SqlIsDecadeColumn("RELEASE_YEAR", [2000, 2001, 2002]), false);
check("decade label en", api.text2SqlPeriodLabel(1980, true, "en"), "1980s");
check("decade label fr", api.text2SqlPeriodLabel(1980, true, "fr"), "années 1980");
check("year label", api.text2SqlPeriodLabel(2023, false, "fr"), "2023");

// Timeline model: the focus date column, mixed aliases included; same-year rows stack; a row
// with no date is set apart; slots never overlap and keep the years' order.
{
  const alien = fx("lota-timeline-alien-en");
  const model = api.text2SqlTimelineModel(alien.result, alien.result_columns);
  check("timeline column", model.dateColumn.name, "DAT_RELEASE");
  check("timeline years", model.groups.map((g) => g.year), [1979, 1986, 1992, 1997]);
  check("timeline first offset", model.groups[0].offset, 0);
  check("timeline offsets never overlap", model.groups.every((g, i) => i === 0 || g.offset >= api.T2S_TIMELINE_MIN_GAP_PX), true);
  check("timeline offsets follow the years", model.groups.map((g) => g.offset), [0, 24, 8, 8]);
  const hp = fx("lota-timeline-harry-potter-mixed-aliases-en");
  const hpModel = api.text2SqlTimelineModel(hp.result, hp.result_columns, { preferred: hp.summary_facts.value_column });
  check("timeline mixed aliases column", hpModel.dateColumn.name, "DAT_FIRST_AIR");
  check("timeline mixed aliases years", hpModel.groups.map((g) => g.year), [2001, 2002, 2004, 2005, 2007, 2009, 2010, 2011]);
  const rows = [
    { data: { ID_MOVIE: 1, MOVIE_TITLE: "B", DAT_RELEASE: "2011-11-01" } },
    { data: { ID_MOVIE: 2, MOVIE_TITLE: "A", DAT_RELEASE: "2011-03-01" } },
    { data: { ID_MOVIE: 3, MOVIE_TITLE: "C", DAT_RELEASE: null } },
  ];
  const cols = [{ name: "ID_MOVIE", role: "entity_id" }, { name: "MOVIE_TITLE", role: "label" }, { name: "DAT_RELEASE", role: "date", focus: true }];
  const stacked = api.text2SqlTimelineModel(rows, cols);
  check("timeline stacks a year in date order", stacked.groups.map((g) => g.items.map((r) => r.MOVIE_TITLE)), [["A", "B"]]);
  check("timeline sets the undated apart", stacked.undated.map((r) => r.MOVIE_TITLE), ["C"]);
}

check("caption timeline en", caption("lota-timeline-alien-en", "en"), "Four films, from 1979 to 1997.");
check("caption timeline fr", caption("lota-timeline-alien-fr", "fr"), "Quatre films, de 1979 à 1997.");
check("caption timeline mixed aliases", caption("lota-timeline-harry-potter-mixed-aliases-en", "en"), "Eight films, from 2001 to 2011.");
check("caption timeline more pages", caption("lota-timeline-nolan-en", "en", { hasMore: true }), "The first 18 films, from 1990 to 2026.");
check("caption timeline after a chip", caption("lota-timeline-alien-en", "en", { rep: "card-grid" }), "Four films in chronological order.");
check("caption sequence en", caption("lota-sequence-dollars-en", "en"), "Three films in release order, from 1964 to 1966.");
check("caption sequence fr", caption("lota-sequence-dollars-fr", "fr"), "Trois films dans l'ordre de sortie, de 1964 à 1966.");
check("caption sequence collection fr", caption("lota-sequence-indiana-collection-order-fr", "fr"), "Cinq films dans l'ordre de la collection, de 1981 à 2023.");
check("caption sequence 54 rows", caption("lota-sequence-mcu-54rows-en", "en"), "54 films in release order, from 2008 to 2027.");
check("caption sequence people", api.text2SqlSummaryLine({
  representation: "sequence-strip",
  result_columns: [{ name: "ID_PERSON", role: "entity_id" }, { name: "PERSON_NAME", role: "label" }, { name: "DAT_BIRTH", role: "date", ordered: "asc" }],
  summary_facts: { count: 2, order: "date", order_direction: "asc" },
  result: [{ data: { ID_PERSON: 1, DAT_BIRTH: "1930-05-31" } }, { data: { ID_PERSON: 2, DAT_BIRTH: "1946-12-18" } }],
}, { lang: "en" }), "Two people in chronological order, from 1930 to 1946.");
check("caption trend decades en", caption("lota-trend-woody-allen-decades-en", "en"), "From the 1960s to the 2020s; the peak is the 1980s, 11 films.");
check("caption trend decades fr", caption("lota-trend-woody-allen-decades-fr", "fr"), "Des années 1960 aux années 2020 ; le pic est dans les années 1980, avec 11 films.");
check("caption trend years en", caption("lota-trend-films-per-year-en", "en"), "From 2000 to 2099; the peak is 2023, 21,776 films.");
check("spoken trend years fr", spoken("lota-trend-films-per-year-fr", "fr"), "De 2000 à 2099 ; le pic est en 2023, avec 21 776 films.");
check("spoken trend usd en", spoken("lota-trend-avg-budget-usd-en", "en"), "From 2000 to 2099; the peak is 2028, 11.1 million dollars.");
check("caption trend minutes", caption("lota-trend-avg-runtime-decade-en", "en"), "From the 1870s to the 2090s; the peak is the 1990s, 1 h 09.");
check("spoken summary of a timeline", api.text2SqlSpokenSummary({ upstream: fx("lota-timeline-alien-en"), has_more: false }), "Four films, from 1979 to 1997.");

// Trend model: the value column of summary_facts, decades labelled, heights relative to the max.
{
  const woody = fx("lota-trend-woody-allen-decades-fr");
  const model = api.text2SqlTrendModel(woody.result, woody.result_columns, woody.summary_facts, "fr");
  check("trend metric", model.metric.name, "FILM_COUNT");
  check("trend decade", model.decade, true);
  check("trend labels fr", model.bars.map((b) => b.label).slice(0, 2), ["années 1960", "années 1970"]);
  check("trend heights", model.bars.map((b) => b.pct), [18.2, 72.7, 100, 100, 100, 81.8, 18.2]);
  check("trend value text", model.bars[2].valueText, "11");
  const budget = fx("lota-trend-avg-budget-usd-en");
  const budgetModel = api.text2SqlTrendModel(budget.result, budget.result_columns, budget.summary_facts, "en");
  check("trend years are not decades", budgetModel.decade, false);
  check("trend usd value", budgetModel.bars[0].valueText, "$1.1M");
  check("trend label year", budgetModel.bars[0].label, "2000");
}

// VOICE-AGENT-250: the "as a table" matcher. Whole-message view requests only, EN and FR.
const view = (text) => api.text2SqlRequestedView(text);
check("view: show it as a table", view("Show it as a table"), "table");
check("view: en tableau", view("en tableau"), "table");
check("view: affiche-le en tableau", view("Affiche-le en tableau s'il te plaît"), "table");
check("view: as a chart", view("as a chart"), "chart");
check("view: en graphique", view("En graphique !"), "chart");
check("view: as cards", view("show them as cards"), "cards");
check("view: with the posters", view("with the posters"), "posters");
check("view: avec les affiches", view("Avec les affiches"), "posters");
check("view: as a timeline", view("Can you put them on a timeline?"), "timeline");
check("view: en frise", view("en frise"), "timeline");
check("view: frise chronologique", view("Montre-moi une frise chronologique"), "timeline");
check("view: in order", view("show them in order"), "sequence");
check("view: dans l'ordre", view("dans l'ordre"), "sequence");
check("view: columns", view("as columns please"), "columns");
check("view: bar chart is bars", view("as a bar chart"), "bars");
check("view: back to the table", view("back to the table"), "table");
check("no view: a new search naming a subject", view("Nolan's films as a table"), "");
check("no view: a chart of something", view("a chart of the budgets"), "");
check("no view: one word is a title", view("Timeline"), "");
check("no view: a film title with a view word", view("Table 19"), "");
check("no view: an ordinary question", view("Who directed Alien?"), "");
check("no view: empty", view(""), "");
const opts = ["value-cards", "card-grid", "ranked-bars", "table"];
check("view to rep: chart to bars", api.text2SqlRepresentationForView("chart", opts), "ranked-bars");
check("view to rep: chart to timeline", api.text2SqlRepresentationForView("chart", ["timeline", "card-grid", "table"]), "timeline");
check("view to rep: chart to trend", api.text2SqlRepresentationForView("chart", ["trend-columns", "table"]), "trend-columns");
check("view to rep: cards to value cards", api.text2SqlRepresentationForView("cards", opts), "value-cards");
check("view to rep: posters to grid", api.text2SqlRepresentationForView("posters", opts), "card-grid");
check("view to rep: not offered", api.text2SqlRepresentationForView("timeline", opts), "");
check("reply done en", api.text2SqlRequestedViewReply({ ok: true, representation: "table", view: "table" }, "en"), "Here it is as a table.");
check("reply done fr", api.text2SqlRequestedViewReply({ ok: true, representation: "timeline", view: "timeline" }, "fr"), "Voici la frise chronologique.");
check("reply refused en", api.text2SqlRequestedViewReply({ ok: false, view: "timeline", available: ["trend-columns", "table"] }, "en"),
  "This result cannot be shown as a timeline. Available views: Columns, Table.");
check("reply refused fr", api.text2SqlRequestedViewReply({ ok: false, view: "chart", available: ["sequence-strip", "card-grid", "table"] }, "fr"),
  "Ce résultat ne peut pas s'afficher en graphique. Vues possibles : Dans l'ordre, Affiches, Tableau.");
check("reply one view fr", api.text2SqlRequestedViewReply({ ok: false, view: "table", available: [] }, "fr"),
  "Ce résultat ne peut pas s'afficher en tableau : il n'a qu'une seule vue.");

// VOICE-AGENT-251: the table title cells that open a detail sheet.
const linkSummary = (cols, keys) => api.text2SqlTableLinks(cols, keys).map((l) => `${l.label}>${l.idColumn || "row"}`);
check("links: movie title", linkSummary(fx("lota-timeline-alien-en").result_columns), ["MOVIE_TITLE>ID_MOVIE"]);
check("links: mixed content", linkSummary(fx("lota-timeline-harry-potter-mixed-aliases-en").result_columns), ["CONTENT_TITLE>ID_CONTENT"]);
check("links: movie and its director", linkSummary([
  { name: "ID_MOVIE", role: "entity_id" }, { name: "MOVIE_TITLE", role: "label" },
  { name: "ID_PERSON", role: "other" }, { name: "PERSON_NAME", role: "other" }]), ["MOVIE_TITLE>ID_MOVIE", "PERSON_NAME>ID_PERSON"]);
check("links: collection and list", linkSummary([
  { name: "ID_T2S_COLLECTION", role: "entity_id" }, { name: "COLLECTION_NAME", role: "label" },
  { name: "ID_T2S_LIST", role: "other" }, { name: "LIST_NAME", role: "other" }]), ["COLLECTION_NAME>ID_T2S_COLLECTION", "LIST_NAME>ID_T2S_LIST"]);
check("links: label with no evident id", linkSummary([{ name: "ID_MOVIE", role: "entity_id" }, { name: "TITLE", role: "label" }]), ["TITLE>row"]);
check("links: none on an aggregate", linkSummary(fx("lota-trend-woody-allen-decades-en").result_columns), []);
check("links: older API, from the keys", linkSummary([], ["ID_PERSON", "PERSON_NAME", "MOVIE_COUNT"]), ["PERSON_NAME>ID_PERSON"]);
{
  const row = { ID_MOVIE: 348, MOVIE_TITLE: "Alien", ID_PERSON: 578, PERSON_NAME: "Ridley Scott" };
  const [movieLink, personLink] = api.text2SqlTableLinks([], Object.keys(row));
  check("link record: movie", api.text2SqlTableLinkRecord(row, movieLink), { ID_MOVIE: 348, MOVIE_TITLE: "Alien" });
  check("link record: person", api.text2SqlTableLinkRecord(row, personLink), { ID_PERSON: 578, PERSON_NAME: "Ridley Scott" });
  check("link record: no id, no link", api.text2SqlTableLinkRecord({ ...row, ID_PERSON: null }, personLink), null);
  const content = { ID_CONTENT: 1399, CONTENT_TYPE: "serie", CONTENT_TITLE: "Game of Thrones" };
  const [contentLink] = api.text2SqlTableLinks([], Object.keys(content));
  check("link record: content keeps its type", api.text2SqlTableLinkRecord(content, contentLink), { ID_CONTENT: 1399, CONTENT_TITLE: "Game of Thrones", CONTENT_TYPE: "serie" });
  check("link record: content opens the series", api.text2SqlTableLinkRecord(content, contentLink) && "ok", "ok");
  const location = { ID_LOCATION: 12, LOCATION_NAME: "Paris", MOVIE_COUNT: 3 };
  const [locationLink] = api.text2SqlTableLinks([], Object.keys(location));
  check("link record: location", api.text2SqlTableLinkRecord(location, locationLink), { ID_LOCATION: 12, LOCATION_NAME: "Paris" });
  const mainOnly = { ID_MOVIE: 5, TITLE: "Four Rooms" };
  check("link record: main entity is the row", api.text2SqlTableLinkRecord(mainOnly, { label: "TITLE", idColumn: "", typeColumn: "" }), mainOnly);
}

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
