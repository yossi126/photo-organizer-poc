import { useCallback, useMemo, useRef, useState } from "react";
import { monotoneCubicLut } from "../../../lib/render/luts";
import type { EditSettings } from "../../../types/photo";

interface CurvesSectionProps {
  settings: EditSettings;
  onSettingsChange: (settings: EditSettings) => void;
}

type ChannelKey = "toneCurve" | "toneCurveRed" | "toneCurveGreen" | "toneCurveBlue";

const CHANNELS: { key: ChannelKey; label: string; color: string }[] = [
  { key: "toneCurve", label: "RGB", color: "#e4e4e7" },
  { key: "toneCurveRed", label: "R", color: "#f87171" },
  { key: "toneCurveGreen", label: "G", color: "#4ade80" },
  { key: "toneCurveBlue", label: "B", color: "#60a5fa" },
];

const SIZE = 232;   // svg viewport (square)
const PAD = 8;      // inner padding
const INNER = SIZE - PAD * 2;
const POINT_R = 5;
const MIN_X_GAP = 0.02;

const IDENTITY: [number, number][] = [[0, 0], [1, 1]];

// curve space [0,1] ↔ svg coords (y axis flipped)
const toSvg = (p: [number, number]) => ({
  x: PAD + p[0] * INNER,
  y: PAD + (1 - p[1]) * INNER,
});
const fromSvg = (x: number, y: number): [number, number] => [
  Math.min(1, Math.max(0, (x - PAD) / INNER)),
  Math.min(1, Math.max(0, 1 - (y - PAD) / INNER)),
];

export function CurvesSection({ settings, onSettingsChange }: CurvesSectionProps) {
  const [channel, setChannel] = useState<ChannelKey>("toneCurve");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const points: [number, number][] = useMemo(() => {
    const p = settings[channel];
    return p && p.length >= 2 ? p : IDENTITY;
  }, [settings, channel]);

  const setPoints = useCallback(
    (next: [number, number][]) => {
      onSettingsChange({ ...settings, [channel]: next });
    },
    [settings, channel, onSettingsChange]
  );

  // Smooth path through the monotone cubic (64 samples is plenty for display)
  const pathD = useMemo(() => {
    const lut = monotoneCubicLut(points, 64);
    let d = "";
    for (let i = 0; i < 64; i++) {
      const { x, y } = toSvg([i / 63, lut[i]]);
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    return d;
  }, [points]);

  const svgPos = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const { x, y } = svgPos(e);
      // Hit-test existing points first
      for (let i = 0; i < points.length; i++) {
        const sp = toSvg(points[i]);
        if (Math.hypot(sp.x - x, sp.y - y) < POINT_R * 2.5) {
          setDragIndex(i);
          (e.target as Element).setPointerCapture?.(e.pointerId);
          return;
        }
      }
      // Otherwise add a point (not beyond endpoints)
      const [cx, cy] = fromSvg(x, y);
      if (cx <= points[0][0] + MIN_X_GAP || cx >= points[points.length - 1][0] - MIN_X_GAP) return;
      const next: [number, number][] = [...points, [cx, cy] as [number, number]].sort(
        (a, b) => a[0] - b[0]
      );
      setPoints(next);
      setDragIndex(next.findIndex((p) => p[0] === cx && p[1] === cy));
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [points, setPoints, svgPos]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragIndex === null) return;
      const { x, y } = svgPos(e);
      let [cx, cy] = fromSvg(x, y);
      const isEndpoint = dragIndex === 0 || dragIndex === points.length - 1;
      if (isEndpoint) {
        // Endpoints keep their x, only y moves
        cx = points[dragIndex][0];
      } else {
        // Keep x strictly between neighbors
        const lo = points[dragIndex - 1][0] + MIN_X_GAP;
        const hi = points[dragIndex + 1][0] - MIN_X_GAP;
        cx = Math.min(hi, Math.max(lo, cx));
      }
      const next = points.map((p, i) => (i === dragIndex ? ([cx, cy] as [number, number]) : p));
      setPoints(next);
    },
    [dragIndex, points, setPoints, svgPos]
  );

  const handlePointerUp = useCallback(() => setDragIndex(null), []);

  const handleDoubleClick = useCallback(
    (index: number) => {
      // Remove interior point on double click
      if (index === 0 || index === points.length - 1) return;
      setPoints(points.filter((_, i) => i !== index));
    },
    [points, setPoints]
  );

  const resetChannel = useCallback(() => setPoints(IDENTITY), [setPoints]);

  const channelColor = CHANNELS.find((c) => c.key === channel)!.color;

  return (
    <div>
      {/* Channel tabs + reset */}
      <div className="flex items-center gap-1 mb-2">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChannel(c.key)}
            className="px-2.5 py-1 rounded text-xs font-medium transition-colors"
            style={{
              color: channel === c.key ? c.color : "#71717a",
              background: channel === c.key ? "#27272a" : "transparent",
            }}
          >
            {c.label}
          </button>
        ))}
        <button
          onClick={resetChannel}
          className="ml-auto px-2 py-1 text-[10px] text-zinc-500 hover:text-zinc-300"
          title="Reset this channel to linear"
        >
          Reset
        </button>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        {/* Grid */}
        {[0.25, 0.5, 0.75].map((t) => (
          <g key={t} stroke="#27272a" strokeWidth="1">
            <line x1={PAD + t * INNER} y1={PAD} x2={PAD + t * INNER} y2={SIZE - PAD} />
            <line x1={PAD} y1={PAD + t * INNER} x2={SIZE - PAD} y2={PAD + t * INNER} />
          </g>
        ))}
        {/* Diagonal reference */}
        <line
          x1={PAD} y1={SIZE - PAD} x2={SIZE - PAD} y2={PAD}
          stroke="#3f3f46" strokeWidth="1" strokeDasharray="4 4"
        />
        {/* Curve */}
        <path d={pathD} fill="none" stroke={channelColor} strokeWidth="2" />
        {/* Points */}
        {points.map((p, i) => {
          const sp = toSvg(p);
          return (
            <circle
              key={i}
              cx={sp.x}
              cy={sp.y}
              r={POINT_R}
              fill={dragIndex === i ? channelColor : "#18181b"}
              stroke={channelColor}
              strokeWidth="2"
              style={{ cursor: "grab" }}
              onDoubleClick={() => handleDoubleClick(i)}
            />
          );
        })}
      </svg>

      <p className="text-[10px] text-zinc-600 mt-2">
        Click to add a point · drag to shape · double-click a point to remove
      </p>
    </div>
  );
}
