import type {
  ScanProgress,
  ScanSummary,
  ScanThresholds,
  PhotoEntry,
} from "../types/photo";

type MessageHandler = (msg: SidecarMessage) => void;

interface SidecarMessage {
  id: number;
  event?: string;
  data?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

// Detect if we're running inside Tauri or in a regular browser
function isTauri(): boolean {
  return !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

// --- Sidecar process state ---
let sidecarProcess: { write: (data: string) => Promise<void> } | null = null;
let nextId = 1;
const pendingHandlers = new Map<number, MessageHandler>();
let lineBuffer = "";

function handleLine(line: string) {
  // Strip \r from Windows line endings
  line = line.replace(/\r$/, "");
  if (!line.trim()) return;
  try {
    const msg: SidecarMessage = JSON.parse(line);
    // Log non-progress messages (progress events are too noisy)
    if (!msg.event) {
      console.log("Sidecar response:", msg.id, msg.result ? "OK" : msg.error || "?");
    }
    const handler = pendingHandlers.get(msg.id);
    if (handler) {
      handler(msg);
      if (msg.result !== undefined || msg.error !== undefined) {
        pendingHandlers.delete(msg.id);
      }
    } else {
      console.warn("No handler for sidecar message id:", msg.id);
    }
  } catch {
    console.error("Sidecar parse error:", line);
  }
}

export async function startSidecar(): Promise<void> {
  if (sidecarProcess) return;

  if (!isTauri()) {
    // Running in a regular browser (e.g., Playwright testing)
    // Mark as ready — functions will use mock data
    console.log("Not running in Tauri — using browser mock mode");
    sidecarProcess = { write: async () => {} };
    return;
  }

  // Dynamic imports so they don't crash in browser context
  const { Command } = await import("@tauri-apps/plugin-shell");
  const { invoke } = await import("@tauri-apps/api/core");

  // Get sidecar config from Rust: backend_dir, python path, script name.
  const config: Record<string, string> = await invoke("get_sidecar_config");
  console.log("Sidecar config:", config);

  // Build env with the venv's Python directory prepended to PATH,
  // so "python" (from the shell scope) resolves to the venv's Python.
  const env: Record<string, string> = {};
  if (config.python) {
    // Extract the directory containing the venv python executable
    const pythonDir = config.python.replace(/[/\\][^/\\]+$/, "");
    env.PATH = pythonDir + ";" + (config.system_path || "");
    console.log("Using venv Python at:", config.python);
  }

  const command = Command.create("python-sidecar", [config.script || "sidecar.py"], {
    cwd: config.backend_dir,
    env,
  });

  command.stdout.on("data", (data: string) => {
    // Log raw stdout chunks (truncated) for debugging
    if (!data.includes('"event"')) {
      console.log("Sidecar stdout chunk:", data.length, "bytes, starts:", data.substring(0, 100));
    }
    lineBuffer += data;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";
    if (lineBuffer.length > 0) {
      console.log("Sidecar lineBuffer pending:", lineBuffer.length, "bytes");
    }
    for (const line of lines) {
      handleLine(line);
    }
  });

  command.stderr.on("data", (data: string) => {
    console.error("Sidecar stderr:", data);
  });

  command.on("error", (err: string) => {
    console.error("Sidecar error:", err);
    sidecarProcess = null;
  });

  command.on("close", (data) => {
    console.warn("Sidecar closed:", data);
    sidecarProcess = null;
  });

  try {
    const spawned = await command.spawn();
    console.log("Sidecar spawned successfully, pid:", spawned.pid);
    sidecarProcess = { write: (data: string) => spawned.write(data) };
  } catch (err) {
    console.error("Failed to spawn sidecar:", err);
    throw err;
  }
}

function sendRequest(
  method: string,
  params: Record<string, unknown>,
  onMessage: MessageHandler
): number {
  const id = nextId++;

  if (!isTauri()) {
    // Browser mock mode — return mock data
    setTimeout(() => handleMockRequest(id, method, params, onMessage), 50);
    return id;
  }

  pendingHandlers.set(id, onMessage);
  const msg = JSON.stringify({ id, method, params }) + "\n";
  console.log("Sending to sidecar:", method, "id:", id);
  sidecarProcess?.write(msg).then(() => {
    console.log("Write completed for:", method, "id:", id);
  }).catch((err) => {
    console.error("Failed to write to sidecar:", err);
    pendingHandlers.delete(id);
    onMessage({ id, error: `Write failed: ${err}` });
  });
  return id;
}

// --- Mock data for browser/Playwright testing ---
function handleMockRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
  onMessage: MessageHandler
) {
  switch (method) {
    case "list_photos":
      onMessage({
        id,
        result: {
          entries: generateMockEntries(24),
        },
      });
      break;
    case "scan":
      // Simulate progress
      for (let i = 1; i <= 10; i++) {
        const step = i;
        setTimeout(() => {
          onMessage({
            id,
            event: "progress",
            data: {
              current: step,
              total: 10,
              message: `Checking: photo_${String(step).padStart(3, "0")}.jpg`,
            },
          });
          if (step === 10) {
            onMessage({
              id,
              result: {
                _duplicates: 2,
                _dark: 3,
                _overexposed: 1,
                _blurry: 4,
                _eyes_closed: 2,
                clean: 12,
              },
            });
          }
        }, step * 200);
      }
      break;
    case "thumbnail":
      onMessage({
        id,
        result: { data: generatePlaceholderThumb(params.size as number || 150) },
      });
      break;
    case "set_rating":
      onMessage({ id, result: { ok: true } });
      break;
    case "reclassify":
      onMessage({ id, result: { ok: true } });
      break;
    case "clear":
      onMessage({ id, result: { cleared: 5, errors: [] } });
      break;
    default:
      onMessage({ id, error: `Unknown method: ${method}` });
  }
}

const MOCK_CATEGORIES = ["clean", "_blurry", "_dark", "_overexposed", "_eyes_closed", "_duplicates"];

function generateMockEntries(count: number): PhotoEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const catIndex = i < 12 ? 0 : (i % (MOCK_CATEGORIES.length - 1)) + 1;
    return {
      filename: `photo_${String(i + 1).padStart(3, "0")}.jpg`,
      path: `C:/mock-photos/photo_${String(i + 1).padStart(3, "0")}.jpg`,
      category: MOCK_CATEGORIES[catIndex] as PhotoEntry["category"],
      allLabels: catIndex > 0 ? [MOCK_CATEGORIES[catIndex]] : [],
      scores: {
        brightness: 80 + Math.random() * 100,
        blur: 20 + Math.random() * 80,
        ear: Math.random() * 0.4,
      },
      starRating: Math.floor(Math.random() * 6),
    };
  });
}

function generatePlaceholderThumb(_size: number): string {
  // 1x1 gray JPEG as minimal placeholder
  return "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=";
}

// --- Public API ---

export function scanPhotos(
  path: string,
  thresholds: ScanThresholds,
  dryRun: boolean,
  onProgress: (p: ScanProgress) => void
): Promise<ScanSummary> {
  return new Promise((resolve, reject) => {
    sendRequest(
      "scan",
      { path, thresholds, dry_run: dryRun },
      (msg) => {
        if (msg.event === "progress" && msg.data) {
          onProgress(msg.data as unknown as ScanProgress);
        } else if (msg.result) {
          resolve(msg.result as ScanSummary);
        } else if (msg.error) {
          reject(new Error(msg.error));
        }
      }
    );
  });
}

export function listPhotos(path: string): Promise<PhotoEntry[]> {
  return new Promise((resolve, reject) => {
    sendRequest("list_photos", { path }, (msg) => {
      if (msg.result) {
        const data = msg.result as { entries: PhotoEntry[] };
        resolve(data.entries);
      } else if (msg.error) {
        reject(new Error(msg.error));
      }
    });
  });
}

export function getThumbnail(
  path: string,
  size = 150
): Promise<string> {
  return new Promise((resolve, reject) => {
    sendRequest("thumbnail", { path, size }, (msg) => {
      if (msg.result) {
        const data = msg.result as { data: string };
        resolve(`data:image/jpeg;base64,${data.data}`);
      } else if (msg.error) {
        reject(new Error(msg.error));
      }
    });
  });
}

export function setRating(
  folder: string,
  filename: string,
  stars: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("set_rating", { folder, filename, stars }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function reclassify(
  folder: string,
  filename: string,
  category: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("reclassify", { folder, filename, category }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function clearClassifications(path: string): Promise<{
  cleared: number;
  errors: string[];
}> {
  return new Promise((resolve, reject) => {
    sendRequest("clear", { path }, (msg) => {
      if (msg.result) {
        resolve(msg.result as { cleared: number; errors: string[] });
      } else if (msg.error) {
        reject(new Error(msg.error));
      }
    });
  });
}
