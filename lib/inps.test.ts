import { describe, expect, it } from 'vitest';
import {
  type InpsRow,
  type Partition,
  type QuadriColumns,
  IntegrityError,
  assertDataRowsIntact,
  assertPartition,
  buildExportMatrix,
  filterQuadri,
  flattenRows,
  groupByYearWithSubtotals,
  normalizeHeader,
  parseYearMonth,
  partitionRows,
  resolveColumn,
  toNumber,
} from './inps';

const COLS: QuadriColumns = {
  data: 'Data Inizio Periodo',
  tipologia: 'Tipologia',
  stato: 'Correnti, obsoleti, …',
  cessazione: 'Codice Motivo Cessazione',
};

function row(id: number, cells: Record<string, string | number | null>): InpsRow {
  return Object.freeze({ __id: id, __sheet: 'test', cells: Object.freeze(cells) });
}

/**
 * Riproduce la sequenza reale che nell'agosto 2026 fece emergere l'off-by-one:
 * la prima riga dati è Corrente, e le righe Obsolete/Annullate precedono
 * immediatamente una Corrente. Il bug perdeva la prima riga, promuoveva le
 * righe scartate al posto delle Correnti e duplicava l'ultima.
 */
function scenarioStorico(): InpsRow[] {
  return [
    row(5, { 'Data Inizio Periodo': '01/05/2025', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '1334.32' }),
    row(6, { 'Data Inizio Periodo': '01/11/2024', 'Tipologia': 'V1', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '722.57' }),
    row(27, { 'Data Inizio Periodo': '01/06/2023', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Annullato', 'Imponibile': '1977.07' }),
    row(28, { 'Data Inizio Periodo': '01/05/2023', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '2010.26' }),
    row(157, { 'Data Inizio Periodo': '01/11/2012', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Obsoleto', 'Imponibile': '839.57' }),
    row(158, { 'Data Inizio Periodo': '01/11/2012', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '839.57' }),
    row(269, { 'Data Inizio Periodo': '01/10/2004', 'Tipologia': 'V1', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '67.56' }),
  ];
}

describe('filterQuadri — regressione off-by-one', () => {
  const rows = scenarioStorico();

  it('tiene la prima riga dati quando soddisfa i filtri', () => {
    const { kept } = filterQuadri(rows, COLS, { stati: new Set(['Corrente']) });
    expect(kept[0].__id).toBe(5);
  });

  it('tiene esattamente le righe Correnti, nessuna sostituzione', () => {
    const { kept, excluded } = filterQuadri(rows, COLS, { stati: new Set(['Corrente']) });
    expect(kept.map(r => r.__id)).toEqual([5, 6, 28, 158, 269]);
    expect(excluded.map(e => e.row.__id)).toEqual([27, 157]);
  });

  it('non duplica l\'ultima riga', () => {
    const { kept } = filterQuadri(rows, COLS, { stati: new Set(['Corrente']) });
    expect(new Set(kept.map(r => r.__id)).size).toBe(kept.length);
  });

  it('tenute + escluse coprono sempre tutto il foglio', () => {
    const { kept, excluded } = filterQuadri(rows, COLS, {
      from: { year: 2012, month: 1 },
      to: { year: 2024, month: 12 },
      stati: new Set(['Corrente']),
    });
    expect(kept.length + excluded.length).toBe(rows.length);
  });

  it('ogni riga tenuta soddisfa davvero il filtro', () => {
    const { kept } = filterQuadri(rows, COLS, { stati: new Set(['Corrente']) });
    for (const r of kept) expect(r.cells['Correnti, obsoleti, …']).toBe('Corrente');
  });

  it('senza filtri non esclude nulla', () => {
    const { kept, excluded } = filterQuadri(rows, COLS, {});
    expect(kept.length).toBe(rows.length);
    expect(excluded).toHaveLength(0);
  });

  it('ogni esclusione ha un motivo leggibile', () => {
    const { excluded } = filterQuadri(rows, COLS, { stati: new Set(['Corrente']) });
    for (const e of excluded) expect(e.reason.length).toBeGreaterThan(0);
  });

  it('ignora con avviso un filtro la cui colonna non esiste, invece di svuotare tutto', () => {
    const senzaStato: QuadriColumns = { ...COLS, stato: null };
    const res = filterQuadri(rows, senzaStato, { stati: new Set(['Corrente']) });
    expect(res.kept.length).toBe(rows.length);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

describe('assertPartition — intercetta lo shift', () => {
  const rows = scenarioStorico();

  it('rifiuta una selezione sfasata di una riga (il bug storico)', () => {
    const corrente = rows.filter(r => r.cells['Correnti, obsoleti, …'] === 'Corrente');
    const shifted = corrente.map(r => {
      const i = rows.indexOf(r);
      return rows[Math.min(i + 1, rows.length - 1)];
    });
    const part: Partition = { kept: shifted, excluded: [] };
    expect(() => assertPartition(rows, part)).toThrow(IntegrityError);
  });

  it('rifiuta righe duplicate', () => {
    const part: Partition = { kept: [rows[0], rows[0]], excluded: [] };
    expect(() => assertPartition(rows, part)).toThrow(IntegrityError);
  });

  it('rifiuta righe estranee', () => {
    const intrusa = row(999, {});
    const part: Partition = { kept: [intrusa], excluded: rows.slice(1).map(r => ({ row: r, reason: 'x' })) };
    expect(() => assertPartition(rows, part)).toThrow(IntegrityError);
  });

  it('rifiuta un ordine diverso da quello del foglio', () => {
    const part: Partition = {
      kept: [rows[1], rows[0]],
      excluded: rows.slice(2).map(r => ({ row: r, reason: 'x' })),
    };
    expect(() => assertPartition(rows, part)).toThrow(IntegrityError);
  });

  it('rifiuta un conteggio incoerente', () => {
    const part: Partition = { kept: [rows[0]], excluded: [] };
    expect(() => assertPartition(rows, part)).toThrow(IntegrityError);
  });

  it('accetta una partizione corretta', () => {
    const part = partitionRows(rows, r => (r.cells['Tipologia'] === 'E0' ? null : 'non E0'));
    expect(() => assertPartition(rows, part)).not.toThrow();
  });
});

describe('groupByYearWithSubtotals', () => {
  const rows = scenarioStorico();

  it('conserva tutte le righe dati e aggiunge un subtotale per anno', () => {
    const cols = ['Data Inizio Periodo', 'Tipologia', 'Imponibile'];
    const out = groupByYearWithSubtotals(rows, cols, 'Data Inizio Periodo');
    const data = out.filter(e => e.kind === 'data');
    expect(data.map(e => e.row!.__id).sort((a, b) => a - b)).toEqual([5, 6, 27, 28, 157, 158, 269]);
    // 2025, 2024, 2023, 2012, 2004
    expect(out.filter(e => e.kind === 'subtotal')).toHaveLength(5);
  });

  it('somma correttamente le colonne numeriche del subtotale', () => {
    const out = groupByYearWithSubtotals(rows, ['Data Inizio Periodo', 'Imponibile'], 'Data Inizio Periodo');
    const sub2012 = out.find(e => e.kind === 'subtotal' && e.year === 2012);
    expect(sub2012?.values?.['Imponibile']).toBeCloseTo(839.57 * 2, 2);
  });

  it('assertDataRowsIntact segnala una riga dati mancante', () => {
    const out = flattenRows(rows).slice(1);
    expect(() => assertDataRowsIntact(rows, out)).toThrow(IntegrityError);
  });
});

describe('buildExportMatrix', () => {
  it('scrive una riga per ogni voce, intestazioni comprese', () => {
    const rows = scenarioStorico();
    const cols = ['Data Inizio Periodo', 'Tipologia'];
    const matrix = buildExportMatrix(flattenRows(rows), cols);
    expect(matrix).toHaveLength(rows.length + 1);
    expect(matrix[1]).toEqual(['01/05/2025', 'E0']);
  });
});

describe('parsing dei valori', () => {
  it('interpreta le date nei formati INPS', () => {
    expect(parseYearMonth('01/05/2025')).toEqual({ year: 2025, month: 5 });
    expect(parseYearMonth('2025-05-01')).toEqual({ year: 2025, month: 5 });
    expect(parseYearMonth('2024 - Ottobre')).toEqual({ year: 2024, month: 10 });
    expect(parseYearMonth('2014-Settembre')).toEqual({ year: 2014, month: 9 });
    expect(parseYearMonth('')).toBeNull();
    expect(parseYearMonth(null)).toBeNull();
  });

  it('interpreta i numeri in formato sia inglese sia italiano', () => {
    expect(toNumber('1334.32')).toBeCloseTo(1334.32, 2);
    expect(toNumber('1.334,32')).toBeCloseTo(1334.32, 2);
    expect(toNumber('671')).toBe(671);
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
  });

  it('risolve le intestazioni anche con punteggiatura diversa', () => {
    const columns = ['Codice fiscale', 'Correnti, obsoleti, …', 'Data Inizio Periodo'];
    expect(resolveColumn(columns, ['Correnti, obsoleti, …'])).toBe('Correnti, obsoleti, …');
    expect(resolveColumn(columns, ['Correnti obsoleti'])).toBe('Correnti, obsoleti, …');
    expect(resolveColumn(columns, ['Colonna inesistente'])).toBeNull();
    expect(normalizeHeader('Correnti, obsoleti, …')).toBe('correnti obsoleti');
  });
});
