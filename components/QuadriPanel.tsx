'use client';
import { useMemo, useState } from 'react';
import {
  type ExportRow,
  type SheetData,
  type YearMonth,
  DEFAULT_COLUMNS,
  E0V1_MAP,
  IntegrityError,
  SUBTOTAL_COLUMNS,
  cellOf,
  distinctValues,
  distinctYearMonths,
  distinctYears,
  exportQuadri,
  filterQuadri,
  firstCessationPeriod,
  flattenRows,
  formatYearMonth,
  groupByYearWithSubtotals,
  resolveQuadriColumns,
  textOf,
  yearMonthOfRow,
} from '../lib/inps';
import { Alert, Card, Chip, ResetChip, formatInt } from './ui';

const STATI_NOTI = ['Corrente', 'Spento', 'Obsoleto', 'Annullato'];
const PAGE_SIZE = 50;

export default function QuadriPanel({ sheet }: { sheet: SheetData }) {
  const cols = useMemo(() => resolveQuadriColumns(sheet.columns), [sheet]);

  const [activeColumns, setActiveColumns] = useState<Set<string>>(() => {
    const defaults = DEFAULT_COLUMNS.filter(c => sheet.columns.includes(c));
    return new Set(defaults.length > 0 ? defaults : sheet.columns.slice(0, 14));
  });
  const [fromYM, setFromYM] = useState<YearMonth | null>(null);
  const [toYM, setToYM] = useState<YearMonth | null>(null);
  const [selectedTipologie, setSelectedTipologie] = useState<Set<string>>(new Set());
  const [selectedStati, setSelectedStati] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState<'auto' | 'on' | 'off'>('auto');
  const [showExcluded, setShowExcluded] = useState(false);
  const [page, setPage] = useState(0);

  const availableYears = useMemo(() => distinctYears(sheet.rows, cols.data), [sheet, cols]);
  const availableYearMonths = useMemo(() => distinctYearMonths(sheet.rows, cols.data), [sheet, cols]);
  const availableTipologie = useMemo(() => distinctValues(sheet.rows, cols.tipologia), [sheet, cols]);
  const availableStati = useMemo(() => {
    const present = distinctValues(sheet.rows, cols.stato);
    const set = new Set(present);
    return STATI_NOTI.filter(s => set.has(s)).concat(present.filter(s => !STATI_NOTI.includes(s)));
  }, [sheet, cols]);
  const cessazione = useMemo(() => firstCessationPeriod(sheet.rows, cols), [sheet, cols]);

  const filtered = useMemo(() => {
    try {
      return { ok: true as const, value: filterQuadri(sheet.rows, cols, {
        from: fromYM, to: toYM, tipologie: selectedTipologie, stati: selectedStati,
      }) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [sheet, cols, fromYM, toYM, selectedTipologie, selectedStati]);

  // Memoizzati: un array nuovo a ogni render invaliderebbe i useMemo a valle.
  const keptRows = useMemo(() => (filtered.ok ? filtered.value.kept : []), [filtered]);
  const excluded = useMemo(() => (filtered.ok ? filtered.value.excluded : []), [filtered]);

  const visibleCols = useMemo(
    () => sheet.columns.filter(c => activeColumns.has(c)),
    [sheet, activeColumns],
  );

  const yearsInSelection = useMemo(() => {
    const s = new Set<number>();
    for (const row of keptRows) {
      const ym = yearMonthOfRow(row, cols.data);
      if (ym) s.add(ym.year);
    }
    return s.size;
  }, [keptRows, cols]);

  const groupingActive = groupMode === 'on' || (groupMode === 'auto' && yearsInSelection >= 2);
  const subtotalColsInUse = useMemo(
    () => SUBTOTAL_COLUMNS.filter(c => visibleCols.includes(c)),
    [visibleCols],
  );

  const displayed = useMemo(() => {
    try {
      const entries: ExportRow[] = groupingActive
        ? groupByYearWithSubtotals(keptRows, visibleCols, cols.data)
        : flattenRows(keptRows);
      return { ok: true as const, value: entries };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [groupingActive, keptRows, visibleCols, cols]);

  const entries = displayed.ok ? displayed.value : [];
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageEntries = entries.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const [exportError, setExportError] = useState<string>('');

  const toggle = <T,>(setter: (fn: (prev: Set<T>) => Set<T>) => void, value: T) => {
    setter(prev => {
      const s = new Set(prev);
      if (s.has(value)) s.delete(value); else s.add(value);
      return s;
    });
    setPage(0);
  };

  const parseYm = (v: string): YearMonth | null => {
    if (!v) return null;
    const [y, m] = v.split('-').map(Number);
    if (!y || !m) return null;
    return { year: y, month: m };
  };
  const ymValue = (ym: YearMonth | null) => (ym ? `${ym.year}-${String(ym.month).padStart(2, '0')}` : '');

  const handleExport = () => {
    setExportError('');
    try {
      exportQuadri(entries, visibleCols, 'inps-estratto-e0-v1.xlsx');
    } catch (err) {
      setExportError(err instanceof IntegrityError
        ? `Export bloccato dal controllo di integrità: ${err.message}`
        : `Export non riuscito: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const integrityError = (!filtered.ok && filtered.error) || (!displayed.ok && displayed.error) || '';

  return (
    <div className="space-y-6">
      {integrityError && (
        <Alert tone="error" title="Controllo di integrità fallito — estrazione bloccata">
          <p>{integrityError}</p>
          <p>Nessun file viene prodotto finché l&apos;incoerenza non è risolta. Segnala il messaggio allo sviluppo.</p>
        </Alert>
      )}
      {exportError && <Alert tone="error" title="Export non eseguito"><p>{exportError}</p></Alert>}
      {filtered.ok && filtered.value.warnings.length > 0 && (
        <Alert tone="warning" title="Filtri parzialmente applicati">
          {filtered.value.warnings.map((w, i) => <p key={i}>{w}</p>)}
        </Alert>
      )}

      {/* Bilancio righe: tenute + escluse deve sempre fare il totale del foglio */}
      <Card
        title="Filtri righe"
        right={
          <span className="text-sm font-medium tabular-nums">
            <span className="bg-green-100 text-green-800 px-3 py-1 rounded-full">
              {formatInt(keptRows.length)} tenute
            </span>
            <span className="mx-1 text-gray-400">+</span>
            <span className="bg-gray-100 text-gray-700 px-3 py-1 rounded-full">
              {formatInt(excluded.length)} escluse
            </span>
            <span className="mx-1 text-gray-400">=</span>
            <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full">
              {formatInt(sheet.rows.length)} nel foglio
            </span>
          </span>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-2">
              Periodo (Data Inizio Periodo) —{' '}
              {fromYM || toYM
                ? `da ${fromYM ? formatYearMonth(fromYM) : 'inizio'} a ${toYM ? formatYearMonth(toYM) : 'fine'}`
                : 'tutto il periodo'}
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col text-xs text-gray-500">
                Da (mese/anno)
                <input
                  type="month"
                  value={ymValue(fromYM)}
                  onChange={e => { setFromYM(parseYm(e.target.value)); setPage(0); }}
                  className="border border-gray-300 rounded px-2 py-1 text-sm"
                />
              </label>
              <label className="flex flex-col text-xs text-gray-500">
                A (mese/anno)
                <input
                  type="month"
                  value={ymValue(toYM)}
                  onChange={e => { setToYM(parseYm(e.target.value)); setPage(0); }}
                  className="border border-gray-300 rounded px-2 py-1 text-sm"
                />
              </label>
              {(fromYM || toYM) && (
                <ResetChip onClick={() => { setFromYM(null); setToYM(null); setPage(0); }}>
                  Tutto il periodo
                </ResetChip>
              )}
            </div>

            <div className="flex flex-wrap gap-2 mt-3 items-center">
              {availableYearMonths.length > 0 && (
                <button
                  type="button"
                  onClick={() => { setFromYM(availableYearMonths[0]); setToYM(null); setPage(0); }}
                  className="px-2 py-1 rounded border text-xs bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                >
                  Da ultimo mese lavorato ({formatYearMonth(availableYearMonths[0])})
                </button>
              )}
              {cessazione && (
                <button
                  type="button"
                  onClick={() => { setFromYM(cessazione); setToYM(null); setPage(0); }}
                  className="px-2 py-1 rounded border text-xs bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100"
                >
                  Dalla cessazione ({formatYearMonth(cessazione)})
                </button>
              )}
              {availableYears.length > 0 && (
                <>
                  <span className="text-xs text-gray-400 ml-2">Anno intero:</span>
                  {availableYears.map(y => (
                    <button
                      key={y}
                      type="button"
                      onClick={() => { setFromYM({ year: y, month: 1 }); setToYM({ year: y, month: 12 }); setPage(0); }}
                      className="px-2 py-1 rounded border text-xs bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                    >{y}</button>
                  ))}
                </>
              )}
            </div>
          </div>

          {availableTipologie.length > 0 && (
            <div>
              <p className="text-sm text-gray-600 mb-2">
                Tipologia — {selectedTipologie.size === 0 ? 'tutte' : `${selectedTipologie.size} selezionate`}
              </p>
              <div className="flex flex-wrap gap-2">
                {availableTipologie.map(t => (
                  <Chip key={t} active={selectedTipologie.has(t)} onClick={() => toggle(setSelectedTipologie, t)}>
                    {t}
                  </Chip>
                ))}
                {selectedTipologie.size > 0 && (
                  <ResetChip onClick={() => { setSelectedTipologie(new Set()); setPage(0); }} />
                )}
              </div>
            </div>
          )}

          {availableStati.length > 0 && (
            <div>
              <p className="text-sm text-gray-600 mb-2">
                Stato — {selectedStati.size === 0 ? 'tutti (nessuna riga esclusa)' : `${selectedStati.size} selezionati`}
              </p>
              <div className="flex flex-wrap gap-2">
                {availableStati.map(s => (
                  <Chip key={s} active={selectedStati.has(s)} onClick={() => toggle(setSelectedStati, s)}>
                    {s}
                  </Chip>
                ))}
                {selectedStati.size > 0 && (
                  <ResetChip onClick={() => { setSelectedStati(new Set()); setPage(0); }} />
                )}
              </div>
            </div>
          )}

          <div>
            <p className="text-sm text-gray-600 mb-2">
              Subtotali per anno — {groupingActive ? 'attivi' : 'disattivi'}
              {groupingActive && subtotalColsInUse.length > 0 && (
                <span className="text-gray-400"> · somma: {subtotalColsInUse.join(', ')}</span>
              )}
              {groupingActive && subtotalColsInUse.length === 0 && (
                <span className="text-amber-600"> · nessuna colonna sommabile fra quelle attive</span>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {(['auto', 'on', 'off'] as const).map(m => (
                <Chip key={m} active={groupMode === m} onClick={() => { setGroupMode(m); setPage(0); }}>
                  {m === 'auto' ? `Auto (≥2 anni: ${yearsInSelection} presenti)` : m === 'on' ? 'Sempre' : 'Mai'}
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Registro delle esclusioni: ogni riga mancante ha un motivo consultabile */}
      {excluded.length > 0 && (
        <Card
          title={`Righe escluse dai filtri (${formatInt(excluded.length)})`}
          right={
            <button
              type="button"
              onClick={() => setShowExcluded(v => !v)}
              className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
            >
              {showExcluded ? 'Nascondi' : 'Mostra elenco'}
            </button>
          }
        >
          {showExcluded ? (
            <div className="overflow-x-auto max-h-80">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100 text-gray-700 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">Riga Excel</th>
                    <th className="px-3 py-2 text-left">Data Inizio</th>
                    <th className="px-3 py-2 text-left">Tipologia</th>
                    <th className="px-3 py-2 text-left">Stato</th>
                    <th className="px-3 py-2 text-left">Motivo esclusione</th>
                  </tr>
                </thead>
                <tbody>
                  {excluded.map(ex => (
                    <tr key={ex.row.__id} className="border-b border-gray-100">
                      <td className="px-3 py-1 tabular-nums text-gray-500">{ex.row.__id}</td>
                      <td className="px-3 py-1 whitespace-nowrap">{textOf(ex.row, cols.data)}</td>
                      <td className="px-3 py-1">{textOf(ex.row, cols.tipologia)}</td>
                      <td className="px-3 py-1">{textOf(ex.row, cols.stato)}</td>
                      <td className="px-3 py-1 text-gray-600">{ex.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              Nessuna riga viene scartata senza motivo: apri l&apos;elenco per verificare riga per riga.
            </p>
          )}
        </Card>
      )}

      <Card
        title="Selezione colonne"
        right={
          <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium">
            {activeColumns.size} attive / {sheet.columns.length} totali
          </span>
        }
      >
        <div className="flex flex-wrap gap-2 max-h-56 overflow-y-auto">
          {sheet.columns.map(col => (
            <label
              key={col}
              className={`flex items-center gap-1 px-3 py-1 rounded-full border cursor-pointer text-sm ${
                activeColumns.has(col)
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-300'
              }`}
            >
              <input
                type="checkbox"
                checked={activeColumns.has(col)}
                onChange={() => setActiveColumns(prev => {
                  const s = new Set(prev);
                  if (s.has(col)) s.delete(col); else s.add(col);
                  return s;
                })}
                className="hidden"
              />
              {E0V1_MAP[col] && <span className="font-bold">{E0V1_MAP[col]}</span>}
              <span>{col}</span>
            </label>
          ))}
        </div>
      </Card>

      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="min-w-full text-sm">
            <thead className="bg-blue-700 text-white sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left whitespace-nowrap" title="Riga nel file INPS di origine">Riga</th>
                {visibleCols.map(col => (
                  <th key={col} className="px-3 py-2 text-left whitespace-nowrap">
                    {E0V1_MAP[col] ? <span className="font-bold">{E0V1_MAP[col]}</span> : col}
                    {E0V1_MAP[col] && <span className="ml-1 opacity-70 text-xs">{col}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageEntries.map((entry, i) => {
                const isSub = entry.kind === 'subtotal';
                const key = isSub ? `sub-${entry.year}` : `row-${entry.row!.__id}`;
                return (
                  <tr
                    key={key}
                    className={isSub
                      ? 'bg-amber-50 font-semibold border-t-2 border-amber-300'
                      : (i % 2 === 0 ? 'bg-white' : 'bg-gray-50')}
                  >
                    <td className="px-3 py-1 border-b border-gray-100 tabular-nums text-gray-400 whitespace-nowrap">
                      {isSub ? '' : entry.row!.__id}
                    </td>
                    {visibleCols.map(col => {
                      const v = isSub ? (entry.values?.[col] ?? null) : cellOf(entry.row!, col);
                      return (
                        <td key={col} className="px-3 py-1 border-b border-gray-100 whitespace-nowrap">
                          {v == null ? '' : String(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {pageEntries.length === 0 && (
                <tr>
                  <td colSpan={visibleCols.length + 1} className="px-3 py-6 text-center text-gray-400">
                    Nessuna riga corrisponde ai filtri.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t">
          <span className="text-sm text-gray-500 tabular-nums">
            {formatInt(keptRows.length)} righe
            {groupingActive ? ` + ${formatInt(entries.length - keptRows.length)} subtotali` : ''}
            {' '}| Pagina {safePage + 1} di {totalPages}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
              className="px-3 py-1 rounded border text-sm disabled:opacity-40">&#8592; Prec</button>
            <button type="button" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
              className="px-3 py-1 rounded border text-sm disabled:opacity-40">Succ &#8594;</button>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleExport}
          disabled={keptRows.length === 0 || visibleCols.length === 0 || Boolean(integrityError)}
          className="bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
        >
          &#128229; Genera file scaricabile (.xlsx)
        </button>
      </div>
    </div>
  );
}
