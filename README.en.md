<div align="right">

**English** · [简体中文](README.md)

</div>

# Soundtrack · 声轨

A modern web-based music **search / download / player** built on top of [musicdl](https://github.com/CharlesPikachu/musicdl).
Supports eight sources: Migu, NetEase Cloud Music, Kuwo, QQ Music, Kugou, 5sing, Jamendo, and Spotify. **Migu is the only source enabled by default** — the rest are one click away in the UI.

![soundtrack](soundtrack.png)

## Why it doesn't freeze

musicdl's search is slow because it resolves the **real audio URL for every single result** (multiple network round-trips). A naive blocking `music_client.search()` makes the UI hang for 10–30 seconds. This project avoids that with a few techniques:

- **Per-result streaming.** The backend drives musicdl's `_search` directly, watches the result list it fills in as it resolves each track, and pushes every track to the browser the instant it's ready via Server-Sent Events (SSE). Results appear one by one instead of all at once after a long wait.
- **Concurrent sources.** Each music source runs on its own thread, so fast sources (Migu) show up first and slow ones never block them.
- **Watchdog timeout.** Any source that hangs longer than `PER_SOURCE_TIMEOUT` seconds is dropped and flagged, so one stuck platform can never freeze the whole UI.
- **Instant playback.** The direct URL is already resolved during search, so playback streams through a backend proxy (with HTTP Range support for seeking) — no need to download the full track first.
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

The build command installs the desktop-only packaging tools into `.venv`. The app saves music under `~/Downloads/Soundtrack/` by default, and the download drawer can select another folder; “Cache while playing” files are stored under `~/Library/Caches/Soundtrack/audio/`.

## Build the Windows app

Run in PowerShell on Windows:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
.\build-windows.ps1
```

The executable is created at `dist\Soundtrack\Soundtrack.exe`. You can also run the `Windows app` workflow from GitHub Actions and download its artifact.

> ⚠️ You need a network environment that can reach the music platforms. For learning and research only — please respect copyright and each platform's terms of service.

## Usage

- Type a keyword in the top bar to search; results stream in one by one.
- Toggle music sources with the chips at the top (only Migu is on by default).
- Each row: ▷ play, ⭳ download. Double-clicking a row also plays it.
- Bottom player bar: previous / play-pause / next, seek, volume, live spectrum.
- “Cache while playing” keeps listened tracks locally and removes the oldest cache files when the selected 512 MB–5 GB limit is exceeded.
- The download drawer can run 1–5 downloads at once; additional tasks wait in click order.
- The "词" button opens the synced lyrics panel; the bottom-right button opens downloads, changes the download folder, and plays downloaded tracks inside the existing player.
- New downloads create a matching `.lrc` and try to embed title, artist, album, lyrics, and artwork into MP3, FLAC, M4A, and OGG files; internal `.soundtrack.json` and `.soundtrack.cover.jpg/.png/...` files remain only as app index/fallback data.
- Shortcuts: `Space` to play/pause, `Alt+←/→` for previous/next track.

## Structure

```
app.py             Flask backend: streaming search (SSE) / audio proxy (Range) / cover proxy / download progress (SSE)
static/index.html  UI markup
static/style.css   Visual styling (dark "recording-studio" theme)
static/app.js      Frontend logic: streaming render / Web Audio spectrum / synced lyrics / downloads
```

## Configuration

Constants at the top of `app.py`:

- `SUPPORTED_SOURCES` — add or remove music sources, change which are on by default.
- `SEARCH_SIZE_PER_SOURCE` — how many tracks to resolve per source (larger = slower).
- `PER_SOURCE_TIMEOUT` — per-source timeout in seconds.

For member-quality audio, pass `default_search_cookies` to the relevant source inside `ClientManager._build()`, following the official musicdl docs.

Soundtrack only consumes direct audio URLs resolved by musicdl during search. This phase does not implement source-specific media decryption, HLS segment merging, media transcoding, or source-specific musicdl `_download` flows; content that requires login cookies, a paid account, or any of those special paths is unsupported. Apple Music, Deezer, Joox, Qianqian, Qobuz, SoundCloud, StreetVoice, Soda Music, and TIDAL are not included in this phase, and TIDAL's dedicated download handling is unsupported.

## Credits

Built on [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl). All search and audio-resolution logic comes from musicdl; this project adds the streaming web UI, player, and download experience.
