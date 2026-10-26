// Advisory only: mirror cleanup.rs Shell path rules; final checks remain in Rust.
export function getRecyclePathIssue(path: string): string | null {
  const shellPath = path.startsWith("\\\\?\\UNC\\")
    ? `\\\\${path.slice(8)}`
    : path.startsWith("\\\\?\\") ? path.slice(4) : path;
  return shellPath.length >= 260
    ? "路径过长，当前版本无法回收；请缩短路径后重新扫描。"
    : null;
}
