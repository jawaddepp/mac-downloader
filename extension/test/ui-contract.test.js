// Popup/options behavior contracts with a minimal DOM, without a browser profile.
// node extension/test/ui-contract.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const extension = path.join(__dirname, "..");

class Element {
  constructor(tag, all) {
    this.tagName = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = {};
    this.className = ""; this.textContent = ""; this.checked = false; this.disabled = false; this.hidden = false; this._value = ""; all.push(this);
    this.classList = {
      toggle: (name, force) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); const add = force === undefined ? !names.has(name) : force; add ? names.add(name) : names.delete(name); this.className = [...names].join(" "); },
      remove: (name) => { this.className = this.className.split(/\s+/).filter((n) => n !== name).join(" "); },
    };
  }
  set value(v) { this._value = String(v); }
  get value() { return this._value; }
  set innerHTML(_) { throw new Error("User-facing HTML must use safe text nodes"); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.className = value; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
  async fire(name) { if (this.disabled) return; for (const handler of this.listeners[name] || []) await handler({ target: this }); }
}

async function page(name, { store = {}, items = [], online = true, preparedPort = undefined, title = "Calm: <Coast>?", url = "https://example.test/watch" } = {}) {
  const all = [], ids = {}, messages = [], writes = [];
  const tabUpdated = [], tabActivated = [], tabRemoved = [], runtimeListeners = [], pendingMedia = [], pendingDownloads = [];
  let activeTab = { id: 7, title, url }, currentItems = items, clientToken = 'token-a', selectionVersion = 0, deferMedia = false, deferDownload = false;
  const html = fs.readFileSync(path.join(extension, `${name}.html`), "utf8");
  for (const match of html.matchAll(/id="([^"]+)"/g)) ids[match[1]] = new Element("existing", all);
  const document = { body: new Element("body", all), getElementById: (id) => { assert(ids[id], `missing HTML id ${id}`); return ids[id]; }, createElement: (tag) => new Element(tag, all), createElementNS: (_, tag) => new Element(tag, all), querySelectorAll: (selector) => {
    assert.strictEqual(selector, "[data-download]");
    const found = []; const walk = (node) => { if (node.dataset.download) found.push(node); for (const child of node.children) walk(child); };
    if (ids.media) walk(ids.media);
    return found;
  } };
  let opened = 0, closed = 0;
  const chrome = {
    storage: { local: { get: async (defaults) => ({ ...defaults, ...store }), set: async (values) => { writes.push(values); Object.assign(store, values); } } },
    tabs: { query: async () => [{ ...activeTab }], onUpdated: { addListener(fn) { tabUpdated.push(fn); } }, onActivated: { addListener(fn) { tabActivated.push(fn); } }, onRemoved: { addListener(fn) { tabRemoved.push(fn); } } },
    runtime: { id: 'synthetic-extension', onMessage: { addListener(fn) { runtimeListeners.push(fn); } }, getURL: (part) => `chrome-extension://synthetic/${part}`, openOptionsPage: () => { opened++; }, sendMessage: (message, callback) => {
      messages.push(message);
      const result = message.type === "swiftget-get-media" ? { items: currentItems, clientToken, selectionVersion, tabId: message.tabId } : { ok: online };
      if (message.type === "swiftget-get-media" && deferMedia) pendingMedia.push(() => callback(result));
      else if (message.type === "swiftget-download" && deferDownload) pendingDownloads.push(() => callback(result));
      else queueMicrotask(() => callback(result));
    } },
  };
  const sandbox = { document, chrome, URL, window: { close: () => { closed++; } }, console, AbortController, fetch: async () => ({ ok: preparedPort !== undefined, text: async () => JSON.stringify({ port: preparedPort }) }), setTimeout: (...args) => { const t = setTimeout(...args); t.unref(); return t; }, clearTimeout };
  await vm.runInNewContext(fs.readFileSync(path.join(extension, `${name}.js`), "utf8"), sandbox);
  return { ids, all, messages, writes, document, store, opened: () => opened, closed: () => closed,
    setTab(next) { activeTab = { ...activeTab, ...next }; },
    setMedia(next, token, version = selectionVersion) { currentItems = next; clientToken = token; selectionVersion = version; },
    emitUpdated(change) { for (const fn of tabUpdated) fn(activeTab.id, change, { ...activeTab }); },
    emitActivated(tabId) { for (const fn of tabActivated) fn({ tabId }); },
    emitRemoved(tabId) { for (const fn of tabRemoved) fn(tabId); },
    emitMedia(tabId = activeTab.id, token = clientToken, version = selectionVersion) { for (const fn of runtimeListeners) fn({ type: 'swiftget-popup-media-changed', tabId, clientToken: token, selectionVersion: version }, { id: 'synthetic-extension' }); },
    setDeferMedia(value) { deferMedia = value; },
    resolveMedia(index) { pendingMedia[index]?.(); },
    pendingMedia() { return pendingMedia.length; },
    setDeferDownload(value) { deferDownload = value; },
    resolveDownload(index) { pendingDownloads[index]?.(); },
    pendingDownloads() { return pendingDownloads.length; },
  };
}

(async () => {
  const unsafeLabel = '<img src="https://untrusted.test/x" onerror="alert(1)">';
  let p = await page("popup", { items: [{ label: unsafeLabel, ext: "mp4", url: "https://media.test/video", sub: "84 MB" }, { label: "Unavailable format", disabled: true }] });
  assert.strictEqual(p.ids.status.textContent, "Connected");
  assert(p.ids.openApp.className.includes("secondary-action"));
  const buttons = p.document.querySelectorAll("[data-download]");
  assert.strictEqual(buttons.length, 2); assert(!buttons[0].disabled); assert(buttons[1].disabled);
  assert(p.all.some((n) => n.className === "media-title" && n.textContent === unsafeLabel), "media labels stay literal text");
  await buttons[0].fire("click");
  const download = p.messages.find((m) => m.type === "swiftget-download");
  assert(download); assert.strictEqual(download.item.url, "https://media.test/video"); assert.strictEqual(download.referrer, "https://example.test/watch");
  assert.strictEqual(download.selectionVersion, 0);
  assert.strictEqual(download.fileName, "Calm_ _Coast__.mp4"); assert.strictEqual(buttons[0].dataset.sent, "true"); assert(buttons[0].disabled);
  const count = p.messages.length; await buttons[0].fire("click"); assert.strictEqual(p.messages.length, count, "sent actions do not submit twice");
  p.ids.enabled.checked = false; await p.ids.enabled.fire("change"); assert.strictEqual(p.store.enabled, false); assert(p.ids.scale.disabled); assert(buttons.every((b) => b.disabled));
  p.ids.enabled.checked = true; await p.ids.enabled.fire("change"); assert(buttons[1].disabled, "unavailable rows stay disabled after resume");
  await p.ids.settings.fire("click"); assert.strictEqual(p.opened(), 1); assert.strictEqual(p.closed(), 1);

  p = await page("popup", { online: false, items: [{ label: "720p · MP4", url: "https://media.test/v" }] });
  assert.strictEqual(p.ids.status.textContent, "App Not Running"); assert(!p.ids.connectionHint.hidden);
  const offlineButton = p.document.querySelectorAll("[data-download]")[0]; await offlineButton.fire("click"); assert(!offlineButton.disabled); assert.strictEqual(offlineButton.dataset.pending, "false"); assert(p.all.some((n) => n.className === "row-error" && !n.hidden));

  p = await page("popup", { url: "https://www.youtube.com/watch?v=x&list=synthetic", items: [{ label: "Audio", ext: "m4a" }], store: { enabled: false, bubbleSize: "large" } });
  assert.strictEqual(p.ids.scaleText.textContent, "125%"); assert(p.document.querySelectorAll("[data-download]").every((b) => b.disabled));
  p.ids.enabled.checked = true; await p.ids.enabled.fire("change"); await p.document.querySelectorAll("[data-download]")[0].fire("click"); assert(p.messages.some((m) => m.type === "swiftget-playlist"));
  await p.ids.scaleReset.fire("click"); assert.strictEqual(p.store.bubbleScale, 1);

  p = await page("popup", { items: [{ type: "protected", protected: true, disabled: true, label: "Protected Video", sub: "Use official downloads." }] });
  assert.strictEqual(p.document.querySelectorAll("[data-download]").length, 0); assert.strictEqual(p.ids.mediaCount.textContent, "");
  assert(p.all.some((n) => n.href === "https://help.netflix.com/en/node/54816")); assert(!p.messages.some((m) => m.type === "swiftget-download"));

  const turn = () => new Promise((resolve) => setImmediate(resolve));
  p = await page("popup", { url: "https://example.test/#/video/a", items: [{ label: "Previous video", url: "https://media.test/a", ext: "mp4" }] });
  const staleButton = p.document.querySelectorAll("[data-download]")[0];
  p.setTab({ url: "https://example.test/#/video/b", title: "Next video" });
  p.setMedia([{ label: "Next video", url: "https://media.test/b", ext: "mp4" }], "token-b");
  p.emitUpdated({ url: "https://example.test/#/video/b" });
  await staleButton.fire("click");
  assert(!p.messages.some((m) => m.type === "swiftget-download"), "old popup action cannot submit after route change");
  await turn(); await turn();
  assert(p.ids.media.children.some((row) => row.children.some((child) => child.children?.some((n) => n.textContent === "Next video"))), "new route is shown");
  const newButton = p.document.querySelectorAll("[data-download]")[0];
  await newButton.fire("click");
  const nextDownload = p.messages.find((m) => m.type === "swiftget-download");
  assert.strictEqual(nextDownload.clientToken, "token-b"); assert.strictEqual(nextDownload.tabId, 7); assert.strictEqual(nextDownload.item.url, "https://media.test/b");

  p = await page("popup", { items: [{ label: "Prior source", url: "https://media.test/source-a", ext: "mp4" }] });
  const priorSourceButton = p.document.querySelectorAll("[data-download]")[0];
  p.setMedia([{ label: "Replacement source", url: "https://media.test/source-b", ext: "mp4" }], "token-source-b");
  p.emitMedia();
  await priorSourceButton.fire("click");
  assert(!p.messages.some((m) => m.type === "swiftget-download"), "same-page source changes immediately invalidate old popup actions");
  await turn(); await turn();
  assert(p.document.querySelectorAll("[data-download]")[0].attributes['aria-label'].includes('Replacement source'));

  p = await page("popup", { items: [{ label: "Embedded A", frameId: 1, frameToken: "frame-a", url: "https://media.test/a" }] });
  const frameAButton = p.document.querySelectorAll("[data-download]")[0];
  p.setMedia([{ label: "Embedded B", frameId: 2, frameToken: "frame-b", url: "https://media.test/b" }], "token-a", 1);
  p.emitMedia();
  await frameAButton.fire("click");
  assert(!p.messages.some(m => m.type === "swiftget-download"), 'changing the active embedded frame immediately invalidates old actions');
  await turn(); await turn();
  const frameBButton = p.document.querySelectorAll("[data-download]")[0];
  assert(frameBButton.attributes['aria-label'].includes('Embedded B'));
  await frameBButton.fire("click");
  const frameBDownload = p.messages.find(m => m.type === "swiftget-download");
  assert.strictEqual(frameBDownload.selectionVersion, 1);
  assert.strictEqual(frameBDownload.item.frameId, 2);

  p = await page("popup", { items: [{ label: "Old", url: "https://media.test/old", ext: "mp4" }] });
  p.setDeferMedia(true); p.emitMedia(); await turn();
  assert.strictEqual(p.pendingMedia(), 1);
  p.setTab({ url: "https://example.test/next" });
  p.setMedia([{ label: "Newest", url: "https://media.test/new", ext: "mp4" }], "token-new");
  p.setDeferMedia(false); p.emitUpdated({ url: "https://example.test/next" }); await turn(); await turn();
  p.resolveMedia(0); await turn();
  const latestButton = p.document.querySelectorAll("[data-download]")[0];
  assert(latestButton.attributes['aria-label'].includes('Newest'), 'late old response cannot replace the new video');

  p = await page("popup", { items: [{ label: "Stable", url: "https://media.test/stable", ext: "mp4" }] });
  p.setDeferDownload(true);
  const pendingButton = p.document.querySelectorAll("[data-download]")[0];
  const pendingClick = pendingButton.fire("click"); await turn();
  assert.strictEqual(p.pendingDownloads(), 1);
  p.emitMedia(); await turn();
  assert.strictEqual(p.document.querySelectorAll("[data-download]")[0], pendingButton, 'same-video updates do not disrupt an in-flight action');
  p.resolveDownload(0); await pendingClick; await turn();
  assert(p.document.querySelectorAll("[data-download]")[0].disabled, 'sent state survives a same-video refresh');

  // Format rows: quality first, then file type · audio · size, clamped text.
  const textOf = (node) => node.textContent + node.children.map(textOf).join("");
  const byClass = (root, cls) => { const out = []; const walk = (n) => { if (n.className.split(/\s+/).includes(cls)) out.push(n); n.children.forEach(walk); }; walk(root); return out; };
  p = await page("popup", { items: [
    { label: "1080p Full HD · MP4", sub: "44.6 MB", yt: { key: "1080p|MP4", quality: "1080p", tag: "Full HD", ext: "mp4", size: 46800000, audioUrl: "https://gv/140", codec: "H.264", title: "Pacific Coast — A Moment by the Ocean" } },
    { label: "720p HD · MP4", sub: "size unknown", yt: { key: "720p|MP4+A", quality: "720p", tag: "HD", ext: "mp4", size: 0 } },
    { label: "1080p · MP4 (video only)", yt: { key: "1080p|MP4-v", quality: "1080p", ext: "mp4", hasAudio: false, size: 1000000 } },
    { label: "Audio only · M4A 128k", sub: "3.9 MB", yt: { key: "audio|M4A", quality: "audio", ext: "m4a", kbps: 128, size: 4e6 } },
    { label: "video/mp4 · 24.5 MB", sub: "https://cdn.media.test/clip.mp4", url: "https://cdn.media.test/clip.mp4", ext: "mp4" },
    { label: "Getting video qualities…", sub: "This takes a few seconds", disabled: true },
  ] });
  assert.strictEqual(p.ids.videoTitle.textContent, "Pacific Coast — A Moment by the Ocean", "the app's video title is shown once above the formats");
  assert(!p.ids.videoTitle.hidden);
  const rowTitles = byClass(p.ids.media, "media-title").map((n) => n.textContent);
  assert.deepStrictEqual(rowTitles, ["1080p Full HD", "720p HD", "1080p Full HD", "Audio Only", "Video File", "Getting video qualities…"]);
  const details = byClass(p.ids.media, "media-detail");
  assert.strictEqual(details.length, 6, "every row has exactly one secondary line");
  assert.deepStrictEqual(details[0].children.map((n) => n.textContent), ["MP4", "With audio", "44.6 MB"]);
  assert.deepStrictEqual(details[1].children.map((n) => n.textContent), ["MP4", "With audio", "Size unknown"], "unknown sizes are stated plainly");
  assert.strictEqual(byClass(details[2], "no-audio")[0].textContent, "No audio", "silent video is flagged");
  assert.deepStrictEqual(details[3].children.map((n) => n.textContent), ["M4A", "128 kbps", "3.9 MB"]);
  assert(textOf(details[4]).includes("24.5 MB") && textOf(details[4]).includes("cdn.media.test"));
  assert.strictEqual(p.document.querySelectorAll("[data-download]").length, 5, "worker progress is not offered as a download");
  assert.strictEqual(p.ids.mediaCount.textContent, "5 formats");
  assert(p.document.querySelectorAll("[data-download]")[0].attributes["aria-label"].startsWith("Download: 1080p Full HD, MP4, With audio"));
  assert(byClass(p.ids.media, "button-text").length === 5, "button text can collapse to an icon in a narrow panel");

  const css = fs.readFileSync(path.join(extension, "apple-ui.css"), "utf8");
  const clamp = /\.video-title, \.media-title, \.media-detail \{[^}]*-webkit-line-clamp: 2;[^}]*overflow-wrap: break-word/.test(css);
  assert(clamp, "titles, labels and details clamp to two lines and wrap at word boundaries");
  assert(!/overflow-wrap: anywhere/.test(css), "popup text never collapses into single-letter columns");
  assert(/html\.popup-document \{ width: 3[67]\dpx; \}/.test(css), "the popup keeps a definite, stable width");
  for (const file of ["popup.js", "options.js", "content.js"]) {
    assert(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(fs.readFileSync(path.join(extension, file), "utf8")), `${file} never parses text as HTML`);
  }

  // Same-tab video switch: the title is cleared immediately and replaced.
  p = await page("popup", { url: "https://example.test/#/video/a", title: "First clip", items: [{ label: "A", url: "https://media.test/a", ext: "mp4", yt: { key: "a", quality: "720p", title: "Old Title" } }] });
  assert.strictEqual(p.ids.videoTitle.textContent, "Old Title");
  p.setTab({ url: "https://example.test/#/video/b", title: "Next clip - YouTube" });
  p.setMedia([{ label: "B", url: "https://media.test/b", ext: "mp4" }], "token-b");
  p.emitUpdated({ url: "https://example.test/#/video/b" });
  assert.strictEqual(p.ids.videoTitle.textContent, "", "invalidation clears the previous title at once");
  assert(p.ids.videoTitle.hidden);
  await turn(); await turn();
  assert.strictEqual(p.ids.videoTitle.textContent, "Next clip", "the new tab title replaces it");
  p.setMedia([{ label: "B2", url: "https://media.test/b2", ext: "mp4" }], "token-b2");
  p.emitMedia();
  assert.strictEqual(p.ids.videoTitle.textContent, "", "a same-page source change also clears the title");
  await turn(); await turn();
  p.setTab({ url: "https://example.test/#/video/c" });
  p.setMedia([{ label: "C", url: "https://media.test/c", ext: "mp4" }], "token-c");
  p.emitUpdated({ url: "https://example.test/#/video/c" }); await turn(); await turn();
  assert(p.ids.videoTitle.hidden, "a tab title still left over from the previous video is not shown");
  p.setTab({ title: "Third clip" }); p.emitUpdated({ title: "Third clip" });
  assert.strictEqual(p.ids.videoTitle.textContent, "Third clip", "the title appears when the page updates it");
  assert(p.document.querySelectorAll("[data-download]")[0].attributes["aria-label"].includes("C"));

  p = await page("popup", { items: [] });
  assert.strictEqual(p.ids.videoTitle.textContent, ""); assert(p.ids.media.children[0].className.includes("is-empty"), "an empty page has its own state");

  // The preview harness renders the real popup/options markup.
  const harness = fs.readFileSync(path.join(__dirname, "popup-preview.html"), "utf8");
  for (const name of ["popup", "options"]) {
    const body = /<body[^>]*>([\s\S]*?)<script src="[a-z]+\.js"><\/script>\s*<\/body>/.exec(fs.readFileSync(path.join(extension, `${name}.html`), "utf8"))[1];
    const template = new RegExp(`<template id="${name}-markup">([\\s\\S]*?)</template>`).exec(harness)[1];
    const squash = (text) => text.replace(/\s+/g, " ").trim();
    assert.strictEqual(squash(template), squash(body), `popup-preview.html ${name} markup matches ${name}.html`);
  }

  let o = await page("options", { preparedPort: 19614, store: { bubbleSize: "small" } });
  assert.strictEqual(o.ids.port.value, "19614"); assert.strictEqual(o.ids.bubbleScaleText.textContent, "85%");
  o.ids.port.value = "65536"; await o.ids.port.fire("change"); assert.strictEqual(o.writes.length, 0); assert(!o.ids["port-error"].hidden);
  o.ids.port.value = "9614.5"; await o.ids.port.fire("change"); assert.strictEqual(o.writes.length, 0);
  o.ids.port.value = "19719"; await o.ids.port.fire("change"); assert.strictEqual(o.store.port, 19719); assert(o.ids["port-error"].hidden);
  o.ids.minSize.value = "-1"; await o.ids.minSize.fire("change"); assert(!o.ids["minimum-error"].hidden);
  o.ids.minSize.value = "0.5"; await o.ids.minSize.fire("change"); assert.strictEqual(o.store.minSizeKB, .5);
  o.ids.intercept.checked = false; await o.ids.intercept.fire("change"); assert.strictEqual(o.store.intercept, false);
  o.ids.bubbleScale.value = "150"; await o.ids.bubbleScale.fire("input"); assert.strictEqual(o.store.bubbleScale, 1.5); assert.strictEqual(o.ids.bubbleScaleText.textContent, "150%");
  await o.ids.bubbleScaleReset.fire("click"); assert.strictEqual(o.store.bubbleScale, 1);
  o = await page("options", { preparedPort: 19614, store: { port: 19719 } }); assert.strictEqual(o.ids.port.value, "19719", "explicit port overrides prepared default");
  o = await page("options", { preparedPort: 999999 }); assert.strictEqual(o.ids.port.value, "9614", "invalid prepared metadata falls back");
  console.log("extension UI contracts: download/playlist messages, safe labels, paused/offline/protected states, scale migration, settings validation and prepared-port precedence passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
