import { useEffect, useState } from "react";
import { createProject, deleteProject, listProjects } from "../../lib/sidecar";
import { TrainingDialog } from "./TrainingDialog";
import type { Project } from "../../types/photo";

interface HomeScreenProps {
  onOpenProject: (project: Project, isNew: boolean) => void;
}

function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const date = new Date(unixSeconds * 1000);
  const diffMs = Date.now() - date.getTime();
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffDays === 0) {
    return `Today at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  if (diffDays === 1) {
    return `Yesterday at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function ApertureIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M14.31 8l5.74 9.94" />
      <path d="M9.69 8h11.48" />
      <path d="M7.38 12l5.74-9.94" />
      <path d="M9.69 16L3.95 6.06" />
      <path d="M14.31 16H2.83" />
      <path d="M16.62 12l-5.74 9.94" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7L19 15z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
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
      <div className="home-card home-stagger w-[560px] max-w-[calc(100vw-2rem)] bg-zinc-900 rounded-2xl p-8 shadow-2xl border border-zinc-800 my-8">
        <div className="text-center mb-8">
          <div className="home-aperture inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-b from-zinc-800 to-zinc-800/40 border border-zinc-700/60 text-zinc-300 mb-4 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
            <ApertureIcon />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Photo Organizer</h1>
          <p className="text-sm text-zinc-400 mt-1.5">
            Scan, cull, and edit your photos
          </p>
        </div>

        <div className="flex gap-2">
          <button
            disabled={busy}
            onClick={newProject}
            className="home-press flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 active:bg-blue-600 disabled:bg-zinc-800 disabled:text-zinc-400 rounded-lg text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          >
            {busy ? (
              <>
                <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                </svg>
                Creating…
              </>
            ) : (
              <>
                <PlusIcon />
                New Project
              </>
            )}
          </button>
          <button
            onClick={() => setShowTraining(true)}
            title="Train an AI profile on your past edits"
            className="home-press flex items-center gap-2 px-4 py-3 bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700/60 rounded-lg text-sm font-medium text-violet-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          >
            <SparkIcon />
            AI Profile
          </button>
        </div>

        {error && (
          <div role="alert" className="mt-3 px-3 py-2 rounded-lg bg-red-950/50 border border-red-900/60 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="mt-7">
          <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-[0.12em] mb-2.5">
            Recent projects
          </div>

          {loading ? (
            <div className="space-y-2" aria-hidden="true">
              {[0, 1].map((i) => (
                <div key={i} className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-800/40 px-4 py-3">
                  <div className="h-3.5 w-32 rounded bg-zinc-700/60 mb-2" />
                  <div className="h-2.5 w-56 rounded bg-zinc-800" />
                </div>
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-800 py-8 text-center">
              <p className="text-sm text-zinc-400">No projects yet</p>
              <p className="text-xs text-zinc-500 mt-1">
                Create one to start scanning a photo folder.
              </p>
            </div>
          ) : (
            <div className="home-rows space-y-2 max-h-80 overflow-y-auto pr-1 lr-panel-scroll">
              {projects.map((project) => (
                <div
                  key={project.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenProject(project, false)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenProject(project, false);
                    }
                  }}
                  className="group flex items-center gap-3 bg-zinc-800/60 hover:bg-zinc-800 hover:border-zinc-600/60 border border-zinc-700/50 rounded-lg px-4 py-3 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                >
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-700/40 text-zinc-400 group-hover:text-zinc-300 shrink-0 transition-colors">
                    <FolderIcon />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-sm font-medium text-zinc-200 truncate">
                        {project.name}
                      </span>
                      <span className="text-[11px] text-zinc-500 shrink-0">
                        {formatDate(project.lastOpenedAt)}
                      </span>
                    </div>
                    <div dir="ltr" className="text-xs text-zinc-500 font-mono truncate mt-0.5">
                      {project.folder}
                    </div>
                  </div>
                  <button
                    onClick={(e) => removeProject(e, project)}
                    title="Delete project"
                    aria-label={`Delete project ${project.name}`}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-950/40 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  >
                    <TrashIcon />
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
