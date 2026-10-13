/** Minimal RFC 4180 reader/writer. The raw dataset has no quoted fields, but the simulated
 *  QUERY_TAG column is JSON, so the writer must quote and the reader must cope with it. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsvObjects(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])));
}

/** `null`/`undefined` become an empty unquoted field, which both DuckDB and Snowflake read as NULL. */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  // Hot path for the simulator (millions of fields): only pay for quoting when it is needed.
  if (
    value.indexOf('"') === -1 &&
    value.indexOf(',') === -1 &&
    value.indexOf('\n') === -1 &&
    value.indexOf('\r') === -1
  ) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function csvLine(values: (string | number | null | undefined)[]): string {
  return values.map(csvField).join(',');
}
