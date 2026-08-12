/**
 * Riepilogo degli sgravi contributivi — foglio "Quadri E0 e V1 Elenco Sgravi".
 *
 * Le aggregazioni partono sempre dalle stesse `InpsRow` immutabili prodotte da
 * `parseInpsWorkbook`, e i filtri passano da `partitionRows`: valgono qui le
 * identiche invarianti dei quadri (nessuna riga persa, duplicata o sostituita).
 */
import {
  type ExportValue,
  type FormulaCell,
  type InpsRow,
  type SheetData,
  type SheetSpec,
  type YearMonth,
  MONTH_NAMES,
  ROW_ID_HEADER,
  cellOf,
  numberOf,
  parseYearMonth,
  partitionRows,
  resolveColumn,
  textOf,
  toNumber,
} from './inps';

export interface SgraviColumns {
  cf: string | null;
  denuncia: string | null;
  dataInizio: string | null;
  dataFine: string | null;
  tipologia: string | null;
  sgravio: string | null;
  imponibileSgravio: string | null;
  altroImponibileSgravio: string | null;
  anno: string | null;
  mese: string | null;
  cassa: string | null;
  imponibile: string | null;
  totaleContributi: string | null;
  protocollo: string | null;
}

export function resolveSgraviColumns(columns: readonly string[]): SgraviColumns {
  return {
    cf: resolveColumn(columns, ['Codice fiscale', 'Iscritto']),
    denuncia: resolveColumn(columns, ['Denuncia']),
    dataInizio: resolveColumn(columns, ['Data Inizio Periodo']),
    dataFine: resolveColumn(columns, ['Data Fine Periodo']),
    tipologia: resolveColumn(columns, ['Tipologia']),
    sgravio: resolveColumn(columns, ['Sgravio']),
    imponibileSgravio: resolveColumn(columns, ['Imponibile Sgravio']),
    altroImponibileSgravio: resolveColumn(columns, ['Altro Imponibile Sgravio']),
    anno: resolveColumn(columns, ['Anno Sgravio']),
    mese: resolveColumn(columns, ['Mese Sgravio']),
    cassa: resolveColumn(columns, ['Cassa Pensionistica']),
    imponibile: resolveColumn(columns, ['Imponibile']),
    totaleContributi: resolveColumn(columns, ['Totale Contributi']),
    protocollo: resolveColumn(columns, ['Protocollo']),
  };
}

/** Il campo "Sgravio" è nella forma "49 - Esonero 7% quota di contributi …". */
export function splitSgravio(value: string): { code: string; description: string } {
  const trimmed = value.trim();
  if (trimmed === '') return { code: '—', description: '(non indicato)' };
  const sep = trimmed.indexOf(' - ');
  if (sep < 0) {
    const m = trimmed.match(/^(\d+)\s+(.*)$/);
    if (m) return { code: m[1], description: m[2] };
    return { code: trimmed, description: trimmed };
  }
  return { code: trimmed.slice(0, sep).trim(), description: trimmed.slice(sep + 3).trim() };
}

/** Competenza dello sgravio: "Anno/Mese Sgravio" se presenti, altrimenti la data inizio periodo. */
export function competenzaOf(row: InpsRow, cols: SgraviColumns): YearMonth | null {
  const year = toNumber(cellOf(row, cols.anno));
  const month = toNumber(cellOf(row, cols.mese));
  if (year != null && month != null && month >= 1 && month <= 12) {
    return { year: Math.trunc(year), month: Math.trunc(month) };
  }
  return parseYearMonth(cellOf(row, cols.dataInizio));
}

// ---------------------------------------------------------------------------
// Filtri
// ---------------------------------------------------------------------------

export interface SgraviFilter {
  anni?: ReadonlySet<number>;
  codici?: ReadonlySet<string>;
}

export function filterSgravi(rows: readonly InpsRow[], cols: SgraviColumns, filter: SgraviFilter) {
  const wantAnni = Boolean(filter.anni && filter.anni.size > 0);
  const wantCodici = Boolean(filter.codici && filter.codici.size > 0);

  return partitionRows(rows, row => {
    if (wantAnni) {
      const ym = competenzaOf(row, cols);
      if (!ym) return 'anno di competenza non determinabile';
      if (!filter.anni!.has(ym.year)) return `anno ${ym.year} non selezionato`;
    }
    if (wantCodici) {
      const { code } = splitSgravio(textOf(row, cols.sgravio));
      if (!filter.codici!.has(code)) return `codice sgravio ${code} non selezionato`;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Aggregazioni
// ---------------------------------------------------------------------------

export interface SgravioTotals {
  count: number;
  imponibileSgravio: number;
  altroImponibileSgravio: number;
}

export interface SgravioPerCodice extends SgravioTotals {
  code: string;
  description: string;
  years: number[];
}

export interface SgravioPerMese extends SgravioTotals {
  month: number;
  monthName: string;
}

export interface SgravioPerAnno extends SgravioTotals {
  year: number;
  codes: string[];
  months: SgravioPerMese[];
}

export interface SgraviSummary {
  totals: SgravioTotals;
  perCodice: SgravioPerCodice[];
  perAnno: SgravioPerAnno[];
  /** Righe la cui competenza non è determinabile: mostrate, mai nascoste. */
  senzaCompetenza: InpsRow[];
  codiciFiscali: string[];
  anni: number[];
  codici: { code: string; description: string }[];
}

const emptyTotals = (): SgravioTotals => ({ count: 0, imponibileSgravio: 0, altroImponibileSgravio: 0 });

function addTo(acc: SgravioTotals, row: InpsRow, cols: SgraviColumns): void {
  acc.count += 1;
  acc.imponibileSgravio += numberOf(row, cols.imponibileSgravio) ?? 0;
  acc.altroImponibileSgravio += numberOf(row, cols.altroImponibileSgravio) ?? 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundTotals<T extends SgravioTotals>(t: T): T {
  t.imponibileSgravio = round2(t.imponibileSgravio);
  t.altroImponibileSgravio = round2(t.altroImponibileSgravio);
  return t;
}

export function summarizeSgravi(rows: readonly InpsRow[], cols: SgraviColumns): SgraviSummary {
  const totals = emptyTotals();
  const byCode = new Map<string, SgravioPerCodice & { yearSet: Set<number> }>();
  const byYear = new Map<number, SgravioPerAnno & { codeSet: Set<string>; monthMap: Map<number, SgravioPerMese> }>();
  const senzaCompetenza: InpsRow[] = [];
  const cfs = new Set<string>();

  for (const row of rows) {
    addTo(totals, row, cols);

    const cf = textOf(row, cols.cf);
    if (cf !== '') cfs.add(cf);

    const { code, description } = splitSgravio(textOf(row, cols.sgravio));
    let codeAgg = byCode.get(code);
    if (!codeAgg) {
      codeAgg = { code, description, years: [], yearSet: new Set<number>(), ...emptyTotals() };
      byCode.set(code, codeAgg);
    }
    addTo(codeAgg, row, cols);

    const ym = competenzaOf(row, cols);
    if (!ym) {
      senzaCompetenza.push(row);
      continue;
    }
    codeAgg.yearSet.add(ym.year);

    let yearAgg = byYear.get(ym.year);
    if (!yearAgg) {
      yearAgg = {
        year: ym.year,
        codes: [],
        months: [],
        codeSet: new Set<string>(),
        monthMap: new Map<number, SgravioPerMese>(),
        ...emptyTotals(),
      };
      byYear.set(ym.year, yearAgg);
    }
    addTo(yearAgg, row, cols);
    yearAgg.codeSet.add(code);

    let monthAgg = yearAgg.monthMap.get(ym.month);
    if (!monthAgg) {
      monthAgg = { month: ym.month, monthName: MONTH_NAMES[ym.month - 1] ?? String(ym.month), ...emptyTotals() };
      yearAgg.monthMap.set(ym.month, monthAgg);
    }
    addTo(monthAgg, row, cols);
  }

  const perCodice = Array.from(byCode.values())
    .map(a => {
      a.years = Array.from(a.yearSet).sort((x, y) => x - y);
      return roundTotals(a);
    })
    .sort((a, b) => b.imponibileSgravio - a.imponibileSgravio || a.code.localeCompare(b.code, 'it'));

  const perAnno = Array.from(byYear.values())
    .map(a => {
      a.codes = Array.from(a.codeSet).sort((x, y) => x.localeCompare(y, 'it'));
      a.months = Array.from(a.monthMap.values()).map(roundTotals).sort((x, y) => x.month - y.month);
      return roundTotals(a);
    })
    .sort((a, b) => b.year - a.year);

  return {
    totals: roundTotals(totals),
    perCodice,
    perAnno,
    senzaCompetenza,
    codiciFiscali: Array.from(cfs).sort((a, b) => a.localeCompare(b, 'it')),
    anni: perAnno.map(a => a.year).sort((a, b) => b - a),
    codici: perCodice.map(c => ({ code: c.code, description: c.description })),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** SUBTOTAL(9) su un intervallo di colonna: ignora le righe filtrate e i subtotali annidati. */
function subtotal(col: string, from: number, to: number): FormulaCell {
  return { t: 'n', f: `SUBTOTAL(9,${col}${from}:${col}${to})` };
}

export function buildSgraviExport(
  summary: SgraviSummary,
  rows: readonly InpsRow[],
  sheet: SheetData,
): SheetSpec[] {
  // --- Foglio 1: per codice. Righe dati contigue, totale in fondo. ---
  const perCodice: ExportValue[][] = [
    ['Codice', 'Descrizione sgravio', 'N. righe', 'Imponibile Sgravio', 'Altro Imponibile Sgravio', 'Anni'],
    ...summary.perCodice.map(c => [
      c.code, c.description, c.count, c.imponibileSgravio, c.altroImponibileSgravio, c.years.join(', '),
    ] as ExportValue[]),
  ];
  if (summary.perCodice.length > 0) {
    const from = 2;
    const to = summary.perCodice.length + 1;
    perCodice.push(['TOTALE', '', subtotal('C', from, to), subtotal('D', from, to), subtotal('E', from, to), '']);
  }

  // --- Foglio 2: per anno. I mesi precedono il totale d'anno, così ogni
  //     intervallo è contiguo e il totale generale può a sua volta essere
  //     una SUBTOTAL che ignora i totali d'anno annidati. ---
  const perAnno: ExportValue[][] = [
    ['Anno', 'Mese', 'N. righe', 'Imponibile Sgravio', 'Altro Imponibile Sgravio', 'Codici'],
  ];
  for (const a of summary.perAnno) {
    const from = perAnno.length + 1;
    for (const m of a.months) {
      perAnno.push([a.year, m.monthName, m.count, m.imponibileSgravio, m.altroImponibileSgravio, '']);
    }
    const to = perAnno.length;
    if (to >= from) {
      perAnno.push([a.year, 'TOTALE ANNO',
        subtotal('C', from, to), subtotal('D', from, to), subtotal('E', from, to), a.codes.join(', ')]);
    } else {
      perAnno.push([a.year, 'TOTALE ANNO', a.count, a.imponibileSgravio, a.altroImponibileSgravio, a.codes.join(', ')]);
    }
  }
  if (perAnno.length > 1) {
    const to = perAnno.length;
    perAnno.push(['TOTALE', '', subtotal('C', 2, to), subtotal('D', 2, to), subtotal('E', 2, to), '']);
  }

  // --- Foglio 3: dettaglio righe, con il numero di riga del file INPS. ---
  const dettaglio: ExportValue[][] = [
    [ROW_ID_HEADER, ...sheet.columns],
    ...rows.map(row => [row.__id, ...sheet.columns.map(c => cellOf(row, c) ?? '')] as ExportValue[]),
  ];

  return [
    { name: 'Sgravi per codice', matrix: perCodice },
    { name: 'Sgravi per anno', matrix: perAnno },
    { name: 'Dettaglio sgravi', matrix: dettaglio },
  ];
}
