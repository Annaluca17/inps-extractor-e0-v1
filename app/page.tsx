'use client';
import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_COLUMNS,
  E0V1_MAP,
  InpsRow,
  SUBTOTAL_COLUMNS,
  YearMonth,
  distinctValues,
  distinctYearMonths,
  distinctYears,
  exportXlsxGrouped,
  filterRows,
  groupByYearWithSubtotals,
  parseInpsWorkbook,
  yearOf,
} from '../lib/inps';

const MONTH_NAMES = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const STATI_NOTI = ['Corrente', 'Spento', 'Obsoleto'];

type Step = 'upload' | 'preview' | 'export';

export default function Home() {
  const [step, setStep] = useState<Step>('upload');
  const [rows, setRows] = useState<InpsRow[]>([]);
  const [allColumns, setAllColumns] = useState<string[]>([]);
  const [activeColumns, setActiveColumns] = useState<Set<string>>(new Set());
  const [fromYM, setFromYM] = useState<YearMonth | null>(null);
  const [toYM, setToYM] = useState<YearMonth | null>(null);
  const [selectedTipologie, setSelectedTipologie] = useState<Set<string>>(new Set());
  const [selectedStati, setSelectedStati] = useState<Set<string>>(new Set());
  const [groupByYearMode, setGroupByYearMode] = useState<'auto' | 'on' | 'off'>('auto');
  const [error, setError] = useState<string>('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const processFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError('Errore: carica solo file .xlsx');
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target?.result as ArrayBuffer;
        const { rows, columns, warnings } = parseInpsWorkbook(buffer);
        if (rows.length === 0) {
          setError('File vuoto o intestazioni non riconosciute.');
          return;
        }
        setRows(rows);
        setAllColumns(columns);
        const defaults = DEFAULT_COLUMNS.filter(c => columns.includes(c));
        setActiveColumns(new Set(defaults.length > 0 ? defaults : columns.slice(0, 14)));
        setFromYM(null);
        setToYM(null);
        setSelectedTipologie(new Set());
        setSelectedStati(new Set());
        setWarnings(warnings);
        setPage(0);
        setStep('preview');
      } catch (err) {
        console.error(err);
        setError('Impossibile leggere il file XLSX. Verifica che non sia corrotto.');
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const toggleColumn = (col: string) => {
    setActiveColumns(prev => {
      const s = new Set(prev);
      if (s.has(col)) s.delete(col); else s.add(col);
      return s;
    });
  };

  const toggleSetItem = <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) => {
    setter(prev => {
      const s = new Set(prev);
      if (s.has(value)) s.delete(value); else s.add(value);
      return s;
    });
    setPage(0);
  };

  const availableYears = useMemo(() => distinctYears(rows), [rows]);
  const availableYearMonths = useMemo(() => distinctYearMonths(rows), [rows]);
  const availableTipologie = useMemo(() => distinctValues(rows, 'Tipologia'), [rows]);
  const availableStati = useMemo(() => {
    const present = distinctValues(rows, 'Correnti, obsoleti, …');
    const presentSet = new Set(present);
    const known = STATI_NOTI.filter(s => presentSet.has(s));
    const extras = present.filter(s => !STATI_NOTI.includes(s));
    return known.concat(extras);
  }, [rows]);

  const filteredRows = useMemo(
    () => filterRows(rows, {
      from: fromYM ?? undefined,
      to: toYM ?? undefined,
      tipologie: selectedTipologie,
      stati: selectedStati,
    }),
    [rows, fromYM, toYM, selectedTipologie, selectedStati],
  );

  const parseYmInput = (v: string): YearMonth | null => {
    if (!v) return null;
    const [y, m] = v.split('-').map(Number);
    if (!y || !m) return null;
    return { year: y, month: m };
  };
  const ymToInputValue = (ym: YearMonth | null): string =>
    ym ? `${ym.year}-${String(ym.month).padStart(2, '0')}` : '';

  const visibleCols = useMemo(
    () => allColumns.filter(c => activeColumns.has(c)),
    [allColumns, activeColumns],
  );

  const distinctYearsInFiltered = useMemo(() => {
    const s = new Set<number>();
    for (const r of filteredRows) { const y = yearOf(r); if (y != null) s.add(y); }
    return s.size;
  }, [filteredRows]);

  const groupingActive = groupByYearMode === 'on'
    || (groupByYearMode === 'auto' && distinctYearsInFiltered >= 2);

  const subtotalColsInUse = useMemo(
    () => SUBTOTAL_COLUMNS.filter(c => visibleCols.includes(c)),
    [visibleCols],
  );

  const displayedRows = useMemo(
    () => groupingActive
      ? groupByYearWithSubtotals(filteredRows, visibleCols)
      : filteredRows.map(r => ({ kind: 'data' as const, row: r })),
    [groupingActive, filteredRows, visibleCols],
  );

  const totalPages = Math.max(1, Math.ceil(displayedRows.length / PAGE_SIZE));
  const pagedRows = displayedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleExport = () => {
    const grouped = groupingActive
      ? groupByYearWithSubtotals(filteredRows, visibleCols)
      : filteredRows.map(r => ({ kind: 'data' as const, row: r }));
    exportXlsxGrouped(grouped, visibleCols, 'inps-estratto-e0-v1.xlsx');
  };

  return (
    <main className="max-w-7xl mx-auto p-4 md:p-8">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-blue-800">INPS Extractor — Quadri E0/V1</h1>
        <p className="text-gray-500 mt-1">Estrazione selettiva righe e colonne da file INPS PASSWEB · Immedia S.p.A.</p>
      </div>

      <div className="flex items-center justify-center gap-2 mb-8">
        {(['upload','preview','export'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold ${
              step === s ? 'bg-blue-600 text-white' : (step === 'preview' && s === 'upload') || step === 'export' ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
            }`}>{i+1}</div>
            <span className={`text-sm font-medium ${ step === s ? 'text-blue-700' : 'text-gray-400'}`}>
              {s === 'upload' ? 'Carica file' : s === 'preview' ? 'Filtri & anteprima' : 'Esporta XLSX'}
            </span>
            {i < 2 && <span className="text-gray-300">›</span>}
          </div>
        ))}
      </div>

      {step === 'upload' && (
        <div
          className="border-2 border-dashed border-blue-300 rounded-2xl p-12 text-center bg-white hover:border-blue-500 transition-colors cursor-pointer"
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
        >
          <div className="text-6xl mb-4">&#128196;</div>
          <p className="text-xl font-semibold text-gray-700 mb-2">Trascina qui il file INPS PASSWEB (.xlsx)</p>
          <p className="text-gray-400 mb-6">oppure</p>
          <label className="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium transition-colors">
            Carica il file INPS (.xlsx)
            <input type="file" accept=".xlsx" onChange={handleChange} className="hidden" />
          </label>
          {error && <p className="mt-4 text-red-600 font-medium">{error}</p>}
        </div>
      )}

      {step === 'preview' && (
        <div className="space-y-6">
          {warnings.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
              <p className="font-semibold text-yellow-800">Avvisi:</p>
              {warnings.map((w, i) => <p key={i} className="text-yellow-700 text-sm">{w}</p>)}
            </div>
          )}

          {/* Filtri righe */}
          <div className="bg-white rounded-xl shadow p-4 space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="font-semibold text-gray-800">Filtri righe</h2>
              <span className="bg-green-100 text-green-800 px-3 py-1 rounded-full text-sm font-medium">
                {filteredRows.length} righe filtrate / {rows.length} totali
              </span>
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-2">
                Periodo (Data Inizio Periodo) — {fromYM || toYM ? `da ${fromYM ? `${MONTH_NAMES[fromYM.month-1]} ${fromYM.year}` : '—'} a ${toYM ? `${MONTH_NAMES[toYM.month-1]} ${toYM.year}` : '—'}` : 'tutto'}
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col text-xs text-gray-500">
                  Da (mese/anno)
                  <input
                    type="month"
                    value={ymToInputValue(fromYM)}
                    onChange={e => { setFromYM(parseYmInput(e.target.value)); setPage(0); }}
                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                </label>
                <label className="flex flex-col text-xs text-gray-500">
                  A (mese/anno)
                  <input
                    type="month"
                    value={ymToInputValue(toYM)}
                    onChange={e => { setToYM(parseYmInput(e.target.value)); setPage(0); }}
                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                  />
                </label>
                {(fromYM || toYM) && (
                  <button
                    onClick={() => { setFromYM(null); setToYM(null); setPage(0); }}
                    className="px-3 py-1 rounded-full border text-sm bg-gray-100 text-gray-600 border-gray-300"
                  >Reset periodo</button>
                )}
              </div>
              {availableYears.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  <span className="text-xs text-gray-400 self-center">Anno intero:</span>
                  {availableYears.map(y => (
                    <button
                      key={y}
                      onClick={() => { setFromYM({ year: y, month: 1 }); setToYM({ year: y, month: 12 }); setPage(0); }}
                      className="px-2 py-1 rounded border text-xs bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                    >{y}</button>
                  ))}
                  {availableYearMonths.length > 0 && (
                    <button
                      onClick={() => {
                        const last = availableYearMonths[0];
                        setFromYM(last); setToYM(null); setPage(0);
                      }}
                      className="px-2 py-1 rounded border text-xs bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
                    >Da ultimo mese lavorato ({MONTH_NAMES[availableYearMonths[0].month-1]} {availableYearMonths[0].year})</button>
                  )}
                </div>
              )}
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-2">
                Tipologia — {selectedTipologie.size === 0 ? 'tutte' : `${selectedTipologie.size} selezionate`}
              </p>
              <div className="flex flex-wrap gap-2">
                {availableTipologie.map(t => (
                  <button
                    key={t}
                    onClick={() => toggleSetItem(setSelectedTipologie, t)}
                    className={`px-3 py-1 rounded-full border text-sm ${
                      selectedTipologie.has(t) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >{t}</button>
                ))}
                {selectedTipologie.size > 0 && (
                  <button
                    onClick={() => { setSelectedTipologie(new Set()); setPage(0); }}
                    className="px-3 py-1 rounded-full border text-sm bg-gray-100 text-gray-600 border-gray-300"
                  >Reset</button>
                )}
              </div>
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-2">
                Stato — {selectedStati.size === 0 ? 'tutti' : `${selectedStati.size} selezionati`}
              </p>
              <div className="flex flex-wrap gap-2">
                {availableStati.map(s => (
                  <button
                    key={s}
                    onClick={() => toggleSetItem(setSelectedStati, s)}
                    className={`px-3 py-1 rounded-full border text-sm ${
                      selectedStati.has(s) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >{s}</button>
                ))}
                {selectedStati.size > 0 && (
                  <button
                    onClick={() => { setSelectedStati(new Set()); setPage(0); }}
                    className="px-3 py-1 rounded-full border text-sm bg-gray-100 text-gray-600 border-gray-300"
                  >Reset</button>
                )}
              </div>
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-2">
                Raggruppamento per anno (Data Inizio Periodo) con subtotali —{' '}
                {groupingActive ? 'attivo' : 'disattivo'}
                {groupingActive && subtotalColsInUse.length > 0 && (
                  <span className="text-gray-400"> · somma: {subtotalColsInUse.join(', ')}</span>
                )}
                {groupingActive && subtotalColsInUse.length === 0 && (
                  <span className="text-amber-600"> · nessuna colonna sommabile tra quelle attive</span>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {(['auto','on','off'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => { setGroupByYearMode(m); setPage(0); }}
                    className={`px-3 py-1 rounded-full border text-sm ${
                      groupByYearMode === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >{m === 'auto' ? `Auto (≥2 anni: ${distinctYearsInFiltered} presenti)` : m === 'on' ? 'Sempre' : 'Mai'}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Selezione colonne */}
          <div className="bg-white rounded-xl shadow p-4">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold text-gray-800">Selezione colonne</h2>
              <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium">
                {activeColumns.size} colonne attive / {allColumns.length} totali
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {allColumns.map(col => (
                <label key={col} className={`flex items-center gap-1 px-3 py-1 rounded-full border cursor-pointer text-sm ${
                  activeColumns.has(col) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'
                }`}>
                  <input type="checkbox" checked={activeColumns.has(col)} onChange={() => toggleColumn(col)} className="hidden" />
                  {E0V1_MAP[col] ? <span className="font-bold">{E0V1_MAP[col]}</span> : null}
                  <span>{col}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Tabella dati */}
          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="overflow-x-auto max-h-[60vh]">
              <table className="min-w-full text-sm">
                <thead className="bg-blue-700 text-white sticky top-0">
                  <tr>
                    {visibleCols.map(col => (
                      <th key={col} className="px-3 py-2 text-left whitespace-nowrap">
                        {E0V1_MAP[col] ? <span className="font-bold">{E0V1_MAP[col]}</span> : col}
                        {E0V1_MAP[col] && <span className="ml-1 opacity-70 text-xs">{col}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((entry, ri) => {
                    const isSub = entry.kind === 'subtotal';
                    const rowCls = isSub
                      ? 'bg-amber-50 font-semibold border-t-2 border-amber-300'
                      : (ri % 2 === 0 ? 'bg-white' : 'bg-gray-50');
                    return (
                      <tr key={ri} className={rowCls}>
                        {visibleCols.map(col => (
                          <td key={col} className="px-3 py-1 border-b border-gray-100 whitespace-nowrap">
                            {entry.row[col]?.toString() ?? ''}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                  {pagedRows.length === 0 && (
                    <tr>
                      <td colSpan={Math.max(1, visibleCols.length)} className="px-3 py-6 text-center text-gray-400">
                        Nessuna riga corrisponde ai filtri.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t">
              <span className="text-sm text-gray-500">
                {filteredRows.length} righe filtrate{groupingActive ? ` + ${displayedRows.length - filteredRows.length} subtotali` : ''} | Pagina {page+1} di {totalPages}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(0, p-1))} disabled={page===0}
                  className="px-3 py-1 rounded border text-sm disabled:opacity-40">&#8592; Prec</button>
                <button onClick={() => setPage(p => Math.min(totalPages-1, p+1))} disabled={page>=totalPages-1}
                  className="px-3 py-1 rounded border text-sm disabled:opacity-40">Succ &#8594;</button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 justify-between">
            <button onClick={() => setStep('upload')}
              className="px-6 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors">
              &#8592; Cambia file
            </button>
            <button onClick={handleExport}
              disabled={filteredRows.length === 0 || visibleCols.length === 0}
              className="bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white px-8 py-3 rounded-lg font-semibold flex items-center gap-2 transition-colors">
              &#128229; Genera file scaricabile (.xlsx)
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
