interface TabBarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  projectName?: string;
  onBackToProjects?: () => void;
}

const TABS = [
  { id: "import", label: "IMPORT" },
  { id: "cull", label: "CULL" },
  { id: "edit", label: "EDIT" },
];

export function TabBar({ activeTab, onTabChange, projectName, onBackToProjects }: TabBarProps) {
  return (
    <div className="flex bg-zinc-900 border-b border-zinc-800 items-center">
      {onBackToProjects && (
        <button
          onClick={onBackToProjects}
          title="Back to projects"
          className="px-4 py-3 text-sm text-zinc-500 hover:text-zinc-200 transition-colors border-r border-zinc-800"
        >
          ←
        </button>
      )}
      {TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className="px-6 py-3 text-sm font-medium transition-colors relative"
          style={{
            color: activeTab === tab.id ? "#e4e4e7" : "#71717a",
          }}
        >
          {tab.label}
          {activeTab === tab.id && (
            <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
          )}
        </button>
      ))}
      {projectName && (
        <div className="ml-auto px-4 text-xs text-zinc-500 truncate max-w-64">
          {projectName}
        </div>
      )}
    </div>
  );
}
