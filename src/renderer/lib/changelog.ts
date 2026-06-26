import changelogMd from '../../../CHANGELOG.md?raw';

export interface ChangelogEntry {
  version: string;
  date?: string;
  items: string[];
}

/** Compare semver strings. Returns positive when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Parse `CHANGELOG.md` sections into structured entries (newest first). */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const lines = markdown.split(/\r?\n/);
  let current: ChangelogEntry | null = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(\d+\.\d+\.\d+)(?:\s*[—–-]\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
    if (heading) {
      if (current && current.items.length > 0) entries.push(current);
      current = { version: heading[1], date: heading[2], items: [] };
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet) current.items.push(bullet[1].trim());
  }

  if (current && current.items.length > 0) entries.push(current);
  return entries;
}

/** Entries newer than `sinceVersion`, preserving newest-first order. */
export function getChangelogSince(sinceVersion: string, markdown = changelogMd): ChangelogEntry[] {
  return parseChangelog(markdown).filter((e) => compareVersions(e.version, sinceVersion) > 0);
}

export { changelogMd };
