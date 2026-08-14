/**
 * Preferenze utente salvate nel browser (localStorage).
 *
 * Al momento contiene solo le "colonne predefinite": l'elenco di colonne che
 * devono risultare selezionate a ogni caricamento, anche quando nel file
 * caricato risultano vuote. Nessun dato del file INPS viene mai salvato, solo
 * i nomi delle colonne scelte.
 *
 * Ogni accesso è difeso: in prerendering `window` non esiste, e il
 * localStorage può essere disabilitato o pieno. In quel caso l'app funziona
 * lo stesso, semplicemente senza memoria delle preferenze.
 */

const COLUMN_PRESET_KEY = 'inps-extractor.colonne-predefinite.v1';
const FLAG_PREFIX = 'inps-extractor.flag.';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Elenco salvato, oppure `null` se non è mai stato salvato nulla. */
export function loadColumnPreset(): string[] | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(COLUMN_PRESET_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const columns = parsed.filter((c): c is string => typeof c === 'string');
    return columns.length > 0 ? columns : null;
  } catch {
    return null;
  }
}

/** Restituisce `false` se il salvataggio non è possibile (storage assente o pieno). */
export function saveColumnPreset(columns: readonly string[]): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(COLUMN_PRESET_KEY, JSON.stringify(Array.from(columns)));
    return true;
  } catch {
    return false;
  }
}

export function clearColumnPreset(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.removeItem(COLUMN_PRESET_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Preferenze di sola interfaccia (pannelli aperti o chiusi, righe per pagina).
 * Non descrivono i dati, quindi un valore illeggibile non è un problema: si
 * ricade sul default senza disturbare l'operatore.
 */
export function loadFlag(name: string, fallback: boolean): boolean {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(FLAG_PREFIX + name);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export function saveFlag(name: string, value: boolean): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(FLAG_PREFIX + name, value ? '1' : '0');
  } catch {
    // Preferenza non memorizzabile: l'app funziona lo stesso.
  }
}

/**
 * Selezione iniziale delle colonne: quelle popolate nel file, più le
 * predefinite salvate — che restano attive anche se in questo file sono vuote,
 * perché "devono sempre esserci".
 */
export function initialColumnSelection(
  allColumns: readonly string[],
  withData: readonly string[],
  preset: readonly string[] | null,
): Set<string> {
  const selection = new Set(withData);
  if (preset) {
    const available = new Set(allColumns);
    for (const c of preset) if (available.has(c)) selection.add(c);
  }
  return selection;
}

/** Colonne predefinite che nel file caricato non esistono proprio: da segnalare. */
export function missingPresetColumns(
  allColumns: readonly string[],
  preset: readonly string[] | null,
): string[] {
  if (!preset) return [];
  const available = new Set(allColumns);
  return preset.filter(c => !available.has(c));
}
