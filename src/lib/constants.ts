import type { Category, EditSettings } from "../types/photo";

export const CATEGORY_CONFIG: Record<
  Category,
  { label: string; color: string; bgColor: string }
> = {
  all: { label: "All Photos", color: "#60a5fa", bgColor: "#1e3a5f" },
  clean: { label: "Clean", color: "#4ade80", bgColor: "#14532d" },
  _blurry: { label: "Blurry", color: "#fb923c", bgColor: "#7c2d12" },
  _dark: { label: "Dark", color: "#818cf8", bgColor: "#312e81" },
  _overexposed: { label: "Overexposed", color: "#f87171", bgColor: "#7f1d1d" },
  _eyes_closed: { label: "Eyes Closed", color: "#f472b6", bgColor: "#831843" },
  _duplicates: { label: "Duplicates", color: "#c084fc", bgColor: "#581c87" },
};

export const FILTER_CATEGORIES: Category[] = [
  "all",
  "clean",
  "_blurry",
  "_dark",
  "_overexposed",
  "_eyes_closed",
  "_duplicates",
];

export const DEFAULT_THRESHOLDS = {
  dark: 85,
  blur: 50,
  duplicates: 5,
  overexposed: 220,
};

export const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".tif", ".webp",
  ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf",
  ".orf", ".raf", ".rw2", ".pef", ".dng", ".raw",
]);

export const DEFAULT_EDIT_SETTINGS: EditSettings = {
  // Color Profile
  colorProfile: "color",
  // White Balance
  wbPreset: "as-shot",
  temperature: 5500,
  tint: 0,
  // Light
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  // Presence
  texture: 0,
  clarity: 0,
  dehaze: 0,
  vibrance: 0,
  saturation: 0,
  // Detail
  sharpenAmount: 40,
  sharpenRadius: 1.0,
  sharpenDetail: 25,
  sharpenMasking: 0,
  noiseReduceLuminance: 0,
  noiseReduceColor: 25,
  // HSL — all 24 fields
  hslHueRed: 0,      hslHueOrange: 0,    hslHueYellow: 0,    hslHueGreen: 0,
  hslHueAqua: 0,     hslHueBlue: 0,      hslHuePurple: 0,    hslHueMagenta: 0,
  hslSatRed: 0,      hslSatOrange: 0,    hslSatYellow: 0,    hslSatGreen: 0,
  hslSatAqua: 0,     hslSatBlue: 0,      hslSatPurple: 0,    hslSatMagenta: 0,
  hslLumRed: 0,      hslLumOrange: 0,    hslLumYellow: 0,    hslLumGreen: 0,
  hslLumAqua: 0,     hslLumBlue: 0,      hslLumPurple: 0,    hslLumMagenta: 0,
  // Calibration
  calShadowsTint: 0,
  calRedHue: 0,      calRedSat: 0,
  calGreenHue: 0,    calGreenSat: 0,
  calBlueHue: 0,     calBlueSat: 0,
};
