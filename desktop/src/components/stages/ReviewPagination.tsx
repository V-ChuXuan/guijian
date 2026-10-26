export const REVIEW_PAGE_SIZE = 50;

interface ReviewPaginationProps {
  label: "重复组" | "文件" | "处理记录" | "扫描问题";
  name?: string;
  descriptionId?: string;
  page: number;
  total: number;
  onPageChange(page: number): void;
}

export function ReviewPagination({ label, name, descriptionId, page, total, onPageChange }: ReviewPaginationProps) {
  const pages = Math.ceil(total / REVIEW_PAGE_SIZE);
  if (pages <= 1) return null;
  const unit = { 重复组: "组", 文件: "文件", 处理记录: "条", 扫描问题: "项" }[label];
  return (
    <nav aria-label={`${label}分页${name ? ` ${name}` : ""}`} aria-describedby={descriptionId} className="review-pagination">
      <span aria-live="polite">第 {page * REVIEW_PAGE_SIZE + 1}–{Math.min((page + 1) * REVIEW_PAGE_SIZE, total)} / {total} {unit} · 第 {page + 1} / {pages} 页</span>
      <div className="review-pagination__actions">
        <button aria-label={`${label}：第一页`} className="text-button" disabled={page === 0} onClick={() => onPageChange(0)} type="button">首页</button>
        <button aria-label={`${label}：上一页`} className="text-button" disabled={page === 0} onClick={() => onPageChange(page - 1)} type="button">上一页</button>
        <button aria-label={`${label}：下一页`} className="text-button" disabled={page === pages - 1} onClick={() => onPageChange(page + 1)} type="button">下一页</button>
        <button aria-label={`${label}：最后一页`} className="text-button" disabled={page === pages - 1} onClick={() => onPageChange(pages - 1)} type="button">末页</button>
      </div>
    </nav>
  );
}
