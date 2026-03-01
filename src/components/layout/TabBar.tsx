interface TabBarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const TABS = [
  { id: "import", label: "IMPORT" },
  { id: "cull", label: "CULL" },
  { id: "edit", label: "EDIT" },
];

export function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <div className="flex bg-zinc-900 border-b border-zinc-800">
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
    </div>
  );
}
