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

/** Ricava l'anno da una cella "Data Inizio Periodo" (formato gg/mm/aaaa). */
export function yearOf(row: InpsRow, column = 'Data Inizio Periodo'): number | null {
  const v = row[column];
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(DATE_RE);
  if (m) return Number(m[3]);
  // fallback: a volte è una stringa "2024 - Ottobre" ecc.
  const m2 = s.match(/(\d{4})/);
  return m2 ? Number(m2[1]) : null;
}

export function distinctYears(rows: InpsRow[], column = 'Data Inizio Periodo'): number[] {
  const set = new Set<number>();
  for (const r of rows) {
    const y = yearOf(r, column);
    if (y != null) set.add(y);
  }
  return Array.from(set).sort((a, b) => b - a);
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

export interface RowFilter {
  years?: Set<number>;        // se vuoto/undefined → tutti
  tipologie?: Set<string>;    // E0 / V1 — se vuoto → tutte
  yearColumn?: string;        // default 'Data Inizio Periodo'
}

export function filterRows(rows: InpsRow[], f: RowFilter): InpsRow[] {
  const yearCol = f.yearColumn ?? 'Data Inizio Periodo';
  return rows.filter(r => {
    if (f.years && f.years.size > 0) {
      const y = yearOf(r, yearCol);
      if (y == null || !f.years.has(y)) return false;
    }
    if (f.tipologie && f.tipologie.size > 0) {
      const t = r['Tipologia'];
      if (t == null || !f.tipologie.has(String(t))) return false;
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
