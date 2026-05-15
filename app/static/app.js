const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const historyBackButton = document.querySelector("#historyBackButton");
const historyForwardButton = document.querySelector("#historyForwardButton");
const questionInput = document.querySelector("#questionInput");
const newConversationButton = document.querySelector("#newConversationButton");
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

let pc;
let dc;
let localStream;
let localAudioTrack;
let sessionRunning = false;
let textChatInFlight = false;
let subtitleTimer = null;
let subtitleQueue = [];
const handledCallIds = new Set();
let currentSearchState = null;
let loadingMore = false;
let autoPagesLoaded = 0;
let pageHistory = [];
let pageHistoryIndex = -1;
let restoringHistory = false;
const maxAutoPages = 4;
const TMDB_FRONT_BASE_URL = "https://www.vaugouin.com/tmdb";
const CONTEXT_STORAGE_KEY = "voice-agent-context-v1";
const maxContextItems = 10;
const DETAIL_TOOL_ENTITIES = {
  get_movie_detail: "movie",
  get_series_detail: "serie",
  get_person_detail: "person",
  get_company_detail: "company",
  get_network_detail: "network",
  get_collection_detail: "collection",
  get_topic_detail: "topic",
  get_list_detail: "list",
  get_movement_detail: "movement",
  get_group_detail: "group",
  get_death_detail: "death",
  get_award_detail: "award",
  get_nomination_detail: "nomination",
  get_location_detail: "location",
};
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

let retainedContext = [];

function appUrl(path) {
  return new URL(path, new URL(".", window.location.href)).toString();
}

function setConversationActive(active) {
  newConversationButton.hidden = !active;
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
      await showRecordDetail(entry.record, { skipHistory: true });
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
  pageHistoryIndex = nextIndex;
  updateHistoryButtons();
  await renderHistoryEntry(pageHistory[pageHistoryIndex]);
}

function clearPageHistory() {
  pageHistory = [];
  pageHistoryIndex = -1;
  updateHistoryButtons();
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
  currentOutput.has_more = nextOutput.has_more;
  currentOutput.question_hashed = nextOutput.question_hashed || currentOutput.question_hashed;
  pageHistory[pageHistoryIndex] = {
    type: "search",
    output: currentOutput,
    args: {
      ...current.args,
      page: currentOutput.page,
      question_hashed: currentOutput.question_hashed || current.args?.question_hashed,
    },
  };
}

function hasQuestionText() {
  return Boolean(questionInput.value.trim());
}

function updateSessionButtons() {
  const hideStartForText = hasQuestionText() || textChatInFlight;
  startButton.hidden = sessionRunning || hideStartForText;
  stopButton.hidden = !sessionRunning;
  startButton.disabled = sessionRunning || hideStartForText;
  stopButton.disabled = !sessionRunning;
}

function setSessionRunning(running) {
  sessionRunning = running;
  updateSessionButtons();
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

function setLoadingResults(query) {
  setConversationActive(true);
  resultsPanel.hidden = false;
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
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

function buildCardMedia(title, imageUrl) {
  const media = document.createElement("div");
  media.className = "search-poster-card-media";

  if (imageUrl) {
    const img = document.createElement("img");
    img.src = imageUrl;
    setImageText(img, title);
    media.append(img);
  } else {
    const fallback = document.createElement("div");
    fallback.className = "posterFallback";
    fallback.textContent = title || "No image";
    media.append(fallback);
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

function appendCard(grid, cardSpec) {
  const card = document.createElement("div");
  card.className = "search-poster-card";
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
  const media = buildCardMedia(cardSpec.title, cardSpec.imageUrl);
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
      meta: [record.ORIGIN_COUNTRY, record.HEADQUARTERS],
      overview: record.DESCRIPTION || "",
    });
  }

  const name =
    record.TOPIC_NAME ||
    record.LIST_NAME ||
    record.COLLECTION_NAME ||
    record.MOVEMENT_NAME ||
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
    item.ITEM_LABEL,
    item.LOCATION_NAME
  );
}

function visualSubtitle(item) {
  return firstValue(
    item.CAST_CHARACTER,
    item.CREW_DEPARTMENT,
    yearFromDate(item.DAT_RELEASE),
    yearFromDate(item.DAT_FIRST_AIR),
    item.GROUP_TYPE,
    item.DEATH_TYPE,
    item.AWARD_TYPE,
    item.NOMINATION_TYPE,
    item.TOPIC_TYPE,
    item.COLLECTION_TYPE,
    item.LIST_TYPE,
    item.MOVEMENT_TYPE
  );
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

function visualImage(item, kind = "poster") {
  const size = kind === "profile" ? "w185" : kind === "logo" ? "w342" : "w342";
  return imageUrl(item.PROFILE_PATH || item.POSTER_PATH || item.LOGO_PATH || item.WIKIPEDIA_IMAGE_PATH, size);
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

function appendVisualRail(parent, title, items, { kind = "poster" } = {}) {
  const clean = (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object" && visualTitle(item));
  if (!clean.length) {
    return false;
  }

  const section = document.createElement("section");
  section.className = "detailVisualSection";
  const header = document.createElement("div");
  header.className = "detailRailHeader";
  appendText(header, "detailSubheading", title);

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
  clean.forEach((item) => {
    const request = detailRequestFromRecord(item);
    const card = document.createElement(request ? "button" : "div");
    card.className = "detailVisualCard";
    if (request) {
      card.type = "button";
      card.setAttribute("aria-label", `Open ${visualTitle(item)}`);
      card.addEventListener("click", () => {
        showRecordDetail(item).catch((error) => {
          log("detail page click error", error.message);
        });
      });
    }

    const media = document.createElement("div");
    media.className = "detailVisualMedia";
    const src = visualImage(item, kind);
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      setImageText(img, visualTitle(item));
      media.append(img);
    } else {
      const fallback = document.createElement("div");
      fallback.className = "posterFallback";
      fallback.textContent = visualTitle(item);
      media.append(fallback);
    }

    const text = document.createElement("div");
    text.className = "detailVisualText";
    appendText(text, "detailVisualTitle", visualTitle(item));
    appendText(text, "detailVisualSubtitle", visualSubtitle(item));
    card.append(media, text);
    rail.append(card);
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
  previous.addEventListener("click", () => scrollRail(-1));
  next.addEventListener("click", () => scrollRail(1));
  rail.addEventListener("scroll", updateControls, { passive: true });
  window.requestAnimationFrame(updateControls);
  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(updateControls);
    resizeObserver.observe(rail);
  } else {
    window.addEventListener("resize", updateControls);
  }

  section.append(header, rail);
  parent.append(section);
  return true;
}

function appendMixedVisualSections(parent, record) {
  appendVisualRail(parent, "Movies", record.movies, { kind: "poster" });
  appendVisualRail(parent, "Series", record.series, { kind: "poster" });
  appendVisualRail(parent, "People", record.persons, { kind: "profile" });
  appendVisualRail(parent, "Awards", record.awards, { kind: "poster" });
  appendVisualRail(parent, "Nominations", record.nominations, { kind: "poster" });
  appendVisualRail(parent, "Collections", record.collections, { kind: "poster" });
  appendVisualRail(parent, "Topics", record.topics, { kind: "poster" });
  appendVisualRail(parent, "Lists", record.lists, { kind: "poster" });
  appendVisualRail(parent, "Movements", record.movements, { kind: "poster" });
  appendVisualRail(parent, "Groups", record.groups, { kind: "profile" });
  appendVisualRail(parent, "Deaths", record.deaths, { kind: "profile" });
  appendVisualRail(parent, "Companies", record.companies, { kind: "logo" });
  appendVisualRail(parent, "Networks", record.networks, { kind: "logo" });
}

function titleForRecord(record) {
  return firstValue(
    record.MOVIE_TITLE,
    record.SERIE_TITLE,
    record.PERSON_NAME,
    record.COMPANY_NAME,
    record.NETWORK_NAME,
    record.COLLECTION_NAME,
    record.TOPIC_NAME,
    record.LIST_NAME,
    record.MOVEMENT_NAME,
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
  } else if (record.ID_MOVIE || record.ID_SERIE) {
    media.append(buildPosterSwipeViewer(record));
  } else {
    const poster = imageUrl(record.POSTER_PATH || record.PROFILE_PATH || record.LOGO_PATH || record.WIKIPEDIA_IMAGE_PATH, "w500");
    if (poster) {
      media.append(buildSingleImageViewer(record, poster));
    } else {
      const fallback = document.createElement("div");
      fallback.className = "posterFallback";
      fallback.textContent = titleForRecord(record);
      media.append(fallback);
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

  if (record.ID_MOVIE || String(record.CONTENT_TYPE || "").toLowerCase() === "movie") {
    const director = directorCredit(record);
    const crewCredits = dedupePersonCrewCredits(record.crew);
    appendMetric(metrics, "Released", firstValue(formatDate(record.DAT_RELEASE), record.RELEASE_YEAR));
    appendMetric(metrics, "Duration", formatRuntime(record.RUNTIME));
    appendMetric(metrics, "IMDb", formatRating(record.IMDB_RATING || record.IMDB_RATING_WEIGHTED));
    appendMetric(metrics, "Director", movieDirectorName(record), { record: director });
    if (metrics.children.length) {
      body.append(metrics);
    }
    if (!appendVisualRail(body, "Cast", record.cast, { kind: "profile" })) {
      appendList(body, "Cast", namesFrom(record.cast, "PERSON_NAME", Infinity));
    }
    appendVisualRail(body, "Crew", crewCredits, { kind: "profile" });
    appendMixedVisualSections(body, record);
  } else if (record.ID_SERIE || String(record.CONTENT_TYPE || "").toLowerCase() === "serie") {
    const director = directorCredit(record);
    const crewCredits = dedupePersonCrewCredits(record.crew);
    appendMetric(metrics, "First aired", firstValue(formatDate(record.DAT_FIRST_AIR), record.FIRST_AIR_YEAR));
    appendMetric(metrics, "Seasons", record.NUMBER_OF_SEASONS);
    appendMetric(metrics, "Episodes", record.NUMBER_OF_EPISODES);
    appendMetric(metrics, "IMDb", formatRating(record.IMDB_RATING || record.IMDB_RATING_WEIGHTED));
    appendMetric(metrics, "Director", movieDirectorName(record), { record: director });
    if (metrics.children.length) {
      body.append(metrics);
    }
    if (!appendVisualRail(body, "Cast", record.cast, { kind: "profile" })) {
      appendList(body, "Cast", namesFrom(record.cast, "PERSON_NAME", Infinity));
    }
    appendVisualRail(body, "Crew", crewCredits, { kind: "profile" });
    appendMixedVisualSections(body, record);
  } else if (record.ID_PERSON) {
    appendMetric(metrics, "Born", record.BIRTH_YEAR);
    appendMetric(metrics, "Died", record.DEATH_YEAR);
    appendMetric(metrics, "Known for", record.KNOWN_FOR_DEPARTMENT);
    appendMetric(metrics, "Country", formatCountryCode(record.COUNTRY_OF_BIRTH));
    if (metrics.children.length) {
      body.append(metrics);
    }
    const knownForActing = String(record.KNOWN_FOR_DEPARTMENT || "").toLowerCase() === "acting";
    const movieCrewCredits = dedupeCrewCredits(record.movie_crew);
    const seriesCrewCredits = dedupeCrewCredits(record.series_crew);
    const displayedMovies = knownForActing
      ? appendVisualRail(body, "Movies", record.movie_cast, { kind: "poster" })
      : appendVisualRail(body, "Directed or crewed", movieCrewCredits, { kind: "poster" });
    if (knownForActing) {
      appendVisualRail(body, "Directed or crewed", movieCrewCredits, { kind: "poster" });
    } else {
      appendVisualRail(body, "Movies", record.movie_cast, { kind: "poster" });
    }
    appendVisualRail(body, "Series", [...(record.series_cast || []), ...seriesCrewCredits], { kind: "poster" });
    appendMixedVisualSections(body, record);
    if (!displayedMovies) {
      appendList(
        body,
        knownForActing ? "Known movies" : "Known crew credits",
        namesFrom(knownForActing ? record.movie_cast : movieCrewCredits, "MOVIE_TITLE", Infinity)
      );
    }
  } else {
    appendMetric(metrics, "Type", firstValue(record.COLLECTION_TYPE, record.TOPIC_TYPE, record.LIST_TYPE, record.MOVEMENT_TYPE, record.GROUP_TYPE, record.DEATH_TYPE, record.AWARD_TYPE, record.NOMINATION_TYPE, record.INSTANCE_OF));
    appendMetric(metrics, "Movies", record.MOVIE_COUNT);
    appendMetric(metrics, "Series", record.SERIE_COUNT);
    appendMetric(metrics, "Persons", record.PERSON_COUNT);
    appendMetric(metrics, "IMDb", formatRating(record.IMDB_RATING || record.IMDB_RATING_WEIGHTED));
    if (metrics.children.length) {
      body.append(metrics);
    }
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
    return;
  }

  try {
    const output = await callEntityDetail(request.toolName, { id: request.id });
    renderSingleDetail(container, { ...record, ...(output.detail || {}) });
  } catch (error) {
    renderSingleDetail(container, record, { error: `Detail fetch failed: ${error.message}` });
  }
}

async function showRecordDetail(record, { skipHistory = false } = {}) {
  setConversationActive(true);
  resultsPanel.hidden = false;
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
  loadingMore = false;
  autoPagesLoaded = 0;

  await renderSingleRecordResult(resultsContent, record);
  if (!skipHistory) {
    pushPageHistory({ type: "recordDetail", record });
  }
}

function setLoadingEntityDetail(toolName, args) {
  setConversationActive(true);
  resultsPanel.hidden = false;
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
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
  setConversationActive(true);
  resultsPanel.hidden = false;
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
  loadingMore = false;
  autoPagesLoaded = 0;

  const container = document.createElement("div");
  container.className = "singleDetailWrap";
  resultsContent.append(container);

  if (output.error) {
    renderSingleDetail(container, {
      CONTENT_TITLE: "Unable to load details",
    }, { error: output.error });
    if (!skipHistory) {
      pushPageHistory({ type: "entityDetail", output, args });
    }
    return;
  }

  const detail = output.detail && typeof output.detail === "object" ? output.detail : null;
  if (!detail) {
    renderSingleDetail(container, {
      CONTENT_TITLE: output.entity ? prettyLabel(output.entity) : "Details",
    }, { error: "No detail record returned." });
    if (!skipHistory) {
      pushPageHistory({ type: "entityDetail", output, args });
    }
    return;
  }

  renderSingleDetail(container, {
    ...detail,
    ID_WIKIDATA: detail.ID_WIKIDATA || args.ID_WIKIDATA,
  });
  if (!skipHistory) {
    pushPageHistory({ type: "entityDetail", output, args });
  }
}

async function renderText2SqlResult(output, args, { append = false, skipHistory = false } = {}) {
  setConversationActive(true);
  resultsPanel.hidden = false;

  const upstream = output.upstream && typeof output.upstream === "object" ? output.upstream : {};
  const rows = Array.isArray(upstream.result)
    ? upstream.result
    : Array.isArray(output.rows)
      ? output.rows
      : [];

  let grid = resultsContent.querySelector(".search-poster-card-grid");

  if (!append || !grid) {
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
    resultsContent.append(answerBlock);

    const details = document.createElement("details");
    details.className = "queryDetails";
    const summary = document.createElement("summary");
    summary.textContent = "Click to expand query details";
    const pre = document.createElement("pre");
    pre.textContent = [
      upstream.justification || "",
      upstream.sql_query || output.sql_query || "",
      upstream.total_processing_time
        ? `Total processing time: ${Number(upstream.total_processing_time).toFixed(3)}s`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    details.append(summary, pre);
    resultsContent.append(details);

    const rowsPerPage = Number(output.rows_per_page || upstream.rows_per_page || rows.length || 0);
    const questionHashed = output.question_hashed || upstream.question_hashed || args.question_hashed || null;
    const page = Number(output.page || upstream.page || args.page || 1);
    currentSearchState = {
      query: args.query || upstream.question || "",
      ui_language: args.ui_language || upstream.ui_language || "en",
      question_hashed: questionHashed,
      page,
      rows_per_page: rowsPerPage,
      has_more: Boolean(questionHashed && (output.has_more ?? upstream.has_more ?? (rowsPerPage && rows.length === rowsPerPage))),
    };

    if (rows.length === 1) {
      const record = rows[0]?.data || rows[0];
      if (record && typeof record === "object") {
        await renderSingleRecordResult(resultsContent, record);
        refreshPaginationControls();
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

  const rowsPerPage = Number(output.rows_per_page || upstream.rows_per_page || rows.length || 0);
  const questionHashed = output.question_hashed || upstream.question_hashed || args.question_hashed || null;
  const page = Number(output.page || upstream.page || args.page || 1);
  currentSearchState = {
    query: args.query || upstream.question || "",
    ui_language: args.ui_language || upstream.ui_language || "en",
    question_hashed: questionHashed,
    page,
    rows_per_page: rowsPerPage,
    has_more: Boolean(questionHashed && (output.has_more ?? upstream.has_more ?? (rowsPerPage && rows.length === rowsPerPage))),
  };
  refreshPaginationControls();
  if (!append && !skipHistory) {
    pushPageHistory({ type: "search", output, args });
  } else if (append && !skipHistory) {
    appendCurrentSearchHistory(output, args);
  }
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

function splitSubtitleText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return [];
  }
  const chunks = [];
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  let current = "";
  for (const sentence of sentences) {
    const next = `${current} ${sentence}`.trim();
    if (next.length <= 150) {
      current = next;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    if (sentence.length <= 150) {
      current = sentence.trim();
      continue;
    }
    for (let index = 0; index < sentence.length; index += 150) {
      chunks.push(sentence.slice(index, index + 150).trim());
    }
    current = "";
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
    return;
  }
  subtitleOverlay.textContent = text;
  subtitleOverlay.hidden = false;
  const duration = Math.max(3500, Math.min(12000, text.length * 65));
  subtitleTimer = window.setTimeout(showNextSubtitle, duration);
}

function showSubtitleText(text) {
  subtitleQueue = splitSubtitleText(text);
  showNextSubtitle();
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
  updateSessionButtons();
  window.setTimeout(updateSessionButtons, 0);
}

async function callTextChat(message) {
  const response = await fetch(appUrl("text-chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

async function sendTextMessage() {
  const text = questionInput.value.trim();
  if (!text) {
    return;
  }

  if (dc && dc.readyState === "open" && activeResponseId) {
    sendEvent({ type: "response.cancel" });
    activeResponseId = null;
    activeAudioResponseId = null;
  }
  if (pc || dc || localStream) {
    stop();
  }

  textChatInFlight = true;
  updateSessionButtons();
  questionInput.value = "";
  resizeQuestionInput();
  updateSessionButtons();
  lastUserTranscript = text;
  addRetainedContext({ type: "user", text });
  setStatus("Thinking in text", "live");
  clientLog("text_chat_sent", { length: text.length });

  try {
    const output = await callTextChat(text);
    for (const toolResult of Array.isArray(output.tool_outputs) ? output.tool_outputs : []) {
      if (toolResult.name === "query_text2sql") {
        await renderText2SqlResult(toolResult.output, toolResult.args || {});
      } else if (DETAIL_TOOL_ENTITIES[toolResult.name]) {
        renderEntityDetailOutput(toolResult.output, toolResult.args || {});
      }
    }
    const responseText = output.text || "";
    if (responseText) {
      addRetainedContext({ type: "assistant", text: responseText });
      showSubtitleText(responseText);
    }
    setStatus("Text response", "live");
    clientLog("text_chat_success", {
      model: output.model || "",
      length: responseText.length,
      tool_count: Array.isArray(output.tool_outputs) ? output.tool_outputs.length : 0,
    });
  } catch (error) {
    const message = `Text response failed: ${error.message}`;
    showSubtitleText(message);
    setStatus("Text error", "error");
    log("text chat error", error.message);
    clientLog("text_chat_error", { error: error.message }, "error");
  } finally {
    textChatInFlight = false;
    updateSessionButtons();
  }
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
      lines.push(`Tool query: ${item.query}`);
      if (item.answer) {
        lines.push(`Tool answer: ${item.answer}`);
      }
      if (item.result_count !== null && item.result_count !== undefined) {
        lines.push(`Tool result count: ${item.result_count}`);
      }
      if (item.rows?.length) {
        lines.push(`Tool rows JSON: ${JSON.stringify(item.rows)}`);
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

function cleanupConnection() {
  connectionGeneration += 1;
  clearResponseFallback();
  clearDisconnectWatchdog();
  stopKeepAlive();
  if (microphoneEnableTimer) {
    clearTimeout(microphoneEnableTimer);
    microphoneEnableTimer = null;
  }
  dc?.close();
  pc?.close();
  localStream?.getTracks().forEach((track) => track.stop());
  dc = undefined;
  pc = undefined;
  localStream = undefined;
  localAudioTrack = undefined;
  activeResponseId = null;
  activeAudioResponseId = null;
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

function setMicrophoneEnabled(enabled) {
  if (localAudioTrack) {
    localAudioTrack.enabled = enabled;
  }
  log("microphone", enabled ? "enabled" : "muted during tool work");
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
  return toolCallsInFlight === 0 && !awaitingToolResponse;
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

async function callText2Sql(args) {
  const response = await fetch(appUrl("tool/text2sql"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: args.query,
      ui_language: args.ui_language || "en",
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
  const id = args.id || args.wikidata_id || args.ID_WIKIDATA || args.ID_MOVIE || args.ID_SERIE || args.ID_PERSON;
  if (!entity || !id) {
    throw new Error(`Missing id for ${toolName}`);
  }

  const response = await fetch(
    appUrl(`tool/detail/${encodeURIComponent(entity)}/${encodeURIComponent(String(id))}`)
  );

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

async function handleFunctionCall(item) {
  if (
    item?.type !== "function_call" ||
    (item.name !== "query_text2sql" && !DETAIL_TOOL_ENTITIES[item.name])
  ) {
    return;
  }
  if (handledCallIds.has(item.call_id)) {
    return;
  }
  handledCallIds.add(item.call_id);

  let args;
  try {
    args = JSON.parse(item.arguments || "{}");
  } catch {
    args = {};
  }

  log("tool call", { name: item.name, args });
  lastToolArgs = args;
  toolCallsInFlight += 1;
  syncMicrophone("tool call started");
  clientLog("tool_call_start", { name: item.name, args, call_id: item.call_id });
  if (item.name === "query_text2sql") {
    setLoadingResults(args.query);
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
        rows: output.rows || [],
        sql_query: output.sql_query || "",
      }
    : {
        error: output.error || "",
        entity: output.entity || DETAIL_TOOL_ENTITIES[item.name],
        id_name: output.id_name || "",
        id: output.id || args.id || args.wikidata_id || "",
        endpoint: output.endpoint || "",
        detail: output.detail || null,
      };
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
          error: toolOutput.error,
        }),
  });

  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: item.call_id,
      output: JSON.stringify(toolOutput),
    },
  });

  if (!activeResponseId) {
    sendEvent({ type: "response.create" });
  } else {
    window.setTimeout(() => {
      if (!activeResponseId) {
        sendEvent({ type: "response.create" });
      }
    }, 250);
  }
  syncMicrophone("tool output sent");
}

async function handleServerEvent(event) {
  log(event.type, event);
  clientLog("realtime_event", summarizeRealtimeEvent(event), event.type === "error" ? "error" : "info");

  if (event.type === "input_audio_buffer.speech_started") {
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
      addRetainedContext({ type: "user", text: lastUserTranscript });
      clientLog("user_transcript", { item_id: event.item_id, transcript: lastUserTranscript });
    }
    inputTranscripts.delete(event.item_id);
  }

  if (event.type === "response.output_audio_transcript.done") {
    const transcript = event.transcript || "";
    if (transcript.trim()) {
      addRetainedContext({ type: "assistant", text: transcript.trim() });
    }
  }

  if (event.type === "response.created") {
    activeResponseId = event.response?.id || null;
    awaitingToolResponse = false;
    clearResponseFallback();
    syncMicrophone("response created");
    setStatus("Responding", "live");
  }

  if (event.type === "output_audio_buffer.started") {
    activeAudioResponseId = event.response_id || activeResponseId;
    syncMicrophone("audio playback started");
  }

  if (event.type === "output_audio_buffer.stopped") {
    if (!event.response_id || event.response_id === activeAudioResponseId) {
      activeAudioResponseId = null;
    }
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
    throw new Error("Microphone capture is not available in this browser. Use HTTPS and allow microphone access.");
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
  nextPc.addTrack(localAudioTrack, nextLocalStream);

  const offer = await nextPc.createOffer();
  await nextPc.setLocalDescription(offer);

  setStatus("Creating Realtime call");
  const sdpResponse = await fetch(appUrl("session"), {
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
  clearReconnectTimer();
  releaseWakeLock("stop");
  cleanupConnection();
  handledCallIds.clear();
  pendingReconnectResume = null;
  setSessionRunning(false);
  setStatus("Idle");
  log("stopped");
}

function clearConversationUi() {
  handledCallIds.clear();
  resultsPanel.hidden = true;
  resultsContent.replaceChildren();
  resultsLoader.hidden = true;
  loadMoreButton.hidden = true;
  resultsEnd.hidden = true;
  currentSearchState = null;
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
}

setupPageDiagnostics();
setupRemoteAudioDiagnostics();
clearRetainedContext();
clientLog("realtime_support", realtimeSupportSnapshot("page load"));

startButton.addEventListener("click", () => {
  start().catch((error) => {
    setSessionRunning(false);
    setStatus("Error", "error");
    const permissionDenied =
      error.name === "NotAllowedError" ||
      error.name === "SecurityError" ||
      error.message.toLowerCase().includes("permission denied");

    if (permissionDenied) {
      clientLog("microphone_permission_denied", { name: error.name, message: error.message }, "error");
      log(
        "microphone permission denied",
        "Allow microphone access for this site, or open http://127.0.0.1:3000 in Chrome/Edge and allow the microphone prompt."
      );
      return;
    }

    clientLog("start_error", { name: error.name, message: error.message }, "error");
    log("start error", error.message);
  });
});

stopButton.addEventListener("click", stop);
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
questionInput.addEventListener("change", syncQuestionInputUi);
questionInput.addEventListener("keyup", syncQuestionInputUi);
questionInput.addEventListener("paste", syncQuestionInputUi);
questionInput.addEventListener("cut", syncQuestionInputUi);
questionInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }
  event.preventDefault();
  sendTextMessage().catch((error) => {
    log("text submit error", error.message);
  });
});
syncQuestionInputUi();
setSessionRunning(false);
updateHistoryButtons();
newConversationButton.addEventListener("click", startNewConversation);
loadMoreButton.addEventListener("click", () => loadNextPage({ isAuto: false }));
window.addEventListener("scroll", maybeLoadNextPage, { passive: true });
window.addEventListener("resize", maybeLoadNextPage, { passive: true });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeFullscreenImageViewer();
  }
});
window.addEventListener("error", (event) => {
  clientLog("window_error", { message: event.message, filename: event.filename, lineno: event.lineno }, "error");
});
window.addEventListener("unhandledrejection", (event) => {
  clientLog("unhandled_rejection", { reason: String(event.reason) }, "error");
});
