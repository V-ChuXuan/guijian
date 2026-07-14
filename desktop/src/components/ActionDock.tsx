import type { ReactNode } from "react";

interface ActionDockProps {
  secondary?: ReactNode;
  summary?: ReactNode;
  primary?: ReactNode;
}

export function ActionDock({ secondary, summary, primary }: ActionDockProps) {
  return (
    <footer className="action-dock">
      <div className="action-dock__secondary">{secondary}</div>
      <div className="action-dock__summary">{summary}</div>
      <div className="action-dock__primary">{primary}</div>
    </footer>
  );
}
