import { useCallback, useEffect, useRef, useState } from "react";
import {
  autoEdit,
  getAiProfile,
  saveAiProfile,
  listPresets,
  personalModelStatus,
  type AiProfileConfig,
  type AutoEditResult,
  type PersonalModelStatus,
  type Preset,
} from "../../lib/sidecar";
import type { EditSettings, PhotoEntry, ScanProgress } from "../../types/photo";

interface AutoEditDialogProps {
  projectId: number;
  photos: PhotoEntry[];
  onClose: () => void;
  onDone: () => void; // reload project (hydrate new edit settings)
}

type Phase = "configure" | "running" | "done" | "error";

const SCENES: { key: string; label: string; hint: string }[] = [
  { key: "portrait", label: "Portrait", hint: "faces detected" },
  { key: "backlit", label: "Backlit", hint: "bright background, dark subject" },
  { key: "low-light", label: "Low light", hint: "dark scenes" },
  { key: "outdoor", label: "Outdoor", hint: "bright & colorful" },
  { key: "indoor", label: "Indoor", hint: "everything else" },
];

export function AutoEditDialog({ projectId, photos, onClose, onDone }: AutoEditDialogProps) {
  const [phase, setPhase] = useState<Phase>("configure");
  const [config, setConfig] = useState<AiProfileConfig | null>(null);
  const [userPresets, setUserPresets] = useState<Preset[]>([]);
  const [sceneChoice, setSceneChoice] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [result, setResult] = useState<AutoEditResult | null>(null);
  const [errorText, setErrorText] = useState("");
  const [modelStatus, setModelStatus] = useState<PersonalModelStatus | null>(null);
  // "standard" = scene-based engine; "personal" = the user's learned profile.
  const [mode, setMode] = useState<"standard" | "personal">("standard");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([getAiProfile(), listPresets()])
      .then(([profile, presets]) => {
        setConfig(profile.config);
        setUserPresets(presets);
      })
      .catch((err) => {
        setErrorText(String(err));
        setPhase("error");
      });
    personalModelStatus()
      .then((s) => {
        setModelStatus(s);
        // Default to My Style once the personal model is trained and good
        // enough, matching how Aftershoot/Imagen default to the personal
        // profile — but the choice stays visible and switchable.
        if (s.available && s.usable) setMode("personal");
      })
      .catch(() => {});
  }, []);

  const personalReady = !!(modelStatus?.available && modelStatus.usable);
  const samplesCollected = modelStatus?.trainingSamples ?? 0;
  const MIN_SAMPLES = 50;

  const start = useCallback(async () => {
    if (!config) return;
    setPhase("running");
    const controller = new AbortController();
    abortRef.current = controller;

    // Scene presets: default engine preset unless the user picked a preset
    const scenePresets: Record<string, Partial<EditSettings>> = { ...config.scenePresets };
    for (const [scene, presetId] of Object.entries(sceneChoice)) {
      if (!presetId) continue;
      const preset = userPresets.find((p) => String(p.id) === presetId);
      if (preset) scenePresets[scene] = preset.settings;
    }
    const finalConfig: AiProfileConfig = {
      ...config,
      scenePresets,
      usePersonalModel: mode === "personal",
    };

    try {
      saveAiProfile(finalConfig).catch(() => {});
      const res = await autoEdit(
        projectId,
        photos.map((p) => p.id),
        finalConfig,
        (p) => setProgress(p),
        controller.signal
      );
      setResult(res);
      setPhase("done");
      onDone();
    } catch (err) {
      if (String(err).includes("cancelled")) {
        setErrorText("Auto-edit cancelled.");
        setPhase("done");
        onDone();
      } else {
        setErrorText(String(err));
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }, [config, sceneChoice, userPresets, projectId, photos, onDone, mode]);

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="auto-edit-dialog">
      <div className="w-[460px] bg-zinc-900 rounded-2xl p-6 shadow-2xl border border-zinc-700">
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">✨ Auto-Edit</h2>
        <p className="text-xs text-zinc-500 mb-4">
          {photos.length} photo{photos.length === 1 ? "" : "s"} · scene detection + exposure
          normalization + per-scene look
        </p>

        {phase === "configure" && config && (
          <div className="space-y-4">
            {/* Standard vs My Style selector */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setMode("standard")}
                aria-pressed={mode === "standard"}
                className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                  mode === "standard"
                    ? "bg-blue-950/50 border-blue-600 text-blue-100"
                    : "bg-zinc-800/60 border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <div className="text-sm font-medium">Standard</div>
                <div className="text-[10px] opacity-70 mt-0.5">
                  Scene-based, general best
                </div>
              </button>
              <button
                onClick={() => personalReady && setMode("personal")}
                disabled={!personalReady}
                aria-pressed={mode === "personal"}
                title={
                  personalReady
                    ? "Edit in your learned style"
                    : "Learns from your edits — train a profile first"
                }
                className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${
                  mode === "personal"
                    ? "bg-violet-950/50 border-violet-600 text-violet-100"
                    : personalReady
                      ? "bg-zinc-800/60 border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                      : "bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed"
                }`}
              >
                <div className="text-sm font-medium">🧠 My Style</div>
                <div className="text-[10px] opacity-70 mt-0.5">
                  {personalReady
                    ? "Your learned profile"
                    : samplesCollected >= MIN_SAMPLES
                      ? "Trained model below quality bar"
                      : `${samplesCollected}/${MIN_SAMPLES} edits collected`}
                </div>
              </button>
            </div>

            {mode === "personal" && (
              <p className="text-xs text-violet-300/80">
                Predicts the full edit per photo from your learned style. Scene
                settings below are the per-photo fallback when the model is unsure.
              </p>
            )}

            <div className="space-y-2">
              {SCENES.map((scene) => (
                <div key={scene.key} className="flex items-center gap-2">
                  <div className="w-24">
                    <div className="text-xs text-zinc-300">{scene.label}</div>
                    <div className="text-[9px] text-zinc-600">{scene.hint}</div>
                  </div>
                  <select
                    value={sceneChoice[scene.key] ?? ""}
                    onChange={(e) =>
                      setSceneChoice((prev) => ({ ...prev, [scene.key]: e.target.value }))
                    }
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Built-in look</option>
                    {userPresets.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        Preset: {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.normalizeExposure}
                onChange={(e) =>
                  setConfig({ ...config, normalizeExposure: e.target.checked })
                }
                className="w-4 h-4 rounded bg-zinc-800 border-zinc-600 text-blue-500"
              />
              <span className="text-xs text-zinc-400">
                Normalize exposure (brighten dark shots, tame bright ones)
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={config.skipEdited}
                onChange={(e) => setConfig({ ...config, skipEdited: e.target.checked })}
                className="w-4 h-4 rounded bg-zinc-800 border-zinc-600 text-blue-500"
              />
              <span className="text-xs text-zinc-400">
                Skip photos I've already edited
              </span>
            </label>

            <div className="flex gap-3 pt-1">
              <button
                onClick={start}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium text-white ${
                  mode === "personal"
                    ? "bg-violet-700 hover:bg-violet-600"
                    : "bg-blue-600 hover:bg-blue-500"
                }`}
              >
                {mode === "personal" ? "Edit in My Style" : "Auto-Edit"}{" "}
                {photos.length} photo{photos.length === 1 ? "" : "s"}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-400"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-3">
            <div className="flex justify-between text-xs text-zinc-500">
              <span className="truncate">{progress?.message || "Starting..."}</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <button
              onClick={() => abortRef.current?.abort()}
              className="w-full py-2.5 bg-red-900/60 hover:bg-red-800/70 border border-red-800 rounded-lg text-sm font-medium text-red-200"
            >
              Cancel
            </button>
          </div>
        )}

        {phase === "done" && (
          <div className="space-y-4">
            {result ? (
              <div className="text-sm text-zinc-300 space-y-1">
                <p>
                  Edited <span className="font-semibold text-white">{result.edited}</span> photos
                  {result.skipped > 0 && <> · skipped {result.skipped} already-edited</>}
                </p>
                <p className="text-xs text-zinc-500">
                  {Object.entries(result.scenes)
                    .filter(([, n]) => n > 0)
                    .map(([s, n]) => `${s}: ${n}`)
                    .join(" · ") || "no scenes"}
                </p>
              </div>
            ) : (
              <p className="text-sm text-zinc-300">{errorText}</p>
            )}
            <button
              onClick={onClose}
              className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-300"
            >
              Close
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4">
            <p className="text-sm text-red-400">{errorText}</p>
            <button
              onClick={onClose}
              className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-300"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
