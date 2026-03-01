import { useState, useRef, useEffect } from "react";
import { DEFAULT_THRESHOLDS } from "../../lib/constants";
import type { ScanProgress, ScanThresholds } from "../../types/photo";

interface ImportTabProps {
  folder: string;
  scanning: boolean;
  progress: ScanProgress | null;
  logs: string[];
  onStartScan: (thresholds: ScanThresholds, dryRun: boolean) => void;
  onClear: () => void;
}

export function ImportTab({
  folder,
  scanning,
  progress,
  logs,
  onStartScan,
  onClear,
}: ImportTabProps) {
  const [thresholds, setThresholds] = useState<ScanThresholds>({
    ...DEFAULT_THRESHOLDS,
  });
  const [dryRun, setDryRun] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Scan Settings</h2>
          <p className="text-sm text-zinc-500 mt-1">
            Adjust detection thresholds for{" "}
            <span className="text-zinc-400 font-mono text-xs">{folder}</span>
          </p>
        </div>

        <div className="space-y-4 bg-zinc-900 rounded-xl p-5 border border-zinc-800">
          <SliderField
            label="Blur sensitivity"
            value={thresholds.blur}
            min={10}
            max={200}
            onChange={(v) => setThresholds((t) => ({ ...t, blur: v }))}
          />
          <SliderField
            label="Dark threshold"
            value={thresholds.dark}
            min={30}
            max={150}
            onChange={(v) => setThresholds((t) => ({ ...t, dark: v }))}
          />
          <SliderField
            label="Duplicate tolerance"
            value={thresholds.duplicates}
            min={1}
            max={15}
            onChange={(v) => setThresholds((t) => ({ ...t, duplicates: v }))}
          />
          <SliderField
            label="Overexposed threshold"
            value={thresholds.overexposed}
            min={180}
            max={250}
            onChange={(v) => setThresholds((t) => ({ ...t, overexposed: v }))}
          />

          <label className="flex items-center gap-2 pt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              className="w-4 h-4 rounded bg-zinc-800 border-zinc-600 text-blue-500 focus:ring-blue-500"
            />
            <span className="text-sm text-zinc-400">
              Dry run (preview only, no changes saved)
            </span>
          </label>
        </div>

        <div className="flex gap-3">
          <button
            disabled={scanning}
            onClick={() => onStartScan(thresholds, dryRun)}
            className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-sm font-medium text-white transition-colors"
          >
            {scanning ? "Scanning..." : "Start Scan"}
          </button>
          <button
            disabled={scanning}
            onClick={onClear}
            className="px-4 py-3 bg-zinc-800 hover:bg-zinc-700 disabled:text-zinc-600 border border-zinc-700 rounded-lg text-sm text-zinc-400 transition-colors"
          >
            Clear Classifications
          </button>
        </div>

        {(scanning || progress) && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-zinc-500">
              <span>{progress?.message || "Starting..."}</span>
              <span>{pct}%</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {logs.length > 0 && (
          <div
            ref={logRef}
            className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 h-48 overflow-y-auto font-mono text-xs text-zinc-500 space-y-0.5"
          >
            {logs.map((log, i) => (
              <div key={i}>{log}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-zinc-400">{label}</span>
        <span className="text-zinc-500 font-mono">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-blue-500"
      />
    </div>
  );
}
