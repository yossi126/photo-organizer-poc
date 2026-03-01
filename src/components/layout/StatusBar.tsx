interface StatusBarProps {
  text: string;
}

export function StatusBar({ text }: StatusBarProps) {
  return (
    <div className="h-7 bg-zinc-900 border-t border-zinc-800 flex items-center px-3">
      <span className="text-xs text-zinc-500">{text}</span>
    </div>
  );
}
