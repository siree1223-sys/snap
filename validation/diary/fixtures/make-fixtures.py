"""Regenerates the Snap Diary test media with real capture metadata.

Needs: pip install pillow piexif pillow-heif imageio-ffmpeg
Run:   python make-fixtures.py   (writes next to this file)
"""
import subprocess
from fractions import Fraction
from pathlib import Path

import imageio_ffmpeg
import piexif
import pillow_heif
from PIL import Image, ImageDraw

pillow_heif.register_heif_opener()
OUT = Path(__file__).resolve().parent


def dms(value):
    value = abs(value)
    d = int(value)
    m = int((value - d) * 60)
    s = Fraction((value - d - m / 60) * 3600).limit_denominator(1000)
    return ((d, 1), (m, 1), (s.numerator, s.denominator))


def exif(taken, lat, lng, offset="+09:00"):
    data = {
        "0th": {piexif.ImageIFD.Make: b"TestCam", piexif.ImageIFD.DateTime: b"2030:01:01 00:00:00"},
        "Exif": {piexif.ExifIFD.DateTimeOriginal: taken.encode(), piexif.ExifIFD.OffsetTimeOriginal: offset.encode()},
        "GPS": {},
    }
    if lat is not None:
        data["GPS"] = {
            piexif.GPSIFD.GPSLatitudeRef: b"N" if lat >= 0 else b"S",
            piexif.GPSIFD.GPSLatitude: dms(lat),
            piexif.GPSIFD.GPSLongitudeRef: b"E" if lng >= 0 else b"W",
            piexif.GPSIFD.GPSLongitude: dms(lng),
        }
    return piexif.dump(data)


def picture(color):
    img = Image.new("RGB", (640, 480), color)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 260, 640, 480], fill=(60, 120, 70))
    d.ellipse([260, 140, 380, 260], fill=(250, 220, 90))
    return img


picture((70, 130, 210)).save(OUT / "seongsu.jpg", quality=88, exif=exif("2026:10:03 14:22:05", 37.5446, 127.0561))
picture((90, 150, 220)).save(OUT / "jeju.jpg", quality=88, exif=exif("2026:10:05 09:10:00", 33.4589, 126.9425))
picture((200, 120, 80)).save(OUT / "noexif.jpg", quality=88)
picture((80, 140, 200)).save(OUT / "seongsu-evening.heic", quality=80, exif=exif("2026:10:03 18:40:00", 37.5470, 127.0580))

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
base = [ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x3c78d8:s=160x120:d=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p"]
# Android-style MP4: UTC creation time + ISO 6709 location (©xyz).
subprocess.run(base + ["-metadata", "creation_time=2026-10-04T03:00:00Z",
                       "-metadata", "location=+35.1587+129.1604/", str(OUT / "haeundae.mp4")], check=True)
# iPhone-style MOV: Apple keys with local time and location.
subprocess.run(base + ["-movflags", "use_metadata_tags",
                       "-metadata", "creation_time=2026-10-04T10:30:00Z",
                       "-metadata", "com.apple.quicktime.creationdate=2026-10-04T19:30:00+0900",
                       "-metadata", "com.apple.quicktime.location.ISO6709=+35.1532+129.1186+005.000/",
                       "-f", "mov", str(OUT / "gwangan.mov")], check=True)


def add_android_location(path, iso6709):
    """Android cameras store location as moov/udta/\xa9xyz (ffmpeg's mp4 muxer does not)."""
    data = bytearray(path.read_bytes())
    pos = 0
    while pos < len(data):
        size = int.from_bytes(data[pos:pos + 4], "big")
        if data[pos + 4:pos + 8] == b"moov":
            text = iso6709.encode()
            xyz = (12 + len(text)).to_bytes(4, "big") + b"\xa9xyz" + len(text).to_bytes(2, "big") + b"\x15\xc7" + text
            udta = (8 + len(xyz)).to_bytes(4, "big") + b"udta" + xyz
            assert pos + size == len(data), "moov must be the last box (no chunk offsets move)"
            data[pos:pos + 4] = (size + len(udta)).to_bytes(4, "big")
            data += udta
            path.write_bytes(bytes(data))
            return
        pos += size
    raise SystemExit("no moov box")


add_android_location(OUT / "haeundae.mp4", "+35.1587+129.1604/")
for p in sorted(OUT.iterdir()):
    print(f"{p.name:24} {p.stat().st_size:>7} bytes")
