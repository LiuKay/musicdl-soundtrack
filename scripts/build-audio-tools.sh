#!/usr/bin/env bash
# Native macOS or MSYS2 UCRT64 build. No system installation or runtime download.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
LAME_VERSION=3.100
LAME_SHA256=ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
SOURCES="$ROOT/build/audio-sources"
OUTPUT="$ROOT/build/audio-tools"
mkdir -p "$SOURCES" "$OUTPUT"
WORK=$(mktemp -d "$ROOT/build/audio-build.XXXXXX")
PREFIX="$WORK/install"
JOBS=${SOUNDTRACK_BUILD_JOBS:-4}

fetch_source() {
    local url=$1 file=$2 expected=$3 actual
    if [[ ! -f "$file" ]]; then
        curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 "$url" -o "$file"
    fi
    if command -v sha256sum >/dev/null; then
        actual=$(sha256sum "$file")
    else
        actual=$(shasum -a 256 "$file")
    fi
    [[ ${actual%% *} == "$expected" ]] || { echo "Checksum mismatch: $file" >&2; exit 1; }
}

fetch_source "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
    "$SOURCES/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
fetch_source "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" \
    "$SOURCES/lame-$LAME_VERSION.tar.gz" "$LAME_SHA256"
tar -xf "$SOURCES/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$WORK"
tar -xf "$SOURCES/lame-$LAME_VERSION.tar.gz" -C "$WORK"

LAME_FLAGS=(--disable-dependency-tracking)
FFMPEG_FLAGS=(--disable-x86asm)
SUFFIX=
case "$(uname -s)" in
    Darwin)
        # LAME's old config.guess predates Apple Silicon.
        if [[ $(uname -m) == arm64 ]]; then LAME_FLAGS+=(--build=aarch64-apple-darwin); fi
        ;;
    MINGW*|MSYS*)
        [[ ${MSYSTEM:-} == UCRT64 ]] || { echo 'Use MSYS2 UCRT64' >&2; exit 1; }
        SUFFIX=.exe
        FFMPEG_FLAGS+=(--extra-ldflags=-static --disable-pthreads --enable-w32threads)
        ;;
    *) echo 'Supported build hosts: macOS, MSYS2 UCRT64' >&2; exit 1 ;;
esac

cd "$WORK/lame-$LAME_VERSION"
CFLAGS='-O2' ./configure --prefix="$PREFIX" --disable-shared --enable-static \
    --disable-frontend --disable-decoder "${LAME_FLAGS[@]}"
make -j"$JOBS"
make install

cd "$WORK/ffmpeg-$FFMPEG_VERSION"
./configure --prefix="$PREFIX" --disable-autodetect --disable-everything \
    --disable-gpl --disable-nonfree --disable-version3 \
    --disable-network --disable-devices --disable-doc --disable-debug \
    --disable-ffplay --disable-shared --enable-static \
    --disable-avdevice --disable-swscale --enable-small \
    --enable-ffmpeg --enable-ffprobe --enable-libmp3lame \
    --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib" \
    --enable-protocol=file,pipe \
    --enable-demuxer=mp3,flac,wav,ogg,mov,aac,aiff,ape,asf,wv \
    --enable-parser=mpegaudio,flac,aac,aac_latm,opus,vorbis \
    --enable-decoder=mp3,mp3float,flac,aac,aac_fixed,alac,vorbis,opus,ape,wmav1,wmav2,wmapro,wmalossless,wavpack,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_u8,pcm_alaw,pcm_mulaw \
    --enable-encoder=libmp3lame --enable-muxer=mp3 \
    --enable-filter=abuffer,abuffersink,aresample,aformat,anull \
    "${FFMPEG_FLAGS[@]}"
make -j"$JOBS"
make install

mkdir -p "$OUTPUT/bin" "$OUTPUT/licenses"
cp "$PREFIX/bin/ffmpeg$SUFFIX" "$PREFIX/bin/ffprobe$SUFFIX" "$OUTPUT/bin/"
cp "$WORK/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$OUTPUT/licenses/FFmpeg-LGPL-2.1.txt"
cp "$WORK/lame-$LAME_VERSION/COPYING" "$OUTPUT/licenses/LAME-LGPL-2.0.txt"
cp "$ROOT/docs/audio-tools.md" "$OUTPUT/licenses/BUILD-AND-SOURCES.md"
"$OUTPUT/bin/ffmpeg$SUFFIX" -buildconf > "$OUTPUT/licenses/ffmpeg-buildconf.txt" 2>&1
"$OUTPUT/bin/ffmpeg$SUFFIX" -version
"$OUTPUT/bin/ffprobe$SUFFIX" -version

# Corresponding sources and exact recipe accompany every binary release.
mkdir -p "$WORK/corresponding-source"
cp "$SOURCES/ffmpeg-$FFMPEG_VERSION.tar.xz" "$SOURCES/lame-$LAME_VERSION.tar.gz" \
    "$ROOT/scripts/build-audio-tools.sh" "$ROOT/docs/audio-tools.md" "$OUTPUT/licenses/ffmpeg-buildconf.txt" "$WORK/corresponding-source/"
tar -czf "$OUTPUT/audio-tools-source.tar.gz" -C "$WORK" corresponding-source
du -h "$OUTPUT/bin/"* "$OUTPUT/audio-tools-source.tar.gz"
