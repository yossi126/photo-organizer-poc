"""
xmp_mapping.py — Adobe Camera Raw (crs:*) XMP <-> EditSettings mapping.

Single source of truth for all XMP handling, used by:
  - preset import (.xmp develop presets from Lightroom)
  - XMP sidecar export (so Lightroom opens photos with our edits)
  - XMP sidecar reading (training-data ingestion in later phases)

Reading accepts ProcessVersion >= 11 (the 2012 tone pipeline). Legacy PV2010
files are read but their 2010-only tone fields (Exposure, Brightness,
Contrast without the 2012 suffix, Highlights/Shadows recovery) are skipped
with a warning.

Writing emits ProcessVersion 15.4 sidecars. When a sidecar already exists we
MERGE: only mapped crs attributes/elements are replaced; everything else
(other namespaces, unknown crs fields) is preserved.
"""

import os
import re
import xml.etree.ElementTree as ET

NS = {
    "x": "adobe:ns:meta/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "crs": "http://ns.adobe.com/camera-raw-settings/1.0/",
    "xmp": "http://ns.adobe.com/xap/1.0/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "tiff": "http://ns.adobe.com/tiff/1.0/",
    "exif": "http://ns.adobe.com/exif/1.0/",
    "photoshop": "http://ns.adobe.com/photoshop/1.0/",
    "aux": "http://ns.adobe.com/exif/1.0/aux/",
    "xmpMM": "http://ns.adobe.com/xap/1.0/mm/",
    "stEvt": "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#",
}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)

CRS = "{" + NS["crs"] + "}"
RDF = "{" + NS["rdf"] + "}"
X = "{" + NS["x"] + "}"

WRITE_PROCESS_VERSION = "15.4"
WRITE_VERSION = "17.0"

# ---------------------------------------------------------------------------
# Declarative scalar mapping: (crs_name, editsettings_field, decode, encode)
# decode: xmp string -> our value; encode: our value -> xmp string
# ---------------------------------------------------------------------------

def _num(v: str) -> float:
    return float(str(v).replace("+", ""))


def _int_str(v) -> str:
    n = float(v)
    return f"{'+' if n > 0 else ''}{int(round(n))}"


def _float_str(v, decimals=2) -> str:
    n = round(float(v), decimals)
    if n == int(n):
        return f"{'+' if n > 0 else ''}{int(n)}" if n != 0 else "0"
    return f"{'+' if n > 0 else ''}{n}"


_HSL_XMP = ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"]

CRS_MAP = [
    # (crs name, our field, decode fn, encode fn)
    ("Temperature", "temperature", _num, lambda v: str(int(round(float(v))))),
    ("Tint", "tint", _num, _int_str),
    ("Exposure2012", "exposure", _num, lambda v: _float_str(v, 2)),
    ("Contrast2012", "contrast", _num, _int_str),
    ("Highlights2012", "highlights", _num, _int_str),
    ("Shadows2012", "shadows", _num, _int_str),
    ("Whites2012", "whites", _num, _int_str),
    ("Blacks2012", "blacks", _num, _int_str),
    ("Texture", "texture", _num, _int_str),
    ("Clarity2012", "clarity", _num, _int_str),
    ("Dehaze", "dehaze", _num, _int_str),
    ("Vibrance", "vibrance", _num, _int_str),
    ("Saturation", "saturation", _num, _int_str),
    ("Sharpness", "sharpenAmount", _num, lambda v: str(int(round(float(v))))),
    ("SharpenRadius", "sharpenRadius", _num, lambda v: f"+{round(float(v), 1)}" if float(v) > 0 else str(round(float(v), 1))),
    ("SharpenDetail", "sharpenDetail", _num, lambda v: str(int(round(float(v))))),
    ("SharpenEdgeMasking", "sharpenMasking", _num, lambda v: str(int(round(float(v))))),
    ("LuminanceSmoothing", "noiseReduceLuminance", _num, lambda v: str(int(round(float(v))))),
    ("ColorNoiseReduction", "noiseReduceColor", _num, lambda v: str(int(round(float(v))))),
    ("ShadowTint", "calShadowsTint", _num, _int_str),
    ("RedHue", "calRedHue", _num, _int_str),
    ("RedSaturation", "calRedSat", _num, _int_str),
    ("GreenHue", "calGreenHue", _num, _int_str),
    ("GreenSaturation", "calGreenSat", _num, _int_str),
    ("BlueHue", "calBlueHue", _num, _int_str),
    ("BlueSaturation", "calBlueSat", _num, _int_str),
]
# HSL: 24 fields
for _ch in _HSL_XMP:
    CRS_MAP.append((f"HueAdjustment{_ch}", f"hslHue{_ch}", _num, _int_str))
    CRS_MAP.append((f"SaturationAdjustment{_ch}", f"hslSat{_ch}", _num, _int_str))
    CRS_MAP.append((f"LuminanceAdjustment{_ch}", f"hslLum{_ch}", _num, _int_str))

# Camera profile <-> our colorProfile
PROFILE_TO_CRS = {
    "color": "Adobe Color",
    "vivid": "Adobe Vivid",
    "landscape": "Adobe Landscape",
    "portrait": "Adobe Portrait",
    "neutral": "Adobe Neutral",
    "flat": "Adobe Neutral",  # closest Adobe equivalent
}
CRS_TO_PROFILE = {
    "Adobe Color": "color",
    "Adobe Standard": "color",
    "Adobe Vivid": "vivid",
    "Adobe Landscape": "landscape",
    "Adobe Portrait": "portrait",
    "Adobe Neutral": "neutral",
    "Adobe Monochrome": "neutral",
}

TONE_CURVE_ELEMENTS = [
    ("ToneCurvePV2012", "toneCurve"),
    ("ToneCurvePV2012Red", "toneCurveRed"),
    ("ToneCurvePV2012Green", "toneCurveGreen"),
    ("ToneCurvePV2012Blue", "toneCurveBlue"),
]

# PV2010-only fields we deliberately skip on read (different tone model)
LEGACY_2010_FIELDS = {
    "Exposure", "Brightness", "Contrast", "Shadows", "HighlightRecovery",
    "FillLight", "Clarity", "Blacks",
}


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------

def _find_descriptions(root: ET.Element):
    """All rdf:Description elements (works for both sidecars and presets)."""
    if root.tag == RDF + "Description":
        return [root]
    return root.findall(f".//{RDF}Description")


def _crs_value(descs, name: str):
    """Look up a crs field either as an attribute or a child element's text."""
    for d in descs:
        v = d.get(CRS + name)
        if v is not None:
            return v
        el = d.find(CRS + name)
        if el is not None and el.text is not None and el.text.strip():
            return el.text.strip()
    return None


def _parse_tone_curve(descs, crs_name: str):
    """ToneCurvePV2012 rdf:Seq of 'x, y' strings in 0..255 -> [[0..1, 0..1]]."""
    for d in descs:
        el = d.find(f"{CRS}{crs_name}")
        if el is None:
            continue
        lis = el.findall(f".//{RDF}li")
        points = []
        for li in lis:
            if not li.text:
                continue
            m = re.match(r"\s*([\d.+-]+)\s*,\s*([\d.+-]+)\s*", li.text)
            if m:
                points.append([round(float(m.group(1)) / 255.0, 5),
                               round(float(m.group(2)) / 255.0, 5)])
        if len(points) >= 2:
            return points
    return None


def parse_xmp(xml_text: str) -> tuple[dict, list[str]]:
    """Parse XMP text -> (partial EditSettings dict, warnings)."""
    warnings = []
    root = ET.fromstring(xml_text)
    descs = _find_descriptions(root)
    if not descs:
        return {}, ["No rdf:Description found in XMP"]

    settings = {}

    pv = _crs_value(descs, "ProcessVersion")
    legacy = False
    if pv is not None:
        try:
            legacy = float(pv) < 11.0
        except ValueError:
            legacy = False
    if legacy:
        warnings.append(
            f"ProcessVersion {pv} uses the legacy 2010 tone pipeline — "
            "2010-only tone fields (Exposure, Brightness, ...) were skipped."
        )

    for crs_name, field, decode, _enc in CRS_MAP:
        raw = _crs_value(descs, crs_name)
        if raw is None:
            continue
        try:
            settings[field] = decode(raw)
        except (ValueError, TypeError):
            warnings.append(f"Could not parse crs:{crs_name}='{raw}'")

    # Note which legacy fields were present but skipped (informational)
    if legacy:
        present_legacy = [n for n in LEGACY_2010_FIELDS if _crs_value(descs, n) is not None]
        if present_legacy:
            warnings.append("Skipped legacy fields: " + ", ".join(sorted(present_legacy)))

    profile = _crs_value(descs, "CameraProfile")
    if profile and profile in CRS_TO_PROFILE:
        settings["colorProfile"] = CRS_TO_PROFILE[profile]

    for crs_name, field in TONE_CURVE_ELEMENTS:
        pts = _parse_tone_curve(descs, crs_name)
        if pts:
            settings[field] = pts

    return settings, warnings


def read_xmp_file(path: str) -> tuple[dict, list[str]]:
    with open(path, "r", encoding="utf-8") as f:
        return parse_xmp(f.read())


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

def _is_identity_curve(points) -> bool:
    return not points or (len(points) == 2 and list(map(list, points)) == [[0, 0], [1, 1]])


def _encode_settings(settings: dict) -> tuple[dict, dict]:
    """-> ({crs_attr_name: string_value}, {crs_curve_name: [[x,y] 0..255]})"""
    attrs = {
        "ProcessVersion": WRITE_PROCESS_VERSION,
        "Version": WRITE_VERSION,
        "HasSettings": "True",
    }
    for crs_name, field, _dec, encode in CRS_MAP:
        if field in settings and settings[field] is not None:
            attrs[crs_name] = encode(settings[field])

    if settings.get("colorProfile"):
        attrs["CameraProfile"] = PROFILE_TO_CRS.get(settings["colorProfile"], "Adobe Color")

    curves = {}
    for crs_name, field in TONE_CURVE_ELEMENTS:
        pts = settings.get(field)
        if pts and not _is_identity_curve(pts):
            curves[crs_name] = [
                [int(round(p[0] * 255)), int(round(p[1] * 255))] for p in pts
            ]
    return attrs, curves


def _curve_xml(crs_name: str, points: list) -> str:
    lis = "\n".join(f"     <rdf:li>{x}, {y}</rdf:li>" for x, y in points)
    return f"""    <crs:{crs_name}>
    <rdf:Seq>
{lis}
    </rdf:Seq>
   </crs:{crs_name}>"""


def build_sidecar_xml(settings: dict) -> str:
    """Build a fresh XMP sidecar document for the given EditSettings."""
    attrs, curves = _encode_settings(settings)
    attr_lines = "\n".join(f'   crs:{k}="{v}"' for k, v in attrs.items())
    curve_block = ""
    if curves:
        curve_block = "\n" + "\n".join(_curve_xml(n, p) for n, p in curves.items())

    return f"""<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="photo-organizer">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
{attr_lines}>{curve_block}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
"""


def merge_into_sidecar(existing_xml: str, settings: dict) -> str:
    """Replace only OUR mapped crs fields in an existing sidecar; preserve
    all other attributes, elements and namespaces."""
    attrs, curves = _encode_settings(settings)
    root = ET.fromstring(existing_xml)
    descs = _find_descriptions(root)
    if not descs:
        return build_sidecar_xml(settings)

    # Choose the description that already carries crs data, else the first
    target = None
    for d in descs:
        if any(k.startswith(CRS) for k in d.attrib) or any(
            child.tag.startswith(CRS) for child in d
        ):
            target = d
            break
    if target is None:
        target = descs[0]

    # Remove our mapped fields wherever they appear (attribute or element form)
    managed = set(attrs.keys()) | {n for n, _f in TONE_CURVE_ELEMENTS}
    for d in descs:
        for name in list(d.attrib):
            if name.startswith(CRS) and name[len(CRS):] in managed:
                del d.attrib[name]
        for child in list(d):
            if child.tag.startswith(CRS) and child.tag[len(CRS):] in managed:
                d.remove(child)

    # Write the new values on the target description
    for k, v in attrs.items():
        target.set(CRS + k, v)
    for crs_name, points in curves.items():
        el = ET.SubElement(target, CRS + crs_name)
        seq = ET.SubElement(el, RDF + "Seq")
        for x, y in points:
            li = ET.SubElement(seq, RDF + "li")
            li.text = f"{x}, {y}"

    return ET.tostring(root, encoding="unicode")


def sidecar_path_for(photo_path: str) -> str:
    """Lightroom-style sidecar path: photo.NEF -> photo.xmp"""
    return os.path.splitext(photo_path)[0] + ".xmp"


def write_sidecar(photo_path: str, settings: dict) -> str:
    """Write (or merge into) the XMP sidecar next to the photo. Returns path."""
    path = sidecar_path_for(photo_path)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            existing = f.read()
        try:
            xml_text = merge_into_sidecar(existing, settings)
        except ET.ParseError:
            xml_text = build_sidecar_xml(settings)
    else:
        xml_text = build_sidecar_xml(settings)
    with open(path, "w", encoding="utf-8") as f:
        f.write(xml_text)
    return path
