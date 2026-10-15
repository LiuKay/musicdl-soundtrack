<div align="right">

**English** · [简体中文](README.md)

</div>

# Soundtrack · 声轨

Find music, compare sources and quality, listen, and save it locally.

Built on [musicdl](https://github.com/CharlesPikachu/musicdl), Soundtrack runs in a local browser or as a macOS / Windows desktop app, with an independent queue, synced lyrics, favorites, a local library and batch MP3 / original FLAC downloads.

![Grouped source versions and search filters (generated local test audio)](docs/product-search-desktop.png)

Screenshots show the current source. Check each Release for packaged features.

## Get started

Download the desktop package for your system from [Releases](https://github.com/LiuKay/musicdl-soundtrack/releases), extract it completely, and open it. If macOS cannot verify the developer, follow the [first-launch guide](docs/first-launch.md#english).

Or run from source:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
# Open http://127.0.0.1:5000
```

On Windows activate with `.venv\Scripts\Activate.ps1`. Use `PORT=8080 python app.py` to change the port.

## Five steps

1. Search by song or artist. Migu is enabled initially; select more sources to find alternatives, allowing more time.
2. Combine lossless, downloaded and possible-clip filters. Expand “N 个版本” to compare source, format and known bitrate; live and instrumental names stay intact.
3. Play a track to listen, or play filtered results with one default version per song. Further searches leave the active queue intact.
4. Download a single track or select a batch. MP3 is the default; Settings offers original FLAC or ask-each-time. Existing files trigger confirmation.
5. Find files in Local music and retain tracks in Favorites. Settings contains caching, position memory, update checks and shortcut help.

Sources include Migu, NetEase, Kuwo, QQ Music, Kugou, 5sing, Jamendo and Spotify. Availability depends on connectivity and provider APIs. Short audio is only marked as a possible clip and may be a complete work. Grouping and default quality choices are not popularity rankings.

## Common questions

- **Where are files saved?** Desktop defaults to `~/Downloads/Soundtrack/` and offers folder selection in Downloads. Source runs use `downloads/<source>/`. Completed tasks and Local music offer file actions.
- **What if search fails?** Retry the failed source or choose another; other results, selections and the active queue remain.
- **Does caching replace downloads?** Cache is temporary, automatically cleaned and not guaranteed offline. Download permanent copies.
- **Do favorites and queues persist?** They are saved in this browser or desktop profile. Reopening stays paused; play fetches the same recording again. Clearing site data removes these records.
- **How do updates work?** Settings shows your version and checks stable releases. Open the release page to download/install manually. Startup checks can be disabled.

## Development and checks

```bash
make test
make app  # macOS, requires Apple command-line tools
```

See the [full usage and development guide](docs/usage.en.md) for Windows builds, audio tools, task recovery, storage rules and packaged validation.

[Mobile search](docs/product-search-mobile.png) · [Settings](docs/product-settings-desktop.png) · [Release guide](docs/releasing.md) · [Product backlog](TODO.md) · [Changelog](CHANGELOG.md)

Respect copyright and provider terms. Built on [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl); no account or Cookie configuration UI is provided.
