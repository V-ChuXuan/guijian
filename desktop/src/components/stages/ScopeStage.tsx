import type { DirectorySelection } from "../../api/desktopApi";
import { Icon } from "../Icon";

interface ScopeStageProps {
  selection: DirectorySelection | null;
  selecting: boolean;
  issue: string | null;
  onSelect(): void;
}

export function ScopeStage({
  selection,
  selecting,
  issue,
  onSelect,
}: ScopeStageProps) {
  return (
    <section className="scope-stage stage-enter" aria-labelledby="page-title">
      <div className={`scope-picker-card ${selection ? "" : "is-empty"}`}>
        <div className="scope-picker-card__visual" aria-hidden="true">
          <Icon name="folder" size={34} />
        </div>
        {selection ? (
          <>
            <div className="scope-picker-card__copy">
              <h2>{selection.name}</h2>
              <p className="path-text" title={selection.path}>
                {selection.path}
              </p>
            </div>
            <button
              className="button button--outline"
              disabled={selecting}
              onClick={onSelect}
              type="button"
            >
              <Icon name="folder" size={18} />
              {selecting ? "正在打开…" : "更换位置"}
            </button>
          </>
        ) : (
          <button
            className="button button--outline scope-picker-card__choose"
            disabled={selecting}
            onClick={onSelect}
            type="button"
          >
            <Icon name="folder" size={18} />
            {selecting ? "正在打开…" : "选择文件夹"}
          </button>
        )}
      </div>

      {issue ? (
        <div className="inline-issue inline-issue--danger" role="alert">
          <Icon name="warning" />
          <div>
            <strong>无法使用这个位置</strong>
            <p>{issue}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
