/**
 * profiles.ts — Stage 1 of docs/render-pipeline.md.
 *
 * Resolves stored EditSettings into effective slider values:
 * merge over defaults, add color-profile deltas, clamp to slider ranges.
 * Mirrored by python-backend/render.py::resolve_effective — keep in sync.
 */

import { DEFAULT_EDIT_SETTINGS } from "../constants";
import type { EditSettings } from "../../types/photo";

interface ProfileDelta {
  contrast: number;
  saturation: number;
  vibrance: number;
  shadows: number;
  highlights: number;
}

const PROFILE_DELTAS: Record<EditSettings["colorProfile"], ProfileDelta> = {
  color:     { contrast: 0,   saturation: 0,   vibrance: 0,  shadows: 0,  highlights: 0 },
  vivid:     { contrast: 15,  saturation: 15,  vibrance: 10, shadows: 0,  highlights: 0 },
  landscape: { contrast: 10,  saturation: 5,   vibrance: 20, shadows: 0,  highlights: 0 },
  portrait:  { contrast: -5,  saturation: -5,  vibrance: 5,  shadows: 0,  highlights: 0 },
  neutral:   { contrast: -15, saturation: -10, vibrance: 0,  shadows: 0,  highlights: 0 },
  flat:      { contrast: -30, saturation: -20, vibrance: 0,  shadows: 20, highlights: -20 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function resolveEffectiveSettings(stored: Partial<EditSettings>): EditSettings {
  const s: EditSettings = { ...DEFAULT_EDIT_SETTINGS, ...stored };
  const d = PROFILE_DELTAS[s.colorProfile] ?? PROFILE_DELTAS.color;
  return {
    ...s,
    contrast: clamp(s.contrast + d.contrast, -100, 100),
    saturation: clamp(s.saturation + d.saturation, -100, 100),
    vibrance: clamp(s.vibrance + d.vibrance, -100, 100),
    shadows: clamp(s.shadows + d.shadows, -100, 100),
    highlights: clamp(s.highlights + d.highlights, -100, 100),
  };
}
