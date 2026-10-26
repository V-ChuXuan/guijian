import type { ScanProgress } from "../../api/desktopApi";
import { formatBytes } from "../../lib/format";
import { Icon } from "../Icon";

interface ScanStageProps {
  progress: ScanProgress | null;
  state: "running" | "cancelled" | "failed";
  issue: string | null;
  progressIssue?: string | null;
  stopping?: boolean;
}

export function ScanStage({ progress, state, issue, progressIssue = null, stopping = false }: ScanStageProps) {
  const determinate = !progressIssue && progress?.stage !== "enumerating" && !!progress?.total && !stopping;
  const percent = determinate && progress
    ? Math.max(0, Math.min(100, Math.floor((progress.completed / progress.total) * 100)))
    : undefined;
  const phase = progress?.stage ?? "enumerating";
  const label = stopping ? "正在停止分析" : progressIssue ? "正在分析文件" : {
    enumerating: "正在发现文件",
    partial_hash: "正在初步比对",
    full_hash: "正在完整比对",
  }[phase];

  if (state === "cancelled") {
    return (
      <section className="center-state stage-enter" aria-labelledby="page-title">
        <span className="center-state__icon center-state__icon--quiet">
          <Icon name="stop" size={30} />
        </span>
        <p>可以重新分析，或返回选择位置。</p>
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
            <strong aria-live="polite">{label}</strong>
            <p className="path-text" title={progress?.currentPath ?? undefined}>
              {progress?.currentPath ?? (progress ? "正在整理本阶段结果…" : "正在准备…")}
            </p>
          </div>
          {percent !== undefined ? <span className="scan-ledger__percent">{percent}%</span> : null}
        </div>
        <div
          aria-label={percent !== undefined ? `当前阶段进度 ${percent}%` : label}
          aria-valuemax={percent !== undefined ? 100 : undefined}
          aria-valuemin={percent !== undefined ? 0 : undefined}
          aria-valuenow={percent}
          className={`progress-track ${percent === undefined ? "progress-track--indeterminate" : ""}`}
          role="progressbar"
        >
          <span style={percent !== undefined ? { width: `${percent}%` } : undefined} />
        </div>
        <p className="scan-phase-count" role={progressIssue ? "status" : undefined}>
          {progressIssue ? `${progressIssue}，请等待扫描结果。` : phase === "enumerating"
            ? "正在统计目录，文件总数尚未确定"
            : `${(progress?.completed ?? 0).toLocaleString("zh-CN")} / ${(progress?.total ?? 0).toLocaleString("zh-CN")} 个候选文件`}
        </p>
      </div>

      {issue ? <div className="inline-issue inline-issue--danger" role="alert"><Icon name="warning" /><p>{issue}</p></div> : null}

      {!progressIssue ? <div className="scan-metrics">
        <article>
          <span>已发现文件</span>
          <strong>{(progress?.scannedFiles ?? 0).toLocaleString("zh-CN")}</strong>
        </article>
        <article>
          <span>文件容量</span>
          <strong>{formatBytes(progress?.scannedBytes ?? 0)}</strong>
        </article>
      </div> : null}
    </section>
  );
}
