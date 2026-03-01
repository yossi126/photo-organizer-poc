import { useState } from "react";

interface HomeScreenProps {
  onStart: (folder: string, resume: boolean) => void;
}

export function HomeScreen({ onStart }: HomeScreenProps) {
  const [folder, setFolder] = useState("");
  const [pickError, setPickError] = useState<string | null>(null);

  const pickFolder = async () => {
    setPickError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      console.log("Opening folder dialog...");
      const selected = await open({ directory: true, multiple: false });
      console.log("Dialog result:", selected);
      if (selected) {
        // Tauri v2 dialog returns string | string[] | null
        const path = Array.isArray(selected) ? selected[0] : selected;
        if (path) setFolder(path);
      }
    } catch (err) {
      console.error("Folder picker error:", err);
      // Browser mode fallback — prompt for path
      const path = prompt("Enter folder path:");
      if (path) setFolder(path);
      else setPickError(String(err));
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-zinc-950">
      <div className="w-[480px] bg-zinc-900 rounded-2xl p-8 shadow-2xl border border-zinc-800">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">📸</div>
          <h1 className="text-2xl font-bold text-zinc-100">Photo Organizer</h1>
          <p className="text-sm text-zinc-500 mt-2">
            Scan, classify, and review your photos
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
              Photo folder
            </label>
            <div className="flex gap-2 mt-1.5">
              <input
                type="text"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="Select a folder..."
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                onClick={pickFolder}
                className="px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Browse
              </button>
            </div>
          </div>

          {pickError && (
            <p className="text-xs text-red-400 mt-1">{pickError}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              disabled={!folder}
              onClick={() => onStart(folder, false)}
              className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-sm font-medium text-white transition-colors"
            >
              New Scan
            </button>
            <button
              disabled={!folder}
              onClick={() => onStart(folder, true)}
              className="flex-1 py-3 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-600 border border-zinc-700 rounded-lg text-sm font-medium text-zinc-300 transition-colors"
            >
              Resume Project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
