import type { CleanupReport, ScanSession } from "../../api/desktopApi";
import { formatBytes } from "../../lib/format";
import { Icon } from "../Icon";

export type CleanupView = "confirm" | "running" | "complete" | "failed";

interface CleanupStageProps {
  view: CleanupView;
  session: ScanSession;
  report: CleanupReport | null;
  issue: string | null;
}

function cleanupSummary(session: ScanSession) {
  return session.groups.reduce(
    (summary, group) => {
      let groupFiles = 0;
      for (const file of group.files) {
        if (file.cleanup) {
          summary.files += 1;
          groupFiles += 1;
        }
      }
      if (groupFiles > 0) {
        summary.groups += 1;
      }
      summary.bytes += group.reclaimableBytes;
      return summary;
    },
    { files: 0, groups: 0, bytes: 0 },
  );
}

export function CleanupStage({
  view,
  session,
  report,
  issue,
}: CleanupStageProps) {
  const summary = cleanupSummary(session);

  if (view === "running") {
    return (
      <section className="cleanup-running stage-enter" aria-labelledby="page-title">
        <span className="cleanup-running__scanner" aria-hidden="true">
          <Icon name="archive" size={34} />
        </span>
        <h2>正在把确认的副本移至回收站</h2>
        <div
          aria-label="清理进度"
          className="progress-track progress-track--indeterminate"
          role="progressbar"
        >
          <span />
        </div>
      </section>
    );
  }

  if (view === "complete" && report) {
    const partial = report.skippedCount > 0 || report.failedCount > 0;
    return (
      <section className="cleanup-receipt stage-enter" aria-labelledby="page-title">
        <div className={`receipt-seal ${partial ? "is-partial" : ""}`}>
          <Icon name={partial ? "warning" : "check"} size={36} />
        </div>
        <h2>清理完成</h2>
        <div className="receipt-capacity">
          <span>可释放</span>
          <strong>{formatBytes(report.reclaimableBytes)}</strong>
        </div>
        <div className="receipt-stats">
          <span>
            <Icon name="archive" size={17} /> 已移入回收站 {report.movedCount} 个
          </span>
          <span>
            <Icon name="shield" size={17} /> 跳过 {report.skippedCount} 个
          </span>
          <span className={report.failedCount ? "has-failure" : ""}>
            <Icon name="warning" size={17} /> 失败 {report.failedCount} 个
          </span>
        </div>
        {partial ? (
          <div className="inline-issue inline-issue--warning">
            <Icon name="warning" />
            <p>部分文件未处理。</p>
          </div>
        ) : null}
        <details className="receipt-details">
          <summary>查看处理详情</summary>
          {report.items.map((item) => (
            <p key={item.path}>
              <span className="path-text" title={item.path}>
                {item.path}
              </span>
              <small>{item.message}</small>
            </p>
          ))}
        </details>
      </section>
    );
  }

  if (view === "failed") {
    return (
      <section className="center-state stage-enter" aria-labelledby="page-title">
        <span className="center-state__icon center-state__icon--danger">
          <Icon name="warning" size={30} />
        </span>
        <h2>清理没有开始</h2>
        <p role="alert">{issue ?? "回收站暂时不可用，请稍后重试。"}</p>
      </section>
    );
  }

  return (
    <section className="cleanup-confirm stage-enter" aria-labelledby="page-title">
      <div className="cleanup-ticket">
        <div className="cleanup-ticket__body">
          <h2>准备移动 {summary.files} 个副本</h2>
          <dl>
            <div>
              <dt>扫描位置</dt>
              <dd className="path-text" title={session.root}>
                {session.root}
              </dd>
            </div>
            <div>
              <dt>涉及重复组</dt>
              <dd>{summary.groups} 组</dd>
            </div>
            <div>
              <dt>预计释放</dt>
              <dd className="ticket-capacity">{formatBytes(summary.bytes)}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="confirmation-safety">
        <Icon name="shield" size={18} />
        <span>文件将移至回收站。</span>
      </div>
    </section>
  );
}
