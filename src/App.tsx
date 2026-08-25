import { useState, useCallback, useRef } from "react";
import { HomeScreen } from "./components/home/HomeScreen";
import { TabBar } from "./components/layout/TabBar";
import { StatusBar } from "./components/layout/StatusBar";
import { ImportTab } from "./components/import/ImportTab";
import { CullTab } from "./components/cull/CullTab";
import { EditTab } from "./components/edit/EditTab";
import { useSidecar } from "./hooks/useSidecar";
import { useScan } from "./hooks/useScan";
import { useThumbnails } from "./hooks/useThumbnails";
import { useEditHistory } from "./hooks/useEditHistory";
import { ExportDialog } from "./components/edit/ExportDialog";
import { AutoEditDialog } from "./components/cull/AutoEditDialog";
import {
  openProject,
  setRating,
  reclassify,
  setFlag,
  saveEditSettings,
  deleteEditSettings,
  autoEdit,
  getAiProfile,
  getEditSettings,
  personalModelStatus,
} from "./lib/sidecar";
import { DEFAULT_EDIT_SETTINGS } from "./lib/constants";
import type {
  Category,
  PhotoEntry,
  PhotoFlag,
  Project,
  ScanThresholds,
  EditSettings,
} from "./types/photo";

type Screen = "home" | "review";

const EDIT_SAVE_DEBOUNCE_MS = 500;

export default function App() {
  const { ready, error: sidecarError } = useSidecar();
  const {
    scanning, progress, summary, logs, error: scanError,
    startScan, cancelScan, clear,
  } = useScan();
  const thumbnails = useThumbnails();

  const [screen, setScreen] = useState<Screen>("home");
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("import");
  const [entries, setEntries] = useState<PhotoEntry[]>([]);
  const [activeCategory, setActiveCategory] = useState<Category>("all");
  const [minStars, setMinStars] = useState(0);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0);
  const [editSettingsMap, setEditSettingsMap] = useState<Record<string, EditSettings>>({});
  const [clipboardSettings, setClipboardSettings] = useState<EditSettings | null>(null);
  const [exportPhotosList, setExportPhotosList] = useState<PhotoEntry[] | null>(null);
  const [autoEditPhotosList, setAutoEditPhotosList] = useState<PhotoEntry[] | null>(null);
  const history = useEditHistory();

  // Per-photo debounce timers + pending payloads for persisting edit settings
  const editSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingSaves = useRef<Map<string, { photoId: number; settings: EditSettings; record: boolean }>>(new Map());

  const loadProject = useCallback(async (projectId: number) => {
    try {
      const data = await openProject(projectId);
      setCurrentProject(data.project);
      setEntries(data.entries);
      // Merge over defaults so rows persisted before new fields existed still render
      const merged: Record<string, EditSettings> = {};
      for (const [path, settings] of Object.entries(data.editSettings)) {
        merged[path] = { ...DEFAULT_EDIT_SETTINGS, ...settings };
      }
      setEditSettingsMap(merged);
    } catch (err) {
      console.error("Failed to open project:", err);
    }
  }, []);

  const handleOpenProject = useCallback(
    async (project: Project, isNew: boolean) => {
      setScreen("review");
      setActiveCategory("all");
      setMinStars(0);
      setSelectedPhotoIndex(0);
      await loadProject(project.id);
      // New/empty projects start at IMPORT; existing ones resume at CULL
      setActiveTab(isNew ? "import" : "cull");
    },
    [loadProject]
  );

  const handleBackToProjects = useCallback(() => {
    if (scanning) cancelScan();
    setScreen("home");
    setCurrentProject(null);
    setEntries([]);
    setEditSettingsMap({});
    editSaveTimers.current.forEach((t) => clearTimeout(t));
    editSaveTimers.current.clear();
    pendingSaves.current.clear();
    history.clear();
  }, [scanning, cancelScan, history]);

  const handleStartScan = useCallback(
    async (thresholds: ScanThresholds, dryRun: boolean) => {
      if (!currentProject) return;
      await startScan(currentProject.id, thresholds, dryRun);
      await loadProject(currentProject.id);
      setActiveTab("cull");
    },
    [currentProject, startScan, loadProject]
  );

  const handleClear = useCallback(async () => {
    if (!currentProject) return;
    await clear(currentProject.id);
    await loadProject(currentProject.id);
  }, [currentProject, clear, loadProject]);

  const handleRatingChange = useCallback(
    async (entry: PhotoEntry, stars: number) => {
      if (!currentProject) return;
      await setRating(currentProject.id, entry.filename, stars);
      setEntries((prev) =>
        prev.map((e) =>
          e.filename === entry.filename ? { ...e, starRating: stars } : e
        )
      );
    },
    [currentProject]
  );

  const handleReclassify = useCallback(
    async (entry: PhotoEntry, category: string) => {
      if (!currentProject) return;
      await reclassify(currentProject.id, entry.filename, category);
      setEntries((prev) =>
        prev.map((e) =>
          e.filename === entry.filename
            ? { ...e, category: category as Category }
            : e
        )
      );
    },
    [currentProject]
  );

  const handleRevertEdit = useCallback(
    async (entry: PhotoEntry) => {
      await deleteEditSettings(entry.id);
      setEditSettingsMap((prev) => {
        const next = { ...prev };
        delete next[entry.path];
        return next;
      });
      const timer = editSaveTimers.current.get(entry.path);
      if (timer) clearTimeout(timer);
      editSaveTimers.current.delete(entry.path);
      pendingSaves.current.delete(entry.path);
    },
    []
  );

  const handleAutoEditSingle = useCallback(
    async (entry: PhotoEntry) => {
      if (!currentProject) return;
      const [profile, modelStatus] = await Promise.all([
        getAiProfile(),
        personalModelStatus().catch(() => null),
      ]);
      const config = {
        ...profile.config,
        skipEdited: false,
        usePersonalModel:
          (profile.config.usePersonalModel ?? true) && !!modelStatus?.usable,
      };
      await autoEdit(currentProject.id, [entry.id], config, () => {});
      const settings = await getEditSettings(entry.id);
      if (!settings) return;
      history.seed(entry.path, editSettingsMap[entry.path] ?? DEFAULT_EDIT_SETTINGS);
      setEditSettingsMap((prev) => ({
        ...prev,
        [entry.path]: { ...DEFAULT_EDIT_SETTINGS, ...settings },
      }));
      // Drop any pending debounced save so stale settings don't overwrite the AI result
      const timer = editSaveTimers.current.get(entry.path);
      if (timer) clearTimeout(timer);
      editSaveTimers.current.delete(entry.path);
      pendingSaves.current.delete(entry.path);
    },
    [currentProject, history, editSettingsMap]
  );

  const handleFlagChange = useCallback(
    async (entry: PhotoEntry, flag: PhotoFlag) => {
      if (!currentProject) return;
      await setFlag(currentProject.id, entry.filename, flag);
      setEntries((prev) =>
        prev.map((e) => (e.filename === entry.filename ? { ...e, flag } : e))
      );
    },
    [currentProject]
  );

  const handleSelectPhoto = useCallback(
    (index: number) => {
      setSelectedPhotoIndex(index);
      setActiveTab("edit");
    },
    []
  );

  const flushPathSave = useCallback(
    (path: string) => {
      const pending = pendingSaves.current.get(path);
      if (!pending) return;
      pendingSaves.current.delete(path);
      const timer = editSaveTimers.current.get(path);
      if (timer) {
        clearTimeout(timer);
        editSaveTimers.current.delete(path);
      }
      if (pending.record) history.record(path, pending.settings);
      saveEditSettings(pending.photoId, pending.settings).catch((err) =>
        console.error("Failed to save edit settings:", err)
      );
    },
    [history]
  );

  const persistEditSettings = useCallback(
    (path: string, settings: EditSettings, record = true) => {
      const entry = entries.find((e) => e.path === path);
      if (!entry) return;
      pendingSaves.current.set(path, { photoId: entry.id, settings, record });
      const timers = editSaveTimers.current;
      const existing = timers.get(path);
      if (existing) clearTimeout(existing);
      timers.set(
        path,
        setTimeout(() => flushPathSave(path), EDIT_SAVE_DEBOUNCE_MS)
      );
    },
    [entries, flushPathSave]
  );

  /** Flush every pending debounced save immediately (called before export). */
  const flushEditSaves = useCallback(async () => {
    const paths = Array.from(pendingSaves.current.keys());
    for (const path of paths) flushPathSave(path);
  }, [flushPathSave]);

  const handleEditSettingsChange = useCallback(
    (path: string, settings: EditSettings) => {
      // Seed history with the pre-edit state on the first change of a photo
      history.seed(path, editSettingsMap[path] ?? DEFAULT_EDIT_SETTINGS);
      setEditSettingsMap((prev) => ({ ...prev, [path]: settings }));
      persistEditSettings(path, settings);
    },
    [persistEditSettings, history, editSettingsMap]
  );

  const handleUndo = useCallback(
    (path: string) => {
      const settings = history.undo(path);
      if (!settings) return;
      setEditSettingsMap((prev) => ({ ...prev, [path]: settings }));
      persistEditSettings(path, settings, false);
    },
    [history, persistEditSettings]
  );

  const handleRedo = useCallback(
    (path: string) => {
      const settings = history.redo(path);
      if (!settings) return;
      setEditSettingsMap((prev) => ({ ...prev, [path]: settings }));
      persistEditSettings(path, settings, false);
    },
    [history, persistEditSettings]
  );

  const handleCopySettings = useCallback(
    (path: string) => {
      setClipboardSettings(editSettingsMap[path] ?? DEFAULT_EDIT_SETTINGS);
    },
    [editSettingsMap]
  );

  const handlePasteSettings = useCallback(
    (path: string) => {
      if (!clipboardSettings) return;
      history.seed(path, editSettingsMap[path] ?? DEFAULT_EDIT_SETTINGS);
      setEditSettingsMap((prev) => ({ ...prev, [path]: clipboardSettings }));
      persistEditSettings(path, clipboardSettings);
    },
    [clipboardSettings, persistEditSettings, history, editSettingsMap]
  );

  const statusText = scanning
    ? `Scanning... ${progress?.current || 0}/${progress?.total || 0}`
    : summary
      ? `Scan complete — ${entries.length} photos loaded${summary.skipped ? ` (${summary.skipped} skipped)` : ""}`
      : entries.length > 0
        ? `${entries.length} photos`
        : "Ready";

  if (sidecarError) {
    return (
      <div className="h-full flex items-center justify-center text-red-400 text-sm">
        Sidecar error: {sidecarError}
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
        Starting Photo Organizer...
      </div>
    );
  }

  if (screen === "home" || !currentProject) {
    return <HomeScreen onOpenProject={handleOpenProject} />;
  }

  return (
    <div className="h-full flex flex-col">
      <TabBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        projectName={currentProject.name}
        onBackToProjects={handleBackToProjects}
      />

      <div className="flex-1 flex overflow-hidden">
        {activeTab === "import" && (
          <ImportTab
            folder={currentProject.folder}
            scanning={scanning}
            progress={progress}
            logs={logs}
            onStartScan={handleStartScan}
            onCancelScan={cancelScan}
            onClear={handleClear}
          />
        )}
        {activeTab === "cull" && (
          <CullTab
            entries={entries}
            activeCategory={activeCategory}
            minStars={minStars}
            onCategoryChange={setActiveCategory}
            onStarsChange={setMinStars}
            onSelectPhoto={handleSelectPhoto}
            getThumbnail={thumbnails.get}
            getLargeImage={thumbnails.getLarge}
            cacheVersion={thumbnails.cacheVersion}
            getQueuedCount={thumbnails.getQueuedCount}
            onRatingChange={handleRatingChange}
            onFlagChange={handleFlagChange}
            onExport={(photos) => setExportPhotosList(photos)}
            onAutoEdit={(photos) => setAutoEditPhotosList(photos)}
          />
        )}
        {activeTab === "edit" && (
          <EditTab
            entries={entries}
            selectedIndex={selectedPhotoIndex}
            onIndexChange={setSelectedPhotoIndex}
            onBack={() => setActiveTab("cull")}
            onRatingChange={handleRatingChange}
            onReclassify={handleReclassify}
            getLargeImage={thumbnails.getLarge}
            getFullResImage={thumbnails.getFullResolution}
            getThumbnail={thumbnails.get}
            cacheVersion={thumbnails.cacheVersion}
            activeCategory={activeCategory}
            minStars={minStars}
            editSettingsMap={editSettingsMap}
            onEditSettingsChange={handleEditSettingsChange}
            clipboardSettings={clipboardSettings}
            onCopySettings={handleCopySettings}
            onPasteSettings={handlePasteSettings}
            onUndo={handleUndo}
            onRedo={handleRedo}
            canUndo={history.canUndo}
            canRedo={history.canRedo}
            onExport={(entry) => setExportPhotosList([entry])}
            onRevertEdit={handleRevertEdit}
            onAutoEditSingle={handleAutoEditSingle}
          />
        )}
      </div>

      <StatusBar text={statusText} />

      {exportPhotosList && (
        <ExportDialog
          photos={exportPhotosList}
          onClose={() => setExportPhotosList(null)}
          onBeforeExport={flushEditSaves}
        />
      )}

      {autoEditPhotosList && currentProject && (
        <AutoEditDialog
          projectId={currentProject.id}
          photos={autoEditPhotosList}
          onClose={() => setAutoEditPhotosList(null)}
          onDone={() => loadProject(currentProject.id)}
        />
      )}

      {scanError && (
        <div className="absolute bottom-8 right-4 bg-red-900/90 text-red-200 text-xs px-3 py-2 rounded-lg border border-red-800">
          {scanError}
        </div>
      )}
    </div>
  );
}
