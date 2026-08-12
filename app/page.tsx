'use client';
import { useCallback, useState } from 'react';
import { type ParsedWorkbook, IntegrityError, parseInpsWorkbook } from '../lib/inps';
import QuadriPanel from '../components/QuadriPanel';
import SgraviPanel from '../components/SgraviPanel';
import { Alert, formatInt } from '../components/ui';

type Tab = 'quadri' | 'sgravi';

export default function Home() {
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [fileName, setFileName] = useState('');
  const [tab, setTab] = useState<Tab>('quadri');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const processFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setError('Carica un file .xlsx esportato da PASSWEB.');
      return;
    }
    setError('');
    setLoading(true);
    const reader = new FileReader();
    reader.onerror = () => {
      setLoading(false);
      setError('Lettura del file non riuscita.');
    };
    reader.onload = e => {
      setLoading(false);
      try {
        const parsed = parseInpsWorkbook(e.target?.result as ArrayBuffer);
        if (!parsed.quadri && !parsed.sgravi) {
          setError('Nessun foglio riconosciuto: il file non sembra un export "Elenco Quadri E0 e V1".');
          return;
        }
        setWorkbook(parsed);
        setFileName(file.name);
        setTab(parsed.quadri ? 'quadri' : 'sgravi');
      } catch (err) {
        console.error(err);
        setError(err instanceof IntegrityError
          ? `Controllo di integrità fallito in lettura: ${err.message}`
          : 'Impossibile leggere il file XLSX. Verifica che non sia corrotto.');
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const reset = () => {
    setWorkbook(null);
    setFileName('');
    setError('');
  };

  return (
    <main className="max-w-7xl mx-auto p-4 md:p-8">
      <header className="mb-6 text-center">
        <h1 className="text-3xl font-bold text-blue-800">INPS Extractor — Quadri E0/V1</h1>
        <p className="text-gray-500 mt-1">
          Estrazione righe/colonne e riepilogo sgravi da file INPS PASSWEB · Immedia S.p.A.
        </p>
      </header>

      {!workbook && (
        <div
          className="border-2 border-dashed border-blue-300 rounded-2xl p-12 text-center bg-white hover:border-blue-500 transition-colors"
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
          onDragOver={e => e.preventDefault()}
        >
          <div className="text-6xl mb-4">&#128196;</div>
          <p className="text-xl font-semibold text-gray-700 mb-2">Trascina qui il file INPS PASSWEB (.xlsx)</p>
          <p className="text-gray-400 mb-6">oppure</p>
          <label className="inline-block cursor-pointer bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-medium transition-colors">
            {loading ? 'Lettura in corso…' : 'Carica il file INPS (.xlsx)'}
            <input
              type="file"
              accept=".xlsx"
              onChange={e => { const f = e.target.files?.[0]; if (f) processFile(f); }}
              className="hidden"
            />
          </label>
          {error && <p className="mt-4 text-red-600 font-medium">{error}</p>}
        </div>
      )}

      {workbook && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl shadow px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-gray-600">
              <span className="font-semibold text-gray-800">{fileName}</span>
              <span className="text-gray-400"> · </span>
              {workbook.sheets.map(s => `${s.name} (${formatInt(s.rows.length)} righe)`).join(' · ')}
            </div>
            <button
              type="button"
              onClick={reset}
              className="px-4 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-100 text-sm"
            >
              &#8592; Cambia file
            </button>
          </div>

          {workbook.warnings.length > 0 && (
            <Alert tone="warning" title="Avvisi di lettura">
              {workbook.warnings.map((w, i) => <p key={i}>{w}</p>)}
            </Alert>
          )}

          <nav className="flex gap-1 border-b border-gray-200">
            {([
              ['quadri', 'Quadri E0/V1', workbook.quadri?.rows.length ?? 0, Boolean(workbook.quadri)],
              ['sgravi', 'Sgravi contributivi', workbook.sgravi?.rows.length ?? 0, Boolean(workbook.sgravi)],
            ] as [Tab, string, number, boolean][]).map(([id, label, count, enabled]) => (
              <button
                key={id}
                type="button"
                disabled={!enabled}
                onClick={() => setTab(id)}
                className={`px-5 py-2.5 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition-colors ${
                  tab === id
                    ? 'border-blue-600 text-blue-700 bg-white'
                    : enabled
                      ? 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-100'
                      : 'border-transparent text-gray-300 cursor-not-allowed'
                }`}
              >
                {label}
                <span className="ml-2 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5 tabular-nums">
                  {enabled ? formatInt(count) : '—'}
                </span>
              </button>
            ))}
          </nav>

          {tab === 'quadri' && workbook.quadri && <QuadriPanel key={workbook.quadri.name} sheet={workbook.quadri} />}
          {tab === 'sgravi' && workbook.sgravi && <SgraviPanel key={workbook.sgravi.name} sheet={workbook.sgravi} />}
          {tab === 'sgravi' && !workbook.sgravi && (
            <Alert tone="info" title="Nessun foglio sgravi nel file">
              <p>Il file caricato non contiene il foglio &quot;Elenco Sgravi&quot;.</p>
            </Alert>
          )}
        </div>
      )}
    </main>
  );
}
