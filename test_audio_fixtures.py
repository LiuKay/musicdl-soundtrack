"""One second of self-generated mono silence, 44.1 kHz / 16-bit FLAC.

Stored directly so tests need only an MP3 encoder, as shipped in desktop builds.
"""
from base64 import b64decode

SILENT_FLAC = b64decode(
    'ZkxhQwAAACISABIAAAALAAANCsRA8AAArETp3tgpcw7M0tAnPXzAa+WMhAAALg0AAABM'
    'YXZmNjIuMTIuMTAwAQAAABUAAABlbmNvZGVyPUxhdmY2Mi4xMi4xMDD/+FkIADwAAAAM'
    'jv/4WQgBOwAAAGD2//hZCAIyAAAA1H7/+FkIAzUAAAC4Bv/4WQgEIAAAAD1r//hZCAUn'
    'AAAAURP/+FkIBi4AAADlm//4WQgHKQAAAInj//hZCAgEAAAAb0T/+HkICQpDFwAAAMwP'
)
