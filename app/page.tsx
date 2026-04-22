'use client';
import { useState, useCallback } from 'react';
import { read, utils, writeFileXLSX } from 'xlsx';

// Tipo base per le righe INPS
export type InpsRow = Record<string, string | number | null>;

// Mappa colonne E0/V1: nome nel file PASSWEB -> etichetta leggibile
const E0V1_MAP: Record<string, string> = {
  'Codice Fiscale': 'CF',
  'Matricola': 'MATR',
  'Cognome': 'COGN',
  'Nome': 'NOME',
  'Data Nascita': 'DT_NASC',
  'Data Inizio': 'DT_INIZ',
  'Data Fine': 'DT_FINE',
  'Imponibile CTPS': 'IMP_CTPS',
  'Contributo CTPS': 'CONTRIB_CTPS',
  'Qualifica': 'QUALIF',
  'Causale Variazione': 'CAUS_VARI',
  'Tipo Rapporto': 'TIPO_RAPP',
  'Giorni': 'GG',
  'Ore': 'ORE',
};

type Step = 'upload' | 'preview' | 'export';

export default function Home() {
  const [step, setStep] = useState<Step>('upload');
  const [rows, setRows] = useState<InpsRow[]>([]);
  const [allColumns, setAllColumns] = useState<string[]>([]);
  const [activeColumns, setActiveColumns] = useState<Set<string>>(new Set());
  const [editedRows, setEditedRows] = useState<InpsRow[]>([]);
  const [error, setError] = useState<string>('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  // Parsing del file XLSX con SheetJS
  const processFile = useCallback((file: File) => {
    if (!file.name.endsWith('.xlsx')) {
      setError('Errore: carica solo file .xlsx');
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result as ArrayBuffer;
        // Leggi il workbook dal buffer
        const wb = read(data, { type: 'array' });
        const wsName = wb.SheetNames[0];
        const ws = wb.Sheets[wsName];
        // Converti in array di oggetti (prima riga = intestazioni)
        const jsonRaw = utils.sheet_to_json<Record<string, any>>(ws, { defval: null });
        if (jsonRaw.length === 0) { setError('File vuoto o non leggibile.'); return; }
        const cols = Object.keys(jsonRaw[0]);
        // Determina colonne attive (intersezione con mappa E0/V1)
        const found = Object.keys(E0V1_MAP).filter(k => cols.includes(k));
        const missing = Object.keys(E0V1_MAP).filter(k => !cols.includes(k));
        const warn: string[] = [];
        if (missing.length > 0) warn.push('Colonne non trovate nel file: ' + missing.join(', '));
        setWarnings(warn);
        setRows(jsonRaw as InpsRow[]);
        setEditedRows(jsonRaw as InpsRow[]);
        setAllColumns(cols);
        setActiveColumns(new Set(found.length > 0 ? found : cols.slice(0, 14)));
        setStep('preview');
      } catch {
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
    const s = new Set(activeColumns);
    s.has(col) ? s.delete(col) : s.add(col);
    setActiveColumns(s);
  };

  const updateCell = (rowIdx: number, col: string, val: string) => {
    const r = [...editedRows];
    r[rowIdx] = { ...r[rowIdx], [col]: val };
    setEditedRows(r);
  };

  // Esportazione XLSX con SheetJS
  const handleExport = () => {
    const cols = Array.from(activeColumns);
    const exportData = editedRows.map(row => {
      const obj: Record<string, any> = {};
      cols.forEach(c => { obj[E0V1_MAP[c] || c] = row[c] ?? ''; });
      return obj;
    });
    const ws = utils.json_to_sheet(exportData);
    const wb = utils.book_new();
    utils.book_append_sheet(wb, ws, 'Quadri E0-V1');
    writeFileXLSX(wb, 'inps-estratto-e0-v1.xlsx');
  };

  const visibleCols = Array.from(activeColumns);
  const totalPages = Math.ceil(editedRows.length / PAGE_SIZE);
  const pagedRows = editedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <main className="max-w-7xl mx-auto p-4 md:p-8">
      {/* HEADER */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-blue-800">INPS Extractor — Quadri E0/V1</h1>
        <p className="text-gray-500 mt-1">Estrazione selettiva colonne da file INPS PASSWEB · Immedia S.p.A.</p>
      </div>

      {/* PROGRESS BAR */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {(['upload','preview','export'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`rounded-full w-8 h-8 flex items-center justify-center text-sm font-bold ${
              step === s ? 'bg-blue-600 text-white' : step === 'preview' && s === 'upload' || step === 'export' ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
            }`}>{i+1}</div>
            <span className={`text-sm font-medium ${ step === s ? 'text-blue-700' : 'text-gray-400'}`}>
              {s === 'upload' ? 'Carica file' : s === 'preview' ? 'Anteprima dati' : 'Esporta XLSX'}
            </span>
            {i < 2 && <span className="text-gray-300">›</span>}
          </div>
        ))}
      </div>

      {/* STEP 1: UPLOAD */}
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

      {/* STEP 2: PREVIEW */}
      {step === 'preview' && (
        <div className="space-y-6">
          {warnings.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
              <p className="font-semibold text-yellow-800">Avvisi:</p>
              {warnings.map((w, i) => <p key={i} className="text-yellow-700 text-sm">{w}</p>)}
            </div>
          )}

          {/* Selezione colonne */}
          <div className="bg-white rounded-xl shadow p-4">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold text-gray-800">Selezione colonne</h2>
              <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium">
                Selezione salvata: {activeColumns.size} colonne
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
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-blue-700 text-white">
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
                        <td key={col} className="px-1 py-1 border-b border-gray-100">
                          <input
                            value={row[col]?.toString() ?? ''}
                            onChange={e => updateCell(page * PAGE_SIZE + ri, col, e.target.value)}
                            className="w-full px-2 py-1 bg-transparent focus:bg-blue-50 focus:outline-none rounded text-xs"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Paginazione */}
            <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t">
              <span className="text-sm text-gray-500">
                {editedRows.length} righe totali | Pagina {page+1} di {totalPages}
              </span>
              <div className="flex gap-2">
                <button onClick={() => setPage(p => Math.max(0, p-1))} disabled={page===0}
                  className="px-3 py-1 rounded border text-sm disabled:opacity-40">&#8592; Prec</button>
                <button onClick={() => setPage(p => Math.min(totalPages-1, p+1))} disabled={page>=totalPages-1}
                  className="px-3 py-1 rounded border text-sm disabled:opacity-40">Succ &#8594;</button>
              </div>
            </div>
          </div>

          {/* Bottoni azione */}
          <div className="flex flex-wrap gap-4 justify-between">
            <button onClick={() => setStep('upload')}
              className="px-6 py-2 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors">
              &#8592; Cambia file
            </button>
            <button onClick={handleExport}
              className="bg-green-600 hover:bg-green-700 text-white px-8 py-3 rounded-lg font-semibold flex items-center gap-2 transition-colors">
              &#128229; Genera file scaricabile (.xlsx)
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
