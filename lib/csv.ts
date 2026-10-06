/**
 * Small CSV reader and writer (RFC 4180): quoted fields, doubled quotes, newlines inside
 * quotes, CRLF or LF. Used for code-pool imports and the claimers export (RWD-02, ADM-06).
 */

/** Rows of fields. A leading byte-order mark is dropped; wholly blank lines are skipped. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawAny = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
    sawAny = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    sawAny = true;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") endField();
    else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") endRow();
    else field += c;
  }
  if (sawAny) endRow();
  return rows;
}

/**
 * One CSV cell. Cells that start with = + - @ (or a tab or CR) are prefixed with an apostrophe
 * so a spreadsheet shows them as text instead of running them as a formula.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header plus rows, CRLF-separated, with a byte-order mark so Excel reads UTF-8 accents. */
export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
