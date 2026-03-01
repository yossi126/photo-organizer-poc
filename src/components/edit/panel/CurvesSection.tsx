interface CurvesSectionProps {
  // Placeholder: curves implementation is complex
}

export function CurvesSection({}: CurvesSectionProps) {
  return (
    <div className="py-4 text-center">
      <p className="text-sm text-zinc-400">Tone curve controls coming soon</p>
      <p className="text-xs text-zinc-600 mt-2">Advanced tone mapping requires WebGL/Canvas</p>
    </div>
  );
}
