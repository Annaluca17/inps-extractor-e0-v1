import { read, utils, writeFileXLSX } from 'xlsx';

export type InpsRow = Record<string, string | number | null>;

// Mappa colonne reale del file PASSWEB "Elenco Quadri E0 e V1".
// Chiave = nome esatto colonna nel file INPS, valore = etichetta breve.
export const E0V1_MAP: Record<string, string> = {
  'Codice fiscale': 'CF',
  'Data Inizio Periodo': 'DT_INIZ',
  'Data Fine Periodo': 'DT_FINE',
  'Tipologia': 'TIPO',
  'Tipo impiego': 'TIPO_IMP',
  'Tipo Servizio': 'TIPO_SERV',
  'Causale Variazione': 'CAUS_VAR',
  'Correnti, obsoleti, …': 'STATO',
  'Denuncia': 'DENUNCIA',
  'Ente Dichiarante in Anagrafica': 'ENTE',
  'Imponibile': 'IMP',
  'Totale Contributi': 'CONTR_TOT',
  'Presenza Errori Gravi': 'ERR_GRAVI',
  'Imponibile TFS': 'IMP_TFS',
  'Contributo TFS': 'CONTR_TFS',
  'Contributo Credito': 'CONTR_CRED',
  'Codice Motivo Cessazione': 'COD_CESS',
  'Stipendio tabellare': 'STIP_TAB',
  'Qualifica': 'QUALIF',
};

// Colonne selezionate di default (sottoinsieme utile per analisi).
export const DEFAULT_COLUMNS: string[] = Object.keys(E0V1_MAP);

export interface ParseResult {
  rows: InpsRow[];
  columns: string[];
  headerRowIndex: number;
  warnings: string[];
}

/**
 * Trova la riga delle intestazioni reali: la prima riga che contiene
 * sia "Codice fiscale" sia "Data Inizio Periodo". I file PASSWEB hanno
 * 3 righe di metadati (titolo, data export, riga vuota) prima dell'header.
 */
function detectHeaderRow(matrix: unknown[][]): number {
  for (let i = 0; i < Math.min(matrix.length, 20); i++) {
    const row = matrix[i] ?? [];
    const cells = row.map(c => (c == null ? '' : String(c).trim()));
    const hasCF = cells.includes('Codice fiscale');
    const hasInizio = cells.includes('Data Inizio Periodo');
    if (hasCF && hasInizio) return i;
  }
  return 0;
}

export function parseInpsWorkbook(buffer: ArrayBuffer): ParseResult {
  const wb = read(buffer, { type: 'array' });
  const wsName = wb.SheetNames[0];
  const ws = wb.Sheets[wsName];

  const matrix = utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, blankrows: false });
  if (matrix.length === 0) {
    return { rows: [], columns: [], headerRowIndex: 0, warnings: ['File vuoto.'] };
  }

  const headerRowIndex = detectHeaderRow(matrix);
  const headerRaw = (matrix[headerRowIndex] ?? []) as unknown[];
  const columns = headerRaw.map((c, i) => (c == null || String(c).trim() === '' ? `col_${i}` : String(c).trim()));

  const rows: InpsRow[] = [];
  for (let i = headerRowIndex + 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    if (row.every(c => c == null || String(c).trim() === '')) continue;
    const obj: InpsRow = {};
    for (let j = 0; j < columns.length; j++) {
      const v = row[j];
      obj[columns[j]] = (v as string | number | null) ?? null;
    }
    rows.push(obj);
  }

  const warnings: string[] = [];
  const missing = Object.keys(E0V1_MAP).filter(k => !columns.includes(k));
  if (missing.length > 0) {
    warnings.push('Colonne mappate non trovate nel file: ' + missing.join(', '));
  }

  return { rows, columns, headerRowIndex, warnings };
}

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Ricava anno+mese da una cella "Data Inizio Periodo" (formato gg/mm/aaaa). */
export function yearMonthOf(row: InpsRow, column = 'Data Inizio Periodo'): { year: number; month: number } | null {
  const v = row[column];
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(DATE_RE);
  if (m) return { year: Number(m[3]), month: Number(m[2]) };
  // fallback: stringhe come "2024 - Ottobre"
  const m2 = s.match(/(\d{4})/);
  if (m2) return { year: Number(m2[1]), month: 1 };
  return null;
}

export function yearOf(row: InpsRow, column = 'Data Inizio Periodo'): number | null {
  return yearMonthOf(row, column)?.year ?? null;
}

/** Codifica anno+mese come intero AAAA*100 + MM, comodo per confronti. */
export function ymKey(year: number, month: number): number {
  return year * 100 + month;
}

export function distinctYears(rows: InpsRow[], column = 'Data Inizio Periodo'): number[] {
  const set = new Set<number>();
  for (const r of rows) {
    const y = yearOf(r, column);
    if (y != null) set.add(y);
  }
  return Array.from(set).sort((a, b) => b - a);
}

/** Restituisce gli anni+mese distinti presenti, ordinati dal più recente. */
export function distinctYearMonths(rows: InpsRow[], column = 'Data Inizio Periodo'): { year: number; month: number }[] {
  const seen = new Set<number>();
  const out: { year: number; month: number }[] = [];
  for (const r of rows) {
    const ym = yearMonthOf(r, column);
    if (!ym) continue;
    const k = ymKey(ym.year, ym.month);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ym);
  }
  out.sort((a, b) => ymKey(b.year, b.month) - ymKey(a.year, a.month));
  return out;
}

export function distinctValues(rows: InpsRow[], column: string): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r[column];
    if (v == null || String(v).trim() === '') continue;
    set.add(String(v));
  }
  return Array.from(set).sort();
}

export interface YearMonth { year: number; month: number }

export interface RowFilter {
  /** Estremo inferiore (incluso) per Data Inizio Periodo. */
  from?: YearMonth;
  /** Estremo superiore (incluso) per Data Inizio Periodo. */
  to?: YearMonth;
  tipologie?: Set<string>;    // E0 / V1 — se vuoto → tutte
  stati?: Set<string>;        // Corrente / Spento / Obsoleto — se vuoto → tutti
  yearColumn?: string;        // default 'Data Inizio Periodo'
  statoColumn?: string;       // default 'Correnti, obsoleti, …'
}

export function filterRows(rows: InpsRow[], f: RowFilter): InpsRow[] {
  const yearCol = f.yearColumn ?? 'Data Inizio Periodo';
  const statoCol = f.statoColumn ?? 'Correnti, obsoleti, …';
  const fromK = f.from ? ymKey(f.from.year, f.from.month) : null;
  const toK = f.to ? ymKey(f.to.year, f.to.month) : null;
  return rows.filter(r => {
    if (fromK != null || toK != null) {
      const ym = yearMonthOf(r, yearCol);
      if (!ym) return false;
      const k = ymKey(ym.year, ym.month);
      if (fromK != null && k < fromK) return false;
      if (toK != null && k > toK) return false;
    }
    if (f.tipologie && f.tipologie.size > 0) {
      const t = r['Tipologia'];
      if (t == null || !f.tipologie.has(String(t))) return false;
    }
    if (f.stati && f.stati.size > 0) {
      const s = r[statoCol];
      if (s == null || !f.stati.has(String(s))) return false;
    }
    return true;
  });
}

export function exportXlsx(rows: InpsRow[], columns: string[], filename: string) {
  const data = rows.map(row => {
    const obj: Record<string, string | number | null> = {};
    for (const c of columns) {
      const label = E0V1_MAP[c] ? `${E0V1_MAP[c]} (${c})` : c;
      obj[label] = row[c] ?? '';
    }
    return obj;
  });
  const ws = utils.json_to_sheet(data);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Quadri E0-V1');
  writeFileXLSX(wb, filename);
}

/** Colonne sommate nei subtotali per anno (se selezionate). */
export const SUBTOTAL_COLUMNS: string[] = [
  'Imponibile',
  'Totale Contributi',
  'Imponibile TFS',
  'Imponibile TFR',
  'Imponibile TFR Accordo Quadro',
  'Contributo TFR Accordo Quadro',
  'Contributo TFR',
  'Contributo TFS',
  'Contributo Credito',
];

export interface GroupedRow {
  kind: 'data' | 'subtotal';
  year?: number;     // valorizzato per le righe di subtotale
  row: InpsRow;
}

function toNumber(v: string | number | null): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Divide le righe per anno (Data Inizio Periodo) e inserisce una riga di
 * subtotale dopo ogni gruppo. I subtotali sommano solo le colonne presenti
 * sia in SUBTOTAL_COLUMNS sia in `columns` (colonne attive nell'export).
 * Le righe con anno non determinabile finiscono in coda senza subtotale.
 */
export function groupByYearWithSubtotals(rows: InpsRow[], columns: string[]): GroupedRow[] {
  const groups = new Map<number, InpsRow[]>();
  const noYear: InpsRow[] = [];
  for (const r of rows) {
    const y = yearOf(r);
    if (y == null) { noYear.push(r); continue; }
    let arr = groups.get(y);
    if (!arr) { arr = []; groups.set(y, arr); }
    arr.push(r);
  }
  const years = Array.from(groups.keys()).sort((a, b) => a - b);
  const labelCol = columns.includes('Data Inizio Periodo')
    ? 'Data Inizio Periodo'
    : (columns[0] ?? 'Subtotale');
  const sumCols = SUBTOTAL_COLUMNS.filter(c => columns.includes(c));

  const out: GroupedRow[] = [];
  for (const y of years) {
    const yearRows = groups.get(y)!;
    for (const r of yearRows) out.push({ kind: 'data', row: r });
    const sub: InpsRow = {};
    for (const c of columns) sub[c] = null;
    sub[labelCol] = `Subtotale ${y}`;
    for (const c of sumCols) {
      let sum = 0;
      let any = false;
      for (const r of yearRows) {
        const n = toNumber(r[c]);
        if (n != null) { sum += n; any = true; }
      }
      sub[c] = any ? Math.round(sum * 100) / 100 : null;
    }
    out.push({ kind: 'subtotal', year: y, row: sub });
  }
  for (const r of noYear) out.push({ kind: 'data', row: r });
  return out;
}

export function exportXlsxGrouped(grouped: GroupedRow[], columns: string[], filename: string) {
  const data = grouped.map(g => {
    const obj: Record<string, string | number | null> = {};
    for (const c of columns) {
      const label = E0V1_MAP[c] ? `${E0V1_MAP[c]} (${c})` : c;
      obj[label] = g.row[c] ?? '';
    }
    return obj;
  });
  const ws = utils.json_to_sheet(data);
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, 'Quadri E0-V1');
  writeFileXLSX(wb, filename);
}
