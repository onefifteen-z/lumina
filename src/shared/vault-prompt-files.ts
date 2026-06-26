/** Vault-root filenames tried for the chat system prompt (CLAUDE.md). */
export const CLAUDE_MD_CANDIDATES = [
  ".CLAUDE.md",
  "CLAUDE.md",
  ".claude.md",
  "claude.md",
] as const;

/** Vault-root filenames tried for the ingest extraction protocol (INGEST.md). */
export const INGEST_MD_CANDIDATES = [
  ".INGEST.md",
  "INGEST.md",
  ".ingest.md",
  "ingest.md",
] as const;

function basename(filename: string): string {
  return filename.split("/").pop() ?? filename;
}

function matchesCandidate(filename: string, candidates: readonly string[]): boolean {
  const base = basename(filename);
  const lower = base.toLowerCase();
  return candidates.some((c) => c.toLowerCase() === lower);
}

export function isClaudeMdFilename(filename: string): boolean {
  return matchesCandidate(filename, CLAUDE_MD_CANDIDATES);
}

export function isIngestMdFilename(filename: string): boolean {
  return matchesCandidate(filename, INGEST_MD_CANDIDATES);
}

/** Canonical vault-root filenames used when creating prompt config drafts. */
export type VaultPromptDraftFilename = "CLAUDE.md" | "INGEST.md";

export function isVaultPromptConfigFilename(filename: string): boolean {
  return isClaudeMdFilename(filename) || isIngestMdFilename(filename);
}

/** Map a vault-relative prompt path to the draft filename written on save. */
export function vaultPromptDraftFilename(filename: string): VaultPromptDraftFilename | null {
  if (isClaudeMdFilename(filename)) return "CLAUDE.md";
  if (isIngestMdFilename(filename)) return "INGEST.md";
  return null;
}

/** Title stem passed to `articleExists` before saving a new prompt draft. */
export function vaultPromptExistsTitle(draft: VaultPromptDraftFilename): string {
  return draft === "CLAUDE.md" ? "CLAUDE" : "INGEST";
}
