param([switch]$SkipAudioBuild)
$ErrorActionPreference = 'Stop'

if (-not $SkipAudioBuild) {
    $audioBuildBash = if ($env:SOUNDTRACK_BASH) { $env:SOUNDTRACK_BASH } else { 'C:\msys64\usr\bin\bash.exe' }
    if (-not (Test-Path $audioBuildBash)) { throw 'Install MSYS2 UCRT64 build tools; see docs/audio-tools.md' }
    $env:MSYSTEM = 'UCRT64'
    $env:SOUNDTRACK_PROJECT_DIR = (Get-Location).Path
    & $audioBuildBash -lc 'cd "$(cygpath -u "$SOUNDTRACK_PROJECT_DIR")" && bash scripts/build-audio-tools.sh'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
foreach ($required in @('bin/ffmpeg.exe', 'bin/ffprobe.exe', 'licenses/FFmpeg-LGPL-2.1.txt', 'licenses/LAME-LGPL-2.0.txt', 'audio-tools-source.tar.gz')) {
    if (-not (Test-Path "build/audio-tools/$required")) { throw "Missing bundled audio tools: $required" }
}

$python = if (Test-Path '.venv\Scripts\python.exe') {
    '.venv\Scripts\python.exe'
} else {
    'python'
}

& $python -m pip install -r requirements.txt pywebview==6.2.1 pyinstaller==6.16.0
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Remove-Item -Recurse -Force 'build\pyinstaller', 'dist\Soundtrack' -ErrorAction SilentlyContinue
& $python -m PyInstaller --clean --noconfirm --windowed --name Soundtrack `
    --workpath 'build\pyinstaller' `
    --add-data 'static;static' `
    --add-binary 'build/audio-tools/bin/ffmpeg.exe;audio-tools/bin' `
    --add-binary 'build/audio-tools/bin/ffprobe.exe;audio-tools/bin' `
    --add-data 'build/audio-tools/licenses;audio-tools/licenses' `
    --collect-all fake_useragent `
    --collect-all musicdl `
    --collect-all webview `
    --collect-all send2trash `
    desktop.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
