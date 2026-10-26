import { useLayoutEffect, useRef, useState } from "react";

import type { ScanIssue } from "../../api/desktopApi";
import { REVIEW_PAGE_SIZE, ReviewPagination } from "./ReviewPagination";

export function ScanIssues({ issues }: { issues: ScanIssue[] }) {
  const [open, setOpen] = useState(false);
  const [issuePage, setIssuePage] = useState(0);
  const summaryRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusedNode = useRef<HTMLElement | null>(null);
  const focusAfterPage = useRef(false);
  const page = Math.max(0, Math.min(issuePage, Math.ceil(issues.length / REVIEW_PAGE_SIZE) - 1));

  useLayoutEffect(() => {
    if (issuePage !== page) setIssuePage(page);
    if (focusAfterPage.current || (focusedNode.current && !focusedNode.current.isConnected && document.activeElement === document.body)) {
      focusAfterPage.current = false;
      (open ? listRef.current : summaryRef.current)?.focus();
    }
  });

  if (issues.length === 0) return null;

  return (
    <details className="scan-issues" onToggle={(event) => setOpen(event.currentTarget.open)}
      onFocusCapture={(event) => { focusedNode.current = event.target; }}>
      <summary ref={summaryRef} tabIndex={0}>有 {issues.length.toLocaleString("zh-CN")} 项未完成检查</summary>
      {open ? <>
        <ReviewPagination label="扫描问题" page={page} total={issues.length} onPageChange={(nextPage) => {
          focusAfterPage.current = true;
          setIssuePage(nextPage);
        }} />
        <ul aria-label="扫描问题详情" ref={listRef} tabIndex={-1}>
          {issues.slice(page * REVIEW_PAGE_SIZE, (page + 1) * REVIEW_PAGE_SIZE).map((issue, index) => (
            <li key={`${issue.path}-${page * REVIEW_PAGE_SIZE + index}`}>
              <span>{issue.path}</span>
              <small>{issue.message}</small>
            </li>
          ))}
        </ul>
      </> : null}
    </details>
  );
}
