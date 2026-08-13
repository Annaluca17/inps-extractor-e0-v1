'use client';
import { useMemo, useState } from 'react';
import { type InpsRow, textOf } from '../lib/inps';
import { formatInt } from './ui';

/**
 * Filtro sui valori di una colonna, in stile filtro automatico di Excel.
 *
 * È un pannello sopra la tabella e non un menu a comparsa sull'intestazione:
 * la tabella vive dentro un contenitore con scorrimento, che ritaglierebbe
 * qualunque elemento posizionato in modo assoluto. Con 80 colonne e valori
 * lunghi come le denominazioni degli enti, un pannello ampio è anche più
 * comodo da usare.
 */
export default function ColumnFilterPanel({
  column,
  rows,
  selected,
  onChange,
  onClose,
}: {
  column: string;
  rows: readonly InpsRow[];
  selected: ReadonlySet<string> | undefined;
  onChange: (values: Set<string>) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');

  // Valori distinti con il numero di righe, calcolati sull'intero foglio così
  // l'elenco non cambia sotto le mani mentre si spuntano le voci.
  const values = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const v = textOf(row, column);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'it'));
  }, [rows, column]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q === '') return values;
    return values.filter(([v]) => v.toLowerCase().includes(q));
  }, [values, search]);

  // Nessuna selezione = nessun filtro = tutti i valori ammessi.
  const active = selected && selected.size > 0;
  const isChecked = (v: string) => !active || selected!.has(v);

  const toggle = (v: string) => {
    const next = new Set(active ? selected! : values.map(([x]) => x));
    if (next.has(v)) next.delete(v); else next.add(v);
    // Selezionati tutti i valori = filtro inutile: si azzera.
    onChange(next.size === values.length ? new Set() : next);
  };

  const onlyThis = (v: string) => onChange(values.length === 1 ? new Set() : new Set([v]));

  return (
    <div className="border border-blue-300 rounded-xl bg-blue-50/60 p-4 mb-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="text-sm">
          <span className="text-gray-500">Filtro sulla colonna</span>{' '}
          <span className="font-semibold text-blue-900">{column}</span>
          <span className="text-gray-500"> — {formatInt(values.length)} valori distinti</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="px-3 py-1 rounded-full border text-sm bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
          >
            Mostra tutti
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded-full border text-sm bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
          >
            Chiudi
          </button>
        </div>
      </div>

      {values.length > 8 && (
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Cerca un valore…"
          className="w-full md:w-96 border border-gray-300 rounded px-3 py-1.5 text-sm mb-3"
        />
      )}

      <div className="max-h-64 overflow-y-auto space-y-1 bg-white rounded-lg border border-blue-200 p-2">
        {filtered.map(([value, count]) => (
          <div key={value} className="flex items-center gap-2 group px-2 py-1 rounded hover:bg-blue-50">
            <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0 text-sm">
              <input type="checkbox" checked={isChecked(value)} onChange={() => toggle(value)} />
              <span className={`truncate ${value === '' ? 'italic text-gray-400' : ''}`} title={value}>
                {value === '' ? '(vuoto)' : value}
              </span>
              <span className="text-xs text-gray-400 tabular-nums shrink-0">{formatInt(count)}</span>
            </label>
            <button
              type="button"
              onClick={() => onlyThis(value)}
              className="text-xs text-blue-600 opacity-0 group-hover:opacity-100 shrink-0 hover:underline"
            >
              solo questo
            </button>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-sm text-gray-400 px-2 py-3 text-center">Nessun valore corrisponde alla ricerca.</p>
        )}
      </div>
    </div>
  );
}
