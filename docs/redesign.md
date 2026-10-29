# Mac Downloader redesign notes

The interface was redesigned as a quiet macOS utility. Behavior, storage and
browser/native protocols are unchanged unless listed under "Deliberate
changes".

## Feature inventory (preserved)

| Area | Features |
|---|---|
| Downloads | add (typed, clipboard, browser, API), segmented HTTP up to 32 connections, pause/resume/retry/redownload, refresh expired address, move/rename, play while downloading, SHA-256 check, properties, drag a finished file out |
| Streams | HLS, DASH video+audio merge (ffmpeg), yt-dlp formats, playlists, protected-video notice |
| Library | All / Unfinished / Finished, categories (add, edit, delete, folders, sites), queues (start, stop, edit, schedule, reorder files), search, sort, compact list and column table (resize, reorder, choose columns), multi-selection (Command/Shift click, drag, Command-A, arrow keys) |
| Batch & discovery | batch list and `*` pattern, site grabber, "download all links", torrents and magnet links |
| Control | global and per-download speed limits, quota, scheduler, when-done actions (sleep, shut down, exit), duplicate handling, sounds, malware scan hook, proxy, site logins (Keychain-protected), user agent |
| Windows | New Download, compact progress monitor + inspector (connections, speed limit, when finished), complete, duplicate, countdown, tips, what's new, updates, about, browser setup assistant |
| Platform | menu bar item (Show, New Download, Settings, Quit), quiet `--background` login start, keep running when closed, single instance, appearance override (System/Light/Dark), text size, font, background picture, eight languages, import/export (.ef2, .txt) |
| Extension | download interception, cookies/referrer hand-off, popup, options, in-page video button and format picker, same-tab video switching with generation checks, fullscreen hiding, reserved YouTube lane, drag/scale/dismiss/keyboard |

## Design system (`crates/app/ui/common.slint`)

* **Color**: AppKit semantic colors resolved in Rust (`appearance.rs`) feed
  `Theme`. Chrome (title bar, toolbar, sidebar) is one quiet tint; content
  (list, groups) is the readable surface. Hover/press/fill are translucent so
  they read on any surface. Status colors are contrast-corrected to 4.5:1.
  Increase Contrast strengthens separators.
* **Type**: system font; caption 11, footnote 12, body 13, title3 15, title2
  17, title1 22 — all scaled by Settings › Appearance › Text size.
* **Category tints**: one restrained tint per file kind (white symbol ≥ 3:1).
* **Components**: `IconButton`, `ToolbarButton`, `SearchField`, `TreeItem`,
  `SidebarHeading`, `KindTile`, `ProgressBar`, `SegmentedBar`/`Segment`,
  `Disclosure`, `Notice`, `FormSection`/`FormRow`/`FormStackRow`,
  `FieldRow`, `EmptyState`, `MenuPanel`/`MenuEntry`. Standard Cupertino
  widgets supply text fields, pop-ups, switches and push buttons so control
  heights match native ones.
* **Motion**: only progress widths animate, and not at all with Reduce Motion.

## Deliberate changes

* Rows show one detail line computed in Rust (`row_detail`): only known
  figures (no total, speed or time estimate is invented for unknown sizes).
* The progress monitor sizes itself to its content (`natural-height`); it no
  longer shows a percentage or bar when the size is unknown.
* Monitors cascade instead of opening exactly on top of each other.
* Arrow keys move the selection (Shift extends it); Command-Delete removes.
* Sizes read like Finder: `512 KB`, `45.2 MB`, `1.49 GB`.
* macOS title bars are transparent; windows whose header names them hide the
  title text (the title remains for VoiceOver, the Window menu and Mission
  Control).
* Browser extension: worker progress/errors appear as messages rather than
  disabled format rows; a page title left over from the previous video is not
  shown after a same-tab switch.

## Branding and compatibility

Visible text says "Mac Downloader". These identifiers are compatibility
contracts and were kept: bundle ID `com.ezoo.EzooDownload`, data folder
`~/Library/Application Support/com.Ezoo.EzooDownload`, LaunchAgent label,
Keychain service, API handshake (`"app":"EzooDownload"`), `ezoo-download://`
URL scheme, Firefox add-on ID, the Windows executable, setup file name,
install folder and registry keys (self-update depends on them).

New browser setups prepare `Browser Extensions/Mac Downloader Extension`.
A folder prepared earlier as `Ezoo Download Extension` stays where it is and
is refreshed in place, because browsers load unpacked extensions by path.

## Verification

* `cargo test --workspace`, plus new tests for row details, percent display,
  keyboard selection, view titles, Finder-style sizes and the legacy
  extension folder.
* `node extension/test/*.js` (four suites, with new assertions).
* Visual checks of the running app in an isolated profile (separate bundle
  ID, HOME, data folder and port) in light and dark, Arabic at 150 %, and of
  the extension through `extension/test/popup-preview.html` and
  `widget-preview.html`.
