"""
test_xmp.py — round-trip tests for xmp_mapping.py.

Run: venv/Scripts/python python-backend/tests/test_xmp.py
"""

import os
import sys
import tempfile

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_here))

import xmp_mapping as xm  # noqa: E402

FIXTURES = os.path.join(_here, "fixtures")

passed = 0
failed = []


def check(cond, name, extra=""):
    global passed
    if cond:
        passed += 1
        print(f"PASS: {name}")
    else:
        failed.append(name)
        print(f"FAIL: {name} {extra}")


# --- 1. Lightroom sidecar (attribute style, PV 15.4) -------------------------
s, warns = xm.read_xmp_file(os.path.join(FIXTURES, "lr_sidecar.xmp"))
check(s.get("temperature") == 6200, "lr: temperature")
check(s.get("tint") == 12, "lr: tint (+ sign stripped)")
check(abs(s.get("exposure", 0) - 0.85) < 1e-9, "lr: exposure2012")
check(s.get("highlights") == -64, "lr: highlights")
check(s.get("sharpenAmount") == 55 and abs(s.get("sharpenRadius", 0) - 1.2) < 1e-9, "lr: sharpen")
check(s.get("noiseReduceLuminance") == 12, "lr: luminance NR")
check(s.get("hslSatOrange") == -16 and s.get("hslLumBlue") == -25, "lr: HSL fields")
check(s.get("calRedSat") == 7 and s.get("calShadowsTint") == 6, "lr: calibration")
check(s.get("colorProfile") == "portrait", "lr: CameraProfile mapped")
tc = s.get("toneCurve")
check(tc and len(tc) == 4 and abs(tc[0][1] - 12 / 255) < 1e-4, "lr: tone curve parsed", str(tc))
check(s.get("toneCurveBlue") is not None and s.get("toneCurveRed") is None, "lr: per-channel curves")
check(not warns, "lr: no warnings", str(warns))

# --- 2. Preset (element style) ------------------------------------------------
p, warns = xm.read_xmp_file(os.path.join(FIXTURES, "preset.xmp"))
check(p.get("temperature") == 7100, "preset: element-style temperature")
check(abs(p.get("exposure", 0) - 0.3) < 1e-9, "preset: exposure")
check(p.get("hslHueGreen") == -40, "preset: HSL green hue")
check(p.get("colorProfile") == "color", "preset: profile")
check(p.get("toneCurve") and len(p["toneCurve"]) == 2, "preset: tone curve")

# --- 3. Legacy PV2010 — warn + skip 2010 tone fields --------------------------
l, warns = xm.read_xmp_file(os.path.join(FIXTURES, "legacy_pv2010.xmp"))
check(any("legacy" in w.lower() or "2010" in w for w in warns), "legacy: warning emitted", str(warns))
check("exposure" not in l, "legacy: Exposure(2010) skipped")
check("contrast" not in l, "legacy: Contrast(2010) skipped")
check(l.get("temperature") == 5300 and l.get("vibrance") == 15, "legacy: safe fields still read")
check(l.get("sharpenAmount") == 40, "legacy: sharpness read")

# --- 4. Write round-trip -------------------------------------------------------
settings = {
    "temperature": 6800, "tint": -20, "exposure": 1.25, "contrast": 33,
    "highlights": -70, "shadows": 55, "whites": 10, "blacks": -15,
    "texture": 20, "clarity": 15, "dehaze": 8, "vibrance": 30, "saturation": -10,
    "sharpenAmount": 80, "sharpenRadius": 1.5, "sharpenDetail": 40, "sharpenMasking": 25,
    "noiseReduceLuminance": 20, "noiseReduceColor": 30,
    "hslHueRed": 25, "hslSatAqua": -45, "hslLumMagenta": 60,
    "calShadowsTint": -12, "calRedHue": 9, "calBlueSat": -33,
    "colorProfile": "vivid",
    "toneCurve": [[0, 0.05], [0.5, 0.55], [1, 0.98]],
    "toneCurveGreen": [[0, 0], [1, 1]],  # identity — must NOT be written
}
xml_text = xm.build_sidecar_xml(settings)
rt, warns = xm.parse_xmp(xml_text)
check(rt.get("temperature") == 6800 and rt.get("tint") == -20, "roundtrip: WB")
check(abs(rt.get("exposure", 0) - 1.25) < 1e-9, "roundtrip: exposure")
check(rt.get("hslSatAqua") == -45 and rt.get("hslLumMagenta") == 60, "roundtrip: HSL")
check(rt.get("calBlueSat") == -33, "roundtrip: calibration")
check(rt.get("colorProfile") == "vivid", "roundtrip: profile")
rtc = rt.get("toneCurve")
check(rtc and len(rtc) == 3 and abs(rtc[1][0] - 0.5) < 3e-3 and abs(rtc[1][1] - 0.55) < 3e-3,
      "roundtrip: tone curve (255-space quantization ok)", str(rtc))
check(rt.get("toneCurveGreen") is None, "roundtrip: identity curve omitted")
check('crs:ProcessVersion="15.4"' in xml_text, "write: ProcessVersion 15.4")

# --- 5. Merge preserves foreign content ----------------------------------------
with open(os.path.join(FIXTURES, "lr_sidecar.xmp"), "r", encoding="utf-8") as f:
    existing = f.read()
# strip xpacket PI lines for ET round-trip simplicity (real files keep them via write_sidecar path)
existing_body = "\n".join(
    line for line in existing.splitlines() if not line.strip().startswith("<?xpacket")
)
merged = xm.merge_into_sidecar(existing_body, {"exposure": -2.0, "temperature": 4500})
m, _ = xm.parse_xmp(merged)
check(abs(m.get("exposure", 0) + 2.0) < 1e-9, "merge: our field replaced")
check(m.get("temperature") == 4500, "merge: temperature replaced")
check("NIKON" in merged, "merge: tiff:Make preserved")
check("Lightroom Classic" in merged, "merge: xmp:CreatorTool preserved")
# Old tone curve removed (managed element), since new settings had identity/no curve
check(m.get("toneCurve") is None, "merge: managed curve element replaced/removed")

# --- 6. write_sidecar file flow -------------------------------------------------
tmp = tempfile.mkdtemp(prefix="xmp_test_")
photo = os.path.join(tmp, "IMG_001.NEF")
open(photo, "wb").close()
out = xm.write_sidecar(photo, {"exposure": 0.5})
check(out == os.path.join(tmp, "IMG_001.xmp") and os.path.exists(out), "write_sidecar: path + created")
# second write merges without error
xm.write_sidecar(photo, {"exposure": 0.7, "contrast": 10})
m2, _ = xm.read_xmp_file(out)
check(abs(m2.get("exposure", 0) - 0.7) < 1e-9 and m2.get("contrast") == 10, "write_sidecar: merge update")

print()
if failed:
    print(f"{len(failed)} FAILURES: {failed}")
    sys.exit(1)
print(f"ALL {passed} XMP TESTS PASSED")
