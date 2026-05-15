'use client';
import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_COLUMNS,
  E0V1_MAP,
  InpsRow,
  distinctValues,
  distinctYears,
  exportXlsx,
  filterRows,
  parseInpsWorkbook,
} from '../lib/inps';

type Step = 'upload' | 'preview' | 'export';

export default function Home() {
  const [step, setStep] = useState<Step>('upload');
  const [rows, setRows] = useState<InpsRow[]>([]);
  const [allColumns, setAllColumns] = useState<string[]>([]);
  const [activeColumns, setActiveColumns] = useState<Set<string>>(new Set());
  const [selectedYears, setSelectedYears] = useState<Set<number>>(new Set());
  const [selectedTipologie, setSelectedTipologie] = useState<Set<string>>(new Set());
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
        setSelectedYears(new Set());
        setSelectedTipologie(new Set());
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

  const toggleYear = (y: number) => {
    setSelectedYears(prev => {
      const s = new Set(prev);
      if (s.has(y)) s.delete(y); else s.add(y);
      return s;
    });
    setPage(0);
  };

  const toggleTipologia = (t: string) => {
    setSelectedTipologie(prev => {
      const s = new Set(prev);
      if (s.has(t)) s.delete(t); else s.add(t);
      return s;
    });
    setPage(0);
  };

  const availableYears = useMemo(() => distinctYears(rows), [rows]);
  const availableTipologie = useMemo(() => distinctValues(rows, 'Tipologia'), [rows]);

  const filteredRows = useMemo(
    () => filterRows(rows, { years: selectedYears, tipologie: selectedTipologie }),
    [rows, selectedYears, selectedTipologie],
  );

  const visibleCols = useMemo(
    () => allColumns.filter(c => activeColumns.has(c)),
    [allColumns, activeColumns],
  );

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pagedRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const handleExport = () => {
    exportXlsx(filteredRows, visibleCols, 'inps-estratto-e0-v1.xlsx');
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
                Anno (Data Inizio Periodo) — {selectedYears.size === 0 ? 'tutti' : `${selectedYears.size} selezionati`}
              </p>
              <div className="flex flex-wrap gap-2">
                {availableYears.map(y => (
                  <button
                    key={y}
                    onClick={() => toggleYear(y)}
                    className={`px-3 py-1 rounded-full border text-sm ${
                      selectedYears.has(y) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >{y}</button>
                ))}
                {selectedYears.size > 0 && (
                  <button
                    onClick={() => { setSelectedYears(new Set()); setPage(0); }}
                    className="px-3 py-1 rounded-full border text-sm bg-gray-100 text-gray-600 border-gray-300"
                  >Reset</button>
                )}
              </div>
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-2">
                Tipologia — {selectedTipologie.size === 0 ? 'tutte' : `${selectedTipologie.size} selezionate`}
              </p>
              <div className="flex flex-wrap gap-2">
                {availableTipologie.map(t => (
                  <button
                    key={t}
                    onClick={() => toggleTipologia(t)}
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
                  {pagedRows.map((row, ri) => (
                    <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      {visibleCols.map(col => (
                        <td key={col} className="px-3 py-1 border-b border-gray-100 whitespace-nowrap">
                          {row[col]?.toString() ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
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
                {filteredRows.length} righe filtrate | Pagina {page+1} di {totalPages}
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
