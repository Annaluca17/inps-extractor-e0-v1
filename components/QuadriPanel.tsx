'use client';
import { useMemo, useState } from 'react';
import {
  type ExportRow,
  type SheetData,
  type SortDirection,
  type YearMonth,
  DEFAULT_COLUMNS,
  E0V1_MAP,
  IntegrityError,
  SUBTOTAL_COLUMNS,
  cellOf,
  columnValueCounts,
  distinctValues,
  distinctYearMonths,
  distinctYears,
  exportQuadri,
  filterQuadri,
  firstCessationPeriod,
  flattenRows,
  formatYearMonth,
  groupByYearWithSubtotals,
  nonEmptyColumns,
  resolveQuadriColumns,
  sortByPeriod,
  textOf,
  yearMonthOfRow,
} from '../lib/inps';
import {
  clearColumnPreset,
  initialColumnSelection,
  loadColumnPreset,
  missingPresetColumns,
  saveColumnPreset,
} from '../lib/preferences';
import { type Causale, CAUSALI, buildUniemensPayload, downloadPayload } from '../lib/uniemens';
import ColumnFilterPanel from './ColumnFilterPanel';
import { Alert, Card, Chip, ResetChip, formatInt } from './ui';

const STATI_NOTI = ['Corrente', 'Spento', 'Obsoleto', 'Annullato'];
const PAGE_SIZE = 50;

export default function QuadriPanel({ sheet }: { sheet: SheetData }) {
  const cols = useMemo(() => resolveQuadriColumns(sheet.columns), [sheet]);

  // Colonne popolate nel file: sono quelle preselezionate. Le colonne senza
  // alcun valore restano spente, così l'export non porta colonne vuote.
  const valueCounts = useMemo(() => columnValueCounts(sheet.rows, sheet.columns), [sheet]);
  const withData = useMemo(() => nonEmptyColumns(sheet.rows, sheet.columns), [sheet]);

  // Il pannello si monta solo dopo il caricamento del file, quindi siamo già
  // lato browser e le preferenze si possono leggere subito (loadColumnPreset
  // è comunque difeso contro l'assenza di window).
  const [preset, setPreset] = useState<string[] | null>(() => loadColumnPreset());
  const [activeColumns, setActiveColumns] = useState<Set<string>>(
    () => initialColumnSelection(sheet.columns, withData, preset),
  );
  const [presetNotice, setPresetNotice] = useState('');

  const presetMissing = useMemo(
    () => missingPresetColumns(sheet.columns, preset),
    [sheet, preset],
  );
  const [fromYM, setFromYM] = useState<YearMonth | null>(null);
  const [toYM, setToYM] = useState<YearMonth | null>(null);
  const [selectedTipologie, setSelectedTipologie] = useState<Set<string>>(new Set());
  const [selectedStati, setSelectedStati] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState<'auto' | 'on' | 'off'>('auto');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [subtotalsAsFormula, setSubtotalsAsFormula] = useState(true);
  const [includeRowId, setIncludeRowId] = useState(true);
  const [showExcluded, setShowExcluded] = useState(false);
  const [page, setPage] = useState(0);

  // Filtri sulle intestazioni: colonna → valori ammessi.
  const [columnFilters, setColumnFilters] = useState<Map<string, Set<string>>>(new Map());
  const [openFilter, setOpenFilter] = useState<string | null>(null);

  const setColumnFilter = (column: string, values: Set<string>) => {
    setColumnFilters(prev => {
      const next = new Map(prev);
      if (values.size === 0) next.delete(column);
      else next.set(column, values);
      return next;
    });
    setPage(0);
  };

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
        from: fromYM, to: toYM, tipologie: selectedTipologie, stati: selectedStati, columnFilters,
      }) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [sheet, cols, fromYM, toYM, selectedTipologie, selectedStati, columnFilters]);

  // Memoizzati: un array nuovo a ogni render invaliderebbe i useMemo a valle.
  const filteredRows = useMemo(() => (filtered.ok ? filtered.value.kept : []), [filtered]);
  const excluded = useMemo(() => (filtered.ok ? filtered.value.excluded : []), [filtered]);

  // Ordinamento per Data Inizio, poi Data Fine. Passo separato dal filtro:
  // il filtro non può riordinare, il sort non può aggiungere o togliere righe.
  const keptRows = useMemo(
    () => sortByPeriod(filteredRows, cols.data, cols.dataFine, sortDirection),
    [filteredRows, cols, sortDirection],
  );

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
  const [causale, setCausale] = useState<Causale>('5');

  const handleExportJson = () => {
    setExportError('');
    try {
      const payload = buildUniemensPayload(keptRows, sheet, cols, causale);
      downloadPayload(payload, `uniemens-c${causale}.json`);
    } catch (err) {
      setExportError(`Export JSON non riuscito: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

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
      exportQuadri(entries, visibleCols, 'inps-estratto-e0-v1.xlsx', { includeRowId, subtotalsAsFormula });
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
              Ordinamento — Data Inizio Periodo, poi Data Fine Periodo
            </p>
            <div className="flex flex-wrap gap-2">
              {([['desc', 'Decrescente (dal più recente)'], ['asc', 'Crescente (dal più vecchio)']] as [SortDirection, string][]).map(([d, label]) => (
                <Chip key={d} active={sortDirection === d} onClick={() => { setSortDirection(d); setPage(0); }}>
                  {label}
                </Chip>
              ))}
            </div>
          </div>

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
          <span className="text-sm font-medium tabular-nums">
            <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full">
              {activeColumns.size} attive / {sheet.columns.length}
            </span>
            <span className="ml-2 bg-gray-100 text-gray-600 px-3 py-1 rounded-full">
              {sheet.columns.length - withData.length} senza dati
            </span>
          </span>
        }
      >
        {presetMissing.length > 0 && (
          <div className="mb-3">
            <Alert tone="warning" title="Colonne predefinite non presenti in questo file">
              <p>{presetMissing.join(', ')}</p>
            </Alert>
          </div>
        )}
        {presetNotice && <p className="mb-3 text-sm text-green-700">{presetNotice}</p>}

        <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-gray-100">
          <span className="text-xs text-gray-400">Selezione rapida:</span>
          <ResetChip onClick={() => setActiveColumns(new Set(withData))}>Solo colonne con dati</ResetChip>
          <ResetChip onClick={() => setActiveColumns(new Set(DEFAULT_COLUMNS.filter(c => sheet.columns.includes(c))))}>
            Colonne principali
          </ResetChip>
          <ResetChip onClick={() => setActiveColumns(new Set(sheet.columns))}>Tutte</ResetChip>
          <ResetChip onClick={() => setActiveColumns(new Set())}>Nessuna</ResetChip>

          <span className="w-px h-5 bg-gray-200 mx-1" />
          <span className="text-xs text-gray-400">
            Predefinite{preset ? ` (${preset.length} salvate)` : ' (nessuna salvata)'}:
          </span>
          <button
            type="button"
            onClick={() => {
              const cols = sheet.columns.filter(c => activeColumns.has(c));
              const ok = saveColumnPreset(cols);
              setPreset(ok ? cols : preset);
              setPresetNotice(ok
                ? `Salvate ${cols.length} colonne come predefinite: saranno sempre attive, anche se vuote.`
                : 'Salvataggio non riuscito: il browser non consente la memorizzazione locale.');
            }}
            className="px-3 py-1 rounded-full border text-sm bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
          >
            Salva la selezione attuale
          </button>
          {preset && (
            <>
              <ResetChip onClick={() => setActiveColumns(new Set(preset.filter(c => sheet.columns.includes(c))))}>
                Solo le predefinite
              </ResetChip>
              <ResetChip onClick={() => {
                clearColumnPreset();
                setPreset(null);
                setPresetNotice('Predefinite cancellate.');
              }}>
                Cancella predefinite
              </ResetChip>
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-2 max-h-64 overflow-y-auto">
          {sheet.columns.map(col => {
            const count = valueCounts.get(col) ?? 0;
            const empty = count === 0;
            const pinned = preset?.includes(col) ?? false;
            const active = activeColumns.has(col);
            return (
              <label
                key={col}
                title={empty ? 'Nessun valore in questo file' : `${formatInt(count)} valori su ${formatInt(sheet.rows.length)} righe`}
                className={`flex items-center gap-1 px-3 py-1 rounded-full border cursor-pointer text-sm ${
                  active
                    ? 'bg-blue-600 text-white border-blue-600'
                    : empty
                      ? 'bg-gray-50 text-gray-400 border-gray-200 border-dashed'
                      : 'bg-white text-gray-600 border-gray-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() => setActiveColumns(prev => {
                    const s = new Set(prev);
                    if (s.has(col)) s.delete(col); else s.add(col);
                    return s;
                  })}
                  className="hidden"
                />
                {pinned && <span title="Colonna predefinita">&#128204;</span>}
                {E0V1_MAP[col] && <span className="font-bold">{E0V1_MAP[col]}</span>}
                <span>{col}</span>
                <span className={active ? 'text-blue-200 text-xs' : 'text-gray-400 text-xs'}>
                  {empty ? 'vuota' : formatInt(count)}
                </span>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-gray-400 mt-3">
          Le colonne popolate sono già selezionate, quelle senza alcun valore restano spente (tratteggiate).
          Le predefinite (&#128204;) restano attive a ogni caricamento, anche se nel file sono vuote.
          Nel file esportato l&apos;intestazione è la sigla breve quando esiste, per non avere colonne più larghe del dato.
        </p>
      </Card>

      <div className="bg-white rounded-xl shadow overflow-hidden">
        {(columnFilters.size > 0 || openFilter) && (
          <div className="p-4 pb-0">
            {columnFilters.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <span className="text-xs text-gray-400">Filtri di colonna attivi:</span>
                {Array.from(columnFilters.entries()).map(([col, values]) => (
                  <span
                    key={col}
                    className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 rounded-full pl-3 pr-1 py-1 text-xs"
                    title={Array.from(values).join(', ')}
                  >
                    <button type="button" className="hover:underline" onClick={() => setOpenFilter(col)}>
                      {E0V1_MAP[col] ?? col}: {values.size === 1 ? (Array.from(values)[0] || '(vuoto)') : `${values.size} valori`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setColumnFilter(col, new Set())}
                      className="w-4 h-4 rounded-full hover:bg-blue-200 leading-none"
                      aria-label={`Rimuovi filtro su ${col}`}
                    >&times;</button>
                  </span>
                ))}
                <ResetChip onClick={() => { setColumnFilters(new Map()); setPage(0); }}>Azzera tutti</ResetChip>
              </div>
            )}
            {openFilter && (
              <ColumnFilterPanel
                column={openFilter}
                rows={sheet.rows}
                selected={columnFilters.get(openFilter)}
                onChange={values => setColumnFilter(openFilter, values)}
                onClose={() => setOpenFilter(null)}
              />
            )}
          </div>
        )}

        <div className="overflow-x-auto max-h-[60vh]">
          <table className="min-w-full text-sm">
            <thead className="bg-blue-700 text-white sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left whitespace-nowrap" title="Riga nel file INPS di origine">Riga</th>
                {visibleCols.map(col => {
                  const filtered = columnFilters.has(col);
                  return (
                    <th key={col} className="px-3 py-2 text-left whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        <span>
                          {E0V1_MAP[col] ? <span className="font-bold">{E0V1_MAP[col]}</span> : col}
                          {E0V1_MAP[col] && <span className="ml-1 opacity-70 text-xs">{col}</span>}
                        </span>
                        <button
                          type="button"
                          onClick={() => setOpenFilter(prev => (prev === col ? null : col))}
                          title={filtered ? `Filtro attivo su ${col}` : `Filtra ${col}`}
                          aria-label={`Filtra ${col}`}
                          className={`px-1 rounded text-xs leading-none ${
                            filtered ? 'bg-amber-300 text-amber-900' : 'text-white/60 hover:text-white hover:bg-blue-600'
                          }`}
                        >
                          &#9660;
                        </button>
                      </span>
                    </th>
                  );
                })}
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

      <Card title="Opzioni di export">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={includeRowId} onChange={() => setIncludeRowId(v => !v)} />
              <span>
                Colonna <span className="font-semibold">Riga</span> con il numero di riga del file INPS
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={subtotalsAsFormula} onChange={() => setSubtotalsAsFormula(v => !v)} />
              <span>
                Subtotali come <span className="font-mono text-xs bg-gray-100 px-1 rounded">SUBTOTAL(9;…)</span>{' '}
                invece che come valore fisso
              </span>
            </label>
            <p className="text-xs text-gray-500 max-w-xl">
              Il foglio esportato ha sempre il filtro automatico sulla riga di intestazione. Con i subtotali come
              formula, aggiungendo o togliendo righe in Excel i totali si aggiornano da soli, e le righe nascoste
              dal filtro non vengono conteggiate.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              {CAUSALI.map(c => (
                <Chip key={c.code} active={causale === c.code} onClick={() => setCausale(c.code)} title={c.hint}>
                  {c.label}
                </Chip>
              ))}
              <button
                type="button"
                onClick={handleExportJson}
                disabled={keptRows.length === 0 || Boolean(integrityError)}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-5 py-2 rounded-lg font-semibold transition-colors"
              >
                &#8631; UniEmens Builder (.json)
              </button>
            </div>
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
      </Card>
    </div>
  );
}
