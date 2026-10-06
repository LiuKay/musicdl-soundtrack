# Bundled audio tools

Soundtrack runs FFmpeg and FFprobe as separate local processes. Desktop builds include a small audio-only build; no executable is downloaded at runtime. MP3 encoding uses LAME.

## Reproduce

Pinned unmodified sources:

- FFmpeg 8.1.3: https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz
  SHA-256: `7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3`
- LAME 3.100: https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
  SHA-256: `ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`

On macOS install Apple's command-line build tools, then run `bash scripts/build-audio-tools.sh` from the checkout. On Windows use MSYS2 UCRT64 with `make`, `curl`, `tar`, `xz` and `mingw-w64-ucrt-x86_64-gcc`, and run the same command in that shell. Nothing is installed globally by this script. `SOUNDTRACK_BUILD_JOBS` controls parallel compilation (default 4).

Output: `build/audio-tools/bin/ffmpeg[.exe]`, `ffprobe[.exe]`, license texts, the actual FFmpeg configuration, and `audio-tools-source.tar.gz`. Working trees remain under `build/audio-build.*` for diagnosis. Each build verifies source checksums before extraction. To rebuild offline, put the exact archives in `build/audio-sources/` first. Builds target the current CPU; they are not universal binaries.

The source archive contains both original tarballs, this document, the build script and actual FFmpeg configuration. Recreate a checkout-shaped directory with `scripts/build-audio-tools.sh`, `docs/audio-tools.md`, and `build/audio-sources/` containing the tarballs, then run the script. Source files are not patched. Compiler and operating-system versions can affect binary output; this is a reproducible recipe, not a claim of bit-for-bit reproducibility.

## Scope and licensing

Only local file/pipe input, the application's audio demuxers/decoders, audio resampling, and MP3 output are enabled. Video encoding, network protocols, capture devices, ffplay, optional system libraries, GPL and nonfree components are disabled. Unsupported/encrypted inputs still fail explicitly; original MP3/FLAC downloads never require transcoding.

FFmpeg is built under LGPL 2.1-or-later. LAME is under LGPL 2.0-or-later. Copyright remains with their respective authors. See the complete license texts included in the app's `audio-tools/licenses` directory and the upstream projects at https://ffmpeg.org/ and https://lame.sourceforge.io/ . LAME is statically linked into the separate FFmpeg executables; the corresponding source and build recipe allow rebuilding those executables with a modified library. Soundtrack does not link these libraries into Python.

Every release distributing the executables must also attach the corresponding `audio-tools-source.tar.gz` (with a platform-specific release filename), include the notices in the application, and link to the source asset in the Release notes. Do not substitute a different prebuilt FFmpeg without rechecking its enabled components, licenses, source availability and tests.

See https://ffmpeg.org/legal.html for FFmpeg's license guidance. This document describes this build; it is not a general license exemption for bundled software.
