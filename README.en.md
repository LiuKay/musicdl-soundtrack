<div align="right">

**English** · [简体中文](README.md)

</div>

# Soundtrack · 声轨

Search for music, arrange a playback queue, and download selected tracks in one interface.

Soundtrack uses [musicdl](https://github.com/CharlesPikachu/musicdl) and runs in a local browser or as a packaged macOS / Windows desktop app. Its light interface includes an independent playback queue, shuffle and repeat modes, batch selection, and synced lyrics.

Eight sources are integrated: Migu, NetEase Cloud Music, Kuwo, QQ Music, Kugou, 5sing, Jamendo, and Spotify. Only Migu is enabled by default. Choose others in the sidebar, or the horizontal source list on phones. Availability depends on your network, provider APIs, and access permissions.

![Compact search results with readable providers, recording versions, formats, and download status (generated test audio)](docs/search-compact-desktop.png)

Screenshots show the current source version. Check each Release's notes for the features included in its package.

## How search results arrive

musicdl resolves an audio URL for each result, which can require several network requests. Soundtrack sends resolved tracks to the browser as they become available:

- **Per-result streaming.** The backend drives musicdl's `_search` directly, watches the result list it fills in as it resolves each track, and pushes every track to the browser the instant it's ready via Server-Sent Events (SSE). Results appear one by one instead of all at once after a long wait.
- **Concurrent sources.** Each source runs in a separate thread. Results from one source can appear while another is still searching.
- **Search timeout.** After `PER_SOURCE_TIMEOUT`, the app stops waiting for that source and reports its timeout without discarding other results.
- **Streaming playback.** The app streams the resolved URL through a backend proxy with HTTP Range support for seeking. You do not need to download the full track first.
- **Live download progress.** Chunked downloads report downloaded MB and speed in real time.

## Run

```bash
pip install -r requirements.txt
python app.py
# open http://127.0.0.1:5000 in your browser
```

Use `PORT=8080 python app.py` to pick a different port. Downloaded files are saved under `downloads/<source>/`.

## Build the macOS app

```bash
make app
open dist/Soundtrack.app
```

Apple's command-line build tools are required. The build verifies pinned source archives and compiles the minimal audio tools, then installs desktop packaging tools into `.venv`; the first build needs network access and takes several minutes. The app saves music under `~/Downloads/Soundtrack/` by default, and the download drawer can select another folder; “Cache played songs” stores temporary files under `~/Library/Caches/Soundtrack/audio/`.

## Build the Windows app

Install MSYS2 UCRT64 and the packages listed in the [audio build guide](docs/audio-tools.md), then run in PowerShell on Windows:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
.\build-windows.ps1
```

The executable is created at `dist\Soundtrack\Soundtrack.exe`; keep its supporting files alongside it. The `Windows release` workflow builds the app and uploads its ZIP and corresponding audio-tool sources to the same GitHub Release.

> Your network must be able to reach the selected music platforms. For learning and research only. Please respect copyright and each platform's terms of service.

## Usage

- Type a keyword in the top bar to search; results stream in one by one. The last 10 searches are stored locally for reuse, individual removal, or clearing. Music-source selections also persist.
- Toggle music sources in the sidebar (a horizontal list at the top on phones; only Migu is on by default). The light interface uses layered neutral surfaces, a berry-red accent, and system fonts with no online font dependency.
- Desktop results retain a compact first-track summary and play action; phones prioritize the list. Titles wrap to retain original live/instrumental version descriptions, providers use readable names, and placeholder values such as NULL are hidden. Result order is not a popularity or recommendation ranking.
- Per-source status shows searching, result counts, timeouts, and request failures without hiding results from other sources.
- Select tracks or all current results, then use "下载所选" to add them to the existing concurrent download queue. Results arriving later are not automatically selected.
- "播放全部" creates an independent playback queue from the current results. New searches do not clear it; each row also offers a play-next action that inserts or moves the track.
- The player supports shuffle, sequential play, repeat-all, and repeat-one. Repeat-one applies at the natural end of a song; manual next/previous still changes tracks.
- The bottom-right queue button lets you inspect, play, remove, or clear upcoming tracks while retaining the current song; "清空全部并停止" clears everything and stops playback. The first 200 tracks, current selection, shuffle order, and repeat mode persist. Reopening restores a paused queue, without restoring playback position.
- The download panel shows unfinished task counts and explains what happens on exit. Desktop confirms closing while requests are being submitted or tasks are queued, downloading, converting, or cancelling. Cancel keeps the app running; completed or failed records alone do not block closing. Unfinished tasks must be added again after exit; completed files remain.
- Browser close/reload requests a leave warning only for unfinished tasks known to this page or pending submissions. The browser controls the text and whether it appears; some mobile browsers may suppress it. Submitted tasks continue while the backend runs. Stopping or force-killing the backend interrupts them; forced system termination cannot be intercepted, and restart/resume is unsupported. Desktop uses native confirmation without a duplicate browser prompt.
- Restored remote tracks fetch fresh links when played, matching the exact provider and track/quality identity. If that version cannot be confirmed, retry or search again; a same-title recording is never substituted automatically. Broken streams get at most one automatic refresh. Local tracks are checked against their directory, relative path, size, and modification time; changed or missing files must be selected again.
- Only track metadata and preferences are stored, without playback URLs, temporary tokens, or lyrics. Browser records belong to the same origin, including its port; clearing site data removes them, and the last interaction wins across tabs. Desktop uses a dedicated persistent browser directory and local port `42001`, allowing one instance; an occupied port aborts startup instead of opening another service. Old private sessions cannot be migrated. Unavailable storage does not prevent current-session use.
- Each row offers play, play-next, and download buttons. Double-clicking a song row also plays it.
- Set the download format above the results: MP3 by default, original FLAC, or "每次选择" (ask each time). The preference persists in this browser. When asking each time, FLAC is offered only if every selected track is originally FLAC; cancelling creates no tasks.
- Preflight checks local files and active tasks. An existing file with the same provider, track identity, quality, and target format offers view, save another copy, or cancel; active tasks are not queued twice. Batch downloads use one confirmation, skip existing tracks by default, and list conversion requirements and unavailable items.
- New downloads retain identity in `.soundtrack.json`, allowing recognition after a new search or app restart. Legacy files and results without reliable identifiers only get same-name hints, never an automatic skip based on title alone. Moved or missing files can be downloaded again.
- Original MP3/FLAC audio is downloaded directly in its matching format. Other audio can be converted to 320 kbps MP3, never to FLAC; conversion does not improve source quality. Cached audio follows the same checks. Tasks show inspection, conversion waiting/progress, and metadata saving. Only one conversion runs at a time; cancellation cleans temporary files. Repeated downloads preserve existing audio under distinct filenames.
- Bottom player bar: previous / play-pause / next, seek, volume, live spectrum.
- “Cache played songs” attempts to cache each full song in the background when playback starts. Cached playback and completed writes evict the least recently used files to meet the selected 512 MB–5 GB limit. Limit changes apply on the next cached playback; active writes may temporarily exceed it. Switching caching off does not cancel writes already started.
- “Manage playback cache” shows usage, completed files, and active writes, with refresh and confirmed cleanup. Cleanup only removes app-generated files at the cache root, preserving active writes, symbolic links, provider workspaces, and downloaded music. Files that cannot be removed are reported for retry. Cache management and automatic eviction are disabled if the cache and download directories contain one another; use separate directories.
- Cached songs do not appear in Local music and are not guaranteed to work offline. Use Download for permanent copies; playback after cleanup may need to load audio again.
- The download drawer can run 1–5 downloads at once; additional tasks wait in click order.
- The "词" button opens synced lyrics. "下载任务" shows progress and recent completions; "本地音乐" opens the main workspace for finding, playing, and managing files. Desktop builds support choosing a folder in the download drawer and revealing files from the local library.
- Search local music by title, artist, or album; combine keywords with a format filter and sort by recently saved, title, or artist. "清除筛选" clears filters and "刷新文件" rereads the folder. Counts show visible and total tracks; filters last for the current page session.
- Filtering does not change the active playback queue. Clicking a track or "播放筛选结果" creates a queue from the visible list. Switching between search and local music preserves each view. Failed reads offer retry; changing folders invalidates old file actions before loading the new folder to prevent operations on a different same-name file.
- The library shows actual formats and offers "导出 MP3" for non-MP3 files, preserving the original and supporting cancellation. Search results matching a saved FLAC recording can also export MP3 locally without downloading it again.
- Recent completions retain a file action: reveal on desktop or save to the device in a browser. Removing a completed task record keeps its audio file. Failed tasks show the full error and offer individual retry or "重试失败项" (retry failed tasks).
- Reloading the page or reopening the drawer restores tasks from the current backend process and syncs retries/removals from other pages. The snapshot includes all active tasks and the latest 100 completed/failed records. Task records do not survive app exit; saved audio remains in the library.
- New downloads create a matching `.lrc` and try to embed title, artist, album, lyrics, and artwork into MP3, FLAC, M4A, and OGG files; internal `.soundtrack.json` and `.soundtrack.cover.jpg/.png/...` files remain only as app index/fallback data.
- Shortcuts: `Space` to play/pause, `Alt+←/→` for previous/next track.
- `Esc` closes drawers. Focus the seek or volume slider and use arrow keys to adjust it, or `Home/End` to reach either end. Phones retain seeking and cache settings.

![Independent playback queue with track removal and a clear-upcoming action](docs/interface-queue.webp)

![Batch preflight: skip existing MP3, reuse local FLAC, and show conversion requirements (generated test audio)](docs/download-workflow-desktop.png)

[Mobile duplicate confirmation screenshot](docs/download-workflow-mobile.png) · [Product backlog and implementation status](TODO.md)

![Dedicated local library with combined keyword, format, and sort controls (generated test audio)](docs/library-desktop.png)

[Mobile local library screenshot](docs/library-mobile.png)

You can keep listening to the current queue while searching for other music. Favorites and playlist-link import are not yet available.

## UI verification

```bash
node --test test_ui.cjs
python -m unittest -v test_app.py test_audio_formats.py test_download_workflow.py
```

Frontend regression tests need no extra Node.js packages and cover queue isolation, repeat/shuffle, batch preflight, duplicate confirmation, retries, task restoration, library filtering/sorting and failed folder changes, stale responses, drawers, and keyboard controls. Backend tests cover display cleanup, identity across searches, concurrent deduplication, path validation, file preservation, and real local exports using isolated directories and generated audio. Live music providers still require manual online verification.

## Structure

```
app.py             Flask backend: streaming search (SSE) / audio proxy (Range) / cover proxy / download progress (SSE)
static/index.html  UI markup
static/style.css   Visual styling (Apple Music-inspired light workspace)
static/app.js      Frontend logic: streaming search / queue / Web Audio / lyrics / batch downloads
static/session.js  History and queue validation / persistence / exact-identity resolution
docs/             Pages showcase and screenshots; no hosted search or download service
```

## Configuration

Constants at the top of `app.py`:

- `SUPPORTED_SOURCES`: add or remove sources and change their defaults.
- `SEARCH_SIZE_PER_SOURCE`: how many tracks to resolve per source; larger values take longer.
- `PER_SOURCE_TIMEOUT`: how long to wait for each source, in seconds.

There is no login or Cookie settings interface. Developers can configure authorized source parameters in `ClientManager._build()` using the musicdl documentation. This does not guarantee access to a track, subscription quality, or protected format. Do not commit credentials.

Starting with v0.7.0, macOS / Windows desktop packages bundle minimal FFmpeg, FFprobe and LAME tools for offline MP3 conversion without additional installation; existing v0.6.0 packages do not contain them. Only audio processing and local file input are enabled, with no video encoders or network protocols. The drawer's "MP3 转换" section shows readiness and offers recovery guidance and rechecking when needed.

When running from source, install FFmpeg / FFprobe with `libmp3lame`, or set executable paths through `SOUNDTRACK_FFMPEG` / `SOUNDTRACK_FFPROBE`. Lookup order is explicit configuration, bundled tools, then system PATH / Homebrew. Invalid explicit overrides are not silently ignored. Native MP3/FLAC downloads remain available if conversion tools are missing or cannot run; batch preflight marks tracks requiring conversion as unavailable. Real audio conversion tests are skipped when tools are unavailable.

Complete tool licenses are included in the app's `audio-tools/licenses` directory. Corresponding sources and build scripts are separate Release assets, not runtime dependencies. See the [audio-tool guide](docs/audio-tools.md) for versions, checksums, rebuilding and release requirements.

For development checks, `SOUNDTRACK_SETTINGS_DIR` selects an isolated desktop settings and web-storage directory, alongside isolated download and cache directories. The packaged smoke test uses temporary directories automatically.

Maintainers can follow the [GitHub web release guide (Chinese)](docs/releasing.md) to create a version, check automated packaging and retry failed builds.

Soundtrack plays and downloads direct audio URLs resolved by musicdl through its own HTTP flow, not the source-specific musicdl `_download` flow. It supports local MP3 conversion but does not implement media decryption, HLS merging, download-task recovery after a restart, or resumable downloads. Apple Music, Deezer, Joox, Qianqian, Qobuz, SoundCloud, StreetVoice, Soda Music, and TIDAL are not integrated. The Apple Music-inspired appearance does not imply access to the Apple Music service.

## Credits

Built on [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl). All search and audio-resolution logic comes from musicdl; this project adds the streaming web UI, player, and download experience.
