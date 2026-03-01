export interface PhotoScores {
  brightness: number;
  blur: number;
  ear: number | null;
}

export interface PhotoEntry {
  filename: string;
  path: string;
  category: Category;
  allLabels: string[];
  scores: PhotoScores;
  starRating: number;
}

export type Category =
  | "all"
  | "clean"
  | "_blurry"
  | "_dark"
  | "_overexposed"
  | "_eyes_closed"
  | "_duplicates";

export interface ScanProgress {
  current: number;
  total: number;
  message: string;
}

export interface ScanSummary {
  _duplicates: number;
  _dark: number;
  _overexposed: number;
  _blurry: number;
  _eyes_closed: number;
  clean: number;
}

export interface ScanThresholds {
  dark: number;
  blur: number;
  duplicates: number;
  overexposed: number;
}

export interface Classifications {
  [filename: string]: {
    primary_category: string;
    all_labels: string[];
    scores: {
      brightness?: number;
      blur?: number;
      ear?: number | null;
    };
  };
}

export interface Ratings {
  [filename: string]: number;
}

export interface EditSettings {
  // Color Profile
  colorProfile: "color" | "vivid" | "landscape" | "portrait" | "neutral" | "flat";

  // White Balance
  wbPreset: "as-shot" | "auto" | "daylight" | "cloudy" | "shade" | "tungsten" | "fluorescent" | "flash" | "custom";
  temperature: number;  // 2000–50000, default 5500
  tint: number;         // -150..+150, default 0

  // Light
  exposure: number;     // -5..+5, default 0
  contrast: number;     // -100..+100, default 0
  highlights: number;   // -100..+100, default 0
  shadows: number;      // -100..+100, default 0
  whites: number;       // -100..+100, default 0
  blacks: number;       // -100..+100, default 0

  // Presence
  texture: number;      // -100..+100, default 0
  clarity: number;      // -100..+100, default 0
  dehaze: number;       // -100..+100, default 0
  vibrance: number;     // -100..+100, default 0
  saturation: number;   // -100..+100, default 0

  // Detail
  sharpenAmount: number;        // 0–150, default 40
  sharpenRadius: number;        // 0.5–3.0, default 1.0
  sharpenDetail: number;        // 0–100, default 25
  sharpenMasking: number;       // 0–100, default 0
  noiseReduceLuminance: number; // 0–100, default 0
  noiseReduceColor: number;     // 0–100, default 25

  // HSL — 8 channels × 3 properties = 24 fields
  hslHueRed: number;      hslHueOrange: number;   hslHueYellow: number;   hslHueGreen: number;
  hslHueAqua: number;     hslHueBlue: number;     hslHuePurple: number;   hslHueMagenta: number;
  hslSatRed: number;      hslSatOrange: number;   hslSatYellow: number;   hslSatGreen: number;
  hslSatAqua: number;     hslSatBlue: number;     hslSatPurple: number;   hslSatMagenta: number;
  hslLumRed: number;      hslLumOrange: number;   hslLumYellow: number;   hslLumGreen: number;
  hslLumAqua: number;     hslLumBlue: number;     hslLumPurple: number;   hslLumMagenta: number;

  // Calibration
  calShadowsTint: number;
  calRedHue: number;      calRedSat: number;
  calGreenHue: number;    calGreenSat: number;
  calBlueHue: number;     calBlueSat: number;
}
