import { useCallback, useRef, useState } from "react";
import type { EditSettings } from "../types/photo";

const HISTORY_CAP = 50;

interface HistoryStack {
  stack: EditSettings[];
  index: number; // points at the current state within stack
}

/**
 * Per-photo undo/redo history (keyed by photo path).
 *
 * `record` is called with the *settled* settings (same debounce as
 * persistence) so one slider drag = one history entry. Applying an
 * undo/redo returns the settings — the caller writes them through the
 * normal change path with recording suppressed.
 */
export function useEditHistory() {
  const stacks = useRef<Map<string, HistoryStack>>(new Map());
  // bumped so canUndo/canRedo consumers re-render after mutations
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const seed = useCallback((path: string, settings: EditSettings) => {
    if (!stacks.current.has(path)) {
      stacks.current.set(path, { stack: [settings], index: 0 });
    }
  }, []);

  const record = useCallback((path: string, settings: EditSettings) => {
    const h = stacks.current.get(path);
    if (!h) {
      stacks.current.set(path, { stack: [settings], index: 0 });
      bump();
      return;
    }
    // Drop redo tail, append, cap
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(settings);
    if (h.stack.length > HISTORY_CAP) h.stack.shift();
    h.index = h.stack.length - 1;
    bump();
  }, []);

  const undo = useCallback((path: string): EditSettings | null => {
    const h = stacks.current.get(path);
    if (!h || h.index <= 0) return null;
    h.index -= 1;
    bump();
    return h.stack[h.index];
  }, []);

  const redo = useCallback((path: string): EditSettings | null => {
    const h = stacks.current.get(path);
    if (!h || h.index >= h.stack.length - 1) return null;
    h.index += 1;
    bump();
    return h.stack[h.index];
  }, []);

  const canUndo = useCallback((path: string): boolean => {
    const h = stacks.current.get(path);
    return !!h && h.index > 0;
  }, []);

  const canRedo = useCallback((path: string): boolean => {
    const h = stacks.current.get(path);
    return !!h && h.index < h.stack.length - 1;
  }, []);

  const clear = useCallback(() => {
    stacks.current.clear();
    bump();
  }, []);

  return { seed, record, undo, redo, canUndo, canRedo, clear };
}
