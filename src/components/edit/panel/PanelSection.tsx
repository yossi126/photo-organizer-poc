
interface PanelSectionProps {
  title: string;
  isCollapsed: boolean;
  onToggle: () => void;
  onReset: () => void;
  children: React.ReactNode;
}

export function PanelSection({
  title,
  isCollapsed,
  onToggle,
  onReset,
  children,
}: PanelSectionProps) {
  return (
    <div style={{ borderBottom: "1px solid #222" }}>
      {/* Section header */}
      <div
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "7px 12px 6px",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              fontSize: 8,
              color: "#555",
              display: "inline-block",
              transition: "transform 0.15s ease",
              transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
              lineHeight: 1,
            }}
          >
            ▼
          </span>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.07em",
              color: "#c8c8c8",
              textTransform: "uppercase",
            }}
          >
            {title}
          </span>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onReset();
          }}
          style={{
            fontSize: 10,
            color: "#555",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
            borderRadius: 3,
            transition: "color 0.1s",
          }}
          onMouseOver={(e) => (e.currentTarget.style.color = "#999")}
          onMouseOut={(e) => (e.currentTarget.style.color = "#555")}
          title="Reset section to defaults"
        >
          Reset
        </button>
      </div>

      {/* Section body */}
      {!isCollapsed && (
        <div
          style={{
            padding: "4px 12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
