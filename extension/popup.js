// The popup is a small, system-appearance downloads surface. User-provided
// labels and page titles are always text nodes, never HTML.
const OLD_SIZES = { small: 85, normal: 100, large: 125 };
let integrationEnabled = true;
let activeSnapshot = null;
let activeTabId = null;
let mediaRevision = 0;
let refreshQueued = false;
let refreshDeferred = false;
const pendingActions = new Set();
const sentActions = new Set();
// The tab title last shown for a page. A single-page app can change its URL
// before its title, so a new page that still reports this title is stale.
let titleRecord = null;
// Where the visible video title came from ({ page, fromTab }), or null.
let titleContext = null;

function pageIdentity(href) {
  try {
    const url = new URL(href);
    if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(url.hostname)) {
      if (url.pathname === "/watch" && url.searchParams.has("v")) return `${url.origin}/watch?v=${url.searchParams.get("v")}`;
      if (/^\/(?:shorts|live|embed)\/[^/]+\/?$/i.test(url.pathname)) return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
    }
    return url.href;
  } catch (_) { return String(href || ""); }
}

function currentSnapshot(snapshot) {
  return !!snapshot && !!activeSnapshot && snapshot.tabId === activeSnapshot.tabId &&
    snapshot.page === activeSnapshot.page && snapshot.clientToken === activeSnapshot.clientToken &&
    snapshot.selectionVersion === activeSnapshot.selectionVersion;
}

// ------------------------------------------------------------ presentation
const AUDIO_EXT = /^(?:mp3|m4a|aac|ogg|opus|flac|wav)$/i;
const SIZE_TEXT = /^(?:about\s+)?\d[\d.,]*\s?(?:B|KB|MB|GB|TB)$/i;
// Streams the worker saw on the network are labelled "video/mp4 · 24 MB".
const RAW_MEDIA = /^((?:video|audio|application)\/[\w.+-]+|HLS stream)(?:\s+·\s+(.+))?$/i;
const STATUS_LOADING = /^Getting video qualities/i;
const STATUS_PROBLEM = /^(?:Can['’]t get this video|This video needs Mac Downloader)/i;

function fmtSize(n) {
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function qualityTag(h) { return !h ? "" : h >= 4320 ? "8K" : h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 1080 ? "Full HD" : h >= 720 ? "HD" : "SD"; }
function heightOf(quality) { const m = /^(\d{3,4})p/.exec(quality || ""); return m ? Number(m[1]) : 0; }
function hostOf(href) { try { return new URL(href).hostname.replace(/^www\./, ""); } catch (_) { return ""; } }

function isAudioItem(item) {
  const y = item.yt;
  return !!(y && (y.quality === "audio" || y.quality === "mp3" || /^audio\|/.test(y.key || ""))) ||
    /^audio\//i.test(item.label || "") || AUDIO_EXT.test(item.ext || "");
}

// "with" when the file is known to carry sound, "none" when it is known to
// be silent, "" when the source does not say.
function audioState(item) {
  const y = item.yt || {};
  const text = `${item.label || ""} ${item.sub || ""} ${y.sub || ""}`;
  if (y.hasAudio === false || /\b(?:video only|no audio|without (?:sound|audio))\b/i.test(text)) return "none";
  if (y.audioUrl || /\+A$/.test(y.key || "") || y.hasAudio === true || /\bwith (?:sound|audio)\b/i.test(text)) return "with";
  return "";
}

function sizeOf(item) {
  const y = item.yt || {};
  const fromText = String(y.sub || item.sub || "").split("·").map((part) => part.trim()).find((part) => SIZE_TEXT.test(part));
  let size = fromText || (y.size > 0 ? fmtSize(y.size) : "");
  if (!size) { const raw = RAW_MEDIA.exec(item.label || ""); if (raw && raw[2] && SIZE_TEXT.test(raw[2].trim())) size = raw[2].trim(); }
  if (size && y.quality === "mp3" && !/^about\b/i.test(size)) size = `about ${size}`;
  return size || "Size unknown";
}

/** What a format is (quality first), then file type, audio and size. */
function describeFormat(item) {
  const y = item.yt || null;
  const audio = isAudioItem(item);
  const raw = !y && RAW_MEDIA.exec(item.label || "");
  const ext = String((y && y.ext) || item.ext || (raw && !/^HLS/i.test(raw[1]) ? raw[1].split("/")[1] : "") || "").toUpperCase();
  let primary;
  if (y && audio) primary = y.quality === "mp3" ? "MP3 Audio" : "Audio Only";
  else if (y && y.quality && !/^video$/i.test(y.quality)) primary = [y.quality, y.tag || qualityTag(heightOf(y.quality))].filter(Boolean).join(" ");
  else if (raw) primary = /^HLS/i.test(raw[1]) ? "HLS Stream" : audio ? "Audio File" : "Video File";
  else primary = (y ? String(item.label || "").split(" · ")[0] : item.label) || (audio ? "Audio" : "Video");
  const kbps = y ? (y.kbps || (y.size && y.duration ? Math.round((y.size * 8) / y.duration / 1000) : 0)) : 0;
  const parts = [];
  if (item.disabled) {
    parts.push({ text: item.sub || "Not available for this video" });
  } else {
    if (ext) parts.push({ text: ext });
    if (audio) { if (kbps) parts.push({ text: `${kbps.toLocaleString("en")} kbps` }); }
    else {
      const sound = audioState(item);
      if (sound === "with") parts.push({ text: "With audio" });
      else if (sound === "none") parts.push({ text: "No audio", flag: true });
    }
    parts.push({ text: sizeOf(item) });
    if (y && y.quality === "mp3") parts.push({ text: "Converted after download" });
    if (raw && item.url) { const host = hostOf(item.url); if (host) parts.push({ text: host }); }
  }
  const codec = y && !audio ? (y.codec || (/\bAV1\b/.test(item.label || "") ? "AV1" : "")) : "";
  const tech = [codec, !audio && kbps ? `${kbps.toLocaleString("en")} kbps` : ""].filter(Boolean);
  return { kind: audio ? "audio" : "video", primary, parts, tech };
}

function statusKind(item) {
  if (item.protected || item.type === "protected") return "protected";
  if (!item.disabled || item.yt || item.url) return "";
  if (STATUS_LOADING.test(item.label || "")) return "loading";
  if (STATUS_PROBLEM.test(item.label || "")) return "problem";
  return "";
}

function cleanDisplayTitle(text) {
  return String(text || "").replace(/^\(\d+\)\s*/, "").replace(/\s+[-–—]\s+YouTube$/i, "").trim();
}

// The current video's title: the app's title for it when known, otherwise
// the tab title unless that still belongs to the page shown before.
function titleFor(items, tab, page) {
  const tabTitle = String(tab.title || "").trim();
  const stale = !!titleRecord && titleRecord.page !== page && titleRecord.tabTitle === tabTitle;
  if (!stale) titleRecord = { page, tabTitle };
  const known = items.map((item) => (item.yt && typeof item.yt.title === "string" ? item.yt.title.trim() : "")).find(Boolean);
  if (known) return { text: known, fromTab: false };
  return { text: stale ? "" : cleanDisplayTitle(tabTitle), fromTab: true };
}

function setVideoTitle(text) {
  const element = document.getElementById("videoTitle");
  element.textContent = text || "";
  element.setAttribute("title", text || "");
  element.hidden = !text;
}

function refreshTabTitle(tab) {
  if (!titleContext || !titleContext.fromTab || !activeSnapshot || titleContext.page !== activeSnapshot.page) return;
  if (!tab || pageIdentity(tab.url) !== activeSnapshot.page) return;
  setVideoTitle(titleFor([], tab, activeSnapshot.page).text);
}

function spinner() {
  const element = document.createElement("span");
  element.className = "spinner";
  element.setAttribute("aria-hidden", "true");
  return element;
}

function showMediaState(kind, message) {
  const box = document.getElementById("media");
  const state = document.createElement("div");
  state.className = `media-state is-${kind}`;
  state.setAttribute("role", "status");
  const title = document.createElement("strong");
  if (kind === "loading") {
    title.textContent = "Looking for the current video…";
    state.append(spinner(), title);
  } else {
    title.textContent = "No Video Found";
    const hint = document.createElement("p");
    hint.textContent = message || "Play a video on this page to see its download formats.";
    state.append(icon("video"), title, hint);
  }
  box.replaceChildren(state);
  document.getElementById("mediaCount").textContent = "";
  titleContext = null;
  setVideoTitle("");
}

function showEmptyMedia(message) { showMediaState("empty", message); }

function invalidateMedia() {
  mediaRevision++;
  activeSnapshot = null;
  showMediaState("loading");
}

function queueMediaRefresh({ invalidate = false } = {}) {
  if (invalidate) invalidateMedia();
  if (!invalidate && activeSnapshot && [...pendingActions].some((key) => key.startsWith(`${activeSnapshot.clientToken}:${activeSnapshot.selectionVersion}:`))) {
    refreshDeferred = true;
    return;
  }
  if (refreshQueued) return;
  refreshQueued = true;
  Promise.resolve().then(() => { refreshQueued = false; void loadMedia(); });
}

function icon(kind) {
  const paths = {
    download: "M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19h14",
    video: "M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm12 3 5-3v12l-5-3",
    audio: "M9 17V5l11-2v12M9 8l11-2M9 17c0 1.4-1.6 2.5-3.5 2.5S2 18.4 2 17s1.6-2.5 3.5-2.5S9 15.6 9 17Zm11-2c0 1.4-1.6 2.5-3.5 2.5S13 16.4 13 15s1.6-2.5 3.5-2.5S20 13.6 20 15Z",
    playlist: "M4 6h11M4 12h8M4 18h6m9-7v10m-4-4 4 4 4-4",
    check: "m5 12 4 4L19 6",
    lock: "M7 10h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm1 0V7a4 4 0 0 1 8 0v3m-4 4v3",
    warning: "M12 3.5 21.5 20h-19L12 3.5Zm0 6v4.5m0 3h.01",
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "glyph");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[kind] || paths.video);
  svg.appendChild(path);
  return svg;
}

function request(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    } catch {
      resolve(null);
    }
  });
}

function updateDownloadControls() {
  for (const button of document.querySelectorAll("[data-download]")) {
    button.disabled = !integrationEnabled || button.dataset.unavailable === "true" || button.dataset.pending === "true" || button.dataset.sent === "true";
  }
  document.getElementById("scale").disabled = !integrationEnabled;
  document.getElementById("scaleReset").disabled = !integrationEnabled;
}

function showEnabled(value) {
  integrationEnabled = value;
  document.getElementById("enabled").checked = value;
  document.body.classList.toggle("off", !value);
  document.getElementById("onText").textContent = value ? "Browser Integration" : "Integration Paused";
  document.getElementById("onHint").textContent = value ? "Send downloads to Mac Downloader" : "Downloads stay in your browser";
  updateDownloadControls();
}

function showScale(value) {
  const percent = Number.isFinite(value) ? Math.max(50, Math.min(200, Math.round(value))) : 100;
  document.getElementById("scale").value = String(percent);
  document.getElementById("scaleText").textContent = `${percent}%`;
  return percent;
}

function showConnection(connected) {
  const status = document.getElementById("status");
  status.textContent = connected ? "Connected" : "App Not Running";
  status.classList.toggle("on", connected);
  status.classList.toggle("offline", !connected);
  document.getElementById("connectionHint").hidden = connected;
  document.getElementById("openApp").classList.toggle("secondary-action", connected);
}

function symbolTile(kind, tone) {
  const tile = document.createElement("div");
  tile.className = `media-symbol${tone ? ` is-${tone}` : ""}`;
  tile.appendChild(kind === "spinner" ? spinner() : icon(kind));
  return tile;
}

function textBlock(className, text) {
  const element = document.createElement(className === "media-title" ? "div" : "p");
  element.className = className;
  element.textContent = text;
  return element;
}

function protectedRow(item) {
  const row = document.createElement("div");
  row.className = "media-row media-notice";
  const info = document.createElement("div");
  info.className = "media-info";
  const help = document.createElement("a");
  help.className = "notice-link";
  help.href = "https://help.netflix.com/en/node/54816";
  help.target = "_blank";
  help.rel = "noopener noreferrer";
  help.textContent = "Netflix Download Help";
  info.append(textBlock("media-title", "Protected Video"), textBlock("media-detail", item.sub || "Protected playback can’t be saved by this downloader."), help);
  row.append(symbolTile("lock", "neutral"), info);
  return row;
}

// Progress or a problem reported in place of formats: no download action.
function statusRow(item, kind) {
  const row = document.createElement("div");
  row.className = `media-row media-notice is-${kind}`;
  row.setAttribute("role", "status");
  const info = document.createElement("div");
  info.className = "media-info";
  info.appendChild(textBlock("media-title", item.label || (kind === "loading" ? "Getting video qualities…" : "Can’t get this video")));
  if (item.sub) info.appendChild(textBlock("media-detail", item.sub));
  row.append(kind === "loading" ? symbolTile("spinner", "plain") : symbolTile("warning", "neutral"), info);
  return row;
}

function detailLine(parts) {
  const detail = document.createElement("p");
  detail.className = "media-detail";
  for (const part of parts) {
    const span = document.createElement("span");
    if (part.flag) span.className = "no-audio";
    span.textContent = part.text;
    detail.appendChild(span);
  }
  return detail;
}

function mediaRow({ label, display, unavailable, message, playlist, snapshot }) {
  const row = document.createElement("div");
  row.className = unavailable ? "media-row is-unavailable" : "media-row";
  const tone = playlist ? "neutral" : display.kind === "audio" ? "audio" : "";
  const info = document.createElement("div");
  info.className = "media-info";
  const title = textBlock("media-title", display.primary);
  title.setAttribute("title", display.primary);
  info.appendChild(title);
  if (display.parts.length) {
    const detail = detailLine(display.parts);
    detail.setAttribute("title", [...display.parts.map((part) => part.text), ...display.tech].join(" · "));
    info.appendChild(detail);
  }
  const error = document.createElement("p");
  error.className = "row-error";
  error.setAttribute("role", "status");
  error.hidden = true;
  info.appendChild(error);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "download-button";
  button.dataset.download = "true";
  button.dataset.unavailable = String(!!unavailable || !snapshot.clientToken || snapshot.selectionVersion === null);
  const actionLabel = playlist ? "Download All" : "Download";
  const item = message.item || {};
  const actionKey = `${snapshot.clientToken}:${snapshot.selectionVersion}:${playlist ? "playlist" : `${item.yt?.source || ""}|${item.yt?.key || ""}|${item.url || ""}|${label}`}`;
  if (sentActions.has(actionKey)) button.dataset.sent = "true";
  button.setAttribute("aria-label", [`${actionLabel}: ${display.primary}`, ...display.parts.map((part) => part.text)].join(", "));
  const buttonLabel = document.createElement("span");
  buttonLabel.className = "button-text";
  buttonLabel.textContent = unavailable ? "Unavailable" : button.dataset.sent === "true" ? (playlist ? "Opened" : "Sent") : actionLabel;
  button.append(icon(button.dataset.sent === "true" ? "check" : "download"), buttonLabel);
  button.addEventListener("click", async () => {
    if (button.disabled || !currentSnapshot(snapshot)) return;
    pendingActions.add(actionKey);
    button.dataset.pending = "true";
    buttonLabel.textContent = "Sending…";
    button.setAttribute("aria-busy", "true");
    error.hidden = true;
    updateDownloadControls();
    let tab;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (_) {}
    if (!currentSnapshot(snapshot) || !tab || tab.id !== snapshot.tabId || pageIdentity(tab.url) !== snapshot.page) {
      pendingActions.delete(actionKey);
      queueMediaRefresh({ invalidate: true });
      return;
    }
    // The worker validates the captured token and tab again at dispatch.
    const result = await request({ ...message, tabId: snapshot.tabId, clientToken: snapshot.clientToken, selectionVersion: snapshot.selectionVersion });
    pendingActions.delete(actionKey);
    if (!currentSnapshot(snapshot)) { if (refreshDeferred) { refreshDeferred = false; queueMediaRefresh(); } return; }
    button.dataset.pending = "false";
    button.setAttribute("aria-busy", "false");
    if (result && result.ok) {
      sentActions.add(actionKey);
      button.dataset.sent = "true";
      buttonLabel.textContent = playlist ? "Opened" : "Sent";
      button.replaceChildren(icon("check"), buttonLabel);
    } else if (result?.error && /video changed/i.test(result.error)) {
      refreshDeferred = false;
      queueMediaRefresh({ invalidate: true });
      return;
    } else {
      buttonLabel.textContent = "Try Again";
      error.textContent = "Open Mac Downloader, then try again.";
      error.hidden = false;
      showConnection(false);
    }
    updateDownloadControls();
    if (refreshDeferred) { refreshDeferred = false; queueMediaRefresh(); }
  });
  row.append(symbolTile(playlist ? "playlist" : display.kind, tone), info, button);
  return row;
}

async function loadMedia() {
  const revision = ++mediaRevision;
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { return; }
  if (revision !== mediaRevision) return;
  if (!tab || !Number.isInteger(tab.id)) { activeSnapshot = null; activeTabId = null; showEmptyMedia(); return; }
  activeTabId = tab.id;
  const page = pageIdentity(tab.url);
  if (activeSnapshot && (activeSnapshot.tabId !== tab.id || activeSnapshot.page !== page)) {
    activeSnapshot = null;
    showMediaState("loading");
  }
  const response = await request({ type: "swiftget-get-media", tabId: tab.id, snapshot: true });
  if (revision !== mediaRevision) return;
  let current;
  try { [current] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (_) {}
  if (revision !== mediaRevision) return;
  if (!current || current.id !== tab.id || pageIdentity(current.url) !== page) { queueMediaRefresh({ invalidate: true }); return; }
  const token = typeof response?.clientToken === "string" && response.clientToken ? response.clientToken : null;
  const selectionVersion = Number.isSafeInteger(response?.selectionVersion) && response.selectionVersion >= 0 ? response.selectionVersion : null;
  const items = token && selectionVersion !== null && Array.isArray(response?.items) && response.tabId === tab.id ? response.items : [];
  const snapshot = { tabId: tab.id, page, clientToken: token, selectionVersion };
  if (!currentSnapshot(snapshot)) sentActions.clear();
  activeSnapshot = snapshot;
  if (!items.length) { showEmptyMedia(); updateDownloadControls(); return; }
  const box = document.getElementById("media");
  box.replaceChildren();
  const title = (tab.title || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120);
  const onlyProtected = items.every((item) => statusKind(item) === "protected");
  const shown = onlyProtected ? { text: "", fromTab: false } : titleFor(items, current, page);
  titleContext = onlyProtected ? null : { page, fromTab: shown.fromTab };
  setVideoTitle(shown.text);
  if (/youtube\.com/i.test(tab.url || "") && /[?&]list=/.test(tab.url || "")) {
    box.appendChild(mediaRow({
      label: "This Playlist", display: { kind: "playlist", primary: "This Playlist", parts: [{ text: "Choose videos in the app" }], tech: [] }, playlist: true,
      message: { type: "swiftget-playlist", url: tab.url }, snapshot,
    }));
  }
  let formats = 0;
  for (const item of items) {
    const status = statusKind(item);
    if (status === "protected") { box.appendChild(protectedRow(item)); continue; }
    if (status) { box.appendChild(statusRow(item, status)); continue; }
    formats++;
    box.appendChild(mediaRow({
      label: item.label || "Video", display: describeFormat(item), unavailable: item.disabled,
      message: { type: "swiftget-download", item, title: tab.title, referrer: tab.url, fileName: `${title}.${item.ext || "mp4"}` }, snapshot,
    }));
  }
  document.getElementById("mediaCount").textContent = formats ? `${formats} ${formats === 1 ? "format" : "formats"}` : "";
  updateDownloadControls();
}

async function init() {
  chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
    if (tabId !== activeTabId) return;
    if (change.title && !change.url) refreshTabTitle(tab);
    if (!change.url) return;
    const changedVideo = !activeSnapshot || pageIdentity(change.url) !== activeSnapshot.page;
    queueMediaRefresh({ invalidate: changedVideo });
  });
  chrome.tabs.onActivated?.addListener(({ tabId }) => {
    if (tabId !== activeTabId) queueMediaRefresh({ invalidate: true });
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    if (tabId === activeTabId) queueMediaRefresh({ invalidate: true });
  });
  chrome.runtime.onMessage?.addListener((message, sender) => {
    if (sender?.id !== chrome.runtime.id || sender.tab || message.type !== "swiftget-popup-media-changed" || message.tabId !== activeTabId) return;
    const changedVideo = !!activeSnapshot && (message.clientToken !== activeSnapshot.clientToken || message.selectionVersion !== activeSnapshot.selectionVersion);
    queueMediaRefresh({ invalidate: changedVideo });
  });
  document.getElementById("settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
  document.getElementById("openApp").addEventListener("click", () => setTimeout(() => window.close(), 300));
  const enabled = document.getElementById("enabled");
  enabled.addEventListener("change", async () => {
    const previous = integrationEnabled;
    showEnabled(enabled.checked);
    try { await chrome.storage.local.set({ enabled: integrationEnabled }); }
    catch { showEnabled(previous); }
  });
  const saveScale = async (value) => {
    const percent = showScale(value);
    try { await chrome.storage.local.set({ bubbleScale: percent / 100 }); } catch { /* keep the UI usable if the browser is closing */ }
  };
  document.getElementById("scale").addEventListener("input", (event) => saveScale(Number(event.target.value)));
  document.getElementById("scaleReset").addEventListener("click", () => saveScale(100));
  try {
    const options = await chrome.storage.local.get({ enabled: true, bubbleScale: null, bubbleSize: "normal" });
    showEnabled(options.enabled !== false);
    showScale(options.bubbleScale != null ? Number(options.bubbleScale) * 100 : OLD_SIZES[options.bubbleSize] || 100);
  } catch { showEnabled(false); }
  const connection = request({ type: "swiftget-status" }).then((response) => showConnection(!!(response && response.ok)));
  await Promise.all([loadMedia(), connection]);
}

init();
