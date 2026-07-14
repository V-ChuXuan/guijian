import type { ScanProgress } from "../../api/desktopApi";
import { formatBytes } from "../../lib/format";
import { Icon } from "../Icon";

interface ScanStageProps {
  progress: ScanProgress | null;
  state: "running" | "cancelled" | "failed";
  issue: string | null;
}

export function ScanStage({ progress, state, issue }: ScanStageProps) {
  const percent = progress?.total
    ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
    : 0;

  if (state === "cancelled") {
    return (
      <section className="center-state stage-enter" aria-labelledby="page-title">
        <span className="center-state__icon center-state__icon--quiet">
          <Icon name="stop" size={30} />
        </span>
        <h2>分析已停止</h2>
      </section>
    );
  }

  if (state === "failed") {
    return (
      <section className="center-state stage-enter" aria-labelledby="page-title">
        <span className="center-state__icon center-state__icon--danger">
          <Icon name="warning" size={30} />
        </span>
        <h2>这次分析没有完成</h2>
        <p role="alert">{issue ?? "扫描服务暂时不可用，请稍后重试。"}</p>
      </section>
    );
  }

  return (
    <section className="scan-stage stage-enter" aria-labelledby="page-title">
      <div className="scan-ledger">
        <div className="scan-ledger__head">
          <span className="scan-ledger__pulse" aria-hidden="true">
            <Icon name="scan" size={30} />
          </span>
          <div>
            <strong>扫描中</strong>
            <p className="path-text" title={progress?.currentPath}>
              {progress?.currentPath ?? "正在准备…"}
            </p>
          </div>
          <span className="scan-ledger__percent">{percent}%</span>
        </div>
        <div
          aria-label={`分析进度 ${percent}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={percent}
          className="progress-track"
          role="progressbar"
        >
          <span style={{ width: `${Math.max(percent, 2)}%` }} />
        </div>
      </div>

      <div className="scan-metrics" aria-live="polite">
        <article>
          <span>已检查文件</span>
          <strong>{(progress?.scannedFiles ?? 0).toLocaleString("zh-CN")}</strong>
        </article>
        <article>
          <span>已读取容量</span>
          <strong>{formatBytes(progress?.scannedBytes ?? 0)}</strong>
        </article>
      </div>
    </section>
  );
}
