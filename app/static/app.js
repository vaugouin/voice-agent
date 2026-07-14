const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const microphoneToggleButton = document.querySelector("#microphoneToggleButton");
const lookToggleButton = document.querySelector("#lookToggleButton");
const panel = document.querySelector(".panel");
const appTitle = document.querySelector(".appHeader h1");
const historyBackButton = document.querySelector("#historyBackButton");
const historyForwardButton = document.querySelector("#historyForwardButton");
const questionInput = document.querySelector("#questionInput");
const submitQuestionButton = document.querySelector("#submitQuestionButton");
const newConversationButton = document.querySelector("#newConversationButton");
const shortcutToast = document.querySelector("#shortcutToast");
const shortcutToastIcon = document.querySelector("#shortcutToastIcon");
const shortcutToastLabel = document.querySelector("#shortcutToastLabel");
const appMenuButton = document.querySelector("#appMenuButton");
const appMenuBackdrop = document.querySelector("#appMenuBackdrop");
const appMenuDrawer = document.querySelector("#appMenuDrawer");
const appMenuTitle = document.querySelector("#appMenuTitle");
const appMenuBackButton = document.querySelector("#appMenuBackButton");
const appMenuCloseButton = document.querySelector("#appMenuCloseButton");
const appMenuIndexScreen = document.querySelector("#appMenuIndexScreen");
const appMenuSettingsScreen = document.querySelector("#appMenuSettingsScreen");
const appMenuAboutScreen = document.querySelector("#appMenuAboutScreen");
const appMenuSettingsButton = document.querySelector("#appMenuSettingsButton");
const appMenuAboutButton = document.querySelector("#appMenuAboutButton");
const spokenSubtitlesMenuToggle = document.querySelector("#spokenSubtitlesMenuToggle");
const userTranscriptSubtitlesMenuToggle = document.querySelector("#userTranscriptSubtitlesMenuToggle");
const statusText = document.querySelector("#statusText");
const statusDot = document.querySelector("#statusDot");
const logEl = document.querySelector("#log");
const remoteAudio = document.querySelector("#remoteAudio");
const resultsPanel = document.querySelector("#resultsPanel");
const resultsContent = document.querySelector("#resultsContent");
const resultsLoader = document.querySelector("#resultsLoader");
const loadMoreButton = document.querySelector("#loadMoreButton");
const resultsEnd = document.querySelector("#resultsEnd");
const subtitleOverlay = document.querySelector("#subtitleOverlay");
const userSubtitleOverlay = document.querySelector("#userSubtitleOverlay");
const queryDetailsDock = document.createElement("div");
queryDetailsDock.id = "queryDetailsDock";
queryDetailsDock.className = "queryDetailsDock";
queryDetailsDock.hidden = true;

// Launch showcase: an auto-scrolling wall of sample questions and their result
// previews, shown only at launch while there is no user query. Lives in its own
// container (outside #resultsPanel) so it does not trigger compact results mode and
// keeps the header/controls visible.
const launchShowcase = document.createElement("section");
launchShowcase.id = "launchShowcase";
launchShowcase.className = "launchShowcase";
launchShowcase.hidden = true;
{
  const statusRow = document.querySelector(".status");
  if (statusRow && statusRow.parentNode) {
    statusRow.parentNode.insertBefore(launchShowcase, statusRow.nextSibling);
  } else {
    panel.append(launchShowcase);
  }
}
let launchShowcaseRaf = null;
let launchShowcaseDismissed = false;
let launchShowcaseData = null;
let launchShowcaseLoading = false;
let showcaseResizeReflowBound = false; // VOICE-AGENT-074: window-resize re-flow bound once
let launchShowcaseLoadPromise = null;

const launchSplash = document.createElement("section");
launchSplash.id = "launchSplash";
launchSplash.className = "launchSplash";
launchSplash.setAttribute("aria-label", "Launch screen");
launchSplash.setAttribute("role", "status");
launchSplash.tabIndex = -1;
launchSplash.hidden = true;
document.body.append(launchSplash);
let launchSplashHasRun = false;
let launchSplashActive = false;
let launchSplashDone = false;
let launchSplashSkipped = false;
let launchSplashHoldTimer = null;
let launchSplashHoldResolver = null;

let pc;
let dc;
let localStream;
let localAudioTrack;
let sessionRunning = false;
let textChatInFlight = false;
let dictationActive = false;
let dictationTranscribing = false;
let dictationStream;
let dictationRecorder;
let dictationChunks = [];
let dictationMimeType = "";
let dictationStopReason = "";
let dictationDiscard = false;
let dictationRecordStartedAt = 0;
let dictationMaxTimer = null;
let dictationAudioContext = null;
let dictationAnalyser = null;
let dictationAnimationFrame = null;
let dictationSilenceStartedAt = null;
let dictationSpeechDetected = false;
let dictationGeneration = 0;
let dictationAbortController = null;
let textChatAbortController = null;
let textChatGeneration = 0;
let subtitleTimer = null;
let userSubtitleTimer = null;
let subtitleQueue = [];
let activeSpokenCardIndex = null;
// VOICE-AGENT-085: page-scoped counter that assigns a unique `data-result-index` to
// highlightable detail-page rail cards (recommendations, similar, collection, cast…),
// so the spoken-card highlight works on an entity detail page the same way it does on a
// search result grid. Reset at the start of each detail render.
let detailSpokenCardIndexCounter = 0;
let assistantSpokenHighlightBuffer = "";
let spokenAudioHighlightTimer = null;
let spokenAudioHighlightCues = [];
let spokenAudioHighlightCueKeys = new Set();
let spokenAudioHighlightPlaying = false;
let spokenAudioHighlightStartedAt = 0;
let structuredCardFocusActive = false;
let spokenSubtitlesActive = false;
let userTranscriptSubtitlesActive = false;
let realtimeSpokenSubtitleBuffer = "";
let realtimeSpokenSubtitleChunks = [];
let realtimeSpokenSubtitleIndex = 0;
let realtimeSpokenSubtitlePlaying = false;
let realtimeSpokenSubtitleStartedAt = 0;
let realtimeSpokenSubtitleFinal = false;
let realtimeSpokenSubtitleAudioStopped = false;
let realtimeSpokenSubtitleLastText = "";
let realtimeSpokenSubtitleSawDelta = false;
let pendingRealtimeTextTurns = [];
let appMenuPreviouslyFocused = null;
let appMenuScreenReturnFocus = null;
const handledCallIds = new Set();
let currentSearchState = null;
let currentDetailState = null;
let loadingDetailCollections = new Set();
let activeUiLanguage = "en";
let loadingMore = false;
let autoPagesLoaded = 0;
let pageHistory = [];
let pageHistoryIndex = -1;
let restoringHistory = false;
// VOICE-AGENT-082: remember the backdrop-slideshow frame per page (like the scroll offset).
// activeBackdropViewer exposes the on-screen viewer's live index for save-time; the pending
// index is set from a history entry just before its page is re-rendered and consumed by the
// next buildBackdropSwipeViewer.
let activeBackdropViewer = null;
let pendingBackdropSlideshowIndex = null;
let currentPageViewSignature = "";
const maxAutoPages = 4;
const TMDB_FRONT_BASE_URL = "https://www.vaugouin.com/tmdb";
const SYNTHETIC_IMAGES_BASE_URL = "https://www.vaugouin.com/synthetic-images";
const DETAIL_RAIL_AUTO_LOAD_THRESHOLD_PX = 360;
// MUST match STYLE_VERSION in the synthetic-images repo's .env on the VPS: padded-logo master
// URLs are sha256("<class>:<id>|logo-pad|<style version>")[:32], so a style bump changes every
// URL. A stale value here degrades gracefully to the raw TMDb logo (the probe just 404s).
const SYNTHETIC_STYLE_VERSION = "v1";
const CONTEXT_STORAGE_KEY = "voice-agent-context-v1";
const STRUCTURED_CARD_FOCUS_TOOL = "focus_result_card";
// VOICE-AGENT-085: the spoken-card highlight targets two card families that never
// coexist in `#resultsContent` — search grid cards (`.search-poster-card`) and entity
// detail rail cards (`.detailVisualCard`). One selector covers both so the matcher,
// count, and highlight apply/clear helpers work identically in search and page mode.
const SPOKEN_CARD_SELECTOR = ".search-poster-card[data-result-index], .detailVisualCard[data-result-index]";
const SPOKEN_CARD_ACTIVE_SELECTOR = ".search-poster-card.isSpokenActive, .detailVisualCard.isSpokenActive";
const SPOKEN_CARD_GROUP_SELECTOR = ".search-poster-card-grid, .detailVisualRail";
const spokenCardSelectorForIndex = (index) =>
  `.search-poster-card[data-result-index="${index}"], .detailVisualCard[data-result-index="${index}"]`;
const SPOKEN_CARD_NUMBER_INDEX = Object.freeze({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
});
const maxContextItems = 10;
const defaultWikipediaMaxSections = 4;
const defaultWikipediaMaxChars = 1200;
const verboseWikipediaMaxSections = 10;
const verboseWikipediaMaxChars = 3000;
const verboseDetailTriggerPhrases = [
  "tell me more",
  "more detail",
  "more details",
  "in detail",
  "full story",
  "whole story",
  "go deeper",
  "longer answer",
  "more complete",
  "more verbose",
  "elaborate",
  "dis m en plus",
  "raconte m en plus",
  "plus de detail",
  "plus de details",
  "en detail",
  "histoire complete",
  "reponse plus longue",
];
const DETAIL_TOOL_ENTITIES = {
  get_movie_detail: "movie",
  get_series_detail: "serie",
  get_season_detail: "season",
  get_episode_detail: "episode",
  get_person_detail: "person",
  get_company_detail: "company",
  get_network_detail: "network",
  get_collection_detail: "collection",
  get_topic_detail: "topic",
  get_list_detail: "list",
  get_movement_detail: "movement",
  get_technical_detail: "technical",
  get_genre_detail: "genre",
  get_group_detail: "group",
  get_death_detail: "death",
  get_award_detail: "award",
  get_nomination_detail: "nomination",
  get_location_detail: "location",
};
const DETAIL_ENTITY_TO_TOOL = Object.fromEntries(
  Object.entries(DETAIL_TOOL_ENTITIES).map(([toolName, entity]) => [entity, toolName])
);
let activeResponseId = null;
let activeAudioResponseId = null;
let toolCallsInFlight = 0;
let awaitingToolResponse = false;
let lastUserTranscript = "";
let lastToolArgs = null;
let lastToolOutput = null;
let pendingReconnectResume = null;
const inputTranscripts = new Map();
let pendingResponseFallbackTimer = null;
let microphoneEnableTimer = null;
let reconnectTimer = null;
let manuallyStopped = false;
let userMicrophoneOpen = true;
let userLookOpen = false;
let connectionGeneration = 0;
let reconnectAttempts = 0;
let reconnectInProgress = false;
let wakeLock = null;
const maxReconnectAttempts = 5;
const disconnectGracePeriodMs = 8000;
let disconnectWatchdogTimer = null;
let keepAliveInterval = null;
let keepAliveWorker = null;
const keepAliveIntervalMs = 2000;
const dictationSilenceThreshold = 0.02;
const dictationSilenceMs = 1200;
const dictationNoSpeechMs = 10000;
const dictationMaxMs = 30000;
const launchSplashHoldMs = 1500;
const launchSplashHandoffMs = 620;
const launchSplashHooks = {
  en: [
    "Talk to the movies.",
    "Ask cinema anything.",
    "Every film. One conversation.",
    "Say it. See it.",
    "Ask. And watch it answer.",
    "Your film questions, out loud.",
    "Skip the search box.",
    "A film buff you can talk to.",
    "Posters, not paragraphs.",
    "Cinema, on speaking terms.",
    "What should I watch? Just ask.",
    "Recommendations, out loud.",
    "Tell it what you love.",
    "Your cinema connoisseur, on call.",
  ],
  fr: [
    "Parlez aux films.",
    "Demandez tout au cinéma.",
    "Tous les films. Une seule conversation.",
    "Dites-le. Voyez-le.",
    "Demandez. Et regardez-le répondre.",
    "Vos questions cinéma, à voix haute.",
    "Oubliez la barre de recherche.",
    "Un cinéphile à qui parler.",
    "Des affiches, pas des paragraphes.",
    "Le cinéma, à portée de voix.",
    "Que regarder ? Demandez, tout simplement.",
    "Des recommandations, à voix haute.",
    "Dites-lui ce que vous aimez.",
    "Votre connaisseur cinéma, à la demande.",
  ],
};

let retainedContext = [];

function appUrl(path) {
  return new URL(path, new URL(".", window.location.href)).toString();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const FRENCH_MARKERS = new Set([
  "acteur",
  "acteurs",
  "actrice",
  "actrices",
  "aimerais",
  "avec",
  "ce",
  "ces",
  "cet",
  "cette",
  "cherche",
  "combien",
  "comment",
  "dans",
  "de",
  "des",
  "dis",
  "donne",
  "donnez",
  "du",
  "elle",
  "elles",
  "est",
  "fais",
  "fait",
  "film",
  "films",
  "francais",
  "francaise",
  "il",
  "ils",
  "je",
  "la",
  "le",
  "les",
  "liste",
  "lister",
  "ma",
  "me",
  "meilleur",
  "meilleure",
  "meilleures",
  "meilleurs",
  "mes",
  "moi",
  "moins",
  "montre",
  "montrez",
  "nous",
  "par",
  "peux",
  "plus",
  "pour",
  "pourquoi",
  "pouvez",
  "quel",
  "quelle",
  "quelles",
  "quels",
  "que",
  "qui",
  "quoi",
  "realisateur",
  "realisatrice",
  "recherche",
  "reponds",
  "sans",
  "serie",
  "series",
  "ses",
  "sont",
  "sorti",
  "sortie",
  "sorties",
  "sortis",
  "sur",
  "te",
  "toi",
  "ton",
  "tres",
  "tu",
  "un",
  "une",
  "veux",
  "voudrais",
  "vous",
]);
const FRENCH_PHRASES = [
  "donne moi",
  "dis moi",
  "est ce que",
  "en francais",
  "peux tu",
  "qu est ce",
  "quels sont",
  "quelles sont",
  "qui est",
  "reponds en francais",
];

function normalizeUiLanguage(value) {
  const clean = String(value || "en").trim().toLowerCase().replace("_", "-").split("-", 1)[0];
  return clean === "fr" ? "fr" : "en";
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function foldLanguageText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0153/g, "oe")
    .replace(/\u00e6/g, "ae");
}

function normalizedIntentText(value) {
  return foldLanguageText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function isVerboseDetailRequest(value) {
  const clean = normalizedIntentText(value);
  return verboseDetailTriggerPhrases.some((phrase) => clean.includes(phrase));
}

function detectUiLanguageFromText(text) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) {
    return "en";
  }

  const folded = foldLanguageText(raw);
  const spaced = folded.replace(/[^a-z']+/g, " ");
  let score = folded !== raw ? 1 : 0;
  if (/\b[ldjmntsqc]'[a-z]/.test(folded)) {
    score += 1;
  }
  if (FRENCH_PHRASES.some((phrase) => spaced.includes(phrase))) {
    score += 2;
  }
  const markers = new Set((folded.match(/[a-z']+/g) || []).filter((token) => FRENCH_MARKERS.has(token)));
  score += Math.min(3, markers.size);
  return score >= 2 ? "fr" : "en";
}

function currentUiLanguage(args = {}) {
  if (args.ui_language || args.uiLanguage) {
    return normalizeUiLanguage(args.ui_language || args.uiLanguage);
  }
  return normalizeUiLanguage(activeUiLanguage || currentSearchState?.ui_language || "en");
}

function parseUrlBooleanFlag(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const clean = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(clean)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(clean)) {
    return false;
  }
  return null;
}

function structuredCardFocusPreference() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("structuredCardFocus") ?? params.get("structured_card_focus");
  return parseUrlBooleanFlag(value);
}

function structuredCardFocusRequested() {
  return structuredCardFocusPreference() !== false;
}

function structuredCardFocusEnabled() {
  return structuredCardFocusActive && structuredCardFocusRequested();
}

function spokenSubtitlesPreference() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("spokenSubtitles") ?? params.get("spoken_subtitles");
  return parseUrlBooleanFlag(value);
}

function spokenSubtitlesRequested() {
  return spokenSubtitlesPreference() !== false;
}

function spokenSubtitlesEnabled() {
  return spokenSubtitlesActive && spokenSubtitlesRequested();
}

function userTranscriptSubtitlesPreference() {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("userTranscriptSubtitles") ?? params.get("user_transcript_subtitles");
  return parseUrlBooleanFlag(value);
}

function userTranscriptSubtitlesRequested() {
  return userTranscriptSubtitlesPreference() !== false;
}

function userTranscriptSubtitlesEnabled() {
  return userTranscriptSubtitlesActive && userTranscriptSubtitlesRequested();
}

function realtimeSessionUrl() {
  const url = new URL(appUrl("session"));
  const structuredPreference = structuredCardFocusPreference();
  if (structuredPreference !== null) {
    url.searchParams.set("structured_card_focus", structuredPreference ? "1" : "0");
  }
  const spokenSubtitlePreference = spokenSubtitlesPreference();
  if (spokenSubtitlePreference !== null) {
    url.searchParams.set("spoken_subtitles", spokenSubtitlePreference ? "1" : "0");
  }
  const userTranscriptSubtitlePreference = userTranscriptSubtitlesPreference();
  if (userTranscriptSubtitlePreference !== null) {
    url.searchParams.set("user_transcript_subtitles", userTranscriptSubtitlePreference ? "1" : "0");
  }
  return url.toString();
}

function setUrlBooleanPreference(camelName, snakeName, enabled) {
  const url = new URL(window.location.href);
  url.searchParams.set(camelName, enabled ? "1" : "0");
  url.searchParams.delete(snakeName);
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function updateAppMenuToggles() {
  if (spokenSubtitlesMenuToggle) {
    spokenSubtitlesMenuToggle.checked = spokenSubtitlesPreference() === true;
  }
  if (userTranscriptSubtitlesMenuToggle) {
    userTranscriptSubtitlesMenuToggle.checked = userTranscriptSubtitlesPreference() === true;
  }
}

const APP_MENU_SCREEN_TITLES = {
  index: "Menu",
  settings: "Settings",
  about: "About",
};

function appMenuScreenElement(screenName) {
  if (screenName === "settings") {
    return appMenuSettingsScreen;
  }
  if (screenName === "about") {
    return appMenuAboutScreen;
  }
  return appMenuIndexScreen;
}

function appMenuFocusableElements() {
  if (!appMenuDrawer || appMenuDrawer.hidden) {
    return [];
  }
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(appMenuDrawer.querySelectorAll(selector)).filter((element) => {
    return element.getClientRects().length > 0;
  });
}

function focusAppMenuScreen(screenName, fallbackElement = null) {
  if (!appMenuDrawer || appMenuDrawer.hidden) {
    return;
  }
  const screen = appMenuScreenElement(screenName);
  const focusable = appMenuFocusableElements();
  const screenTarget = screen ? focusable.find((element) => screen.contains(element)) : null;
  const focusTarget =
    fallbackElement || screenTarget || (screenName === "index" ? appMenuCloseButton : appMenuBackButton) || appMenuDrawer;
  if (focusTarget && typeof focusTarget.focus === "function") {
    focusTarget.focus({ preventScroll: true });
  }
}

function focusAppMenuStart() {
  if (!appMenuDrawer || appMenuDrawer.hidden) {
    return;
  }
  const currentScreen = appMenuDrawer.dataset.menuScreen || "index";
  if (currentScreen === "index") {
    const focusTarget = appMenuCloseButton || appMenuFocusableElements()[0] || appMenuDrawer;
    if (focusTarget && typeof focusTarget.focus === "function") {
      focusTarget.focus({ preventScroll: true });
    }
    return;
  }
  focusAppMenuScreen(currentScreen);
}

function setAppMenuScreen(screenName, { focus = true, returnFocus = null } = {}) {
  if (!appMenuDrawer) {
    return;
  }
  const nextScreen = APP_MENU_SCREEN_TITLES[screenName] ? screenName : "index";
  const screens = {
    index: appMenuIndexScreen,
    settings: appMenuSettingsScreen,
    about: appMenuAboutScreen,
  };
  Object.entries(screens).forEach(([name, screen]) => {
    if (screen) {
      screen.hidden = name !== nextScreen;
    }
  });
  appMenuDrawer.dataset.menuScreen = nextScreen;
  if (appMenuTitle) {
    appMenuTitle.textContent = APP_MENU_SCREEN_TITLES[nextScreen];
  }
  if (appMenuBackButton) {
    appMenuBackButton.hidden = nextScreen === "index";
  }
  if (nextScreen === "settings") {
    updateAppMenuToggles();
  }
  if (returnFocus) {
    appMenuScreenReturnFocus = returnFocus;
  } else if (nextScreen === "index") {
    appMenuScreenReturnFocus = null;
  }
  if (focus) {
    window.requestAnimationFrame(() => focusAppMenuScreen(nextScreen));
  }
}

function openAppMenuScreen(screenName, triggerElement) {
  setAppMenuScreen(screenName, {
    focus: true,
    returnFocus: triggerElement instanceof HTMLElement ? triggerElement : null,
  });
  clientLog("app_menu_screen_opened", { screen: screenName });
}

// VOICE-AGENT-080: open the App Menu straight to the About screen (credits/attribution).
// Used by the "?" keyboard shortcut and reusable elsewhere.
function openAboutScreen() {
  if (!appMenuAboutScreen) {
    return;
  }
  if (appMenuDrawer && appMenuDrawer.hidden) {
    openAppMenu();
  }
  openAppMenuScreen("about", appMenuButton);
}

function backToAppMenuIndex() {
  const focusTarget =
    appMenuScreenReturnFocus &&
    document.contains(appMenuScreenReturnFocus) &&
    typeof appMenuScreenReturnFocus.focus === "function"
      ? appMenuScreenReturnFocus
      : null;
  setAppMenuScreen("index", { focus: false });
  window.requestAnimationFrame(() => {
    focusAppMenuScreen("index", focusTarget || appMenuSettingsButton || appMenuCloseButton || appMenuDrawer);
  });
  clientLog("app_menu_back");
}

function openAppMenu() {
  if (!appMenuDrawer || !appMenuBackdrop || !appMenuButton) {
    return;
  }
  if (!appMenuDrawer.hidden) {
    focusAppMenuStart();
    return;
  }
  updateAppMenuToggles();
  setAppMenuScreen("index", { focus: false });
  appMenuPreviouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  appMenuBackdrop.hidden = false;
  appMenuDrawer.hidden = false;
  document.body.classList.add("appMenuOpen");
  appMenuButton.setAttribute("aria-expanded", "true");
  window.requestAnimationFrame(focusAppMenuStart);
  clientLog("app_menu_opened");
}

function closeAppMenu({ restoreFocus = true } = {}) {
  if (!appMenuDrawer || appMenuDrawer.hidden) {
    return;
  }
  appMenuDrawer.hidden = true;
  if (appMenuBackdrop) {
    appMenuBackdrop.hidden = true;
  }
  document.body.classList.remove("appMenuOpen");
  if (appMenuButton) {
    appMenuButton.setAttribute("aria-expanded", "false");
  }
  setAppMenuScreen("index", { focus: false });
  if (
    restoreFocus &&
    appMenuPreviouslyFocused &&
    document.contains(appMenuPreviouslyFocused) &&
    typeof appMenuPreviouslyFocused.focus === "function"
  ) {
    appMenuPreviouslyFocused.focus({ preventScroll: true });
  }
  appMenuPreviouslyFocused = null;
  clientLog("app_menu_closed");
}

function handleAppMenuKeydown(event) {
  if (!appMenuDrawer || appMenuDrawer.hidden) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeAppMenu();
    return;
  }
  if (event.key !== "Tab") {
    return;
  }

  const focusable = appMenuFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    appMenuDrawer.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!appMenuDrawer.contains(document.activeElement)) {
    event.preventDefault();
    first.focus({ preventScroll: true });
    return;
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function setAppMenuBooleanSetting(toggle, camelName, snakeName, settingName) {
  if (!toggle) {
    return;
  }
  const enabled = toggle.checked;
  setUrlBooleanPreference(camelName, snakeName, enabled);
  updateAppMenuToggles();
  clientLog("app_menu_setting_changed", { setting: settingName, enabled });
}

function setConversationActive(active) {
  newConversationButton.hidden = !active;
}

function syncResultsMode() {
  panel.classList.toggle("resultsMode", !resultsPanel.hidden);
}

const resultsPanelObserver = new MutationObserver(syncResultsMode);
resultsPanelObserver.observe(resultsPanel, { attributes: true, attributeFilter: ["hidden"] });
syncResultsMode();

function clearQueryDetailsDock() {
  queryDetailsDock.hidden = true;
  queryDetailsDock.replaceChildren();
  document.querySelectorAll(".queryDetailsToggle").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
    button.textContent = "▶";
  });
}

function buildQueryDetailsToggle(detailsText) {
  if (!detailsText) {
    return null;
  }

  const button = document.createElement("button");
  button.className = "queryDetailsToggle";
  button.type = "button";
  button.setAttribute("aria-label", "Toggle query details");
  button.setAttribute("aria-expanded", "false");
  button.textContent = "▶";
  button.addEventListener("click", () => {
    const shouldOpen = queryDetailsDock.hidden;
    document.querySelectorAll(".queryDetailsToggle").forEach((item) => {
      item.setAttribute("aria-expanded", "false");
      item.textContent = "▶";
    });
    queryDetailsDock.replaceChildren();
    if (shouldOpen) {
      const pre = document.createElement("pre");
      pre.textContent = detailsText;
      queryDetailsDock.append(pre);
      queryDetailsDock.hidden = false;
      button.setAttribute("aria-expanded", "true");
      button.textContent = "▲";
    } else {
      queryDetailsDock.hidden = true;
      button.textContent = "▶";
    }
  });
  return button;
}

function cloneHistoryValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function stablePageViewStringify(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stablePageViewStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stablePageViewStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function pageViewSignature(kind, payload) {
  return `${kind}:${stablePageViewStringify(payload)}`;
}

function firstDetailArgValue(args = {}, keys = []) {
  for (const key of keys) {
    const value = args[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
}

function detailArgsSignature(args = {}) {
  return {
    id: firstDetailArgValue(args, [
      "id",
      "wikidata_id",
      "ID_MOVIE",
      "ID_SERIE",
      "ID_PERSON",
      "ID_COMPANY",
      "ID_NETWORK",
      "ID_T2S_COLLECTION",
      "ID_TOPIC",
      "ID_T2S_LIST",
      "ID_MOVEMENT",
      "ID_TECHNICAL",
      "ID_GENRE",
      "ID_GROUP",
      "ID_DEATH",
      "ID_AWARD",
      "ID_NOMINATION",
      "ID_WIKIDATA",
    ]),
    id_serie: firstDetailArgValue(args, ["id_serie", "ID_SERIE"]),
    season_number: firstDetailArgValue(args, ["season_number", "SEASON_NUMBER"]),
    episode_number: firstDetailArgValue(args, ["episode_number", "EPISODE_NUMBER"]),
    ui_language: normalizeUiLanguage(args.ui_language || activeUiLanguage),
  };
}

function recordIdentitySignature(record = {}) {
  const request = detailRequestFromRecord(record);
  if (request) {
    return {
      toolName: request.toolName,
      ...detailArgsSignature({ ...request, ui_language: activeUiLanguage }),
    };
  }
  const idKeys = [
    "ID_MOVIE",
    "ID_SERIE",
    "ID_SEASON",
    "ID_EPISODE",
    "ID_PERSON",
    "ID_COMPANY",
    "ID_NETWORK",
    "ID_T2S_COLLECTION",
    "ID_TOPIC",
    "ID_T2S_LIST",
    "ID_MOVEMENT",
    "ID_TECHNICAL",
    "ID_GENRE",
    "ID_GROUP",
    "ID_DEATH",
    "ID_AWARD",
    "ID_NOMINATION",
    "ID_WIKIDATA",
  ];
  const ids = {};
  idKeys.forEach((key) => {
    if (record[key] !== null && record[key] !== undefined && String(record[key]).trim() !== "") {
      ids[key] = record[key];
    }
  });
  return {
    content_type: record.CONTENT_TYPE || "",
    title: titleForRecord(record),
    ids,
  };
}

function searchRecordSignature(record = {}) {
  const cardSpec = cardSpecFromRecord(record);
  if (cardSpec) {
    return {
      identity: recordIdentitySignature(record),
      title: cardSpec.title || "",
      subtitle: cardSpec.subtitle || "",
      imageUrl: cardSpec.imageUrl || "",
      meta: cardSpec.meta || [],
      rating: cardSpec.rating ?? "",
      overview: cardSpec.overview || "",
    };
  }
  return {
    identity: recordIdentitySignature(record),
    values: Object.fromEntries(
      Object.entries(record)
        .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "")
        .map(([key, value]) => [key, formatScalarValue(key, value)])
        .filter(([, value]) => value)
    ),
  };
}

function searchPageSignature(output = {}, args = {}, upstream = null, rows = null) {
  const cleanUpstream = upstream && typeof upstream === "object" ? upstream : output.upstream || {};
  const cleanRows = Array.isArray(rows)
    ? rows
    : Array.isArray(cleanUpstream.result)
      ? cleanUpstream.result
      : Array.isArray(output.rows)
        ? output.rows
        : [];
  const uiLanguage = normalizeUiLanguage(
    args.ui_language ||
    cleanUpstream.ui_language ||
    detectUiLanguageFromText(args.query || cleanUpstream.question || lastUserTranscript)
  );
  return pageViewSignature("search", {
    query: args.query || cleanUpstream.question || "",
    ui_language: uiLanguage,
    page: Number(output.page || cleanUpstream.page || args.page || 1),
    question_hashed: output.question_hashed || cleanUpstream.question_hashed || args.question_hashed || "",
    answer: output.answer || cleanUpstream.answer || "",
    error: output.error || cleanUpstream.error || "",
    rows: cleanRows.map((item) => searchRecordSignature(item?.data || item || {})),
  });
}

function currentSearchDomSignature() {
  const cards = Array.from(resultsContent.querySelectorAll(".search-poster-card")).map((card) => ({
    title: card.dataset.resultTitle || "",
    titleKey: card.dataset.resultTitleKey || "",
    subtitle: card.dataset.resultSubtitle || "",
    detailTool: card.dataset.resultDetailTool || "",
    detailId: card.dataset.resultDetailId || "",
  }));
  return pageViewSignature("search-dom", {
    query: currentSearchState?.query || "",
    ui_language: currentSearchState?.ui_language || activeUiLanguage,
    page: currentSearchState?.page || 1,
    question_hashed: currentSearchState?.question_hashed || "",
    cards,
  });
}

function detailRecordSignature(record = {}) {
  const ignoredKeys = new Set(["wikipedia_content"]);
  const compact = {};
  Object.keys(record || {})
    .sort()
    .forEach((key) => {
      if (!ignoredKeys.has(key)) {
        compact[key] = record[key];
      }
    });
  return {
    identity: recordIdentitySignature(record),
    title: titleForRecord(record),
    detail: compact,
  };
}

function entityDetailPageSignature(output = {}, args = {}) {
  const entity = output.entity || DETAIL_TOOL_ENTITIES[args.toolName] || "";
  const toolName = args.toolName || DETAIL_ENTITY_TO_TOOL[entity] || "";
  const uiLanguage = normalizeUiLanguage(output.ui_language || args.ui_language || activeUiLanguage);
  const detail = output.detail && typeof output.detail === "object" ? output.detail : null;
  const detailForSignature = detail
    ? {
        ...detail,
        ID_WIKIDATA: detail.ID_WIKIDATA || args.ID_WIKIDATA || args.wikidata_id,
      }
    : null;
  return pageViewSignature("entity-detail", {
    toolName,
    entity,
    args: detailArgsSignature({ ...args, ui_language: uiLanguage }),
    error: output.error || "",
    empty: detail ? "" : "1",
    detail: detailForSignature ? detailRecordSignature(detailForSignature) : null,
  });
}

function currentEntityDetailPageSignature() {
  if (!currentDetailState) {
    return "";
  }
  return entityDetailPageSignature(currentDetailState.output, currentDetailState.args);
}

function isSameRenderedEntityDetail(output = {}, args = {}) {
  const signature = entityDetailPageSignature(output, args);
  return Boolean(
    isSameRenderedPageView(signature) ||
    (currentDetailState && !resultsPanel.hidden && currentEntityDetailPageSignature() === signature)
  );
}

function recordDetailPageSignature(record = {}, uiLanguage = activeUiLanguage) {
  return pageViewSignature("record-detail", {
    ui_language: normalizeUiLanguage(uiLanguage),
    record: detailRecordSignature(record),
  });
}

function isSameRenderedPageView(signature) {
  return Boolean(
    signature &&
    currentPageViewSignature === signature &&
    !resultsPanel.hidden &&
    resultsContent.childElementCount
  );
}

function markRenderedPageView(signature) {
  currentPageViewSignature = signature || "";
}

function clearRenderedPageViewSignature() {
  currentPageViewSignature = "";
}

function matchesCurrentSearchRequest(query, uiLanguage = "") {
  return Boolean(
    currentPageViewSignature &&
    !resultsPanel.hidden &&
    currentSearchState &&
    String(currentSearchState.query || "") === String(query || "") &&
    normalizeUiLanguage(currentSearchState.ui_language || activeUiLanguage) === normalizeUiLanguage(uiLanguage || activeUiLanguage)
  );
}

function matchesCurrentDetailRequest(toolName, args = {}) {
  if (!currentPageViewSignature || resultsPanel.hidden || !currentDetailState) {
    return false;
  }
  const currentArgs = detailArgsSignature(currentDetailState.args || {});
  const nextArgs = detailArgsSignature(args || {});
  return (
    currentDetailState.toolName === toolName &&
    stablePageViewStringify(currentArgs) === stablePageViewStringify(nextArgs)
  );
}

function updateHistoryButtons() {
  historyBackButton.disabled = pageHistoryIndex <= 0;
  historyForwardButton.disabled = pageHistoryIndex < 0 || pageHistoryIndex >= pageHistory.length - 1;
}

function pushPageHistory(entry) {
  if (restoringHistory) {
    return;
  }
  pageHistory = pageHistory.slice(0, pageHistoryIndex + 1);
  pageHistory.push(cloneHistoryValue(entry));
  pageHistoryIndex = pageHistory.length - 1;
  updateHistoryButtons();
}

async function renderHistoryEntry(entry) {
  if (!entry) {
    return;
  }
  restoringHistory = true;
  try {
    if (entry.type === "search") {
      await renderText2SqlResult(entry.output, entry.args, { skipHistory: true });
    } else if (entry.type === "recordDetail") {
      await showRecordDetail(entry.record, { skipHistory: true, ui_language: entry.ui_language });
    } else if (entry.type === "entityDetail") {
      renderEntityDetailOutput(entry.output, entry.args, { skipHistory: true });
    }
  } finally {
    restoringHistory = false;
    updateHistoryButtons();
  }
}

async function goHistory(direction) {
  const nextIndex = pageHistoryIndex + direction;
  if (nextIndex < 0 || nextIndex >= pageHistory.length) {
    return;
  }
  // Remember where we are on the page we are leaving, so the reverse move restores it too.
  saveCurrentScrollPosition();
  pageHistoryIndex = nextIndex;
  updateHistoryButtons();
  const entry = pageHistory[pageHistoryIndex];
  // VOICE-AGENT-082: hand the saved backdrop frame to the next buildBackdropSwipeViewer.
  pendingBackdropSlideshowIndex = typeof entry.slideshowIndex === "number" ? entry.slideshowIndex : null;
  await renderHistoryEntry(entry);
  pendingBackdropSlideshowIndex = null; // clear if the restored page had no backdrop to consume it
  restoreScrollPosition(entry);
}

function clearPageHistory() {
  pageHistory = [];
  pageHistoryIndex = -1;
  updateHistoryButtons();
}

// VOICE-AGENT-077: the whole document scrolls (no inner overflow container), so a
// detail/search page keeps its scroll offset in its own history entry. Save it just
// before the current page is torn down (a new render replaces #resultsContent) so the
// Back/Forward buttons can put the user back where the rail they clicked from was.
function saveCurrentScrollPosition() {
  if (restoringHistory || pageHistoryIndex < 0) {
    return;
  }
  const entry = pageHistory[pageHistoryIndex];
  if (entry) {
    entry.scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    // VOICE-AGENT-082: also remember the current backdrop-slideshow frame, if this page has one.
    entry.slideshowIndex = activeBackdropViewer ? activeBackdropViewer.getIndex() : undefined;
  }
}

// VOICE-AGENT-082: read (and clear) the pending backdrop frame set from a restored history
// entry, clamped to the images actually available on the re-rendered page.
function consumePendingBackdropIndex(count) {
  const pending = pendingBackdropSlideshowIndex;
  pendingBackdropSlideshowIndex = null;
  if (typeof pending !== "number" || !Number.isFinite(pending) || count <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, Math.floor(pending)), count - 1);
}

function restoreScrollPosition(entry) {
  const target = entry && typeof entry.scrollY === "number" ? entry.scrollY : 0;
  // Restore after layout settles. Double rAF covers the reflow once the restored
  // cards/images are in the DOM; the offset is clamped by the browser if the page is
  // shorter than expected, which is the best we can do without measuring every image.
  window.requestAnimationFrame(() => {
    window.scrollTo(0, target);
    window.requestAnimationFrame(() => window.scrollTo(0, target));
  });
}

function appendCurrentSearchHistory(output, args) {
  const current = pageHistory[pageHistoryIndex];
  if (!current || current.type !== "search") {
    return;
  }
  const currentOutput = cloneHistoryValue(current.output) || {};
  const nextOutput = cloneHistoryValue(output) || {};
  const currentUpstream = currentOutput.upstream && typeof currentOutput.upstream === "object"
    ? currentOutput.upstream
    : null;
  const nextUpstream = nextOutput.upstream && typeof nextOutput.upstream === "object"
    ? nextOutput.upstream
    : null;
  const currentRows = currentUpstream && Array.isArray(currentUpstream.result)
    ? currentUpstream.result
    : Array.isArray(currentOutput.rows)
      ? currentOutput.rows
      : [];
  const nextRows = nextUpstream && Array.isArray(nextUpstream.result)
    ? nextUpstream.result
    : Array.isArray(nextOutput.rows)
      ? nextOutput.rows
      : [];

  if (currentUpstream) {
    currentUpstream.result = [...currentRows, ...nextRows];
  } else {
    currentOutput.rows = [...currentRows, ...nextRows];
  }

  currentOutput.page = nextOutput.page || args.page || currentOutput.page;
  currentOutput.has_more = Boolean(nextOutput.has_more);
  currentOutput.question_hashed = currentOutput.has_more
    ? nextOutput.question_hashed || args.question_hashed || currentOutput.question_hashed || null
    : null;
  pageHistory[pageHistoryIndex] = {
    type: "search",
    output: currentOutput,
    args: {
      ...current.args,
      page: currentOutput.page,
      question_hashed: currentOutput.question_hashed,
    },
  };
}

function reusableText2SqlQuestionHash(output, upstream, args, rows, rowsPerPage) {
  const questionHashed = output.question_hashed || upstream.question_hashed || args.question_hashed || null;
  const hasSql = Boolean(output.sql_query || upstream.sql_query);
  const inferredHasMore = rowsPerPage && rows.length === rowsPerPage;
  const hasMore = Boolean(
    questionHashed &&
    hasSql &&
    (output.has_more ?? upstream.has_more ?? inferredHasMore)
  );
  return {
    question_hashed: hasMore ? questionHashed : null,
    has_more: hasMore,
  };
}

function resetDetailState() {
  currentDetailState = null;
  loadingDetailCollections = new Set();
  // VOICE-AGENT-082: the on-screen backdrop viewer is about to be torn down; a page without
  // one leaves this null so save-time reads no stale index.
  activeBackdropViewer = null;
}

function baseDetailArgs(args = {}) {
  const { collection: _collection, page: _page, rows_per_page: _rowsPerPage, ...base } = args || {};
  return base;
}

function setCurrentDetailState(output, args, container, detail) {
  const entity = output?.entity || DETAIL_TOOL_ENTITIES[args?.toolName] || "";
  const toolName = args?.toolName || DETAIL_ENTITY_TO_TOOL[entity] || "";
  const uiLanguage = normalizeUiLanguage(output?.ui_language || args?.ui_language || activeUiLanguage);
  const cleanArgs = {
    ...baseDetailArgs(args),
    ui_language: uiLanguage,
  };

  currentDetailState = {
    toolName,
    entity,
    output: {
      ...(output || {}),
      ui_language: uiLanguage,
      detail,
    },
    args: cleanArgs,
    container,
    detail,
    ui_language: uiLanguage,
    collectionErrors: {},
  };
}

function updateCurrentDetailHistory() {
  if (!currentDetailState || restoringHistory || pageHistoryIndex < 0) {
    return;
  }

  const current = pageHistory[pageHistoryIndex];
  if (!current || (current.type !== "entityDetail" && current.type !== "recordDetail")) {
    return;
  }

  pageHistory[pageHistoryIndex] = {
    type: "entityDetail",
    output: cloneHistoryValue(currentDetailState.output),
    args: cloneHistoryValue(currentDetailState.args),
  };
}

function detailCollectionLoadedCount(collectionName) {
  const rows = currentDetailState?.detail?.[collectionName];
  return Array.isArray(rows) ? rows.length : 0;
}

function detailCollectionPagination(collectionName) {
  const pagination = currentDetailState?.detail?.pagination;
  const meta = pagination && typeof pagination === "object" ? pagination[collectionName] : null;
  if (!meta || typeof meta !== "object") {
    return null;
  }

  const total = Math.max(0, Number(meta.total || 0));
  const page = Math.max(1, Number(meta.page || 1));
  const rowsPerPage = Math.max(0, Number(meta.rows_per_page || 0));
  const returned = Math.max(0, Number(meta.returned || 0));
  const loaded = Math.min(total || detailCollectionLoadedCount(collectionName), detailCollectionLoadedCount(collectionName) || returned);
  return { total, page, rowsPerPage, returned, loaded };
}

async function loadDetailCollectionPage(collectionName) {
  const state = currentDetailState;
  const meta = detailCollectionPagination(collectionName);
  if (!state?.toolName || !collectionName || !meta || meta.total <= meta.loaded || loadingDetailCollections.has(collectionName)) {
    return;
  }

  loadingDetailCollections.add(collectionName);
  delete state.collectionErrors[collectionName];
  updateDetailRailHeader(collectionName);

  try {
    const output = await callEntityDetail(state.toolName, {
      ...state.args,
      collection: collectionName,
      page: meta.page + 1,
      rows_per_page: meta.rowsPerPage || undefined,
    });
    if (currentDetailState !== state) {
      return;
    }

    const pageDetail = output.detail && typeof output.detail === "object" ? output.detail : {};
    const pageRows = Array.isArray(pageDetail[collectionName]) ? pageDetail[collectionName] : [];
    const existingRows = Array.isArray(state.detail[collectionName]) ? state.detail[collectionName] : [];
    state.detail[collectionName] = [...existingRows, ...pageRows];
    const pagePagination = pageDetail.pagination && typeof pageDetail.pagination === "object"
      ? pageDetail.pagination[collectionName]
      : null;
    state.detail.pagination = {
      ...(state.detail.pagination && typeof state.detail.pagination === "object" ? state.detail.pagination : {}),
      [collectionName]: pagePagination || {
        total: meta.total,
        page: meta.page + 1,
        rows_per_page: meta.rowsPerPage,
        returned: pageRows.length,
      },
    };
    state.output.detail = state.detail;
    appendDetailRailItems(collectionName, pageRows);
    updateCurrentDetailHistory();
  } catch (error) {
    if (currentDetailState === state) {
      state.collectionErrors[collectionName] = error.message;
      log("detail collection load error", { collection: collectionName, error: error.message });
    }
  } finally {
    if (currentDetailState === state) {
      loadingDetailCollections.delete(collectionName);
      updateDetailRailHeader(collectionName);
    }
  }
}

function hasQuestionText() {
  return Boolean(questionInput.value.trim());
}

function realtimeUnavailableReason() {
  const PeerConnection = getPeerConnectionConstructor();
  if (!window.isSecureContext) {
    return "Voice requires HTTPS";
  }
  if (!PeerConnection) {
    return "Voice not supported here";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "Microphone not supported here";
  }
  return "";
}

function chooseDictationMimeType() {
  if (typeof MediaRecorder !== "function") {
    return "";
  }
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function dictationUnavailableReason() {
  if (!window.isSecureContext) {
    return "Dictation requires HTTPS";
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return "Microphone not supported here";
  }
  if (typeof MediaRecorder !== "function") {
    return "Recording not supported here";
  }
  return "";
}

function updateSessionButtons() {
  const unavailableReason = realtimeUnavailableReason();
  startButton.hidden = sessionRunning;
  stopButton.hidden = !sessionRunning;
  startButton.disabled = sessionRunning || Boolean(unavailableReason);
  startButton.title = unavailableReason || "Talk";
  startButton.setAttribute("aria-label", unavailableReason || "Talk");
  stopButton.disabled = !sessionRunning;
  updateMicrophoneToggle();
}

function setSessionRunning(running) {
  sessionRunning = running;
  updateSessionButtons();
}

function updateMicrophoneToggle() {
  const microphoneOpen = sessionRunning ? userMicrophoneOpen : dictationActive;
  const unavailableReason = sessionRunning ? "" : dictationUnavailableReason();
  let disabled = false;
  let label = microphoneOpen ? "Mic Off" : "Mic On";
  if (sessionRunning) {
    disabled = !localAudioTrack;
  } else if (dictationActive) {
    label = "Stop dictation";
  } else if (dictationTranscribing || textChatInFlight) {
    // Stay enabled: a click supersedes the in-flight answer and starts a new question.
    label = "Ask again";
  } else if (hasQuestionText()) {
    // Stay enabled: a click clears the typed text and dictates instead.
    label = "Dictate question";
  } else if (unavailableReason) {
    label = unavailableReason;
    disabled = true;
  } else {
    label = "Dictate question";
  }
  microphoneToggleButton.classList.toggle("isClosed", !microphoneOpen);
  microphoneToggleButton.disabled = disabled;
  microphoneToggleButton.setAttribute("aria-pressed", String(microphoneOpen));
  microphoneToggleButton.setAttribute("aria-label", label);
  microphoneToggleButton.title = label;
}

function updateLookToggle() {
  lookToggleButton.classList.toggle("isClosed", !userLookOpen);
  lookToggleButton.setAttribute("aria-pressed", String(userLookOpen));
  const label = userLookOpen ? "Look On" : "Look Off";
  lookToggleButton.setAttribute("aria-label", label);
  lookToggleButton.title = label;
}

function getPeerConnectionConstructor() {
  return window.RTCPeerConnection || window.webkitRTCPeerConnection;
}

function realtimeSupportSnapshot(reason) {
  return {
    ...browserContext(reason),
    href: window.location.href,
    protocol: window.location.protocol,
    host: window.location.host,
    isSecureContext: window.isSecureContext,
    hasRTCPeerConnection: typeof window.RTCPeerConnection === "function",
    hasWebkitRTCPeerConnection: typeof window.webkitRTCPeerConnection === "function",
    hasMediaDevices: Boolean(navigator.mediaDevices),
    hasGetUserMedia: Boolean(navigator.mediaDevices?.getUserMedia),
    hasWakeLock: Boolean(navigator.wakeLock?.request),
  };
}

function explainWebRtcUnavailable() {
  const snapshot = realtimeSupportSnapshot("webrtc unavailable");
  if (/Apple Watch|Watch/i.test(navigator.userAgent) || /Watch/i.test(navigator.platform)) {
    return "Voice is not supported on Apple Watch. Use typed questions on the watch, or use voice on iPhone Safari.";
  }
  if (!snapshot.isSecureContext) {
    return "WebRTC is unavailable because this page is not running in a secure browser context. On iPhone, open the HTTPS deployment URL directly in Safari, for example https://www.vaugouin.com/voice-agent/.";
  }
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
    return "WebRTC is unavailable in this iOS Safari context. Open the HTTPS deployment URL directly in Safari, make sure WebRTC is enabled in Safari settings, and keep the tab in the foreground.";
  }
  return "WebRTC is not available in this browser. Use a browser that exposes RTCPeerConnection over HTTPS.";
}

function setStatus(text, state = "idle") {
  statusText.textContent = text;
  statusDot.classList.toggle("live", state === "live");
  statusDot.classList.toggle("error", state === "error");
}

function log(label, value = "") {
  const entry = document.createElement("div");
  entry.className = "logEntry";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  entry.textContent = value ? `${label}: ${text}` : label;
  logEl.prepend(entry);
}

function summarizeRealtimeEvent(event) {
  const summary = {
    type: event.type,
    event_id: event.event_id,
    response_id: event.response_id || event.response?.id,
    item_id: event.item_id || event.item?.id,
    activeResponseId,
    activeAudioResponseId,
    dataChannelState: dc?.readyState || null,
    micEnabled: localAudioTrack?.enabled ?? null,
    toolCallsInFlight,
    awaitingToolResponse,
  };

  if (event.error) {
    summary.error = event.error;
  }
  if (event.response?.status) {
    summary.response_status = event.response.status;
    summary.status_details = event.response.status_details;
  }
  if (event.item?.type) {
    summary.item_type = event.item.type;
    summary.item_status = event.item.status;
    summary.item_name = event.item.name;
    summary.call_id = event.item.call_id;
  }
  if (event.type === "response.done") {
    summary.output_types = (event.response?.output || []).map((item) => item.type);
  }
  if (event.type === "session.created" || event.type === "session.updated") {
    summary.turn_detection = event.session?.audio?.input?.turn_detection || null;
  }

  return summary;
}

function clientLog(event, data = {}, level = "info") {
  fetch(appUrl("client-log"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ level, event, data }),
    keepalive: true,
  }).catch(() => {});
}

function browserContext(reason) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return {
    reason,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    online: navigator.onLine,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    connection: connection
      ? {
          effectiveType: connection.effectiveType || null,
          type: connection.type || null,
          downlink: connection.downlink || null,
          rtt: connection.rtt || null,
          saveData: connection.saveData || false,
        }
      : null,
  };
}

function setupPageDiagnostics() {
  document.addEventListener("visibilitychange", () => {
    clientLog("page_visibility", browserContext("visibilitychange"));
    if (document.visibilityState === "visible" && !manuallyStopped && pc) {
      requestWakeLock("visibility restored");
      // Immediate keepalive on becoming visible — main-thread timers may
      // have been throttled while hidden, so pump bytes now to refresh
      // the data-channel/UDP path before consent freshness fails.
      sendKeepAlivePing();
    }
  });
  window.addEventListener("pagehide", () => {
    clientLog("page_lifecycle", browserContext("pagehide"), "error");
  });
  window.addEventListener("pageshow", (event) => {
    clientLog("page_lifecycle", { ...browserContext("pageshow"), persisted: event.persisted });
  });
  window.addEventListener("blur", () => {
    clientLog("window_focus", browserContext("blur"));
  });
  window.addEventListener("focus", () => {
    clientLog("window_focus", browserContext("focus"));
    // Same idea as visibilitychange: on regaining focus, wake the
    // connection immediately rather than waiting for the next worker tick.
    if (!manuallyStopped && pc) {
      sendKeepAlivePing();
    }
  });
  window.addEventListener("online", () => {
    clientLog("network_status", browserContext("online"));
  });
  window.addEventListener("offline", () => {
    clientLog("network_status", browserContext("offline"), "error");
  });
}

async function requestWakeLock(reason) {
  if (!navigator.wakeLock?.request || document.visibilityState !== "visible") {
    clientLog("wake_lock_unavailable", {
      reason,
      hasWakeLock: Boolean(navigator.wakeLock?.request),
      visibilityState: document.visibilityState,
    });
    return;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      clientLog("wake_lock_released", { reason });
      wakeLock = null;
    });
    clientLog("wake_lock_acquired", { reason });
  } catch (error) {
    clientLog("wake_lock_error", { reason, name: error.name, message: error.message }, "error");
  }
}

async function releaseWakeLock(reason) {
  if (!wakeLock) {
    return;
  }
  try {
    await wakeLock.release();
    clientLog("wake_lock_release_requested", { reason });
  } catch (error) {
    clientLog("wake_lock_release_error", { reason, name: error.name, message: error.message }, "error");
  } finally {
    wakeLock = null;
  }
}

function setupRemoteAudioDiagnostics() {
  const events = ["play", "playing", "pause", "ended", "waiting", "stalled", "suspend", "error", "emptied"];
  for (const eventName of events) {
    remoteAudio.addEventListener(eventName, () => {
      clientLog(eventName === "error" ? "remote_audio_error" : "remote_audio_element", {
        event: eventName,
        paused: remoteAudio.paused,
        readyState: remoteAudio.readyState,
        networkState: remoteAudio.networkState,
        currentTime: remoteAudio.currentTime,
        muted: remoteAudio.muted,
        error: remoteAudio.error
          ? {
              code: remoteAudio.error.code,
              message: remoteAudio.error.message,
            }
          : null,
      }, eventName === "error" || eventName === "stalled" ? "error" : "info");
    });
  }
}

function attachTrackDiagnostics(track, label) {
  if (!track) {
    return;
  }

  const trackState = (eventName) => ({
    event: eventName,
    label,
    id: track.id,
    kind: track.kind,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings: typeof track.getSettings === "function" ? track.getSettings() : null,
  });

  clientLog("media_track_state", trackState("attached"));
  for (const eventName of ["ended", "mute", "unmute"]) {
    track.addEventListener(eventName, () => {
      clientLog("media_track_state", trackState(eventName), eventName === "ended" ? "error" : "info");
    });
  }
}

async function logPeerStats(reason, peer) {
  if (!peer || typeof peer.getStats !== "function") {
    return;
  }

  try {
    const report = await peer.getStats();
    const byId = new Map();
    report.forEach((stat) => byId.set(stat.id, stat));

    const summary = {
      reason,
      connectionState: peer.connectionState,
      iceConnectionState: peer.iceConnectionState,
      iceGatheringState: peer.iceGatheringState,
      signalingState: peer.signalingState,
      selectedCandidatePair: null,
      localCandidate: null,
      remoteCandidate: null,
      inboundAudio: [],
      outboundAudio: [],
    };

    report.forEach((stat) => {
      if (stat.type === "candidate-pair" && (stat.selected || (!summary.selectedCandidatePair && stat.state === "succeeded"))) {
        summary.selectedCandidatePair = {
          id: stat.id,
          state: stat.state,
          nominated: stat.nominated,
          currentRoundTripTime: stat.currentRoundTripTime,
          availableOutgoingBitrate: stat.availableOutgoingBitrate,
          bytesSent: stat.bytesSent,
          bytesReceived: stat.bytesReceived,
        };
        const local = byId.get(stat.localCandidateId);
        const remote = byId.get(stat.remoteCandidateId);
        if (local) {
          summary.localCandidate = {
            candidateType: local.candidateType,
            protocol: local.protocol,
            address: local.address || local.ip || null,
            port: local.port,
          };
        }
        if (remote) {
          summary.remoteCandidate = {
            candidateType: remote.candidateType,
            protocol: remote.protocol,
            address: remote.address || remote.ip || null,
            port: remote.port,
          };
        }
      }

      if (stat.type === "inbound-rtp" && stat.kind === "audio") {
        summary.inboundAudio.push({
          packetsReceived: stat.packetsReceived,
          packetsLost: stat.packetsLost,
          jitter: stat.jitter,
          bytesReceived: stat.bytesReceived,
          concealedSamples: stat.concealedSamples,
        });
      }

      if (stat.type === "outbound-rtp" && stat.kind === "audio") {
        summary.outboundAudio.push({
          packetsSent: stat.packetsSent,
          bytesSent: stat.bytesSent,
          retransmittedPacketsSent: stat.retransmittedPacketsSent,
          totalPacketSendDelay: stat.totalPacketSendDelay,
        });
      }
    });

    clientLog("peer_connection_stats", summary, reason.includes("failed") || reason.includes("disconnected") ? "error" : "info");
  } catch (error) {
    clientLog("peer_connection_stats_error", { reason, name: error.name, message: error.message }, "error");
  }
}

function setLoadingResults(query, uiLanguage = "") {
  setConversationActive(true);
  activeUiLanguage = uiLanguage
    ? normalizeUiLanguage(uiLanguage)
    : detectUiLanguageFromText(query || lastUserTranscript);
  if (matchesCurrentSearchRequest(query, activeUiLanguage)) {
    resultsPanel.hidden = false;
    resultsLoader.hidden = true;
    loadMoreButton.hidden = true;
    resultsEnd.hidden = true;
    loadingMore = false;
    autoPagesLoaded = 0;
    return;
  }
  resultsPanel.hidden = false;
  clearActiveSpokenCard();
  assistantSpokenHighlightBuffer = "";
  clearRenderedPageViewSignature();
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
  resetDetailState();
  loadingMore = false;
  autoPagesLoaded = 0;

  const block = document.createElement("div");
  block.className = "answerBlock";
  const text = document.createElement("p");
  text.className = "answerText";
  text.textContent = query ? `Searching: ${query}` : "Searching...";
  block.append(text);
  resultsContent.append(block);
}

function yearFromDate(value) {
  return String(value || "").slice(0, 4);
}

// VOICE-AGENT-067: air-year range for a serie card — "2000-2003", "2020-" (ongoing, no end),
// "2026-2026" (single year). Begin from DAT_FIRST_AIR, or DAT_RELEASE when the item is a
// collection serie member (first-air is aliased to DAT_RELEASE there). "" for non-series.
function serieAirYears(item) {
  const first = item.DAT_FIRST_AIR || (item.ENTITY_TYPE === "serie" ? item.DAT_RELEASE : "");
  const begin = yearFromDate(first);
  if (!begin) return "";
  const end = yearFromDate(item.DAT_LAST_AIR);
  return end ? `${begin}-${end}` : `${begin}-`;
}

function formatRating(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(1) : "";
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== "") || "";
}

function formatRuntime(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "";
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours ? `${hours}h ${remaining}m` : `${remaining}m`;
}

function formatDate(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (/^\d{4}$/.test(text)) {
    return text;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function countryFlagEmoji(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return "";
  }
  return Array.from(code)
    .map((char) => String.fromCodePoint(0x1f1e6 + char.charCodeAt(0) - 65))
    .join("");
}

function formatCountryCode(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!code) {
    return "";
  }
  const flag = countryFlagEmoji(code);
  return flag ? `${flag} ${code}` : code;
}

// Compact money label: 15000000 -> "$15M", 47010480 -> "$47M", 1500000 -> "$1.5M".
// Empty string for missing / non-positive amounts (so the tile is dropped).
function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "";
  }
  if (amount >= 1e9) {
    return `$${(amount / 1e9).toFixed(amount >= 1e10 ? 0 : 1)}B`;
  }
  if (amount >= 1e6) {
    return `$${(amount / 1e6).toFixed(amount >= 1e7 ? 0 : 1)}M`;
  }
  if (amount >= 1e3) {
    return `$${Math.round(amount / 1e3)}K`;
  }
  return `$${Math.round(amount)}`;
}

// ISO language/region codes -> readable names via Intl.DisplayNames, cached, with the
// raw code as a graceful fallback. "en" -> "English", "GB" -> "🇬🇧 United Kingdom".
let _languageDisplayNames = null;
let _regionDisplayNames = null;
function formatLanguageCode(languageCode) {
  const code = String(languageCode || "").trim().toLowerCase();
  if (!code) {
    return "";
  }
  try {
    if (!_languageDisplayNames) {
      _languageDisplayNames = new Intl.DisplayNames(["en"], { type: "language" });
    }
    return _languageDisplayNames.of(code) || code.toUpperCase();
  } catch (error) {
    return code.toUpperCase();
  }
}
function countryName(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!code) {
    return "";
  }
  try {
    if (!_regionDisplayNames) {
      _regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
    }
    return _regionDisplayNames.of(code) || code;
  } catch (error) {
    return code;
  }
}

// A country shown as its flag emoji (a Unicode regional-indicator pair) instead of the
// raw 2-letter code. Falls back to the code when it isn't a valid region. The full name
// is kept as a tooltip by the callers (chip title / metric). VOICE-AGENT-090.
function countryFlag(countryCode) {
  const code = String(countryCode || "").trim().toUpperCase();
  if (!code) {
    return "";
  }
  return countryFlagEmoji(code) || code;
}

// Integer count with thousands separators (1234 -> "1,234"); "" when non-positive.
function formatCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return "";
  }
  return new Intl.NumberFormat("en-US").format(Math.round(number));
}

// TMDb EPISODE_TYPE prettified ("mid_season" -> "Mid Season"), but blank for the
// unremarkable "standard" so the tile only appears for notable episodes (premiere,
// finale, mid-season). VOICE-AGENT-091.
function prettyEpisodeType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (!value || value === "standard") {
    return "";
  }
  return prettyLabel(value);
}

// TMDb GENDER code -> label; "" (tile dropped) for 0/unknown/missing. VOICE-AGENT-092.
function formatGender(gender) {
  const code = Number(gender);
  if (code === 1) return "Female";
  if (code === 2) return "Male";
  if (code === 3) return "Non-binary";
  return "";
}

// A delimited string (newline / pipe / comma) or an array -> trimmed non-empty items,
// capped. Feeds chip strips from fields like ALSO_KNOWN_AS / ALIASES.
function splitList(value, cap = 12) {
  let items;
  if (Array.isArray(value)) {
    items = value;
  } else {
    const text = String(value ?? "").trim();
    if (!text) {
      return [];
    }
    const delimiter = text.includes("\n") ? "\n" : text.includes("|") ? "|" : ",";
    items = text.split(delimiter);
  }
  return items.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, cap);
}

function prettyLabel(key) {
  const label = String(key || "Value")
    .replace(/[()*]/g, " ")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return label.replace(/\b\w/g, (char) => char.toUpperCase()) || "Value";
}

function formatScalarValue(key, value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "";
  }

  const keyUpper = String(key).toUpperCase();
  const number = Number(value);
  if (Number.isFinite(number) && String(value).trim() !== "") {
    if (
      keyUpper === "BUDGET" ||
      keyUpper === "REVENUE" ||
      keyUpper.includes("AMOUNT") ||
      keyUpper.startsWith("TOTAL_") ||
      keyUpper.endsWith("_SUM")
    ) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(number);
    }
    if (
      keyUpper.includes("AVERAGE") ||
      keyUpper.includes("AVG") ||
      keyUpper.includes("MEAN") ||
      keyUpper === "VOTE_AVERAGE" ||
      keyUpper === "IMDB_RATING"
    ) {
      return number.toFixed(1);
    }
    if (Number.isInteger(number)) {
      return new Intl.NumberFormat("en-US").format(number);
    }
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(number);
  }

  return String(value);
}

function tmdbImage(path, size = "w342") {
  const value = String(path || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  return `https://image.tmdb.org/t/p/${size}${value}`;
}

async function syntheticImageUrl(itemClass, id) {
  // Padded 2:3 card master produced by the synthetic-images repo (decision #7) and served
  // by tmdb-front's Apache. The URL is deterministic: the IMAGE_KEY is
  // sha256("<class>:<id>|logo-pad|<style version>") truncated to 32 hex chars.
  if (!id || !window.crypto || !crypto.subtle) {
    return "";
  }
  try {
    const key = `${itemClass}:${id}|logo-pad|${SYNTHETIC_STYLE_VERSION}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    return `${SYNTHETIC_IMAGES_BASE_URL}/${encodeURIComponent(itemClass)}/${hex}.webp`;
  } catch (error) {
    return "";
  }
}

function applySyntheticLogo(media, img, title, synthetic) {
  // Upgrade a company/network visual to its padded master once the probe confirms the file
  // exists; on 404 (master not generated yet) the raw TMDb logo simply stays in place.
  if (!media || !synthetic || !synthetic.itemClass || !synthetic.id) {
    return;
  }
  syntheticImageUrl(synthetic.itemClass, synthetic.id).then((url) => {
    if (!url) {
      return;
    }
    const probe = new Image();
    probe.onload = () => {
      if (img) {
        img.src = url;
        return;
      }
      const upgraded = document.createElement("img");
      upgraded.src = url;
      setImageText(upgraded, title);
      const fallback = media.querySelector(".posterFallback");
      if (fallback) {
        fallback.replaceWith(upgraded);
      } else {
        media.prepend(upgraded);
      }
    };
    probe.src = url;
  });
}

function wikipediaImage(path) {
  const value = String(path || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }
  if (value.startsWith("/wikipedia/") || value.startsWith("/commons/")) {
    return `https://upload.wikimedia.org${value}`;
  }
  if (value.startsWith("/")) {
    return `https://en.wikipedia.org${value}`;
  }
  if (value.startsWith("wikipedia/") || value.startsWith("commons/")) {
    return `https://upload.wikimedia.org/${value}`;
  }
  const fileName = value.replace(/^File:/i, "");
  return `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}`;
}

function imageUrl(path, size = "w342") {
  const value = String(path || "").trim();
  if (!value) {
    return "";
  }
  if (
    value.startsWith("//") ||
    value.includes("wikimedia.org") ||
    value.includes("wikipedia.org") ||
    value.startsWith("/wiki/") ||
    value.startsWith("/w/") ||
    value.startsWith("/wikipedia/") ||
    value.startsWith("wikipedia/") ||
    value.startsWith("/commons/") ||
    value.startsWith("commons/") ||
    value.startsWith("File:")
  ) {
    return wikipediaImage(value);
  }
  return tmdbImage(value, size);
}

function appendText(parent, className, text) {
  if (!text) {
    return;
  }
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  parent.append(el);
}

function setImageText(img, text) {
  const label = String(text || "").trim();
  img.alt = label;
  if (label) {
    img.title = label;
  } else {
    img.removeAttribute("title");
  }
}

function appendMetric(parent, label, value, { record = null } = {}) {
  const formatted = value === null || value === undefined ? "" : String(value).trim();
  if (!formatted) {
    return;
  }
  const item = document.createElement("div");
  item.className = "detailMetric";
  appendText(item, "detailMetricLabel", label);
  const request = record ? detailRequestFromRecord(record) : null;
  if (request) {
    const button = document.createElement("button");
    button.className = "detailMetricValue detailMetricLink";
    button.type = "button";
    button.textContent = formatted;
    button.setAttribute("aria-label", `Open ${formatted}`);
    button.addEventListener("click", () => {
      showRecordDetail(record).catch((error) => {
        log("detail metric click error", error.message);
      });
    });
    item.append(button);
  } else {
    appendText(item, "detailMetricValue", formatted);
  }
  parent.append(item);
}

// VOICE-AGENT-089: a labelled strip of text chips for short label lists that have no
// image (genres, spoken languages, production countries) — these can't go in a poster
// rail (image-less cards are hidden), so they get a compact pill row instead. No-op
// when the list is empty.
function appendChipStrip(parent, label, chips) {
  // Each chip is a plain string, or { text, title } when a hover tooltip is wanted
  // (e.g. a country flag chip with the full country name as its title).
  const items = (Array.isArray(chips) ? chips : [])
    .map((chip) => (chip && typeof chip === "object")
      ? { text: String(chip.text ?? "").trim(), title: String(chip.title ?? "").trim() }
      : { text: String(chip ?? "").trim(), title: "" })
    .filter((item) => item.text);
  if (!items.length) {
    return;
  }
  const strip = document.createElement("div");
  strip.className = "detailChipStrip";
  appendText(strip, "detailChipStripLabel", label);
  const list = document.createElement("div");
  list.className = "detailChips";
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = "detailChip";
    chip.textContent = item.text;
    if (item.title) {
      chip.title = item.title;
    }
    list.append(chip);
  }
  strip.append(list);
  parent.append(strip);
}

function buildReveal(meta, rating, overview) {
  const reveal = document.createElement("div");
  reveal.className = "search-poster-card-reveal";
  const cleanMeta = meta.filter((item) => item !== null && item !== undefined && String(item).trim());
  if (cleanMeta.length) {
    appendText(reveal, "search-poster-card-reveal-meta", cleanMeta.join(" · "));
  }
  const cleanRating = formatRating(rating);
  if (cleanRating) {
    appendText(reveal, "search-poster-card-reveal-rating", `★ ${cleanRating}`);
  }
  appendText(reveal, "search-poster-card-reveal-overview", overview);
  return reveal;
}

function buildCardMedia(title, imageUrl, synthetic = null) {
  const media = document.createElement("div");
  media.className = "search-poster-card-media";

  if (imageUrl) {
    const img = document.createElement("img");
    // Lazy-load (set before src) + async decode so the launch showcase — up to ~237
    // sample groups, each with poster cards, duplicated for the marquee — does not fetch
    // every poster on cold start; posters load as they scroll into view.
    img.loading = "lazy";
    img.decoding = "async";
    img.src = imageUrl;
    setImageText(img, title);
    media.append(img);
    applySyntheticLogo(media, img, title, synthetic);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "posterFallback";
    fallback.textContent = title || "No image";
    media.append(fallback);
    applySyntheticLogo(media, null, title, synthetic);
  }

  return media;
}

function buildCardText(title, subtitle = "") {
  const text = document.createElement("div");
  text.className = "search-poster-card-text";
  appendText(text, "search-poster-card-title", title);
  appendText(text, "search-poster-card-year", subtitle);
  return text;
}

function normalizeSpokenCardText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function yearTokensFromText(value) {
  return Array.from(new Set(String(value || "").match(/\b(?:18|19|20)\d{2}\b/g) || []));
}

function titleWithoutLeadingArticle(title) {
  return normalizeSpokenCardText(title).replace(/^(?:the|a|an)\s+/, "");
}

// Store the normalized title / title-key / subtitle / year tokens a card exposes for
// spoken-card matching (VOICE-AGENT-028/048). Shared by search grid cards and detail
// rail cards; the caller owns `data-result-index` assignment.
function setSpokenCardMatchData(card, { title = "", subtitle = "" } = {}) {
  const normalizedTitle = normalizeSpokenCardText(title);
  const normalizedTitleKey = titleWithoutLeadingArticle(title);
  const normalizedSubtitle = normalizeSpokenCardText(subtitle);
  if (normalizedTitle) {
    card.dataset.resultTitle = normalizedTitle;
  }
  if (normalizedTitleKey && normalizedTitleKey !== normalizedTitle) {
    card.dataset.resultTitleKey = normalizedTitleKey;
  }
  if (normalizedSubtitle) {
    card.dataset.resultSubtitle = normalizedSubtitle;
  }
  const yearKeys = yearTokensFromText(subtitle);
  if (yearKeys.length) {
    card.dataset.resultYearKeys = yearKeys.join(" ");
  }
}

function assignResultCardIndex(grid, card, { title = "", subtitle = "" } = {}) {
  const index = grid.querySelectorAll(".search-poster-card").length + 1;
  card.dataset.resultIndex = String(index);
  setSpokenCardMatchData(card, { title, subtitle });
}

function appendCard(grid, cardSpec) {
  const card = document.createElement("div");
  card.className = "search-poster-card";
  assignResultCardIndex(grid, card, {
    title: cardSpec.title,
    subtitle: cardSpec.subtitle,
  });
  if (cardSpec.detailRequest?.toolName) {
    card.dataset.resultDetailTool = cardSpec.detailRequest.toolName;
  }
  const detailId = cardSpec.detailRequest?.id ?? cardSpec.detailRequest?.id_serie ?? "";
  if (detailId !== "") {
    card.dataset.resultDetailId = String(detailId);
  }
  const link = document.createElement(cardSpec.detailRequest ? "button" : cardSpec.href ? "a" : "div");
  link.className = "search-poster-card-link";
  if (cardSpec.detailRequest) {
    link.type = "button";
    link.addEventListener("click", () => {
      showRecordDetail(cardSpec.record).catch((error) => {
        log("detail card click error", error.message);
      });
    });
  }
  if (cardSpec.href) {
    link.href = cardSpec.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  const media = buildCardMedia(cardSpec.title, cardSpec.imageUrl, cardSpec.synthetic || null);
  media.append(buildReveal(cardSpec.meta || [], cardSpec.rating, cardSpec.overview));
  link.append(media, buildCardText(cardSpec.title, cardSpec.subtitle));
  card.append(link);
  grid.append(card);
}

function cardSpecFromRecord(record) {
  const type = String(record.CONTENT_TYPE || "").toLowerCase();
  const detailRequest = detailRequestFromRecord(record);
  const withRecordDetail = (spec) => ({
    ...spec,
    record,
    detailRequest,
  });

  // Image-wall rows (person_image / movie_image / serie_image result_entity): each row is one
  // image from T_WC_T2S_*_IMAGE (ID_ROW PK, TYPE_IMAGE, image path in POSTER_PATH aliased from
  // IMAGE_PATH). Render the image itself, not a "Person 505710" entity card with a blank portrait.
  if (record.ID_ROW && record.TYPE_IMAGE && (record.POSTER_PATH || record.IMAGE_PATH)) {
    const rawPath = record.POSTER_PATH || record.IMAGE_PATH;
    const typeImage = String(record.TYPE_IMAGE || "").toLowerCase();
    const size = typeImage === "backdrop" || typeImage === "still" ? "w780" : "w500";
    const title = record.PERSON_NAME || record.MOVIE_TITLE || record.SERIE_TITLE || record.CONTENT_TITLE || "";
    return withRecordDetail({
      title,
      imageUrl: tmdbImage(rawPath, size),
    });
  }

  if (record.ID_MOVIE || type === "movie") {
    const title = record.MOVIE_TITLE || record.CONTENT_TITLE || record.TITLE || `Movie ${record.ID_MOVIE || ""}`;
    const year = yearFromDate(record.DAT_RELEASE);
    const meta = [year, record.RUNTIME ? `${record.RUNTIME} min` : ""];
    return withRecordDetail({
      title,
      subtitle: year,
      href: !detailRequest && record.ID_MOVIE
        ? `${TMDB_FRONT_BASE_URL}/movie.php?movieid=${encodeURIComponent(record.ID_MOVIE)}`
        : "",
      imageUrl: tmdbImage(record.POSTER_PATH, "w342"),
      meta,
      rating: record.IMDB_RATING,
      overview: record.TAGLINE || record.OVERVIEW || "",
    });
  }

  if (record.ID_EPISODE || type === "episode") {
    const title = record.TITLE || record.CONTENT_TITLE || `Episode ${record.EPISODE_NUMBER || ""}`;
    const episodeLabel = record.SEASON_NUMBER !== undefined && record.EPISODE_NUMBER !== undefined
      ? `S${String(record.SEASON_NUMBER).padStart(2, "0")}E${String(record.EPISODE_NUMBER).padStart(2, "0")}`
      : "";
    return withRecordDetail({
      title,
      subtitle: episodeLabel,
      imageUrl: tmdbImage(record.STILL_PATH, "w342"),
      meta: [episodeLabel, formatDate(record.DAT_AIR), formatRuntime(record.RUNTIME)],
      rating: record.VOTE_AVERAGE,
      overview: record.OVERVIEW || "",
    });
  }

  if (record.ID_SEASON || type === "season") {
    const seasonNumber = Number(record.SEASON_NUMBER);
    const title = record.TITLE || (seasonNumber === 0 ? "Specials" : `Season ${record.SEASON_NUMBER || ""}`);
    return withRecordDetail({
      title,
      subtitle: firstValue(formatDate(record.DAT_AIR), record.AIR_YEAR),
      imageUrl: tmdbImage(record.POSTER_PATH, "w342"),
      meta: [record.EPISODE_COUNT ? `${record.EPISODE_COUNT} episodes` : "", formatDate(record.DAT_AIR)],
      rating: record.VOTE_AVERAGE,
      overview: record.OVERVIEW || "",
    });
  }

  if (record.ID_SERIE || type === "serie") {
    const title = record.SERIE_TITLE || record.CONTENT_TITLE || `Series ${record.ID_SERIE || ""}`;
    const firstYear = yearFromDate(record.DAT_FIRST_AIR);
    const lastYear = yearFromDate(record.DAT_LAST_AIR);
    const years = firstYear || lastYear ? `${firstYear}-${lastYear}` : "";
    const meta = [
      years,
      record.NUMBER_OF_SEASONS ? `${record.NUMBER_OF_SEASONS} seasons` : "",
      record.NUMBER_OF_EPISODES ? `${record.NUMBER_OF_EPISODES} episodes` : "",
    ];
    return withRecordDetail({
      title,
      subtitle: years,
      href: !detailRequest && record.ID_SERIE
        ? `${TMDB_FRONT_BASE_URL}/serie.php?serieid=${encodeURIComponent(record.ID_SERIE)}`
        : "",
      imageUrl: tmdbImage(record.POSTER_PATH, "w342"),
      meta,
      rating: record.IMDB_RATING,
      overview: record.TAGLINE || record.OVERVIEW || "",
    });
  }

  if (record.ID_PERSON) {
    const title = record.PERSON_NAME || `Person ${record.ID_PERSON}`;
    const life =
      record.BIRTH_YEAR && record.DEATH_YEAR
        ? `${record.BIRTH_YEAR} - ${record.DEATH_YEAR}`
        : record.BIRTH_YEAR
        ? `b. ${record.BIRTH_YEAR}`
        : "";
    return withRecordDetail({
      title,
      subtitle: life,
      href: detailRequest ? "" : `${TMDB_FRONT_BASE_URL}/person.php?personid=${encodeURIComponent(record.ID_PERSON)}`,
      imageUrl: tmdbImage(record.PROFILE_PATH, "w185"),
      meta: [record.KNOWN_FOR_DEPARTMENT, life],
      overview: record.BIOGRAPHY || "",
    });
  }

  if (record.ID_COMPANY || record.ID_NETWORK) {
    const isNetwork = Boolean(record.ID_NETWORK);
    const id = isNetwork ? record.ID_NETWORK : record.ID_COMPANY;
    const title = record.NETWORK_NAME || record.COMPANY_NAME || `${isNetwork ? "Network" : "Company"} ${id}`;
    return withRecordDetail({
      title,
      href: detailRequest
        ? ""
        : `${TMDB_FRONT_BASE_URL}/${isNetwork ? "network" : "company"}.php?${isNetwork ? "networkid" : "companyid"}=${encodeURIComponent(id)}`,
      imageUrl: tmdbImage(record.LOGO_PATH, "w342"),
      synthetic: { itemClass: isNetwork ? "network" : "company", id },
      meta: [record.ORIGIN_COUNTRY, record.HEADQUARTERS],
      overview: record.DESCRIPTION || "",
    });
  }

  const name =
    record.TOPIC_NAME ||
    record.LIST_NAME ||
    record.COLLECTION_NAME ||
    record.MOVEMENT_NAME ||
    record.GENRE_NAME ||
    record.DESCRIPTION ||
    record.DESCRIPTION_FR ||
    record.GROUP_NAME ||
    record.DEATH_NAME ||
    record.AWARD_NAME ||
    record.NOMINATION_NAME ||
    record.ITEM_LABEL ||
    "";

  if (name || record.POSTER_PATH || record.WIKIPEDIA_IMAGE_PATH) {
    return withRecordDetail({
      title: name || "Result",
      imageUrl: imageUrl(record.POSTER_PATH || record.WIKIPEDIA_IMAGE_PATH, "w342"),
      meta: [
        record.TOPIC_TYPE,
        record.LIST_TYPE,
        record.COLLECTION_TYPE,
        record.MOVEMENT_TYPE,
        record.TECHNICAL_TYPE ? prettyLabel(record.TECHNICAL_TYPE) : "",
        record.GROUP_TYPE,
        record.DEATH_TYPE,
        record.AWARD_TYPE,
        record.NOMINATION_TYPE,
      ],
      rating: record.IMDB_RATING,
      overview: record.OVERVIEW || record.DESCRIPTION || "",
    });
  }

  return null;
}

function appendAggregateCard(grid, record) {
  const card = document.createElement("div");
  card.className = "search-poster-card";
  assignResultCardIndex(grid, card);
  const content = document.createElement("div");
  content.className = "search-poster-card-link scalarGrid";

  Object.entries(record).forEach(([key, value]) => {
    const formatted = formatScalarValue(key, value);
    if (!formatted) {
      return;
    }
    const item = document.createElement("div");
    item.className = "search-poster-card-text";
    appendText(item, "search-poster-card-title", prettyLabel(key));
    appendText(item, "search-poster-card-year", formatted);
    content.append(item);
  });

  if (content.children.length) {
    card.append(content);
    grid.append(card);
  }
}

function detailRequestFromRecord(record) {
  const type = String(record.CONTENT_TYPE || "").toLowerCase();
  if (record.ID_EPISODE || type === "episode") {
    if (
      record.ID_SERIE !== null && record.ID_SERIE !== undefined &&
      record.SEASON_NUMBER !== null && record.SEASON_NUMBER !== undefined &&
      record.EPISODE_NUMBER !== null && record.EPISODE_NUMBER !== undefined
    ) {
      return {
        toolName: "get_episode_detail",
        id_serie: record.ID_SERIE,
        season_number: record.SEASON_NUMBER,
        episode_number: record.EPISODE_NUMBER,
      };
    }
    return null;
  }
  if (record.ID_SEASON || type === "season") {
    if (
      record.ID_SERIE !== null && record.ID_SERIE !== undefined &&
      record.SEASON_NUMBER !== null && record.SEASON_NUMBER !== undefined
    ) {
      return {
        toolName: "get_season_detail",
        id_serie: record.ID_SERIE,
        season_number: record.SEASON_NUMBER,
      };
    }
    return null;
  }
  if (record.ID_MOVIE || type === "movie") {
    return record.ID_MOVIE ? { toolName: "get_movie_detail", id: record.ID_MOVIE } : null;
  }
  if (record.ID_SERIE || type === "serie") {
    return record.ID_SERIE ? { toolName: "get_series_detail", id: record.ID_SERIE } : null;
  }
  if (record.ID_PERSON) {
    return { toolName: "get_person_detail", id: record.ID_PERSON };
  }
  if (record.ID_COMPANY) {
    return { toolName: "get_company_detail", id: record.ID_COMPANY };
  }
  if (record.ID_NETWORK) {
    return { toolName: "get_network_detail", id: record.ID_NETWORK };
  }
  if (record.ID_T2S_COLLECTION) {
    return { toolName: "get_collection_detail", id: record.ID_T2S_COLLECTION };
  }
  if (record.ID_TOPIC) {
    return { toolName: "get_topic_detail", id: record.ID_TOPIC };
  }
  if (record.ID_T2S_LIST) {
    return { toolName: "get_list_detail", id: record.ID_T2S_LIST };
  }
  if (record.ID_MOVEMENT) {
    return { toolName: "get_movement_detail", id: record.ID_MOVEMENT };
  }
  if (record.ID_TECHNICAL) {
    return { toolName: "get_technical_detail", id: record.ID_TECHNICAL };
  }
  if (record.ID_GENRE) {
    return { toolName: "get_genre_detail", id: record.ID_GENRE };
  }
  if (record.ID_GROUP) {
    return { toolName: "get_group_detail", id: record.ID_GROUP };
  }
  if (record.ID_DEATH) {
    return { toolName: "get_death_detail", id: record.ID_DEATH };
  }
  if (record.ID_AWARD) {
    return { toolName: "get_award_detail", id: record.ID_AWARD };
  }
  if (record.ID_NOMINATION) {
    return { toolName: "get_nomination_detail", id: record.ID_NOMINATION };
  }
  if (record.ID_WIKIDATA) {
    return { toolName: "get_location_detail", id: record.ID_WIKIDATA };
  }
  return null;
}

function namesFrom(items, key, count = 6) {
  return (Array.isArray(items) ? items : [])
    .map((item) => item?.[key])
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .slice(0, count);
}

function directorCredit(record) {
  const crew = Array.isArray(record.crew) ? record.crew : [];
  return crew.find((item) => {
    const department = String(item.CREW_DEPARTMENT || "").toLowerCase();
    const character = String(item.CAST_CHARACTER || "").toLowerCase();
    return department.includes("directing") || character.includes("director");
  });
}

function movieDirectorName(record) {
  const director = directorCredit(record);
  return director?.PERSON_NAME || record.DIRECTOR_NAME || record.DIRECTOR || "";
}

function appendList(parent, title, values) {
  const clean = values.filter((value) => String(value || "").trim());
  if (!clean.length) {
    return;
  }
  const section = document.createElement("section");
  section.className = "detailSubsection";
  appendText(section, "detailSubheading", title);
  const list = document.createElement("div");
  list.className = "detailChipList";
  clean.forEach((value) => appendText(list, "detailChip", value));
  section.append(list);
  parent.append(section);
}

function visualTitle(item) {
  return firstValue(
    item.SEASON_TITLE,
    item.EPISODE_TITLE,
    item.TITLE,
    item.MOVIE_TITLE,
    item.SERIE_TITLE,
    item.PERSON_NAME,
    item.COMPANY_NAME,
    item.NETWORK_NAME,
    item.COLLECTION_NAME,
    item.TOPIC_NAME,
    item.LIST_NAME,
    item.MOVEMENT_NAME,
    item.GROUP_NAME,
    item.DEATH_NAME,
    item.AWARD_NAME,
    item.NOMINATION_NAME,
    item.DESCRIPTION,
    item.DESCRIPTION_FR,
    item.ITEM_LABEL,
    item.LOCATION_NAME
  );
}

function visualSubtitle(item) {
  return firstValue(
    item.SEASON_SUBTITLE,
    item.EPISODE_SUBTITLE,
    item.CAST_CHARACTER,
    item.CREW_DEPARTMENT,
    serieAirYears(item),
    yearFromDate(item.DAT_RELEASE),
    yearFromDate(item.DAT_FIRST_AIR),
    item.GROUP_TYPE,
    item.DEATH_TYPE,
    item.AWARD_TYPE,
    item.NOMINATION_TYPE,
    item.TECHNICAL_TYPE ? prettyLabel(item.TECHNICAL_TYPE) : "",
    item.TOPIC_TYPE,
    item.COLLECTION_TYPE,
    item.LIST_TYPE,
    item.MOVEMENT_TYPE
  );
}

function seasonRailItems(items, idSerie) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const seasonNumber = Number(item.SEASON_NUMBER);
      const title = firstValue(
        item.TITLE,
        Number.isFinite(seasonNumber)
          ? seasonNumber === 0
            ? "Specials"
            : `Season ${seasonNumber}`
          : "",
        "Season"
      );
      const airDate = firstValue(formatDate(item.DAT_AIR), item.AIR_YEAR);
      const episodes = item.EPISODE_COUNT ? `${item.EPISODE_COUNT} episodes` : "";
      return {
        ...item,
        ID_SERIE: item.ID_SERIE || idSerie,
        SEASON_TITLE: title,
        SEASON_SUBTITLE: uniqueNonEmpty([airDate, episodes]).join(" / "),
      };
    });
}

function episodeRailItems(items, idSerie, seasonNumber) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const episodeNumber = Number(item.EPISODE_NUMBER);
      const episodeLabel = Number.isFinite(episodeNumber) ? `Episode ${episodeNumber}` : "Episode";
      const title = firstValue(item.TITLE, episodeLabel);
      const airDate = firstValue(formatDate(item.DAT_AIR), item.AIR_YEAR);
      return {
        ...item,
        ID_SERIE: item.ID_SERIE || idSerie,
        SEASON_NUMBER: item.SEASON_NUMBER ?? seasonNumber,
        EPISODE_TITLE: title,
        EPISODE_SUBTITLE: uniqueNonEmpty([episodeLabel, airDate, formatRuntime(item.RUNTIME)]).join(" / "),
      };
    });
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function crewCreditLabels(item) {
  return uniqueNonEmpty([
    item.CREW_DEPARTMENT,
    item.CREW_JOB,
    item.JOB,
    item.DEPARTMENT,
  ]);
}

function contentCreditKey(item) {
  return firstValue(
    item.ID_MOVIE ? `movie:${item.ID_MOVIE}` : "",
    item.ID_SERIE ? `serie:${item.ID_SERIE}` : "",
    item.MOVIE_TITLE ? `movie-title:${String(item.MOVIE_TITLE).toLowerCase()}` : "",
    item.SERIE_TITLE ? `serie-title:${String(item.SERIE_TITLE).toLowerCase()}` : "",
    visualTitle(item).toLowerCase()
  );
}

function dedupeCrewCredits(items) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || !visualTitle(item)) {
      continue;
    }
    const key = contentCreditKey(item);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        item: { ...item },
        roles: crewCreditLabels(item),
      });
      continue;
    }
    current.roles = uniqueNonEmpty([...current.roles, ...crewCreditLabels(item)]);
  }

  return Array.from(grouped.values()).map(({ item, roles }) => ({
    ...item,
    CREW_DEPARTMENT: roles.join(", ") || item.CREW_DEPARTMENT,
  }));
}

function personCreditKey(item) {
  return firstValue(
    item.ID_PERSON ? `person:${item.ID_PERSON}` : "",
    item.PERSON_NAME ? `person-name:${String(item.PERSON_NAME).toLowerCase()}` : "",
    visualTitle(item).toLowerCase()
  );
}

function dedupePersonCrewCredits(items) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || !visualTitle(item)) {
      continue;
    }
    const key = personCreditKey(item);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        item: { ...item },
        roles: crewCreditLabels(item),
      });
      continue;
    }
    current.roles = uniqueNonEmpty([...current.roles, ...crewCreditLabels(item)]);
    if (!current.item.PROFILE_PATH && item.PROFILE_PATH) {
      current.item.PROFILE_PATH = item.PROFILE_PATH;
    }
    if (!current.item.ID_PERSON && item.ID_PERSON) {
      current.item.ID_PERSON = item.ID_PERSON;
    }
  }

  return Array.from(grouped.values()).map(({ item, roles }) => ({
    ...item,
    CREW_DEPARTMENT: roles.join(", ") || item.CREW_DEPARTMENT,
  }));
}

function castCreditLabels(item) {
  return uniqueNonEmpty([item.CAST_CHARACTER, item.CHARACTER, item.ROLE]);
}

// Group a content's cast by person so someone credited for several characters shows a
// single portrait with all their character names joined below it (mirrors
// dedupePersonCrewCredits for crew). First-billed occurrence keeps its Map position, so
// billing order is preserved.
function dedupePersonCastCredits(items) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || !visualTitle(item)) {
      continue;
    }
    const key = personCreditKey(item);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { item: { ...item }, roles: castCreditLabels(item) });
      continue;
    }
    current.roles = uniqueNonEmpty([...current.roles, ...castCreditLabels(item)]);
    if (!current.item.PROFILE_PATH && item.PROFILE_PATH) {
      current.item.PROFILE_PATH = item.PROFILE_PATH;
    }
    if (!current.item.ID_PERSON && item.ID_PERSON) {
      current.item.ID_PERSON = item.ID_PERSON;
    }
  }

  return Array.from(grouped.values()).map(({ item, roles }) => ({
    ...item,
    CAST_CHARACTER: roles.join(", ") || item.CAST_CHARACTER,
  }));
}

function visualImage(item, kind = "poster") {
  const size = kind === "profile" ? "w185" : kind === "logo" ? "w342" : "w342";
  return imageUrl(item.PROFILE_PATH || item.POSTER_PATH || item.STILL_PATH || item.IMAGE_PATH || item.LOGO_PATH || item.WIKIPEDIA_IMAGE_PATH, size);
}

function personPortraitImages(record) {
  const portraits = (Array.isArray(record.portraits) ? record.portraits : [])
    .map((item) => imageUrl(item?.IMAGE_PATH, "h632"))
    .filter(Boolean);
  const fallback = imageUrl(record.PROFILE_PATH, "h632");
  return uniqueNonEmpty([...portraits, fallback]);
}

function toggleFullscreenImageViewer(viewer) {
  const wasFullscreen = viewer.classList.contains("isFullscreen");
  document.querySelectorAll(".personPortraitViewer.isFullscreen").forEach((item) => {
    item.classList.remove("isFullscreen");
  });
  document.body.classList.toggle("imageViewerOpen", !wasFullscreen);
  if (!wasFullscreen) {
    viewer.classList.add("isFullscreen");
  }
}

function closeFullscreenImageViewer() {
  document.querySelectorAll(".personPortraitViewer.isFullscreen").forEach((item) => {
    item.classList.remove("isFullscreen");
  });
  document.body.classList.remove("imageViewerOpen");
}

function buildPersonPortraitViewer(record) {
  const viewer = document.createElement("div");
  viewer.className = "personPortraitViewer";
  const images = personPortraitImages(record);
  let index = 0;
  let pointerStartX = null;
  let swiped = false;

  const img = document.createElement("img");
  setImageText(img, titleForRecord(record));
  viewer.append(img);

  const counter = document.createElement("div");
  counter.className = "personPortraitCounter";

  const previous = document.createElement("button");
  previous.className = "portraitNav portraitNavPrev";
  previous.type = "button";
  previous.setAttribute("aria-label", "Previous portrait");
  previous.textContent = "‹";

  const next = document.createElement("button");
  next.className = "portraitNav portraitNavNext";
  next.type = "button";
  next.setAttribute("aria-label", "Next portrait");
  next.textContent = "›";

  const update = () => {
    img.src = images[index] || "";
    counter.textContent = `${index + 1} / ${images.length}`;
  };
  const show = (direction) => {
    if (images.length < 2) {
      return;
    }
    index = (index + direction + images.length) % images.length;
    update();
  };

  previous.addEventListener("click", (event) => {
    event.stopPropagation();
    show(-1);
  });
  next.addEventListener("click", (event) => {
    event.stopPropagation();
    show(1);
  });

  img.addEventListener("click", () => {
    if (swiped) {
      swiped = false;
      return;
    }
    toggleFullscreenImageViewer(viewer);
  });

  viewer.addEventListener("pointerdown", (event) => {
    pointerStartX = event.clientX;
    swiped = false;
  });
  viewer.addEventListener("pointerup", (event) => {
    if (pointerStartX === null) {
      return;
    }
    const deltaX = event.clientX - pointerStartX;
    pointerStartX = null;
    if (Math.abs(deltaX) >= 40) {
      swiped = true;
      show(deltaX < 0 ? 1 : -1);
    }
  });
  viewer.addEventListener("pointercancel", () => {
    pointerStartX = null;
  });

  if (images.length > 1) {
    viewer.append(counter);
  }
  if (images.length) {
    update();
  } else {
    const fallback = document.createElement("div");
    fallback.className = "posterFallback";
    fallback.textContent = titleForRecord(record);
    viewer.replaceChildren(fallback);
  }

  return viewer;
}

function buildSingleImageViewer(record, src) {
  const viewer = document.createElement("div");
  viewer.className = "personPortraitViewer";
  const img = document.createElement("img");
  img.src = src;
  setImageText(img, titleForRecord(record));
  img.addEventListener("click", () => {
    toggleFullscreenImageViewer(viewer);
  });
  viewer.append(img);
  return viewer;
}

function movieOrSeriePosterImages(record) {
  const posters = (Array.isArray(record.posters) ? record.posters : [])
    .map((item) => imageUrl(item?.IMAGE_PATH, "w500"))
    .filter(Boolean);
  const fallback = imageUrl(record.POSTER_PATH, "w500");
  return uniqueNonEmpty([...posters, fallback]);
}

function buildPosterSwipeViewer(record) {
  const viewer = document.createElement("div");
  viewer.className = "personPortraitViewer";
  const images = movieOrSeriePosterImages(record);
  let index = 0;
  let pointerStartX = null;
  let swiped = false;

  const img = document.createElement("img");
  setImageText(img, titleForRecord(record));
  viewer.append(img);

  const counter = document.createElement("div");
  counter.className = "personPortraitCounter";

  const update = () => {
    img.src = images[index] || "";
    counter.textContent = `${index + 1} / ${images.length}`;
  };
  const show = (direction) => {
    if (images.length < 2) {
      return;
    }
    index = (index + direction + images.length) % images.length;
    update();
  };

  img.addEventListener("click", () => {
    if (swiped) {
      swiped = false;
      return;
    }
    toggleFullscreenImageViewer(viewer);
  });

  viewer.addEventListener("pointerdown", (event) => {
    pointerStartX = event.clientX;
    swiped = false;
  });
  viewer.addEventListener("pointerup", (event) => {
    if (pointerStartX === null) {
      return;
    }
    const deltaX = event.clientX - pointerStartX;
    pointerStartX = null;
    if (Math.abs(deltaX) >= 40) {
      swiped = true;
      show(deltaX < 0 ? 1 : -1);
    }
  });
  viewer.addEventListener("pointercancel", () => {
    pointerStartX = null;
  });

  if (images.length > 1) {
    viewer.append(counter);
  }
  if (images.length) {
    update();
  } else {
    const fallback = document.createElement("div");
    fallback.className = "posterFallback";
    fallback.textContent = titleForRecord(record);
    viewer.replaceChildren(fallback);
  }

  return viewer;
}

function movieOrSerieBackdropImages(record) {
  const backdrops = (Array.isArray(record.backdrops) ? record.backdrops : [])
    .map((item) => imageUrl(item?.IMAGE_PATH, "w1280"))
    .filter(Boolean);
  const fallback = imageUrl(record.BACKDROP_PATH, "w1280");
  return uniqueNonEmpty([...backdrops, fallback]);
}

function buildBackdropSwipeViewer(record) {
  const images = movieOrSerieBackdropImages(record);
  if (!images.length) {
    return null;
  }

  const viewer = document.createElement("div");
  viewer.className = "personPortraitViewer backdropViewer";
  // VOICE-AGENT-082: start on the frame saved when this page was last left (0 otherwise),
  // and expose the live index so save-time can capture where the slideshow currently is.
  let index = consumePendingBackdropIndex(images.length);
  let pointerStartX = null;
  let swiped = false;
  let slideshowTimer = null;
  activeBackdropViewer = { getIndex: () => index };

  const img = document.createElement("img");
  setImageText(img, `${titleForRecord(record)} backdrop`);
  viewer.append(img);

  const counter = document.createElement("div");
  counter.className = "personPortraitCounter backdropCounter";

  const slideshowButton = document.createElement("button");
  slideshowButton.className = "slideshowToggle";
  slideshowButton.type = "button";
  slideshowButton.textContent = "\u25b6";
  slideshowButton.setAttribute("aria-label", "Start backdrop slideshow");
  slideshowButton.setAttribute("aria-pressed", "false");

  const update = () => {
    img.src = images[index] || "";
    counter.textContent = `${index + 1} / ${images.length}`;
  };
  const show = (direction) => {
    if (images.length < 2) {
      return;
    }
    index = (index + direction + images.length) % images.length;
    update();
  };
  const setSlideshowRunning = (running) => {
    if (slideshowTimer) {
      window.clearInterval(slideshowTimer);
      slideshowTimer = null;
    }
    if (running && images.length > 1) {
      slideshowTimer = window.setInterval(() => {
        if (!viewer.isConnected) {
          setSlideshowRunning(false);
          return;
        }
        show(1);
      }, 2600);
    }
    const isRunning = Boolean(slideshowTimer);
    slideshowButton.textContent = isRunning ? "\u25a0" : "\u25b6";
    slideshowButton.setAttribute("aria-label", `${isRunning ? "Stop" : "Start"} backdrop slideshow`);
    slideshowButton.setAttribute("aria-pressed", isRunning ? "true" : "false");
  };

  img.addEventListener("click", () => {
    if (swiped) {
      swiped = false;
      return;
    }
    toggleFullscreenImageViewer(viewer);
  });
  viewer.addEventListener("pointerdown", (event) => {
    pointerStartX = event.clientX;
    swiped = false;
  });
  viewer.addEventListener("pointerup", (event) => {
    if (pointerStartX === null) {
      return;
    }
    const deltaX = event.clientX - pointerStartX;
    pointerStartX = null;
    if (Math.abs(deltaX) >= 40) {
      swiped = true;
      show(deltaX < 0 ? 1 : -1);
    }
  });
  viewer.addEventListener("pointercancel", () => {
    pointerStartX = null;
  });
  slideshowButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setSlideshowRunning(!slideshowTimer);
  });

  update();
  if (images.length > 1) {
    viewer.append(counter, slideshowButton);
    // Auto-play the backdrop slideshow as soon as a movie/serie page is shown,
    // unless the user prefers reduced motion. The interval self-stops when the
    // viewer leaves the DOM (isConnected check) or when the button is toggled.
    if (!prefersReducedMotion()) {
      setSlideshowRunning(true);
    }
  }
  return viewer;
}

function buildDetailVisualCard(item, kind = "poster") {
  const title = visualTitle(item);
  const request = detailRequestFromRecord(item);
  const card = document.createElement(request ? "button" : "div");
  card.className = "detailVisualCard";
  if (request) {
    card.type = "button";
    card.setAttribute("aria-label", `Open ${title}`);
    card.addEventListener("click", () => {
      showRecordDetail(item).catch((error) => {
        log("detail page click error", error.message);
      });
    });
  }

  const media = document.createElement("div");
  media.className = "detailVisualMedia";
  const src = visualImage(item, kind);
  const synthetic = (item.ID_COMPANY || item.ID_NETWORK)
    ? { itemClass: item.ID_NETWORK ? "network" : "company", id: item.ID_NETWORK || item.ID_COMPANY }
    : null;
  if (src) {
    const img = document.createElement("img");
    img.src = src;
    setImageText(img, title);
    media.append(img);
    applySyntheticLogo(media, img, title, synthetic);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "posterFallback";
    fallback.textContent = title;
    media.append(fallback);
    applySyntheticLogo(media, null, title, synthetic);
  }

  const text = document.createElement("div");
  text.className = "detailVisualText";
  appendText(text, "detailVisualTitle", title);
  const subtitleText = visualSubtitle(item);
  if (subtitleText) {
    const subtitle = document.createElement("div");
    subtitle.className = "detailVisualSubtitle";
    subtitle.textContent = subtitleText;
    // Long credits (e.g. one actor's many roles) are clamped to 3 lines so cards
    // keep an even height; tapping a clamped subtitle reveals the full text.
    // stopPropagation keeps that tap from also opening the card's detail page.
    subtitle.addEventListener("click", (event) => {
      if (!subtitle.classList.contains("isClampable")) {
        return;
      }
      event.stopPropagation();
      subtitle.classList.toggle("isExpanded");
    });
    text.append(subtitle);
    // Flag as clampable only once it's laid out and actually overflows, so short
    // credits stay non-interactive.
    requestAnimationFrame(() => {
      if (subtitle.scrollHeight > subtitle.clientHeight + 1) {
        subtitle.classList.add("isClampable");
      }
    });
  }
  // VOICE-AGENT-085: make this rail card participate in spoken-card highlighting, so when
  // the assistant names it (e.g. a recommendation from the Recommend rail) it lights up
  // like a search result card. Page-scoped unique index (across all rails); highlight only,
  // no scroll (VOICE-AGENT-065). Cards without a usable title stay unmatched.
  if (title) {
    card.dataset.resultIndex = String((detailSpokenCardIndexCounter += 1));
    setSpokenCardMatchData(card, { title, subtitle: subtitleText });
  }
  card.append(media, text);
  return card;
}

function findDetailRailSection(collectionName, state = currentDetailState) {
  if (!state?.container?.isConnected || !collectionName) {
    return null;
  }
  return Array.from(state.container.querySelectorAll(".detailVisualSection[data-detail-collection]"))
    .find((section) => section.dataset.detailCollection === collectionName) || null;
}

function detailRailAutoLoadThreshold(rail) {
  return Math.max(DETAIL_RAIL_AUTO_LOAD_THRESHOLD_PX, rail.clientWidth * 0.5);
}

function maybeAutoLoadDetailRailPage(rail, { allowErrorRetry = false } = {}) {
  const collectionName = rail?.dataset?.detailCollection || "";
  const meta = collectionName ? detailCollectionPagination(collectionName) : null;
  const hasLoadError = Boolean(currentDetailState?.collectionErrors?.[collectionName]);
  if (
    !collectionName ||
    !meta ||
    meta.total <= meta.loaded ||
    loadingDetailCollections.has(collectionName) ||
    (hasLoadError && !allowErrorRetry)
  ) {
    return;
  }

  const remaining = rail.scrollWidth - rail.clientWidth - rail.scrollLeft;
  if (remaining <= detailRailAutoLoadThreshold(rail)) {
    if (hasLoadError) {
      delete currentDetailState.collectionErrors[collectionName];
      updateDetailRailHeader(collectionName);
    }
    loadDetailCollectionPage(collectionName);
  }
}

function scheduleDetailRailAutoLoadCheck(rail, { allowErrorRetry = false } = {}) {
  if (!rail || rail.dataset.detailRailAutoLoadScheduled === "true") {
    if (rail && allowErrorRetry) {
      rail.dataset.detailRailAutoLoadRetry = "true";
    }
    return;
  }

  rail.dataset.detailRailAutoLoadScheduled = "true";
  rail.dataset.detailRailAutoLoadRetry = allowErrorRetry ? "true" : "false";
  window.requestAnimationFrame(() => {
    const shouldAllowErrorRetry = rail.dataset.detailRailAutoLoadRetry === "true";
    delete rail.dataset.detailRailAutoLoadScheduled;
    delete rail.dataset.detailRailAutoLoadRetry;
    maybeAutoLoadDetailRailPage(rail, { allowErrorRetry: shouldAllowErrorRetry });
  });
}

function updateDetailRailHeader(collectionName) {
  const section = findDetailRailSection(collectionName);
  if (!section) {
    return;
  }

  const meta = detailCollectionPagination(collectionName);
  const titleBlock = section.querySelector(".detailRailTitleBlock");
  if (!titleBlock) {
    return;
  }

  let count = titleBlock.querySelector(".detailRailCount");
  if (meta && meta.total > 0) {
    if (!count) {
      count = document.createElement("div");
      count.className = "detailRailCount";
      titleBlock.append(count);
    }
    count.textContent = `${meta.loaded} of ${meta.total}`;
  } else if (count) {
    count.remove();
  }

  let errorText = titleBlock.querySelector(".detailRailError");
  const loadError = currentDetailState?.collectionErrors?.[collectionName] || "";
  if (loadError) {
    if (!errorText) {
      errorText = document.createElement("div");
      errorText.className = "detailRailError";
      titleBlock.append(errorText);
    }
    errorText.textContent = "Load failed";
    errorText.title = loadError;
  } else if (errorText) {
    errorText.remove();
  }
}

function appendDetailRailItems(collectionName, items) {
  const section = findDetailRailSection(collectionName);
  const rail = section?.querySelector(".detailVisualRail[data-detail-collection]");
  if (!rail) {
    return false;
  }

  const kind = rail.dataset.detailRailKind || "poster";
  const displayItems = detailRailDisplayItems(collectionName, items, currentDetailState?.detail);
  const clean = (Array.isArray(displayItems) ? displayItems : [])
    .filter((item) => item && typeof item === "object" && visualTitle(item));
  if (!clean.length) {
    return true;
  }

  const scrollLeft = rail.scrollLeft;
  const fragment = document.createDocumentFragment();
  clean.forEach((item) => {
    fragment.append(buildDetailVisualCard(item, kind));
  });
  rail.append(fragment);
  rail.scrollLeft = scrollLeft;
  rail.dispatchEvent(new CustomEvent("detailRailUpdated"));
  return true;
}

function detailRailDisplayItems(collectionName, items, detail = currentDetailState?.detail) {
  if (collectionName === "seasons") {
    return seasonRailItems(items, detail?.ID_SERIE);
  }
  if (collectionName === "episodes") {
    return episodeRailItems(items, detail?.ID_SERIE, detail?.SEASON_NUMBER);
  }
  if (collectionName === "crew") {
    return dedupePersonCrewCredits(items);
  }
  if (collectionName === "movie_crew" || collectionName === "series_crew") {
    return dedupeCrewCredits(items);
  }
  return items;
}

function appendVisualRail(parent, title, items, { kind = "poster", collectionName = "" } = {}) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object" && visualTitle(item));
  if (!clean.length) {
    return false;
  }

  const section = document.createElement("section");
  section.className = "detailVisualSection";
  if (collectionName) {
    section.dataset.detailCollection = collectionName;
    section.dataset.detailRailTitle = title;
  }
  const header = document.createElement("div");
  header.className = "detailRailHeader";
  const titleBlock = document.createElement("div");
  titleBlock.className = "detailRailTitleBlock";
  appendText(titleBlock, "detailSubheading", title);
  const meta = collectionName ? detailCollectionPagination(collectionName) : null;
  if (meta && meta.total > 0) {
    const count = document.createElement("div");
    count.className = "detailRailCount";
    count.textContent = `${meta.loaded} of ${meta.total}`;
    titleBlock.append(count);
  }
  const loadError = collectionName ? currentDetailState?.collectionErrors?.[collectionName] : "";
  if (loadError) {
    const errorText = document.createElement("div");
    errorText.className = "detailRailError";
    errorText.textContent = "Load failed";
    errorText.title = loadError;
    titleBlock.append(errorText);
  }
  header.append(titleBlock);

  const controls = document.createElement("div");
  controls.className = "detailRailControls";
  const previous = document.createElement("button");
  previous.className = "detailRailControl";
  previous.type = "button";
  previous.textContent = "<";
  previous.setAttribute("aria-label", `Scroll ${title} left`);
  const next = document.createElement("button");
  next.className = "detailRailControl";
  next.type = "button";
  next.textContent = ">";
  next.setAttribute("aria-label", `Scroll ${title} right`);
  controls.append(previous, next);
  header.append(controls);

  const rail = document.createElement("div");
  rail.className = `detailVisualRail ${kind === "profile" ? "profileRail" : ""}`;
  rail.dataset.detailRailKind = kind;
  if (collectionName) {
    rail.dataset.detailCollection = collectionName;
  }
  clean.forEach((item) => {
    rail.append(buildDetailVisualCard(item, kind));
  });

  const scrollRail = (direction) => {
    const firstCard = rail.querySelector(".detailVisualCard");
    const cardWidth = firstCard ? firstCard.getBoundingClientRect().width : 140;
    rail.scrollBy({
      left: direction * Math.max(cardWidth * 3, rail.clientWidth * 0.75),
      behavior: "smooth",
    });
  };
  const updateControls = () => {
    const hasOverflow = rail.scrollWidth > rail.clientWidth + 1;
    previous.hidden = !hasOverflow;
    next.hidden = !hasOverflow;
    previous.disabled = !hasOverflow || rail.scrollLeft <= 1;
    next.disabled = !hasOverflow || rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1;
  };
  const updateRailState = (options = {}) => {
    const config = options && options.allowErrorRetry ? options : {};
    updateControls();
    scheduleDetailRailAutoLoadCheck(rail, config);
  };
  previous.addEventListener("click", () => scrollRail(-1));
  next.addEventListener("click", () => scrollRail(1));
  rail.addEventListener("scroll", () => updateRailState({ allowErrorRetry: true }), { passive: true });
  rail.addEventListener("detailRailUpdated", () => updateRailState());
  window.requestAnimationFrame(updateRailState);
  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(updateRailState);
    resizeObserver.observe(rail);
  } else {
    window.addEventListener("resize", updateRailState);
  }

  section.append(header, rail);
  parent.append(section);
  return true;
}

// VOICE-AGENT-070: YouTube/Vimeo video rail on a movie/serie detail. The API `videos`
// field already carries THUMBNAIL_URL / EMBED_URL / WATCH_URL / VIDEO_NAME per row; clicking
// a card plays the video inline in a modal (no leaving the app).
function isPlayableVideo(video) {
  if (!video || typeof video !== "object") return false;
  const embeddable = video.EMBED_URL || video.WATCH_URL;
  const hasThumb = video.THUMBNAIL_URL || video.VIDEO_KEY;
  return Boolean(embeddable && hasThumb);
}

function videoThumbUrl(video) {
  if (video.THUMBNAIL_URL) return video.THUMBNAIL_URL;
  if (String(video.VIDEO_SITE || "").toLowerCase() === "youtube" && video.VIDEO_KEY) {
    return `https://img.youtube.com/vi/${video.VIDEO_KEY}/hqdefault.jpg`;
  }
  return "";
}

function openVideoModal(video) {
  const site = String(video.VIDEO_SITE || "").toLowerCase();
  let embed = video.EMBED_URL || "";
  if (!embed && site === "youtube" && video.VIDEO_KEY) embed = `https://www.youtube.com/embed/${video.VIDEO_KEY}`;
  if (!embed) {
    if (video.WATCH_URL) window.open(video.WATCH_URL, "_blank", "noopener");
    return;
  }
  const src = embed + (embed.includes("?") ? "&" : "?") + "autoplay=1&rel=0";
  const overlay = document.createElement("div");
  overlay.className = "videoModalOverlay";
  const frameWrap = document.createElement("div");
  frameWrap.className = "videoModalFrame";
  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.title = video.VIDEO_NAME || "Video";
  iframe.setAttribute("allow", "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
  iframe.setAttribute("allowfullscreen", "");
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "videoModalClose";
  closeBtn.setAttribute("aria-label", "Close video");
  closeBtn.textContent = "✕";
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  frameWrap.append(iframe, closeBtn);
  overlay.append(frameWrap);
  document.body.append(overlay);
}

function buildVideoCard(video) {
  const name = video.VIDEO_NAME || "Video";
  const card = document.createElement("button");
  card.type = "button";
  card.className = "detailVisualCard videoCard";
  card.setAttribute("aria-label", `Play ${name}`);
  card.addEventListener("click", () => openVideoModal(video));

  const media = document.createElement("div");
  media.className = "detailVisualMedia videoMedia";
  const thumb = videoThumbUrl(video);
  if (thumb) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = thumb;
    setImageText(img, name);
    media.append(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "posterFallback";
    fallback.textContent = name;
    media.append(fallback);
  }
  const play = document.createElement("span");
  play.className = "videoPlayBadge";
  media.append(play);

  const text = document.createElement("div");
  text.className = "detailVisualText";
  appendText(text, "detailVisualTitle", name);
  const subtitleText = video.VIDEO_TYPE || "";
  if (subtitleText) {
    const subtitle = document.createElement("div");
    subtitle.className = "detailVisualSubtitle";
    subtitle.textContent = subtitleText;
    text.append(subtitle);
  }
  card.append(media, text);
  return card;
}

function appendVideoRail(parent, videos) {
  const clean = (Array.isArray(videos) ? videos : []).filter(isPlayableVideo);
  if (!clean.length) return false;

  const section = document.createElement("section");
  section.className = "detailVisualSection";
  const header = document.createElement("div");
  header.className = "detailRailHeader";
  const titleBlock = document.createElement("div");
  titleBlock.className = "detailRailTitleBlock";
  appendText(titleBlock, "detailSubheading", "Videos");
  header.append(titleBlock);

  const controls = document.createElement("div");
  controls.className = "detailRailControls";
  const previous = document.createElement("button");
  previous.className = "detailRailControl";
  previous.type = "button";
  previous.textContent = "<";
  previous.setAttribute("aria-label", "Scroll Videos left");
  const next = document.createElement("button");
  next.className = "detailRailControl";
  next.type = "button";
  next.textContent = ">";
  next.setAttribute("aria-label", "Scroll Videos right");
  controls.append(previous, next);
  header.append(controls);

  const rail = document.createElement("div");
  rail.className = "detailVisualRail";
  clean.forEach((video) => rail.append(buildVideoCard(video)));

  const scrollRail = (direction) => {
    const firstCard = rail.querySelector(".detailVisualCard");
    const cardWidth = firstCard ? firstCard.getBoundingClientRect().width : 220;
    rail.scrollBy({ left: direction * Math.max(cardWidth * 3, rail.clientWidth * 0.75), behavior: "smooth" });
  };
  const updateControls = () => {
    const hasOverflow = rail.scrollWidth > rail.clientWidth + 1;
    previous.hidden = !hasOverflow;
    next.hidden = !hasOverflow;
    previous.disabled = !hasOverflow || rail.scrollLeft <= 1;
    next.disabled = !hasOverflow || rail.scrollLeft + rail.clientWidth >= rail.scrollWidth - 1;
  };
  previous.addEventListener("click", () => scrollRail(-1));
  next.addEventListener("click", () => scrollRail(1));
  rail.addEventListener("scroll", updateControls, { passive: true });
  window.requestAnimationFrame(updateControls);
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(updateControls).observe(rail);
  } else {
    window.addEventListener("resize", updateControls);
  }

  section.append(header, rail);
  parent.append(section);
  return true;
}

// VOICE-AGENT-076 (from the -063 proposal): make the client.log self-sufficient for
// grounded-reco attribution. When a movie/serie detail page renders its Similar /
// Recommended rails, journal the entity IDs actually shown per collection, so a later
// reco turn can be cross-checked against the on-screen grounded set (no fuzzy title
// matching, no Nosferatu-style collisions). Observability only — not the grounding fix.
function logRecoCardsShown(record) {
  const activeId = record?.ID_MOVIE || record?.ID_SERIE || null;
  ["similar", "recommendations"].forEach((source) => {
    const ids = (Array.isArray(record?.[source]) ? record[source] : [])
      .filter((item) => item && typeof item === "object" && visualTitle(item))
      .map((item) => item.ID_MOVIE || item.ID_SERIE)
      .filter((id) => id !== undefined && id !== null && id !== "");
    if (!ids.length) {
      return;
    }
    clientLog("reco_cards_shown", { movie_id: activeId, source, ids });
  });
}

function appendMixedVisualSections(parent, record) {
  appendVisualRail(parent, "Movies", record.movies, { kind: "poster", collectionName: "movies" });
  appendVisualRail(parent, "Series", record.series, { kind: "poster", collectionName: "series" });
  appendVisualRail(parent, "People", record.persons, { kind: "profile", collectionName: "persons" });
  appendVisualRail(parent, "Awards", record.awards, { kind: "poster", collectionName: "awards" });
  appendVisualRail(parent, "Nominations", record.nominations, { kind: "poster", collectionName: "nominations" });
  appendVisualRail(parent, "Collections", record.collections, { kind: "poster", collectionName: "collections" });
  appendVisualRail(parent, "Topics", record.topics, { kind: "poster", collectionName: "topics" });
  appendVisualRail(parent, "Lists", record.lists, { kind: "poster", collectionName: "lists" });
  appendVisualRail(parent, "Movements", record.movements, { kind: "poster", collectionName: "movements" });
  appendVisualRail(parent, "Related technicals", record.siblings, { kind: "poster", collectionName: "siblings" });
  appendVisualRail(parent, "Groups", record.groups, { kind: "profile", collectionName: "groups" });
  appendVisualRail(parent, "Deaths", record.deaths, { kind: "profile", collectionName: "deaths" });
  appendVisualRail(parent, "Companies", record.companies, { kind: "logo", collectionName: "companies" });
  appendVisualRail(parent, "Networks", record.networks, { kind: "logo", collectionName: "networks" });
}

function titleForRecord(record) {
  return firstValue(
    record.TITLE,
    record.MOVIE_TITLE,
    record.SERIE_TITLE,
    record.PERSON_NAME,
    record.COMPANY_NAME,
    record.NETWORK_NAME,
    record.COLLECTION_NAME,
    record.TOPIC_NAME,
    record.LIST_NAME,
    record.MOVEMENT_NAME,
    record.GENRE_NAME,
    record.DESCRIPTION,
    record.DESCRIPTION_FR,
    record.GROUP_NAME,
    record.DEATH_NAME,
    record.AWARD_NAME,
    record.NOMINATION_NAME,
    record.ITEM_LABEL,
    record.CONTENT_TITLE,
    "Result"
  );
}

function renderSingleDetail(container, record, { loading = false, error = "" } = {}) {
  container.replaceChildren();
  const detail = document.createElement("section");
  detail.className = "singleDetail";

  const backdrop = imageUrl(record.BACKDROP_PATH, "w1280");
  if (backdrop) {
    detail.style.setProperty("--detail-backdrop", `url("${backdrop.replace(/"/g, "%22")}")`);
    detail.classList.add("hasBackdrop");
  }

  const media = document.createElement("div");
  media.className = "singleDetailPoster";
  if (record.ID_PERSON) {
    media.append(buildPersonPortraitViewer(record));
  } else if (record.ID_EPISODE) {
    const still = imageUrl(record.STILL_PATH || record.WIKIPEDIA_IMAGE_PATH, "w780");
    if (still) {
      media.append(buildSingleImageViewer(record, still));
    } else {
      const fallback = document.createElement("div");
      fallback.className = "posterFallback";
      fallback.textContent = titleForRecord(record);
      media.append(fallback);
    }
  } else if (record.ID_MOVIE || record.ID_SERIE || record.ID_SEASON) {
    media.append(buildPosterSwipeViewer(record));
    const backdropViewer = buildBackdropSwipeViewer(record);
    if (backdropViewer) {
      media.append(backdropViewer);
    }
  } else {
    const poster = imageUrl(record.POSTER_PATH || record.PROFILE_PATH || record.LOGO_PATH || record.WIKIPEDIA_IMAGE_PATH, "w500");
    const synthetic = (record.ID_COMPANY || record.ID_NETWORK)
      ? { itemClass: record.ID_NETWORK ? "network" : "company", id: record.ID_NETWORK || record.ID_COMPANY }
      : null;
    if (poster) {
      const viewer = buildSingleImageViewer(record, poster);
      applySyntheticLogo(viewer, viewer.querySelector("img"), titleForRecord(record), synthetic);
      media.append(viewer);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "posterFallback";
      fallback.textContent = titleForRecord(record);
      media.append(fallback);
      applySyntheticLogo(media, null, titleForRecord(record), synthetic);
    }
  }

  const body = document.createElement("div");
  body.className = "singleDetailBody";
  appendText(body, "singleDetailEyebrow", loading ? "Loading details..." : "");
  appendText(body, "singleDetailTitle", titleForRecord(record));
  if (!record.ID_PERSON) {
    appendText(body, "singleDetailTagline", firstValue(record.TAGLINE, record.OVERVIEW, record.DESCRIPTION));
  }

  const metrics = document.createElement("div");
  metrics.className = "detailMetrics";

  if (record.ID_EPISODE || String(record.CONTENT_TYPE || "").toLowerCase() === "episode") {
    const crewCredits = dedupePersonCrewCredits(record.crew);
    const castCredits = dedupePersonCastCredits(record.cast);
    const episodeNumber = record.EPISODE_NUMBER !== null && record.EPISODE_NUMBER !== undefined
      ? `Episode ${record.EPISODE_NUMBER}`
      : "";
    appendMetric(metrics, "Episode", episodeNumber);
    appendMetric(metrics, "Aired", firstValue(formatDate(record.DAT_AIR), record.AIR_YEAR));
    appendMetric(metrics, "Duration", formatRuntime(record.RUNTIME));
    appendMetric(metrics, "Rating", formatRating(record.VOTE_AVERAGE));
    appendMetric(metrics, "Votes", formatCount(record.VOTE_COUNT));         // VOICE-AGENT-091
    appendMetric(metrics, "Type", prettyEpisodeType(record.EPISODE_TYPE));  // premiere/finale/mid-season only
    if (metrics.children.length) {
      body.append(metrics);
    }
    appendVisualRail(body, "Series", record.series ? [record.series] : [], { kind: "poster" });
    appendVisualRail(body, "Season", record.season ? [{ ...record.season, ID_SERIE: record.ID_SERIE }] : [], { kind: "poster" });
    if (!appendVisualRail(body, "Cast", castCredits, { kind: "profile", collectionName: "cast" })) {
      appendList(body, "Cast", namesFrom(castCredits, "PERSON_NAME", Infinity));
    }
    appendVisualRail(body, "Crew", crewCredits, { kind: "profile", collectionName: "crew" });
    appendVisualRail(
      body,
      "Stills",
      (Array.isArray(record.stills) ? record.stills : []).map((item, index) => ({
        ...item,
        TITLE: `${titleForRecord(record)} still ${index + 1}`,
      })),
      { kind: "poster" }
    );
  } else if (record.ID_SEASON || String(record.CONTENT_TYPE || "").toLowerCase() === "season") {
    const crewCredits = dedupePersonCrewCredits(record.crew);
    const castCredits = dedupePersonCastCredits(record.cast);
    appendMetric(metrics, "Aired", firstValue(formatDate(record.DAT_AIR), record.AIR_YEAR));
    appendMetric(metrics, "Episodes", record.EPISODE_COUNT);
    appendMetric(metrics, "Rating", formatRating(record.VOTE_AVERAGE));
    if (metrics.children.length) {
      body.append(metrics);
    }
    appendVisualRail(body, "Series", record.series ? [record.series] : [], { kind: "poster" });
    appendVisualRail(
      body,
      "Episodes",
      episodeRailItems(record.episodes, record.ID_SERIE, record.SEASON_NUMBER),
      { kind: "poster", collectionName: "episodes" }
    );
    if (!appendVisualRail(body, "Cast", castCredits, { kind: "profile", collectionName: "cast" })) {
      appendList(body, "Cast", namesFrom(castCredits, "PERSON_NAME", Infinity));
    }
    appendVisualRail(body, "Crew", crewCredits, { kind: "profile", collectionName: "crew" });
  } else if (record.ID_MOVIE || String(record.CONTENT_TYPE || "").toLowerCase() === "movie") {
    const crewCredits = dedupePersonCrewCredits(record.crew);
    const castCredits = dedupePersonCastCredits(record.cast);
    appendMetric(metrics, "Released", firstValue(formatDate(record.DAT_RELEASE), record.RELEASE_YEAR));
    appendMetric(metrics, "Duration", formatRuntime(record.RUNTIME));
    appendMetric(metrics, "IMDb", formatRating(record.IMDB_RATING || record.IMDB_RATING_WEIGHTED));
    appendMetric(metrics, "Popularity", formatRating(record.POPULARITY));
    appendMetric(metrics, "Budget", formatMoney(record.BUDGET));
    appendMetric(metrics, "Revenue", formatMoney(record.REVENUE));
    appendMetric(metrics, "Original language", formatLanguageCode(record.ORIGINAL_LANGUAGE));
    // VOICE-AGENT-089: Director tile removed (it's already in the Crew rail below).
    // Original title only when it differs from the shown title (else it's a duplicate).
    const shownTitleKey = String(titleForRecord(record) || record.MOVIE_TITLE || "").trim().toLowerCase();
    const originalTitle = String(record.ORIGINAL_TITLE || "").trim();
    if (originalTitle && originalTitle.toLowerCase() !== shownTitleKey) {
      appendMetric(metrics, "Original title", originalTitle);
    }
    if (metrics.children.length) {
      body.append(metrics);
    }
    // Image-less label lists -> chip strips (no poster rail: image-less cards are hidden).
    appendChipStrip(body, "Genres", (record.genres || []).map((genre) => genre && genre.GENRE_NAME));
    appendChipStrip(body, "Spoken languages", (record.spoken_languages || []).map(formatLanguageCode));
    appendChipStrip(body, "Production countries", (record.production_countries || []).map((code) => ({ text: countryFlag(code), title: countryName(code) })));
    if (!appendVisualRail(body, "Cast", castCredits, { kind: "profile", collectionName: "cast" })) {
      appendList(body, "Cast", namesFrom(castCredits, "PERSON_NAME", Infinity));
    }
    appendVisualRail(body, "Crew", crewCredits, { kind: "profile", collectionName: "crew" });
    appendVisualRail(body, "Technicals", record.technicals, { kind: "poster", collectionName: "technicals" });
    appendVisualRail(body, record.collection_name || "Collection", record.collection_movies, { kind: "poster", collectionName: "collection_movies" });
    appendVisualRail(body, "Similar", record.similar, { kind: "poster", collectionName: "similar" });
    appendVisualRail(body, "Recommended", record.recommendations, { kind: "poster", collectionName: "recommendations" });
    logRecoCardsShown(record);
    appendVideoRail(body, record.videos); // VOICE-AGENT-070
    appendMixedVisualSections(body, record);
  } else if (record.ID_SERIE || String(record.CONTENT_TYPE || "").toLowerCase() === "serie") {
    const crewCredits = dedupePersonCrewCredits(record.crew);
    const castCredits = dedupePersonCastCredits(record.cast);
    appendMetric(metrics, "First aired", firstValue(formatDate(record.DAT_FIRST_AIR), record.FIRST_AIR_YEAR));
    appendMetric(metrics, "Seasons", record.NUMBER_OF_SEASONS);
    appendMetric(metrics, "Episodes", record.NUMBER_OF_EPISODES);
    appendMetric(metrics, "IMDb", formatRating(record.IMDB_RATING || record.IMDB_RATING_WEIGHTED));
    appendMetric(metrics, "Popularity", formatRating(record.POPULARITY));
    appendMetric(metrics, "Original language", formatLanguageCode(record.ORIGINAL_LANGUAGE));
    // VOICE-AGENT-090: mirror the movie page — Director tile removed (it's in the Crew rail),
    // Original title only when it differs from the shown title.
    const shownSerieTitleKey = String(titleForRecord(record) || record.SERIE_TITLE || "").trim().toLowerCase();
    const originalSerieTitle = String(record.ORIGINAL_TITLE || "").trim();
    if (originalSerieTitle && originalSerieTitle.toLowerCase() !== shownSerieTitleKey) {
      appendMetric(metrics, "Original title", originalSerieTitle);
    }
    if (metrics.children.length) {
      body.append(metrics);
    }
    appendChipStrip(body, "Genres", (record.genres || []).map((genre) => genre && genre.GENRE_NAME));
    appendChipStrip(body, "Spoken languages", (record.spoken_languages || []).map(formatLanguageCode));
    appendChipStrip(body, "Production countries", (record.production_countries || []).map((code) => ({ text: countryFlag(code), title: countryName(code) })));
    appendVisualRail(body, "Seasons", seasonRailItems(record.seasons, record.ID_SERIE), { kind: "poster", collectionName: "seasons" });
    if (!appendVisualRail(body, "Cast", castCredits, { kind: "profile", collectionName: "cast" })) {
      appendList(body, "Cast", namesFrom(castCredits, "PERSON_NAME", Infinity));
    }
    appendVisualRail(body, "Crew", crewCredits, { kind: "profile", collectionName: "crew" });
    // FASTAPI-152: cross-type T2S collection rail — a collection can hold both films and
    // series (e.g. Star Trek); each card routes to the right detail by its own ID_MOVIE /
    // ID_SERIE (detailRequestFromRecord), so movies and series mix in one chronological rail.
    appendVisualRail(body, record.collection_name || "Collection", record.collection_movies, { kind: "poster", collectionName: "collection_movies" });
    appendVisualRail(body, "Similar", record.similar, { kind: "poster", collectionName: "similar" });
    appendVisualRail(body, "Recommended", record.recommendations, { kind: "poster", collectionName: "recommendations" });
    logRecoCardsShown(record);
    appendVideoRail(body, record.videos); // VOICE-AGENT-070
    appendMixedVisualSections(body, record);
  } else if (record.ID_PERSON) {
    // VOICE-AGENT-092: full birth/death dates (fall back to the year), plus Gender and
    // Popularity, to match the tmdb-front person page.
    appendMetric(metrics, "Born", firstValue(formatDate(record.BIRTHDAY), record.BIRTH_YEAR));
    appendMetric(metrics, "Died", firstValue(formatDate(record.DEATHDAY), record.DEATH_YEAR));
    appendMetric(metrics, "Known for", record.KNOWN_FOR_DEPARTMENT);
    appendMetric(metrics, "Gender", formatGender(record.GENDER));
    appendMetric(metrics, "Popularity", formatRating(record.POPULARITY));
    appendMetric(metrics, "Country", countryFlag(record.COUNTRY_OF_BIRTH));
    if (metrics.children.length) {
      body.append(metrics);
    }
    appendChipStrip(body, "Also known as", splitList(record.ALSO_KNOWN_AS ?? record.ALIASES, 10));
    const knownForActing = String(record.KNOWN_FOR_DEPARTMENT || "").toLowerCase() === "acting";
    const movieCrewCredits = dedupeCrewCredits(record.movie_crew);
    const seriesCrewCredits = dedupeCrewCredits(record.series_crew);
    const displayedMovies = knownForActing
      ? appendVisualRail(body, "Movies", record.movie_cast, { kind: "poster", collectionName: "movie_cast" })
      : appendVisualRail(body, "Directed or crewed", movieCrewCredits, { kind: "poster", collectionName: "movie_crew" });
    if (knownForActing) {
      appendVisualRail(body, "Directed or crewed", movieCrewCredits, { kind: "poster", collectionName: "movie_crew" });
    } else {
      appendVisualRail(body, "Movies", record.movie_cast, { kind: "poster", collectionName: "movie_cast" });
    }
    appendVisualRail(body, "Series", record.series_cast, { kind: "poster", collectionName: "series_cast" });
    appendVisualRail(body, "Series crew", seriesCrewCredits, { kind: "poster", collectionName: "series_crew" });
    appendMixedVisualSections(body, record);
    if (!displayedMovies) {
      appendList(
        body,
        knownForActing ? "Known movies" : "Known crew credits",
        namesFrom(knownForActing ? record.movie_cast : movieCrewCredits, "MOVIE_TITLE", Infinity)
      );
    }
  } else {
    // Shared branch for company / network / collection / topic / list / location / movement /
    // technical / genre / group / death / award / nomination. Every tile is skip-empty, so each
    // entity surfaces only the fields its own table carries (VOICE-AGENT-092).
    appendMetric(metrics, "Type", firstValue(record.COLLECTION_TYPE, record.TOPIC_TYPE, record.LIST_TYPE, record.MOVEMENT_TYPE, record.TECHNICAL_TYPE ? prettyLabel(record.TECHNICAL_TYPE) : "", record.GROUP_TYPE, record.DEATH_TYPE, record.AWARD_TYPE, record.NOMINATION_TYPE, record.INSTANCE_OF));
    appendMetric(metrics, "Movies", record.MOVIE_COUNT);
    appendMetric(metrics, "Series", record.SERIE_COUNT);
    appendMetric(metrics, "Persons", record.PERSON_COUNT);
    appendMetric(metrics, "IMDb", formatRating(record.IMDB_RATING || record.IMDB_RATING_WEIGHTED));
    appendMetric(metrics, "Popularity", formatRating(record.POPULARITY));           // company/collection/topic/list/movement/technical/group
    appendMetric(metrics, "Country", countryFlag(record.ORIGIN_COUNTRY));            // company/network
    appendMetric(metrics, "Headquarters", record.HEADQUARTERS);                      // company/network
    // Provenance, only for the entities whose source value is human-readable (keyword /
    // custom / collection…). group/death/award/nomination sources are raw Wikidata property
    // codes (P108, P166…), so they are intentionally not shown.
    const sourceValue = firstValue(record.COLLECTION_SOURCE, record.TOPIC_SOURCE, record.LIST_SOURCE);
    appendMetric(metrics, "Source", sourceValue ? prettyLabel(sourceValue) : "");
    if (metrics.children.length) {
      body.append(metrics);
    }
    // genre: which content types it applies to.
    const appliesTo = [];
    if (record.APPLIES_TO_MOVIE) { appliesTo.push("Movies"); }
    if (record.APPLIES_TO_SERIE) { appliesTo.push("Series"); }
    appendChipStrip(body, "Applies to", appliesTo);
    appendChipStrip(body, "Also known as", splitList(record.ALIASES ?? record.ALSO_KNOWN_AS, 10));
    appendMixedVisualSections(body, record);
    if (!record.movies?.length && !record.series?.length && !record.persons?.length) {
      appendList(body, "Movies", namesFrom(record.movies, "MOVIE_TITLE", Infinity));
      appendList(body, "Series", namesFrom(record.series, "SERIE_TITLE", Infinity));
      appendList(body, "People", namesFrom(record.persons, "PERSON_NAME", Infinity));
    }
  }

  if (metrics.children.length && !metrics.parentElement) {
    body.append(metrics);
  }
  if (error) {
    appendText(body, "errorText", error);
  }

  detail.append(media, body);
  container.append(detail);
}

async function renderSingleRecordResult(parent, record) {
  const container = document.createElement("div");
  container.className = "singleDetailWrap";
  parent.append(container);
  renderSingleDetail(container, record, { loading: Boolean(detailRequestFromRecord(record)) });

  const request = detailRequestFromRecord(record);
  if (!request) {
    return null;
  }

  try {
    const output = await callEntityDetail(request.toolName, request);
    const detail = { ...record, ...(output.detail || {}) };
    const stateOutput = { ...output, detail };
    setCurrentDetailState(stateOutput, { ...request, ui_language: output.ui_language || activeUiLanguage }, container, detail);
    retainDetailToolContext(request.toolName, currentDetailState.args, stateOutput);
    renderSingleDetail(container, detail);
    return {
      output: stateOutput,
      args: cloneHistoryValue(currentDetailState.args),
    };
  } catch (error) {
    renderSingleDetail(container, record, { error: `Detail fetch failed: ${error.message}` });
    return null;
  }
}

async function showRecordDetail(record, { skipHistory = false, ui_language = "" } = {}) {
  dismissLaunchShowcase();
  setConversationActive(true);
  activeUiLanguage = currentUiLanguage({ ui_language });
  const request = detailRequestFromRecord(record);
  if (request && matchesCurrentDetailRequest(request.toolName, { ...request, ui_language: activeUiLanguage })) {
    return;
  }
  const recordSignature = recordDetailPageSignature(record, activeUiLanguage);
  if (isSameRenderedPageView(recordSignature)) {
    return;
  }
  saveCurrentScrollPosition();
  resultsPanel.hidden = false;
  clearQueryDetailsDock();
  clearRenderedPageViewSignature();
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
  resetDetailState();
  loadingMore = false;
  autoPagesLoaded = 0;

  const renderedDetail = await renderSingleRecordResult(resultsContent, record);
  const renderedOutput = renderedDetail?.output || {};
  const renderedArgs = renderedDetail?.args || detailRequestFromRecord(record) || {};
  markRenderedPageView(renderedDetail
    ? entityDetailPageSignature(renderedOutput, renderedArgs)
    : recordSignature);
  if (!skipHistory) {
    if (renderedDetail) {
      pushPageHistory({ type: "entityDetail", output: renderedDetail.output, args: renderedDetail.args });
    } else {
      pushPageHistory({ type: "recordDetail", record, ui_language: activeUiLanguage });
    }
  }
}

function setLoadingEntityDetail(toolName, args) {
  setConversationActive(true);
  activeUiLanguage = currentUiLanguage(args);
  if (matchesCurrentDetailRequest(toolName, { ...args, ui_language: activeUiLanguage })) {
    resultsPanel.hidden = false;
    resultsLoader.hidden = true;
    loadMoreButton.hidden = true;
    resultsEnd.hidden = true;
    loadingMore = false;
    autoPagesLoaded = 0;
    return;
  }
  resultsPanel.hidden = false;
  clearQueryDetailsDock();
  clearRenderedPageViewSignature();
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
  resetDetailState();
  loadingMore = false;
  autoPagesLoaded = 0;

  const entity = DETAIL_TOOL_ENTITIES[toolName] || "entity";
  const container = document.createElement("div");
  container.className = "singleDetailWrap";
  resultsContent.append(container);
  renderSingleDetail(container, {
    [`ID_${entity.toUpperCase()}`]: args.id || "",
    CONTENT_TITLE: "Loading details...",
  }, { loading: true });
}

function renderEntityDetailOutput(output, args = {}, { skipHistory = false } = {}) {
  dismissLaunchShowcase();
  setConversationActive(true);
  activeUiLanguage = currentUiLanguage({ ui_language: output.ui_language || args.ui_language });
  const outputSignature = entityDetailPageSignature(output, args);
  if (isSameRenderedEntityDetail(output, args)) {
    return;
  }
  saveCurrentScrollPosition();
  resultsPanel.hidden = false;
  clearQueryDetailsDock();
  clearRenderedPageViewSignature();
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
  resetDetailState();
  // VOICE-AGENT-085: restart per-page spoken-card indexing for the detail rails built below.
  detailSpokenCardIndexCounter = 0;
  loadingMore = false;
  autoPagesLoaded = 0;

  const container = document.createElement("div");
  container.className = "singleDetailWrap";
  resultsContent.append(container);

  if (output.error) {
    const errorRecord = {
      CONTENT_TITLE: "Unable to load details",
    };
    renderSingleDetail(container, errorRecord, { error: output.error });
    markRenderedPageView(outputSignature);
    if (!skipHistory) {
      pushPageHistory({ type: "entityDetail", output, args });
    }
    return;
  }

  const detail = output.detail && typeof output.detail === "object" ? output.detail : null;
  if (!detail) {
    const emptyRecord = {
      CONTENT_TITLE: output.entity ? prettyLabel(output.entity) : "Details",
    };
    renderSingleDetail(container, emptyRecord, { error: "No detail record returned." });
    markRenderedPageView(outputSignature);
    if (!skipHistory) {
      pushPageHistory({ type: "entityDetail", output, args });
    }
    return;
  }

  const detailRecord = {
    ...detail,
    ID_WIKIDATA: detail.ID_WIKIDATA || args.ID_WIKIDATA,
  };
  const stateOutput = { ...output, detail: detailRecord };
  setCurrentDetailState(stateOutput, args, container, detailRecord);
  renderSingleDetail(container, detailRecord);
  markRenderedPageView(entityDetailPageSignature(stateOutput, currentDetailState.args));
  if (!skipHistory) {
    pushPageHistory({ type: "entityDetail", output: stateOutput, args: currentDetailState.args });
  }
}

async function renderText2SqlResult(output, args, { append = false, skipHistory = false } = {}) {
  dismissLaunchShowcase();
  setConversationActive(true);
  resultsPanel.hidden = false;

  const upstream = output.upstream && typeof output.upstream === "object" ? output.upstream : {};
  const uiLanguage = normalizeUiLanguage(
    args.ui_language ||
    upstream.ui_language ||
    detectUiLanguageFromText(args.query || upstream.question || lastUserTranscript)
  );
  activeUiLanguage = uiLanguage;
  const rows = Array.isArray(upstream.result)
    ? upstream.result
    : Array.isArray(output.rows)
      ? output.rows
      : [];
  const outputSignature = searchPageSignature(output, args, upstream, rows);
  if (!append && isSameRenderedPageView(outputSignature)) {
    resultsPanel.hidden = false;
    resultsLoader.hidden = true;
    loadMoreButton.hidden = true;
    refreshPaginationControls();
    return;
  }

  let grid = resultsContent.querySelector(".search-poster-card-grid");

  if (!append || !grid) {
    saveCurrentScrollPosition();
    clearActiveSpokenCard();
    clearQueryDetailsDock();
    resetDetailState();
    clearRenderedPageViewSignature();
    resultsContent.replaceChildren();

    const answerBlock = document.createElement("div");
    answerBlock.className = "answerBlock";
    const answer = document.createElement("p");
    answer.className = "answerText";
    answer.textContent = output.answer || upstream.answer || `Results for: ${args.query || ""}`;
    answerBlock.append(answer);

    const error = output.error || upstream.error || "";
    if (error) {
      const errorEl = document.createElement("p");
      errorEl.className = "errorText";
      errorEl.textContent = error;
      answerBlock.append(errorEl);
    }
    const detailsText = [
      upstream.justification || "",
      upstream.sql_query || output.sql_query || "",
      upstream.total_processing_time
        ? `Total processing time: ${Number(upstream.total_processing_time).toFixed(3)}s`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const detailsToggle = buildQueryDetailsToggle(detailsText);
    if (detailsToggle) {
      answerBlock.append(detailsToggle);
    }
    resultsContent.append(answerBlock);
    resultsContent.append(queryDetailsDock);

    const rowsPerPage = Number(output.rows_per_page || upstream.rows_per_page || rows.length || 0);
    const pagination = reusableText2SqlQuestionHash(output, upstream, args, rows, rowsPerPage);
    const page = Number(output.page || upstream.page || args.page || 1);
    currentSearchState = {
      query: args.query || upstream.question || "",
      ui_language: uiLanguage,
      question_hashed: pagination.question_hashed,
      page,
      rows_per_page: rowsPerPage,
      has_more: pagination.has_more,
    };

    if (rows.length === 1) {
      const record = rows[0]?.data || rows[0];
      if (record && typeof record === "object") {
        const renderedDetail = await renderSingleRecordResult(resultsContent, record);
        const renderedOutput = renderedDetail?.output || {};
        const renderedArgs = renderedDetail?.args || detailRequestFromRecord(record) || {};
        refreshPaginationControls();
        markRenderedPageView(outputSignature);
        if (!skipHistory) {
          pushPageHistory({ type: "search", output, args });
        }
        return;
      }
    }

    const section = document.createElement("div");
    section.className = "search-poster-results";
    grid = document.createElement("div");
    grid.className = "search-poster-card-grid";
    section.append(grid);
    resultsContent.append(section);
  }

  rows.forEach((item) => {
    const record = item?.data || item;
    if (!record || typeof record !== "object") {
      return;
    }
    const cardSpec = cardSpecFromRecord(record);
    if (cardSpec) {
      appendCard(grid, cardSpec);
    } else {
      appendAggregateCard(grid, record);
    }
  });

  if (!grid.children.length) {
    const empty = document.createElement("div");
    empty.className = "search-poster-card-text";
    empty.textContent = "No displayable rows.";
    grid.append(empty);
  }
  if (assistantSpokenHighlightBuffer) {
    enqueueSpokenAudioHighlightCues(assistantSpokenHighlightBuffer);
  }

  const rowsPerPage = Number(output.rows_per_page || upstream.rows_per_page || rows.length || 0);
  const pagination = reusableText2SqlQuestionHash(output, upstream, args, rows, rowsPerPage);
  const page = Number(output.page || upstream.page || args.page || 1);
  currentSearchState = {
    query: args.query || upstream.question || "",
    ui_language: uiLanguage,
    question_hashed: pagination.question_hashed,
    page,
    rows_per_page: rowsPerPage,
    has_more: pagination.has_more,
  };
  refreshPaginationControls();
  if (!append && !skipHistory) {
    pushPageHistory({ type: "search", output, args });
  } else if (append && !skipHistory) {
    appendCurrentSearchHistory(output, args);
  }
  markRenderedPageView(append ? currentSearchDomSignature() : outputSignature);
}

function loadedCardCount() {
  return resultsContent.querySelectorAll(".search-poster-card").length;
}

function refreshPaginationControls() {
  if (!currentSearchState?.has_more) {
    resultsLoader.hidden = true;
    loadMoreButton.hidden = true;
    resultsEnd.hidden = loadedCardCount() === 0;
    resultsEnd.textContent = loadedCardCount()
      ? `No more results (${loadedCardCount()} retrieved)`
      : "";
    return;
  }

  resultsEnd.hidden = true;
  resultsLoader.hidden = !loadingMore;
  resultsLoader.textContent = `Loading more (${loadedCardCount()} retrieved)`;
  loadMoreButton.hidden = loadingMore || autoPagesLoaded < maxAutoPages;
  loadMoreButton.textContent = `Load more (${loadedCardCount()} retrieved)`;
}

async function loadNextPage({ isAuto = false } = {}) {
  if (!currentSearchState?.has_more || loadingMore || !currentSearchState.question_hashed) {
    return;
  }

  loadingMore = true;
  refreshPaginationControls();

  try {
    const nextArgs = {
      query: currentSearchState.query,
      ui_language: currentSearchState.ui_language,
      question_hashed: currentSearchState.question_hashed,
      page: currentSearchState.page + 1,
    };
    const output = await callText2Sql(nextArgs);
    await renderText2SqlResult(output, nextArgs, { append: true });
    autoPagesLoaded = isAuto ? autoPagesLoaded + 1 : 0;
  } catch (error) {
    log("load more error", error.message);
    currentSearchState.has_more = false;
  } finally {
    loadingMore = false;
    refreshPaginationControls();
  }
}

function maybeLoadNextPage() {
  if (!currentSearchState?.has_more || loadingMore || autoPagesLoaded >= maxAutoPages) {
    refreshPaginationControls();
    return;
  }

  const rect = resultsPanel.getBoundingClientRect();
  const preloadDistance = Math.max(window.innerHeight, 900);
  if (rect.bottom - window.innerHeight < preloadDistance) {
    loadNextPage({ isAuto: true });
  }
}

function resultCardCount() {
  return resultsContent.querySelectorAll(SPOKEN_CARD_SELECTOR).length;
}

function currentVisibleResultCards() {
  return Array.from(resultsContent.querySelectorAll(".search-poster-card[data-result-index]"))
    .map((card) => {
      const index = Number(card.dataset.resultIndex);
      if (!card.dataset.resultTitle) {
        return null;
      }
      const title = card.querySelector(".search-poster-card-title")?.textContent?.trim() || "";
      const subtitle = card.querySelector(".search-poster-card-year")?.textContent?.trim() || "";
      const result = { index, title };
      if (subtitle) {
        result.subtitle = subtitle;
      }
      if (card.dataset.resultDetailTool) {
        result.detail_tool = card.dataset.resultDetailTool;
      }
      if (card.dataset.resultDetailId) {
        result.id = card.dataset.resultDetailId;
      }
      return result;
    })
    .filter((item) => item && Number.isInteger(item.index) && item.index > 0 && item.title);
}

function clearActiveSpokenCard() {
  activeSpokenCardIndex = null;
  resultsContent.querySelectorAll(SPOKEN_CARD_ACTIVE_SELECTOR).forEach((card) => {
    card.classList.remove("isSpokenActive");
    card.removeAttribute("aria-current");
  });
  resultsContent
    .querySelectorAll(".search-poster-card-grid.hasSpokenActive, .detailVisualRail.hasSpokenActive")
    .forEach((group) => {
      group.classList.remove("hasSpokenActive");
    });
}

function setActiveSpokenCard(index) {
  const numericIndex = Number(index);
  if (!Number.isInteger(numericIndex) || numericIndex < 1) {
    clearActiveSpokenCard();
    return;
  }

  const card = resultsContent.querySelector(spokenCardSelectorForIndex(numericIndex));
  if (!card) {
    return;
  }

  if (activeSpokenCardIndex === numericIndex && card.classList.contains("isSpokenActive")) {
    return;
  }

  clearActiveSpokenCard();
  activeSpokenCardIndex = numericIndex;
  card.classList.add("isSpokenActive");
  card.setAttribute("aria-current", "true");
  card.closest(SPOKEN_CARD_GROUP_SELECTOR)?.classList.add("hasSpokenActive");
  // VOICE-AGENT-065: highlight only, no auto-scroll. The page used to scrollIntoView the
  // spoken card, which yanked content under the user mid-read; the highlight alone conveys
  // which card is being discussed. Manual scrolling is untouched.
}

function usefulSpokenTitleKey(key) {
  if (!key || key.length < 4) {
    return false;
  }
  return key.split(" ").some((part) => part.length >= 3);
}

function pushSpokenCardMatch(matches, index, position, keyLength = 0) {
  if (!Number.isInteger(index) || index < 1 || position < 0) {
    return;
  }
  const existing = matches.find((match) => (
    match.index === index && Math.abs(match.position - position) < 8
  ));
  if (existing) {
    existing.position = Math.min(existing.position, position);
    existing.keyLength = Math.max(existing.keyLength, keyLength);
    return;
  }
  matches.push({ index, position, keyLength });
}

function spokenCardTitleKeys(card) {
  return [
    card.dataset.resultTitle || "",
    card.dataset.resultTitleKey || "",
  ].filter((value, position, values) => value && values.indexOf(value) === position);
}

function spokenCardYearKeys(card) {
  return String(card.dataset.resultYearKeys || "")
    .split(/\s+/)
    .filter(Boolean);
}

function visibleSpokenCardMetadata(cardCount) {
  return Array.from(resultsContent.querySelectorAll(SPOKEN_CARD_SELECTOR))
    .map((card) => {
      const index = Number(card.dataset.resultIndex);
      if (!Number.isInteger(index) || index < 1 || index > cardCount) {
        return null;
      }
      const titleKeys = spokenCardTitleKeys(card).filter(usefulSpokenTitleKey);
      if (!titleKeys.length) {
        return null;
      }
      return {
        index,
        titleKeys,
        yearKeys: spokenCardYearKeys(card),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
}

function findInPaddedText(paddedText, key, onMatch) {
  const needle = ` ${key} `;
  let searchFrom = 0;
  while (searchFrom < paddedText.length) {
    const position = paddedText.indexOf(needle, searchFrom);
    if (position < 0) {
      break;
    }
    onMatch(position);
    searchFrom = position + Math.max(needle.length - 1, 1);
  }
}

function spokenTitleContext(paddedText, position, keyLength) {
  const radius = 42;
  const start = Math.max(0, position - radius);
  const end = Math.min(paddedText.length, position + keyLength + radius);
  return paddedText.slice(start, end);
}

function distanceFromSpokenTitle(position, keyLength, tokenStart, tokenLength) {
  const titleStart = position + 1;
  const titleEnd = titleStart + keyLength;
  const tokenEnd = tokenStart + tokenLength;
  if (tokenEnd <= titleStart) {
    return titleStart - tokenEnd;
  }
  if (tokenStart >= titleEnd) {
    return tokenStart - titleEnd;
  }
  return 0;
}

function nearbyYearTokens(paddedText, position, keyLength) {
  const radius = 42;
  const start = Math.max(0, position - radius);
  const end = Math.min(paddedText.length, position + keyLength + radius);
  const context = paddedText.slice(start, end);
  return Array.from(context.matchAll(/\b(?:18|19|20)\d{2}\b/g))
    .map((match) => ({
      year: match[0],
      distance: distanceFromSpokenTitle(position, keyLength, start + (match.index || 0), match[0].length),
    }))
    .sort((a, b) => a.distance - b.distance);
}

function resolveDuplicateTitleCard(group, paddedText, position, key, usedDuplicateTitleMatches) {
  const context = spokenTitleContext(paddedText, position, key.length);
  for (const { year } of nearbyYearTokens(paddedText, position, key.length)) {
    const matchingYearCards = group.filter((card) => card.yearKeys.includes(year));
    if (matchingYearCards.length === 1) {
      return { card: matchingYearCards[0], keyLength: key.length + year.length + 1 };
    }
  }

  for (const match of context.matchAll(/\b\d{1,3}\b/g)) {
    const cardIndex = Number(match[0]);
    const matchingIndexCard = group.find((card) => card.index === cardIndex);
    if (matchingIndexCard) {
      return { card: matchingIndexCard, keyLength: key.length + match[0].length + 1 };
    }
  }

  const spokenNumberPattern = /\b(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/g;
  for (const match of context.matchAll(spokenNumberPattern)) {
    const ordinal = SPOKEN_CARD_NUMBER_INDEX[match[1]];
    if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= group.length) {
      return { card: group[ordinal - 1], keyLength: key.length + match[1].length + 1 };
    }
  }

  const used = usedDuplicateTitleMatches.get(key) || new Set();
  const nextUnusedCard = group.find((card) => !used.has(card.index)) || group[0];
  used.add(nextUnusedCard.index);
  usedDuplicateTitleMatches.set(key, used);
  return { card: nextUnusedCard, keyLength: key.length };
}

function addTitleSpokenCardMatches(matches, paddedText, cardCount) {
  const titleGroups = new Map();
  for (const card of visibleSpokenCardMetadata(cardCount)) {
    for (const key of card.titleKeys) {
      if (!titleGroups.has(key)) {
        titleGroups.set(key, []);
      }
      titleGroups.get(key).push(card);
    }
  }

  // Collect every title-key hit with its start position first, so we can keep only the
  // most specific (longest) title at each position. Otherwise a short article-stripped
  // key ("avengers", from "The Avengers") matches as a prefix of longer titles
  // ("Avengers: Endgame") and steals every mention.
  const hits = [];
  for (const [key, group] of titleGroups.entries()) {
    const uniqueGroup = Array.from(
      new Map(group.map((card) => [card.index, card])).values()
    ).sort((a, b) => a.index - b.index);
    findInPaddedText(paddedText, key, (position) => {
      hits.push({ key, position, group: uniqueGroup });
    });
  }

  const longestKeyLengthByPosition = new Map();
  for (const hit of hits) {
    const previous = longestKeyLengthByPosition.get(hit.position) || 0;
    if (hit.key.length > previous) {
      longestKeyLengthByPosition.set(hit.position, hit.key.length);
    }
  }

  const usedDuplicateTitleMatches = new Map();
  for (const hit of hits) {
    if (hit.key.length < (longestKeyLengthByPosition.get(hit.position) || 0)) {
      continue; // a longer, more specific card title matched at this same position
    }
    if (hit.group.length === 1) {
      pushSpokenCardMatch(matches, hit.group[0].index, hit.position, hit.key.length);
      continue;
    }
    const resolved = resolveDuplicateTitleCard(hit.group, paddedText, hit.position, hit.key, usedDuplicateTitleMatches);
    if (resolved?.card) {
      pushSpokenCardMatch(matches, resolved.card.index, hit.position, resolved.keyLength);
    }
  }
}

function spokenCardMatchesFromText(text) {
  const cardCount = resultCardCount();
  if (!cardCount) {
    return [];
  }

  const clean = String(text || "");
  const matches = [];
  const numericPatterns = [
    /(^|[\s([{])(\d{1,3})[.)]\s+(?=\S)/g,
    /(^|[\s([{])(\d{1,3})\s*[-:]\s+(?=\S)/g,
    /(^|[\s([{])(?:card|result|number|#)\s*(\d{1,3})\b/gi,
  ];

  for (const pattern of numericPatterns) {
    for (const match of clean.matchAll(pattern)) {
      pushSpokenCardMatch(matches, Number(match[2]), (match.index || 0) + match[1].length);
    }
  }

  const ordinalPattern = /(^|[\s([{])(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi;
  for (const match of clean.matchAll(ordinalPattern)) {
    pushSpokenCardMatch(
      matches,
      SPOKEN_CARD_NUMBER_INDEX[match[2].toLowerCase()],
      (match.index || 0) + match[1].length,
      match[2].length
    );
  }

  const namedReferencePattern = /(^|[\s([{])(?:card|result|number|movie|film|series|show|item|option)\s+(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi;
  for (const match of clean.matchAll(namedReferencePattern)) {
    pushSpokenCardMatch(
      matches,
      SPOKEN_CARD_NUMBER_INDEX[match[2].toLowerCase()],
      (match.index || 0) + match[1].length,
      match[2].length
    );
  }

  const normalizedText = normalizeSpokenCardText(clean);
  const paddedText = ` ${normalizedText} `;
  addTitleSpokenCardMatches(matches, paddedText, cardCount);

  return matches
    .filter((match) => match.index >= 1 && match.index <= cardCount)
    .sort((a, b) => (
      a.position - b.position ||
      b.keyLength - a.keyLength ||
      a.index - b.index
    ));
}

function spokenCardIndexFromText(text) {
  const matches = spokenCardMatchesFromText(text);
  const latest = matches[matches.length - 1];

  return latest?.index || null;
}

function applyFallbackSpokenCard(index, options = {}) {
  // Voice and text both rely on the (now prefix-safe) title matcher to follow the
  // enumerated card: in practice the model rarely calls focus_result_card, so this is
  // what actually drives the highlight. focus_result_card, when it IS called, highlights
  // the same card directly; with accurate matching the two agree instead of fighting.
  setActiveSpokenCard(index, options);
}

function syncSpokenCardHighlightFromText(text, options = {}) {
  const index = spokenCardIndexFromText(text);
  if (index) {
    applyFallbackSpokenCard(index, options);
  }
}

function clearSpokenAudioHighlightTimer() {
  if (spokenAudioHighlightTimer) {
    clearTimeout(spokenAudioHighlightTimer);
    spokenAudioHighlightTimer = null;
  }
}

function resetSpokenAudioHighlightState({ clearHighlight = true } = {}) {
  clearSpokenAudioHighlightTimer();
  assistantSpokenHighlightBuffer = "";
  spokenAudioHighlightCues = [];
  spokenAudioHighlightCueKeys = new Set();
  spokenAudioHighlightPlaying = false;
  spokenAudioHighlightStartedAt = 0;
  if (clearHighlight) {
    clearActiveSpokenCard();
  }
}

function scheduleNextSpokenAudioHighlightCue() {
  if (!spokenAudioHighlightPlaying || spokenAudioHighlightTimer || !spokenAudioHighlightCues.length) {
    return;
  }

  const cue = spokenAudioHighlightCues[0];
  const elapsedMs = Date.now() - spokenAudioHighlightStartedAt;
  const dueMs = spokenAudioHighlightInitialDelayMs + cue.position * spokenAudioHighlightMsPerChar;
  const delayMs = Math.max(spokenAudioHighlightMinDelayMs, dueMs - elapsedMs);
  spokenAudioHighlightTimer = window.setTimeout(() => {
    spokenAudioHighlightTimer = null;
    const nextCue = spokenAudioHighlightCues.shift();
    if (nextCue) {
      applyFallbackSpokenCard(nextCue.index);
    }
    scheduleNextSpokenAudioHighlightCue();
  }, delayMs);
}

function enqueueSpokenAudioHighlightCues(text) {
  for (const match of spokenCardMatchesFromText(text)) {
    const key = `${match.index}:${Math.round(match.position / 8)}`;
    if (spokenAudioHighlightCueKeys.has(key)) {
      continue;
    }
    spokenAudioHighlightCueKeys.add(key);
    spokenAudioHighlightCues.push({
      index: match.index,
      position: match.position,
    });
  }
  spokenAudioHighlightCues.sort((a, b) => a.position - b.position || a.index - b.index);
  scheduleNextSpokenAudioHighlightCue();
}

function startSpokenAudioHighlightPlayback() {
  spokenAudioHighlightPlaying = true;
  spokenAudioHighlightStartedAt = Date.now();
  scheduleNextSpokenAudioHighlightCue();
}

function syncSpokenCardHighlightFromTranscriptDelta(delta) {
  if (!delta) {
    return;
  }
  assistantSpokenHighlightBuffer = `${assistantSpokenHighlightBuffer}${delta}`;
  enqueueSpokenAudioHighlightCues(assistantSpokenHighlightBuffer);
}

const subtitleChunkTarget = 150;
const subtitleLongBlockLimit = 260;
const subtitleListItemPattern = /^(?:\d{1,3}[.)]|[-*]|\u2022)\s+\S/;
const realtimeSpokenSubtitleInitialDelayMs = 450;
const realtimeSpokenSubtitleMsPerChar = 68;
const realtimeSpokenSubtitleMinGapMs = 500;
const realtimeSpokenSubtitleStopHoldMs = 3600;
const spokenAudioHighlightInitialDelayMs = 450;
// ms per normalized-transcript char. Realtime voices speak at ~65-70 ms per raw char, and
// the cue position is measured on the punctuation-stripped normalized text (fewer chars),
// so this must sit a bit above the raw rate to track real speech. 52 ran the highlight
// noticeably ahead of the voice.
const spokenAudioHighlightMsPerChar = 72;
const spokenAudioHighlightMinDelayMs = 80;
const publicIdValuePattern = String.raw`(?:tt\d{5,}|nm\d{5,}|co\d{5,}|ev\d{5,}|ch\d{5,}|Q\d+)`;
const labeledIdValuePattern = String.raw`(?:${publicIdValuePattern}|[A-Z]{1,8}\d{2,}|[A-Za-z0-9_-]{8,}|\d+)`;
const idLabelPattern = String.raw`(?:ID_[A-Z0-9_]+|(?:imdb|wikidata|tmdb|tvdb|trakt|t2s)_id|(?:IMDb|Wikidata|TMDb|TVDB|Trakt|T2S)(?:\s+(?:ID|identifier|item|record))?|(?:internal|database|entity|movie|film|series|show|season|episode|person|company|network|collection|topic|list|movement|technical|group|death|award|nomination|location)\s+(?:ID|identifier)|(?:ID|identifier))`;

function sanitizeAssistantFeedbackText(text) {
  return String(text || "")
    .replace(new RegExp(String.raw`\s*[\[(]\s*${idLabelPattern}\s*(?:is|=|:|#|-)?\s*${labeledIdValuePattern}\s*[\])]`, "gi"), "")
    .replace(new RegExp(String.raw`\s*[\[(]\s*${publicIdValuePattern}\s*[\])]`, "g"), "")
    .replace(
      new RegExp(String.raw`(^|[\s,;:([{])${idLabelPattern}\s*(?:is|=|:|#|-)?\s*${labeledIdValuePattern}(?=$|[\s,;:.)\]}-])`, "gi"),
      (_match, prefix) => (prefix && !/[,;:([{]/.test(prefix) ? prefix : "")
    )
    .replace(
      new RegExp(String.raw`(^|[\s,;:([{])${publicIdValuePattern}(?=$|[\s,;:.)\]}-])`, "g"),
      (_match, prefix) => (prefix && !/[,;:([{]/.test(prefix) ? prefix : "")
    )
    .replace(/\b(?:and|or)\s+([,.;:!?])/gi, "$1")
    .replace(/\b(?:has|have|with|using|is|are)\s+([,.;:!?])/gi, "$1")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/([([{])\s+|\s+([)\]}])/g, "$1$2")
    .replace(/\s+(-)\s+([,.;:!?])/g, "$2")
    .replace(/([,;:])\s*([,;:.!?])/g, "$2")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSubtitleText(text) {
  const clean = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!clean) {
    return "";
  }

  return clean
    .replace(/([^\n])\s+((?:\d{1,3}[.)])\s+\S)/g, "$1\n$2")
    .replace(/([.!?]"?)\s+((?:[-*]|\u2022)\s+\S)/g, "$1\n$2");
}

function isSubtitleListItem(text) {
  return subtitleListItemPattern.test(text.trim());
}

function splitSubtitleBlocks(text) {
  const clean = normalizeSubtitleText(text);
  if (!clean) {
    return [];
  }

  const blocks = [];
  let paragraphLines = [];
  let activeListIndex = -1;
  let previousWasBlank = false;

  function flushParagraph() {
    if (!paragraphLines.length) {
      return;
    }
    blocks.push(paragraphLines.join(" "));
    paragraphLines = [];
  }

  for (const rawLine of clean.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      activeListIndex = -1;
      previousWasBlank = true;
      continue;
    }

    if (isSubtitleListItem(line)) {
      flushParagraph();
      blocks.push(line);
      activeListIndex = blocks.length - 1;
      previousWasBlank = false;
      continue;
    }

    if (activeListIndex >= 0 && !previousWasBlank) {
      blocks[activeListIndex] = `${blocks[activeListIndex]} ${line}`;
    } else {
      paragraphLines.push(line);
      activeListIndex = -1;
    }
    previousWasBlank = false;
  }

  flushParagraph();
  return blocks;
}

function splitLongSubtitleBlock(block) {
  if (block.length <= subtitleLongBlockLimit) {
    return [block];
  }

  const listMatch = block.match(/^((?:\d{1,3}[.)]|[-*]|\u2022)\s+)(.+)$/);
  if (listMatch) {
    const [, marker, body] = listMatch;
    return splitLongSubtitleBlock(body).map((part, index) => (
      index === 0 ? `${marker}${part}` : part
    ));
  }

  const chunks = [];
  const sentences = block.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) || [block];
  let current = "";
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }
    const next = `${current} ${trimmed}`.trim();
    if (next.length <= subtitleChunkTarget) {
      current = next;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    if (trimmed.length <= subtitleLongBlockLimit) {
      current = trimmed;
      continue;
    }
    for (let index = 0; index < trimmed.length; index += subtitleChunkTarget) {
      chunks.push(trimmed.slice(index, index + subtitleChunkTarget).trim());
    }
    current = "";
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function splitSubtitleText(text) {
  const blocks = splitSubtitleBlocks(text);
  const chunks = [];
  let current = "";
  let currentIsList = false;

  for (const block of blocks) {
    for (const part of splitLongSubtitleBlock(block)) {
      const partIsList = isSubtitleListItem(part);
      if (partIsList) {
        if (current) {
          chunks.push(current);
          current = "";
        }
        chunks.push(part);
        currentIsList = false;
        continue;
      }

      if (current && currentIsList !== partIsList) {
        chunks.push(current);
        current = "";
      }

      const separator = " ";
      const next = current ? `${current}${separator}${part}` : part;
      if (current && next.length > subtitleChunkTarget) {
        chunks.push(current);
        current = part;
      } else {
        current = next;
      }
      currentIsList = partIsList;
    }
  }

  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function showNextSubtitle() {
  if (!subtitleOverlay) {
    return;
  }
  if (subtitleTimer) {
    clearTimeout(subtitleTimer);
    subtitleTimer = null;
  }
  const text = subtitleQueue.shift();
  if (!text) {
    subtitleOverlay.hidden = true;
    subtitleOverlay.textContent = "";
    clearActiveSpokenCard();
    return;
  }
  subtitleOverlay.textContent = text;
  subtitleOverlay.hidden = false;
  const spokenCardIndex = spokenCardIndexFromText(text);
  if (spokenCardIndex) {
    applyFallbackSpokenCard(spokenCardIndex);
  }
  const duration = Math.max(3500, Math.min(12000, text.length * 65));
  subtitleTimer = window.setTimeout(showNextSubtitle, duration);
}

function showSubtitleText(text) {
  subtitleQueue = splitSubtitleText(sanitizeAssistantFeedbackText(text));
  showNextSubtitle();
}

function showUserSubtitleText(text) {
  if (!userTranscriptSubtitlesEnabled() || !userSubtitleOverlay) {
    return;
  }
  const clean = normalizeSubtitleText(text);
  if (!clean) {
    return;
  }
  if (userSubtitleTimer) {
    clearTimeout(userSubtitleTimer);
    userSubtitleTimer = null;
  }
  userSubtitleOverlay.textContent = clean;
  userSubtitleOverlay.hidden = false;
  const duration = Math.max(3500, Math.min(9000, clean.length * 55));
  userSubtitleTimer = window.setTimeout(() => {
    userSubtitleTimer = null;
    userSubtitleOverlay.hidden = true;
    userSubtitleOverlay.textContent = "";
  }, duration);
}

function stableRealtimeSpokenSubtitleChunks(text, { includeTrailing = false } = {}) {
  const chunks = splitSubtitleText(sanitizeAssistantFeedbackText(text));
  const isStableChunk = (chunk) => /[.!?]["')\]]?$/.test(String(chunk || "").trim());
  if (includeTrailing) {
    return chunks;
  }
  if (chunks.length <= 1) {
    const onlyChunk = chunks[0] || "";
    return isStableChunk(onlyChunk) ? chunks : [];
  }
  const lastChunk = chunks[chunks.length - 1] || "";
  if (isStableChunk(lastChunk)) {
    return chunks;
  }
  return chunks.slice(0, -1);
}

function realtimeSpokenSubtitleDueMs(index) {
  const previousChars = realtimeSpokenSubtitleChunks
    .slice(0, index)
    .reduce((total, chunk) => total + Math.max(20, chunk.length), 0);
  return realtimeSpokenSubtitleInitialDelayMs + previousChars * realtimeSpokenSubtitleMsPerChar;
}

function renderRealtimeSpokenSubtitleChunk(text) {
  if (!subtitleOverlay) {
    return;
  }
  const clean = sanitizeAssistantFeedbackText(text);
  if (!clean) {
    return;
  }
  subtitleQueue = [];
  subtitleOverlay.textContent = clean;
  subtitleOverlay.hidden = false;
  const spokenCardIndex = spokenCardIndexFromText(clean);
  if (spokenCardIndex) {
    applyFallbackSpokenCard(spokenCardIndex);
  }
  realtimeSpokenSubtitleLastText = clean;
}

function finishRealtimeSpokenSubtitleAfterAudioStop() {
  if (subtitleTimer) {
    clearTimeout(subtitleTimer);
    subtitleTimer = null;
  }
  const finalChunk = realtimeSpokenSubtitleChunks[realtimeSpokenSubtitleChunks.length - 1] || "";
  if (
    realtimeSpokenSubtitleFinal &&
    finalChunk &&
    (
      realtimeSpokenSubtitleIndex < realtimeSpokenSubtitleChunks.length ||
      realtimeSpokenSubtitleLastText !== finalChunk
    )
  ) {
    realtimeSpokenSubtitleIndex = realtimeSpokenSubtitleChunks.length;
    renderRealtimeSpokenSubtitleChunk(finalChunk);
  }
  if (!subtitleOverlay || subtitleOverlay.hidden) {
    return;
  }
  subtitleTimer = window.setTimeout(() => {
    subtitleTimer = null;
    if (!realtimeSpokenSubtitlePlaying && !subtitleQueue.length) {
      subtitleOverlay.hidden = true;
      subtitleOverlay.textContent = "";
    }
  }, realtimeSpokenSubtitleStopHoldMs);
}

function scheduleNextRealtimeSpokenSubtitle() {
  if (
    !spokenSubtitlesEnabled() ||
    !realtimeSpokenSubtitlePlaying ||
    subtitleTimer ||
    realtimeSpokenSubtitleIndex >= realtimeSpokenSubtitleChunks.length
  ) {
    return;
  }

  const elapsedMs = Date.now() - realtimeSpokenSubtitleStartedAt;
  const dueMs = realtimeSpokenSubtitleDueMs(realtimeSpokenSubtitleIndex);
  const delayMs = Math.max(
    realtimeSpokenSubtitleIndex === 0 ? 0 : realtimeSpokenSubtitleMinGapMs,
    dueMs - elapsedMs
  );
  subtitleTimer = window.setTimeout(() => {
    subtitleTimer = null;
    if (!spokenSubtitlesEnabled() || !realtimeSpokenSubtitlePlaying) {
      return;
    }
    const nextText = realtimeSpokenSubtitleChunks[realtimeSpokenSubtitleIndex];
    realtimeSpokenSubtitleIndex += 1;
    renderRealtimeSpokenSubtitleChunk(nextText);
    scheduleNextRealtimeSpokenSubtitle();
  }, delayMs);
}

function refreshRealtimeSpokenSubtitleChunks({ final = false } = {}) {
  if (!spokenSubtitlesEnabled()) {
    return;
  }
  realtimeSpokenSubtitleFinal = realtimeSpokenSubtitleFinal || final;
  realtimeSpokenSubtitleChunks = stableRealtimeSpokenSubtitleChunks(
    realtimeSpokenSubtitleBuffer,
    { includeTrailing: realtimeSpokenSubtitleFinal }
  );
  if (
    realtimeSpokenSubtitleFinal &&
    realtimeSpokenSubtitleChunks.length &&
    realtimeSpokenSubtitleIndex >= realtimeSpokenSubtitleChunks.length &&
    realtimeSpokenSubtitleLastText !== realtimeSpokenSubtitleChunks[realtimeSpokenSubtitleChunks.length - 1]
  ) {
    realtimeSpokenSubtitleIndex = realtimeSpokenSubtitleChunks.length - 1;
  }
  if (realtimeSpokenSubtitleIndex > realtimeSpokenSubtitleChunks.length) {
    realtimeSpokenSubtitleIndex = realtimeSpokenSubtitleChunks.length;
  }
  if (realtimeSpokenSubtitleAudioStopped) {
    finishRealtimeSpokenSubtitleAfterAudioStop();
    return;
  }
  scheduleNextRealtimeSpokenSubtitle();
}

function startRealtimeSpokenSubtitlePlayback() {
  if (!spokenSubtitlesEnabled()) {
    return;
  }
  realtimeSpokenSubtitlePlaying = true;
  realtimeSpokenSubtitleAudioStopped = false;
  realtimeSpokenSubtitleStartedAt = Date.now();
  scheduleNextRealtimeSpokenSubtitle();
}

function stopRealtimeSpokenSubtitlePlayback() {
  if (!realtimeSpokenSubtitlePlaying && realtimeSpokenSubtitleAudioStopped) {
    return;
  }
  realtimeSpokenSubtitlePlaying = false;
  realtimeSpokenSubtitleAudioStopped = true;
  finishRealtimeSpokenSubtitleAfterAudioStop();
}

function resetRealtimeSpokenSubtitles({ clearVisible = false } = {}) {
  const hadRealtimeSubtitleState = Boolean(
    realtimeSpokenSubtitleBuffer ||
    realtimeSpokenSubtitleChunks.length ||
    realtimeSpokenSubtitlePlaying ||
    realtimeSpokenSubtitleFinal ||
    realtimeSpokenSubtitleLastText ||
    realtimeSpokenSubtitleSawDelta
  );
  realtimeSpokenSubtitleBuffer = "";
  realtimeSpokenSubtitleChunks = [];
  realtimeSpokenSubtitleIndex = 0;
  realtimeSpokenSubtitlePlaying = false;
  realtimeSpokenSubtitleStartedAt = 0;
  realtimeSpokenSubtitleFinal = false;
  realtimeSpokenSubtitleAudioStopped = false;
  realtimeSpokenSubtitleLastText = "";
  realtimeSpokenSubtitleSawDelta = false;
  if ((hadRealtimeSubtitleState || clearVisible) && subtitleTimer) {
    clearTimeout(subtitleTimer);
    subtitleTimer = null;
  }
  if (!clearVisible || !subtitleOverlay) {
    return;
  }
  subtitleQueue = [];
  subtitleOverlay.hidden = true;
  subtitleOverlay.textContent = "";
}

function appendRealtimeSpokenSubtitleDelta(delta) {
  if (!spokenSubtitlesEnabled()) {
    return;
  }
  const text = String(delta || "");
  if (!text) {
    return;
  }
  realtimeSpokenSubtitleSawDelta = true;
  realtimeSpokenSubtitleBuffer = `${realtimeSpokenSubtitleBuffer}${text}`;
  refreshRealtimeSpokenSubtitleChunks();
}

function completeRealtimeSpokenSubtitle(transcript) {
  if (!spokenSubtitlesEnabled()) {
    return;
  }
  const clean = sanitizeAssistantFeedbackText(transcript);
  if (!clean) {
    return;
  }
  realtimeSpokenSubtitleBuffer = clean;
  realtimeSpokenSubtitleSawDelta = true;
  refreshRealtimeSpokenSubtitleChunks({ final: true });
}

function clearUserSubtitleOutput() {
  if (userSubtitleTimer) {
    clearTimeout(userSubtitleTimer);
    userSubtitleTimer = null;
  }
  if (userSubtitleOverlay) {
    userSubtitleOverlay.hidden = true;
    userSubtitleOverlay.textContent = "";
  }
}

function clearSubtitleOutput() {
  if (subtitleTimer) {
    clearTimeout(subtitleTimer);
    subtitleTimer = null;
  }
  subtitleQueue = [];
  resetRealtimeSpokenSubtitles();
  clearUserSubtitleOutput();
  if (subtitleOverlay) {
    subtitleOverlay.hidden = true;
    subtitleOverlay.textContent = "";
  }
  clearActiveSpokenCard();
}

function isCurrentTextChatRequest(generation, abortController) {
  return (
    generation === textChatGeneration &&
    textChatAbortController === abortController &&
    !abortController.signal.aborted
  );
}

function cancelTextChatOutput(reason = "cancelled") {
  if (!textChatAbortController && !textChatInFlight) {
    return false;
  }
  textChatGeneration += 1;
  textChatAbortController?.abort();
  textChatAbortController = null;
  textChatInFlight = false;
  updateSessionButtons();
  clientLog("text_chat_cancelled", { reason });
  return true;
}

function sendEvent(event) {
  if (!dc || dc.readyState !== "open") {
    log("data channel is not open");
    return false;
  }

  dc.send(JSON.stringify(event));
  return true;
}

function resizeQuestionInput() {
  const maxHeight = Number.parseFloat(getComputedStyle(questionInput).maxHeight) || 180;
  questionInput.style.height = "auto";
  const nextHeight = Math.min(questionInput.scrollHeight, maxHeight);
  questionInput.style.height = `${nextHeight}px`;
  questionInput.style.overflowY = questionInput.scrollHeight > maxHeight ? "auto" : "hidden";
}

function syncQuestionInputUi() {
  resizeQuestionInput();
  submitQuestionButton.hidden = !hasQuestionText();
  updateSessionButtons();
  window.setTimeout(updateSessionButtons, 0);
}

async function callTextChat(message, signal) {
  const response = await fetch(appUrl("text-chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      message,
      context: retainedContext.slice(-maxContextItems),
    }),
  });

  const rawBody = await response.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { text: rawBody };
  }

  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

async function callAudioTranscription(audioBlob, signal) {
  const response = await fetch(appUrl("transcribe"), {
    method: "POST",
    headers: { "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob,
    signal,
  });

  const rawBody = await response.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { text: rawBody };
  }

  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

function canSendTypedRealtimeTurn() {
  return sessionRunning;
}

function sendTypedRealtimeTurn(text, { createResponse = true } = {}) {
  const interruptedResponse = Boolean(activeResponseId);
  const interruptedAudio = Boolean(activeAudioResponseId);
  if (interruptedResponse) {
    sendEvent({ type: "response.cancel" });
    activeResponseId = null;
  }
  if (interruptedAudio) {
    sendEvent({ type: "output_audio_buffer.clear" });
    activeAudioResponseId = null;
  }
  if (interruptedResponse || interruptedAudio) {
    resetSpokenAudioHighlightState();
    resetRealtimeSpokenSubtitles({ clearVisible: spokenSubtitlesEnabled() });
  }

  setStatus("Thinking", "live");
  clientLog("realtime_text_sent", {
    length: text.length,
    interruptedResponse,
    interruptedAudio,
  });

  const inputSent = sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
  const responseSent = !createResponse || sendEvent({ type: "response.create" });
  if (!inputSent || !responseSent) {
    setStatus("Realtime text error", "error");
    clientLog("realtime_text_error", { error: "data channel is not open" }, "error");
  }
}

function submitQuestion() {
  sendTextMessage().catch((error) => {
    log("text submit error", error.message);
  });
}

async function sendTextChatMessage(text, { source = "typed" } = {}) {
  if (!text) {
    return;
  }

  cancelTextChatOutput("new text message");
  const requestGeneration = ++textChatGeneration;
  const requestAbortController = new AbortController();
  textChatAbortController = requestAbortController;

  if (dc && dc.readyState === "open" && activeResponseId) {
    sendEvent({ type: "response.cancel" });
    activeResponseId = null;
    activeAudioResponseId = null;
    resetRealtimeSpokenSubtitles({ clearVisible: spokenSubtitlesEnabled() });
  }
  if (pc || dc || localStream) {
    stop();
  }

  textChatInFlight = true;
  updateSessionButtons();
  questionInput.value = "";
  submitQuestionButton.hidden = true;
  resizeQuestionInput();
  updateSessionButtons();
  lastUserTranscript = text;
  activeUiLanguage = detectUiLanguageFromText(text);
  addRetainedContext({ type: "user", text });
  setStatus("Thinking in text", "live");
  clientLog("text_chat_sent", { length: text.length, source });

  try {
    const output = await callTextChat(text, requestAbortController.signal);
    if (!isCurrentTextChatRequest(requestGeneration, requestAbortController)) {
      return;
    }
    for (const toolResult of Array.isArray(output.tool_outputs) ? output.tool_outputs : []) {
      const toolArgs = toolResult.args || {};
      const toolOutput = toolResult.output || {};
      if (toolResult.name === "query_text2sql") {
        await renderText2SqlResult(toolOutput, toolArgs);
        if (!isCurrentTextChatRequest(requestGeneration, requestAbortController)) {
          return;
        }
        addRetainedContext({
          type: "tool",
          tool_name: toolResult.name,
          ...compactToolContext(toolArgs, toolOutput),
        });
      } else if (DETAIL_TOOL_ENTITIES[toolResult.name]) {
        renderEntityDetailOutput(toolOutput, toolArgs);
        if (!isCurrentTextChatRequest(requestGeneration, requestAbortController)) {
          return;
        }
        retainDetailToolContext(toolResult.name, toolArgs, toolOutput);
      }
      if (!isCurrentTextChatRequest(requestGeneration, requestAbortController)) {
        return;
      }
    }
    const responseText = sanitizeAssistantFeedbackText(output.text || "");
    if (responseText) {
      addRetainedContext({ type: "assistant", text: responseText });
      showSubtitleText(responseText);
    }
    setStatus("Text response", "live");
    clientLog("text_chat_success", {
      model: output.model || "",
      source,
      length: responseText.length,
      tool_count: Array.isArray(output.tool_outputs) ? output.tool_outputs.length : 0,
    });
  } catch (error) {
    if (requestAbortController.signal.aborted || error.name === "AbortError") {
      clientLog("text_chat_cancelled", { source, reason: "aborted" });
      return;
    }
    if (!isCurrentTextChatRequest(requestGeneration, requestAbortController)) {
      return;
    }
    const message = `Text response failed: ${error.message}`;
    showSubtitleText(message);
    setStatus("Text error", "error");
    log("text chat error", error.message);
    clientLog("text_chat_error", { source, error: error.message }, "error");
  } finally {
    if (isCurrentTextChatRequest(requestGeneration, requestAbortController)) {
      textChatAbortController = null;
      textChatInFlight = false;
      updateSessionButtons();
    }
  }
}

async function sendTextMessage() {
  const text = questionInput.value.trim();
  if (!text) {
    return;
  }

  if (canSendTypedRealtimeTurn()) {
    questionInput.value = "";
    submitQuestionButton.hidden = true;
    resizeQuestionInput();
    updateSessionButtons();
    lastUserTranscript = text;
    activeUiLanguage = detectUiLanguageFromText(text);
    if (dc?.readyState === "open") {
      addRetainedContext({ type: "user", text });
      sendTypedRealtimeTurn(text);
    } else {
      pendingRealtimeTextTurns.push(text);
      setStatus("Connecting for voice reply", "live");
      clientLog("realtime_text_queued", { length: text.length });
    }
    return;
  }

  await sendTextChatMessage(text, { source: "typed" });
}

function loadRetainedContext() {
  try {
    const raw = window.localStorage.getItem(CONTEXT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-maxContextItems) : [];
  } catch {
    return [];
  }
}

function saveRetainedContext() {
  try {
    window.localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(retainedContext.slice(-maxContextItems)));
  } catch (error) {
    clientLog("context_save_error", { name: error.name, message: error.message }, "error");
  }
}

function clearRetainedContext() {
  retainedContext = [];
  try {
    window.localStorage.removeItem(CONTEXT_STORAGE_KEY);
  } catch (error) {
    clientLog("context_clear_error", { name: error.name, message: error.message }, "error");
  }
}

function addRetainedContext(item) {
  setConversationActive(true);
  retainedContext.push({
    ...item,
    ts: new Date().toISOString(),
  });
  retainedContext = retainedContext.slice(-maxContextItems);
  saveRetainedContext();
  clientLog("context_retained", {
    type: item.type,
    count: retainedContext.length,
  });
}

function compactToolContext(args, output) {
  return {
    query: args?.query || "",
    answer: output?.answer || "",
    error: output?.error || "",
    result_count: output?.result_count ?? null,
    rows: (output?.rows || []).slice(0, 5),
    sql_query: output?.sql_query || "",
  };
}

function retainDetailToolContext(toolName, args = {}, output = {}) {
  addRetainedContext({
    type: "tool",
    tool_name: toolName,
    entity: output.entity || DETAIL_TOOL_ENTITIES[toolName],
    id: output.id || args.id || args.wikidata_id || "",
    endpoint: output.endpoint || "",
    ui_language: output.ui_language || args.ui_language || "",
    error: output.error || "",
  });
}

function retainedContextText(reason) {
  if (!retainedContext.length) {
    return "";
  }

  const lines = [
    `Retained context restored after ${reason}.`,
    "Use this as prior conversation context. Do not answer this context message directly.",
  ];

  for (const item of retainedContext.slice(-maxContextItems)) {
    if (item.type === "user") {
      lines.push(`User asked: ${item.text}`);
    } else if (item.type === "tool") {
      if (item.tool_name && DETAIL_TOOL_ENTITIES[item.tool_name]) {
        lines.push(`Detail tool: ${item.tool_name}`);
        if (item.entity) {
          lines.push(`Detail entity: ${item.entity}`);
        }
        if (item.id !== null && item.id !== undefined && item.id !== "") {
          lines.push(`Detail id JSON: ${JSON.stringify(item.id)}`);
        }
        if (item.endpoint) {
          lines.push(`Detail endpoint: ${item.endpoint}`);
        }
      } else {
        lines.push(`Tool query: ${item.query || ""}`);
        if (item.answer) {
          lines.push(`Tool answer: ${item.answer}`);
        }
        if (item.result_count !== null && item.result_count !== undefined) {
          lines.push(`Tool result count: ${item.result_count}`);
        }
        if (item.rows?.length) {
          lines.push(`Tool rows JSON: ${JSON.stringify(item.rows)}`);
        }
      }
    } else if (item.type === "assistant") {
      lines.push(`Assistant answered: ${item.text}`);
    }
  }

  return lines.join("\n");
}

function seedRetainedContext(reason) {
  const text = retainedContextText(reason);
  if (!text || !dc || dc.readyState !== "open") {
    return false;
  }

  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
  clientLog("context_seeded", {
    reason,
    count: retainedContext.length,
  });
  return true;
}

function scheduleResponseFallback() {
  if (pendingResponseFallbackTimer) {
    clearTimeout(pendingResponseFallbackTimer);
  }

  pendingResponseFallbackTimer = window.setTimeout(() => {
    pendingResponseFallbackTimer = null;
    if (!dc || dc.readyState !== "open" || activeResponseId) {
      return;
    }
    log("response fallback", "No automatic response was created after speech commit.");
    sendEvent({ type: "response.create" });
  }, 1200);
}

function clearResponseFallback() {
  if (pendingResponseFallbackTimer) {
    clearTimeout(pendingResponseFallbackTimer);
    pendingResponseFallbackTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearDisconnectWatchdog() {
  if (disconnectWatchdogTimer) {
    clearTimeout(disconnectWatchdogTimer);
    disconnectWatchdogTimer = null;
  }
}

function sendKeepAlivePing() {
  if (!dc || dc.readyState !== "open") {
    return;
  }
  try {
    // session.update merges with the current session config, so passing
    // the (unchanged) session.type acts as a true no-op while satisfying
    // the OpenAI Realtime API's schema validation. Sending it on a fixed
    // cadence keeps the data channel (and its underlying SCTP/DTLS/UDP
    // path) actively exchanging packets, preventing NAT mapping
    // expiration and Firefox's ICE consent freshness timeout (~15s) from
    // declaring the peer connection "disconnected" during silent periods
    // (post-response audio playout, in-flight tool calls, background
    // tab/blurred window).
    dc.send(
      JSON.stringify({
        type: "session.update",
        session: { type: "realtime" },
      })
    );
  } catch (error) {
    clientLog(
      "keepalive_send_error",
      { name: error.name, message: error.message },
      "error"
    );
  }
}

function createKeepAliveWorker() {
  // Run setInterval inside a dedicated Worker so the keepalive cadence is
  // NOT throttled when the tab/window loses focus. Firefox (and other
  // browsers) throttle main-thread setInterval/setTimeout to as little
  // as 1 fire/second in background tabs and even more aggressively in
  // unfocused windows; a 5s keepalive can miss multiple fires that way,
  // long enough for ICE consent freshness to declare the peer dead.
  // Workers are not subject to that throttling, so the worker posts a
  // "tick" message which the main thread translates into a data-channel
  // send.
  const source = [
    "let timer = null;",
    "self.onmessage = (event) => {",
    "  const data = event.data || {};",
    "  if (data.type === 'start') {",
    "    if (timer) { clearInterval(timer); }",
    "    timer = setInterval(function () { self.postMessage({ type: 'tick' }); }, data.intervalMs || 5000);",
    "  } else if (data.type === 'stop') {",
    "    if (timer) { clearInterval(timer); timer = null; }",
    "  }",
    "};",
  ].join("\n");
  const blob = new Blob([source], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  worker._blobUrl = url;
  return worker;
}

function startKeepAlive() {
  if (keepAliveWorker || keepAliveInterval) {
    return;
  }
  try {
    keepAliveWorker = createKeepAliveWorker();
    keepAliveWorker.onmessage = (event) => {
      if (event.data && event.data.type === "tick") {
        sendKeepAlivePing();
      }
    };
    keepAliveWorker.onerror = (error) => {
      clientLog(
        "keepalive_worker_error",
        { message: error.message || String(error) },
        "error"
      );
    };
    keepAliveWorker.postMessage({
      type: "start",
      intervalMs: keepAliveIntervalMs,
    });
    clientLog("keepalive_started", {
      intervalMs: keepAliveIntervalMs,
      mode: "worker",
    });
  } catch (error) {
    // Workers may be unavailable (CSP, very old browsers). Fall back to
    // main-thread setInterval; this is the throttle-prone path the worker
    // is designed to avoid, but it's better than no keepalive at all.
    clientLog(
      "keepalive_worker_unavailable",
      { name: error.name, message: error.message },
      "error"
    );
    keepAliveInterval = window.setInterval(
      sendKeepAlivePing,
      keepAliveIntervalMs
    );
    clientLog("keepalive_started", {
      intervalMs: keepAliveIntervalMs,
      mode: "interval",
    });
  }
}

function stopKeepAlive() {
  let stopped = false;
  if (keepAliveWorker) {
    try {
      keepAliveWorker.postMessage({ type: "stop" });
      keepAliveWorker.terminate();
      if (keepAliveWorker._blobUrl) {
        URL.revokeObjectURL(keepAliveWorker._blobUrl);
      }
    } catch (_error) {
      /* ignore */
    }
    keepAliveWorker = null;
    stopped = true;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    stopped = true;
  }
  if (stopped) {
    clientLog("keepalive_stopped");
  }
}

function buildReconnectResume(reason) {
  if (!activeResponseId && !activeAudioResponseId && toolCallsInFlight === 0 && !awaitingToolResponse) {
    return null;
  }

  return {
    reason,
    userTranscript: lastUserTranscript,
    toolArgs: lastToolArgs,
    toolOutput: lastToolOutput,
    hadActiveResponse: Boolean(activeResponseId),
    hadActiveAudio: Boolean(activeAudioResponseId),
    hadToolWork: toolCallsInFlight > 0 || awaitingToolResponse,
  };
}

function resumeDroppedAnswer() {
  if (!pendingReconnectResume || !dc || dc.readyState !== "open") {
    return;
  }

  const resume = pendingReconnectResume;
  pendingReconnectResume = null;
  const toolSummary = resume.toolOutput
    ? JSON.stringify({
        answer: resume.toolOutput.answer || "",
        result_count: resume.toolOutput.result_count ?? null,
        rows: resume.toolOutput.rows || [],
        sql_query: resume.toolOutput.sql_query || "",
      })
    : "";
  const requestText = [
    "The WebRTC connection dropped while you were answering.",
    "Continue the interrupted spoken answer concisely.",
    retainedContextText("connection drop"),
    resume.userTranscript ? `User request: ${resume.userTranscript}` : "",
    resume.toolArgs?.query ? `Tool query: ${resume.toolArgs.query}` : "",
    toolSummary ? `Tool result JSON: ${toolSummary}` : "If needed, call query_text2sql again for the user's request.",
  ].filter(Boolean).join("\n");

  clientLog("reconnect_resume_sent", {
    reason: resume.reason,
    hasTranscript: Boolean(resume.userTranscript),
    hasToolOutput: Boolean(resume.toolOutput),
  });
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: requestText }],
    },
  });
  sendEvent({ type: "response.create" });
}

function clearRemoteAudioOutput() {
  if (!remoteAudio) {
    return;
  }
  const remoteStream = remoteAudio.srcObject;
  if (remoteStream && typeof remoteStream.getTracks === "function") {
    remoteStream.getTracks().forEach((track) => track.stop());
  }
  try {
    remoteAudio.pause();
  } catch (_error) {
    /* ignore */
  }
  remoteAudio.srcObject = null;
  remoteAudio.removeAttribute("src");
  try {
    remoteAudio.load();
  } catch (_error) {
    /* ignore */
  }
}

function cancelRealtimeOutput(reason = "cancelled") {
  const hadActiveResponse = Boolean(activeResponseId);
  const hadActiveAudio = Boolean(activeAudioResponseId);
  const hadRemoteAudio = Boolean(remoteAudio?.srcObject && !remoteAudio.paused);
  if (dc?.readyState === "open") {
    if (hadActiveResponse) {
      sendEvent({ type: "response.cancel" });
    }
    if (hadActiveAudio || hadRemoteAudio) {
      sendEvent({ type: "output_audio_buffer.clear" });
    }
  }
  activeResponseId = null;
  activeAudioResponseId = null;
  resetSpokenAudioHighlightState();
  resetRealtimeSpokenSubtitles({ clearVisible: spokenSubtitlesEnabled() });
  clearResponseFallback();
  if (hadActiveResponse || hadActiveAudio || hadRemoteAudio) {
    clientLog("realtime_output_cancelled", {
      reason,
      hadActiveResponse,
      hadActiveAudio,
      hadRemoteAudio,
    });
  }
}

function cancelAssistantOutput(reason = "cancelled") {
  clearSubtitleOutput();
  cancelTextChatOutput(reason);
  cancelRealtimeOutput(reason);
  clearRemoteAudioOutput();
}

function cleanupConnection() {
  connectionGeneration += 1;
  clearResponseFallback();
  clearDisconnectWatchdog();
  resetSpokenAudioHighlightState();
  stopKeepAlive();
  if (microphoneEnableTimer) {
    clearTimeout(microphoneEnableTimer);
    microphoneEnableTimer = null;
  }
  dc?.close();
  pc?.close();
  localStream?.getTracks().forEach((track) => track.stop());
  clearRemoteAudioOutput();
  dc = undefined;
  pc = undefined;
  localStream = undefined;
  localAudioTrack = undefined;
  activeResponseId = null;
  activeAudioResponseId = null;
  structuredCardFocusActive = false;
  spokenSubtitlesActive = false;
  userTranscriptSubtitlesActive = false;
  resetRealtimeSpokenSubtitles();
  toolCallsInFlight = 0;
  awaitingToolResponse = false;
}

function scheduleReconnect(reason, delayMs = 1500) {
  if (manuallyStopped || reconnectTimer || reconnectInProgress) {
    return;
  }

  pendingReconnectResume ||= buildReconnectResume(reason);

  if (reconnectAttempts >= maxReconnectAttempts) {
    setStatus("Disconnected", "error");
    log("connection", "Realtime disconnected. Click Start to create a new session.");
    clientLog("reconnect_abandoned", { reason, reconnectAttempts }, "error");
    cleanupConnection();
    setSessionRunning(false);
    return;
  }

  reconnectAttempts += 1;

  setStatus("Reconnecting", "error");
  log("connection", `reconnecting after ${reason} (attempt ${reconnectAttempts})`);
  clientLog("reconnect_scheduled", { reason, delayMs, reconnectAttempts }, "error");

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (manuallyStopped) {
      return;
    }
    // Self-heal check: if the peer recovered while we were waiting,
    // do NOT tear down the working connection.
    if (
      pc &&
      pc.connectionState === "connected" &&
      dc &&
      dc.readyState === "open"
    ) {
      clientLog("reconnect_aborted_self_healed", {
        reason,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        dataChannelState: dc.readyState,
        reconnectAttempts,
      });
      reconnectAttempts = Math.max(0, reconnectAttempts - 1);
      pendingReconnectResume = null;
      setStatus("Connected", "live");
      return;
    }
    reconnectInProgress = true;
    cleanupConnection();
    start({ reconnecting: true }).catch((error) => {
      clientLog("reconnect_failed", { name: error.name, message: error.message }, "error");
      setStatus("Disconnected", "error");
      setSessionRunning(false);
      log("reconnect failed", error.message);
    }).finally(() => {
      reconnectInProgress = false;
    });
  }, delayMs);
}

function clearDictationMonitor() {
  if (dictationMaxTimer) {
    clearTimeout(dictationMaxTimer);
    dictationMaxTimer = null;
  }
  if (dictationAnimationFrame) {
    cancelAnimationFrame(dictationAnimationFrame);
    dictationAnimationFrame = null;
  }
  dictationAnalyser = null;
  if (dictationAudioContext) {
    dictationAudioContext.close().catch(() => {});
    dictationAudioContext = null;
  }
  dictationSilenceStartedAt = null;
}

function stopDictationTracks() {
  dictationStream?.getTracks().forEach((track) => track.stop());
  dictationStream = undefined;
}

function resetDictationCaptureState() {
  dictationRecorder = undefined;
  dictationChunks = [];
  dictationMimeType = "";
  dictationStopReason = "";
  dictationDiscard = false;
  dictationRecordStartedAt = 0;
  dictationSpeechDetected = false;
}

function startDictationSilenceMonitor(stream, generation) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    return;
  }

  try {
    dictationAudioContext = new AudioContextConstructor();
    const source = dictationAudioContext.createMediaStreamSource(stream);
    dictationAnalyser = dictationAudioContext.createAnalyser();
    dictationAnalyser.fftSize = 2048;
    source.connect(dictationAnalyser);
  } catch (error) {
    clientLog("dictation_monitor_error", { name: error.name, message: error.message }, "error");
    return;
  }

  const samples = new Uint8Array(dictationAnalyser.fftSize);
  const tick = () => {
    if (generation !== dictationGeneration || !dictationActive || !dictationAnalyser) {
      return;
    }

    dictationAnalyser.getByteTimeDomainData(samples);
    let sumSquares = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / samples.length);
    const now = Date.now();

    if (rms >= dictationSilenceThreshold) {
      dictationSpeechDetected = true;
      dictationSilenceStartedAt = null;
    } else if (dictationSpeechDetected) {
      dictationSilenceStartedAt ||= now;
      if (now - dictationSilenceStartedAt >= dictationSilenceMs) {
        stopIdleDictation("silence");
        return;
      }
    } else if (now - dictationRecordStartedAt >= dictationNoSpeechMs) {
      stopIdleDictation("no speech");
      return;
    }

    dictationAnimationFrame = requestAnimationFrame(tick);
  };

  dictationAnimationFrame = requestAnimationFrame(tick);
}

function stopIdleDictation(reason = "manual", { discard = false } = {}) {
  if (!dictationActive) {
    return;
  }

  dictationStopReason = reason;
  dictationDiscard = dictationDiscard || discard;
  dictationActive = false;
  dictationTranscribing = !dictationDiscard;
  clearDictationMonitor();
  setStatus(dictationDiscard ? "Idle" : "Transcribing speech", dictationDiscard ? "idle" : "live");
  updateSessionButtons();

  if (dictationRecorder && dictationRecorder.state !== "inactive") {
    try {
      dictationRecorder.requestData();
    } catch (error) {
      clientLog("dictation_request_data_error", { name: error.name, message: error.message }, "error");
    }
    dictationRecorder.stop();
  } else {
    finishIdleDictation(dictationGeneration).catch((error) => {
      log("dictation finish error", error.message);
    });
  }
}

async function finishIdleDictation(generation) {
  const chunks = dictationChunks.slice();
  const mimeType = dictationMimeType || dictationRecorder?.mimeType || chunks[0]?.type || "audio/webm";
  const stopReason = dictationStopReason;
  const discard = dictationDiscard;

  stopDictationTracks();
  if (discard || generation !== dictationGeneration) {
    dictationTranscribing = false;
    clearDictationMonitor();
    resetDictationCaptureState();
    updateSessionButtons();
    releaseWakeLock("dictation");
    return;
  }

  if (!chunks.length) {
    dictationTranscribing = false;
    resetDictationCaptureState();
    setStatus("No speech detected", "error");
    showSubtitleText("I could not hear a question.");
    clientLog("dictation_empty", { stopReason }, "error");
    updateSessionButtons();
    releaseWakeLock("dictation");
    return;
  }

  const audioBlob = new Blob(chunks, { type: mimeType });
  if (!audioBlob.size) {
    dictationTranscribing = false;
    resetDictationCaptureState();
    setStatus("No speech detected", "error");
    showSubtitleText("I could not hear a question.");
    clientLog("dictation_empty_blob", { stopReason }, "error");
    updateSessionButtons();
    releaseWakeLock("dictation");
    return;
  }

  dictationAbortController = new AbortController();
  try {
    clientLog("dictation_transcribe_sent", {
      bytes: audioBlob.size,
      mimeType: audioBlob.type,
      stopReason,
      durationMs: Date.now() - dictationRecordStartedAt,
    });
    const output = await callAudioTranscription(audioBlob, dictationAbortController.signal);
    if (generation !== dictationGeneration) {
      return;
    }
    const transcript = String(output.text || "").trim();
    if (!transcript) {
      setStatus("No speech detected", "error");
      showSubtitleText("I could not hear a question.");
      clientLog("dictation_transcript_empty", { model: output.model || "" }, "error");
      return;
    }

    clientLog("dictation_transcribed", {
      model: output.model || "",
      length: transcript.length,
    });
    await sendTextChatMessage(transcript, { source: "dictation" });
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    const message = `Dictation failed: ${error.message}`;
    showSubtitleText(message);
    setStatus("Dictation error", "error");
    log("dictation error", error.message);
    clientLog("dictation_error", { error: error.message }, "error");
  } finally {
    if (generation === dictationGeneration) {
      dictationTranscribing = false;
      dictationAbortController = null;
      resetDictationCaptureState();
      updateSessionButtons();
      releaseWakeLock("dictation");
    }
  }
}

async function startIdleDictation() {
  if (sessionRunning || dictationActive || dictationTranscribing || textChatInFlight) {
    return;
  }

  const unavailableReason = dictationUnavailableReason();
  if (unavailableReason) {
    throw new Error(unavailableReason);
  }

  const generation = ++dictationGeneration;
  dictationDiscard = false;
  dictationChunks = [];
  dictationMimeType = chooseDictationMimeType();
  dictationRecordStartedAt = Date.now();
  dictationSpeechDetected = false;
  dictationSilenceStartedAt = null;

  setConversationActive(true);
  setStatus("Requesting microphone", "live");
  updateSessionButtons();
  requestWakeLock("dictation");

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (generation !== dictationGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const recorderOptions = dictationMimeType ? { mimeType: dictationMimeType } : {};
    const recorder = new MediaRecorder(stream, recorderOptions);
    dictationStream = stream;
    dictationRecorder = recorder;
    dictationMimeType = recorder.mimeType || dictationMimeType || "audio/webm";

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) {
        dictationChunks.push(event.data);
      }
    });
    recorder.addEventListener("stop", () => {
      finishIdleDictation(generation).catch((error) => {
        log("dictation finish error", error.message);
      });
    }, { once: true });
    recorder.addEventListener("error", (event) => {
      clientLog("dictation_recorder_error", {
        name: event.error?.name || "",
        message: event.error?.message || "Recorder error",
      }, "error");
      stopIdleDictation("recorder error");
    });

    recorder.start(250);
    dictationActive = true;
    dictationTranscribing = false;
    setStatus("Dictation listening", "live");
    updateSessionButtons();
    startDictationSilenceMonitor(stream, generation);
    dictationMaxTimer = window.setTimeout(() => {
      stopIdleDictation("max duration");
    }, dictationMaxMs);
    clientLog("dictation_started", { mimeType: dictationMimeType });
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    dictationActive = false;
    dictationTranscribing = false;
    resetDictationCaptureState();
    updateSessionButtons();
    releaseWakeLock("dictation");
    throw error;
  }
}

function cancelIdleDictation(reason = "dictation cancelled") {
  dictationGeneration += 1;
  dictationAbortController?.abort();
  dictationAbortController = null;
  if (dictationActive) {
    stopIdleDictation(reason, { discard: true });
  } else {
    clearDictationMonitor();
    stopDictationTracks();
    dictationActive = false;
    dictationTranscribing = false;
    resetDictationCaptureState();
    updateSessionButtons();
    releaseWakeLock("dictation");
  }
}

function setMicrophoneEnabled(enabled) {
  if (localAudioTrack) {
    localAudioTrack.enabled = enabled;
  }
  updateMicrophoneToggle();
  const microphoneState = enabled ? "enabled" : userMicrophoneOpen ? "muted during tool work" : "closed by user";
  log("microphone", microphoneState);
  clientLog("microphone", {
    enabled,
    activeResponseId,
    activeAudioResponseId,
    toolCallsInFlight,
    awaitingToolResponse,
  });

  if (microphoneEnableTimer) {
    clearTimeout(microphoneEnableTimer);
    microphoneEnableTimer = null;
  }

  if (!enabled) {
    microphoneEnableTimer = window.setTimeout(() => {
      microphoneEnableTimer = null;
      if (localAudioTrack && canEnableMicrophone()) {
        localAudioTrack.enabled = true;
        updateMicrophoneToggle();
        log("microphone", "auto re-enabled after audio watchdog");
        clientLog("microphone_watchdog_reenabled", {
          activeResponseId,
          activeAudioResponseId,
          toolCallsInFlight,
          awaitingToolResponse,
        });
      } else {
        clientLog("microphone_watchdog_deferred", {
          activeResponseId,
          activeAudioResponseId,
          toolCallsInFlight,
          awaitingToolResponse,
        });
      }
    }, 30000);
  }
}

function canEnableMicrophone() {
  return userMicrophoneOpen && toolCallsInFlight === 0 && !awaitingToolResponse;
}

function syncMicrophone(reason) {
  const enabled = canEnableMicrophone();
  setMicrophoneEnabled(enabled);
  clientLog("microphone_sync", {
    reason,
    enabled,
    activeResponseId,
    activeAudioResponseId,
    toolCallsInFlight,
    awaitingToolResponse,
  });
}

function toggleMicrophone() {
  if (!sessionRunning) {
    if (dictationActive) {
      stopIdleDictation("manual");
      return;
    }
    // Supersede any in-flight transcription / text answer (or typed text) so a click
    // starts a fresh question immediately instead of waiting for the previous answer.
    if (dictationTranscribing || textChatInFlight || hasQuestionText()) {
      cancelIdleDictation("superseded by new dictation");
      cancelAssistantOutput("superseded by new dictation");
      questionInput.value = "";
      syncQuestionInputUi();
    }
    startIdleDictation().catch((error) => {
      const permissionDenied =
        error.name === "NotAllowedError" ||
        error.name === "SecurityError" ||
        error.message.toLowerCase().includes("permission denied");

      if (permissionDenied) {
        setStatus("Microphone permission denied", "error");
        clientLog("dictation_microphone_permission_denied", {
          name: error.name,
          message: error.message,
        }, "error");
        log(
          "microphone permission denied",
          "Allow microphone access for this site, or open http://127.0.0.1:3000 in Chrome/Edge and allow the microphone prompt."
        );
        return;
      }

      const unsupported =
        error.message.toLowerCase().includes("not supported") ||
        error.message.toLowerCase().includes("requires https") ||
        error.message.toLowerCase().includes("format not supported");
      setStatus(unsupported ? "Dictation not supported here" : "Dictation failed", "error");
      clientLog("dictation_start_error", { name: error.name, message: error.message }, "error");
      log("dictation start error", error.message);
    });
    return;
  }

  if (!localAudioTrack) {
    return;
  }
  userMicrophoneOpen = !userMicrophoneOpen;
  syncMicrophone("manual microphone toggle");
  log("microphone switch", userMicrophoneOpen ? "open" : "closed");
}

function toggleLook() {
  userLookOpen = !userLookOpen;
  updateLookToggle();
  log("look switch", userLookOpen ? "open" : "closed");
  clientLog("look_toggle", { enabled: userLookOpen });
}

function compactWikipediaContent(detail, { verbose = false } = {}) {
  const sections = Array.isArray(detail?.wikipedia_content) ? detail.wikipedia_content : [];
  const compact = [];
  const maxSections = verbose ? verboseWikipediaMaxSections : defaultWikipediaMaxSections;
  const maxChars = verbose ? verboseWikipediaMaxChars : defaultWikipediaMaxChars;
  for (const section of sections) {
    if (!section || typeof section !== "object") {
      continue;
    }
    const title = String(section.title || section.TITLE || "").trim();
    let content = String(section.content || section.CONTENT || "").trim();
    if (!content) {
      continue;
    }
    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars).trimEnd()}...`;
    }
    compact.push({ title, content });
    if (compact.length >= maxSections) {
      break;
    }
  }
  return compact;
}

function compactDetailForModel(output, fallbackEntity, { verbose = false } = {}) {
  const detail = output?.detail && typeof output.detail === "object" ? output.detail : null;
  if (!detail) {
    return output;
  }
  const { wikipedia_content: _wikipediaContent, ...compactDetail } = detail;
  return {
    error: output.error || "",
    entity: output.entity || fallbackEntity || "",
    id_name: output.id_name || "",
    id: output.id || "",
    endpoint: output.endpoint || "",
    ui_language: output.ui_language || "",
    detail: compactDetail,
    wikipedia_content: compactWikipediaContent(detail, { verbose }),
    wikipedia_content_mode: verbose ? "verbose" : "compact",
  };
}

async function callText2Sql(args) {
  const uiLanguage = normalizeUiLanguage(
    args.ui_language ||
    detectUiLanguageFromText(args.query || lastUserTranscript)
  );
  activeUiLanguage = uiLanguage;
  const response = await fetch(appUrl("tool/text2sql"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: args.query,
      ui_language: uiLanguage,
      page: args.page || 1,
      question_hashed: args.question_hashed || null,
    }),
  });

  const rawBody = await response.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { text: rawBody };
  }

  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

async function callEntityDetail(toolName, args) {
  const entity = DETAIL_TOOL_ENTITIES[toolName];
  const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== "";
  const uiLanguage = currentUiLanguage(args);
  let detailPath = "";
  if (entity === "season") {
    const idSerie = args.id_serie ?? args.ID_SERIE;
    const seasonNumber = args.season_number ?? args.SEASON_NUMBER;
    if (!hasValue(idSerie) || !hasValue(seasonNumber)) {
      throw new Error(`Missing id for ${toolName}`);
    }
    detailPath = `tool/detail/season/${encodeURIComponent(String(idSerie))}/${encodeURIComponent(String(seasonNumber))}`;
  } else if (entity === "episode") {
    const idSerie = args.id_serie ?? args.ID_SERIE;
    const seasonNumber = args.season_number ?? args.SEASON_NUMBER;
    const episodeNumber = args.episode_number ?? args.EPISODE_NUMBER;
    if (!hasValue(idSerie) || !hasValue(seasonNumber) || !hasValue(episodeNumber)) {
      throw new Error(`Missing id for ${toolName}`);
    }
    detailPath = `tool/detail/episode/${encodeURIComponent(String(idSerie))}/${encodeURIComponent(String(seasonNumber))}/${encodeURIComponent(String(episodeNumber))}`;
  }
  const id =
    args.id ||
    args.wikidata_id ||
    args.ID_WIKIDATA ||
    args.ID_MOVIE ||
    args.ID_SERIE ||
    args.ID_PERSON ||
    args.ID_COMPANY ||
    args.ID_NETWORK ||
    args.ID_T2S_COLLECTION ||
    args.ID_TOPIC ||
    args.ID_T2S_LIST ||
    args.ID_MOVEMENT ||
    args.ID_TECHNICAL ||
    args.ID_GROUP ||
    args.ID_DEATH ||
    args.ID_AWARD ||
    args.ID_NOMINATION;
  if (!entity || (!detailPath && !id)) {
    throw new Error(`Missing id for ${toolName}`);
  }

  const detailUrl = new URL(
    appUrl(detailPath || `tool/detail/${encodeURIComponent(entity)}/${encodeURIComponent(String(id))}`)
  );
  detailUrl.searchParams.set("ui_language", uiLanguage);
  const collection = String(args.collection || "").trim();
  if (collection) {
    detailUrl.searchParams.set("collection", collection);
    detailUrl.searchParams.set("page", String(args.page || 1));
  }
  if (args.rows_per_page !== null && args.rows_per_page !== undefined && String(args.rows_per_page).trim() !== "") {
    detailUrl.searchParams.set("rows_per_page", String(args.rows_per_page));
  }
  const response = await fetch(detailUrl.toString());

  const rawBody = await response.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { text: rawBody };
  }

  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

function parseFunctionCallArgs(item) {
  try {
    return JSON.parse(item.arguments || "{}");
  } catch {
    return {};
  }
}

function sendFunctionCallOutput(callId, output) {
  return sendEvent({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output),
    },
  });
}

function requestRealtimeResponseAfterToolOutput() {
  if (!activeResponseId) {
    sendEvent({ type: "response.create" });
  } else {
    window.setTimeout(() => {
      if (!activeResponseId) {
        sendEvent({ type: "response.create" });
      }
    }, 250);
  }
}

function handleStructuredCardFocusCall(item, args) {
  const requestedIndex = Number(args.index);
  const cardCount = resultCardCount();
  const visibleResults = currentVisibleResultCards();
  const enabled = structuredCardFocusEnabled();
  const focusedResult = visibleResults.find((result) => result.index === requestedIndex) || null;
  const validIndex = Boolean(focusedResult);
  const output = {
    ok: Boolean(enabled && validIndex),
    enabled,
    index: validIndex ? requestedIndex : null,
    title: focusedResult?.title || "",
    result_count: cardCount,
    visible_result_count: visibleResults.length,
  };

  if (enabled && validIndex) {
    setActiveSpokenCard(requestedIndex);
  } else if (!enabled) {
    output.error = "Structured card focus is disabled for this session.";
  } else {
    output.error = "No visible result card exists for that index.";
  }

  awaitingToolResponse = true;
  clientLog("structured_card_focus", {
    call_id: item.call_id,
    requestedIndex,
    enabled,
    ok: output.ok,
    result_count: cardCount,
    visible_result_count: visibleResults.length,
  }, output.ok ? "info" : "error");
  sendFunctionCallOutput(item.call_id, output);
  requestRealtimeResponseAfterToolOutput();
  syncMicrophone("structured card focus output sent");
}

async function handleFunctionCall(item) {
  if (
    item?.type !== "function_call" ||
    (
      item.name !== "query_text2sql" &&
      item.name !== STRUCTURED_CARD_FOCUS_TOOL &&
      !DETAIL_TOOL_ENTITIES[item.name]
    )
  ) {
    return;
  }
  if (handledCallIds.has(item.call_id)) {
    return;
  }
  handledCallIds.add(item.call_id);

  const args = parseFunctionCallArgs(item);
  if (item.name === STRUCTURED_CARD_FOCUS_TOOL) {
    handleStructuredCardFocusCall(item, args);
    return;
  }
  args.ui_language = item.name === "query_text2sql"
    ? detectUiLanguageFromText(lastUserTranscript || args.query)
    : normalizeUiLanguage(activeUiLanguage || currentSearchState?.ui_language || "en");

  log("tool call", { name: item.name, args });
  lastToolArgs = args;
  toolCallsInFlight += 1;
  syncMicrophone("tool call started");
  clientLog("tool_call_start", { name: item.name, args, call_id: item.call_id });
  if (item.name === "query_text2sql") {
    setLoadingResults(args.query, args.ui_language);
  } else {
    setLoadingEntityDetail(item.name, args);
  }
  let output;
  try {
    output = item.name === "query_text2sql"
      ? await callText2Sql(args)
      : await callEntityDetail(item.name, args);
    clientLog("tool_call_success", {
      name: item.name,
      call_id: item.call_id,
      result_count: output.result_count,
      has_more: output.has_more,
      page: output.page,
      entity: output.entity,
      id: output.id,
      diagnostic: output.diagnostic ?? null,
    });
    if (item.name === "query_text2sql") {
      await renderText2SqlResult(output, args);
    } else {
      renderEntityDetailOutput(output, args);
    }
  } catch (error) {
    output = { error: error.message };
    clientLog("tool_call_error", { name: item.name, call_id: item.call_id, error: error.message }, "error");
    if (item.name === "query_text2sql") {
      await renderText2SqlResult(output, args);
    } else {
      renderEntityDetailOutput(output, args);
    }
  }

  toolCallsInFlight = Math.max(0, toolCallsInFlight - 1);
  awaitingToolResponse = true;
  const toolOutput = item.name === "query_text2sql"
    ? {
        answer: output.answer || "",
        error: output.error || "",
        result_count: output.result_count ?? null,
        // VOICE-AGENT-086: hand the model the pagination signal so it doesn't report the
        // first-page count (≤ rows_per_page, e.g. 50) as a definitive total. Without these
        // the Realtime model only saw result_count and said "there are 50 movies".
        rows_per_page: output.rows_per_page ?? null,
        has_more: Boolean(output.has_more),
        visible_results: structuredCardFocusEnabled() ? currentVisibleResultCards() : [],
        rows: output.rows || [],
        sql_query: output.sql_query || "",
        diagnostic: output.diagnostic || null,
      }
    : {
        error: output.error || "",
        entity: output.entity || DETAIL_TOOL_ENTITIES[item.name],
        id_name: output.id_name || "",
        id: output.id || args.id || args.wikidata_id || "",
        endpoint: output.endpoint || "",
        ui_language: output.ui_language || args.ui_language || "",
        detail: output.detail || null,
      };
  const verboseDetailRequest = DETAIL_TOOL_ENTITIES[item.name] && isVerboseDetailRequest(lastUserTranscript);
  const modelToolOutput = item.name === "query_text2sql"
    ? toolOutput
    : compactDetailForModel(toolOutput, DETAIL_TOOL_ENTITIES[item.name], { verbose: verboseDetailRequest });
  lastToolOutput = toolOutput;
  addRetainedContext({
    type: "tool",
    tool_name: item.name,
    ...(item.name === "query_text2sql"
      ? compactToolContext(args, toolOutput)
      : {
          entity: toolOutput.entity,
          id: toolOutput.id,
          endpoint: toolOutput.endpoint,
          ui_language: toolOutput.ui_language,
          error: toolOutput.error,
        }),
  });

  sendFunctionCallOutput(item.call_id, modelToolOutput);
  requestRealtimeResponseAfterToolOutput();
  syncMicrophone("tool output sent");
}

async function handleServerEvent(event) {
  log(event.type, event);
  clientLog("realtime_event", summarizeRealtimeEvent(event), event.type === "error" ? "error" : "info");

  if (event.type === "input_audio_buffer.speech_started") {
    if (activeResponseId || activeAudioResponseId) {
      resetSpokenAudioHighlightState();
      resetRealtimeSpokenSubtitles({ clearVisible: spokenSubtitlesEnabled() });
    }
    if (!canEnableMicrophone()) {
      clientLog("speech_started_while_muted", {
        activeResponseId,
        activeAudioResponseId,
        toolCallsInFlight,
        awaitingToolResponse,
      });
      return;
    }
    setStatus("Listening", "live");
  }

  if (event.type === "input_audio_buffer.committed") {
    setStatus("Thinking", "live");
    scheduleResponseFallback();
  }

  if (event.type === "conversation.item.input_audio_transcription.delta") {
    const current = inputTranscripts.get(event.item_id) || "";
    inputTranscripts.set(event.item_id, `${current}${event.delta || ""}`);
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const transcript = event.transcript || inputTranscripts.get(event.item_id) || "";
    if (transcript.trim()) {
      lastUserTranscript = transcript.trim();
      activeUiLanguage = detectUiLanguageFromText(lastUserTranscript);
      addRetainedContext({ type: "user", text: lastUserTranscript });
      clientLog("user_transcript", { item_id: event.item_id, transcript: lastUserTranscript });
      showUserSubtitleText(lastUserTranscript);
    }
    inputTranscripts.delete(event.item_id);
  }

  if (event.type === "response.output_audio_transcript.done") {
    const transcript = event.transcript || "";
    if (transcript.trim()) {
      addRetainedContext({ type: "assistant", text: transcript.trim() });
      clientLog("assistant_transcript", { item_id: event.item_id, transcript: transcript.trim() });
      assistantSpokenHighlightBuffer = transcript.trim();
      enqueueSpokenAudioHighlightCues(assistantSpokenHighlightBuffer);
      completeRealtimeSpokenSubtitle(transcript);
    }
  }

  if (
    event.type === "response.output_audio_transcript.delta" ||
    event.type === "response.audio_transcript.delta"
  ) {
    const delta = event.delta || "";
    syncSpokenCardHighlightFromTranscriptDelta(delta);
    appendRealtimeSpokenSubtitleDelta(delta);
  }

  if (event.type === "response.created") {
    activeResponseId = event.response?.id || null;
    resetSpokenAudioHighlightState();
    resetRealtimeSpokenSubtitles({ clearVisible: spokenSubtitlesEnabled() });
    awaitingToolResponse = false;
    clearResponseFallback();
    syncMicrophone("response created");
    setStatus("Responding", "live");
  }

  if (event.type === "output_audio_buffer.started") {
    activeAudioResponseId = event.response_id || activeResponseId;
    startSpokenAudioHighlightPlayback();
    startRealtimeSpokenSubtitlePlayback();
    syncMicrophone("audio playback started");
  }

  if (event.type === "output_audio_buffer.stopped") {
    if (!event.response_id || event.response_id === activeAudioResponseId) {
      activeAudioResponseId = null;
    }
    resetSpokenAudioHighlightState();
    stopRealtimeSpokenSubtitlePlayback();
    syncMicrophone("audio playback stopped");
  }

  if (event.type === "response.done") {
    const responseId = event.response?.id || event.response_id || null;
    if (!responseId || responseId === activeResponseId) {
      activeResponseId = null;
    }
    clearResponseFallback();
    setStatus("Connected", "live");

    const output = event.response?.output || [];
    for (const item of output) {
      await handleFunctionCall(item);
    }
    syncMicrophone("response done");
  }

  if (event.type === "error") {
    if (event.error?.code === "conversation_already_has_active_response") {
      log("response timing", "Realtime still has an active response; waiting for it to finish.");
      return;
    }
    setStatus("Error", "error");
  }
}

async function start({ reconnecting = false } = {}) {
  dismissLaunchShowcase();
  if (dictationActive || dictationTranscribing) {
    cancelIdleDictation("start voice session");
  }
  manuallyStopped = false;
  setConversationActive(true);
  if (!reconnecting) {
    reconnectAttempts = 0;
    reconnectInProgress = false;
    clearReconnectTimer();
  }
  setSessionRunning(true);
  handledCallIds.clear();
  setStatus(reconnecting ? "Reconnecting" : "Requesting microphone");
  clientLog("realtime_support", {
    ...realtimeSupportSnapshot(reconnecting ? "reconnect start" : "start"),
    structuredCardFocusRequested: structuredCardFocusRequested(),
    spokenSubtitlesRequested: spokenSubtitlesRequested(),
    userTranscriptSubtitlesRequested: userTranscriptSubtitlesRequested(),
  });
  requestWakeLock(reconnecting ? "reconnect start" : "start");

  const PeerConnection = getPeerConnectionConstructor();
  if (!PeerConnection) {
    const message = explainWebRtcUnavailable();
    clientLog("webrtc_unavailable", realtimeSupportSnapshot("start"), "error");
    setSessionRunning(false);
    throw new Error(message);
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setSessionRunning(false);
    throw new Error("Microphone is not supported in this browser. Use typed questions here, or use voice on iPhone Safari.");
  }

  const generation = ++connectionGeneration;
  const nextPc = new PeerConnection();
  pc = nextPc;
  nextPc.addEventListener("connectionstatechange", () => {
    if (generation !== connectionGeneration) {
      return;
    }
    const connectionState = nextPc.connectionState;
    const iceConnectionState = nextPc.iceConnectionState;
    clientLog("peer_connection_state", {
      connectionState,
      iceConnectionState,
      signalingState: nextPc.signalingState,
    });
    if (connectionState === "failed") {
      clearDisconnectWatchdog();
      logPeerStats("connection failed", nextPc);
      scheduleReconnect("peer connection failed", 500);
    } else if (connectionState === "disconnected") {
      logPeerStats("connection disconnected", nextPc);
      // "disconnected" is officially transient per the WebRTC spec.
      // Give the peer a chance to recover on its own before tearing
      // down the session, instead of forcing a costly rebuild that
      // discards mid-answer state.
      if (!disconnectWatchdogTimer) {
        disconnectWatchdogTimer = window.setTimeout(() => {
          disconnectWatchdogTimer = null;
          if (generation !== connectionGeneration || manuallyStopped) {
            return;
          }
          const stillBad =
            nextPc.connectionState === "disconnected" ||
            nextPc.connectionState === "failed";
          clientLog("disconnect_watchdog_check", {
            connectionState: nextPc.connectionState,
            iceConnectionState: nextPc.iceConnectionState,
            dataChannelState: dc?.readyState || null,
            stillBad,
          });
          if (stillBad) {
            scheduleReconnect("peer connection disconnected (watchdog)", 500);
          }
        }, disconnectGracePeriodMs);
      }
    } else if (connectionState === "connected") {
      clearDisconnectWatchdog();
      clearReconnectTimer();
      reconnectInProgress = false;
      reconnectAttempts = 0;
      logPeerStats("connection connected", nextPc);
    }
  });
  nextPc.addEventListener("iceconnectionstatechange", () => {
    if (generation !== connectionGeneration) {
      return;
    }
    clientLog("ice_connection_state", {
      iceConnectionState: nextPc.iceConnectionState,
      connectionState: nextPc.connectionState,
      signalingState: nextPc.signalingState,
    });
  });
  nextPc.addEventListener("icegatheringstatechange", () => {
    if (generation !== connectionGeneration) {
      return;
    }
    clientLog("ice_gathering_state", {
      iceGatheringState: nextPc.iceGatheringState,
      connectionState: nextPc.connectionState,
    });
  });
  nextPc.addEventListener("signalingstatechange", () => {
    if (generation !== connectionGeneration) {
      return;
    }
    clientLog("signaling_state", {
      signalingState: nextPc.signalingState,
      connectionState: nextPc.connectionState,
      iceConnectionState: nextPc.iceConnectionState,
    });
  });
  nextPc.ontrack = (event) => {
    if (generation !== connectionGeneration) {
      return;
    }
    remoteAudio.srcObject = event.streams[0];
    clientLog("remote_audio_track", { streams: event.streams.length });
    event.streams[0]?.getAudioTracks().forEach((track) => attachTrackDiagnostics(track, "remote audio"));
  };

  const nextDc = nextPc.createDataChannel("oai-events");
  dc = nextDc;
  nextDc.addEventListener("open", () => {
    if (generation !== connectionGeneration) {
      return;
    }
    setStatus("Connected", "live");
    log("data channel open");
    clientLog("data_channel_open");
    startKeepAlive();
    seedRetainedContext(reconnecting ? "reconnect" : "new session");
    const queuedTextTurns = pendingRealtimeTextTurns.splice(0);
    for (const [index, queuedText] of queuedTextTurns.entries()) {
      addRetainedContext({ type: "user", text: queuedText });
      sendTypedRealtimeTurn(queuedText, { createResponse: index === queuedTextTurns.length - 1 });
    }
    if (reconnecting && pendingReconnectResume) {
      window.setTimeout(() => {
        if (generation === connectionGeneration) {
          resumeDroppedAnswer();
        }
      }, 750);
    }
  });
  nextDc.addEventListener("close", () => {
    if (generation !== connectionGeneration) {
      return;
    }
    clientLog("data_channel_close", { readyState: nextDc.readyState || null });
    if (!manuallyStopped) {
      scheduleReconnect("data channel closed", 500);
    }
  });
  nextDc.addEventListener("error", (event) => {
    if (generation !== connectionGeneration) {
      return;
    }
    clientLog("data_channel_error", { message: event.message || "data channel error" }, "error");
  });
  nextDc.addEventListener("message", (event) => {
    if (generation !== connectionGeneration) {
      return;
    }
    handleServerEvent(JSON.parse(event.data)).catch((error) => {
      log("event handler error", error.message);
    });
  });

  const nextLocalStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  if (generation !== connectionGeneration) {
    nextLocalStream.getTracks().forEach((track) => track.stop());
    return;
  }
  localStream = nextLocalStream;
  localAudioTrack = nextLocalStream.getAudioTracks()[0];
  clientLog("microphone_track_acquired", {
    label: localAudioTrack.label,
    enabled: localAudioTrack.enabled,
    muted: localAudioTrack.muted,
    readyState: localAudioTrack.readyState,
  });
  attachTrackDiagnostics(localAudioTrack, "microphone");
  syncMicrophone("microphone track acquired");
  nextPc.addTrack(localAudioTrack, nextLocalStream);

  const offer = await nextPc.createOffer();
  await nextPc.setLocalDescription(offer);

  setStatus("Creating Realtime call");
  structuredCardFocusActive = false;
  spokenSubtitlesActive = false;
  userTranscriptSubtitlesActive = false;
  const sdpResponse = await fetch(realtimeSessionUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });

  const answerSdp = await sdpResponse.text();
  if (!sdpResponse.ok) {
    throw new Error(answerSdp);
  }
  structuredCardFocusActive = sdpResponse.headers.get("X-Structured-Card-Focus") === "1";
  spokenSubtitlesActive = sdpResponse.headers.get("X-Spoken-Subtitles") === "1";
  userTranscriptSubtitlesActive = sdpResponse.headers.get("X-User-Transcript-Subtitles") === "1";
  clientLog("structured_card_focus_session", {
    requested: structuredCardFocusRequested(),
    active: structuredCardFocusActive,
  });
  clientLog("spoken_subtitles_session", {
    requested: spokenSubtitlesRequested(),
    active: spokenSubtitlesActive,
  });
  clientLog("user_transcript_subtitles_session", {
    requested: userTranscriptSubtitlesRequested(),
    active: userTranscriptSubtitlesActive,
  });

  const callId = sdpResponse.headers.get("X-OpenAI-Call-ID");
  if (callId) {
    log("call id", callId);
  }

  if (generation !== connectionGeneration) {
    setSessionRunning(false);
    return;
  }
  await nextPc.setRemoteDescription({ type: "answer", sdp: answerSdp });
  setSessionRunning(true);
}

function stop() {
  manuallyStopped = true;
  pendingRealtimeTextTurns = [];
  cancelIdleDictation("stop");
  clearReconnectTimer();
  releaseWakeLock("stop");
  cleanupConnection();
  handledCallIds.clear();
  pendingReconnectResume = null;
  setSessionRunning(false);
  setStatus("Idle");
  log("stopped");
}

// ---------------------------------------------------------------------------
// Launch showcase (sample questions + simulated result previews)
// ---------------------------------------------------------------------------

function launchShowcaseUiLanguage() {
  // The launch showcase has no user query to detect a language from, so it
  // defaults to English.
  return "en";
}

function shuffleArray(items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Walk the /samples category tree into a flat list of {question, category, sim},
// tagging each sample with its top-level category for diversity selection.
function flattenSampleTree(categories, topLabel = "") {
  const flat = [];
  for (const category of Array.isArray(categories) ? categories : []) {
    const label = topLabel || category.DESCRIPTION || "";
    for (const sample of Array.isArray(category.samples) ? category.samples : []) {
      flat.push({
        question: String(sample.QUESTION || "").trim(),
        category: label,
        sim: sample.simulated_result || null,
      });
    }
    if (Array.isArray(category.categories) && category.categories.length) {
      flat.push(...flattenSampleTree(category.categories, label));
    }
  }
  return flat;
}

// Keep samples that have a renderable preview, then round-robin across categories
// so the showcase mixes topics instead of clustering one category.
function selectShowcaseSamples(flat, max = 300) {
  const renderable = flat.filter(
    (sample) =>
      sample.question &&
      sample.sim &&
      Array.isArray(sample.sim.result) &&
      sample.sim.result.length > 0 &&
      (sample.sim.result_kind === "entity_rows" || sample.sim.result_kind === "scalar")
  );
  const byCategory = new Map();
  for (const sample of shuffleArray(renderable)) {
    if (!byCategory.has(sample.category)) {
      byCategory.set(sample.category, []);
    }
    byCategory.get(sample.category).push(sample);
  }
  const queues = shuffleArray([...byCategory.values()]);
  const picked = [];
  let progressed = true;
  while (picked.length < max && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (queue.length) {
        picked.push(queue.shift());
        progressed = true;
        if (picked.length >= max) {
          break;
        }
      }
    }
  }
  return picked;
}

function runShowcaseQuestion(question) {
  const text = String(question || "").trim();
  if (!text) {
    return;
  }
  dismissLaunchShowcase();
  questionInput.value = text;
  syncQuestionInputUi();
  submitQuestion();
}

// One marquee group: a question chip followed inline by its result cards (or a
// single scalar value). Groups are laid out horizontally in a lane and flow
// right-to-left. Returns null when no card/value could be rendered.
function buildShowcaseGroup(sample) {
  const group = document.createElement("div");
  group.className = "showcaseGroup";

  const question = document.createElement("button");
  question.type = "button";
  question.className = "showcaseQuestion";
  // Normalize CR/CRLF to LF so multi-line questions break cleanly under
  // white-space: pre-line; the chip wraps long/multi-line questions and stays
  // single-line for short ones.
  const questionLabel = sample.question.replace(/\r\n?/g, "\n");
  question.textContent = questionLabel;
  question.title = questionLabel;
  question.addEventListener("click", () => runShowcaseQuestion(sample.question));
  group.append(question);

  let rendered = 0;
  if (sample.sim.result_kind === "scalar") {
    const data = sample.sim.result[0]?.data || {};
    const value = Object.values(data)[0];
    const answer = document.createElement("div");
    answer.className = "showcaseScalar";
    answer.textContent = String(value ?? "");
    group.append(answer);
    rendered = 1;
  } else {
    // All samples (including image-query galleries) cap at 8 preview cards. Image-query
    // samples still differ in that each row is one of the entity's *_IMAGE posters/
    // portraits, so the group shows up to 8 posters instead of a single entity card.
    for (const row of sample.sim.result.slice(0, 8)) {
      const record = row?.data || row;
      if (!record || typeof record !== "object") {
        continue;
      }
      const cardSpec = cardSpecFromRecord(record);
      // VOICE-AGENT-068: the showcase is a posters-only teaser wall, so an element with no
      // image would render as an alt-text-only fallback tile and read like a bug. Skip
      // image-less cards here (aggregate cards too). Normal result screens are unaffected —
      // they still render image-less items with their alt text.
      if (!cardSpec || !cardSpec.imageUrl) {
        continue;
      }
      appendCard(group, cardSpec);
      // Showcase cards are posters-only (title text is hidden via CSS); keep the name
      // as a hover tooltip on the card so it stays identifiable and accessible.
      if (cardSpec.title) {
        group.lastElementChild?.setAttribute("title", cardSpec.title);
      }
      rendered += 1;
    }
  }
  return rendered ? group : null;
}

function cancelShowcaseAutoScroll() {
  if (launchShowcaseRaf !== null) {
    cancelAnimationFrame(launchShowcaseRaf);
    launchShowcaseRaf = null;
  }
}

// Horizontal marquee: every lane's track holds two identical copies of its
// groups and is translated leftward, so cards enter from the right, cross the
// screen, and exit on the left, wrapping seamlessly after one copy's width.
// Paused on hover and when the tab is hidden. scrollWidth is read each frame
// because poster images change the width as they load in.
function startShowcaseMarquee(viewport, lanes) {
  cancelShowcaseAutoScroll();
  // Respect reduced-motion: leave the lanes static and manually scrollable (CSS
  // switches each lane to overflow-x: auto).
  if (prefersReducedMotion()) {
    return;
  }
  let last = performance.now();
  let paused = false;
  viewport.addEventListener("mouseenter", () => {
    paused = true;
  });
  viewport.addEventListener("mouseleave", () => {
    paused = false;
  });
  const step = (now) => {
    const delta = (now - last) / 1000;
    last = now;
    if (!paused && !document.hidden) {
      for (const lane of lanes) {
        lane.offset += lane.speed * delta;
        const loopWidth = lane.track.scrollWidth / 2;
        if (loopWidth > 0 && lane.offset >= loopWidth) {
          lane.offset -= loopWidth;
        }
        lane.track.style.transform = `translateX(${-lane.offset}px)`;
      }
    }
    launchShowcaseRaf = requestAnimationFrame(step);
  };
  launchShowcaseRaf = requestAnimationFrame(step);
}

// VOICE-AGENT-074: how many showcase rows (lanes) fit the visible height. The showcase
// viewport is a fixed-height flex column — clamp(320px, 100dvh - 260px, 1100px), 18px gap
// (see .showcaseViewport in styles.css) — and each lane is ~one poster-card tall (a 118px
// poster is ~177px at 2:3, plus the 18px flex gap). Mirror the CSS clamp, then fit as many
// full lanes as the space allows. Recomputed on resize so the wall always fills the height.
function computeShowcaseLaneCount() {
  const viewportHeight = Math.max(320, Math.min(1100, window.innerHeight - 260));
  const laneHeight = 177 + 18; // poster height + flex gap
  return Math.max(2, Math.min(6, Math.floor((viewportHeight + 18) / laneHeight)));
}

// Re-flow the lane count when the window is resized (bound once).
function bindShowcaseResizeReflow() {
  if (showcaseResizeReflowBound) {
    return;
  }
  showcaseResizeReflowBound = true;
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (
        launchShowcase && !launchShowcase.hidden && !launchShowcaseDismissed &&
        launchShowcaseData && resultsPanel.hidden && !sessionRunning && !textChatInFlight
      ) {
        renderLaunchShowcase(launchShowcaseData.categories, launchShowcaseData.uiLanguage, { animate: false });
      }
    }, 250);
  });
}

function renderLaunchShowcase(categories, uiLanguage, { animate = false } = {}) {
  bindShowcaseResizeReflow();
  const picked = selectShowcaseSamples(flattenSampleTree(categories), 300);
  if (!picked.length) {
    return;
  }
  activeUiLanguage = normalizeUiLanguage(uiLanguage || activeUiLanguage);

  const heading = document.createElement("p");
  heading.className = "showcaseHeading";
  heading.textContent = activeUiLanguage === "fr" ? "Essayez de demander…" : "Try asking…";

  const viewport = document.createElement("div");
  viewport.className = "showcaseViewport";

  // Spread the groups over as many horizontal lanes as fit the available height, so the
  // wall fills the screen instead of leaving an empty band below (VOICE-AGENT-074).
  const laneCount = computeShowcaseLaneCount();
  const laneSamples = Array.from({ length: laneCount }, () => []);
  picked.forEach((sample, index) => {
    laneSamples[index % laneCount].push(sample);
  });

  const lanes = [];
  laneSamples.forEach((samples, laneIndex) => {
    if (!samples.length) {
      return;
    }
    const lane = document.createElement("div");
    lane.className = "showcaseLane";
    const track = document.createElement("div");
    track.className = "showcaseLaneTrack";
    let rendered = 0;
    // Two identical passes so the leftward scroll wraps seamlessly.
    for (let pass = 0; pass < 2; pass += 1) {
      for (const sample of samples) {
        const group = buildShowcaseGroup(sample);
        if (group) {
          track.append(group);
          rendered += 1;
        }
      }
    }
    if (!rendered) {
      return;
    }
    lane.append(track);
    viewport.append(lane);
    // Vary speed per lane for a natural wall; all clearly faster than before.
    lanes.push({ track, offset: 0, speed: 72 + (laneIndex % 3) * 12 });
  });

  if (!lanes.length) {
    return;
  }

  launchShowcase.replaceChildren(heading, viewport);
  launchShowcase.hidden = false;
  launchShowcase.classList.remove("isEntering");
  if (animate && !prefersReducedMotion()) {
    launchShowcase.classList.add("isEntering");
    window.setTimeout(() => launchShowcase.classList.remove("isEntering"), 700);
  }
  startShowcaseMarquee(viewport, lanes);
}

async function loadLaunchShowcaseData() {
  if (launchShowcaseData) {
    return launchShowcaseData;
  }
  if (launchShowcaseLoadPromise) {
    return launchShowcaseLoadPromise;
  }
  launchShowcaseLoading = true;
  launchShowcaseLoadPromise = (async () => {
    const showcaseUrl = new URL(appUrl("tool/samples"));
    showcaseUrl.searchParams.set("ui_language", launchShowcaseUiLanguage());
    showcaseUrl.searchParams.set("set", "showcase");  // advisor home-screen picks (IS_SHOWCASE=1)
    const response = await fetch(showcaseUrl.toString());
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    launchShowcaseData = {
      categories: Array.isArray(data.categories) ? data.categories : [],
      uiLanguage: data.ui_language,
    };
    return launchShowcaseData;
  })()
    .catch((error) => {
      log("launch showcase load error", error.message);
      return null;
    })
    .finally(() => {
      launchShowcaseLoading = false;
      launchShowcaseLoadPromise = null;
    });
  return launchShowcaseLoadPromise;
}

async function maybeShowLaunchShowcase({ animate = false } = {}) {
  if (launchShowcaseDismissed) {
    return;
  }
  if (!resultsPanel.hidden || sessionRunning || textChatInFlight) {
    return;
  }
  const showcaseData = await loadLaunchShowcaseData();
  if (!showcaseData) {
    return;
  }
  if (launchShowcaseDismissed || !resultsPanel.hidden || sessionRunning || textChatInFlight) {
    return;
  }
  renderLaunchShowcase(showcaseData.categories, showcaseData.uiLanguage, { animate });
}

function dismissLaunchShowcase() {
  cancelShowcaseAutoScroll();
  launchShowcaseDismissed = true;
  if (launchShowcase && !launchShowcase.hidden) {
    launchShowcase.hidden = true;
    launchShowcase.replaceChildren();
  }
}

function launchSplashUiLanguage() {
  return normalizeUiLanguage(activeUiLanguage || launchShowcaseUiLanguage());
}

function pickLaunchSplashHook(uiLanguage) {
  const hooks = launchSplashHooks[normalizeUiLanguage(uiLanguage)] || launchSplashHooks.en;
  return hooks[Math.floor(Math.random() * hooks.length)] || hooks[0];
}

function launchSplashAppName() {
  return String(appTitle?.textContent || document.title || "Voice Movie Database").trim();
}

function renderLaunchSplashContent() {
  const uiLanguage = launchSplashUiLanguage();
  const hookText = pickLaunchSplashHook(uiLanguage);
  const content = document.createElement("div");
  content.className = "launchSplashContent";

  const hook = document.createElement("p");
  hook.className = "launchSplashHook";
  hook.textContent = hookText;

  const name = document.createElement("div");
  name.className = "launchSplashName";
  name.textContent = launchSplashAppName();

  content.append(hook, name);
  launchSplash.replaceChildren(content);
  clientLog("launch_splash_shown", { ui_language: uiLanguage, hook: hookText });
}

function resolveLaunchSplashHold(reason) {
  if (launchSplashHoldTimer !== null) {
    window.clearTimeout(launchSplashHoldTimer);
    launchSplashHoldTimer = null;
  }
  if (launchSplashHoldResolver) {
    const resolve = launchSplashHoldResolver;
    launchSplashHoldResolver = null;
    resolve(reason);
  }
}

function waitForLaunchSplashHold() {
  return new Promise((resolve) => {
    launchSplashHoldResolver = resolve;
    launchSplashHoldTimer = window.setTimeout(() => resolveLaunchSplashHold("timer"), launchSplashHoldMs);
  });
}

function isLaunchSplashActive() {
  return launchSplashActive && !launchSplash.hidden && !launchSplashDone;
}

function skipLaunchSplash(reason = "skip") {
  if (!isLaunchSplashActive()) {
    return;
  }
  launchSplashSkipped = true;
  resolveLaunchSplashHold(reason);
}

function finishAnimation(animation) {
  if (!animation?.finished) {
    return Promise.resolve();
  }
  return animation.finished.catch(() => {});
}

async function animateLaunchSplashTitleToHeader() {
  const splashName = launchSplash.querySelector(".launchSplashName");
  if (!splashName || !appTitle || typeof splashName.getBoundingClientRect !== "function") {
    await delay(launchSplashHandoffMs);
    return;
  }

  const sourceRect = splashName.getBoundingClientRect();
  const targetRect = appTitle.getBoundingClientRect();
  if (!sourceRect.width || !sourceRect.height || !targetRect.width || !targetRect.height) {
    await delay(launchSplashHandoffMs);
    return;
  }

  const previousVisibility = appTitle.style.visibility;
  appTitle.style.visibility = "hidden";
  const targetStyle = window.getComputedStyle(appTitle);
  const flyTitle = document.createElement("div");
  flyTitle.className = "launchSplashTitleFly";
  flyTitle.textContent = launchSplashAppName();
  flyTitle.style.left = `${targetRect.left}px`;
  flyTitle.style.top = `${targetRect.top}px`;
  flyTitle.style.width = `${targetRect.width}px`;
  flyTitle.style.fontFamily = targetStyle.fontFamily;
  flyTitle.style.fontSize = targetStyle.fontSize;
  flyTitle.style.fontWeight = targetStyle.fontWeight;
  flyTitle.style.lineHeight = targetStyle.lineHeight;
  flyTitle.style.letterSpacing = targetStyle.letterSpacing;
  flyTitle.style.color = targetStyle.color;
  document.body.append(flyTitle);

  splashName.style.visibility = "hidden";
  const scale = sourceRect.height / targetRect.height;
  const translateX = sourceRect.left - targetRect.left;
  const translateY = sourceRect.top - targetRect.top;
  const startTransform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  try {
    if (typeof flyTitle.animate !== "function") {
      await delay(launchSplashHandoffMs);
      return;
    }
    const titleAnimation = flyTitle.animate(
      [
        { transform: startTransform, opacity: 1 },
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
      ],
      {
        duration: launchSplashHandoffMs,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "forwards",
      }
    );
    await finishAnimation(titleAnimation);
  } finally {
    flyTitle.remove();
    splashName.style.visibility = "";
    appTitle.style.visibility = previousVisibility;
  }
}

async function animateLaunchSplashHandoff() {
  launchSplash.classList.add("isLeaving");
  await Promise.all([animateLaunchSplashTitleToHeader(), delay(launchSplashHandoffMs)]);
}

function hideLaunchSplash() {
  resolveLaunchSplashHold("hide");
  launchSplash.hidden = true;
  launchSplash.className = "launchSplash";
  launchSplash.replaceChildren();
  document.body.classList.remove("launchSplashOpen");
  launchSplashActive = false;
  launchSplashDone = false;
  launchSplashSkipped = false;
}

async function completeLaunchSplash() {
  if (launchSplashDone) {
    return;
  }
  launchSplashDone = true;
  const skipped = launchSplashSkipped;
  void maybeShowLaunchShowcase({ animate: !launchSplashSkipped && !prefersReducedMotion() });
  if (!launchSplashSkipped && !prefersReducedMotion()) {
    await animateLaunchSplashHandoff();
  }
  hideLaunchSplash();
  clientLog("launch_splash_dismissed", { skipped });
}

async function runLaunchSplash() {
  if (launchSplashHasRun) {
    void maybeShowLaunchShowcase();
    return;
  }
  launchSplashHasRun = true;
  launchSplashActive = true;
  launchSplashDone = false;
  launchSplashSkipped = false;
  document.body.classList.add("launchSplashOpen");
  renderLaunchSplashContent();
  launchSplash.hidden = false;
  launchSplash.focus({ preventScroll: true });
  void loadLaunchShowcaseData();

  const reason = await waitForLaunchSplashHold();
  if (reason !== "timer") {
    launchSplashSkipped = true;
  }
  await completeLaunchSplash();
}

function clearConversationUi() {
  handledCallIds.clear();
  resetSpokenAudioHighlightState();
  resultsPanel.hidden = true;
  clearQueryDetailsDock();
  clearRenderedPageViewSignature();
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
  resetDetailState();
  activeUiLanguage = "en";
  loadingMore = false;
  autoPagesLoaded = 0;
  pendingReconnectResume = null;
  lastUserTranscript = "";
  lastToolArgs = null;
  lastToolOutput = null;
  inputTranscripts.clear();
}

function startNewConversation() {
  manuallyStopped = true;
  pendingRealtimeTextTurns = [];
  cancelIdleDictation("new conversation");
  cancelAssistantOutput("new conversation");
  clearReconnectTimer();
  releaseWakeLock("new conversation");
  cleanupConnection();
  clearConversationUi();
  clearRetainedContext();
  setConversationActive(false);
  clearPageHistory();
  setSessionRunning(false);
  setStatus("Idle");
  log("new conversation");
  clientLog("conversation_reset");
  // Back to the launch state with no user query: bring the showcase back.
  launchShowcaseDismissed = false;
  maybeShowLaunchShowcase();
}

setupPageDiagnostics();
setupRemoteAudioDiagnostics();
clearRetainedContext();
clientLog("realtime_support", realtimeSupportSnapshot("page load"));

startButton.addEventListener("click", () => {
  start().catch((error) => {
    pendingRealtimeTextTurns = [];
    setSessionRunning(false);
    const permissionDenied =
      error.name === "NotAllowedError" ||
      error.name === "SecurityError" ||
      error.message.toLowerCase().includes("permission denied");

    if (permissionDenied) {
      setStatus("Microphone permission denied", "error");
      clientLog("microphone_permission_denied", { name: error.name, message: error.message }, "error");
      log(
        "microphone permission denied",
        "Allow microphone access for this site, or open http://127.0.0.1:3000 in Chrome/Edge and allow the microphone prompt."
      );
      return;
    }

    const unsupported =
      error.message.toLowerCase().includes("not supported") ||
      error.message.toLowerCase().includes("not available") ||
      error.message.toLowerCase().includes("unavailable");
    setStatus(unsupported ? "Voice not supported here" : "Start failed", "error");
    clientLog("start_error", { name: error.name, message: error.message }, "error");
    log("start error", error.message);
  });
});

stopButton.addEventListener("click", stop);
microphoneToggleButton.addEventListener("click", toggleMicrophone);
lookToggleButton.addEventListener("click", toggleLook);
historyBackButton.addEventListener("click", () => {
  goHistory(-1).catch((error) => {
    log("history back error", error.message);
  });
});
historyForwardButton.addEventListener("click", () => {
  goHistory(1).catch((error) => {
    log("history forward error", error.message);
  });
});
questionInput.addEventListener("input", syncQuestionInputUi);
questionInput.addEventListener("input", () => {
  if (questionInput.value.trim()) {
    dismissLaunchShowcase();
  }
});
questionInput.addEventListener("change", syncQuestionInputUi);
questionInput.addEventListener("keyup", syncQuestionInputUi);
questionInput.addEventListener("paste", syncQuestionInputUi);
questionInput.addEventListener("cut", syncQuestionInputUi);
questionInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  submitQuestion();
});
submitQuestionButton.addEventListener("click", submitQuestion);
syncQuestionInputUi();
updateLookToggle();
setSessionRunning(false);
updateHistoryButtons();
newConversationButton.addEventListener("click", startNewConversation);
if (appMenuButton) {
  appMenuButton.addEventListener("click", openAppMenu);
}
if (appMenuBackButton) {
  appMenuBackButton.addEventListener("click", backToAppMenuIndex);
}
if (appMenuCloseButton) {
  appMenuCloseButton.addEventListener("click", () => closeAppMenu());
}
if (appMenuSettingsButton) {
  appMenuSettingsButton.addEventListener("click", () => openAppMenuScreen("settings", appMenuSettingsButton));
}
if (appMenuAboutButton) {
  appMenuAboutButton.addEventListener("click", () => openAppMenuScreen("about", appMenuAboutButton));
}
if (appMenuBackdrop) {
  appMenuBackdrop.addEventListener("click", () => closeAppMenu());
}
if (appMenuDrawer) {
  appMenuDrawer.addEventListener("keydown", handleAppMenuKeydown);
}
if (spokenSubtitlesMenuToggle) {
  spokenSubtitlesMenuToggle.addEventListener("change", () => {
    setAppMenuBooleanSetting(
      spokenSubtitlesMenuToggle,
      "spokenSubtitles",
      "spoken_subtitles",
      "spoken_subtitles"
    );
  });
}
if (userTranscriptSubtitlesMenuToggle) {
  userTranscriptSubtitlesMenuToggle.addEventListener("change", () => {
    setAppMenuBooleanSetting(
      userTranscriptSubtitlesMenuToggle,
      "userTranscriptSubtitles",
      "user_transcript_subtitles",
      "user_transcript_subtitles"
    );
  });
}
launchSplash.addEventListener("pointerdown", () => skipLaunchSplash("pointer"));
launchSplash.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    skipLaunchSplash(event.key === "Escape" ? "escape" : "keyboard");
  }
});
updateAppMenuToggles();
loadMoreButton.addEventListener("click", () => loadNextPage({ isAuto: false }));
window.addEventListener("scroll", maybeLoadNextPage, { passive: true });
window.addEventListener("resize", maybeLoadNextPage, { passive: true });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (isLaunchSplashActive()) {
      event.preventDefault();
      skipLaunchSplash("escape");
      return;
    }
    if (appMenuDrawer && !appMenuDrawer.hidden) {
      closeAppMenu();
      return;
    }
    closeFullscreenImageViewer();
    return;
  }
  // VOICE-AGENT-080: "?" opens the About page (credits/attribution). Ignored while typing
  // in the question box (or any input) and during the launch splash; preventDefault stops
  // Firefox's quick-find from hijacking the key. Esc already closes the menu (symmetric).
  if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const target = event.target;
    const isTyping = target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (isTyping || isLaunchSplashActive()) {
      return;
    }
    event.preventDefault();
    openAboutScreen();
  }
});

// VOICE-AGENT-087: floating status toast for shortcut-driven state changes. Auto-
// dismisses; role="status" + aria-live announce the change to assistive tech. The
// hidden attribute is removed before the transition so the fade-in runs from the
// off-screen state, and reinstated after the fade-out so screen readers don't read
// stale content.
let shortcutToastShowTimer = null;
let shortcutToastHideTimer = null;
function showToast(label, icon = "") {
  if (!shortcutToast) {
    return;
  }
  clearTimeout(shortcutToastShowTimer);
  clearTimeout(shortcutToastHideTimer);
  shortcutToastIcon.textContent = icon;
  shortcutToastIcon.hidden = !icon;
  shortcutToastLabel.textContent = label;
  shortcutToast.hidden = false;
  void shortcutToast.offsetWidth; // force reflow so the transition starts from hidden
  shortcutToast.classList.add("isVisible");
  shortcutToastShowTimer = setTimeout(() => {
    shortcutToast.classList.remove("isVisible");
    shortcutToastHideTimer = setTimeout(() => {
      shortcutToast.hidden = true;
      shortcutToastLabel.textContent = "";
      shortcutToastIcon.textContent = "";
    }, 240);
  }, 1500);
}

// VOICE-AGENT-087: single-key shortcuts for the main controls. Each key maps to the
// existing button and reuses its click handler, so all disabled/hidden guards and
// state updates stay in one place; a shortcut is a no-op when its button is hidden
// or disabled. Ignored while typing, during the launch splash, and while the burger
// menu is open, and it never fires with Ctrl/Meta/Alt held (those are OS/browser).
function isTypingTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}
function triggerControl(button) {
  if (button && !button.hidden && !button.disabled) {
    button.click();
    return true;
  }
  return false;
}
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  if (isTypingTarget(event.target) || isLaunchSplashActive()) {
    return;
  }
  if (appMenuDrawer && !appMenuDrawer.hidden) {
    return;
  }
  // Don't hijack keys while a modal overlay owns the screen (Escape closes those).
  if (document.body.classList.contains("imageViewerOpen") || document.querySelector(".videoModalOverlay")) {
    return;
  }

  // Backspace / Shift+Backspace = history back / forward (browser-style navigation).
  if (event.key === "Backspace") {
    const target = event.shiftKey ? historyForwardButton : historyBackButton;
    if (triggerControl(target)) {
      event.preventDefault();
    }
    return;
  }
  // The remaining shortcuts are all shift-free single letters.
  if (event.shiftKey) {
    return;
  }

  switch (event.key.toLowerCase()) {
    case "t": {
      // Start / Stop the Realtime session (only one of the pair is ever actionable).
      const wasRunning = sessionRunning;
      if (triggerControl(wasRunning ? stopButton : startButton)) {
        event.preventDefault();
        showToast(wasRunning ? "Session stopped" : "Starting session", wasRunning ? "⏹️" : "🎙️");
      }
      break;
    }
    case "m": {
      // In a session: mute / unmute (aria-pressed reflects the new state synchronously).
      // Idle: the same control drives dictation (async), so label by intent instead.
      const wasRunning = sessionRunning;
      const wasDictating = dictationActive;
      if (triggerControl(microphoneToggleButton)) {
        event.preventDefault();
        if (wasRunning) {
          const open = microphoneToggleButton.getAttribute("aria-pressed") === "true";
          showToast(open ? "Mic on" : "Mic off", open ? "🎙️" : "🔇");
        } else {
          showToast(wasDictating ? "Dictation sent" : "Listening…", wasDictating ? "✅" : "🎙️");
        }
      }
      break;
    }
    case "l":
      if (triggerControl(lookToggleButton)) {
        event.preventDefault();
        const open = lookToggleButton.getAttribute("aria-pressed") === "true";
        showToast(open ? "Look on" : "Look off", open ? "👁️" : "🙈");
      }
      break;
    case "n":
      if (triggerControl(newConversationButton)) {
        event.preventDefault();
        showToast("New conversation", "🔄");
      }
      break;
    default:
      break;
  }
});
window.addEventListener("error", (event) => {
  clientLog("window_error", { message: event.message, filename: event.filename, lineno: event.lineno }, "error");
});
window.addEventListener("unhandledrejection", (event) => {
  clientLog("unhandled_rejection", { reason: String(event.reason) }, "error");
});

// On cold load, play the launch title before handing off to the sample showcase.
runLaunchSplash().catch((error) => {
  log("launch splash error", error.message);
  hideLaunchSplash();
  void maybeShowLaunchShowcase();
});
