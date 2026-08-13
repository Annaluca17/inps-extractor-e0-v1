/**
 * Export verso UniEmens Variazione Builder.
 *
 * Produce un JSON nella forma esatta dello stato del builder (`mkPer()` /
 * `dips`), così l'import è un innesto e non una traduzione. Formati vincolanti,
 * letti dal sorgente del builder:
 *   GiornoInizio / GiornoFine → "AAAA-MM-GG"
 *   AnnoMeseErogazione        → "AAAA-MM"
 *   importi                   → stringa italiana "1234,56"
 *
 * Scelte deliberate:
 *
 * — `AnnoMeseErogazione` è SEMPRE vuoto. La colonna `Denuncia` del file INPS è
 *   il mese di trasmissione, non quello di erogazione: coincidono sugli
 *   arretrati ma non su una correzione tardiva di un periodo ordinario. Il
 *   valore lo mette l'operatore nel builder, consapevolmente.
 *
 * — Periodi dal 10/2012: un quadro per mese, con un blocco enti versanti.
 *   Periodi fino al 09/2012: un quadro aggregato per anno, SENZA enti versanti
 *   (vanno aggiunti solo se nell'anno esiste un V1C1, e in quel caso uno per
 *   mese di pagamento: senza il mese non sarebbero distinguibili fra loro).
 *
 * — La causale la sceglie l'operatore: non è derivabile dal file.
 *   C1 aggiunge al dichiarato, C5 lo sostituisce, C6 lo cancella.
 */
import {
  type InpsRow,
  type QuadriColumns,
  type SheetData,
  numberOf,
  resolveColumn,
  textOf,
  parseDate,
  parseYearMonth,
  ymKey,
} from './inps';

/** Dal 2012-10 INPS impone quadri mono-mese; prima erano ammessi periodi aggregati. */
export const SOGLIA_MONO_MESE = 201210;

export type Causale = '1' | '5' | '6';

export const CAUSALI: { code: Causale; label: string; hint: string }[] = [
  { code: '1', label: 'C1 — aggiunge', hint: 'Somma al già dichiarato' },
  { code: '5', label: 'C5 — sostituisce', hint: 'Rimpiazza la dichiarazione del periodo' },
  { code: '6', label: 'C6 — cancella', hint: 'Annulla il periodo indicato' },
];

export interface EnteVersanteRow {
  id: string;
  TipoContributo: string;
  CFAzienda: string;
  PRGAZIENDA: string;
  Imponibile: string;
  Contributo: string;
  AnnoMeseErogazione: string;
  Aliquota: string;
  pairedTc9?: string;
  pairedWith?: string;
}

export interface BuilderPeriodo {
  id: string;
  tipoQuadro: 'V1';
  CausaleVariazione: Causale;
  CodMotivoUtilizzo: string;
  GiornoInizio: string;
  GiornoFine: string;
  TipoImpiego: string;
  TipoServizio: string;
  Contratto: string;
  Qualifica: string;
  hasPartTime: boolean;
  TipoPartTime: string;
  PercPartTime: string;
  RegimeFineServizio: string;
  GiorniUtiliFiniPensionistici: string;
  ImpCPDEL: string;
  ContribCPDEL: string;
  Contrib1Perc: string;
  ContribSolidarieta: string;
  StipTabellare: string;
  RetribAnzianita: string;
  regimeTFS: 'TFS' | 'TFR';
  ImpTFS: string;
  ContribTFS: string;
  RetribTeoricaTabellareTFR: string;
  ImponibileTFRUlterioriElem: string;
  ContributoTFRUlterioriElem: string;
  RetribValutabileTFR: string;
  ImpCredito: string;
  ContribCredito: string;
  CodiceCessazione: string;
  dmuDataAtto: string;
  dmuIdentAtto: string;
  dmuNumeroRegistro: string;
  enteVersante: EnteVersanteRow[];
  /** Righe del file INPS confluite in questo quadro: traccia di provenienza. */
  _righeOrigine: number[];
}

export interface BuilderDipendente {
  id: string;
  CFLavoratore: string;
  Cognome: string;
  Nome: string;
  CodiceComune: string;
  CAP: string;
  periodi: BuilderPeriodo[];
}

export interface BuilderPayload {
  _formato: 'uniemens-builder-import';
  _versione: 1;
  _generatoDa: string;
  _generatoIl: string;
  _causale: Causale;
  /** Incongruenze rilevate: nel file, non nell'interfaccia. */
  _avvisi: string[];
  dipendenti: BuilderDipendente[];
}

let counter = 0;
function uid(): string {
  counter += 1;
  return `x${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Primo token: "1  - Contratto…" → "1", "0IRCC1 ISTRUTTORI - EX C1" → "0IRCC1". */
export function codeToken(value: string): string {
  const t = value.trim().split(/\s+/)[0] ?? '';
  return t.replace(/[-–]$/, '');
}

/** "COMUNE DI NOTO 00195880893 00000" → CF azienda + progressivo. */
export function parseEnte(value: string): { CFAzienda: string; PRGAZIENDA: string } {
  const m = value.trim().match(/([0-9]{11}|[A-Z0-9]{16})\s+([0-9]{5})\s*$/i);
  if (m) return { CFAzienda: m[1], PRGAZIENDA: m[2] };
  const soloCf = value.trim().match(/([0-9]{11}|[A-Z0-9]{16})\s*$/i);
  return { CFAzienda: soloCf ? soloCf[1] : '', PRGAZIENDA: '00000' };
}

/** "01/05/2025" → "2025-05-01". */
export function toIsoDate(value: string): string {
  const d = parseDate(value);
  if (!d) return '';
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** 1334.32 → "1334,32". Il builder legge anche il punto, ma la virgola non è ambigua. */
export function toItalian(n: number | null): string {
  if (n == null) return '';
  return n.toFixed(2).replace('.', ',');
}

function sum(rows: readonly InpsRow[], column: string | null): number | null {
  if (!column) return null;
  let total = 0;
  let any = false;
  for (const row of rows) {
    const n = numberOf(row, column);
    if (n != null) { total += n; any = true; }
  }
  return any ? Math.round(total * 100) / 100 : null;
}

interface MappedColumns {
  cf: string | null;
  tipoImpiego: string | null;
  tipoServizio: string | null;
  contratto: string | null;
  qualifica: string | null;
  tipoPartTime: string | null;
  percPartTime: string | null;
  regimeFineServizio: string | null;
  giorniUtili: string | null;
  imponibile: string | null;
  contributi: string | null;
  contributo1: string | null;
  stipTabellare: string | null;
  retribAnzianita: string | null;
  impTFS: string | null;
  contribTFS: string | null;
  impTFR: string | null;
  contribTFR: string | null;
  retribTeoricaTFR: string | null;
  retribValutabileTFR: string | null;
  ultElemTFR: string | null;
  contribUltElemTFR: string | null;
  impCredito: string | null;
  contribCredito: string | null;
  ente: string | null;
  causale: string | null;
  denuncia: string | null;
}

function mapColumns(columns: readonly string[]): MappedColumns {
  const r = (...names: string[]) => resolveColumn(columns, names);
  return {
    cf: r('Codice fiscale'),
    tipoImpiego: r('Tipo impiego'),
    tipoServizio: r('Tipo Servizio'),
    contratto: r('Contratto'),
    qualifica: r('Qualifica'),
    tipoPartTime: r('Tipo PART TIME'),
    percPartTime: r('Percentuale part time'),
    regimeFineServizio: r('Regime fine servizio'),
    giorniUtili: r('Giorni utili'),
    imponibile: r('Imponibile'),
    contributi: r('Totale Contributi'),
    contributo1: r('Contributo 1%'),
    stipTabellare: r('Stipendio tabellare'),
    retribAnzianita: r("Retr. indiv. Anzianita'"),
    impTFS: r('Imponibile TFS'),
    contribTFS: r('Contributo TFS'),
    impTFR: r('Imponibile TFR'),
    contribTFR: r('Contributo TFR'),
    retribTeoricaTFR: r('Retribuzione teoriaca tabellare TFR'),
    retribValutabileTFR: r('Retribuzione valutabile ai fini TFR'),
    ultElemTFR: r('Ulteriori Elementi Imp TFR'),
    contribUltElemTFR: r('Contributo Ulteriori Elementi Imp TFR'),
    impCredito: r('Imponibile Credito'),
    contribCredito: r('Contributo Credito'),
    ente: r('Ente Dichiarante in Anagrafica', 'Dichiarante in denuncia'),
    causale: r('Causale Variazione'),
    denuncia: r('Denuncia'),
  };
}

/** Chiave del periodo: mese per i periodi dal 10/2012, anno per quelli precedenti. */
function periodKeyOf(row: InpsRow, dateColumn: string | null): string | null {
  const d = parseDate(textOf(row, dateColumn));
  if (!d) return null;
  const k = ymKey(d);
  return k >= SOGLIA_MONO_MESE
    ? `M${d.year}-${String(d.month).padStart(2, '0')}`
    : `A${d.year}`;
}

/**
 * Inquadramento della riga. Un blocco aggregato può contenere solo righe con
 * lo stesso inquadramento: un anno in cui il dipendente passa da part-time a
 * tempo pieno non può essere dichiarato con un solo `TipoImpiego`.
 */
/**
 * Campi che spezzano un periodo aggregato, perché una loro variazione lo rende
 * indichiarabile con un solo valore:
 *   tipoImpiego  — passaggio part-time ↔ tempo pieno
 *   tipoServizio — passaggio tempo determinato ↔ indeterminato
 *   qualifica    — progressione fra le aree
 *   percPartTime — ma solo dal 2020: prima le percentuali dichiarate dai comuni
 *                  erano spesso errate e spezzare produrrebbe frammentazione
 *                  inutile.
 * `contratto` è escluso: vale sempre RALN, quindi non discrimina nulla.
 * Il confronto è sui codici, non sulle descrizioni.
 */
const INQ_FIELDS = ['tipoImpiego', 'tipoServizio', 'qualifica', 'percPartTime'] as const;

/** Dal 2020 le variazioni di percentuale part-time sono attendibili. */
export const ANNO_PART_TIME_ATTENDIBILE = 2020;

type Inquadramento = Record<string, string>;

function inquadramentoOf(row: InpsRow, m: MappedColumns, anno: number): Inquadramento {
  const out: Inquadramento = {};
  for (const field of INQ_FIELDS) {
    if (field === 'percPartTime') {
      out[field] = anno >= ANNO_PART_TIME_ATTENDIBILE ? String(numberOf(row, m.percPartTime) ?? '') : '';
      continue;
    }
    // Si confrontano i codici, non le descrizioni: la stessa voce può comparire
    // come "056000" o "056000 POSIZIONE ECONOMICA DI ACCESSO C1".
    out[field] = codeToken(textOf(row, m[field]));
  }
  return out;
}

/** Compatibili se nessun campo valorizzato su entrambe le righe è diverso. */
function inquadramentoCompatibile(a: Inquadramento, b: Inquadramento): string | null {
  for (const field of INQ_FIELDS) {
    const x = a[field];
    const y = b[field];
    if (x !== '' && y !== '' && x !== y) return field;
  }
  return null;
}

/** Unione: i campi vuoti dell'uno vengono completati dall'altro. */
function inquadramentoUnione(a: Inquadramento, b: Inquadramento): Inquadramento {
  const out: Inquadramento = {};
  for (const field of INQ_FIELDS) out[field] = a[field] || b[field];
  return out;
}

const INQ_LABEL: Record<string, string> = {
  tipoImpiego: 'Tipo impiego',
  tipoServizio: 'Tipo Servizio',
  qualifica: 'Qualifica',
  percPartTime: 'Percentuale part time',
};

interface Block {
  periodKey: string;
  monoMese: boolean;
  inq: Inquadramento;
  rows: InpsRow[];
  /** Enti versanti per mese di pagamento: anni ante 10/2012 che contengono un V1C1. */
  evPerMesePagamento: boolean;
}

/** Terna TC1 / TC9 / TC7 per un insieme di righe. */
function enteVersanteSet(
  rows: readonly InpsRow[],
  m: MappedColumns,
  ente: { CFAzienda: string; PRGAZIENDA: string },
  annoMese: string,
): EnteVersanteRow[] {
  const impCPDEL = sum(rows, m.imponibile);
  const contribCPDEL = sum(rows, m.contributi);
  const impCredito = sum(rows, m.impCredito);
  const contribCredito = sum(rows, m.contribCredito);
  const impTFS = sum(rows, m.impTFS) ?? sum(rows, m.impTFR);
  const contribTFS = sum(rows, m.contribTFS) ?? sum(rows, m.contribTFR);

  const base = { CFAzienda: ente.CFAzienda, PRGAZIENDA: ente.PRGAZIENDA, AnnoMeseErogazione: annoMese, Aliquota: '2' };
  const out: EnteVersanteRow[] = [];
  const t1 = uid();
  const t9 = uid();

  out.push({ id: t1, TipoContributo: '1', ...base, Imponibile: toItalian(impCPDEL), Contributo: toItalian(contribCPDEL), pairedTc9: t9 });
  out.push({ id: t9, TipoContributo: '9', ...base, Imponibile: toItalian(impCredito ?? impCPDEL), Contributo: toItalian(contribCredito), pairedWith: t1 });
  if (impTFS != null && impTFS !== 0) {
    out.push({ id: uid(), TipoContributo: '7', ...base, Imponibile: toItalian(impTFS), Contributo: toItalian(contribTFS) });
  }
  return out;
}

/**
 * Enti versanti di un anno con V1C1: una terna per ogni mese di pagamento.
 * Qui `AnnoMeseErogazione` viene valorizzato dalla colonna `Denuncia`, perché
 * senza il mese le terne sarebbero indistinguibili fra loro e il dettaglio —
 * che è tutto il motivo per cui servono — andrebbe perso. Va comunque
 * verificato: `Denuncia` è il mese di trasmissione, che per gli arretrati
 * coincide con quello di erogazione ma non è la stessa cosa.
 */
function enteVersantePerMesePagamento(
  rows: readonly InpsRow[],
  m: MappedColumns,
  ente: { CFAzienda: string; PRGAZIENDA: string },
): EnteVersanteRow[] {
  const perMese = new Map<string, InpsRow[]>();
  for (const row of rows) {
    const ym = parseYearMonth(textOf(row, m.denuncia));
    const key = ym ? `${ym.year}-${String(ym.month).padStart(2, '0')}` : '';
    const arr = perMese.get(key);
    if (arr) arr.push(row); else perMese.set(key, [row]);
  }
  const mesi = Array.from(perMese.keys()).sort();
  const out: EnteVersanteRow[] = [];
  for (const mese of mesi) out.push(...enteVersanteSet(perMese.get(mese)!, m, ente, mese));
  return out;
}

export function buildUniemensPayload(
  rows: readonly InpsRow[],
  sheet: SheetData,
  cols: QuadriColumns,
  causale: Causale,
): BuilderPayload {
  counter = 0;
  const m = mapColumns(sheet.columns);
  const avvisi: string[] = [];

  // Un dipendente per codice fiscale, nell'ordine di comparsa.
  const perCf = new Map<string, InpsRow[]>();
  for (const row of rows) {
    const cf = textOf(row, m.cf);
    const arr = perCf.get(cf);
    if (arr) arr.push(row); else perCf.set(cf, [row]);
  }

  const dipendenti: BuilderDipendente[] = [];

  for (const [cf, cfRows] of Array.from(perCf.entries())) {
    // Ordine cronologico crescente: i quadri escono in sequenza e i blocchi
    // contigui sono ben definiti a prescindere dall'ordinamento a schermo.
    const ordered = cfRows.slice().sort((a, b) => {
      const ia = toIsoDate(textOf(a, cols.data));
      const ib = toIsoDate(textOf(b, cols.data));
      if (ia !== ib) return ia < ib ? -1 : 1;
      const fa = toIsoDate(textOf(a, cols.dataFine));
      const fb = toIsoDate(textOf(b, cols.dataFine));
      if (fa !== fb) return fa < fb ? -1 : 1;
      return a.__id - b.__id;
    });

    // Anni ante 10/2012 che contengono un V1C1: vanno riprodotti interi, con
    // gli enti versanti per mese di pagamento. Non si spezzano e non si
    // cumulano in una cifra sola: il dettaglio per mese è ciò che impedisce
    // che il C1 venga mal attribuito.
    const anniConC1 = new Set<string>();
    for (const row of ordered) {
      const periodKey = periodKeyOf(row, cols.data);
      if (!periodKey || periodKey.startsWith('M')) continue;
      const isV1 = textOf(row, cols.tipologia).toUpperCase() === 'V1';
      if (isV1 && codeToken(textOf(row, m.causale)) === '1') anniConC1.add(periodKey);
    }

    // Un blocco nuovo inizia quando cambia il periodo oppure l'inquadramento.
    const blocks: Block[] = [];
    let current: Block | null = null;
    for (const row of ordered) {
      const periodKey = periodKeyOf(row, cols.data);
      if (!periodKey) {
        avvisi.push(`Riga ${row.__id}: data inizio periodo non interpretabile, esclusa.`);
        continue;
      }
      const annoIntero = anniConC1.has(periodKey);
      const anno = Number(periodKey.slice(1, 5));
      const inq = inquadramentoOf(row, m, anno);
      // Sugli anni con V1C1 non si spezza: l'anno esce intero.
      const cambio = current && current.periodKey === periodKey && !annoIntero
        ? inquadramentoCompatibile(current.inq, inq)
        : null;

      if (!current || current.periodKey !== periodKey || cambio) {
        if (cambio) {
          avvisi.push(`${cf} ${periodKey.slice(1)}: periodo spezzato alla riga ${row.__id} per cambio di "${INQ_LABEL[cambio]}" (${current!.inq[cambio]} → ${inq[cambio]}).`);
        }
        current = {
          periodKey,
          monoMese: periodKey.startsWith('M'),
          inq,
          rows: [],
          evPerMesePagamento: annoIntero,
        };
        blocks.push(current);
      } else {
        current.inq = inquadramentoUnione(current.inq, inq);
      }
      current.rows.push(row);
    }

    const periodi: BuilderPeriodo[] = [];

    for (const block of blocks) {
      const blockRows = block.rows;
      const monoMese = block.monoMese;
      // Estremi effettivi del blocco.
      const starts = blockRows.map(r => toIsoDate(textOf(r, cols.data))).filter(Boolean).sort();
      const ends = blockRows.map(r => toIsoDate(textOf(r, cols.dataFine))).filter(Boolean).sort();
      const giornoInizio = starts[0] ?? '';
      const giornoFine = ends[ends.length - 1] ?? '';

      // Inquadramento: quello del blocco, omogeneo per costruzione. Gli altri
      // campi vengono dall'ultima riga del blocco.
      const ref = blockRows[blockRows.length - 1];
      const inq = block.inq;
      const ente = parseEnte(textOf(ref, m.ente));
      if (block.evPerMesePagamento) {
        const senzaDenuncia = blockRows.filter(r => parseYearMonth(textOf(r, m.denuncia)) == null);
        if (senzaDenuncia.length > 0) {
          avvisi.push(`${cf} ${block.periodKey.slice(1)}: ${senzaDenuncia.length} righe senza denuncia interpretabile (${senzaDenuncia.map(r => r.__id).join(', ')}); il relativo ente versante esce senza mese.`);
        }
        // L'anno esce intero perché contiene un V1C1: se l'inquadramento varia
        // al suo interno, il quadro ne porta comunque un solo valore.
        const anno = Number(block.periodKey.slice(1, 5));
        for (const field of INQ_FIELDS) {
          const valori = Array.from(new Set(
            blockRows.map(r => inquadramentoOf(r, m, anno)[field]).filter(Boolean),
          ));
          if (valori.length > 1) {
            avvisi.push(`${cf} ${block.periodKey.slice(1)}: anno riprodotto intero per la presenza di un V1C1, ma "${INQ_LABEL[field]}" varia (${valori.join(' | ')}); il quadro riporta ${block.inq[field]}.`);
          }
        }
      }
      const impTFR = sum(blockRows, m.impTFR);
      const impTFSraw = sum(blockRows, m.impTFS);
      const regimeTFS: 'TFS' | 'TFR' = (impTFR != null && impTFR !== 0) ? 'TFR' : 'TFS';
      const tipoImpiego = inq.tipoImpiego;

      const isC6 = causale === '6';
      const isC1 = causale === '1';

      const periodo: BuilderPeriodo = {
        id: uid(),
        tipoQuadro: 'V1',
        CausaleVariazione: causale,
        CodMotivoUtilizzo: '',
        GiornoInizio: giornoInizio,
        GiornoFine: giornoFine,
        TipoImpiego: isC6 ? '' : tipoImpiego,
        TipoServizio: isC6 ? '' : inq.tipoServizio,
        Contratto: isC6 ? '' : inq.contratto,
        Qualifica: isC6 ? '' : inq.qualifica,
        hasPartTime: !isC6 && (tipoImpiego === '8' || tipoImpiego === '18'),
        TipoPartTime: isC6 ? '' : inq.tipoPartTime,
        PercPartTime: isC6 ? '' : inq.percPartTime,
        RegimeFineServizio: isC6 ? '' : inq.regimeFineServizio,
        GiorniUtiliFiniPensionistici: isC6 ? '' : textOf(ref, m.giorniUtili),
        // C1 aggiunge denaro nuovo, che nel file non c'è: importi vuoti.
        ImpCPDEL: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.imponibile)),
        ContribCPDEL: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.contributi)),
        Contrib1Perc: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.contributo1)),
        ContribSolidarieta: '',
        StipTabellare: isC6 ? '' : (toItalian(numberOf(ref, m.stipTabellare)) || '0,00'),
        RetribAnzianita: isC6 ? '' : (toItalian(numberOf(ref, m.retribAnzianita)) || '0,00'),
        regimeTFS,
        ImpTFS: isC6 || isC1 ? '' : toItalian(regimeTFS === 'TFR' ? impTFR : impTFSraw),
        ContribTFS: isC6 || isC1 ? '' : toItalian(sum(blockRows, regimeTFS === 'TFR' ? m.contribTFR : m.contribTFS)),
        RetribTeoricaTabellareTFR: isC6 ? '' : toItalian(numberOf(ref, m.retribTeoricaTFR)),
        ImponibileTFRUlterioriElem: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.ultElemTFR)),
        ContributoTFRUlterioriElem: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.contribUltElemTFR)),
        RetribValutabileTFR: isC6 ? '' : toItalian(sum(blockRows, m.retribValutabileTFR)),
        ImpCredito: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.impCredito)),
        ContribCredito: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.contribCredito)),
        CodiceCessazione: isC6 ? '' : codeToken(textOf(ref, cols.cessazione)),
        dmuDataAtto: '',
        dmuIdentAtto: '',
        dmuNumeroRegistro: '',
        enteVersante: (isC6 || isC1)
          ? []
          : block.evPerMesePagamento
            // Anno con V1C1: una terna per mese di pagamento, mese valorizzato.
            ? enteVersantePerMesePagamento(blockRows, m, ente)
            : monoMese
              // Quadro mensile: una terna, mese da compilare nel builder.
              ? enteVersanteSet(blockRows, m, ente, '')
              // Aggregato senza V1C1: si cumula, niente enti versanti.
              : [],
        _righeOrigine: blockRows.map(r => r.__id),
      };

      periodi.push(periodo);
    }

    dipendenti.push({
      id: uid(),
      CFLavoratore: cf,
      Cognome: '',
      Nome: '',
      CodiceComune: '',
      CAP: '',
      periodi,
    });
  }

  return {
    _formato: 'uniemens-builder-import',
    _versione: 1,
    _generatoDa: 'INPS Extractor E0/V1',
    _generatoIl: new Date().toISOString().slice(0, 10),
    _causale: causale,
    _avvisi: avvisi,
    dipendenti,
  };
}

/** Scarica il payload come file JSON. */
export function downloadPayload(payload: BuilderPayload, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
