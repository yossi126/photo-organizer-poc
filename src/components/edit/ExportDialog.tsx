import { useCallback, useRef, useState } from "react";
import { exportPhotos, writeXmpSidecars } from "../../lib/sidecar";
import type { PhotoEntry, ScanProgress } from "../../types/photo";

interface ExportDialogProps {
  photos: PhotoEntry[];
  onClose: () => void;
  /** Awaited before starting — lets App flush pending debounced edit saves. */
  onBeforeExport?: () => Promise<void>;
}

type Phase = "configure" | "exporting" | "done" | "error";
type Mode = "jpeg" | "xmp";

const RESIZE_OPTIONS = [
  { label: "Original size", value: 0 },
  { label: "Long edge 4096 px", value: 4096 },
  { label: "Long edge 2048 px", value: 2048 },
];

export function ExportDialog({ photos, onClose, onBeforeExport }: ExportDialogProps) {
  const [mode, setMode] = useState<Mode>("jpeg");
  const [destDir, setDestDir] = useState("");
  const [quality, setQuality] = useState(90);
  const [resize, setResize] = useState(0);
  const [phase, setPhase] = useState<Phase>("configure");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [resultText, setResultText] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const pickFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      const dir = Array.isArray(selected) ? selected[0] : selected;
      if (dir) setDestDir(dir);
    } catch {
      const dir = prompt("Enter destination folder:");
      if (dir) setDestDir(dir);
    }
  }, []);

  const startExport = useCallback(async () => {
    if (photos.length === 0) return;
    if (mode === "jpeg" && !destDir) return;
    setPhase("exporting");
    setProgress(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await onBeforeExport?.();
      if (mode === "jpeg") {
        const result = await exportPhotos(
          photos.map((p) => p.id),
          { destDir, quality, maxPx: resize || null },
          (p) => setProgress(p),
          controller.signal
        );
        const errCount = result.errors.length;
        setResultText(
          `Exported ${result.exported.length} photo${result.exported.length === 1 ? "" : "s"}` +
            (errCount ? ` — ${errCount} failed` : "")
        );
      } else {
        const result = await writeXmpSidecars(
          photos.map((p) => p.id),
          (p) => setProgress(p),
          controller.signal
        );
        const errCount = result.errors.length;
        setResultText(
          `Wrote ${result.written.length} XMP sidecar${result.written.length === 1 ? "" : "s"} ` +
            `next to the photos — open them in Lightroom to see the edits` +
            (errCount ? ` (${errCount} failed)` : "")
        );
      }
      setPhase("done");
    } catch (err) {
      if (String(err).includes("cancelled")) {
        setResultText("Export cancelled.");
        setPhase("done");
      } else {
        setResultText(String(err));
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
    }
  }, [mode, destDir, quality, resize, photos, onBeforeExport]);

  const cancelExport = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[440px] bg-zinc-900 rounded-2xl p-6 shadow-2xl border border-zinc-700">
        <h2 className="text-lg font-semibold text-zinc-100 mb-1">Export</h2>
        <p className="text-xs text-zinc-500 mb-5">
          {photos.length} photo{photos.length === 1 ? "" : "s"} · with current edits
        </p>

        {phase === "configure" && (
          <div className="space-y-4">
            {/* Mode toggle */}
            <div className="flex rounded-lg overflow-hidden border border-zinc-700">
              <button
                onClick={() => setMode("jpeg")}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${
                  mode === "jpeg" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                JPEG files
              </button>
              <button
                onClick={() => setMode("xmp")}
                className={`flex-1 py-2 text-sm font-medium transition-colors ${
                  mode === "xmp" ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                XMP for Lightroom
              </button>
            </div>

            {mode === "jpeg" ? (
              <>
                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    Destination
                  </label>
                  <div className="flex gap-2 mt-1.5">
                    <input
                      type="text"
                      value={destDir}
                      onChange={(e) => setDestDir(e.target.value)}
                      placeholder="Select a folder..."
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={pickFolder}
                      className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-300 hover:bg-zinc-700"
                    >
                      Browse
                    </button>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="font-medium text-zinc-400 uppercase tracking-wider">Quality</span>
                    <span className="text-zinc-500 font-mono">{quality}</span>
                  </div>
                  <input
                    type="range"
                    min={60}
                    max={100}
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                    className="w-full h-1.5 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-blue-500"
                  />
                </div>

                <div>
                  <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
                    Size
                  </label>
                  <select
                    value={resize}
                    onChange={(e) => setResize(Number(e.target.value))}
                    className="w-full mt-1.5 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
                  >
                    {RESIZE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <p className="text-xs text-zinc-500 leading-relaxed">
                Writes a <span className="font-mono text-zinc-400">.xmp</span> sidecar file next to
                each photo with the develop settings. Lightroom / Camera Raw will read these
                automatically when you import or "Read Metadata from File". Existing sidecars are
                merged — other metadata is preserved.
              </p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                disabled={mode === "jpeg" && !destDir}
                onClick={startExport}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-sm font-medium text-white"
              >
                {mode === "jpeg" ? "Export JPEGs" : "Write XMP sidecars"}
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

        {phase === "exporting" && (
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
              onClick={cancelExport}
              className="w-full py-2.5 bg-red-900/60 hover:bg-red-800/70 border border-red-800 rounded-lg text-sm font-medium text-red-200"
            >
              Cancel Export
            </button>
          </div>
        )}

        {(phase === "done" || phase === "error") && (
          <div className="space-y-4">
            <p className={`text-sm ${phase === "error" ? "text-red-400" : "text-zinc-300"}`}>
              {resultText}
            </p>
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
