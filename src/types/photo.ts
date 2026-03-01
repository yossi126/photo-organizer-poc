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
