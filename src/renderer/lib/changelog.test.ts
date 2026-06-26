import { describe, expect, it } from 'vitest';
import { compareVersions, getChangelogSince, parseChangelog } from './changelog';

const SAMPLE = `# Changelog

## 0.8.7 — 2025-06-26

- Feature A
- Feature B

## 0.8.6 — 2025-06-20

- Feature C
`;

describe('compareVersions', () => {
  it('orders semver strings', () => {
    expect(compareVersions('0.8.7', '0.8.6')).toBeGreaterThan(0);
    expect(compareVersions('0.8.6', '0.8.7')).toBeLessThan(0);
    expect(compareVersions('0.8.7', '0.8.7')).toBe(0);
  });
});

describe('parseChangelog', () => {
  it('extracts version sections and bullet items', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      version: '0.8.7',
      date: '2025-06-26',
      items: ['Feature A', 'Feature B'],
    });
    expect(entries[1].version).toBe('0.8.6');
  });
});

describe('getChangelogSince', () => {
  it('returns only versions newer than the given one', () => {
    const entries = getChangelogSince('0.8.6', SAMPLE);
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('0.8.7');
  });

  it('returns all entries when sinceVersion is empty', () => {
    const entries = getChangelogSince('', SAMPLE);
    expect(entries).toHaveLength(2);
  });
});
