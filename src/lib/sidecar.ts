import type {
  ScanProgress,
  ScanSummary,
  ScanThresholds,
  PhotoEntry,
  Project,
  EditSettings,
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
  onMessage: MessageHandler,
  signal?: AbortSignal
): number {
  const id = nextId++;

  if (!isTauri()) {
    // Browser mock mode — return mock data. Requests are serialized through
    // a queue: each handler does a load-modify-save of the whole mock store,
    // so parallel handlers would clobber each other's writes.
    if (signal) {
      signal.addEventListener("abort", () => {
        onMessage({ id, error: "cancelled" });
      }, { once: true });
    }
    mockQueue = mockQueue.then(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            handleMockRequest(id, method, params, onMessage);
            resolve();
          }, 10);
        })
    );
    return id;
  }

  pendingHandlers.set(id, onMessage);

  if (signal) {
    signal.addEventListener("abort", () => {
      if (!pendingHandlers.has(id)) return; // already resolved
      // Fire-and-forget cancellation; the job replies with {error: "cancelled"}
      const cancelId = nextId++;
      const cancelMsg = JSON.stringify({
        id: cancelId,
        method: "cancel_job",
        params: { job_id: id },
      }) + "\n";
      pendingHandlers.set(cancelId, () => {});
      sidecarProcess?.write(cancelMsg).catch((err) => {
        console.error("Failed to send cancel_job:", err);
      });
    }, { once: true });
  }

  const msg = JSON.stringify({ id, method, params }) + "\n";
  console.log("Sending to sidecar:", method, "id:", id);
  sidecarProcess?.write(msg).catch((err) => {
    console.error("Failed to write to sidecar:", err);
    pendingHandlers.delete(id);
    onMessage({ id, error: `Write failed: ${err}` });
  });
  return id;
}

// --- Mock catalog for browser/Playwright testing ---
// Persisted to localStorage so project resume is testable in the browser.

interface MockCatalog {
  nextProjectId: number;
  nextPhotoId: number;
  nextPresetId?: number;
  projects: Project[];
  photos: Record<number, PhotoEntry[]>; // project id -> entries
  editSettings: Record<number, EditSettings>; // photo id -> settings
  presets?: { id: number; name: string; settings: Partial<EditSettings> }[];
}

const MOCK_STORE_KEY = "photo-organizer-mock-catalog";

// Serializes mock request handling (see sendRequest)
let mockQueue: Promise<void> = Promise.resolve();

function loadMockCatalog(): MockCatalog {
  try {
    const raw = localStorage.getItem(MOCK_STORE_KEY);
    if (raw) return JSON.parse(raw) as MockCatalog;
  } catch {
    // corrupted store — start fresh
  }
  return { nextProjectId: 1, nextPhotoId: 1, projects: [], photos: {}, editSettings: {} };
}

function saveMockCatalog(cat: MockCatalog) {
  localStorage.setItem(MOCK_STORE_KEY, JSON.stringify(cat));
}

function mockEditSettingsForProject(cat: MockCatalog, projectId: number): Record<string, EditSettings> {
  const out: Record<string, EditSettings> = {};
  for (const entry of cat.photos[projectId] ?? []) {
    const settings = cat.editSettings[entry.id];
    if (settings) out[entry.path] = settings;
  }
  return out;
}

function handleMockRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
  onMessage: MessageHandler
) {
  const cat = loadMockCatalog();
  const projectId = params.project_id as number;

  switch (method) {
    case "create_project": {
      const folder = params.folder as string;
      let project = cat.projects.find((p) => p.folder === folder);
      if (!project) {
        project = {
          id: cat.nextProjectId++,
          name: (params.name as string) || folder.split(/[\\/]/).pop() || folder,
          folder,
          createdAt: Date.now() / 1000,
          lastOpenedAt: Date.now() / 1000,
        };
        cat.projects.push(project);
        cat.photos[project.id] = [];
      } else {
        project.lastOpenedAt = Date.now() / 1000;
      }
      saveMockCatalog(cat);
      onMessage({ id, result: { project } });
      break;
    }
    case "list_projects":
      onMessage({
        id,
        result: {
          projects: [...cat.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
        },
      });
      break;
    case "open_project": {
      const project = cat.projects.find((p) => p.id === projectId);
      if (!project) {
        onMessage({ id, error: `Unknown project: ${projectId}` });
        break;
      }
      project.lastOpenedAt = Date.now() / 1000;
      saveMockCatalog(cat);
      onMessage({
        id,
        result: {
          project,
          entries: cat.photos[projectId] ?? [],
          editSettings: mockEditSettingsForProject(cat, projectId),
        },
      });
      break;
    }
    case "delete_project": {
      const photos = cat.photos[projectId] ?? [];
      for (const p of photos) delete cat.editSettings[p.id];
      delete cat.photos[projectId];
      cat.projects = cat.projects.filter((p) => p.id !== projectId);
      saveMockCatalog(cat);
      onMessage({ id, result: { ok: true } });
      break;
    }
    case "list_photos":
      onMessage({ id, result: { entries: cat.photos[projectId] ?? [] } });
      break;
    case "scan": {
      // Simulate progress, then populate the project with mock photos
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
            const fresh = loadMockCatalog();
            if ((fresh.photos[projectId] ?? []).length === 0) {
              fresh.photos[projectId] = generateMockEntries(fresh, 24);
              saveMockCatalog(fresh);
            }
            onMessage({
              id,
              result: {
                _duplicates: 2,
                _dark: 3,
                _overexposed: 1,
                _blurry: 4,
                _eyes_closed: 2,
                clean: 12,
                skipped: 0,
              },
            });
          }
        }, step * 200);
      }
      break;
    }
    case "set_edit_settings": {
      cat.editSettings[params.photo_id as number] = params.settings as EditSettings;
      saveMockCatalog(cat);
      onMessage({ id, result: { ok: true } });
      break;
    }
    case "set_rating": {
      const entries = cat.photos[projectId] ?? [];
      const entry = entries.find((e) => e.filename === params.filename);
      if (entry) entry.starRating = params.stars as number;
      saveMockCatalog(cat);
      onMessage({ id, result: { ok: true } });
      break;
    }
    case "reclassify": {
      const entries = cat.photos[projectId] ?? [];
      const entry = entries.find((e) => e.filename === params.filename);
      if (entry) entry.category = params.category as PhotoEntry["category"];
      saveMockCatalog(cat);
      onMessage({ id, result: { ok: true } });
      break;
    }
    case "set_flag": {
      const entries = cat.photos[projectId] ?? [];
      const entry = entries.find((e) => e.filename === params.filename);
      if (entry) entry.flag = (params.flag ?? null) as PhotoEntry["flag"];
      saveMockCatalog(cat);
      onMessage({ id, result: { ok: true } });
      break;
    }
    case "get_faces":
      onMessage({ id, result: { faces: [] } });
      break;
    case "auto_edit": {
      const ids = (params.photo_ids as number[]) || [];
      let edited = 0;
      let skipped = 0;
      const scenes: Record<string, number> = { outdoor: 0, indoor: 0, portrait: 0 };
      ids.forEach((pid, idx) => {
        setTimeout(() => {
          onMessage({
            id,
            event: "progress",
            data: { current: idx + 1, total: ids.length, message: `Auto-editing photo ${pid}` },
          });
          if (idx === ids.length - 1) {
            const fresh = loadMockCatalog();
            for (const p of ids) {
              if (params.skip_edited && fresh.editSettings[p]) {
                skipped++;
                continue;
              }
              fresh.editSettings[p] = {
                exposure: 0.5,
                contrast: 10,
                vibrance: 15,
                aiEdited: true,
                aiScene: "outdoor",
              } as unknown as EditSettings;
              scenes.outdoor++;
              edited++;
            }
            saveMockCatalog(fresh);
            onMessage({ id, result: { edited, skipped, scenes } });
          }
        }, (idx + 1) * 40);
      });
      if (ids.length === 0) onMessage({ id, result: { edited: 0, skipped: 0, scenes } });
      break;
    }
    case "ingest_training_data": {
      for (let i = 1; i <= 5; i++) {
        setTimeout(() => {
          onMessage({
            id,
            event: "progress",
            data: { current: i, total: 5, message: `Ingesting: IMG_${i}.jpg` },
          });
          if (i === 5) {
            onMessage({
              id,
              result: {
                pairsFound: 5, ingested: 5, errors: 0, totalSamples: 620,
                coverage: { exposure: 620, contrast: 610, temperature: 590 },
                minSamples: 50, recommendedSamples: 500,
              },
            });
          }
        }, i * 60);
      }
      break;
    }
    case "train_profile": {
      for (let i = 1; i <= 6; i++) {
        setTimeout(() => {
          onMessage({
            id,
            event: "progress",
            data: { current: i, total: 6, message: `Epoch ${i}: train 0.0${9 - i}, val 0.0${8 - i}` },
          });
          if (i === 6) {
            onMessage({
              id,
              result: {
                valLoss: 0.021, samples: 620,
                valMae: { exposure: 0.28, temperature: 310, contrast: 8.4 },
                usable: true, modelPath: "mock/head.onnx",
              },
            });
          }
        }, i * 80);
      }
      break;
    }
    case "personal_model_status":
      onMessage({
        id,
        result: { available: false, samples: 0 },
      });
      break;
    case "clear_training_data":
      onMessage({ id, result: { ok: true } });
      break;
    case "get_ai_profile":
      onMessage({
        id,
        result: {
          profile: {
            id: 1,
            name: "Default",
            config: { scenePresets: {}, normalizeExposure: true, skipEdited: true },
          },
        },
      });
      break;
    case "save_ai_profile":
      onMessage({ id, result: { ok: true } });
      break;
    case "delete_edit_settings": {
      delete cat.editSettings[params.photo_id as number];
      saveMockCatalog(cat);
      onMessage({ id, result: { ok: true } });
      break;
    }
    case "thumbnail":
      onMessage({
        id,
        result: { data: generatePlaceholderThumb(params.size as number || 150) },
      });
      break;
    case "preview_image":
      onMessage({
        id,
        result: { data: generatePlaceholderThumb((params.max_px as number) || 2560) },
      });
      break;
    case "export": {
      const ids = (params.photo_ids as number[]) || [];
      ids.forEach((_, idx) => {
        setTimeout(() => {
          onMessage({
            id,
            event: "progress",
            data: { current: idx + 1, total: ids.length, message: `Exporting photo ${idx + 1}` },
          });
          if (idx === ids.length - 1) {
            onMessage({
              id,
              result: {
                exported: ids.map((pid) => `${params.dest_dir}/photo_${pid}_edited.jpg`),
                errors: [],
              },
            });
          }
        }, (idx + 1) * 100);
      });
      if (ids.length === 0) {
        onMessage({ id, result: { exported: [], errors: [] } });
      }
      break;
    }
    case "thumbnails_batch":
      {
        const paths = (params.paths as string[]) || [];
        const size = (params.size as number) || 300;
        const thumbnails: Record<string, string> = {};
        for (const p of paths) {
          thumbnails[p] = generatePlaceholderThumb(size);
        }
        onMessage({
          id,
          result: { thumbnails },
        });
      }
      break;
    case "clear": {
      const entries = cat.photos[projectId] ?? [];
      for (const e of entries) {
        e.category = "clean";
        e.allLabels = [];
      }
      saveMockCatalog(cat);
      onMessage({ id, result: { cleared: entries.length, errors: [] } });
      break;
    }
    case "list_presets":
      onMessage({ id, result: { presets: cat.presets ?? [] } });
      break;
    case "save_preset": {
      cat.presets = cat.presets ?? [];
      cat.nextPresetId = cat.nextPresetId ?? 1;
      const preset = {
        id: cat.nextPresetId++,
        name: params.name as string,
        settings: params.settings as Partial<EditSettings>,
      };
      cat.presets.push(preset);
      saveMockCatalog(cat);
      onMessage({ id, result: { preset } });
      break;
    }
    case "delete_preset": {
      cat.presets = (cat.presets ?? []).filter((p) => p.id !== params.preset_id);
      saveMockCatalog(cat);
      onMessage({ id, result: { ok: true } });
      break;
    }
    case "import_preset": {
      cat.presets = cat.presets ?? [];
      cat.nextPresetId = cat.nextPresetId ?? 1;
      const path = (params.path as string) || "imported.xmp";
      const base = path.split(/[\\/]/).pop() || "Imported";
      const preset = {
        id: cat.nextPresetId++,
        name: base.replace(/\.xmp$/i, ""),
        settings: { exposure: 0.4, contrast: 12, vibrance: 18, temperature: 6300 },
      };
      cat.presets.push(preset);
      saveMockCatalog(cat);
      onMessage({ id, result: { preset, warnings: [] } });
      break;
    }
    case "write_xmp_sidecars": {
      const ids = (params.photo_ids as number[]) || [];
      ids.forEach((_, idx) => {
        setTimeout(() => {
          onMessage({
            id,
            event: "progress",
            data: { current: idx + 1, total: ids.length, message: `Writing XMP ${idx + 1}` },
          });
          if (idx === ids.length - 1) {
            onMessage({
              id,
              result: { written: ids.map((pid) => `photo_${pid}.xmp`), errors: [] },
            });
          }
        }, (idx + 1) * 60);
      });
      if (ids.length === 0) onMessage({ id, result: { written: [], errors: [] } });
      break;
    }
    case "cancel_job":
      onMessage({ id, result: { ok: true } });
      break;
    default:
      onMessage({ id, error: `Unknown method: ${method}` });
  }
}

const MOCK_CATEGORIES = ["clean", "_blurry", "_dark", "_overexposed", "_eyes_closed", "_duplicates"];

function generateMockEntries(cat: MockCatalog, count: number): PhotoEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const catIndex = i < 12 ? 0 : (i % (MOCK_CATEGORIES.length - 1)) + 1;
    // Photos 1-3 form stack 1, photos 5-6 form stack 2 (mimics burst grouping)
    const stackId = i < 3 ? 1 : i === 4 || i === 5 ? 2 : null;
    const isStackTop = i === 0 || i === 4;
    return {
      id: cat.nextPhotoId++,
      filename: `photo_${String(i + 1).padStart(3, "0")}.jpg`,
      path: `C:/mock-photos/photo_${String(i + 1).padStart(3, "0")}.jpg`,
      category: MOCK_CATEGORIES[catIndex] as PhotoEntry["category"],
      allLabels: catIndex > 0 ? [MOCK_CATEGORIES[catIndex]] : [],
      scores: {
        brightness: 80 + Math.random() * 100,
        blur: 20 + Math.random() * 80,
        ear: Math.random() * 0.4,
        aesthetic: 3 + Math.random() * 5,
        combined: Math.random(),
      },
      starRating: 1 + Math.floor(Math.random() * 5),
      ratingSource: "auto",
      stackId,
      isStackTop,
      flag: isStackTop ? ("pick" as const) : null,
    };
  });
}

let mockThumbCache: string | null = null;

function generatePlaceholderThumb(_size: number): string {
  // A real 256×256 gradient JPEG so the edit engine has actual pixels to
  // work with in mock mode (generated once per session)
  if (mockThumbCache) return mockThumbCache;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 256, 256);
  g.addColorStop(0, "#335577");
  g.addColorStop(0.5, "#88aa66");
  g.addColorStop(1, "#ddcc99");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = "#aa4444";
  ctx.beginPath();
  ctx.arc(128, 128, 60, 0, Math.PI * 2);
  ctx.fill();
  mockThumbCache = c.toDataURL("image/jpeg", 0.9).split(",")[1];
  return mockThumbCache;
}

// --- Public API ---

export interface OpenProjectResult {
  project: Project;
  entries: PhotoEntry[];
  editSettings: Record<string, EditSettings>; // keyed by photo path
}

export function createProject(folder: string, name?: string): Promise<Project> {
  return new Promise((resolve, reject) => {
    sendRequest("create_project", { folder, name }, (msg) => {
      if (msg.result) resolve((msg.result as { project: Project }).project);
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function listProjects(): Promise<Project[]> {
  return new Promise((resolve, reject) => {
    sendRequest("list_projects", {}, (msg) => {
      if (msg.result) resolve((msg.result as { projects: Project[] }).projects);
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function openProject(projectId: number): Promise<OpenProjectResult> {
  return new Promise((resolve, reject) => {
    sendRequest("open_project", { project_id: projectId }, (msg) => {
      if (msg.result) resolve(msg.result as OpenProjectResult);
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function deleteProject(projectId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("delete_project", { project_id: projectId }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function saveEditSettings(
  photoId: number,
  settings: EditSettings
): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("set_edit_settings", { photo_id: photoId, settings }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function scanPhotos(
  projectId: number,
  thresholds: ScanThresholds,
  dryRun: boolean,
  onProgress: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<ScanSummary> {
  return new Promise((resolve, reject) => {
    sendRequest(
      "scan",
      { project_id: projectId, thresholds, dry_run: dryRun },
      (msg) => {
        if (msg.event === "progress" && msg.data) {
          onProgress(msg.data as unknown as ScanProgress);
        } else if (msg.result) {
          resolve(msg.result as ScanSummary);
        } else if (msg.error) {
          reject(new Error(msg.error));
        }
      },
      signal
    );
  });
}

export function listPhotos(projectId: number): Promise<PhotoEntry[]> {
  return new Promise((resolve, reject) => {
    sendRequest("list_photos", { project_id: projectId }, (msg) => {
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

export function getThumbnailsBatch(
  paths: string[],
  size = 300
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    sendRequest("thumbnails_batch", { paths, size }, (msg) => {
      if (msg.result) {
        const raw = (msg.result as { thumbnails: Record<string, string | null> }).thumbnails;
        const out: Record<string, string> = {};
        // Ensure all requested paths are in the result, even if they failed
        for (const p of paths) {
          const d = raw[p];
          out[p] = d ? `data:image/jpeg;base64,${d}` : "";
        }
        resolve(out);
      } else if (msg.error) {
        reject(new Error(msg.error));
      }
    });
  });
}

export function getPreviewImage(path: string, maxPx = 2560): Promise<string> {
  return new Promise((resolve, reject) => {
    sendRequest("preview_image", { path, max_px: maxPx }, (msg) => {
      if (msg.result) {
        const data = msg.result as { data: string };
        resolve(`data:image/jpeg;base64,${data.data}`);
      } else if (msg.error) {
        reject(new Error(msg.error));
      }
    });
  });
}

export interface ExportOptions {
  destDir: string;
  quality?: number;
  maxPx?: number | null;
  suffix?: string;
}

export interface ExportResult {
  exported: string[];
  errors: { photo_id: number; error: string }[];
}

export function exportPhotos(
  photoIds: number[],
  opts: ExportOptions,
  onProgress: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    sendRequest(
      "export",
      {
        photo_ids: photoIds,
        dest_dir: opts.destDir,
        quality: opts.quality ?? 90,
        max_px: opts.maxPx ?? null,
        suffix: opts.suffix ?? "_edited",
      },
      (msg) => {
        if (msg.event === "progress" && msg.data) {
          onProgress(msg.data as unknown as ScanProgress);
        } else if (msg.result) {
          resolve(msg.result as ExportResult);
        } else if (msg.error) {
          reject(new Error(msg.error));
        }
      },
      signal
    );
  });
}

export interface Preset {
  id: number;
  name: string;
  settings: Partial<EditSettings>;
}

export function listPresets(): Promise<Preset[]> {
  return new Promise((resolve, reject) => {
    sendRequest("list_presets", {}, (msg) => {
      if (msg.result) resolve((msg.result as { presets: Preset[] }).presets);
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function savePreset(name: string, settings: EditSettings): Promise<Preset> {
  return new Promise((resolve, reject) => {
    sendRequest("save_preset", { name, settings }, (msg) => {
      if (msg.result) resolve((msg.result as { preset: Preset }).preset);
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function deletePreset(presetId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("delete_preset", { preset_id: presetId }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function importPreset(
  path: string
): Promise<{ preset: Preset; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    sendRequest("import_preset", { path }, (msg) => {
      if (msg.result) resolve(msg.result as { preset: Preset; warnings: string[] });
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export interface XmpWriteResult {
  written: string[];
  errors: { photo_id: number; error: string }[];
}

export function writeXmpSidecars(
  photoIds: number[],
  onProgress: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<XmpWriteResult> {
  return new Promise((resolve, reject) => {
    sendRequest(
      "write_xmp_sidecars",
      { photo_ids: photoIds },
      (msg) => {
        if (msg.event === "progress" && msg.data) {
          onProgress(msg.data as unknown as ScanProgress);
        } else if (msg.result) {
          resolve(msg.result as XmpWriteResult);
        } else if (msg.error) {
          reject(new Error(msg.error));
        }
      },
      signal
    );
  });
}

export interface AutoEditResult {
  edited: number;
  skipped: number;
  scenes: Record<string, number>;
}

export interface AiProfileConfig {
  scenePresets: Record<string, Partial<EditSettings>>;
  normalizeExposure: boolean;
  skipEdited: boolean;
  usePersonalModel?: boolean;
}

export interface IngestResult {
  pairsFound: number;
  ingested: number;
  errors: number;
  totalSamples: number;
  coverage: Record<string, number>;
  minSamples: number;
  recommendedSamples: number;
}

export interface TrainResult {
  valLoss: number;
  samples: number;
  valMae: Record<string, number>;
  usable: boolean;
  modelPath: string;
}

export interface PersonalModelStatus {
  available: boolean;
  usable?: boolean;
  valLoss?: number;
  samples?: number;
  trainingSamples?: number;
}

export function ingestTrainingData(
  folders: string[],
  onProgress: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<IngestResult> {
  return new Promise((resolve, reject) => {
    sendRequest("ingest_training_data", { folders }, (msg) => {
      if (msg.event === "progress" && msg.data) onProgress(msg.data as unknown as ScanProgress);
      else if (msg.result) resolve(msg.result as IngestResult);
      else if (msg.error) reject(new Error(msg.error));
    }, signal);
  });
}

export function trainProfile(
  onProgress: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<TrainResult> {
  return new Promise((resolve, reject) => {
    sendRequest("train_profile", {}, (msg) => {
      if (msg.event === "progress" && msg.data) onProgress(msg.data as unknown as ScanProgress);
      else if (msg.result) resolve(msg.result as TrainResult);
      else if (msg.error) reject(new Error(msg.error));
    }, signal);
  });
}

export function personalModelStatus(): Promise<PersonalModelStatus> {
  return new Promise((resolve, reject) => {
    sendRequest("personal_model_status", {}, (msg) => {
      if (msg.result) resolve(msg.result as PersonalModelStatus);
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function autoEdit(
  projectId: number,
  photoIds: number[],
  config: AiProfileConfig,
  onProgress: (p: ScanProgress) => void,
  signal?: AbortSignal
): Promise<AutoEditResult> {
  return new Promise((resolve, reject) => {
    sendRequest(
      "auto_edit",
      {
        project_id: projectId,
        photo_ids: photoIds,
        scene_presets: config.scenePresets,
        normalize_exposure: config.normalizeExposure,
        skip_edited: config.skipEdited,
        use_personal_model: config.usePersonalModel ?? true,
      },
      (msg) => {
        if (msg.event === "progress" && msg.data) {
          onProgress(msg.data as unknown as ScanProgress);
        } else if (msg.result) {
          resolve(msg.result as AutoEditResult);
        } else if (msg.error) {
          reject(new Error(msg.error));
        }
      },
      signal
    );
  });
}

export function getAiProfile(): Promise<{ id: number; name: string; config: AiProfileConfig }> {
  return new Promise((resolve, reject) => {
    sendRequest("get_ai_profile", {}, (msg) => {
      if (msg.result) {
        const p = (msg.result as { profile: { id: number; name: string; config: Record<string, unknown> } }).profile;
        const cfg = p.config as Partial<AiProfileConfig> & {
          scene_presets?: Record<string, Partial<EditSettings>>;
          normalize_exposure?: boolean;
          skip_edited?: boolean;
        };
        resolve({
          id: p.id,
          name: p.name,
          config: {
            scenePresets: cfg.scenePresets ?? cfg.scene_presets ?? {},
            normalizeExposure: cfg.normalizeExposure ?? cfg.normalize_exposure ?? true,
            skipEdited: cfg.skipEdited ?? cfg.skip_edited ?? true,
          },
        });
      } else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function saveAiProfile(config: AiProfileConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("save_ai_profile", { config }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function deleteEditSettings(photoId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("delete_edit_settings", { photo_id: photoId }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function setRating(
  projectId: number,
  filename: string,
  stars: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("set_rating", { project_id: projectId, filename, stars }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function reclassify(
  projectId: number,
  filename: string,
  category: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("reclassify", { project_id: projectId, filename, category }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function setFlag(
  projectId: number,
  filename: string,
  flag: "pick" | "reject" | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    sendRequest("set_flag", { project_id: projectId, filename, flag }, (msg) => {
      if (msg.result) resolve();
      else if (msg.error) reject(new Error(msg.error));
    });
  });
}

export function clearClassifications(projectId: number): Promise<{
  cleared: number;
  errors: string[];
}> {
  return new Promise((resolve, reject) => {
    sendRequest("clear", { project_id: projectId }, (msg) => {
      if (msg.result) {
        resolve(msg.result as { cleared: number; errors: string[] });
      } else if (msg.error) {
        reject(new Error(msg.error));
      }
    });
  });
}
