import type {
  RuntimeEntryStatus,
  SourceDirectory,
  SourceEntry,
} from "@shared/contracts";

export type EntryFilter =
  | "all"
  | "ready"
  | "done"
  | "unsupported"
  | "running"
  | "error";

export interface EntryOverride {
  status?: RuntimeEntryStatus;
  message?: string;
}

export function resolveEntryStatus(
  entry: SourceEntry,
  override?: EntryOverride,
): RuntimeEntryStatus {
  return override?.status ?? entry.resultStatus;
}

export function getStatusLabel(status: RuntimeEntryStatus): string {
  switch (status) {
    case "done":
      return "已完成";
    case "unsupported":
      return "不支持";
    case "running":
      return "处理中";
    case "error":
      return "失败";
    case "ready":
      return "待处理";
  }
}

export function formatDuration(durationSec: number): string {
  if (!Number.isFinite(durationSec)) {
    return "--";
  }

  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds
    .toFixed(1)
    .padStart(4, "0")}`;
}

export function formatSampleRate(sampleRate: number): string {
  if (sampleRate >= 1000) {
    return `${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`;
  }

  return `${sampleRate} Hz`;
}

export function formatKindLabel(kind: SourceEntry["kind"]): string {
  return kind.toUpperCase();
}

export function formatFriendlyStem(stem: string, maxLength = 30): string {
  if (stem.length <= maxLength) {
    return stem;
  }

  const prefix = Math.max(12, Math.floor(maxLength * 0.6));
  const suffix = Math.max(6, maxLength - prefix - 1);
  return `${stem.slice(0, prefix)}…${stem.slice(-suffix)}`;
}

function matchesFilter(status: RuntimeEntryStatus, filter: EntryFilter): boolean {
  if (filter === "all") {
    return true;
  }

  return status === filter;
}

function matchesSearch(entry: SourceEntry, searchTerm: string): boolean {
  if (!searchTerm) {
    return true;
  }

  const needle = searchTerm.toLowerCase();
  return (
    entry.stem.toLowerCase().includes(needle) ||
    entry.sourcePath.toLowerCase().includes(needle)
  );
}

export function filterDirectoryTree(
  directory: SourceDirectory,
  searchTerm: string,
  filter: EntryFilter,
  overrides: Map<string, EntryOverride>,
): SourceDirectory | null {
  const entries = directory.entries.filter((entry) => {
    const status = resolveEntryStatus(entry, overrides.get(entry.sourcePath));
    return matchesFilter(status, filter) && matchesSearch(entry, searchTerm);
  });
  const directories = directory.directories
    .map((child) => filterDirectoryTree(child, searchTerm, filter, overrides))
    .filter((child): child is SourceDirectory => Boolean(child));

  if (entries.length === 0 && directories.length === 0) {
    return null;
  }

  return {
    ...directory,
    entries,
    directories,
  };
}

export function flattenEntries(tree: SourceDirectory): SourceEntry[] {
  return [
    ...tree.entries,
    ...tree.directories.flatMap((directory) => flattenEntries(directory)),
  ];
}

export function collectDirectoryPaths(tree: SourceDirectory): string[] {
  return [
    tree.relativePath,
    ...tree.directories.flatMap((directory) => collectDirectoryPaths(directory)),
  ];
}

export function findDirectoryByRelativePath(
  tree: SourceDirectory,
  relativePath: string,
): SourceDirectory | null {
  if (tree.relativePath === relativePath) {
    return tree;
  }

  for (const child of tree.directories) {
    const match = findDirectoryByRelativePath(child, relativePath);
    if (match) {
      return match;
    }
  }

  return null;
}
