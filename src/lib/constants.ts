import type { Category } from "../types/photo";

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
