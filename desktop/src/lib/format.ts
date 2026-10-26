const units = ["B", "KB", "MB", "GB", "TB"] as const;
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1000)),
    units.length - 1,
  );
  const value = bytes / 1000 ** exponent;
  return exponent === 0
    ? `${Math.round(value)} ${units[exponent]}`
    : `${value.toFixed(2)} ${units[exponent]}`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "时间未知";
  }
  return dateFormatter.format(date);
}

export function fileNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function normalizeWindowsPath(path: string): string {
  const source = path.trim();
  if (!source) {
    return "";
  }

  const isUncPath = /^[\\/]{2}/.test(source);
  let normalized = source.replace(/[\\/]+/g, "\\");
  if (isUncPath && !normalized.startsWith("\\\\")) {
    normalized = `\\${normalized}`;
  }

  return /^[A-Za-z]:\\$/.test(normalized)
    ? normalized
    : normalized.replace(/\\+$/, "");
}

export function formatRelativePath(root: string, filePath: string): string {
  const normalizedRoot = normalizeWindowsPath(root);
  const normalizedFile = normalizeWindowsPath(filePath);
  if (!normalizedRoot || !normalizedFile) {
    return normalizedFile;
  }

  const rootPrefix = normalizedRoot.endsWith("\\")
    ? normalizedRoot
    : `${normalizedRoot}\\`;

  if (normalizedFile.toLocaleLowerCase("en-US").startsWith(
    rootPrefix.toLocaleLowerCase("en-US"),
  )) {
    return normalizedFile.slice(rootPrefix.length);
  }

  return normalizedFile;
}
