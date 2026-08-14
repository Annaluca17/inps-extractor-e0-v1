'use client';
import { useEffect, useMemo, useState } from 'react';
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
  numberOf,
  resolveQuadriColumns,
  sortByPeriod,
  textOf,
  yearMonthOfRow,
} from '../lib/inps';
import {
  clearColumnPreset,
  initialColumnSelection,
  loadColumnPreset,
  loadFlag,
  missingPresetColumns,
  saveColumnPreset,
  saveFlag,
} from '../lib/preferences';
import {
  type AnagraficaDipendente,
  type AziendaDenuncia,
  type Causale,
  type Mittente,
  AZIENDA_VUOTA,
  CAUSALI,
  MITTENTE_VUOTO,
  aziendaDalFile,
  buildUniemensPayload,
  codiciFiscaliDi,
  downloadPayload,
  riferimentoCumulo,
  toIsoDate,
} from '../lib/uniemens';
import ColumnFilterPanel from './ColumnFilterPanel';
import { Alert, Card, Chip, ResetChip, formatInt, formatNumber } from './ui';

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

  // A schermo intero la tabella è lo strumento di lavoro: si guardano tutte le
  // righe del dipendente in una volta, senza rimbalzare fra le pagine.
  const [fullscreen, setFullscreen] = useState(false);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE);

  const entries = displayed.ok ? displayed.value : [];
  const effectivePageSize = pageSize === 0 ? Math.max(entries.length, 1) : pageSize;
  const totalPages = Math.max(1, Math.ceil(entries.length / effectivePageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageEntries = entries.slice(safePage * effectivePageSize, (safePage + 1) * effectivePageSize);

  const [exportError, setExportError] = useState<string>('');
  const [causale, setCausale] = useState<Causale>('5');

  // Righe da fondere in un unico quadro: i pagamenti successivi alla
  // cessazione vanno sommati all'ultimo mese lavorato, ma solo l'operatore sa
  // se un E0 fuori posto è un errore o una riassunzione.
  const [cumula, setCumula] = useState<Set<number>>(new Set());
  const toggleCumula = (id: number) => setCumula(prev => {
    const s = new Set(prev);
    if (s.has(id)) s.delete(id); else s.add(id);
    return s;
  });

  const righeCumulate = useMemo(() => keptRows.filter(r => cumula.has(r.__id)), [keptRows, cumula]);
  const rifCumulo = useMemo(() => riferimentoCumulo(righeCumulate, cols), [righeCumulate, cols]);

  // Le spunte sopravvivono ai cambi di filtro, ma nell'export finiscono solo le
  // righe ancora selezionate. Il conteggio deve dire la verità su ciò che uscirà
  // davvero, non su quante caselle sono state toccate: un numero che torna su un
  // contenuto diverso è esattamente l'errore che l'app esiste per rendere
  // impossibile.
  const cumulaFuoriVista = cumula.size - righeCumulate.length;

  /** Totali delle righe spuntate: la somma che prima si faceva in Excel. */
  const totaliCumulo = useMemo(() => {
    const numeriche = SUBTOTAL_COLUMNS.filter(c => sheet.columns.includes(c));
    return numeriche
      .map(col => ({
        col,
        totale: righeCumulate.reduce((s, r) => s + (numberOf(r, col) ?? 0), 0),
      }))
      .filter(x => x.totale !== 0);
  }, [righeCumulate, sheet]);

  // Pannello colonne richiudibile: dopo la scelta iniziale è ingombro, e
  // l'intestazione continua a dire quante ne sono attive.
  const [colonneAperte, setColonneAperte] = useState(() => loadFlag('colonne-aperte', true));
  const toggleColonne = () => setColonneAperte(prev => {
    saveFlag('colonne-aperte', !prev);
    return !prev;
  });

  // A schermo intero: ESC per uscire, e la pagina sotto non deve scorrere.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [fullscreen]);

  // Dati che il tracciato PASSWEB non contiene e che l'XML pretende. Valgono
  // solo per l'export JSON: l'XLSX resta la trascrizione fedele del file INPS.
  const [mostraAggiuntivi, setMostraAggiuntivi] = useState(false);
  const [anagrafica, setAnagrafica] = useState<Record<string, AnagraficaDipendente>>({});
  const [mittente, setMittente] = useState<Mittente>(MITTENTE_VUOTO);
  const [azienda, setAzienda] = useState<AziendaDenuncia>(AZIENDA_VUOTA);

  const cfPresenti = useMemo(() => codiciFiscaliDi(keptRows, sheet), [keptRows, sheet]);
  const aziendaSuggerita = useMemo(() => aziendaDalFile(keptRows, sheet), [keptRows, sheet]);

  const anagraficaDi = (cf: string): AnagraficaDipendente =>
    anagrafica[cf] ?? { Cognome: '', Nome: '', CodiceComune: '', CAP: '' };
  const setAnagraficaCampo = (cf: string, campo: keyof AnagraficaDipendente, valore: string) =>
    setAnagrafica(prev => ({ ...prev, [cf]: { ...anagraficaDi(cf), [campo]: valore } }));

  const anagraficaIncompleta = cfPresenti.filter(cf => {
    const a = anagrafica[cf];
    return !a?.Cognome?.trim() || !a?.Nome?.trim();
  });

  /** Precompila dal file ciò che il file sa già dire: CF ente, progressivo, ragione sociale. */
  const precompilaAzienda = () => setAzienda(prev => ({ ...prev, ...aziendaSuggerita }));

  const nonVuoto = <T extends object>(o: T): boolean =>
    Object.values(o).some(v => typeof v === 'string' && v.trim() !== '');

  const handleExportJson = () => {
    setExportError('');
    try {
      const compilate = new Map(
        cfPresenti
          .map(cf => [cf, anagrafica[cf]] as const)
          .filter((e): e is [string, AnagraficaDipendente] => e[1] != null),
      );
      const payload = buildUniemensPayload(keptRows, sheet, cols, causale, cumula, {
        anagrafica: compilate,
        // Il frontespizio viaggia solo se l'operatore lo ha toccato: un
        // frontespizio vuoto sovrascriverebbe quello già presente nel builder.
        mittente: nonVuoto({ ...mittente, CFSoftwarehouse: '' }) ? mittente : undefined,
        azienda: nonVuoto({ ...azienda, PRGAZIENDA: '', FormaGiuridica: '' }) ? azienda : undefined,
      });
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
        title={
          <button
            type="button"
            onClick={toggleColonne}
            className="flex items-center gap-2 hover:text-blue-700"
            aria-expanded={colonneAperte}
          >
            <span className="text-gray-400">{colonneAperte ? '▾' : '▸'}</span>
            Selezione colonne
          </button>
        }
        right={
          <span className="text-sm font-medium tabular-nums">
            <span className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full">
              {activeColumns.size} attive / {sheet.columns.length}
            </span>
            <span className="ml-2 bg-gray-100 text-gray-600 px-3 py-1 rounded-full">
              {sheet.columns.length - withData.length} senza dati
            </span>
            {!colonneAperte && (
              <button type="button" onClick={toggleColonne} className="ml-2 text-blue-700 underline text-xs">
                apri
              </button>
            )}
          </span>
        }
      >
        {!colonneAperte && (
          <p className="text-sm text-gray-500">
            Pannello chiuso. Le {activeColumns.size} colonne attive restano quelle scelte.
          </p>
        )}
        {colonneAperte && <>
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
        </>}
      </Card>

      <div
        className={fullscreen
          ? 'fixed inset-0 z-50 bg-white flex flex-col'
          : 'bg-white rounded-xl shadow overflow-hidden'}
        // Il contenitore esterno usa space-y, che dà un margine superiore ai
        // figli: con inset-0 sposterebbe in basso lo schermo intero.
        style={fullscreen ? { marginTop: 0 } : undefined}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={() => setFullscreen(v => !v)}
              className="px-3 py-1 rounded-lg border border-gray-300 bg-white hover:bg-gray-100 font-medium"
              title={fullscreen ? 'Esci (o premi ESC)' : 'Lavora a schermo intero'}
            >
              {fullscreen ? '⤡ Esci da schermo intero' : '⤢ Schermo intero'}
            </button>
            {fullscreen && <span className="text-xs text-gray-400">ESC per uscire</span>}
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            Righe per pagina
            <select
              value={pageSize}
              onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}
              className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={250}>250</option>
              <option value={0}>tutte</option>
            </select>
          </label>
        </div>

        {/* Va mostrato anche quando nessuna riga spuntata rientra nei filtri:
            è lì che l'avviso serve di più, non dove è superfluo. */}
        {(righeCumulate.length > 0 || cumulaFuoriVista > 0) && (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold text-amber-900">
                &#8721; {righeCumulate.length} righe selezionate
              </span>
              {totaliCumulo.map(({ col, totale }) => (
                <span key={col} className="text-amber-900 tabular-nums">
                  {E0V1_MAP[col] ?? col}: <span className="font-semibold">{formatNumber(totale)}</span>
                </span>
              ))}
              <button
                type="button"
                onClick={() => setCumula(new Set())}
                className="underline text-amber-700 hover:text-amber-900"
              >azzera</button>
            </div>
            {cumulaFuoriVista > 0 && (
              <p className="text-xs text-amber-700 mt-1">
                Altre {cumulaFuoriVista} righe spuntate non rientrano nei filtri attuali: non sono in questi
                totali e non finiranno nell&apos;export.
              </p>
            )}
          </div>
        )}

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

        <div className={fullscreen ? 'overflow-auto flex-1' : 'overflow-auto max-h-[60vh]'}>
          <table className="min-w-full text-sm border-separate border-spacing-0">
            <thead className="bg-blue-700 text-white sticky top-0 z-20">
              <tr>
                <th
                  className="px-2 py-2 text-center whitespace-nowrap sticky left-0 z-30 bg-blue-700 w-10"
                  title="Righe da cumulare in un unico V1C5"
                >&#8721;</th>
                <th
                  className="px-3 py-2 text-left whitespace-nowrap sticky left-10 z-30 bg-blue-700"
                  title="Riga nel file INPS di origine"
                >Riga</th>
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
                const spuntata = !isSub && cumula.has(entry.row!.__id);
                // Le celle bloccate non ereditano lo sfondo della riga: se
                // resta trasparente, il contenuto che scorre le attraversa.
                const sfondo = isSub
                  ? 'bg-amber-50'
                  : spuntata ? 'bg-amber-100' : (i % 2 === 0 ? 'bg-white' : 'bg-gray-50');
                return (
                  <tr
                    key={key}
                    className={`${sfondo} ${isSub ? 'font-semibold' : ''}`}
                  >
                    <td className={`px-2 py-1 border-b border-gray-100 text-center sticky left-0 z-10 ${sfondo}`}>
                      {!isSub && (
                        <input
                          type="checkbox"
                          checked={spuntata}
                          onChange={() => toggleCumula(entry.row!.__id)}
                          title="Cumula questa riga nel V1C5"
                        />
                      )}
                    </td>
                    <td className={`px-3 py-1 border-b border-gray-100 tabular-nums text-gray-400 whitespace-nowrap sticky left-10 z-10 ${sfondo}`}>
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
                  <td colSpan={visibleCols.length + 2} className="px-3 py-6 text-center text-gray-400">
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
            {(righeCumulate.length > 0 || cumulaFuoriVista > 0) && (
              <div className="text-sm bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 max-w-xl">
                <span className="font-semibold text-amber-900">
                  &#8721; {righeCumulate.length} righe da cumulare in un unico V1C5
                </span>
                {rifCumulo && (
                  <span className="text-amber-800">
                    {' '}· riferimento{' '}
                    <span className="font-mono">
                      {toIsoDate(textOf(rifCumulo, cols.data))} → {toIsoDate(textOf(rifCumulo, cols.dataFine))}
                    </span>
                    {' '}(riga {rifCumulo.__id})
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setCumula(new Set())}
                  className="ml-2 underline text-amber-700 hover:text-amber-900"
                >azzera</button>
                <p className="text-xs text-amber-700 mt-1">
                  Importi sommati sul periodo di riferimento, un ente versante per ogni mese di pagamento.
                  Vale solo per la causale 5.
                </p>
                {cumulaFuoriVista > 0 && (
                  <p className="text-xs text-amber-800 mt-1 font-medium">
                    Altre {cumulaFuoriVista} righe spuntate sono fuori dai filtri attuali e non verranno esportate.
                  </p>
                )}
              </div>
            )}
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
              onClick={() => setMostraAggiuntivi(v => !v)}
              className="text-sm text-blue-700 hover:text-blue-900 underline"
            >
              {mostraAggiuntivi ? '▾' : '▸'} Dati per il builder
              {anagraficaIncompleta.length > 0 && (
                <span className="ml-1 text-amber-700">
                  ({anagraficaIncompleta.length} da compilare)
                </span>
              )}
            </button>
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

        {mostraAggiuntivi && (
          <div className="mt-4 pt-4 border-t border-gray-200 space-y-5">
            <p className="text-sm text-gray-600 max-w-3xl">
              Il tracciato PASSWEB non contiene l&apos;anagrafica del lavoratore né l&apos;intestazione
              della denuncia, ma l&apos;XML non può farne a meno: si compilano qui. Valgono{' '}
              <span className="font-semibold">solo per il file .json</span> — l&apos;export .xlsx resta la
              trascrizione fedele del file INPS e non ne è toccato.
            </p>

            <div>
              <h3 className="font-semibold text-gray-800 text-sm mb-2">
                Anagrafica dei lavoratori{' '}
                <span className="font-normal text-gray-500">
                  ({cfPresenti.length} nelle righe selezionate)
                </span>
              </h3>
              <div className="overflow-x-auto">
                <table className="text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 text-xs uppercase tracking-wide">
                      <th className="pr-3 pb-1 font-medium">Codice fiscale</th>
                      <th className="pr-3 pb-1 font-medium">Cognome</th>
                      <th className="pr-3 pb-1 font-medium">Nome</th>
                      <th className="pr-3 pb-1 font-medium">Codice comune</th>
                      <th className="pb-1 font-medium">CAP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cfPresenti.map(cf => {
                      const a = anagraficaDi(cf);
                      const manca = !a.Cognome.trim() || !a.Nome.trim();
                      return (
                        <tr key={cf}>
                          <td className="pr-3 py-1 font-mono text-xs whitespace-nowrap">
                            {cf}
                            {manca && <span className="ml-1 text-amber-600" title="Cognome e nome sono obbligatori">•</span>}
                          </td>
                          <td className="pr-3 py-1">
                            <CampoTesto value={a.Cognome} onChange={v => setAnagraficaCampo(cf, 'Cognome', v)} width="w-40" />
                          </td>
                          <td className="pr-3 py-1">
                            <CampoTesto value={a.Nome} onChange={v => setAnagraficaCampo(cf, 'Nome', v)} width="w-40" />
                          </td>
                          <td className="pr-3 py-1">
                            <CampoTesto value={a.CodiceComune} onChange={v => setAnagraficaCampo(cf, 'CodiceComune', v)} placeholder="L651" width="w-24" />
                          </td>
                          <td className="py-1">
                            <CampoTesto value={a.CAP} onChange={v => setAnagraficaCampo(cf, 'CAP', v)} placeholder="98040" width="w-24" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {anagraficaIncompleta.length > 0 && (
                <p className="text-xs text-amber-700 mt-2">
                  Cognome e nome mancanti per {anagraficaIncompleta.length} lavoratore/i: il JSON viene
                  comunque prodotto, con l&apos;avviso dentro, ma il builder non genererà un XML valido.
                </p>
              )}
            </div>

            <div>
              <div className="flex items-baseline gap-3 mb-2">
                <h3 className="font-semibold text-gray-800 text-sm">Intestazione della denuncia</h3>
                {Object.keys(aziendaSuggerita).length > 0 && (
                  <button type="button" onClick={precompilaAzienda} className="text-xs text-blue-700 underline hover:text-blue-900">
                    riprendi l&apos;ente dal file
                  </button>
                )}
              </div>
              <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl">
                <Campo label="CF persona mittente" value={mittente.CFPersonaMittente} onChange={v => setMittente(p => ({ ...p, CFPersonaMittente: v }))} />
                <Campo label="Ragione sociale mittente" value={mittente.RagSocMittente} onChange={v => setMittente(p => ({ ...p, RagSocMittente: v }))} />
                <Campo label="CF mittente" value={mittente.CFMittente} onChange={v => setMittente(p => ({ ...p, CFMittente: v }))} />
                <Campo label="CF softwarehouse" value={mittente.CFSoftwarehouse} onChange={v => setMittente(p => ({ ...p, CFSoftwarehouse: v }))} />
                <Campo label="Sede INPS" value={mittente.SedeINPS} onChange={v => setMittente(p => ({ ...p, SedeINPS: v }))} placeholder="4800" />
                <Campo label="Anno-mese denuncia" value={azienda.AnnoMeseDenuncia} onChange={v => setAzienda(p => ({ ...p, AnnoMeseDenuncia: v }))} placeholder="2026-01" />
                <Campo label="CF azienda" value={azienda.CFAzienda} onChange={v => setAzienda(p => ({ ...p, CFAzienda: v }))} />
                <Campo label="Ragione sociale ente" value={azienda.RagSocAzienda} onChange={v => setAzienda(p => ({ ...p, RagSocAzienda: v }))} />
                <Campo label="PRGAZIENDA" value={azienda.PRGAZIENDA} onChange={v => setAzienda(p => ({ ...p, PRGAZIENDA: v }))} />
                <Campo label="CF rappresentante firmatario" value={azienda.CFRappresentanteFirmatario} onChange={v => setAzienda(p => ({ ...p, CFRappresentanteFirmatario: v }))} />
                <Campo label="ISTAT" value={azienda.ISTAT} onChange={v => setAzienda(p => ({ ...p, ISTAT: v }))} placeholder="841110" />
                <Campo label="Forma giuridica" value={azienda.FormaGiuridica} onChange={v => setAzienda(p => ({ ...p, FormaGiuridica: v }))} placeholder="2430" />
              </div>
              <p className="text-xs text-gray-500 mt-2 max-w-3xl">
                Se lasciata in bianco, l&apos;intestazione non viene scritta nel JSON e il builder conserva
                quella già caricata.
              </p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function CampoTesto({ value, onChange, placeholder = '', width = 'w-full' }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  width?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className={`${width} border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500`}
    />
  );
}

function Campo({ label, value, onChange, placeholder = '' }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs text-gray-500 mb-0.5">{label}</span>
      <CampoTesto value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  );
}
