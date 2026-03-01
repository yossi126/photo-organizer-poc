import { useEffect, useRef, useState } from "react";
import { startSidecar } from "../lib/sidecar";

export function useSidecar() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startSidecar()
      .then(() => setReady(true))
      .catch((err) => setError(String(err)));
  }, []);

  return { ready, error };
}
