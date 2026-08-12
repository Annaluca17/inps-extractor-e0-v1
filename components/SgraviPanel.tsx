'use client';
import { Fragment, useMemo, useState } from 'react';
import {
  type SheetData,
  IntegrityError,
  exportWorkbook,
  textOf,
} from '../lib/inps';
import {
  buildSgraviExport,
  competenzaOf,
  filterSgravi,
  resolveSgraviColumns,
  splitSgravio,
  summarizeSgravi,
} from '../lib/sgravi';
import { Alert, Bar, Card, Chip, Kpi, ResetChip, formatInt, formatNumber } from './ui';

export default function SgraviPanel({ sheet }: { sheet: SheetData }) {
  const cols = useMemo(() => resolveSgraviColumns(sheet.columns), [sheet]);
  const overall = useMemo(() => summarizeSgravi(sheet.rows, cols), [sheet, cols]);

  const [selectedAnni, setSelectedAnni] = useState<Set<number>>(new Set());
  const [selectedCodici, setSelectedCodici] = useState<Set<string>>(new Set());
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const [showDettaglio, setShowDettaglio] = useState(false);
  const [exportError, setExportError] = useState('');

  const filtered = useMemo(() => {
    try {
      return { ok: true as const, value: filterSgravi(sheet.rows, cols, { anni: selectedAnni, codici: selectedCodici }) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [sheet, cols, selectedAnni, selectedCodici]);

  // Memoizzati: un array nuovo a ogni render invaliderebbe i useMemo a valle.
  const rows = useMemo(() => (filtered.ok ? filtered.value.kept : []), [filtered]);
  const excluded = useMemo(() => (filtered.ok ? filtered.value.excluded : []), [filtered]);
  const summary = useMemo(() => summarizeSgravi(rows, cols), [rows, cols]);

  const maxCodice = Math.max(1, ...summary.perCodice.map(c => c.imponibileSgravio));
  const maxAnno = Math.max(1, ...summary.perAnno.map(a => a.imponibileSgravio));

  const toggleAnno = (y: number) => setSelectedAnni(prev => {
    const s = new Set(prev);
    if (s.has(y)) s.delete(y); else s.add(y);
    return s;
  });
  const toggleCodice = (c: string) => setSelectedCodici(prev => {
    const s = new Set(prev);
    if (s.has(c)) s.delete(c); else s.add(c);
    return s;
  });

  const handleExport = () => {
    setExportError('');
    try {
      exportWorkbook(buildSgraviExport(summary, rows, sheet), 'inps-sgravi-contributivi.xlsx');
    } catch (err) {
      setExportError(err instanceof IntegrityError
        ? `Export bloccato dal controllo di integrità: ${err.message}`
        : `Export non riuscito: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const missing = [
    !cols.sgravio && 'Sgravio',
    !cols.imponibileSgravio && 'Imponibile Sgravio',
    !cols.altroImponibileSgravio && 'Altro Imponibile Sgravio',
  ].filter(Boolean) as string[];

  const periodo = summary.perAnno.length > 0
    ? `${summary.perAnno[summary.perAnno.length - 1].year}–${summary.perAnno[0].year}`
    : '—';

  return (
    <div className="space-y-6">
      {!filtered.ok && (
        <Alert tone="error" title="Controllo di integrità fallito">
          <p>{filtered.error}</p>
        </Alert>
      )}
      {exportError && <Alert tone="error" title="Export non eseguito"><p>{exportError}</p></Alert>}
      {missing.length > 0 && (
        <Alert tone="warning" title="Colonne non trovate nel foglio sgravi">
          <p>{missing.join(', ')}. I totali relativi risultano a zero.</p>
        </Alert>
      )}
      {summary.senzaCompetenza.length > 0 && (
        <Alert tone="warning" title={`${summary.senzaCompetenza.length} righe senza anno di competenza`}>
          <p>
            Righe Excel {summary.senzaCompetenza.map(r => r.__id).join(', ')}: conteggiate nei totali generali e nel
            riepilogo per codice, escluse dal riepilogo per anno.
          </p>
        </Alert>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Righe sgravio" value={formatInt(summary.totals.count)}
          hint={`su ${formatInt(sheet.rows.length)} nel foglio`} tone="gray" />
        <Kpi label="Codici sgravio distinti" value={formatInt(summary.perCodice.length)}
          hint={`periodo ${periodo}`} tone="blue" />
        <Kpi label="Totale Imponibile Sgravio" value={`€ ${formatNumber(summary.totals.imponibileSgravio)}`}
          hint="somma colonna Imponibile Sgravio" tone="green" />
        <Kpi label="Totale Altro Imponibile" value={`€ ${formatNumber(summary.totals.altroImponibileSgravio)}`}
          hint="somma colonna Altro Imponibile Sgravio" tone="amber" />
      </div>

      <Card
        title="Filtri"
        right={
          <span className="text-sm tabular-nums">
            <span className="bg-green-100 text-green-800 px-3 py-1 rounded-full">{formatInt(rows.length)} tenute</span>
            <span className="mx-1 text-gray-400">+</span>
            <span className="bg-gray-100 text-gray-700 px-3 py-1 rounded-full">{formatInt(excluded.length)} escluse</span>
            <span className="mx-1 text-gray-400">=</span>
            <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full">{formatInt(sheet.rows.length)}</span>
          </span>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-2">
              Anno di competenza — {selectedAnni.size === 0 ? 'tutti' : `${selectedAnni.size} selezionati`}
            </p>
            <div className="flex flex-wrap gap-2">
              {overall.anni.map(y => (
                <Chip key={y} active={selectedAnni.has(y)} onClick={() => toggleAnno(y)}>{y}</Chip>
              ))}
              {selectedAnni.size > 0 && <ResetChip onClick={() => setSelectedAnni(new Set())} />}
            </div>
          </div>
          <div>
            <p className="text-sm text-gray-600 mb-2">
              Codice sgravio — {selectedCodici.size === 0 ? 'tutti' : `${selectedCodici.size} selezionati`}
            </p>
            <div className="flex flex-wrap gap-2">
              {overall.codici.map(c => (
                <Chip key={c.code} active={selectedCodici.has(c.code)} onClick={() => toggleCodice(c.code)}
                  title={c.description}>
                  {c.code}
                </Chip>
              ))}
              {selectedCodici.size > 0 && <ResetChip onClick={() => setSelectedCodici(new Set())} />}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Riepilogo per codice sgravio">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100 text-gray-700">
              <tr>
                <th className="px-3 py-2 text-left">Cod.</th>
                <th className="px-3 py-2 text-left">Descrizione</th>
                <th className="px-3 py-2 text-left">Anni</th>
                <th className="px-3 py-2 text-right">N.</th>
                <th className="px-3 py-2 text-right">Imponibile Sgravio</th>
                <th className="px-3 py-2 text-right">Altro Imponibile</th>
                <th className="px-3 py-2 text-left w-32">Peso</th>
              </tr>
            </thead>
            <tbody>
              {summary.perCodice.map(c => (
                <tr key={c.code} className="border-b border-gray-100 align-top">
                  <td className="px-3 py-2 font-bold text-blue-800 tabular-nums">{c.code}</td>
                  <td className="px-3 py-2 text-gray-700 max-w-lg">{c.description}</td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap tabular-nums">{c.years.join(', ') || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatInt(c.count)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{formatNumber(c.imponibileSgravio)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">{formatNumber(c.altroImponibileSgravio)}</td>
                  <td className="px-3 py-2"><Bar value={c.imponibileSgravio} max={maxCodice} /></td>
                </tr>
              ))}
              {summary.perCodice.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">Nessuno sgravio con i filtri attivi.</td></tr>
              )}
            </tbody>
            {summary.perCodice.length > 0 && (
              <tfoot>
                <tr className="bg-amber-50 font-semibold border-t-2 border-amber-300">
                  <td className="px-3 py-2" colSpan={3}>TOTALE</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatInt(summary.totals.count)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(summary.totals.imponibileSgravio)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatNumber(summary.totals.altroImponibileSgravio)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      <Card title="Riepilogo per anno di competenza">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100 text-gray-700">
              <tr>
                <th className="px-3 py-2 text-left">Anno</th>
                <th className="px-3 py-2 text-left">Codici</th>
                <th className="px-3 py-2 text-right">N.</th>
                <th className="px-3 py-2 text-right">Imponibile Sgravio</th>
                <th className="px-3 py-2 text-right">Altro Imponibile</th>
                <th className="px-3 py-2 text-left w-32">Peso</th>
              </tr>
            </thead>
            <tbody>
              {summary.perAnno.map(a => (
                <Fragment key={a.year}>
                  <tr
                    className="border-b border-gray-100 cursor-pointer hover:bg-blue-50"
                    onClick={() => setExpandedYear(prev => (prev === a.year ? null : a.year))}
                  >
                    <td className="px-3 py-2 font-bold tabular-nums">
                      <span className="text-gray-400 mr-1">{expandedYear === a.year ? '▾' : '▸'}</span>
                      {a.year}
                    </td>
                    <td className="px-3 py-2 text-gray-500 tabular-nums">{a.codes.join(', ')}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatInt(a.count)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">{formatNumber(a.imponibileSgravio)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-600">{formatNumber(a.altroImponibileSgravio)}</td>
                    <td className="px-3 py-2"><Bar value={a.imponibileSgravio} max={maxAnno} tone="green" /></td>
                  </tr>
                  {expandedYear === a.year && a.months.map(m => (
                    <tr key={`${a.year}-${m.month}`} className="bg-gray-50 border-b border-gray-100 text-gray-600">
                      <td className="px-3 py-1 pl-8 text-xs">{m.monthName}</td>
                      <td />
                      <td className="px-3 py-1 text-right tabular-nums text-xs">{formatInt(m.count)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-xs">{formatNumber(m.imponibileSgravio)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-xs">{formatNumber(m.altroImponibileSgravio)}</td>
                      <td />
                    </tr>
                  ))}
                </Fragment>
              ))}
              {summary.perAnno.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Nessun anno di competenza determinabile.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          Clicca su un anno per il dettaglio mensile. Competenza = colonne &quot;Anno/Mese Sgravio&quot;; in mancanza, Data Inizio Periodo.
        </p>
      </Card>

      <Card
        title={`Dettaglio righe sgravio (${formatInt(rows.length)})`}
        right={
          <button
            type="button"
            onClick={() => setShowDettaglio(v => !v)}
            className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
          >
            {showDettaglio ? 'Nascondi' : 'Mostra'}
          </button>
        }
      >
        {showDettaglio ? (
          <div className="overflow-x-auto max-h-96">
            <table className="min-w-full text-sm">
              <thead className="bg-blue-700 text-white sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Riga</th>
                  <th className="px-3 py-2 text-left">Competenza</th>
                  <th className="px-3 py-2 text-left">Denuncia</th>
                  <th className="px-3 py-2 text-left">Periodo</th>
                  <th className="px-3 py-2 text-left">Cod.</th>
                  <th className="px-3 py-2 text-right">Imp. Sgravio</th>
                  <th className="px-3 py-2 text-right">Altro Imp.</th>
                  <th className="px-3 py-2 text-left">Cassa</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const ym = competenzaOf(row, cols);
                  const { code } = splitSgravio(textOf(row, cols.sgravio));
                  return (
                    <tr key={row.__id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                      <td className="px-3 py-1 tabular-nums text-gray-400">{row.__id}</td>
                      <td className="px-3 py-1 tabular-nums whitespace-nowrap">
                        {ym ? `${String(ym.month).padStart(2, '0')}/${ym.year}` : '—'}
                      </td>
                      <td className="px-3 py-1 whitespace-nowrap">{textOf(row, cols.denuncia)}</td>
                      <td className="px-3 py-1 whitespace-nowrap">
                        {textOf(row, cols.dataInizio)} – {textOf(row, cols.dataFine)}
                      </td>
                      <td className="px-3 py-1 font-bold text-blue-800 tabular-nums">{code}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{textOf(row, cols.imponibileSgravio)}</td>
                      <td className="px-3 py-1 text-right tabular-nums text-gray-600">{textOf(row, cols.altroImponibileSgravio)}</td>
                      <td className="px-3 py-1 whitespace-nowrap text-gray-600">{textOf(row, cols.cassa)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-gray-500">Elenco completo delle righe incluse nei totali qui sopra.</p>
        )}
      </Card>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleExport}
          disabled={rows.length === 0 || !filtered.ok}
          className="bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white px-8 py-3 rounded-lg font-semibold transition-colors"
        >
          &#128229; Esporta riepilogo sgravi (.xlsx)
        </button>
      </div>
    </div>
  );
}
