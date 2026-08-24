import { useCallback, useRef, useState } from "react";
import { scanPhotos, clearClassifications } from "../lib/sidecar";
import type { ScanProgress, ScanSummary, ScanThresholds } from "../types/photo";

export function useScan() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startScan = useCallback(
    async (projectId: number, thresholds: ScanThresholds, dryRun: boolean) => {
      setScanning(true);
      setProgress(null);
      setSummary(null);
      setLogs([]);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const result = await scanPhotos(
          projectId,
          thresholds,
          dryRun,
          (p) => {
            setProgress(p);
            setLogs((prev) => [...prev, p.message]);
          },
          controller.signal
        );
        setSummary(result);
      } catch (err) {
        if (String(err).includes("cancelled")) {
          setLogs((prev) => [...prev, "Scan cancelled."]);
        } else {
          setError(String(err));
        }
      } finally {
        abortRef.current = null;
        setScanning(false);
      }
    },
    []
  );

  const cancelScan = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(async (projectId: number) => {
    try {
      const result = await clearClassifications(projectId);
      setLogs((prev) => [
        ...prev,
        `Cleared ${result.cleared} classifications.`,
      ]);
      setSummary(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  return { scanning, progress, summary, logs, error, startScan, cancelScan, clear };
}
