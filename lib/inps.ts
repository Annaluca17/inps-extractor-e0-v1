/**
 * Core di parsing e selezione per i file INPS PASSWEB "Elenco Quadri E0 e V1".
 *
 * Regola architetturale — nata dal bug di off-by-one riscontrato ad agosto 2026,
 * dove l'export applicava il predicato alla riga i e scriveva la riga i+1
 * (prima riga persa, righe Obsolete/Annullate promosse al posto delle Correnti,
 * ultima riga duplicata):
 *
 *   1. Nessuna selezione avviene per indice numerico. Le righe sono oggetti
 *      immutabili con identità stabile (`__id` = riga Excel di origine).
 *   2. Ogni filtro produce una PARTIZIONE dell'input: tenute + escluse-con-motivo.
 *      `assertPartition` verifica che nulla si perda, si duplichi o cambi ordine.
 *   3. L'export rilegge il foglio appena costruito e lo confronta cella per cella
 *      con la matrice sorgente (`assertRoundTrip`).
 *
 * Se un'invariante salta l'app lancia `IntegrityError` e si ferma: meglio un
 * errore visibile che un file di export silenziosamente sbagliato.
 */
import { read, utils, writeFileXLSX, type WorkBook, type WorkSheet } from 'xlsx';

export type Cell = string | number | null;

/** Riga di un foglio INPS. Immutabile e dotata di identità stabile. */
export interface InpsRow {
  /** Numero della riga nel foglio Excel di origine (1-based). Mai un indice di array. */
  readonly __id: number;
  /** Nome del foglio di provenienza. */
  readonly __sheet: string;
  readonly cells: Readonly<Record<string, Cell>>;
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

// ---------------------------------------------------------------------------
// Mappa colonne
// ---------------------------------------------------------------------------

/**
 * Colonne principali del tracciato E0/V1, con la sigla storica.
 *
 * Le sigle non vengono più usate come intestazione — né a schermo né
 * nell'export, dove vale il nome originale del file. La mappa resta perché
 * definisce quali sono le colonne principali (`DEFAULT_COLUMNS`, la selezione
 * rapida) e quali segnalare se mancano dal foglio.
 */
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

export const DEFAULT_COLUMNS: string[] = Object.keys(E0V1_MAP);

/** Colonne sommate nei subtotali per anno, quando selezionate. */
export const SUBTOTAL_COLUMNS: string[] = [
  'Imponibile',
  'Totale Contributi',
  'Imponibile TFS',
  'Contributo TFS',
  'Imponibile TFR',
  'Contributo TFR',
  'Imponibile TFR Accordo Quadro',
  'Contributo TFR Accordo Quadro',
  'Contributo Credito',
];

// Nomi canonici usati dai filtri. Risolti in modo tollerante: INPS cambia
// spesso punteggiatura e troncature nelle intestazioni.
export const COL_CF = ['Codice fiscale', 'Iscritto'];
export const COL_DATA_INIZIO = ['Data Inizio Periodo'];
export const COL_DATA_FINE = ['Data Fine Periodo'];
export const COL_TIPOLOGIA = ['Tipologia'];
export const COL_STATO = ['Correnti, obsoleti, …', 'Correnti, obsoleti', 'Stato'];
export const COL_CESSAZIONE = ['Codice Motivo Cessazione'];

// ---------------------------------------------------------------------------
// Normalizzazione e risoluzione colonne
// ---------------------------------------------------------------------------

/** Forma canonica di un'intestazione: niente ellissi, punteggiatura, maiuscole. */
export function normalizeHeader(s: string): string {
  return s
    .replace(/…/g, ' ')
    .replace(/\.\.\./g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Trova nel foglio la colonna corrispondente a uno dei nomi candidati.
 * Prima match esatto, poi normalizzato, poi prefisso (INPS tronca a 30 caratteri).
 * Restituisce `null` se non esiste: i chiamanti devono gestirlo esplicitamente,
 * mai assumere che la colonna ci sia.
 */
export function resolveColumn(columns: readonly string[], candidates: readonly string[]): string | null {
  for (const c of candidates) {
    if (columns.includes(c)) return c;
  }
  const norm = new Map<string, string>();
  for (const col of columns) {
    const k = normalizeHeader(col);
    if (!norm.has(k)) norm.set(k, col);
  }
  for (const c of candidates) {
    const hit = norm.get(normalizeHeader(c));
    if (hit) return hit;
  }
  // Terzo tentativo: PASSWEB tronca le intestazioni a 30 caratteri. Il prefisso
  // comune deve essere lungo almeno 8 caratteri, altrimenti nomi brevi
  // produrrebbero corrispondenze casuali.
  const entries = Array.from(norm.entries());
  for (const c of candidates) {
    const target = normalizeHeader(c);
    for (const [k, col] of entries) {
      if (Math.min(k.length, target.length) < 8) continue;
      if (k.startsWith(target) || target.startsWith(k)) return col;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Accesso ai valori
// ---------------------------------------------------------------------------

export function cellOf(row: InpsRow, column: string | null): Cell {
  if (!column) return null;
  const v = row.cells[column];
  return v === undefined ? null : v;
}

export function textOf(row: InpsRow, column: string | null): string {
  const v = cellOf(row, column);
  return v == null ? '' : String(v).trim();
}

/** Converte in numero gestendo sia "1234.56" sia "1.234,56". */
export function toNumber(v: Cell): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = v.replace(/[\s €]/g, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function numberOf(row: InpsRow, column: string | null): number | null {
  return toNumber(cellOf(row, column));
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

export interface YearMonth {
  year: number;
  month: number;
}

export const MONTH_NAMES = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];

const MONTH_INDEX: Record<string, number> = MONTH_NAMES.reduce((acc, name, i) => {
  acc[name.toLowerCase()] = i + 1;
  return acc;
}, {} as Record<string, number>);

const DMY_RE = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/;
const YMD_RE = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/;
const YEAR_MONTH_NAME_RE = /^(\d{4})\s*[-–]?\s*([A-Za-zàèéìòù]+)$/;

/** Data completa. `day` vale 1 per i formati che indicano solo anno e mese. */
export interface DateParts extends YearMonth {
  day: number;
}

/** Seriale Excel → data. Epoca 1899-12-30 (sistema 1900 con il bug del 1900). */
function fromExcelSerial(serial: number): DateParts | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const ms = Math.round(serial) * 86400000;
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Estrae la data da una cella. Gestisce gg/mm/aaaa, aaaa-mm-gg,
 * "2024 - Ottobre", "2014-Settembre", oggetti Date e seriali Excel.
 */
export function parseDate(v: Cell): DateParts | null {
  if (v == null) return null;
  if (typeof v === 'number') return fromExcelSerial(v);
  const s = String(v).trim();
  if (s === '') return null;

  const dmy = s.match(DMY_RE);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }

  const ymd = s.match(YMD_RE);
  if (ymd) {
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year: Number(ymd[1]), month, day };
  }

  const named = s.match(YEAR_MONTH_NAME_RE);
  if (named) {
    const month = MONTH_INDEX[named[2].toLowerCase()];
    if (month) return { year: Number(named[1]), month, day: 1 };
  }

  if (/^\d+(\.\d+)?$/.test(s)) {
    const asSerial = fromExcelSerial(Number(s));
    if (asSerial) return asSerial;
  }

  return null;
}

export function parseYearMonth(v: Cell): YearMonth | null {
  const d = parseDate(v);
  return d ? { year: d.year, month: d.month } : null;
}

export function ymKey(ym: YearMonth): number {
  return ym.year * 100 + ym.month;
}

/** Chiave ordinabile aaaammgg. */
export function dateKey(d: DateParts): number {
  return d.year * 10000 + d.month * 100 + d.day;
}

export function formatYearMonth(ym: YearMonth): string {
  return `${MONTH_NAMES[ym.month - 1] ?? '?'} ${ym.year}`;
}

export function yearMonthOfRow(row: InpsRow, column: string | null): YearMonth | null {
  return parseYearMonth(cellOf(row, column));
}

// ---------------------------------------------------------------------------
// Parsing del workbook
// ---------------------------------------------------------------------------

export interface SheetData {
  name: string;
  columns: string[];
  rows: InpsRow[];
  /** Riga Excel (1-based) che contiene le intestazioni. */
  headerExcelRow: number;
  /** Righe completamente vuote saltate fra i dati. */
  blankRowsSkipped: number;
}

export interface ParsedWorkbook {
  sheets: SheetData[];
  quadri: SheetData | null;
  sgravi: SheetData | null;
  altroEnte: SheetData | null;
  warnings: string[];
}

const HEADER_HINTS = [
  'codice fiscale', 'iscritto', 'data inizio periodo', 'data fine periodo',
  'tipologia', 'denuncia', 'imponibile', 'totale contributi', 'sgravio',
  'protocollo', 'cassa pensionistica',
];

/**
 * Individua la riga di intestazione: quella con più corrispondenze fra i nomi
 * noti. I file PASSWEB hanno 2-3 righe di metadati e, in alcuni fogli, una riga
 * di intestazioni di gruppo ("Sezione Sgravi", "Gestione") sopra quella vera.
 */
function detectHeaderRow(matrix: readonly Cell[][]): number {
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(matrix.length, 25);
  for (let i = 0; i < limit; i++) {
    const cells = (matrix[i] ?? []).map(c => (c == null ? '' : normalizeHeader(String(c))));
    let score = 0;
    for (const hint of HEADER_HINTS) {
      if (cells.some(c => c === hint || c.startsWith(hint))) score++;
    }
    // Strettamente maggiore: a parità vince la riga più in alto. Le righe di
    // intestazione di gruppo ("Sezione Sgravi", "Gestione") non contengono nomi
    // noti e restano sotto soglia, quindi non vengono mai scelte.
    if (score > bestScore && score >= 3) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Rende univoci i nomi di colonna duplicati, così nessun valore viene sovrascritto. */
function uniqueColumnNames(raw: readonly Cell[]): string[] {
  const used = new Map<string, number>();
  return raw.map((c, i) => {
    const base = c == null || String(c).trim() === '' ? `col_${i + 1}` : String(c).trim();
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base} (${seen + 1})`;
  });
}

function isBlankRow(row: readonly Cell[] | undefined): boolean {
  if (!row) return true;
  return row.every(c => c == null || String(c).trim() === '');
}

function parseSheet(ws: WorkSheet, name: string): SheetData | null {
  const ref = ws['!ref'];
  if (!ref) return null;
  const range = utils.decode_range(ref);
  // blankrows:true è obbligatorio: mantiene la corrispondenza 1:1 fra indice di
  // array e riga Excel, così `__id` è sempre il numero di riga reale.
  const matrix = utils.sheet_to_json<Cell[]>(ws, { header: 1, defval: null, blankrows: true });
  const firstExcelRow = range.s.r + 1;

  const headerIdx = detectHeaderRow(matrix);
  if (headerIdx < 0) return null;

  const columns = uniqueColumnNames(matrix[headerIdx] ?? []);
  const rows: InpsRow[] = [];
  let blankRowsSkipped = 0;

  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const raw = matrix[i];
    if (isBlankRow(raw)) {
      blankRowsSkipped++;
      continue;
    }
    const cells: Record<string, Cell> = {};
    for (let j = 0; j < columns.length; j++) {
      const v = raw?.[j];
      cells[columns[j]] = v === undefined ? null : v;
    }
    rows.push(Object.freeze({
      __id: firstExcelRow + i,
      __sheet: name,
      cells: Object.freeze(cells),
    }));
  }

  return {
    name,
    columns,
    rows,
    headerExcelRow: firstExcelRow + headerIdx,
    blankRowsSkipped,
  };
}

function hasColumn(sheet: SheetData, candidates: readonly string[]): boolean {
  return resolveColumn(sheet.columns, candidates) !== null;
}

export function parseInpsWorkbook(buffer: ArrayBuffer): ParsedWorkbook {
  const wb = read(buffer, { type: 'array' });
  const sheets: SheetData[] = [];
  const warnings: string[] = [];

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const parsed = parseSheet(ws, name);
    if (parsed && parsed.rows.length > 0) sheets.push(parsed);
    else if (!parsed) warnings.push(`Foglio "${name}": intestazioni non riconosciute, ignorato.`);
  }

  const sgravi = sheets.find(s => hasColumn(s, ['Sgravio'])) ?? null;
  const altroEnte = sheets.find(s => hasColumn(s, ['Ente Versante Dichiarato', 'Tipo Contributo'])) ?? null;
  const quadri = sheets.find(s =>
    s !== sgravi && s !== altroEnte &&
    hasColumn(s, COL_DATA_INIZIO) && hasColumn(s, COL_TIPOLOGIA)) ?? null;

  if (!quadri) {
    warnings.push('Nessun foglio "Quadri E0 e V1" riconosciuto nel file.');
  } else {
    const missing = Object.keys(E0V1_MAP).filter(k => resolveColumn(quadri.columns, [k]) === null);
    if (missing.length > 0) {
      warnings.push(`Colonne mappate non presenti nel foglio "${quadri.name}": ${missing.join(', ')}.`);
    }
    if (quadri.blankRowsSkipped > 0) {
      warnings.push(`Foglio "${quadri.name}": ${quadri.blankRowsSkipped} righe vuote ignorate.`);
    }
  }

  return { sheets, quadri, sgravi, altroEnte, warnings };
}

// ---------------------------------------------------------------------------
// Selezione righe — con invarianti
// ---------------------------------------------------------------------------

export type RowPredicate = (row: InpsRow) => boolean;

export interface Exclusion {
  row: InpsRow;
  /** Motivo leggibile: mostrato in UI, mai una riga sparisce in silenzio. */
  reason: string;
}

export interface Partition {
  kept: InpsRow[];
  excluded: Exclusion[];
}

/**
 * Verifica che `kept` + `excluded` siano esattamente l'input, nello stesso
 * ordine, senza duplicati e senza righe estranee. È il controllo che avrebbe
 * intercettato immediatamente lo shift di una riga.
 */
export function assertPartition(input: readonly InpsRow[], part: Partition): void {
  const total = part.kept.length + part.excluded.length;
  if (total !== input.length) {
    throw new IntegrityError(
      `Partizione incoerente: ${input.length} righe in ingresso, ${part.kept.length} tenute + ${part.excluded.length} escluse = ${total}.`,
    );
  }

  const source = new Set<InpsRow>(input);
  const seen = new Set<number>();

  const check = (row: InpsRow, where: string) => {
    if (!source.has(row)) {
      throw new IntegrityError(`Riga ${row.__id} in "${where}" non proviene dall'insieme di partenza.`);
    }
    if (seen.has(row.__id)) {
      throw new IntegrityError(`Riga ${row.__id} presente più di una volta nel risultato.`);
    }
    seen.add(row.__id);
  };

  for (const row of part.kept) check(row, 'tenute');
  for (const ex of part.excluded) check(ex.row, 'escluse');

  // L'ordine di `kept` deve essere una sottosequenza dell'input.
  let cursor = 0;
  for (const row of part.kept) {
    while (cursor < input.length && input[cursor] !== row) cursor++;
    if (cursor === input.length) {
      throw new IntegrityError(`Riga ${row.__id} fuori ordine rispetto al foglio di origine.`);
    }
    cursor++;
  }
}

/**
 * Filtro con motivazione. `classify` restituisce `null` per tenere la riga
 * oppure il motivo dell'esclusione. La riga valutata è sempre la stessa che
 * finisce nel risultato: nessun indice, nessuno scostamento possibile.
 */
export function partitionRows(
  rows: readonly InpsRow[],
  classify: (row: InpsRow) => string | null,
): Partition {
  const kept: InpsRow[] = [];
  const excluded: Exclusion[] = [];
  for (const row of rows) {
    const reason = classify(row);
    if (reason === null) kept.push(row);
    else excluded.push({ row, reason });
  }
  const part = { kept, excluded };
  assertPartition(rows, part);
  return part;
}

// ---------------------------------------------------------------------------
// Ordinamento — con invariante di permutazione
// ---------------------------------------------------------------------------

export type SortDirection = 'desc' | 'asc';

/**
 * Un riordino deve essere una permutazione: stesse righe, stessi oggetti,
 * nessuna persa, nessuna duplicata. Vale per il sort la stessa regola del
 * filtro — cambia l'ordine, mai il contenuto.
 */
export function assertPermutation(input: readonly InpsRow[], output: readonly InpsRow[]): void {
  if (input.length !== output.length) {
    throw new IntegrityError(
      `Ordinamento: ${input.length} righe in ingresso, ${output.length} in uscita.`,
    );
  }
  const source = new Set<InpsRow>(input);
  const seen = new Set<number>();
  for (const row of output) {
    if (!source.has(row)) {
      throw new IntegrityError(`Ordinamento: riga ${row.__id} estranea all'insieme di partenza.`);
    }
    if (seen.has(row.__id)) {
      throw new IntegrityError(`Ordinamento: riga ${row.__id} duplicata.`);
    }
    seen.add(row.__id);
  }
}

/**
 * Ordina per Data Inizio Periodo e, a parità, per Data Fine Periodo.
 * Le righe con data inizio non interpretabile finiscono sempre in coda,
 * qualunque sia la direzione, così non si mescolano ai dati validi.
 * L'ordinamento è stabile: a parità di chiave resta l'ordine del file.
 */
export function sortByPeriod(
  rows: readonly InpsRow[],
  startColumn: string | null,
  endColumn: string | null,
  direction: SortDirection,
): InpsRow[] {
  const sign = direction === 'desc' ? -1 : 1;
  const decorated = rows.map((row, index) => {
    const start = parseDate(cellOf(row, startColumn));
    const end = parseDate(cellOf(row, endColumn));
    return {
      row,
      index,
      start: start ? dateKey(start) : null,
      end: end ? dateKey(end) : null,
    };
  });

  decorated.sort((a, b) => {
    if (a.start == null && b.start == null) return a.index - b.index;
    if (a.start == null) return 1;
    if (b.start == null) return -1;
    if (a.start !== b.start) return sign * (a.start - b.start);
    const ae = a.end ?? 0;
    const be = b.end ?? 0;
    if (ae !== be) return sign * (ae - be);
    return a.index - b.index;
  });

  const out = decorated.map(d => d.row);
  assertPermutation(rows, out);
  return out;
}

// ---------------------------------------------------------------------------
// Filtri sui quadri
// ---------------------------------------------------------------------------

export interface QuadriFilter {
  from?: YearMonth | null;
  to?: YearMonth | null;
  tipologie?: ReadonlySet<string>;
  stati?: ReadonlySet<string>;
  /**
   * Filtri per colonna, in stile filtro automatico di Excel: colonna → valori
   * ammessi. Un insieme vuoto equivale a nessun filtro su quella colonna.
   */
  columnFilters?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Righe escluse a mano dall'operatore, per numero di riga del file.
   *
   * I filtri ragionano per valore e non bastano: un doppione da scartare e la
   * riga buona possono avere lo stesso stato e lo stesso periodo. L'esclusione
   * puntuale passa comunque da `partitionRows`, quindi finisce nel registro
   * con il suo motivo e resta soggetta alle stesse invarianti.
   */
  escluseManuali?: ReadonlySet<number>;
}

export interface QuadriColumns {
  data: string | null;
  dataFine: string | null;
  tipologia: string | null;
  stato: string | null;
  cessazione: string | null;
}

export function resolveQuadriColumns(columns: readonly string[]): QuadriColumns {
  return {
    data: resolveColumn(columns, COL_DATA_INIZIO),
    dataFine: resolveColumn(columns, COL_DATA_FINE),
    tipologia: resolveColumn(columns, COL_TIPOLOGIA),
    stato: resolveColumn(columns, COL_STATO),
    cessazione: resolveColumn(columns, COL_CESSAZIONE),
  };
}

export interface FilterResult extends Partition {
  warnings: string[];
}

/**
 * Applica i filtri di riga. Un criterio la cui colonna non esiste nel file
 * viene ignorato con un avviso: mai svuotare l'estrazione in silenzio.
 */
export function filterQuadri(
  rows: readonly InpsRow[],
  cols: QuadriColumns,
  filter: QuadriFilter,
): FilterResult {
  const warnings: string[] = [];

  const wantPeriod = Boolean(filter.from || filter.to);
  const wantTipologia = Boolean(filter.tipologie && filter.tipologie.size > 0);
  const wantStato = Boolean(filter.stati && filter.stati.size > 0);

  if (wantPeriod && !cols.data) {
    warnings.push('Filtro periodo ignorato: colonna "Data Inizio Periodo" assente.');
  }
  if (wantTipologia && !cols.tipologia) {
    warnings.push('Filtro tipologia ignorato: colonna "Tipologia" assente.');
  }
  if (wantStato && !cols.stato) {
    warnings.push('Filtro stato ignorato: colonna "Correnti, obsoleti, …" assente.');
  }

  // Solo i filtri colonna con almeno un valore ammesso sono vincolanti: un
  // insieme vuoto significherebbe "nessuna riga passa", che non è mai ciò che
  // l'utente intende. Le righe condividono per costruzione le stesse chiavi.
  const knownColumns = new Set(rows.length > 0 ? Object.keys(rows[0].cells) : []);
  const requested = Array.from(filter.columnFilters?.entries() ?? [])
    .filter(([, allowed]) => allowed.size > 0);
  const activeColumnFilters = requested.filter(([column]) => knownColumns.has(column));
  const ignored = requested.filter(([column]) => !knownColumns.has(column)).map(([column]) => column);
  if (ignored.length > 0) {
    warnings.push(`Filtri di colonna ignorati, colonne assenti nel foglio: ${ignored.join(', ')}.`);
  }

  const fromK = filter.from ? ymKey(filter.from) : null;
  const toK = filter.to ? ymKey(filter.to) : null;

  const part = partitionRows(rows, row => {
    // Prima di ogni criterio: la scelta esplicita dell'operatore prevale, e
    // deve restare leggibile nel registro come tale.
    if (filter.escluseManuali?.has(row.__id)) return 'esclusa a mano dall\'operatore';
    if (wantPeriod && cols.data) {
      const ym = yearMonthOfRow(row, cols.data);
      if (!ym) return 'data inizio periodo non interpretabile';
      const k = ymKey(ym);
      if (fromK != null && k < fromK) return `periodo precedente a ${formatYearMonth(filter.from!)}`;
      if (toK != null && k > toK) return `periodo successivo a ${formatYearMonth(filter.to!)}`;
    }
    if (wantTipologia && cols.tipologia) {
      const t = textOf(row, cols.tipologia);
      if (!filter.tipologie!.has(t)) return `tipologia "${t || '(vuota)'}" non selezionata`;
    }
    if (wantStato && cols.stato) {
      const s = textOf(row, cols.stato);
      if (!filter.stati!.has(s)) return `stato "${s || '(vuoto)'}" non selezionato`;
    }
    for (const [column, allowed] of activeColumnFilters) {
      const v = textOf(row, column);
      if (!allowed.has(v)) return `${column}: "${v || '(vuoto)'}" non selezionato`;
    }
    return null;
  });

  return { ...part, warnings };
}

// ---------------------------------------------------------------------------
// Valori distinti
// ---------------------------------------------------------------------------

/**
 * Quanti valori non vuoti ha ciascuna colonna. Serve a preselezionare le
 * colonne popolate e a lasciar spente quelle che nel file sono vuote: nei
 * tracciati PASSWEB una buona parte delle 115 colonne non è mai valorizzata.
 */
export function columnValueCounts(
  rows: readonly InpsRow[],
  columns: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of columns) counts.set(c, 0);
  for (const row of rows) {
    for (const c of columns) {
      const v = row.cells[c];
      if (v == null) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return counts;
}

/** Colonne con almeno un valore, nell'ordine del foglio. */
export function nonEmptyColumns(rows: readonly InpsRow[], columns: readonly string[]): string[] {
  const counts = columnValueCounts(rows, columns);
  return columns.filter(c => (counts.get(c) ?? 0) > 0);
}

export function distinctValues(rows: readonly InpsRow[], column: string | null): string[] {
  if (!column) return [];
  const set = new Set<string>();
  for (const row of rows) {
    const v = textOf(row, column);
    if (v !== '') set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'it'));
}

export function distinctYears(rows: readonly InpsRow[], column: string | null): number[] {
  const set = new Set<number>();
  for (const row of rows) {
    const ym = yearMonthOfRow(row, column);
    if (ym) set.add(ym.year);
  }
  return Array.from(set).sort((a, b) => b - a);
}

/** Anni+mese distinti, dal più recente. */
export function distinctYearMonths(rows: readonly InpsRow[], column: string | null): YearMonth[] {
  const seen = new Set<number>();
  const out: YearMonth[] = [];
  for (const row of rows) {
    const ym = yearMonthOfRow(row, column);
    if (!ym) continue;
    const k = ymKey(ym);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ym);
  }
  return out.sort((a, b) => ymKey(b) - ymKey(a));
}

/** Periodo più antico con un codice motivo cessazione valorizzato (≠ "0"). */
export function firstCessationPeriod(rows: readonly InpsRow[], cols: QuadriColumns): YearMonth | null {
  if (!cols.cessazione || !cols.data) return null;
  let best: YearMonth | null = null;
  for (const row of rows) {
    const code = textOf(row, cols.cessazione);
    if (code === '' || code === '0') continue;
    const ym = yearMonthOfRow(row, cols.data);
    if (!ym) continue;
    if (!best || ymKey(ym) < ymKey(best)) best = ym;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Raggruppamento per anno con subtotali
// ---------------------------------------------------------------------------

export interface ExportRow {
  kind: 'data' | 'subtotal';
  year?: number;
  row?: InpsRow;
  /** Valorizzato solo per i subtotali. */
  values?: Record<string, Cell>;
}

/**
 * Inserisce una riga di subtotale al termine di ogni blocco contiguo di righe
 * dello stesso anno. NON riordina: rispetta l'ordine ricevuto, che è quello
 * deciso da `sortByPeriod`. Grazie a questo ogni blocco è contiguo anche nel
 * foglio finale, condizione necessaria perché i subtotali possano essere
 * formule su un intervallo.
 *
 * Le righe dati restano gli stessi oggetti dell'input, nello stesso ordine:
 * `assertDataRowsIntact` lo verifica prima di restituire il risultato.
 */
export function groupByYearWithSubtotals(
  rows: readonly InpsRow[],
  columns: readonly string[],
  dateColumn: string | null,
): ExportRow[] {
  const labelCol = (dateColumn && columns.includes(dateColumn)) ? dateColumn : (columns[0] ?? null);
  const sumCols = SUBTOTAL_COLUMNS.filter(c => columns.includes(c));
  const out: ExportRow[] = [];

  let runYear: number | null = null;
  let runRows: InpsRow[] = [];

  const closeRun = () => {
    if (runYear == null || runRows.length === 0) {
      runRows = [];
      return;
    }
    const values: Record<string, Cell> = {};
    for (const c of columns) values[c] = null;
    if (labelCol) values[labelCol] = `Subtotale ${runYear}`;
    for (const c of sumCols) {
      let sum = 0;
      let any = false;
      for (const row of runRows) {
        const n = numberOf(row, c);
        if (n != null) {
          sum += n;
          any = true;
        }
      }
      values[c] = any ? Math.round(sum * 100) / 100 : null;
    }
    out.push({ kind: 'subtotal', year: runYear, values });
    runRows = [];
  };

  for (const row of rows) {
    const ym = yearMonthOfRow(row, dateColumn);
    const year = ym ? ym.year : null;
    if (year !== runYear) {
      closeRun();
      runYear = year;
    }
    out.push({ kind: 'data', row });
    if (year != null) runRows.push(row);
  }
  closeRun();

  assertDataRowsIntact(rows, out);
  return out;
}

/** Le righe dati dell'output devono essere gli stessi oggetti dell'input, tutti e soli. */
export function assertDataRowsIntact(input: readonly InpsRow[], output: readonly ExportRow[]): void {
  const data = output.filter(e => e.kind === 'data').map(e => e.row);
  if (data.length !== input.length) {
    throw new IntegrityError(
      `Raggruppamento: ${input.length} righe in ingresso ma ${data.length} righe dati in uscita.`,
    );
  }
  const source = new Set<InpsRow>(input);
  const seen = new Set<number>();
  for (const row of data) {
    if (!row || !source.has(row)) {
      throw new IntegrityError(`Raggruppamento: riga ${row?.__id ?? '?'} estranea all'insieme di partenza.`);
    }
    if (seen.has(row.__id)) {
      throw new IntegrityError(`Raggruppamento: riga ${row.__id} duplicata.`);
    }
    seen.add(row.__id);
  }
}

export function flattenRows(rows: readonly InpsRow[]): ExportRow[] {
  return rows.map(row => ({ kind: 'data' as const, row }));
}

// ---------------------------------------------------------------------------
// Export XLSX — formule, filtro automatico, verifica cella per cella
// ---------------------------------------------------------------------------

/** Cella con formula Excel. La formula si scrive senza "=" e con la virgola come separatore. */
export interface FormulaCell {
  t: 'n';
  f: string;
}

export type ExportValue = Cell | FormulaCell;

export function isFormulaCell(v: ExportValue): v is FormulaCell {
  return typeof v === 'object' && v !== null && typeof (v as FormulaCell).f === 'string';
}

export interface SheetSpec {
  name: string;
  matrix: ExportValue[][];
  /** Filtro automatico sulla riga di intestazione. Attivo se non specificato. */
  autoFilter?: boolean;
}

/** Intestazione della colonna con il numero di riga del file INPS di origine. */
export const ROW_ID_HEADER = 'Riga';

/**
 * Intestazione usata nel file esportato: il nome della colonna come sta nel
 * file INPS di origine.
 *
 * Le sigle brevi (`CF`, `DT_INIZ`, …) sono state tolte: rendevano l'export non
 * confrontabile a occhio con il file di partenza, che è il primo controllo che
 * si fa. La larghezza resta calcolata sul dato, con l'intestazione che può
 * allargare la colonna solo entro un limite, quindi i nomi lunghi non
 * producono colonne sproporzionate.
 */
export function columnLabel(column: string): string {
  return column;
}

export interface ExportOptions {
  /** Antepone la colonna "Riga" con il numero di riga del file INPS. Default: sì. */
  includeRowId?: boolean;
  /**
   * Scrive i subtotali come formula SUBTOTAL(9;intervallo) invece che come
   * valore fisso, così restano corretti se in Excel si aggiungono o tolgono
   * righe. SUBTOTAL ignora anche le righe nascoste dal filtro automatico e
   * non conteggia due volte i subtotali annidati. Default: sì.
   */
  subtotalsAsFormula?: boolean;
}

/**
 * Costruisce la matrice di export: intestazioni + una riga per ogni ExportRow.
 * I subtotali diventano formule sull'intervallo delle righe dati che li
 * precedono — intervallo che è contiguo perché `groupByYearWithSubtotals`
 * rispetta l'ordinamento senza rimescolare le righe.
 */
export function buildExportMatrix(
  entries: readonly ExportRow[],
  columns: readonly string[],
  options: ExportOptions = {},
): ExportValue[][] {
  const includeRowId = options.includeRowId !== false;
  const asFormula = options.subtotalsAsFormula !== false;
  const offset = includeRowId ? 1 : 0;

  const header: ExportValue[] = columns.map(columnLabel);
  if (includeRowId) header.unshift(ROW_ID_HEADER);
  const matrix: ExportValue[][] = [header];

  // Riga Excel (1-based) della prima riga dati del blocco corrente.
  let runStart: number | null = null;
  let runEnd: number | null = null;

  for (const entry of entries) {
    const excelRow = matrix.length + 1;

    if (entry.kind === 'subtotal') {
      const values = entry.values ?? {};
      const line: ExportValue[] = columns.map((c, i) => {
        const value = values[c] ?? '';
        if (!asFormula || value === '' || runStart == null || runEnd == null) return value;
        // Solo le colonne effettivamente sommate diventano formula.
        if (typeof value !== 'number') return value;
        const col = utils.encode_col(i + offset);
        return { t: 'n', f: `SUBTOTAL(9,${col}${runStart}:${col}${runEnd})` } as FormulaCell;
      });
      if (includeRowId) line.unshift('');
      matrix.push(line);
      runStart = null;
      runEnd = null;
      continue;
    }

    const row = entry.row!;
    const line: ExportValue[] = columns.map(c => cellOf(row, c) ?? '');
    if (includeRowId) line.unshift(row.__id);
    matrix.push(line);
    if (runStart == null) runStart = excelRow;
    runEnd = excelRow;
  }

  return matrix;
}

/**
 * Confronta il foglio costruito con la matrice sorgente, cella per cella,
 * leggendo direttamente le celle del worksheet. Per le formule verifica la
 * formula scritta (una cella con formula non ha valore in cache finché Excel
 * non ricalcola, quindi un confronto sui valori sarebbe inutilizzabile).
 */
export function assertSheetMatches(
  ws: WorkSheet,
  matrix: readonly ExportValue[][],
  sheetName: string,
): void {
  const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const ref = ws['!ref'];
  if (!ref) {
    throw new IntegrityError(`Foglio "${sheetName}": intervallo assente.`);
  }
  const range = utils.decode_range(ref);
  if (range.e.r + 1 !== matrix.length || range.e.c + 1 !== width) {
    throw new IntegrityError(
      `Foglio "${sheetName}": attese ${matrix.length}×${width} celle, il foglio è ${range.e.r + 1}×${range.e.c + 1}.`,
    );
  }

  for (let r = 0; r < matrix.length; r++) {
    const line = matrix[r];
    for (let c = 0; c < line.length; c++) {
      const intended = line[c];
      const addr = utils.encode_cell({ r, c });
      const cell = ws[addr] as { v?: unknown; f?: string } | undefined;

      if (isFormulaCell(intended)) {
        if (!cell || cell.f !== intended.f) {
          throw new IntegrityError(
            `Foglio "${sheetName}" cella ${addr}: attesa formula "${intended.f}", trovata "${cell?.f ?? '(nessuna)'}".`,
          );
        }
        continue;
      }

      const expected = intended == null ? '' : String(intended);
      const actual = cell == null || cell.v == null ? '' : String(cell.v);
      if (expected !== actual) {
        throw new IntegrityError(
          `Foglio "${sheetName}" cella ${addr}: atteso "${expected}", scritto "${actual}".`,
        );
      }
    }
  }
}

/**
 * Larghezze colonna calcolate sul DATO, non sull'intestazione: in questi
 * tracciati l'intestazione è quasi sempre più lunga del contenuto, e lasciarla
 * comandare produce colonne larghissime e mezze vuote. L'intestazione può
 * allargare la colonna solo fino a `HEADER_WIDTH_CAP`; oltre viene troncata a
 * schermo, restando comunque leggibile nella barra della formula.
 */
const HEADER_WIDTH_CAP = 14;
const MIN_WIDTH = 6;
const MAX_WIDTH = 45;

function columnWidths(matrix: readonly ExportValue[][]): { wch: number }[] {
  const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const dataWidths: number[] = new Array(width).fill(0);
  const headerWidths: number[] = new Array(width).fill(0);

  for (let r = 0; r < matrix.length; r++) {
    const line = matrix[r];
    for (let c = 0; c < line.length; c++) {
      const v = line[c];
      const len = isFormulaCell(v) ? 10 : (v == null ? 0 : String(v).length);
      if (r === 0) headerWidths[c] = len;
      else if (len > dataWidths[c]) dataWidths[c] = len;
    }
  }

  return dataWidths.map((dataLen, c) => {
    const headerLen = Math.min(headerWidths[c], HEADER_WIDTH_CAP);
    const wch = Math.max(dataLen, headerLen) + 2;
    return { wch: Math.min(Math.max(wch, MIN_WIDTH), MAX_WIDTH) };
  });
}

/**
 * Costruisce il workbook (fogli, formule, filtro automatico, larghezze) senza
 * salvarlo. Separato dal salvataggio così il risultato è ispezionabile e
 * verificabile fuori dal browser.
 */
export function buildWorkbook(specs: readonly SheetSpec[]): WorkBook {
  const wb = utils.book_new();
  for (const spec of specs) {
    const ws = utils.aoa_to_sheet(spec.matrix as unknown[][]);
    assertSheetMatches(ws, spec.matrix, spec.name);

    if (spec.autoFilter !== false && spec.matrix.length > 0) {
      const width = spec.matrix.reduce((m, r) => Math.max(m, r.length), 0);
      ws['!autofilter'] = {
        ref: utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: spec.matrix.length - 1, c: Math.max(0, width - 1) },
        }),
      };
    }
    ws['!cols'] = columnWidths(spec.matrix);

    // I nomi foglio Excel sono limitati a 31 caratteri.
    utils.book_append_sheet(wb, ws, spec.name.slice(0, 31));
  }
  return wb;
}

export function exportWorkbook(specs: readonly SheetSpec[], filename: string): void {
  writeFileXLSX(buildWorkbook(specs), filename);
}

export function exportQuadri(
  entries: readonly ExportRow[],
  columns: readonly string[],
  filename: string,
  options: ExportOptions = {},
): void {
  const matrix = buildExportMatrix(entries, columns, options);
  exportWorkbook([{ name: 'Quadri E0-V1', matrix }], filename);
}
