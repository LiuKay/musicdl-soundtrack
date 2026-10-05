"""Local audio inspection and cancellable MP3 encoding (no remote FFmpeg inputs)."""
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from mutagen.flac import FLAC
from mutagen.mp3 import MP3

INPUT_FORMATS = 'mp3,flac,wav,ogg,mov,aac,aiff,ape,asf,wv'


def tool_path(name):
    configured = os.environ.get('SOUNDTRACK_' + name.upper())
    if configured:
        return shutil.which(configured)
    return (shutil.which(name) or shutil.which('/opt/homebrew/bin/' + name)
            or shutil.which('/usr/local/bin/' + name))


def can_convert():
    return bool(tool_path('ffmpeg') and tool_path('ffprobe'))


def _stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def inspect_audio(path, check_cancelled):
    # Native MP3/FLAC remain available even without the optional FFmpeg tools.
    for kind, reader in (('flac', FLAC), ('mp3', MP3)):
        try:
            info = reader(path).info
            if info.length > 0:
                return kind, info.length
        except Exception:
            pass
    probe = tool_path('ffprobe')
    if not probe:
        raise ValueError('无法识别音频；转换需要安装 FFmpeg 和 FFprobe')
    process = subprocess.Popen([
        probe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', INPUT_FORMATS,
        '-select_streams', 'a:0', '-show_entries',
        'stream=codec_name,duration:format=duration', '-of', 'json', path,
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 20
    try:
        while True:
            check_cancelled()
            if time.monotonic() > deadline:
                raise ValueError('音频格式检测超时')
            try:
                output, _ = process.communicate(timeout=.2)
                break
            except subprocess.TimeoutExpired:
                continue
        data = json.loads(output) if process.returncode == 0 else {}
        streams = data.get('streams', [])
        if not streams:
            raise ValueError('文件不是可用的音频')
        duration = data.get('format', {}).get('duration', streams[0].get('duration', 0))
        try:
            duration = float(duration)
        except (TypeError, ValueError):
            duration = 0
        # Only the native readers above certify direct MP3/FLAC files.
        return 'other', duration
    finally:
        _stop(process)


def convert_mp3(source, destination, duration, check_cancelled, report):
    executable = tool_path('ffmpeg')
    if not executable:
        raise ValueError('转换需要安装 FFmpeg 和 FFprobe')
    with tempfile.TemporaryDirectory(prefix='soundtrack-transcode-') as work:
        progress = Path(work, 'progress')
        progress.touch()
        with open(progress, encoding='utf-8') as reader:
            process = subprocess.Popen([
                executable, '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', source,
                '-map', '0:a:0', '-vn', '-map_metadata', '-1',
                '-c:a', 'libmp3lame', '-b:a', '320k', '-threads', '1',
                '-progress', str(progress), '-f', 'mp3', destination,
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 1800
            try:
                while True:
                    check_cancelled()
                    if time.monotonic() > deadline:
                        raise ValueError('转换超时，请重试')
                    for line in reader:
                        if duration > 0 and line.startswith('out_time_us='):
                            try:
                                report(min(99, max(0, int(line.split('=', 1)[1]) / duration / 10000)))
                            except ValueError:
                                pass
                    try:
                        process.wait(timeout=.2)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                check_cancelled()
                if process.returncode != 0:
                    raise ValueError('MP3 转换失败：音频损坏或 FFmpeg 缺少 MP3 编码器')
                if inspect_audio(destination, check_cancelled)[0] != 'mp3':
                    raise ValueError('转换结果不是有效的 MP3')
            finally:
                _stop(process)
