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
// (window.__LEXICONS__), and the table links, which need detailRequestFromRecord(). Phase 2 lot B
// (fixtures lotb-*) added the compare-card, fact-card and verdict models and sentences, phase 2
// lot C (fixtures lotc-*) the histogram, share-bar and flag-list models and sentences, phase 3
// lot A (fixtures p3a-*) the scatter model, ticks and sentences, phase 3 lot B (fixtures p3b-*,
// and the outline app/static/world-110m.json itself) the map model and its sentences, phase 3
// lot C (fixtures p3c-*) the hierarchy model and its sentence, phase 3 lot E (fixtures p3e-*) the
// chain model and its sentence.
const lexicons = readFileSync(join(root, "app", "lexicons.json"), "utf8");
const code = [
  ...["normalizeUiLanguage", "uiText", "prettyLabel", "formatDate", "formatMoney", "formatMinutes",
    "formatMetric", "text2SqlResultColumns", "pickBarMetric", "foldedWords", "isSourceWorkRecord",
    "detailRequestFromRecord"].map(extractFunction),
  extractRegion("// VOICE-AGENT-246 / -247 / -248 (FASTAPI-TEXT2SQL-354)", "// One result row as a poster card"),
  "globalThis.api = { text2SqlRepresentationOptions, text2SqlChipOptions, resolveText2SqlRepresentation,",
  "  text2SqlValueColumns, formatCardValue, spokenMetricValue, text2SqlSummaryLine, text2SqlSpokenSummary, text2SqlViewSummaryLine,",
  "  pickBarMetric, text2SqlRepresentationLabel, text2SqlYearOf, text2SqlDateColumn, text2SqlYearSpan,",
  "  text2SqlIsDecadeColumn, text2SqlPeriodLabel, text2SqlTrendModel, text2SqlTimelineModel,",
  "  text2SqlRequestedView, text2SqlRepresentationForView, text2SqlRequestedViewReply,",
  "  text2SqlTableLinks, text2SqlTableLinkRecord, T2S_TIMELINE_SLOT_PX, T2S_TIMELINE_MIN_GAP_PX,",
  "  text2SqlLongDate, text2SqlQuantityText, text2SqlCompareModel, text2SqlCompareMarkText, text2SqlCompareSummary,",
  "  text2SqlFactModel, text2SqlFactOthersText, text2SqlFactSummary, text2SqlVerdictWord, text2SqlVerdictSummary,",
  "  text2SqlVerdictNote, text2SqlVerdictEvidence,",
  "  text2SqlHistogramModel, text2SqlHistogramSummary, text2SqlHistogramAxisName, text2SqlBinRangeText,",
  "  text2SqlShareModel, text2SqlShareSummary, text2SqlPercentText, text2SqlFlagEmoji, text2SqlFlagModel,",
  "  text2SqlFlagSummary, text2SqlCountryName, text2SqlChipOptionsLotC: text2SqlChipOptions,",
  "  text2SqlScatterModel, text2SqlScatterSummary, text2SqlScatterTicks, text2SqlScatterTickText,",
  "  text2SqlScatterValueText, text2SqlScatterAxisTitle, text2SqlScatterWords,",
  "  text2SqlMapModel, text2SqlMapTone, text2SqlMapStepText,",
  "  text2SqlHierarchyModel, text2SqlHierarchySummary, text2SqlHierarchyLeafNoun, text2SqlHierarchyKind,",
  "  text2SqlChainModel, text2SqlChainSummary, text2SqlFrDe, text2SqlFrA,",
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
{
  // A films-and-series union: DAT_LAST_AIR repeats the release date aliased DAT_FIRST_AIR
  const unionCols = [
    { name: "ID_CONTENT", role: "entity_id" }, { name: "CONTENT_TYPE", role: "other" },
    { name: "DAT_FIRST_AIR", role: "date", focus: true }, { name: "DAT_LAST_AIR", role: "date", focus: true },
  ];
  check("value col, union value keeps the first date", names(api.text2SqlValueColumns(unionCols, { task: "value" })), ["DAT_FIRST_AIR"]);
  check("value col, union compare drops the last date", names(api.text2SqlValueColumns(unionCols, { task: "compare" })), ["DAT_FIRST_AIR"]);
}
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

// After Load more, the caption of a timeline or a sequence counts every row on hand and says
// "the first N" only while another page may follow; other forms keep the first page's sentence.
{
  const nolan = fx("lota-timeline-nolan-en");
  const alien = fx("lota-timeline-alien-en");
  const rows = [...nolan.result, ...alien.result];
  const base = { upstream: nolan, rows: nolan.result, rep: "timeline", lang: "en", hasMore: true, moreNow: true };
  check("view caption, first page", api.text2SqlViewSummaryLine(base), "The first 18 films, from 1990 to 2026.");
  check("view caption, two pages, more to come", api.text2SqlViewSummaryLine({ ...base, rows }), "The first 22 films, from 1979 to 2026.");
  check("view caption, every page loaded", api.text2SqlViewSummaryLine({ ...base, rows, moreNow: false }), "22 films, from 1979 to 2026.");
  const mcu = fx("lota-sequence-mcu-54rows-en");
  check("view caption, a sequence over two pages", api.text2SqlViewSummaryLine({ upstream: mcu, rows: [...mcu.result, ...mcu.result], rep: "sequence-strip", lang: "en", hasMore: true, moreNow: false }),
    "108 films in release order, from 2008 to 2027.");
  const lotr = fx("2568-en-value-cards-budget-release-order");
  check("view caption, value cards keep the first page", api.text2SqlViewSummaryLine({ upstream: lotr, rows: [...lotr.result, ...lotr.result], rep: "value-cards", lang: "en", hasMore: true, moreNow: false }),
    caption("2568-en-value-cards-budget-release-order", "en", { hasMore: true }));
}

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

// Phase 2 lot B: compare-cards, fact-card, verdict (fixtures lotb-*: live API 1.1.20 responses of
// 2026-11-11, re-classified by the API's new module, EN and FR).
{
  // Known, offered as chips only when the API lists them, in the API's order.
  check("lotb chips: compare", api.text2SqlChipOptions(fx("lotb-compare-yes-no-runtime-en")), ["compare-cards", "card-grid", "value-cards", "ranked-bars", "table"]);
  check("lotb chips: compare of people", api.text2SqlChipOptions(fx("lotb-compare-born-first-en")), ["compare-cards", "card-grid", "timeline", "value-cards", "table"]);
  check("lotb chips: fact of one row, no entity page chip", api.text2SqlChipOptions(fx("lotb-fact-runtime-en")), ["fact-card", "table"]);
  check("lotb chips: fact over homonyms", api.text2SqlChipOptions(fx("lotb-fact-vertigo-homonyms-en")), ["fact-card", "timeline", "card-grid", "value-cards", "table"]);
  check("lotb chips: fact over two homonyms offers compare", api.text2SqlChipOptions(fx("lotb-fact-chernobyl-homonym-en")), ["fact-card", "value-cards", "card-grid", "compare-cards", "ranked-bars", "table"]);
  check("lotb chips: verdict over rows", api.text2SqlChipOptions(fx("lotb-verdict-yes-two-rows-en")), ["verdict", "card-grid", "table"]);
  check("lotb chips: verdict over one entity", api.text2SqlChipOptions(fx("lotb-verdict-yes-en")), ["verdict", "table"]);
  check("lotb chips: verdict over a count", api.text2SqlChipOptions(fx("lotb-verdict-count-zero-en")), ["verdict", "table"]);
  check("lotb chips: none on an empty verdict", api.text2SqlChipOptions(fx("lotb-verdict-no-empty-en")), []);
  check("lotb chip labels en", ["compare-cards", "fact-card", "verdict"].map((r) => api.text2SqlRepresentationLabel(r, "en")), ["Side by side", "Fact", "Yes / No"]);
  check("lotb chip labels fr", ["compare-cards", "fact-card", "verdict"].map((r) => api.text2SqlRepresentationLabel(r, "fr")), ["Côte à côte", "Fait", "Oui / Non"]);
  check("lotb unknown representation still ignored", api.text2SqlRepresentationOptions({ representation_options: ["verdict", "pie-chart", "table"] }), ["verdict", "table"]);

  // The representation drawn: the default; a remembered list preference applies to compare cards,
  // never over a fact card or a verdict, which are the answer itself.
  check("lotb default compare", api.resolveText2SqlRepresentation(fx("lotb-compare-godfather-runtime-en"), ""), "compare-cards");
  check("lotb preference over compare", api.resolveText2SqlRepresentation(fx("lotb-compare-godfather-runtime-en"), "ranked-bars"), "ranked-bars");
  check("lotb compare preference on value cards", api.resolveText2SqlRepresentation(fx("lotb-fact-chernobyl-homonym-en"), "compare-cards"), "fact-card");
  check("lotb table preference keeps the fact", api.resolveText2SqlRepresentation(fx("lotb-fact-vertigo-homonyms-en"), "table"), "fact-card");
  check("lotb table preference keeps the verdict", api.resolveText2SqlRepresentation(fx("lotb-verdict-yes-two-rows-en"), "table"), "verdict");
  check("lotb empty verdict keeps the verdict", api.resolveText2SqlRepresentation(fx("lotb-verdict-no-empty-en"), "table"), "verdict");

  // Formats of the quantities: minutes, usd, count, a year, a full date (EN and FR), spoken.
  check("lotb qty minutes", api.text2SqlQuantityText(194, { unit: "minutes", role: "metric" }, "en"), "3 h 14");
  check("lotb qty minutes spoken", api.text2SqlQuantityText(194, { unit: "minutes", role: "metric" }, "fr", true), "3 heures 14 minutes");
  check("lotb qty usd", api.text2SqlQuantityText(2923706026, { unit: "usd", role: "metric" }, "en"), "$2.9B");
  check("lotb qty usd spoken", api.text2SqlQuantityText(2923706026, { unit: "usd", role: "metric" }, "en", true), "2.9 billion dollars");
  check("lotb qty count", api.text2SqlQuantityText(5, { unit: "count", role: "metric" }, "en"), "5");
  check("lotb qty year", api.text2SqlQuantityText(1889, { unit: null, role: "date" }, "en"), "1889");
  check("lotb qty date en", api.text2SqlQuantityText("1958-05-28", { unit: null, role: "date" }, "en"), "28 May 1958");
  check("lotb qty date fr", api.text2SqlQuantityText("1958-05-28", { unit: null, role: "date" }, "fr"), "28 mai 1958");
  check("lotb qty unknown runtime", api.text2SqlQuantityText(0, { unit: "minutes", role: "metric" }, "en"), "");
  check("lotb qty missing", api.text2SqlQuantityText(null, { unit: "count", role: "metric" }, "en"), "");

  // Compare cards: the quantities and the marked card of each one.
  const marks = (name) => {
    const f = fx(name);
    const model = api.text2SqlCompareModel(f.result, f.result_columns, f.summary_facts);
    return {
      columns: model.quantities.map((q) => q.column.name),
      cards: model.cards.map((c) => c.marks.map((m) => (m.wins ? m.extreme : m.tie ? "tie" : "-")).join(",")),
    };
  };
  check("lotb compare runtime winner", marks("lotb-compare-yes-no-runtime-en"), { columns: ["RUNTIME"], cards: ["max", "-"] });
  check("lotb compare godfather winner", marks("lotb-compare-godfather-runtime-en"), { columns: ["RUNTIME"], cards: ["max", "-", "-"] });
  check("lotb compare three revenue winner", marks("lotb-compare-three-revenue-en"), { columns: ["REVENUE"], cards: ["max", "-", "-"] });
  check("lotb compare two quantities", marks("lotb-compare-two-focus-en"), { columns: ["BUDGET", "REVENUE"], cards: ["max,max", "-,-"] });
  check("lotb compare tie marks nobody", marks("lotb-compare-seasons-tie-en"), { columns: ["NUMBER_OF_SEASONS"], cards: ["tie", "tie"] });
  check("lotb compare birth, date parts dropped", marks("lotb-compare-born-before-en"), { columns: ["BIRTH_YEAR"], cards: ["earliest", "-"] });
  {
    // No winners (an older API, a chip): the focus columns, no date part, nobody marked.
    const f = fx("lotb-compare-born-before-en");
    const model = api.text2SqlCompareModel(f.result, f.result_columns, { ...f.summary_facts, winners: undefined });
    check("lotb compare without winners", model.quantities.map((q) => q.column.name), ["BIRTH_YEAR"]);
    check("lotb compare without winners marks nobody", model.cards.every((c) => c.marks.every((m) => !m.wins && !m.tie)), true);
  }
  check("lotb mark text en", ["max", "min", "earliest", "latest"].map((e) => api.text2SqlCompareMarkText(e, "en")), ["Top", "Lowest", "First", "Last"]);
  check("lotb mark text fr", ["max", "min", "earliest", "latest"].map((e) => api.text2SqlCompareMarkText(e, "fr")), ["En tête", "Minimum", "En premier", "En dernier"]);

  check("lotb caption compare en", caption("lotb-compare-yes-no-runtime-en", "en"), "Two films side by side; Titanic leads on runtime, 3 h 14.");
  check("lotb caption compare fr", caption("lotb-compare-yes-no-runtime-fr", "fr"), "Deux films côte à côte ; Titanic l'emporte en durée, 3 h 14.");
  check("lotb spoken compare en", spoken("lotb-compare-yes-no-runtime-en", "en"), "Two films side by side; Titanic leads on runtime, 3 hours 14 minutes.");
  check("lotb caption compare three", caption("lotb-compare-three-revenue-en", "en"), "Three films side by side; Jurassic Park leads on revenue, $1.1B.");
  check("lotb caption compare godfather", caption("lotb-compare-godfather-runtime-en", "en"), "Three films side by side; The Godfather Part II leads on runtime, 3 h 22.");
  check("lotb caption compare two quantities", caption("lotb-compare-two-focus-en", "en"), "Two films side by side; Avatar leads on budget, $237M, and on revenue, $2.9B.");
  check("lotb caption compare tie", caption("lotb-compare-seasons-tie-en", "en"), "Two series side by side; tied on seasons, 5.");
  check("lotb caption compare tie fr", caption("lotb-compare-seasons-tie-en", "fr"), "Deux séries côte à côte ; à égalité en saisons, 5.");
  check("lotb caption born first en", caption("lotb-compare-born-first-en", "en"), "Two people side by side; Charlie Chaplin comes first (1889).");
  check("lotb caption born before fr", caption("lotb-compare-born-before-fr", "fr"), "Deux personnes côte à côte ; Alfred Hitchcock vient en premier (1899).");
  check("lotb spoken summary compare", api.text2SqlSpokenSummary({ upstream: fx("lotb-compare-yes-no-runtime-fr"), has_more: false }),
    "Deux films côte à côte ; Titanic l'emporte en durée, 3 heures 14 minutes.");
  check("lotb caption compare after a chip", caption("lotb-compare-yes-no-runtime-en", "en", { rep: "value-cards" }), "Two films; the longest is Titanic, 3 h 14.");

  // Fact card: the row, the fact, the homonyms.
  const fact = (name) => {
    const f = fx(name);
    const model = api.text2SqlFactModel(f.result, f.result_columns, f.summary_facts, f.intent);
    return { label: model.label, column: model.column.name, value: model.value, others: model.othersCount };
  };
  check("lotb fact runtime", fact("lotb-fact-runtime-en"), { label: "Lawrence of Arabia", column: "RUNTIME", value: 228, others: 0 });
  check("lotb fact vertigo homonyms", fact("lotb-fact-vertigo-homonyms-en"), { label: "Vertigo", column: "DAT_RELEASE", value: "1958-05-28", others: 11 });
  check("lotb fact chernobyl homonym", fact("lotb-fact-chernobyl-homonym-en"), { label: "Chernobyl", column: "NUMBER_OF_EPISODES", value: 5, others: 1 });
  check("lotb fact birth year", fact("lotb-fact-birth-year-en"), { label: "Akira Kurosawa", column: "BIRTH_YEAR", value: 1910, others: 0 });
  check("lotb others text en", api.text2SqlFactOthersText(11, "films", "en"), "11 other titles with this name");
  check("lotb others text fr", api.text2SqlFactOthersText(11, "films", "fr"), "11 autres titres portent ce nom");
  check("lotb others text one fr", api.text2SqlFactOthersText(1, "series", "fr"), "1 autre titre porte ce nom");
  check("lotb others text people", api.text2SqlFactOthersText(2, "people", "en"), "2 other people with this name");

  check("lotb caption fact runtime", caption("lotb-fact-runtime-en", "en"), "Lawrence of Arabia: runtime, 3 h 48.");
  check("lotb spoken fact runtime", spoken("lotb-fact-runtime-en", "en"), "Lawrence of Arabia: runtime, 3 hours 48 minutes.");
  check("lotb caption fact revenue", caption("lotb-fact-revenue-en", "en"), "Avatar: revenue, $2.9B.");
  check("lotb caption fact seasons en", caption("lotb-fact-seasons-en", "en"), "Breaking Bad: seasons, 5.");
  check("lotb caption fact seasons fr", caption("lotb-fact-seasons-fr", "fr"), "Breaking Bad : saisons, 5.");
  check("lotb caption fact birth year", caption("lotb-fact-birth-year-en", "en"), "Akira Kurosawa: birth year, 1910.");
  check("lotb caption fact date fr", caption("lotb-fact-vertigo-date-fr", "fr"), "Sueurs froides : date de sortie, 28 mai 1958.");
  check("lotb caption fact homonyms", caption("lotb-fact-vertigo-homonyms-en", "en"), "Vertigo: release date, 28 May 1958 (11 other titles with this name).");
  check("lotb caption fact one homonym", caption("lotb-fact-chernobyl-homonym-en", "en"), "Chernobyl: episodes, 5 (1 other title with this name).");
  check("lotb caption fact no value", api.text2SqlSummaryLine({
    ...fx("lotb-fact-runtime-en"),
    result: [{ data: { ...fx("lotb-fact-runtime-en").result[0].data, RUNTIME: null } }],
  }, { lang: "en" }), "Lawrence of Arabia: no runtime in the database.");
  check("lotb caption fact after a chip", caption("lotb-fact-vertigo-homonyms-en", "en", { rep: "card-grid" }), "Twelve films.");

  // Verdict: the word, the sentence of each basis, the evidence form, the empty path.
  check("lotb verdict word", [api.text2SqlVerdictWord("yes", "en"), api.text2SqlVerdictWord("no", "en"), api.text2SqlVerdictWord("yes", "fr"), api.text2SqlVerdictWord("no", "fr")], ["Yes", "No", "Oui", "Non"]);
  check("lotb caption verdict one row en", caption("lotb-verdict-yes-en", "en"), "Yes: 1 matching result.");
  check("lotb caption verdict one row fr", caption("lotb-verdict-yes-fr", "fr"), "Oui : 1 résultat correspondant.");
  check("lotb caption verdict rows en", caption("lotb-verdict-yes-two-rows-en", "en"), "Yes: 2 matching results.");
  check("lotb caption verdict rows fr", caption("lotb-verdict-yes-two-rows-fr", "fr"), "Oui : 2 résultats correspondants.");
  check("lotb caption verdict more pages", caption("lotb-verdict-yes-two-rows-en", "en", { hasMore: true }), "Yes: at least 2 matching results.");
  check("lotb caption verdict empty en", caption("lotb-verdict-no-empty-en", "en"), "No: nothing in the database matches.");
  check("lotb caption verdict empty fr", caption("lotb-verdict-no-empty-fr", "fr"), "Non : rien dans la base ne correspond.");
  check("lotb spoken verdict empty", api.text2SqlSpokenSummary({ upstream: fx("lotb-verdict-no-empty-en"), has_more: false }), "No: nothing in the database matches.");
  check("lotb caption verdict count zero en", caption("lotb-verdict-count-zero-en", "en"), "No: 0.");
  check("lotb caption verdict count zero fr", caption("lotb-verdict-count-zero-fr", "fr"), "Non : 0.");
  check("lotb caption verdict count yes", api.text2SqlSummaryLine({
    ...fx("lotb-verdict-count-zero-en"),
    result: [{ data: { AWARD_WIN_COUNT: 3 } }],
    summary_facts: { ...fx("lotb-verdict-count-zero-en").summary_facts, verdict: "yes" },
  }, { lang: "fr" }), "Oui : 3.");
  check("lotb caption verdict after a chip", caption("lotb-verdict-yes-two-rows-en", "en", { rep: "card-grid" }), "Two films.");
  check("lotb verdict never says false", [
    "lotb-verdict-no-empty-en", "lotb-verdict-no-empty-fr", "lotb-verdict-count-zero-en", "lotb-verdict-count-zero-fr",
  ].map((name) => caption(name, name.endsWith("fr") ? "fr" : "en") + api.text2SqlVerdictNote(fx(name), name.endsWith("fr") ? "fr" : "en"))
    .some((text) => /false|faux|wrong|incorrect/i.test(text)), false);
  check("lotb verdict note empty", api.text2SqlVerdictNote(fx("lotb-verdict-no-empty-fr"), "fr"), "Rien dans la base ne correspond à cette question.");
  check("lotb verdict note on rows", api.text2SqlVerdictNote(fx("lotb-verdict-yes-en"), "en"), "");
  check("lotb evidence entity page", api.text2SqlVerdictEvidence(fx("lotb-verdict-yes-en")), "entity-page");
  check("lotb evidence poster grid", api.text2SqlVerdictEvidence(fx("lotb-verdict-yes-two-rows-fr")), "card-grid");
  check("lotb evidence number card", api.text2SqlVerdictEvidence(fx("lotb-verdict-count-zero-en")), "number-card");
  check("lotb evidence none when empty", api.text2SqlVerdictEvidence(fx("lotb-verdict-no-empty-en")), "");
  check("lotb evidence older API, one row", api.text2SqlVerdictEvidence({ result: [{ data: { ID_MOVIE: 578 } }] }), "entity-page");
  {
    // The empty verdict reaches the dispatch: no row, yet a summary and the verdict representation.
    const empty = fx("lotb-verdict-no-empty-en");
    check("lotb empty verdict shape", [empty.result.length, empty.summary_facts.count, empty.representation], [0, 0, "verdict"]);
  }

  // "Side by side" / "côte à côte", typed or through show_results_as; "as cards" keeps compare cards.
  check("view: side by side", view("show them side by side"), "compare");
  check("view: cote a cote", view("Mets-les côte à côte"), "compare");
  check("view: compare them", view("compare them"), "compare");
  check("no view: compare two titles", view("Compare Titanic and Avatar"), "");
  const compareOpts = fx("lotb-compare-yes-no-runtime-en").representation_options;
  check("view to rep: compare", api.text2SqlRepresentationForView("compare", compareOpts), "compare-cards");
  check("view to rep: compare not offered", api.text2SqlRepresentationForView("compare", opts), "");
  check("view to rep: cards keep compare cards", api.text2SqlRepresentationForView("cards", compareOpts, "compare-cards"), "compare-cards");
  check("view to rep: cards from the table", api.text2SqlRepresentationForView("cards", compareOpts, "table"), "value-cards");
  check("reply compare fr", api.text2SqlRequestedViewReply({ ok: true, representation: "compare-cards", view: "compare" }, "fr"), "Les voici côte à côte.");
  check("reply compare refused en", api.text2SqlRequestedViewReply({ ok: false, view: "compare", available: ["timeline", "card-grid", "table"] }, "en"),
    "This result cannot be shown as cards side by side. Available views: Timeline, Posters, Table.");
}

// Phase 2 lot C (fixtures lotc-*: live 1.1.20 answers of 2026-11-11, re-classified with the lot C
// module of fastapi-text2sql). The sentences are the ones t2s-front writes.
{
  // Histogram: bins in their own order, the empty bin the API filled in, the ranges, the sentence.
  const range = api.text2SqlHistogramModel(fx("lotc-histogram-runtime-range-en").summary_facts, "en");
  check("lotc histogram bars", range.bars.map((b) => [b.axis, b.range, b.value, b.empty, b.peak]), [
    ["0", "0 to 29 min", 3, false, false], ["30", "30 to 59 min", 0, true, false], ["60", "60 to 89 min", 4, false, false],
    ["90", "90 to 119 min", 2, false, false], ["120", "120 to 149 min", 5, false, true], ["150", "150 to 179 min", 2, false, false],
    ["180", "180 to 209 min", 2, false, false],
  ]);
  check("lotc histogram heights", range.bars.map((b) => b.pct), [60, 0, 80, 40, 100, 40, 40]);
  check("lotc histogram bins sorted by start", api.text2SqlHistogramModel(fx("lotc-histogram-raw-rating-en").summary_facts, "en").bars
    .every((b, i, all) => i === 0 || Number(b.axis) > Number(all[i - 1].axis)), true);
  check("lotc caption histogram runtime en", caption("lotc-histogram-runtime-range-en", "en"),
    "18 films in bins of 30 min; the most common bin is 120 to 149 min, 5 films.");
  check("lotc caption histogram runtime fr", caption("lotc-histogram-runtime-range-fr", "fr"),
    "18 films, par tranches de 30 min ; la tranche la plus fréquente : 120 à 149 min, 5 films.");
  check("lotc spoken histogram runtime", spoken("lotc-histogram-runtime-range-en", "en"),
    "18 films in bins of 30 minutes; the most common bin is 120 to 149 minutes, 5 films.");
  check("lotc caption histogram width without an end", caption("lotc-histogram-bond-runtime-en", "en"),
    "27 films in bins of 10 min; the most common bin is 130 to 139 min, 8 films.");
  check("lotc caption histogram money", caption("lotc-histogram-budget-en", "en"),
    "31 films in bins of $50M; the most common bin is $0 to $50M, 16 films.");
  check("lotc spoken histogram money step", spoken("lotc-histogram-budget-en", "en").startsWith("31 films in bins of 50 million dollars;"), true);
  check("lotc caption histogram no unit", caption("lotc-histogram-rating-band-en", "en"),
    "14,292 films in 10 bins; the most common bin is 6, 4,133 films.");
  check("lotc caption histogram series", caption("lotc-histogram-seasons-en", "en"),
    "375 series in 57 bins; the most common bin is 1, 219 series.");
  check("lotc histogram axis names", [
    api.text2SqlHistogramAxisName(range, "en"),
    api.text2SqlHistogramAxisName(api.text2SqlHistogramModel(fx("lotc-histogram-runtime-range-fr").summary_facts, "fr"), "fr"),
    api.text2SqlHistogramAxisName(api.text2SqlHistogramModel(fx("lotc-histogram-budget-en").summary_facts, "en"), "en"),
    api.text2SqlHistogramAxisName(api.text2SqlHistogramModel(fx("lotc-histogram-rating-band-en").summary_facts, "en"), "en"),
  ], ["Runtime (min), bins of 30 min", "Durée (min), tranches de 30 min", "Budget ($), bins of $50M", "Rating"]);
  check("lotc histogram text bin", api.text2SqlBinRangeText({ label: "under 90" }, { unit: "minutes" }, "en"), "under 90");
  check("lotc histogram step of one", api.text2SqlBinRangeText({ low: 3, high: null }, { unit: "count", width: 1 }, "fr"), "3");
  check("lotc histogram chips", api.text2SqlChipOptionsLotC(fx("lotc-histogram-seasons-en")), ["histogram", "table"]);

  // Share bar: the parts and their labels, GENDER named, one share and its rest, the sentences.
  check("lotc share gender labels en", api.text2SqlShareModel(fx("lotc-share-gender-codes-en"), "en").segments.map((s) => [s.label, s.valueText, s.pctText]),
    [["women", "7", "11%"], ["men", "58", "88%"], ["non-binary", "1", "2%"]]);
  check("lotc share gender labels fr", api.text2SqlShareModel(fx("lotc-share-gender-codes-en"), "fr").segments.map((s) => s.label), ["femmes", "hommes", "non binaire"]);
  check("lotc caption share parts en", caption("lotc-share-hbo-type-en", "en"),
    "375 series counted in six parts: Scripted 49%, Miniseries 38%, Documentary 8% and 3 more.");
  check("lotc caption share parts fr", caption("lotc-share-hbo-type-fr", "fr"),
    "375 séries comptées en six parts : Scripted 49 %, Miniseries 38 %, Documentary 8 % et 3 autres.");
  check("lotc caption share as a pie", caption("lotc-share-pie-status-en", "en"),
    "375 series counted in five parts: Ended 74%, Canceled 12%, Returning Series 11% and 2 more.");
  check("lotc caption share gender", caption("lotc-share-gender-codes-en", "en"),
    "66 people counted in three parts: women 11%, men 88%, non-binary 2%.");
  check("lotc caption share CASE labels fr", caption("lotc-share-gender-labels-fr", "fr"),
    "65 résultats comptés en deux parts : Femmes 11 %, Hommes 89 %.");
  check("lotc caption one share en", caption("lotc-share-single-en", "en"), "74% of the whole; the rest, 26%.");
  check("lotc caption one share fr", caption("lotc-share-single-percent-fr", "fr"), "74 % de l'ensemble ; le reste, 26 %.");
  check("lotc one share and its rest add up", caption("lotc-share-single-percent-en", "en"), "38% of the whole; the rest, 62%.");
  check("lotc spoken one share", spoken("lotc-share-single-en", "en"), "74 percent of the whole; the rest, 26 percent.");
  check("lotc spoken share fr", spoken("lotc-share-gender-labels-fr", "fr"), "65 résultats comptés en deux parts : Femmes 11 pour cent, Hommes 89 pour cent.");
  check("lotc share rest labelled", api.text2SqlShareModel(fx("lotc-share-single-en"), "fr").segments.map((s) => [s.label, s.rest]),
    [["film share", false], ["le reste", true]]);
  check("lotc percent below one", [api.text2SqlPercentText(0.004, "en"), api.text2SqlPercentText(0.004, "fr"), api.text2SqlPercentText(0, "en")], ["<1%", "<1 %", "0%"]);
  check("lotc share chips one row", api.text2SqlChipOptionsLotC(fx("lotc-share-single-en")), ["share-bar", "table"]);
  check("lotc share chips parts", api.text2SqlChipOptionsLotC(fx("lotc-share-hbo-type-en")), ["share-bar", "ranked-bars", "table"]);

  // Flag list: the emoji from the code, no flag for a withdrawn code, the names, the sentences.
  check("lotc flag emoji", [api.text2SqlFlagEmoji("FR"), api.text2SqlFlagEmoji("jp"), api.text2SqlFlagEmoji("1A"), api.text2SqlFlagEmoji("")],
    ["\u{1F1EB}\u{1F1F7}", "\u{1F1EF}\u{1F1F5}", "", ""]);
  const noFlag = api.text2SqlFlagModel(fx("lotc-flags-codes-no-flag-en"), "en").items.filter((i) => !i.flag).map((i) => [i.code, i.name]);
  check("lotc flags without a flag", noFlag, [["YU", "Yugoslavia"], ["SU", "Soviet Union"], ["XC", "Czechoslovakia"], ["XK", "Kosovo"]]);
  check("lotc flags place names", api.text2SqlFlagModel(fx("lotc-flags-filmed-england-en"), "fr").items.map((i) => [i.code, i.name]),
    [["GB", "England"], ["JO", "Jordanie"], ["MA", "Maroc"], ["ES", "Espagne"], ["GB", "Royaume-Uni"]]);
  check("lotc flags bars", api.text2SqlFlagModel(fx("lotc-flags-codes-kurosawa-en"), "en").items.slice(0, 3).map((i) => [i.code, i.valueText, i.pct]),
    [["JP", "93", 100], ["US", "16", 17], ["IT", "4", 4]]);
  check("lotc caption flags count en", caption("lotc-flags-codes-kurosawa-en", "en"), "The first 13 countries by number of films; Japan leads with 93 films.");
  check("lotc caption flags count fr", caption("lotc-flags-codes-kurosawa-fr", "fr"), "Les 13 premiers pays par nombre de films ; Japon arrive en tête avec 93 films.");
  check("lotc caption flags names en", caption("lotc-flags-filmed-mad-max-en", "en"), "Four countries: Angola, Australia, Namibia and South Africa.");
  check("lotc caption flags names fr", caption("lotc-flags-filmed-mad-max-fr", "fr"), "Quatre pays : Angola, Australie, Namibie et Afrique du Sud.");
  check("lotc caption flags repeated", caption("lotc-flags-repeated-lotr-en", "en"), "Two countries: New Zealand and United States.");
  check("lotc caption flags more pages", caption("lotc-flags-filmed-mad-max-en", "en", { hasMore: true }), "The first four countries: Angola, Australia, Namibia and South Africa.");
  check("lotc flags chips", [api.text2SqlChipOptionsLotC(fx("lotc-flags-codes-netflix-en")), api.text2SqlChipOptionsLotC(fx("lotc-flags-filmed-mad-max-en"))],
    [["flag-list", "ranked-bars", "table"], ["flag-list", "card-grid", "table"]]);

  // Views asked for in words: a pie, a histogram, the flags; "as a chart" on a country ranking.
  check("view: as a pie", view("show it as a pie"), "share");
  check("view: en camembert", view("Mets-le en camembert"), "share");
  check("view: histogram", view("as a histogram please"), "histogram");
  check("view: with the flags", view("show them with flags"), "flags");
  check("view to rep: share", api.text2SqlRepresentationForView("share", fx("lotc-share-hbo-type-en").representation_options), "share-bar");
  check("view to rep: chart on flags is the ranking", api.text2SqlRepresentationForView("chart", fx("lotc-flags-codes-kurosawa-en").representation_options), "ranked-bars");
  check("view to rep: chart on a histogram", api.text2SqlRepresentationForView("chart", fx("lotc-histogram-seasons-en").representation_options), "histogram");
  check("view to rep: columns on a histogram", api.text2SqlRepresentationForView("columns", fx("lotc-histogram-seasons-en").representation_options), "histogram");
  check("view to rep: flags not offered", api.text2SqlRepresentationForView("flags", fx("lotc-share-hbo-type-en").representation_options), "");
  check("reply share fr", api.text2SqlRequestedViewReply({ ok: true, representation: "share-bar", view: "share" }, "fr"), "Voici les parts.");
  check("lotc labels", ["histogram", "share-bar", "flag-list"].map((rep) => [api.text2SqlRepresentationLabel(rep, "en"), api.text2SqlRepresentationLabel(rep, "fr")]),
    [["Histogram", "Histogramme"], ["Shares", "Parts"], ["Flags", "Drapeaux"]]);
}

// Phase 3 lot A (fixtures p3a-*: the 1.1.20 baseline answers of evaluations 2900 to 2909, English
// and French, re-classified with the phase 3 lot A module of fastapi-text2sql). The sentences
// and ticks are the ones t2s-front writes.
{
  check("p3a caption all plotted en", caption("p3a-scatter-kubrick-runtime-rating-en", "en"),
    "18 films, runtime against IMDb rating; highest IMDb rating: Paths of Glory, 8.4.");
  check("p3a caption all plotted fr", caption("p3a-scatter-kubrick-runtime-rating-fr", "fr"),
    "18 films, note IMDb en fonction de la durée ; maximum de la note IMDb : Shining, 8.4.");
  check("p3a caption left out en", caption("p3a-scatter-nolan-budget-revenue-en", "en"),
    "18 of 31 films, budget against box-office revenue (13 without a budget or box-office revenue); highest box-office revenue: The Odyssey, $1.8B.");
  check("p3a caption left out fr", caption("p3a-scatter-nolan-budget-revenue-fr", "fr"),
    "18 films sur 31, recettes en fonction du budget (13 sans budget ou sans recettes) ; maximum des recettes : L'Odyssée, $1.8B.");
  check("p3a caption one value missing", caption("p3a-scatter-pixar-budget-rating-en", "en"),
    "34 of 50 films, budget against IMDb rating (16 without a budget); highest IMDb rating: WALL·E, 8.4.");
  check("p3a caption year axis fr", caption("p3a-scatter-hitchcock-year-rating-fr", "fr"),
    "49 films sur 50, note IMDb en fonction de l'année de sortie (1 sans note IMDb) ; maximum de la note IMDb : Rebecca, 8.0.");
  check("p3a caption series", caption("p3a-scatter-hbo-seasons-rating-en", "en"),
    "50 series, number of seasons against IMDb rating; highest IMDb rating: Band of Brothers, 9.4.");
  check("p3a caption more pages en", caption("p3a-scatter-ghibli-runtime-rating-en", "en", { hasMore: true }),
    "The first 50 films, runtime against IMDb rating; highest IMDb rating: Spirited Away, 8.6.");
  check("p3a caption more pages fr, left out", caption("p3a-scatter-hbo-seasons-rating-fr", "fr", { hasMore: true }),
    "49 des 50 premières séries, note IMDb en fonction du nombre de saisons (1 sans nombre de saisons) ; maximum de la note IMDb : The Franchise, 6.5.");
  check("p3a spoken money en", spoken("p3a-scatter-potter-runtime-revenue-en", "en"),
    "8 films, runtime against box-office revenue; highest box-office revenue: Harry Potter and the Deathly Hallows: Part 2, 1.3 billion dollars.");
  check("p3a spoken money fr", spoken("p3a-scatter-bond-budget-revenue-fr", "fr"),
    "26 films sur 27, recettes en fonction du budget (1 sans budget ou sans recettes) ; maximum des recettes : Skyfall, 1,1 milliard de dollars.");

  // Axes: titles in the UI language, round ticks in the unit's short form, log decades for votes.
  const axes = (name, lang) => {
    const m = api.text2SqlScatterModel(fx(name), lang);
    return [m.x.title, m.x.ticks.map((t) => t.text), m.y.title, m.y.ticks.map((t) => t.text)];
  };
  check("p3a axes money", axes("p3a-scatter-nolan-budget-revenue-en", "en"),
    ["Budget ($)", ["$0", "$100M", "$200M", "$300M"], "Box-office revenue ($)", ["$0", "$500M", "$1B", "$1.5B", "$2B"]]);
  check("p3a axes money fr", axes("p3a-scatter-mcu-budget-revenue-fr", "fr").slice(0, 3),
    ["Budget ($)", ["$100M", "$150M", "$200M", "$250M", "$300M"], "Recettes ($)"]);
  check("p3a axes log votes", axes("p3a-scatter-tarantino-votes-rating-en", "en"),
    ["IMDb votes (log scale)", ["10", "100", "1K", "10K", "100K", "1M", "10M"], "IMDb rating", ["4", "6", "8", "10"]]);
  check("p3a axes log votes fr", axes("p3a-scatter-tarantino-votes-rating-fr", "fr")[0], "Votes IMDb (échelle log)");
  check("p3a axes year, padded where a point sits on the edge", axes("p3a-scatter-hitchcock-year-rating-en", "en"),
    ["Release year", ["1910", "1920", "1930", "1940", "1950"], "IMDb rating", ["4", "5", "6", "7", "8"]]);
  check("p3a axes minutes", axes("p3a-scatter-potter-runtime-revenue-en", "en"),
    ["Runtime (min)", ["120", "130", "140", "150", "160", "170"], "Box-office revenue ($)", ["$600M", "$800M", "$1B", "$1.2B", "$1.4B"]]);
  check("p3a axes seasons fr", axes("p3a-scatter-hbo-seasons-rating-fr", "fr")[0], "Nombre de saisons");

  // Points: placed by percent, the highest ringed and shown first, titled with both values.
  const nolan = api.text2SqlScatterModel(fx("p3a-scatter-nolan-budget-revenue-en"), "en");
  check("p3a points kept", nolan.points.length, 18);
  check("p3a highest point", nolan.points[nolan.highlight],
    { index: 6, label: "The Odyssey", left: 83.33, top: 10.19, xText: "$250M", yText: "$1.8B",
      values: "Budget $250M · Box-office revenue $1.8B", aria: "The Odyssey: budget $250M, box-office revenue $1.8B", highest: true });
  check("p3a only one ringed", nolan.points.filter((p) => p.highest).length, 1);
  check("p3a points inside the plot", ["nolan-budget-revenue", "mcu-budget-revenue", "kubrick-runtime-rating", "hitchcock-year-rating",
    "pixar-budget-rating", "ghibli-runtime-rating", "bond-budget-revenue", "tarantino-votes-rating", "potter-runtime-revenue", "hbo-seasons-rating"]
    .every((n) => ["en", "fr"].every((l) => api.text2SqlScatterModel(fx(`p3a-scatter-${n}-${l}`), l).points
      .every((p) => p.left >= 0 && p.left <= 100 && p.top >= 0 && p.top <= 100))), true);
  check("p3a values fr", api.text2SqlScatterModel(fx("p3a-scatter-kubrick-runtime-rating-fr"), "fr").points[0].aria, "Shining : durée 144 min, note IMDb 8.4");
  check("p3a votes value", api.text2SqlScatterValueText(2482559, { unit: "votes" }, "en"), "2,482,559");
  check("p3a tick texts", [api.text2SqlScatterTickText(1250000000, { unit: "usd" }), api.text2SqlScatterTickText(2500, { unit: "count" }),
    api.text2SqlScatterTickText(7.5, { unit: "rating" }), api.text2SqlScatterTickText(1958, { unit: "year" }), api.text2SqlScatterTickText(0, { unit: "usd" })],
  ["$1.25B", "2.5K", "7.5", "1958", "$0"]);
  check("p3a no scatter facts, no model", api.text2SqlScatterModel(fx("lotc-share-hbo-type-en"), "en"), null);

  // Chips, labels and the view asked for in words.
  check("p3a chips", api.text2SqlChipOptionsLotC(fx("p3a-scatter-nolan-budget-revenue-en")), ["scatter", "value-cards", "card-grid", "ranked-bars", "table"]);
  check("p3a labels", [api.text2SqlRepresentationLabel("scatter", "en"), api.text2SqlRepresentationLabel("scatter", "fr")], ["Scatter", "Nuage de points"]);
  check("view: as a scatter plot", view("show it as a scatter plot"), "scatter");
  check("view: en nuage de points", view("Mets-le en nuage de points"), "scatter");
  check("view to rep: scatter", api.text2SqlRepresentationForView("scatter", fx("p3a-scatter-kubrick-runtime-rating-en").representation_options), "scatter");
  check("view to rep: scatter not offered", api.text2SqlRepresentationForView("scatter", fx("lotc-share-hbo-type-en").representation_options), "");
  check("view to rep: chart on a scatter stays the bars", api.text2SqlRepresentationForView("chart", fx("p3a-scatter-kubrick-runtime-rating-en").representation_options), "ranked-bars");
  check("reply scatter fr", api.text2SqlRequestedViewReply({ ok: true, representation: "scatter", view: "scatter" }, "fr"), "Voici le nuage de points.");
}

// Phase 3 lot B (fixtures p3b-*: the 1.1.20 baseline answers of evaluations 2916 to 2919, the
// countries asked on a map, re-classified with the phase 3 lot B module of fastapi-text2sql; the
// outline is app/static/world-110m.json). The sentences, legend and notes are the ones t2s-front
// writes.
{
  const world = JSON.parse(readFileSync(join(root, "app", "static", "world-110m.json"), "utf8"));
  const map = (name, lang) => api.text2SqlMapModel(fx(name), lang, world);
  check("p3b outline", [world.width, world.height, Object.keys(world.shapes).length, ["702", "344", "470", "492", "438", "048", "020"].every((k) => world.dots[k]),
    world.alpha2["250"], world.alpha2["826"]], [2000, 863, 173, true, "FR", "GB"]);
  check("p3b caption en", caption("p3b-map-films-2020-en", "en"),
    "The first 50 countries by number of films on the map; United States leads with 3,957 films.");
  check("p3b caption fr", caption("p3b-map-coproductions-france-fr", "fr"),
    "Les 50 premiers pays par nombre de films sur la carte ; Italie arrive en tête avec 2,514 films.");
  check("p3b caption series", spoken("p3b-map-netflix-series-en", "en"),
    "The first 50 countries by number of series on the map; United States leads with 1,047 series.");
  check("p3b caption without counts", caption("p3b-map-country-locations-en", "en"),
    "50 countries on the map: Indonesia, England, France, Italy, Mexico and 45 more.");
  check("p3b flag caption unchanged", api.text2SqlSummaryLine({ ...fx("p3b-map-films-2020-en"), representation: "flag-list" }, { lang: "en" }),
    "The first 50 countries by number of films; United States leads with 3,957 films.");
  const films = map("p3b-map-films-2020-en", "en");
  check("p3b legend", [films.legendTitle, films.legend], ["Number of films", [{ text: "39-55", tone: 0 }, { text: "57-98", tone: 1 },
    { text: "99-134", tone: 2 }, { text: "177-316", tone: 3 }, { text: "401-3,957", tone: 4 }]]);
  check("p3b legend fr, one value a step", [map("p3b-map-netflix-series-en", "fr").legendTitle, map("p3b-map-netflix-series-en", "en").legend[0].text], ["Nombre de séries", "2"]);
  check("p3b top country", (({ numeric, label, tone, dot }) => ({ numeric, label, tone, dot }))(films.countries[0]),
    { numeric: "840", label: "United States: 3,957 films", tone: 4, dot: null });
  check("p3b label fr", map("p3b-map-films-2020-fr", "fr").countries[0].label, "États-Unis : 3,957 films");
  check("p3b small countries are dots", films.countries.filter((c) => c.dot).map((c) => [c.name, c.dot.left > 0 && c.dot.left < 100 && c.dot.top > 0 && c.dot.top < 100]),
    [["Hong Kong", true], ["Singapore", true]]);
  check("p3b every country placed", films.countries.length, 50);
  check("p3b land keeps the others", films.land.length > 5000 && !films.land.includes(world.shapes["840"]), true);
  const places = map("p3b-map-country-locations-en", "en");
  check("p3b locations: one country, its places named together, no shade", (({ name, tone }) => ({ name, tone }))(places.countries.find((c) => c.numeric === "826")),
    { name: "England, Scotland", tone: null });
  check("p3b locations: not on the map", places.offText, "Not on the map: Milan, Russian Empire, Venice, Soviet Union, Ancient Rome, Hamburg.");
  check("p3b locations: no legend, the name hint", [places.legend, places.legendTitle, places.hint], [[], "", "Tap or hover over a country to see its name."]);
  check("p3b off map fr, with the count", api.text2SqlMapModel({ ...fx("p3b-map-films-2020-fr"), summary_facts: { ...fx("p3b-map-films-2020-fr").summary_facts,
    countries: { ...fx("p3b-map-films-2020-fr").summary_facts.countries, countries: fx("p3b-map-films-2020-fr").summary_facts.countries.countries.map((c, i) => (i === 1 ? { ...c, code: "SU", numeric: null, name: { en: "Soviet Union", fr: "Union soviétique" } } : c)) } } }, "fr", world).offText,
    "Hors carte : Union soviétique (1,127).");
  check("p3b tones", [1, 2, 3, 4, 5].map((n) => Array.from({ length: n }, (_, i) => api.text2SqlMapTone(i, n))), [[4], [0, 4], [0, 2, 4], [0, 1, 3, 4], [0, 1, 2, 3, 4]]);
  check("p3b no outline or no facts, no model", [api.text2SqlMapModel(fx("p3b-map-films-2020-en"), "en", null), api.text2SqlMapModel(fx("lotc-share-hbo-type-en"), "en", world)], [null, null]);
  check("p3b chips", api.text2SqlChipOptionsLotC(fx("p3b-map-films-2020-en")), ["map", "flag-list", "ranked-bars", "table"]);
  check("p3b labels", [api.text2SqlRepresentationLabel("map", "en"), api.text2SqlRepresentationLabel("map", "fr")], ["Map", "Carte"]);
  check("view: on a map", view("show it on a map"), "map");
  check("view: sur une carte", view("Montre-le sur une carte"), "map");
  check("view: en cartes stays cards", view("Montre-les en cartes"), "cards");
  check("view to rep: map", api.text2SqlRepresentationForView("map", fx("lotc-flags-codes-netflix-en").representation_options.concat("map")), "map");
  check("view to rep: map not offered", api.text2SqlRepresentationForView("map", fx("lotc-share-hbo-type-en").representation_options), "");
  check("reply map fr", api.text2SqlRequestedViewReply({ ok: true, representation: "map", view: "map" }, "fr"), "Voici la carte.");
}

// Phase 3 lot C (fixtures p3c-*: the 1.1.20 answers of evaluations 2920, 2922, 2926 and 2927,
// re-classified with the phase 3 lot C module of fastapi-text2sql, and one hand-written answer
// with three levels, the shape the prompt rule asks for). The sentences are t2s-front's.
{
  const P = "p3c-hierarchy-";
  check("p3c caption even en", caption(P + "middle-earth-trilogies-en", "en"), "Six films in two trilogies, three in each.");
  check("p3c caption even fr", caption(P + "middle-earth-trilogies-en", "fr"), "Six films en deux trilogies, trois dans chacune.");
  check("p3c caption largest fr", caption(P + "mcu-collections-fr", "fr"),
    "37 films en douze collections ; la plus grande, The Avengers Collection, en compte six.");
  check("p3c caption largest en", caption(P + "mcu-collections-fr", "en"),
    "37 films in twelve collections; the largest, The Avengers Collection, has six.");
  check("p3c caption shared en", caption(P + "italy-regions-en", "en"),
    "44 places in 19 regions (five in more than one); the largest, Lazio, has eleven.");
  check("p3c caption shared fr, more pages", caption(P + "italy-regions-fr", "fr", { hasMore: true }),
    "Les 42 premiers lieux en 20 régions (sept dans plusieurs) ; la plus grande, Lazio, en compte onze.");
  check("p3c caption masculine level fr", caption(P + "ford-states-en", "fr"),
    "Douze lieux en neuf États (trois dans plusieurs) ; le plus grand, California, en compte cinq.");
  check("p3c caption three levels en", caption(P + "potter-nations-counties-hand-en", "en"),
    "Seven places in five counties and three nations; the largest, England, has five.");
  check("p3c caption three levels fr", caption(P + "potter-nations-counties-hand-en", "fr"),
    "Sept lieux dans cinq comtés et trois nations ; la plus grande, England, en compte cinq.");
  check("p3c spoken is the caption", spoken(P + "middle-earth-trilogies-en", "en"), "Six films in two trilogies, three in each.");
  check("p3c more pages en", caption(P + "middle-earth-trilogies-en", "en", { hasMore: true }), "The first six films in two trilogies, three in each.");

  // Model: the API's groups in its order, the leaves by row position, the leaf alone when it
  // comes after its parent's entity (no collection poster on a film), the group's own record.
  const me = api.text2SqlHierarchyModel(fx(P + "middle-earth-trilogies-en"), "en");
  check("p3c groups", me.groups.map((g) => [g.name, g.count, g.leaves.length]),
    [["The Hobbit Collection", 3, 3], ["The Lord of the Rings Collection", 3, 3]]);
  check("p3c leaf with year and its row", [me.image, me.groups[1].leaves[0].title, me.groups[1].leaves[0].year, me.groups[1].leaves[0].index,
    me.groups[1].leaves[0].record.POSTER_PATH !== undefined], [true, "The Lord of the Rings: The Fellowship of the Ring", "2001", 3, true]);
  const mcu = api.text2SqlHierarchyModel(fx(P + "mcu-collections-fr"), "fr");
  check("p3c leaf alone after its parent", [mcu.image, mcu.groups[0].leaves[0].record, mcu.groups[0].leaves[0].year],
    [false, { ID_MOVIE: 102899, MOVIE_TITLE: "Ant-Man" }, ""]);
  check("p3c group record", mcu.groups[0].record, { ID_T2S_COLLECTION: 1776, COLLECTION_NAME: "Ant-Man Collection" });
  check("p3c no id, no group record", me.groups[0].record, null);
  const hand = api.text2SqlHierarchyModel(fx(P + "potter-nations-counties-hand-en"), "en");
  check("p3c three levels", hand.groups.map((g) => [g.name, g.count, g.leaves.length, g.groups.map((s) => [s.name, s.count, s.leaves.map((l) => l.title)])]),
    [["England", 5, 0, [["Greater London", 2, ["Leadenhall Market", "London Zoo"]], ["North Yorkshire", 1, ["Goathland railway station"]],
      ["Oxfordshire", 2, ["Christ Church", "New College"]]]], ["Scotland", 1, 0, [["Highland", 1, ["Glen Nevis"]]]],
     ["Wales", 1, 0, [["Pembrokeshire", 1, ["Pembrokeshire"]]]]]);
  const it = api.text2SqlHierarchyModel(fx(P + "italy-regions-en"), "en");
  check("p3c a shared place under each of its groups", it.groups.filter((g) => g.leaves.some((l) => l.title === "Cirella")).map((g) => g.name),
    ["Calabria", "Diamante"]);
  const other = JSON.parse(JSON.stringify(fx(P + "middle-earth-trilogies-en")));
  other.summary_facts.hierarchy.groups[0].label = null;
  check("p3c an unnamed group reads Other", [api.text2SqlHierarchyModel(other, "fr").groups[0].name, api.text2SqlHierarchyModel(other, "en").groups[0].unnamed], ["Autres", true]);
  check("p3c leaf nouns", [api.text2SqlHierarchyLeafNoun("ID_LOCATION", [])[1], api.text2SqlHierarchyLeafNoun("ID_CONTENT", [{ CONTENT_TYPE: "serie" }])[0],
    api.text2SqlHierarchyLeafNoun("ID_AWARD", [])[0], api.text2SqlHierarchyKind("nope")[1]], ["lieux", "series", "results", "groupes"]);
  check("p3c no hierarchy facts, no model", api.text2SqlHierarchyModel(fx("lotc-share-hbo-type-en"), "en"), null);

  // Chips, labels and the view asked for in words.
  check("p3c chips", api.text2SqlChipOptionsLotC(fx(P + "italy-regions-en")), ["hierarchy", "card-grid", "table"]);
  check("p3c labels", [api.text2SqlRepresentationLabel("hierarchy", "en"), api.text2SqlRepresentationLabel("hierarchy", "fr")], ["Groups", "Groupes"]);
  check("view: in groups", view("show them in groups"), "groups");
  check("view: par groupe", view("Affiche-les par groupe"), "groups");
  check("view: grouped by trilogy is a search", view("grouped by trilogy"), "");
  check("view to rep: groups", api.text2SqlRepresentationForView("groups", fx(P + "ford-states-en").representation_options), "hierarchy");
  check("view to rep: groups not offered", api.text2SqlRepresentationForView("groups", fx("lotc-share-hbo-type-en").representation_options), "");
  check("reply groups fr", api.text2SqlRequestedViewReply({ ok: true, representation: "hierarchy", view: "groups" }, "fr"), "Voici le résultat par groupe.");
}

// Phase 3 lot E (fixtures p3e-*: the 1.1.20 answers of evaluations 2930 to 2939 re-classified with
// the API's lineage walk run on the live graph, plus three hand-written: Red Harvest cut at five
// works, in English and French, and three films citing each other in a ring). The captions are
// t2s-front's word for word (the same list in its test).
{
  const P = "p3e-chain-";
  check("p3e caption p3e-chain-star-is-born-en", caption("p3e-chain-star-is-born-en", "en"), "Four films from A Star Is Born (1937) to A Star Is Born (2018); A Star Is Born (2018) draws on three of them.");
  check("p3e caption p3e-chain-star-is-born-fr", caption("p3e-chain-star-is-born-fr", "fr"), "Quatre films, d'Une étoile est née (1937) à A Star is Born (2018) ; A Star is Born en reprend trois.");
  check("p3e caption p3e-chain-fistful-en", caption("p3e-chain-fistful-en", "en"), "Three works from Red Harvest (1927) to A Fistful of Dollars (1964); A Fistful of Dollars draws on two of them.");
  check("p3e caption p3e-chain-fistful-fr", caption("p3e-chain-fistful-fr", "fr"), "Trois œuvres, de La Moisson rouge (1927) à Pour une poignée de dollars (1964) ; Pour une poignée de dollars en reprend deux.");
  check("p3e caption p3e-chain-scarface-en", caption("p3e-chain-scarface-en", "en"), "Three works from Scarface (1930) to Scarface (1983); Scarface (1983) draws on two of them.");
  check("p3e caption p3e-chain-departed-en", caption("p3e-chain-departed-en", "en"), "Five works from Infernal Affairs (2002) to The Clan (2022); The Departed remakes Infernal Affairs.");
  check("p3e caption p3e-chain-magnificent-seven-2016-en", caption("p3e-chain-magnificent-seven-2016-en", "en"), "Three films from Seven Samurai (1954) to The Magnificent Seven (2016); The Magnificent Seven (2016) draws on two of them.");
  check("p3e caption p3e-chain-nosferatu-en", caption("p3e-chain-nosferatu-en", "en"), "Three works from Dracula (1897) to Nosferatu (2024); Nosferatu (2024) draws on two of them.");
  check("p3e caption p3e-chain-nosferatu-fr", caption("p3e-chain-nosferatu-fr", "fr"), "Trois œuvres, de Dracula (1897) à Nosferatu (2024) ; Nosferatu (2024) en reprend deux.");
  check("p3e caption p3e-chain-last-man-standing-en", caption("p3e-chain-last-man-standing-en", "en"), "Three works from Red Harvest (1927) to Last Man Standing (1996); Last Man Standing remakes Yojimbo.");
  check("p3e caption p3e-chain-red-harvest-en", caption("p3e-chain-red-harvest-en", "en"), "Nine works from Red Harvest (1927) to Django (2023); Red Harvest directly inspired three of them.");
  check("p3e caption p3e-chain-seven-samurai-en", caption("p3e-chain-seven-samurai-en", "en"), "Six works from Seven Samurai (1954) to The Magnificent Seven (2016); Seven Samurai directly inspired three of them.");
  check("p3e caption p3e-chain-seven-samurai-fr", caption("p3e-chain-seven-samurai-fr", "fr"), "Six œuvres, des Sept Samouraïs (1954) aux Sept Mercenaires (2016) ; Les Sept Samouraïs en a inspiré directement trois.");
  check("p3e caption p3e-chain-magnificent-seven-1960-en", caption("p3e-chain-magnificent-seven-1960-en", "en"), "Five works from Seven Samurai (1954) to The Magnificent Seven (2016); The Magnificent Seven (1960) remakes Seven Samurai.");
  check("p3e caption p3e-chain-red-harvest-cut-hand-en", caption("p3e-chain-red-harvest-cut-hand-en", "en"), "Five works from Red Harvest (1927) to Last Man Standing (1996) (the lineage goes on beyond five works); Red Harvest directly inspired three of them.");
  check("p3e caption p3e-chain-red-harvest-cut-hand-fr", caption("p3e-chain-red-harvest-cut-hand-fr", "fr"), "Cinq œuvres, de La Moisson rouge (1927) à Dernier recours (1996) (la filiation continue au-delà de cinq œuvres) ; La Moisson rouge en a inspiré directement trois.");
  check("p3e caption p3e-chain-ring-hand-en", caption("p3e-chain-ring-hand-en", "en"), "Three films from Dog Day Afternoon (1975) to The Dog (2013); Terrorism and Kebab remakes Dog Day Afternoon.");
  check("p3e spoken is the caption", spoken(P + "last-man-standing-en", "en"), caption(P + "last-man-standing-en", "en"));
  const asib = api.text2SqlChainModel(fx(P + "star-is-born-en"), "en");
  check("p3e generations by year", asib.generations.map((g) => g.map((c) => c.year)), [["1937"], ["1954", "1976"], ["2018"]]);
  check("p3e links of the 2018 card", asib.generations[2][0].links.map((l) => l.text),
    ["Remake of A Star Is Born (1937)", "Remake of A Star Is Born (1954)", "Remake of A Star Is Born (1976)"]);
  check("p3e anchor and record", [asib.generations[2][0].anchor, asib.generations[2][0].record],
    [true, { ID_MOVIE: 332562, MOVIE_TITLE: "A Star Is Born", POSTER_PATH: "/wrFpXMNBRj2PBiN4Z5kix51XaIZ.jpg" }]);
  const lms = api.text2SqlChainModel(fx(P + "last-man-standing-en"), "en");
  check("p3e source work card", [lms.generations[0][0].badge, lms.generations[0][0].record.ID_SOURCE_WORK, Boolean(lms.generations[0][0].record.WIKIPEDIA_IMAGE_PATH)],
    ["Book", 6848, true]);
  check("p3e links across forms", lms.generations.map((g) => g[0].links.map((l) => l.text)),
    [[], ["Adapted from Red Harvest"], ["Remake of Yojimbo"]]);
  const fistFr = api.text2SqlChainModel(fx(P + "fistful-fr"), "fr");
  check("p3e French links and badges", [fistFr.generations[0][0].badge, fistFr.generations[2][0].links.map((l) => l.text)],
    ["Livre", ["Adaptation de La Moisson rouge", "Remake du Garde du corps"]]);
  const samFr = api.text2SqlChainModel(fx(P + "seven-samurai-fr"), "fr");
  check("p3e series badge fr", samFr.generations[1].map((c) => c.badge), ["Film", "Série"]);
  const ring = api.text2SqlChainModel(fx(P + "ring-hand-en"), "en");
  check("p3e a loop in the data", ring.generations[0][0].links, [{ text: "Remake of The Dog (a loop in the data)", cycle: true }]);
  check("p3e French elision and contraction", [api.text2SqlFrDe("Une étoile est née"), api.text2SqlFrDe("Le Garde du corps"),
    api.text2SqlFrDe("Les Sept Samouraïs"), api.text2SqlFrA("Les Sept Mercenaires"), api.text2SqlFrDe("Dracula")],
    ["d'Une étoile est née", "du Garde du corps", "des Sept Samouraïs", "aux Sept Mercenaires", "de Dracula"]);
  check("p3e no chain facts, no model", api.text2SqlChainModel(fx("lotc-share-hbo-type-en"), "en"), null);
  check("p3e no chain facts, no sentence", api.text2SqlChainSummary(fx("lotc-share-hbo-type-en"), { lang: "en" }), "");
  check("p3e chips", api.text2SqlChipOptionsLotC(fx(P + "departed-en")), ["chain", "card-grid", "table"]);
  check("p3e labels", [api.text2SqlRepresentationLabel("chain", "en"), api.text2SqlRepresentationLabel("chain", "fr")], ["Lineage", "Filiation"]);
  check("view: as a lineage", view("show it as a lineage"), "lineage");
  check("view: en filiation", view("Montre-la en filiation"), "lineage");
  check("view: the remake lineage of a film is a search", view("the remake lineage of Cape Fear"), "");
  check("view to rep: lineage", api.text2SqlRepresentationForView("lineage", fx(P + "red-harvest-en").representation_options), "chain");
  check("view to rep: lineage not offered", api.text2SqlRepresentationForView("lineage", fx("lotc-share-hbo-type-en").representation_options), "");
  check("reply lineage fr", api.text2SqlRequestedViewReply({ ok: true, representation: "chain", view: "lineage" }, "fr"), "Voici la filiation.");
}

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
