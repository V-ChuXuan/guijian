const stages = [
  { number: 1, label: "选择位置" },
  { number: 2, label: "分析文件" },
  { number: 3, label: "检查副本" },
  { number: 4, label: "清理" },
] as const;

interface StageRailProps {
  currentStage: number;
  busy: boolean;
  onNavigate(stage: number): void;
}

export function StageRail({
  currentStage,
  busy,
  onNavigate,
}: StageRailProps) {
  return (
    <header className="stage-rail">
      <nav aria-label="清理步骤">
        <ol className="stage-list">
          {stages.map((stage) => {
            const state =
              stage.number === currentStage
                ? "active"
                : stage.number < currentStage
                  ? "complete"
                  : "upcoming";
            const canNavigate =
              stage.number === 1 && currentStage > stage.number && !busy;

            return (
              <li key={stage.number} data-state={state}>
                <button
                  aria-current={state === "active" ? "step" : undefined}
                  disabled={!canNavigate}
                  onClick={() => onNavigate(stage.number)}
                  type="button"
                >
                  <span className="stage-list__number">{stage.number}</span>
                  <span className="stage-list__copy">
                    <strong>{stage.label}</strong>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </header>
  );
}
