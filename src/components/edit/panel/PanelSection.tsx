
interface PanelSectionProps {
  title: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onReset: () => void;
  children: React.ReactNode;
}

export function PanelSection({ title, isCollapsed, onToggle, onReset, children }: PanelSectionProps) {
  return (
    <div className="border-b border-zinc-700">
      <div className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-800/50" onClick={onToggle}>
        <div className="flex items-center gap-2">
          <span className="text-zinc-400">
            {isCollapsed ? "▶" : "▼"}
          </span>
          <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReset();
          }}
          className="text-zinc-500 hover:text-zinc-300 text-sm"
          title="Reset section to defaults"
        >
          ↺
        </button>
      </div>
      {!isCollapsed && <div className="px-4 py-3 space-y-4">{children}</div>}
    </div>
  );
}
