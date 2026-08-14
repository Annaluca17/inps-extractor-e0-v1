import { describe, expect, it } from 'vitest';
import {
  type InpsRow,
  type Partition,
  type QuadriColumns,
  IntegrityError,
  assertDataRowsIntact,
  assertPartition,
  assertPermutation,
  buildExportMatrix,
  columnValueCounts,
  filterQuadri,
  flattenRows,
  groupByYearWithSubtotals,
  isFormulaCell,
  nonEmptyColumns,
  normalizeHeader,
  parseDate,
  parseYearMonth,
  partitionRows,
  resolveColumn,
  sortByPeriod,
  toNumber,
} from './inps';
import { initialColumnSelection, missingPresetColumns } from './preferences';

const COLS: QuadriColumns = {
  data: 'Data Inizio Periodo',
  dataFine: 'Data Fine Periodo',
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
    row(5, { 'Data Inizio Periodo': '01/05/2025', 'Data Fine Periodo': '31/05/2025', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '1334.32' }),
    row(6, { 'Data Inizio Periodo': '01/11/2024', 'Data Fine Periodo': '30/11/2024', 'Tipologia': 'V1', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '722.57' }),
    row(27, { 'Data Inizio Periodo': '01/06/2023', 'Data Fine Periodo': '30/06/2023', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Annullato', 'Imponibile': '1977.07' }),
    row(28, { 'Data Inizio Periodo': '01/05/2023', 'Data Fine Periodo': '31/05/2023', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '2010.26' }),
    row(157, { 'Data Inizio Periodo': '01/11/2012', 'Data Fine Periodo': '30/11/2012', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Obsoleto', 'Imponibile': '839.57' }),
    row(158, { 'Data Inizio Periodo': '01/11/2012', 'Data Fine Periodo': '30/11/2012', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '839.57' }),
    row(269, { 'Data Inizio Periodo': '01/10/2004', 'Data Fine Periodo': '31/12/2004', 'Tipologia': 'V1', 'Correnti, obsoleti, …': 'Corrente', 'Imponibile': '67.56' }),
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

describe('esclusione manuale di singole righe', () => {
  const rows = scenarioStorico();

  it('toglie solo le righe indicate, con il motivo nel registro', () => {
    const { kept, excluded } = filterQuadri(rows, COLS, { escluseManuali: new Set([28]) });
    expect(kept.map(r => r.__id)).not.toContain(28);
    const ex = excluded.find(e => e.row.__id === 28);
    expect(ex?.reason).toContain('a mano');
  });

  it('resta una partizione: tenute + escluse coprono il foglio', () => {
    const { kept, excluded } = filterQuadri(rows, COLS, {
      stati: new Set(['Corrente']),
      escluseManuali: new Set([5, 158]),
    });
    expect(kept.length + excluded.length).toBe(rows.length);
    expect(kept.map(r => r.__id)).not.toContain(5);
    expect(kept.map(r => r.__id)).not.toContain(158);
  });

  it('distingue due righe che nessun filtro per valore separerebbe', () => {
    // 5 e 28 sono entrambe E0 Correnti: solo la scelta puntuale le distingue.
    const { kept } = filterQuadri(rows, COLS, {
      stati: new Set(['Corrente']),
      escluseManuali: new Set([28]),
    });
    expect(kept.map(r => r.__id)).toContain(5);
    expect(kept.map(r => r.__id)).not.toContain(28);
  });

  it('prevale sui filtri: il motivo resta quello dell\'operatore', () => {
    const { excluded } = filterQuadri(rows, COLS, {
      stati: new Set(['Corrente']),
      escluseManuali: new Set([27]),   // 27 sarebbe già esclusa dallo stato
    });
    expect(excluded.find(e => e.row.__id === 27)?.reason).toContain('a mano');
  });

  it('senza esclusioni manuali nulla cambia', () => {
    const a = filterQuadri(rows, COLS, { stati: new Set(['Corrente']) });
    const b = filterQuadri(rows, COLS, { stati: new Set(['Corrente']), escluseManuali: new Set() });
    expect(b.kept.map(r => r.__id)).toEqual(a.kept.map(r => r.__id));
  });
});

describe('filtri sulle intestazioni di colonna', () => {
  const rows = scenarioStorico();

  it('tiene solo le righe con i valori ammessi', () => {
    const { kept } = filterQuadri(rows, COLS, {
      columnFilters: new Map([['Tipologia', new Set(['V1'])]]),
    });
    expect(kept.map(r => r.__id)).toEqual([6, 269]);
  });

  it('combina più colonne in AND', () => {
    const { kept } = filterQuadri(rows, COLS, {
      columnFilters: new Map([
        ['Tipologia', new Set(['E0'])],
        ['Correnti, obsoleti, …', new Set(['Corrente'])],
      ]),
    });
    expect(kept.map(r => r.__id)).toEqual([5, 28, 158]);
  });

  it('si combina con gli altri filtri e resta una partizione', () => {
    const { kept, excluded } = filterQuadri(rows, COLS, {
      from: { year: 2012, month: 1 },
      columnFilters: new Map([['Tipologia', new Set(['E0'])]]),
    });
    expect(kept.length + excluded.length).toBe(rows.length);
    for (const r of kept) expect(r.cells['Tipologia']).toBe('E0');
  });

  it('un insieme vuoto di valori non filtra nulla', () => {
    const { kept } = filterQuadri(rows, COLS, {
      columnFilters: new Map([['Tipologia', new Set<string>()]]),
    });
    expect(kept).toHaveLength(rows.length);
  });

  it('ignora con avviso un filtro su colonna inesistente invece di svuotare tutto', () => {
    const res = filterQuadri(rows, COLS, {
      columnFilters: new Map([['Colonna Fantasma', new Set(['x'])]]),
    });
    expect(res.kept).toHaveLength(rows.length);
    expect(res.warnings.join(' ')).toContain('Colonna Fantasma');
  });

  it('motiva l\'esclusione indicando colonna e valore', () => {
    const { excluded } = filterQuadri(rows, COLS, {
      columnFilters: new Map([['Tipologia', new Set(['V1'])]]),
    });
    expect(excluded[0].reason).toContain('Tipologia');
    expect(excluded[0].reason).toContain('E0');
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

describe('sortByPeriod', () => {
  const rows = scenarioStorico();

  it('ordina per data inizio decrescente, dal più recente al più vecchio', () => {
    const out = sortByPeriod(rows, 'Data Inizio Periodo', 'Data Fine Periodo', 'desc');
    expect(out.map(r => r.cells['Data Inizio Periodo'])).toEqual([
      '01/05/2025', '01/11/2024', '01/06/2023', '01/05/2023',
      '01/11/2012', '01/11/2012', '01/10/2004',
    ]);
  });

  it('ordina crescente su richiesta', () => {
    const out = sortByPeriod(rows, 'Data Inizio Periodo', 'Data Fine Periodo', 'asc');
    expect(out[0].__id).toBe(269);
    expect(out[out.length - 1].__id).toBe(5);
  });

  it('a parità di data inizio usa la data fine', () => {
    const a = row(1, { 'Data Inizio Periodo': '01/01/2020', 'Data Fine Periodo': '31/01/2020' });
    const b = row(2, { 'Data Inizio Periodo': '01/01/2020', 'Data Fine Periodo': '31/03/2020' });
    const out = sortByPeriod([a, b], 'Data Inizio Periodo', 'Data Fine Periodo', 'desc');
    expect(out.map(r => r.__id)).toEqual([2, 1]);
  });

  it('è stabile: a parità di chiave resta l\'ordine del file', () => {
    const out = sortByPeriod(rows, 'Data Inizio Periodo', 'Data Fine Periodo', 'desc');
    const dodici = out.filter(r => r.cells['Data Inizio Periodo'] === '01/11/2012');
    expect(dodici.map(r => r.__id)).toEqual([157, 158]);
  });

  it('mette in coda le righe senza data valida, in entrambe le direzioni', () => {
    const senzaData = row(999, { 'Data Inizio Periodo': '' });
    for (const dir of ['desc', 'asc'] as const) {
      const out = sortByPeriod([senzaData, ...rows], 'Data Inizio Periodo', 'Data Fine Periodo', dir);
      expect(out[out.length - 1].__id).toBe(999);
    }
  });

  it('non perde né duplica righe', () => {
    const out = sortByPeriod(rows, 'Data Inizio Periodo', 'Data Fine Periodo', 'desc');
    expect(() => assertPermutation(rows, out)).not.toThrow();
    expect(new Set(out.map(r => r.__id)).size).toBe(rows.length);
  });

  it('assertPermutation rifiuta una riga persa o duplicata', () => {
    expect(() => assertPermutation(rows, rows.slice(1))).toThrow(IntegrityError);
    expect(() => assertPermutation(rows, [rows[0], ...rows.slice(0, rows.length - 1)])).toThrow(IntegrityError);
  });
});

describe('buildExportMatrix', () => {
  const rows = scenarioStorico();
  const cols = ['Data Inizio Periodo', 'Tipologia', 'Imponibile'];

  it('antepone la colonna Riga e tiene i nomi di colonna del file di origine', () => {
    const matrix = buildExportMatrix(flattenRows(rows), cols);
    expect(matrix).toHaveLength(rows.length + 1);
    // Nessuna sigla: l'export deve restare confrontabile a occhio col file INPS.
    expect(matrix[0]).toEqual(['Riga', 'Data Inizio Periodo', 'Tipologia', 'Imponibile']);
    expect(matrix[1]).toEqual([5, '01/05/2025', 'E0', '1334.32']);
  });

  it('tiene il nome originale anche per le colonne fuori dalla mappa', () => {
    const matrix = buildExportMatrix(flattenRows(rows), ['Retribuzione valutabile ai fini TFR']);
    expect(matrix[0]).toEqual(['Riga', 'Retribuzione valutabile ai fini TFR']);
  });

  it('omette la colonna Riga se richiesto', () => {
    const matrix = buildExportMatrix(flattenRows(rows), cols, { includeRowId: false });
    expect(matrix[1]).toEqual(['01/05/2025', 'E0', '1334.32']);
  });

  it('scrive i subtotali come formula sull\'intervallo giusto', () => {
    const sorted = sortByPeriod(rows, 'Data Inizio Periodo', 'Data Fine Periodo', 'desc');
    const entries = groupByYearWithSubtotals(sorted, cols, 'Data Inizio Periodo');
    const matrix = buildExportMatrix(entries, cols);

    // Ordine atteso: 2025 | sub | 2024 | sub | 2023 ×2 | sub | 2012 ×2 | sub | 2004 | sub
    // La colonna Imponibile è la D (A = Riga).
    const formule = matrix
      .flat()
      .filter(isFormulaCell)
      .map(c => c.f);
    expect(formule).toEqual([
      'SUBTOTAL(9,D2:D2)',    // 2025
      'SUBTOTAL(9,D4:D4)',    // 2024
      'SUBTOTAL(9,D6:D7)',    // 2023, due righe
      'SUBTOTAL(9,D9:D10)',   // 2012, due righe
      'SUBTOTAL(9,D12:D12)',  // 2004
    ]);
  });

  it('scrive valori fissi se le formule sono disattivate', () => {
    const sorted = sortByPeriod(rows, 'Data Inizio Periodo', 'Data Fine Periodo', 'desc');
    const entries = groupByYearWithSubtotals(sorted, cols, 'Data Inizio Periodo');
    const matrix = buildExportMatrix(entries, cols, { subtotalsAsFormula: false });
    expect(matrix.flat().filter(isFormulaCell)).toHaveLength(0);
    const sub2023 = matrix.find(r => r[1] === 'Subtotale 2023');
    expect(sub2023?.[3]).toBeCloseTo(1977.07 + 2010.26, 2);
  });

  it('i blocchi dei subtotali coprono righe contigue', () => {
    const sorted = sortByPeriod(rows, 'Data Inizio Periodo', 'Data Fine Periodo', 'desc');
    const entries = groupByYearWithSubtotals(sorted, cols, 'Data Inizio Periodo');
    // Ogni subtotale è preceduto solo da righe dati del proprio anno.
    let blockYear: number | null = null;
    for (const e of entries) {
      if (e.kind === 'data') {
        const y = Number(String(e.row!.cells['Data Inizio Periodo']).slice(-4));
        if (blockYear == null) blockYear = y;
        expect(y).toBe(blockYear);
      } else {
        expect(e.year).toBe(blockYear);
        blockYear = null;
      }
    }
  });
});

describe('colonne popolate e vuote', () => {
  const rows = [
    row(5, { 'A': 'x', 'B': '', 'C': null, 'D': 0 }),
    row(6, { 'A': 'y', 'B': '   ', 'C': null, 'D': 3 }),
    row(7, { 'A': '', 'B': 'z', 'C': null, 'D': 7 }),
  ];
  const cols = ['A', 'B', 'C', 'D'];

  it('conta i valori non vuoti per colonna', () => {
    const counts = columnValueCounts(rows, cols);
    expect(counts.get('A')).toBe(2);
    expect(counts.get('B')).toBe(1);   // stringhe di soli spazi non contano
    expect(counts.get('C')).toBe(0);
    expect(counts.get('D')).toBe(3);   // lo zero è un valore
  });

  it('elenca solo le colonne con almeno un valore, nell\'ordine del foglio', () => {
    expect(nonEmptyColumns(rows, cols)).toEqual(['A', 'B', 'D']);
  });

  it('la selezione iniziale unisce colonne popolate e predefinite salvate', () => {
    const selection = initialColumnSelection(cols, nonEmptyColumns(rows, cols), ['C']);
    expect(Array.from(selection).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('senza predefinite salvate seleziona solo le colonne popolate', () => {
    const selection = initialColumnSelection(cols, nonEmptyColumns(rows, cols), null);
    expect(selection.has('C')).toBe(false);
    expect(selection.size).toBe(3);
  });

  it('ignora le predefinite che non esistono nel file e le segnala', () => {
    const selection = initialColumnSelection(cols, nonEmptyColumns(rows, cols), ['C', 'Inesistente']);
    expect(selection.has('Inesistente')).toBe(false);
    expect(missingPresetColumns(cols, ['C', 'Inesistente'])).toEqual(['Inesistente']);
  });
});

describe('parsing dei valori', () => {
  it('interpreta le date con il giorno, necessario per l\'ordinamento', () => {
    expect(parseDate('15/05/2025')).toEqual({ year: 2025, month: 5, day: 15 });
    expect(parseDate('2025-05-15')).toEqual({ year: 2025, month: 5, day: 15 });
    expect(parseDate('2024 - Ottobre')).toEqual({ year: 2024, month: 10, day: 1 });
    expect(parseDate('non una data')).toBeNull();
  });

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
