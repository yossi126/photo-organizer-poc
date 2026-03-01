import { useCallback, useRef, useState } from "react";
import { getThumbnail } from "../lib/sidecar";

export function useThumbnails() {
  const cache = useRef<Map<string, string>>(new Map());
  const pending = useRef<Set<string>>(new Set());
  const [, forceUpdate] = useState(0);

  const get = useCallback((path: string): string | null => {
    if (cache.current.has(path)) return cache.current.get(path)!;

    if (!pending.current.has(path)) {
      pending.current.add(path);
      getThumbnail(path, 150)
        .then((dataUrl) => {
          cache.current.set(path, dataUrl);
          pending.current.delete(path);
          forceUpdate((n) => n + 1);
        })
        .catch(() => {
          pending.current.delete(path);
        });
    }

    return null;
  }, []);

  const getLarge = useCallback(
    (path: string): Promise<string> => {
      const key = `large:${path}`;
      if (cache.current.has(key))
        return Promise.resolve(cache.current.get(key)!);

      return getThumbnail(path, 1200).then((dataUrl) => {
        cache.current.set(key, dataUrl);
        return dataUrl;
      });
    },
    []
  );

  return { get, getLarge };
}
