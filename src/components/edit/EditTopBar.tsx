interface EditTopBarProps {
  filename: string;
  position: string;
  onBack: () => void;
}

export function EditTopBar({ filename, position, onBack }: EditTopBarProps) {
  return (
    <div className="h-10 border-b border-zinc-700 bg-zinc-900 flex items-center justify-between px-4">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        ← Back to grid
      </button>

      <div className="flex-1 text-center">
        <p className="text-sm text-zinc-300 truncate font-mono" title={filename}>
          {filename}
        </p>
      </div>

      <div className="text-sm text-zinc-500">{position}</div>
    </div>
  );
}
