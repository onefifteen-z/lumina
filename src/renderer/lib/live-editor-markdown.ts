/**
 * Normalize markdown produced by the inline WYSIWYG editor before persisting
 * or running it through the same remark pipeline as the reader preview.
 */
export function normalizeLiveMarkdownForVault(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}
