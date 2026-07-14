# Repository Guidelines

## Project Structure & Module Organization

This is a compact Flask application with a framework-free frontend:

- `app.py` contains the API, search stream, media proxies, downloads, and runtime configuration.
- `static/index.html`, `static/app.js`, and `static/style.css` contain the page markup, browser behavior, and visual theme.
- `requirements.txt` declares Python dependencies.
- `README.md` and `README.zh-CN.md` document usage in English and Chinese; keep them aligned when behavior changes.
- `screenshot.png` shows the expected UI. Generated files under `downloads/` and local virtual environments are not source artifacts.

## Build, Test, and Development Commands

Create an isolated environment and install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Run `python app.py`, then open `http://127.0.0.1:5000`. Use `PORT=8080 python app.py` to change the port. Use HOME="$PWD/.runtime-home" to keeps musicdl’s log files. Before submitting Python changes, run `python -m py_compile app.py` for a syntax check.

## Coding Style & Naming Conventions

Follow the existing style: four-space indentation and `snake_case` for Python functions and variables, `UPPER_CASE` for configuration constants, and `PascalCase` for classes. Frontend JavaScript uses two-space indentation, `camelCase` functions and variables, and `const` by default. Use kebab-case CSS classes and group related rules by component. Keep API paths under `/api/` and preserve the existing SSE event names when changing streaming behavior. No formatter or linter is configured, so keep diffs focused and match surrounding code.

## Testing Guidelines

Run `python -m unittest -v test_app.py` for the search compatibility check. There is no coverage threshold. Manually verify source toggles, incremental search results, playback, seeking, lyrics, downloads, and error states. Test the default Migu source and confirm browser console and Flask logs remain clean. Add focused standard-library tests for logic that works without live music services.

## Commit & Pull Request Guidelines

Recent history favors short, imperative, lowercase subjects such as `fix #84` and `support setting cookies for soda music client`. Keep each commit scoped to one change and reference issues when applicable. Pull requests should explain user-visible behavior, list verification performed, and note any source-specific limitations. Include an updated screenshot or short recording for UI changes, and update both READMEs when commands, configuration, or supported behavior changes.

## Security & Configuration Tips

Do not commit cookies, credentials, downloaded media, `.env` files, or virtual environments. Treat remote URLs and filenames as untrusted input, preserve proxy timeouts and filename sanitization, and respect music-provider terms and copyright restrictions.
