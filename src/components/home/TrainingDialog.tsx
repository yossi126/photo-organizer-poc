import { useCallback, useEffect, useRef, useState } from "react";
import {
  ingestTrainingData,
  trainProfile,
  personalModelStatus,
  type IngestResult,
  type TrainResult,
  type PersonalModelStatus,
} from "../../lib/sidecar";
import type { ScanProgress } from "../../types/photo";

interface TrainingDialogProps {
  onClose: () => void;
}

type Phase = "intro" | "ingesting" | "ingested" | "training" | "trained" | "error";

/**
 * Personal AI Profile wizard: pick folders of edited shoots (image + .xmp
 * sidecar pairs from Lightroom) → ingest → train → report.
 */
export function TrainingDialog({ onClose }: TrainingDialogProps) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [status, setStatus] = useState<PersonalModelStatus | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [epochLog, setEpochLog] = useState<string[]>([]);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [trainResult, setTrainResult] = useState<TrainResult | null>(null);
  const [errorText, setErrorText] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    personalModelStatus().then(setStatus).catch(() => {});
  }, []);

  const addFolder = useCallback(async () => {
    let folder: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      folder = Array.isArray(selected) ? selected[0] : selected;
    } catch {
      folder = prompt("Enter folder path with edited photos (+ .xmp sidecars):");
    }
    if (folder) setFolders((prev) => (prev.includes(folder!) ? prev : [...prev, folder!]));
  }, []);

  const runIngest = useCallback(async () => {
    if (folders.length === 0) return;
    setPhase("ingesting");
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await ingestTrainingData(folders, setProgress, controller.signal);
      setIngestResult(res);
      setPhase("ingested");
    } catch (err) {
      setErrorText(String(err));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }, [folders]);

  const runTrain = useCallback(async () => {
    setPhase("training");
    setEpochLog([]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await trainProfile((p) => {
        setProgress(p);
        setEpochLog((prev) => [...prev.slice(-11), p.message]);
      }, controller.signal);
      setTrainResult(res);
      setPhase("trained");
    } catch (err) {
      setErrorText(String(err));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }, []);

  const total = ingestResult?.totalSamples ?? status?.trainingSamples ?? 0;
  const canTrain = total >= (ingestResult?.minSamples ?? 50);
  const recommended = ingestResult?.recommendedSamples ?? 500;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="training-dialog">
      <div className="w-[520px] bg-zinc-900 rounded-2xl p-6 shadow-2xl border border-zinc-700">
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">🧠 Personal AI Profile</h2>
        <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
          Learns YOUR editing style. It trains on two sources: the photos you edit right here in
          the app, and (optionally) folders of past shoots with Lightroom{" "}
          <span className="font-mono text-zinc-400">.xmp</span> sidecars. Minimum 50 edits to
          train; 500–5,000 recommended for real accuracy.
        </p>

        {(status?.trainingSamples ?? 0) > 0 && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-zinc-800/60 border border-zinc-700 text-xs text-zinc-300">
            {status!.trainingSamples} edit{status!.trainingSamples === 1 ? "" : "s"} collected so
            far{" "}
            {(status?.trainingSamples ?? 0) >= 50
              ? "— enough to train."
              : `— ${50 - (status?.trainingSamples ?? 0)} more to reach the 50 minimum.`}
          </div>
        )}

        {status?.available && phase === "intro" && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-violet-950/40 border border-violet-800 text-xs text-violet-200">
            A trained model exists (val loss {status.valLoss?.toFixed(4)},{" "}
            {status.samples} samples{status.usable ? ", active" : ", below quality bar — scene mode used"}).
            Training again replaces it.
          </div>
        )}

        {phase === "intro" && (
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                  Training folders
                </span>
                <button
                  onClick={addFolder}
                  className="px-2.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 hover:bg-zinc-700"
                >
                  + Add folder
                </button>
              </div>
              {folders.length === 0 ? (
                <p className="text-xs text-zinc-600 italic py-2">No folders yet.</p>
              ) : (
                <ul className="space-y-1 max-h-32 overflow-y-auto">
                  {folders.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-zinc-400 font-mono">
                      <span className="truncate flex-1">{f}</span>
                      <button
                        onClick={() => setFolders((prev) => prev.filter((x) => x !== f))}
                        className="text-zinc-600 hover:text-red-400"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {(status?.trainingSamples ?? 0) > 0 && (
              <p className="text-xs text-zinc-500">
                Library already holds {status?.trainingSamples} ingested pairs — new folders add to it.
              </p>
            )}
            <div className="flex gap-3">
              <button
                disabled={folders.length === 0}
                onClick={runIngest}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-sm font-medium text-white"
              >
                Scan folders for pairs
              </button>
              {(status?.trainingSamples ?? 0) >= 50 && (
                <button
                  onClick={runTrain}
                  className="px-4 py-2.5 bg-violet-700 hover:bg-violet-600 rounded-lg text-sm font-medium text-white"
                >
                  Train now
                </button>
              )}
              <button
                onClick={onClose}
                className="px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-400"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {(phase === "ingesting" || phase === "training") && (
          <div className="space-y-3">
            <div className="flex justify-between text-xs text-zinc-500">
              <span className="truncate">{progress?.message || "Starting..."}</span>
              {progress && progress.total > 0 && (
                <span>{Math.round((progress.current / progress.total) * 100)}%</span>
              )}
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-500 transition-all duration-200"
                style={{
                  width: `${progress && progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                }}
              />
            </div>
            {phase === "training" && epochLog.length > 0 && (
              <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 h-32 overflow-y-auto font-mono text-[10px] text-zinc-500 space-y-0.5">
                {epochLog.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            )}
            <button
              onClick={() => abortRef.current?.abort()}
              className="w-full py-2.5 bg-red-900/60 hover:bg-red-800/70 border border-red-800 rounded-lg text-sm font-medium text-red-200"
            >
              Cancel
            </button>
          </div>
        )}

        {phase === "ingested" && ingestResult && (
          <div className="space-y-4">
            <div className="text-sm text-zinc-300 space-y-1">
              <p>
                Found <span className="font-semibold text-white">{ingestResult.ingested}</span> new
                pairs · library total{" "}
                <span className="font-semibold text-white">{ingestResult.totalSamples}</span>
              </p>
              <p className="text-xs text-zinc-500">
                {total < 50
                  ? `Need at least 50 pairs to train (have ${total}).`
                  : total < recommended
                    ? `You can train now, but accuracy improves a lot with ${recommended}+ pairs.`
                    : "Great dataset size — ready to train."}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                disabled={!canTrain}
                onClick={runTrain}
                data-testid="train-button"
                className="flex-1 py-2.5 bg-violet-700 hover:bg-violet-600 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-sm font-medium text-white"
              >
                Train personal model
              </button>
              <button
                onClick={() => setPhase("intro")}
                className="px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-400"
              >
                Add more
              </button>
            </div>
          </div>
        )}

        {phase === "trained" && trainResult && (
          <div className="space-y-4">
            <div className="text-sm text-zinc-300 space-y-2">
              <p>
                {trainResult.usable ? "✅ Model trained and active." : "⚠️ Model trained but below the quality bar — scene-based editing stays active. Add more consistent training data."}
              </p>
              <p className="text-xs text-zinc-500">
                Validation loss {trainResult.valLoss} · {trainResult.samples} samples
              </p>
              {Object.keys(trainResult.valMae).length > 0 && (
                <div className="text-[11px] text-zinc-500 bg-zinc-950 border border-zinc-800 rounded-lg p-2 max-h-28 overflow-y-auto">
                  {Object.entries(trainResult.valMae)
                    .slice(0, 10)
                    .map(([f, v]) => (
                      <div key={f} className="flex justify-between">
                        <span>{f}</span>
                        <span className="font-mono">±{v}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-300"
            >
              Done
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-4">
            <p className="text-sm text-red-400">{errorText}</p>
            <button
              onClick={() => setPhase("intro")}
              className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-300"
            >
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
