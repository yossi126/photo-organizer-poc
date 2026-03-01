import { useCallback, useState } from "react";
import { scanPhotos, clearClassifications } from "../lib/sidecar";
import type { ScanProgress, ScanSummary, ScanThresholds } from "../types/photo";

export function useScan() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const startScan = useCallback(
    async (path: string, thresholds: ScanThresholds, dryRun: boolean) => {
      setScanning(true);
      setProgress(null);
      setSummary(null);
      setLogs([]);
      setError(null);

      try {
        const result = await scanPhotos(path, thresholds, dryRun, (p) => {
          setProgress(p);
          setLogs((prev) => [...prev, p.message]);
        });
        setSummary(result);
      } catch (err) {
        setError(String(err));
      } finally {
        setScanning(false);
      }
    },
    []
  );

  const clear = useCallback(async (path: string) => {
    try {
      const result = await clearClassifications(path);
      setLogs((prev) => [
        ...prev,
        `Cleared ${result.cleared} classifications.`,
      ]);
      setSummary(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  return { scanning, progress, summary, logs, error, startScan, clear };
}
