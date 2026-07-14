$ErrorActionPreference = 'Stop'

$python = if (Test-Path '.venv\Scripts\python.exe') {
    '.venv\Scripts\python.exe'
} else {
    'python'
}

& $python -m pip install -r requirements.txt pywebview==6.2.1 pyinstaller==6.16.0
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Remove-Item -Recurse -Force build, 'dist\Soundtrack' -ErrorAction SilentlyContinue
& $python -m PyInstaller --clean --noconfirm --windowed --name Soundtrack `
    --add-data 'static;static' `
    --collect-all fake_useragent `
    --collect-all musicdl `
    --collect-all webview `
    desktop.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
