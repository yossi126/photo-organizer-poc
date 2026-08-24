import { useCallback, useRef, useState } from "react";
import { getThumbnailsBatch, getPreviewImage } from "../lib/sidecar";

// Formats WebView2 cannot decode natively — served as JPEG previews by the sidecar
const SIDECAR_PREVIEW_EXTS = new Set([
  "cr2", "cr3", "nef", "nrw", "arw", "srf", "orf", "raf", "rw2", "pef", "dng", "raw",
  "tif", "tiff", "heic", "heif",
]);

// Placeholder for failed/loading images
const PLACEHOLDER = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8VAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=";

export function useThumbnails() {
  const cache = useRef<Map<string, string>>(new Map());
  const queued = useRef<Set<string>>(new Set()); // paths waiting to be fetched
  const inFlight = useRef<Set<string>>(new Set()); // paths currently in active batch
  const fetching = useRef(false); // is a batch currently being processed?
  const [cacheVersion, setCacheVersion] = useState(0);

  const BATCH_SIZE = 20;

  const processQueue = useCallback(async () => {
    // Exit if already processing
    if (fetching.current) return;
    fetching.current = true;
    console.log(`[Thumbnails] Starting processQueue with ${queued.current.size} items in queue`);

    // Keep processing batches until queue is empty
    while (queued.current.size > 0) {
      // Take up to BATCH_SIZE paths from queue
      const batch = Array.from(queued.current).slice(0, BATCH_SIZE);
      console.log(`[Thumbnails] Processing batch of ${batch.length} images`);

      // Move from queued to inFlight
      batch.forEach((p) => {
        queued.current.delete(p);
        inFlight.current.add(p);
      });

      try {
        // Fetch batch
        console.log(`[Thumbnails] Fetching batch: ${batch.slice(0, 3).join(", ")}...`);
        const results = await getThumbnailsBatch(batch, 300);
        console.log(`[Thumbnails] Batch received, caching ${Object.keys(results).length} results`);

        // Cache results and remove from inFlight
        for (const path of batch) {
          cache.current.set(path, results[path] || PLACEHOLDER);
          inFlight.current.delete(path);
        }
      } catch (error) {
        // On error, cache placeholder and remove from inFlight
        console.error(`[Thumbnails] Batch failed:`, error);
        for (const path of batch) {
          cache.current.set(path, PLACEHOLDER);
          inFlight.current.delete(path);
        }
      }

      console.log(`[Thumbnails] Cache size: ${cache.current.size}, Queued: ${queued.current.size}`);
      // Trigger re-render for this batch
      setCacheVersion((n) => n + 1);
    }

    // Done processing
    fetching.current = false;
  }, []);

  const get = useCallback(
    (path: string): string | null => {
      // Return cached result if available
      if (cache.current.has(path)) {
        return cache.current.get(path)!;
      }

      // Don't re-request if already queued or in-flight
      if (queued.current.has(path) || inFlight.current.has(path)) {
        return null;
      }

      // Add to queue and start processing
      queued.current.add(path);
      processQueue(); // No-op if already running; new items picked up by while loop

      return null;
    },
    [processQueue]
  );

  const getLarge = useCallback(
    (path: string): Promise<string> => {
      const key = `large:${path}`;
      if (cache.current.has(key)) {
        return Promise.resolve(cache.current.get(key)!);
      }

      return getThumbnailsBatch([path], 1200)
        .then((results) => {
          const dataUrl = results[path] || PLACEHOLDER;
          cache.current.set(key, dataUrl);
          return dataUrl;
        })
        .catch(() => {
          cache.current.set(key, PLACEHOLDER);
          return PLACEHOLDER;
        });
    },
    []
  );

  // Load original full-resolution image from disk via Tauri FS
  const getFullResolution = useCallback(
    async (path: string): Promise<string> => {
      const key = `full:${path}`;
      if (cache.current.has(key)) {
        return cache.current.get(key)!;
      }

      // RAW/TIFF: the browser can't decode these — use the sidecar's
      // high-quality preview base (same rawpy params as export)
      const extension = path.split(".").pop()?.toLowerCase() || "";
      if (SIDECAR_PREVIEW_EXTS.has(extension)) {
        try {
          const dataUrl = await getPreviewImage(path);
          cache.current.set(key, dataUrl);
          return dataUrl;
        } catch (err) {
          console.error("[Thumbnails] Failed to load sidecar preview:", err);
          return getLarge(path);
        }
      }

      // Browser/mock mode has no filesystem access — use the large thumbnail
      if (!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__) {
        return getLarge(path);
      }

      try {
        // Dynamic import so it doesn't crash in browser context
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(path);

        // Detect mime type from extension
        const ext = path.split(".").pop()?.toLowerCase() || "jpg";
        const mimeMap: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
          gif: "image/gif",
          bmp: "image/bmp",
          tiff: "image/tiff",
          tif: "image/tiff",
        };
        const mime = mimeMap[ext] || "image/jpeg";

        const blob = new Blob([bytes], { type: mime });
        const url = URL.createObjectURL(blob);
        cache.current.set(key, url);
        return url;
      } catch (err) {
        console.error("[Thumbnails] Failed to load full-res image:", err);
        // Fallback to large thumbnail
        return getLarge(path);
      }
    },
    [getLarge]
  );

  const getQueuedCount = useCallback(() => {
    return queued.current.size + inFlight.current.size;
  }, []);

  return { get, getLarge, getFullResolution, cacheVersion, getQueuedCount };
}
