import type { Text } from "@codemirror/state";

export type ParsedPipeTable = {
  headers: string[];
  rows: string[][];
};

/**
 * Heuristic pipe-table ranges when the syntax tree has not produced `Table`
 * nodes yet (or misses an edge case). Lines are 1-based like `Text.line`.
 */
export function findPipeTableBlockRangesInDoc(doc: Text): { from: number; to: number }[] {
  const blocks: { from: number; to: number }[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const header = doc.line(i);
    if (!looksLikePipeTableHeaderLine(header.text)) continue;
    if (i + 1 > doc.lines) break;
    const delim = doc.line(i + 1);
    if (!isDelimiterRow(splitPipeRow(delim.text))) continue;
    let j = i + 2;
    while (j <= doc.lines && /^\s*\|/.test(doc.line(j).text)) j++;
    blocks.push({ from: header.from, to: doc.line(j - 1).to });
    i = j - 1;
  }
  return blocks;
}

function looksLikePipeTableHeaderLine(text: string): boolean {
  const t = text.trim();
  return t.includes("|") && /[^|\s:-]/.test(t);
}

/**
 * Parse a GFM-style pipe table block into headers + body rows.
 * Returns null if the block does not look like a valid pipe table.
 */
export function parseMarkdownPipeTableBlock(src: string): ParsedPipeTable | null {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const rows: string[] = [];
  for (const line of lines) {
    const t = line.replace(/\s+$/, "");
    if (t.length > 0) rows.push(t);
  }
  if (rows.length < 2) return null;
  if (!rows.every((l) => l.includes("|"))) return null;

  const headerCells = splitPipeRow(rows[0]);
  const delimCells = splitPipeRow(rows[1]);
  if (headerCells.length === 0 || !isDelimiterRow(delimCells)) return null;

  const colCount = headerCells.length;
  const body: string[][] = [];
  for (let i = 2; i < rows.length; i++) {
    const cells = splitPipeRow(rows[i]);
    const padded: string[] = [];
    for (let j = 0; j < colCount; j++) {
      padded.push(cells[j] ?? "");
    }
    body.push(padded);
  }

  return { headers: headerCells, rows: body };
}

/**
 * Parse a GFM-style pipe table block (as in the editor) into an HTML table.
 * Cell text supports `**bold**` spans; other content is plain text. Browser only.
 */
export function markdownTableBlockToHtmlTableElement(
  src: string,
): HTMLTableElement | null {
  const parsed = parseMarkdownPipeTableBlock(src);
  if (!parsed) return null;

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const thr = document.createElement("tr");
  for (const h of parsed.headers) {
    const th = document.createElement("th");
    appendTableCellInlineMd(th, h);
    thr.appendChild(th);
  }
  thead.appendChild(thr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of parsed.rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      appendTableCellInlineMd(td, cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/**
 * Render `**bold**` inside a table cell (preview widget only). Other markdown
 * stays plain text so we avoid XSS from HTML-like cell content.
 */
function appendTableCellInlineMd(el: HTMLElement, raw: string): void {
  const parts = raw.split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    const m = p.match(/^\*\*([^*]+)\*\*$/);
    if (m) {
      const strong = document.createElement("strong");
      strong.textContent = m[1]!;
      el.appendChild(strong);
    } else {
      el.appendChild(document.createTextNode(p));
    }
  }
}

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  if (!s.length) return [];
  return s.split("|").map((c) => c.trim());
}

/** GFM / @lezer/markdown: delimiter cells are `:---`, `---`, `-`, etc. */
function isDelimiterRow(cells: string[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((c) => {
    const t = c.replace(/\s+/g, "");
    return /^:?-+:?:?$/.test(t) && /-/.test(t);
  });
}
