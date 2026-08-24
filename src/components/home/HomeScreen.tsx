import { useEffect, useState } from "react";
import { createProject, deleteProject, listProjects } from "../../lib/sidecar";
import { TrainingDialog } from "./TrainingDialog";
import type { Project } from "../../types/photo";

interface HomeScreenProps {
  onOpenProject: (project: Project, isNew: boolean) => void;
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  return new Date(unixSeconds * 1000).toLocaleString();
}

export function HomeScreen({ onOpenProject }: HomeScreenProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTraining, setShowTraining] = useState(false);

  const refresh = async () => {
    try {
      setProjects(await listProjects());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const newProject = async () => {
    setError(null);
    let folder: string | null = null;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      folder = Array.isArray(selected) ? selected[0] : selected;
    } catch {
      // Browser mode fallback — prompt for path
      folder = prompt("Enter folder path:");
    }
    if (!folder) return;

    setBusy(true);
    try {
      const project = await createProject(folder);
      onOpenProject(project, true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeProject = async (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    if (!confirm(`Delete project "${project.name}"?\n\nPhotos on disk are NOT deleted — only ratings, classifications and edits stored in the catalog.`)) {
      return;
    }
    try {
      await deleteProject(project.id);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center bg-zinc-950 overflow-y-auto">
      <div className="w-[560px] bg-zinc-900 rounded-2xl p-8 shadow-2xl border border-zinc-800 my-8">
        <div className="text-center mb-8">
          <div className="text-4xl mb-3">📸</div>
          <h1 className="text-2xl font-bold text-zinc-100">Photo Organizer</h1>
          <p className="text-sm text-zinc-500 mt-2">
            Scan, cull, and edit your photos
          </p>
        </div>

        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={newProject}
            className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 rounded-lg text-sm font-medium text-white transition-colors"
          >
            {busy ? "Creating..." : "+ New Project"}
          </button>
          <button
            onClick={() => setShowTraining(true)}
            title="Train an AI profile on your past edits"
            className="px-4 py-3 bg-violet-700 hover:bg-violet-600 rounded-lg text-sm font-medium text-white transition-colors"
          >
            🧠 AI Profile
          </button>
        </div>

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        <div className="mt-6">
          <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
            Recent projects
          </div>

          {loading ? (
            <p className="text-sm text-zinc-600 py-4 text-center">Loading...</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-zinc-600 py-4 text-center">
              No projects yet — create one to get started.
            </p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {projects.map((project) => (
                <div
                  key={project.id}
                  onClick={() => onOpenProject(project, false)}
                  className="group flex items-center gap-3 bg-zinc-800/60 hover:bg-zinc-800 border border-zinc-700/50 rounded-lg px-4 py-3 cursor-pointer transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-zinc-200 truncate">
                      {project.name}
                    </div>
                    <div className="text-xs text-zinc-500 font-mono truncate">
                      {project.folder}
                    </div>
                    <div className="text-[10px] text-zinc-600 mt-0.5">
                      Last opened: {formatDate(project.lastOpenedAt)}
                    </div>
                  </div>
                  <button
                    onClick={(e) => removeProject(e, project)}
                    title="Delete project"
                    className="opacity-0 group-hover:opacity-100 px-2 py-1 text-xs text-zinc-500 hover:text-red-400 transition-all"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showTraining && <TrainingDialog onClose={() => setShowTraining(false)} />}
    </div>
  );
}
