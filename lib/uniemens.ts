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
 * — `AnnoMeseErogazione` viene dalla colonna `Denuncia`. Attenzione: `Denuncia`
 *   è il mese di trasmissione, che sugli arretrati coincide con quello di
 *   erogazione — il caso in cui l'ente versante serve — ma non è la stessa
 *   cosa. Resta un valore da controllare, non da firmare a scatola chiusa.
 *
 * — L'aggregazione dei quadri dipende dal periodo: dal 10/2012 un quadro per
 *   mese, prima un quadro per anno (intero se l'anno contiene un V1C1,
 *   altrimenti cumulato). Gli enti versanti invece si emettono sempre, una
 *   terna per ciascun mese di pagamento, compreso il mese di competenza: la
 *   somma degli EnteVersante deve quadrare al centesimo con le gestioni
 *   dichiarate, altrimenti INPS respinge il quadro (00171I / 00032I).
 *   Verificato su flussi reali accettati, sia mono-mese sia annuali.
 *
 * — La terna di fine servizio è TC7 in regime TFS e TC8 in regime TFR: sono
 *   gestioni distinte e il controllo di congruità le confronta separate.
 *
 * — Il regime è quello DICHIARATO nella colonna `Regime fine servizio`, non
 *   quello dedotto da dove ci sono gli importi. Sono due cose diverse quando un
 *   blocco mescola righe di regime diverso — il caso tipico è il passaggio da
 *   TFS a TFR — e dedurlo dagli importi produce quadri in cui
 *   `RegimeFineServizio` dice una cosa e la gestione previdenziale un'altra,
 *   con la terna emessa sulla gestione sbagliata e l'imponibile dell'altro
 *   regime scartato in silenzio. Gli importi valgono solo come ripiego sulle
 *   righe che il codice non ce l'hanno (ante 10/2012).
 *
 * — La causale la sceglie l'operatore: non è derivabile dal file.
 *   C1 aggiunge al dichiarato, C5 lo sostituisce, C6 lo cancella.
 *
 * — Cognome, nome, comune, CAP e frontespizio non esistono nel tracciato
 *   PASSWEB: li digita l'operatore e viaggiano solo in questo JSON.
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

/**
 * Dati del lavoratore che il tracciato PASSWEB non contiene ma che l'XML
 * pretende: `Cognome` e `Nome` sono obbligatori, comune e CAP compongono
 * `DatiSedeLavoro`. Li digita l'operatore, per codice fiscale.
 */
export interface AnagraficaDipendente {
  Cognome: string;
  Nome: string;
  CodiceComune: string;
  CAP: string;
}

/** Intestazione della denuncia: nel file INPS non c'è, la digita l'operatore. */
export interface Mittente {
  CFPersonaMittente: string;
  RagSocMittente: string;
  CFMittente: string;
  CFSoftwarehouse: string;
  SedeINPS: string;
}

export interface AziendaDenuncia {
  AnnoMeseDenuncia: string;
  CFAzienda: string;
  RagSocAzienda: string;
  PRGAZIENDA: string;
  CFRappresentanteFirmatario: string;
  ISTAT: string;
  FormaGiuridica: string;
}

export const MITTENTE_VUOTO: Mittente = {
  CFPersonaMittente: '', RagSocMittente: '', CFMittente: '',
  CFSoftwarehouse: '00000000000', SedeINPS: '',
};

export const AZIENDA_VUOTA: AziendaDenuncia = {
  AnnoMeseDenuncia: '', CFAzienda: '', RagSocAzienda: '', PRGAZIENDA: '00000',
  CFRappresentanteFirmatario: '', ISTAT: '', FormaGiuridica: '2430',
};

/**
 * Quanto l'operatore aggiunge a mano prima dell'export JSON. Non tocca
 * l'export XLSX, che resta la trascrizione fedele del file INPS.
 */
export interface DatiAggiuntivi {
  anagrafica?: ReadonlyMap<string, AnagraficaDipendente>;
  mittente?: Mittente;
  azienda?: AziendaDenuncia;
}

export interface BuilderPayload {
  _formato: 'uniemens-builder-import';
  _versione: 1;
  _generatoDa: string;
  _generatoIl: string;
  _causale: Causale;
  /** Incongruenze rilevate: nel file, non nell'interfaccia. */
  _avvisi: string[];
  /** Frontespizio digitato dall'operatore; assente se non compilato. */
  _mittente?: Mittente;
  _azienda?: AziendaDenuncia;
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

/**
 * Lo XSD DMA2 ammette solo P / V / M. La voce "orizzontale" compare anche
 * come `O` nei flussi, che l'XSD rifiuta: vale come P.
 */
export function tipoPartTimeOf(value: string): string {
  const t = codeToken(value).toUpperCase();
  return t === 'O' ? 'P' : t;
}

/**
 * Percentuale part-time nel formato DMA2: un intero, cioè la percentuale con
 * tre decimali e senza separatore — 66,67% si dichiara `66670`. PASSWEB la
 * espone invece come decimale (`66.67`), quindi va riscalata: passarla così
 * com'è produce un valore cento volte più piccolo del dovuto.
 *
 * Un valore già maggiore di 100 non può essere una percentuale: è di sicuro
 * già nella forma DMA2 e si lascia stare.
 */
export function percPartTimeOf(value: string): string {
  const s = String(value ?? '').trim();
  if (s === '') return '';
  const n = Number(s.replace(/[^\d,.-]/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n === 0) return '';
  return String(Math.round(n > 100 ? n : n * 1000));
}

/**
 * Codice motivo cessazione. Il tracciato usa `0` per dire "nessuna
 * cessazione": è un riempitivo, non un codice, e non va dichiarato.
 */
export function codiceCessazioneOf(value: string): string {
  const c = codeToken(value);
  return c === '0' ? '' : c;
}

/**
 * Gestione previdenziale corrispondente al codice `Regime fine servizio`:
 * 1 = TFR privatistico, 2 = TFR misto, 3 = TFS (ex INADEL). È la stessa
 * corrispondenza che applica il builder quando l'operatore cambia il campo a
 * mano. `null` quando il codice manca o non è riconosciuto: le righe ante
 * 10/2012 non lo portano affatto.
 */
export function regimeDaCodice(value: string): 'TFS' | 'TFR' | null {
  const c = codeToken(value);
  if (c === '1' || c === '2') return 'TFR';
  if (c === '3') return 'TFS';
  return null;
}

/** Stati che dicono "questa riga è già stata sostituita da un'altra". */
const STATI_SUPERATI = ['spento', 'obsoleto', 'annullato'];

/**
 * Riga superata: il suo contenuto non è più quello dichiarato a INPS. Prenderla
 * a riferimento significa copiare l'inquadramento di una dichiarazione morta.
 */
export function statoSuperato(value: string): boolean {
  return STATI_SUPERATI.includes(value.trim().toLowerCase());
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

/**
 * Somma prendendo, riga per riga, la prima colonna valorizzata.
 *
 * Serve dove lo stesso dato cambia colonna a seconda dell'epoca della riga:
 * l'imponibile del Fondo Credito sta in `Imponibile Credito` sulle righe
 * recenti e in `Imponibile Credito/ENPDEP` su quelle vecchie, e un file che
 * copre molti anni le usa entrambe.
 */
function sumFirstOf(rows: readonly InpsRow[], columns: readonly (string | null)[]): number | null {
  let total = 0;
  let any = false;
  for (const row of rows) {
    for (const column of columns) {
      const n = numberOf(row, column);
      if (n != null) { total += n; any = true; break; }
    }
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
  impCreditoEnpdep: string | null;
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
    impCreditoEnpdep: r('Imponibile Credito/ENPDEP'),
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
 *   regimeFineServizio — passaggio TFS ↔ TFR: sono gestioni previdenziali
 *                  distinte, un quadro ne dichiara una sola e gli importi
 *                  dell'altra non avrebbero dove andare
 *   percPartTime — ma solo dal 2020: prima le percentuali dichiarate dai comuni
 *                  erano spesso errate e spezzare produrrebbe frammentazione
 *                  inutile.
 * `contratto` è escluso: vale sempre RALN, quindi non discrimina nulla.
 * Il confronto è sui codici, non sulle descrizioni.
 */
const INQ_FIELDS = ['tipoImpiego', 'tipoServizio', 'qualifica', 'regimeFineServizio', 'percPartTime'] as const;

/** Dal 2020 le variazioni di percentuale part-time sono attendibili. */
export const ANNO_PART_TIME_ATTENDIBILE = 2020;

type Inquadramento = Record<string, string>;

function inquadramentoOf(row: InpsRow, m: MappedColumns): Inquadramento {
  const out: Inquadramento = {};
  for (const field of INQ_FIELDS) {
    // Si confrontano i codici, non le descrizioni: la stessa voce può comparire
    // come "056000" o "056000 POSIZIONE ECONOMICA DI ACCESSO C1".
    out[field] = field === 'percPartTime'
      ? textOf(row, m.percPartTime)
      : codeToken(textOf(row, m[field]));
  }
  return out;
}

/**
 * Compatibili se nessun campo valorizzato su entrambe le righe è diverso.
 * Prima del 2020 la percentuale part-time non viene confrontata — il valore
 * resta però nel quadro: si ignora ai fini della spezzatura, non si cancella.
 */
function inquadramentoCompatibile(a: Inquadramento, b: Inquadramento, anno: number): string | null {
  for (const field of INQ_FIELDS) {
    if (field === 'percPartTime' && anno < ANNO_PART_TIME_ATTENDIBILE) continue;
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
  regimeFineServizio: 'Regime fine servizio',
  percPartTime: 'Percentuale part time',
};

interface Block {
  periodKey: string;
  inq: Inquadramento;
  rows: InpsRow[];
  /** Enti versanti per mese di pagamento: anni ante 10/2012 che contengono un V1C1. */
  evPerMesePagamento: boolean;
  /** Riga di riferimento quando il blocco nasce da una cumulazione manuale. */
  cumuloManuale?: InpsRow;
}

/**
 * Terna TC1 / TC9 / fine servizio per un insieme di righe.
 *
 * Il tipo contributo del fine servizio dipende dal regime del quadro: TC7 per
 * il TFS, TC8 per il TFR. Sono gestioni distinte — la validazione del builder
 * confronta Σ TC7 con `ImponibileTFS` e Σ TC8 con `ImponibileTFR`, quindi una
 * terna col codice sbagliato lascia scoperta la gestione dichiarata.
 */
function enteVersanteSet(
  rows: readonly InpsRow[],
  m: MappedColumns,
  ente: { CFAzienda: string; PRGAZIENDA: string },
  annoMese: string,
  regimeTFS: 'TFS' | 'TFR',
): EnteVersanteRow[] {
  const impCPDEL = sum(rows, m.imponibile);
  const contribCPDEL = sum(rows, m.contributi);
  const impCredito = sumFirstOf(rows, [m.impCredito, m.impCreditoEnpdep]);
  const contribCredito = sum(rows, m.contribCredito);
  const isTFR = regimeTFS === 'TFR';
  const impFineServizio = sum(rows, isTFR ? m.impTFR : m.impTFS);
  const contribFineServizio = sum(rows, isTFR ? m.contribTFR : m.contribTFS);

  const base = { CFAzienda: ente.CFAzienda, PRGAZIENDA: ente.PRGAZIENDA, AnnoMeseErogazione: annoMese, Aliquota: '2' };
  const out: EnteVersanteRow[] = [];
  const t1 = uid();
  const t9 = uid();

  out.push({ id: t1, TipoContributo: '1', ...base, Imponibile: toItalian(impCPDEL), Contributo: toItalian(contribCPDEL), pairedTc9: t9 });
  out.push({ id: t9, TipoContributo: '9', ...base, Imponibile: toItalian(impCredito ?? impCPDEL), Contributo: toItalian(contribCredito), pairedWith: t1 });
  if (impFineServizio != null && impFineServizio !== 0) {
    out.push({ id: uid(), TipoContributo: isTFR ? '8' : '7', ...base, Imponibile: toItalian(impFineServizio), Contributo: toItalian(contribFineServizio) });
  }
  return out;
}

/**
 * Enti versanti: una terna per ogni mese di pagamento, con
 * `AnnoMeseErogazione` preso dalla colonna `Denuncia`.
 *
 * Nota d'uso: `Denuncia` è il mese di trasmissione. Per gli arretrati coincide
 * con quello di erogazione — che è il caso in cui l'ente versante serve — ma
 * non è la stessa cosa, quindi resta un valore da controllare nel builder,
 * non da firmare a scatola chiusa.
 *
 * Nessun mese viene escluso, nemmeno quello di competenza del quadro: la somma
 * delle terne deve ricostruire per intero gli imponibili dichiarati, e una
 * terna omessa diventa un residuo che INPS contesta.
 */
function enteVersantePerMesePagamento(
  rows: readonly InpsRow[],
  m: MappedColumns,
  ente: { CFAzienda: string; PRGAZIENDA: string },
  regimeTFS: 'TFS' | 'TFR',
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
  for (const mese of mesi) out.push(...enteVersanteSet(perMese.get(mese)!, m, ente, mese, regimeTFS));
  return out;
}

/**
 * Periodo di riferimento di una cumulazione manuale: l'ultimo mese lavorato,
 * cioè la riga che porta un codice motivo cessazione. In mancanza, la più
 * antica fra quelle scelte.
 *
 * Le righe superate (Spento / Obsoleto / Annullato) valgono solo se non c'è
 * altro: dal riferimento il quadro copia inquadramento, regime e date, e
 * quelli di una dichiarazione già sostituita non sono più il dichiarato. Il
 * caso reale: la riga E0 Spenta in regime TFS accanto al V1 Corrente che l'ha
 * rifatta in TFR — entrambe con lo stesso codice cessazione e la stessa data.
 */
export function riferimentoCumulo(
  rows: readonly InpsRow[],
  cols: QuadriColumns,
): InpsRow | null {
  if (rows.length === 0) return null;
  const vive = rows.filter(r => !statoSuperato(textOf(r, cols.stato)));
  const base = vive.length > 0 ? vive : rows;
  const conCessazione = base.filter(r => codiceCessazioneOf(textOf(r, cols.cessazione)) !== '');
  const candidati = conCessazione.length > 0 ? conCessazione : base;
  return candidati.reduce((best, r) =>
    toIsoDate(textOf(r, cols.data)) < toIsoDate(textOf(best, cols.data)) ? r : best);
}

export function buildUniemensPayload(
  rows: readonly InpsRow[],
  sheet: SheetData,
  cols: QuadriColumns,
  causale: Causale,
  /**
   * Righe da fondere in un unico quadro, indicate a mano dall'operatore.
   * Serve per i pagamenti successivi alla cessazione, che vanno tutti sommati
   * all'ultimo mese lavorato: distinguere un E0 sbagliato da una riassunzione
   * (gli stagionali) non è deducibile dal file, quindi lo dice l'operatore.
   */
  cumula: ReadonlySet<number> = new Set(),
  /**
   * Anagrafica e frontespizio digitati dall'operatore: il tracciato PASSWEB
   * non li contiene e l'XML non può farne a meno.
   */
  extra: DatiAggiuntivi = {},
): BuilderPayload {
  counter = 0;
  const m = mapColumns(sheet.columns);
  const avvisi: string[] = [];
  const isC6 = causale === '6';
  const isC1 = causale === '1';
  // Solo la C5 porta gli enti versanti: la C6 cancella e la C1 aggiunge
  // denaro nuovo, che nel file non c'è.
  const emetteEnteVersante = !isC6 && !isC1;

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

    // Righe marcate a mano: un unico blocco, riferimento all'ultimo mese
    // lavorato. Tutto il resto segue le regole automatiche.
    const daCumulare = causale === '5' ? ordered.filter(r => cumula.has(r.__id)) : [];
    const restanti = daCumulare.length > 0 ? ordered.filter(r => !cumula.has(r.__id)) : ordered;

    // Un blocco nuovo inizia quando cambia il periodo oppure l'inquadramento.
    const blocks: Block[] = [];
    let current: Block | null = null;

    if (daCumulare.length > 0) {
      const rif = riferimentoCumulo(daCumulare, cols)!;
      const periodKey = periodKeyOf(rif, cols.data) ?? 'M';
      // Inquadramento del cumulo: quello del riferimento, completato dalle
      // altre righe scelte per i campi che il riferimento non porta — gli
      // arretrati ripetono di rado regime e qualifica. Le righe superate
      // vengono per ultime: valgono solo dove non c'è nient'altro.
      const perInquadramento = [
        rif,
        ...daCumulare.filter(r => r !== rif && !statoSuperato(textOf(r, cols.stato))),
        ...daCumulare.filter(r => r !== rif && statoSuperato(textOf(r, cols.stato))),
      ];
      blocks.push({
        periodKey,
        inq: perInquadramento.map(r => inquadramentoOf(r, m)).reduce(inquadramentoUnione),
        rows: daCumulare,
        evPerMesePagamento: false,
        cumuloManuale: rif,
      });
      const mesi = Array.from(new Set(daCumulare.map(r => textOf(r, m.denuncia)).filter(Boolean)));
      avvisi.push(`${cf}: ${daCumulare.length} righe cumulate a mano su ${toIsoDate(textOf(rif, cols.data))} (righe ${daCumulare.map(r => r.__id).join(', ')}; pagamenti ${mesi.join(', ')}).`);
      // Ci si arriva solo se ogni riga scelta è superata: il quadro copierebbe
      // inquadramento e regime da una dichiarazione già sostituita.
      if (statoSuperato(textOf(rif, cols.stato))) {
        avvisi.push(`${cf}: la riga di riferimento del cumulo (${rif.__id}) è "${textOf(rif, cols.stato)}"; inquadramento, regime e date del quadro vengono da una dichiarazione già sostituita.`);
      }
    }

    for (const row of restanti) {
      const periodKey = periodKeyOf(row, cols.data);
      if (!periodKey) {
        avvisi.push(`Riga ${row.__id}: data inizio periodo non interpretabile, esclusa.`);
        continue;
      }
      const annoIntero = anniConC1.has(periodKey);
      const anno = Number(periodKey.slice(1, 5));
      const inq = inquadramentoOf(row, m);
      // Sugli anni con V1C1 non si spezza: l'anno esce intero.
      const cambio = current && current.periodKey === periodKey && !annoIntero
        ? inquadramentoCompatibile(current.inq, inq, anno)
        : null;

      if (!current || current.periodKey !== periodKey || cambio) {
        if (cambio) {
          avvisi.push(`${cf} ${periodKey.slice(1)}: periodo spezzato alla riga ${row.__id} per cambio di "${INQ_LABEL[cambio]}" (${current!.inq[cambio]} → ${inq[cambio]}).`);
        }
        current = {
          periodKey,
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
      // Estremi effettivi del blocco.
      let giornoInizio: string;
      let giornoFine: string;
      if (block.cumuloManuale) {
        // Il periodo è quello della riga di riferimento: le altre confluiscono
        // come importi, non come estensione del periodo.
        giornoInizio = toIsoDate(textOf(block.cumuloManuale, cols.data));
        giornoFine = toIsoDate(textOf(block.cumuloManuale, cols.dataFine));
      } else {
        const starts = blockRows.map(r => toIsoDate(textOf(r, cols.data))).filter(Boolean).sort();
        const ends = blockRows.map(r => toIsoDate(textOf(r, cols.dataFine))).filter(Boolean).sort();
        giornoInizio = starts[0] ?? '';
        giornoFine = ends[ends.length - 1] ?? '';
      }

      // Inquadramento: quello del blocco, omogeneo per costruzione. Gli altri
      // campi vengono dall'ultima riga del blocco.
      const ref = block.cumuloManuale ?? blockRows[blockRows.length - 1];
      const inq = block.inq;
      const ente = parseEnte(textOf(ref, m.ente));
      // Vale per ogni quadro che porta enti versanti, non solo per gli anni
      // riprodotti interi: senza mese la terna resta fuori dall'XML.
      if (emetteEnteVersante) {
        const senzaDenuncia = blockRows.filter(r => parseYearMonth(textOf(r, m.denuncia)) == null);
        if (senzaDenuncia.length > 0) {
          avvisi.push(`${cf} ${block.periodKey.slice(1)}: ${senzaDenuncia.length} righe senza denuncia interpretabile (${senzaDenuncia.map(r => r.__id).join(', ')}); il relativo ente versante esce senza mese.`);
        }
      }
      if (block.evPerMesePagamento) {
        // L'anno esce intero perché contiene un V1C1: se l'inquadramento varia
        // al suo interno, il quadro ne porta comunque un solo valore.
        const annoBlocco = Number(block.periodKey.slice(1, 5));
        for (const field of INQ_FIELDS) {
          if (field === 'percPartTime' && annoBlocco < ANNO_PART_TIME_ATTENDIBILE) continue;
          const valori = Array.from(new Set(
            blockRows.map(r => inquadramentoOf(r, m)[field]).filter(Boolean),
          ));
          if (valori.length > 1) {
            avvisi.push(`${cf} ${block.periodKey.slice(1)}: anno riprodotto intero per la presenza di un V1C1, ma "${INQ_LABEL[field]}" varia (${valori.join(' | ')}); il quadro riporta ${block.inq[field]}.`);
          }
        }
      }
      const impTFR = sum(blockRows, m.impTFR);
      const impTFSraw = sum(blockRows, m.impTFS);

      // Il regime lo dichiara il file. `inq.regimeFineServizio` è il codice del
      // blocco: unico per costruzione, perché una variazione lo spezza. Gli
      // importi decidono solo dove il codice non c'è (righe ante 10/2012).
      const codiceRegime = inq.regimeFineServizio;
      const regimeTFS: 'TFS' | 'TFR' =
        regimeDaCodice(codiceRegime) ?? ((impTFR != null && impTFR !== 0) ? 'TFR' : 'TFS');

      // Un blocco con due regimi resta possibile dove la spezzatura non si
      // applica: cumulo manuale e anni riprodotti interi per la presenza di un
      // V1C1. Il quadro ne dichiara uno solo, quindi va detto quale.
      const codiciRegime = Array.from(new Set(
        blockRows.map(r => codeToken(textOf(r, m.regimeFineServizio))).filter(Boolean),
      ));
      if (codiciRegime.length > 1) {
        avvisi.push(`${cf} ${block.periodKey.slice(1)}: le righe portano regimi di fine servizio diversi (${codiciRegime.join(' | ')}); il quadro dichiara ${codiceRegime || '(nessuno)'} → ${regimeTFS}.`);
      }

      // Contropartita della scelta del regime: quanto sta nella colonna
      // dell'altro non ha una gestione in cui finire e resterebbe fuori dal
      // quadro e dalle terne senza che si veda.
      const impScartato = regimeTFS === 'TFR' ? impTFSraw : impTFR;
      if (impScartato != null && impScartato !== 0) {
        const colonnaScartata = regimeTFS === 'TFR' ? 'TFS' : 'TFR';
        const righeScartate = blockRows
          .filter(r => numberOf(r, regimeTFS === 'TFR' ? m.impTFS : m.impTFR) != null)
          .map(r => r.__id);
        avvisi.push(`${cf} ${block.periodKey.slice(1)}: quadro in regime ${regimeTFS}, ma le righe ${righeScartate.join(', ')} portano ${toItalian(impScartato)} di imponibile ${colonnaScartata}; quell'importo resta fuori dal quadro e dalle terne.`);
      }

      const tipoImpiego = inq.tipoImpiego;

      const periodo: BuilderPeriodo = {
        id: uid(),
        tipoQuadro: 'V1',
        CausaleVariazione: causale,
        CodMotivoUtilizzo: '',
        GiornoInizio: giornoInizio,
        GiornoFine: giornoFine,
        TipoImpiego: isC6 ? '' : tipoImpiego,
        TipoServizio: isC6 ? '' : inq.tipoServizio,
        Qualifica: isC6 ? '' : inq.qualifica,
        PercPartTime: isC6 ? '' : percPartTimeOf(inq.percPartTime),
        // Non fanno parte dei criteri di spezzatura: si leggono dalla riga di
        // riferimento, non dall'inquadramento del blocco.
        Contratto: isC6 ? '' : codeToken(textOf(ref, m.contratto)),
        TipoPartTime: isC6 ? '' : tipoPartTimeOf(textOf(ref, m.tipoPartTime)),
        RegimeFineServizio: isC6 ? '' : codiceRegime,
        hasPartTime: !isC6 && (tipoImpiego === '8' || tipoImpiego === '18'),
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
        // Sommata come la valutabile: sono due facce della stessa retribuzione
        // del periodo dichiarato, e leggerne una dalla sola riga di riferimento
        // la lasciava vuota ogni volta che il fine servizio stava su un'altra
        // riga del blocco. Vuota, in regime TFR, è un quadro che INPS respinge.
        RetribTeoricaTabellareTFR: isC6 ? '' : toItalian(sum(blockRows, m.retribTeoricaTFR)),
        ImponibileTFRUlterioriElem: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.ultElemTFR)),
        ContributoTFRUlterioriElem: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.contribUltElemTFR)),
        RetribValutabileTFR: isC6 ? '' : toItalian(sum(blockRows, m.retribValutabileTFR)),
        // Il Fondo Credito insiste sullo stesso imponibile della gestione
        // pensionistica: quando il file non lo riporta si rispecchia, come già
        // fanno le terne TC9 e come vuole il builder, che senza `ImpCredito`
        // non emette `GestCredito` e lascia gli enti versanti scoperti.
        ImpCredito: isC6 || isC1
          ? ''
          : toItalian(sumFirstOf(blockRows, [m.impCredito, m.impCreditoEnpdep]) ?? sum(blockRows, m.imponibile)),
        ContribCredito: isC6 || isC1 ? '' : toItalian(sum(blockRows, m.contribCredito)),
        CodiceCessazione: isC6 ? '' : codiceCessazioneOf(textOf(ref, cols.cessazione)),
        dmuDataAtto: '',
        dmuIdentAtto: '',
        dmuNumeroRegistro: '',
        // Una terna per ogni mese di pagamento, sempre: il quadro può essere
        // mensile o annuale, ma gli imponibili vanno comunque ricostruiti per
        // intero dalle terne.
        enteVersante: emetteEnteVersante
          ? enteVersantePerMesePagamento(blockRows, m, ente, regimeTFS)
          : [],
        _righeOrigine: blockRows.map(r => r.__id),
      };

      periodi.push(periodo);
    }

    // Il blocco cumulato viene creato per primo: si riordina cronologicamente.
    periodi.sort((a, b) => (a.GiornoInizio < b.GiornoInizio ? -1 : a.GiornoInizio > b.GiornoInizio ? 1 : 0));

    // Due quadri causale 5 sullo stesso periodo si annullano a vicenda: la C5
    // sostituisce il dichiarato, INPS li elabora in sequenza e l'ultimo vince.
    // Il file resta formalmente valido, quindi l'errore non si vede: il caso
    // tipico è una riga superata (E0 "Spento") rimasta nei filtri accanto al
    // V1 che l'aveva già corretta.
    if (causale === '5') {
      const perPeriodo = new Map<string, BuilderPeriodo[]>();
      for (const p of periodi) {
        const chiave = `${p.GiornoInizio}|${p.GiornoFine}`;
        const arr = perPeriodo.get(chiave);
        if (arr) arr.push(p); else perPeriodo.set(chiave, [p]);
      }
      for (const [chiave, gruppo] of Array.from(perPeriodo.entries())) {
        if (gruppo.length < 2) continue;
        const [inizio, fine] = chiave.split('|');
        const dettaglio = gruppo.map(p => `righe ${p._righeOrigine.join('+')}`).join(' e ');
        avvisi.push(`${cf} ${inizio} → ${fine}: ${gruppo.length} quadri causale 5 sullo stesso periodo (${dettaglio}). INPS li elabora in sequenza e l'ultimo sostituisce i precedenti: ne va tenuto uno solo.`);
      }
    }

    // Il tracciato PASSWEB non porta l'anagrafica: quella che c'è l'ha
    // digitata l'operatore. Cognome e nome sono obbligatori nell'XML.
    const ana = extra.anagrafica?.get(cf);
    if (!ana?.Cognome || !ana?.Nome) {
      avvisi.push(`${cf}: cognome e nome non compilati; il builder non può generare l'XML senza.`);
    }

    dipendenti.push({
      id: uid(),
      CFLavoratore: cf,
      Cognome: ana?.Cognome ?? '',
      Nome: ana?.Nome ?? '',
      CodiceComune: ana?.CodiceComune ?? '',
      CAP: ana?.CAP ?? '',
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
    ...(extra.mittente ? { _mittente: extra.mittente } : {}),
    ...(extra.azienda ? { _azienda: extra.azienda } : {}),
    dipendenti,
  };
}

/** Codici fiscali presenti nelle righe, nell'ordine di comparsa. */
export function codiciFiscaliDi(rows: readonly InpsRow[], sheet: SheetData): string[] {
  const cf = resolveColumn(sheet.columns, ['Codice fiscale']);
  const out: string[] = [];
  const visti = new Set<string>();
  for (const row of rows) {
    const v = textOf(row, cf);
    if (v && !visti.has(v)) { visti.add(v); out.push(v); }
  }
  return out;
}

/**
 * Dati dell'ente ricavabili dal file, per precompilare il frontespizio.
 * La colonna dichiarante ha la forma "COMUNE DI NOTO 00195880893 00000".
 */
export function aziendaDalFile(rows: readonly InpsRow[], sheet: SheetData): Partial<AziendaDenuncia> {
  const col = resolveColumn(sheet.columns, ['Ente Dichiarante in Anagrafica', 'Dichiarante in denuncia']);
  for (const row of rows) {
    const v = textOf(row, col);
    if (!v) continue;
    const { CFAzienda, PRGAZIENDA } = parseEnte(v);
    if (!CFAzienda) continue;
    const ragSoc = v.slice(0, v.indexOf(CFAzienda)).trim();
    return { CFAzienda, PRGAZIENDA, RagSocAzienda: ragSoc };
  }
  return {};
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
