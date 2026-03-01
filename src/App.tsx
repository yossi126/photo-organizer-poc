import { useState, useCallback } from "react";
import { HomeScreen } from "./components/home/HomeScreen";
import { TabBar } from "./components/layout/TabBar";
import { StatusBar } from "./components/layout/StatusBar";
import { ImportTab } from "./components/import/ImportTab";
import { CullTab } from "./components/cull/CullTab";
import { EditTab } from "./components/edit/EditTab";
import { useSidecar } from "./hooks/useSidecar";
import { useScan } from "./hooks/useScan";
import { useThumbnails } from "./hooks/useThumbnails";
import { listPhotos, setRating, reclassify } from "./lib/sidecar";
import { DEFAULT_EDIT_SETTINGS } from "./lib/constants";
import type { Category, PhotoEntry, ScanThresholds, EditSettings } from "./types/photo";

type Screen = "home" | "review";

export default function App() {
  const { ready, error: sidecarError } = useSidecar();
  const { scanning, progress, summary, logs, error: scanError, startScan, clear } = useScan();
  const thumbnails = useThumbnails();

  const [screen, setScreen] = useState<Screen>("home");
  const [folder, setFolder] = useState("");
  const [activeTab, setActiveTab] = useState("import");
  const [entries, setEntries] = useState<PhotoEntry[]>([]);
  const [activeCategory, setActiveCategory] = useState<Category>("all");
  const [minStars, setMinStars] = useState(0);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0);
  const [editSettingsMap, setEditSettingsMap] = useState<Record<string, EditSettings>>({});
  const [clipboardSettings, setClipboardSettings] = useState<EditSettings | null>(null);

  const loadEntries = useCallback(async (path: string) => {
    try {
      console.log("Loading entries for:", path);
      const data = await listPhotos(path);
      console.log("Loaded entries:", data.length);
      setEntries(data);
    } catch (err) {
      console.error("Failed to load entries:", err);
    }
  }, []);

  const handleStart = useCallback(
    async (path: string, resume: boolean) => {
      setFolder(path);
      setScreen("review");
      if (resume) {
        setActiveTab("cull");
        await loadEntries(path);
      } else {
        setActiveTab("import");
      }
    },
    [loadEntries]
  );

  const handleStartScan = useCallback(
    async (thresholds: ScanThresholds, dryRun: boolean) => {
      console.log("Starting scan for:", folder);
      await startScan(folder, thresholds, dryRun);
      console.log("Scan finished, loading entries...");
      // Small delay to ensure the sidecar's stdout pipe is fully flushed
      // and the event loop has processed all pending scan messages
      await new Promise((r) => setTimeout(r, 100));
      await loadEntries(folder);
      console.log("Entries loaded after scan, switching to cull tab");
      setActiveTab("cull");
    },
    [folder, startScan, loadEntries]
  );

  const handleClear = useCallback(async () => {
    await clear(folder);
    await loadEntries(folder);
  }, [folder, clear, loadEntries]);

  const handleRatingChange = useCallback(
    async (entry: PhotoEntry, stars: number) => {
      await setRating(folder, entry.filename, stars);
      setEntries((prev) =>
        prev.map((e) =>
          e.filename === entry.filename ? { ...e, starRating: stars } : e
        )
      );
    },
    [folder]
  );

  const handleReclassify = useCallback(
    async (entry: PhotoEntry, category: string) => {
      await reclassify(folder, entry.filename, category);
      setEntries((prev) =>
        prev.map((e) =>
          e.filename === entry.filename
            ? { ...e, category: category as Category }
            : e
        )
      );
    },
    [folder]
  );

  const handleSelectPhoto = useCallback(
    (index: number) => {
      setSelectedPhotoIndex(index);
      setActiveTab("edit");
    },
    []
  );

  const handleEditSettingsChange = useCallback(
    (path: string, settings: EditSettings) => {
      setEditSettingsMap((prev) => ({ ...prev, [path]: settings }));
    },
    []
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
      setEditSettingsMap((prev) => ({ ...prev, [path]: clipboardSettings }));
    },
    [clipboardSettings]
  );

  const statusText = scanning
    ? `Scanning... ${progress?.current || 0}/${progress?.total || 0}`
    : summary
      ? `Scan complete — ${entries.length} photos loaded`
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

  if (screen === "home") {
    return <HomeScreen onStart={handleStart} />;
  }

  return (
    <div className="h-full flex flex-col">
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex-1 flex overflow-hidden">
        {activeTab === "import" && (
          <ImportTab
            folder={folder}
            scanning={scanning}
            progress={progress}
            logs={logs}
            onStartScan={handleStartScan}
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
            cacheVersion={thumbnails.cacheVersion}
            getQueuedCount={thumbnails.getQueuedCount}
            onRatingChange={handleRatingChange}
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
            getThumbnail={thumbnails.get}
            cacheVersion={thumbnails.cacheVersion}
            activeCategory={activeCategory}
            minStars={minStars}
            editSettingsMap={editSettingsMap}
            onEditSettingsChange={handleEditSettingsChange}
            clipboardSettings={clipboardSettings}
            onCopySettings={handleCopySettings}
            onPasteSettings={handlePasteSettings}
          />
        )}
      </div>

      <StatusBar text={statusText} />

      {scanError && (
        <div className="absolute bottom-8 right-4 bg-red-900/90 text-red-200 text-xs px-3 py-2 rounded-lg border border-red-800">
          {scanError}
        </div>
      )}
    </div>
  );
}
