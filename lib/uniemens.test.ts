import { describe, expect, it } from 'vitest';
import { type InpsRow, type QuadriColumns, type SheetData } from './inps';
import {
  AZIENDA_VUOTA,
  MITTENTE_VUOTO,
  aziendaDalFile,
  buildUniemensPayload,
  codeToken,
  codiceCessazioneOf,
  codiciFiscaliDi,
  parseEnte,
  percPartTimeOf,
  regimeDaCodice,
  statoSuperato,
  tipoPartTimeOf,
  toIsoDate,
  toItalian,
} from './uniemens';

const COLUMNS = [
  'Codice fiscale', 'Data Inizio Periodo', 'Data Fine Periodo', 'Tipologia',
  'Tipo impiego', 'Tipo Servizio', 'Contratto', 'Qualifica',
  'Tipo PART TIME', 'Percentuale part time', 'Regime fine servizio',
  'Imponibile', 'Totale Contributi', 'Codice Motivo Cessazione',
  'Imponibile TFS', 'Contributo TFS', 'Imponibile TFR', 'Contributo TFR',
  'Imponibile Credito/ENPDEP', 'Imponibile Credito', 'Contributo Credito',
  'Ente Dichiarante in Anagrafica', 'Causale Variazione', 'Denuncia',
  'Correnti, obsoleti, …',
  'Retribuzione teoriaca tabellare TFR', 'Retribuzione valutabile ai fini TFR',
];

const COLS: QuadriColumns = {
  data: 'Data Inizio Periodo',
  dataFine: 'Data Fine Periodo',
  tipologia: 'Tipologia',
  stato: 'Correnti, obsoleti, …',
  cessazione: 'Codice Motivo Cessazione',
};

function row(id: number, cells: Record<string, string | number | null>): InpsRow {
  return Object.freeze({ __id: id, __sheet: 'test', cells: Object.freeze(cells) });
}

function sheet(rows: InpsRow[]): SheetData {
  return { name: 'test', columns: COLUMNS, rows, headerExcelRow: 4, blankRowsSkipped: 0 };
}

const ENTE = 'COMUNE DI NOTO 00195880893 00000';

const MESI_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

/** Riga E0 mensile: la denuncia cade, come di norma, nel mese stesso. */
function mese(id: number, inizio: string, fine: string, extra: Record<string, string> = {}): InpsRow {
  const [, mm, aaaa] = inizio.split('/');
  return row(id, {
    'Codice fiscale': 'PRCSVT57S12F943R',
    'Data Inizio Periodo': inizio,
    'Data Fine Periodo': fine,
    'Denuncia': `${aaaa} - ${MESI_IT[Number(mm) - 1]}`,
    'Tipologia': 'E0',
    'Tipo impiego': '1  - Contratto a tempo indeterminato (tempo pieno)',
    'Tipo Servizio': '4 - Servizio ordinario',
    'Contratto': 'RALN - REGIONI AUTONOMIE LOCALI',
    'Qualifica': '056000',
    'Imponibile': '1000.00',
    'Totale Contributi': '326.50',
    'Ente Dichiarante in Anagrafica': ENTE,
    ...extra,
  });
}

describe('helper di conversione', () => {
  it('estrae il codice come primo token', () => {
    expect(codeToken('1  - Contratto a tempo indeterminato (tempo pieno)')).toBe('1');
    expect(codeToken('18 - Part-time (contratto a tempo determinato)')).toBe('18');
    expect(codeToken('RALN - REGIONI AUTONOMIE LOCALI')).toBe('RALN');
    expect(codeToken('0IRCC1 ISTRUTTORI - EX C1')).toBe('0IRCC1');
    expect(codeToken('')).toBe('');
  });

  it('mappa il codice regime sulla gestione previdenziale', () => {
    expect(regimeDaCodice('1')).toBe('TFR');
    expect(regimeDaCodice('2')).toBe('TFR');
    expect(regimeDaCodice('3 - TFS ex INADEL')).toBe('TFS');
    expect(regimeDaCodice('')).toBeNull();
    expect(regimeDaCodice('9')).toBeNull();
  });

  it('riconosce le righe superate dallo stato', () => {
    expect(statoSuperato('Spento')).toBe(true);
    expect(statoSuperato('obsoleto')).toBe(true);
    expect(statoSuperato('Annullato')).toBe(true);
    expect(statoSuperato('Corrente')).toBe(false);
    expect(statoSuperato('')).toBe(false);
  });

  it('separa codice fiscale e progressivo dell\'ente', () => {
    expect(parseEnte(ENTE)).toEqual({ CFAzienda: '00195880893', PRGAZIENDA: '00000' });
    expect(parseEnte('ENTE SENZA PROGRESSIVO 00195880893')).toEqual({ CFAzienda: '00195880893', PRGAZIENDA: '00000' });
    expect(parseEnte('nessun codice')).toEqual({ CFAzienda: '', PRGAZIENDA: '00000' });
  });

  it('converte date e importi nei formati del builder', () => {
    expect(toIsoDate('01/05/2025')).toBe('2025-05-01');
    expect(toIsoDate('')).toBe('');
    expect(toItalian(1334.32)).toBe('1334,32');
    expect(toItalian(671)).toBe('671,00');
    expect(toItalian(null)).toBe('');
  });
});

describe('regimi di aggregazione', () => {
  it('dal 10/2012 produce un quadro per mese', () => {
    const rows = [mese(1, '01/10/2012', '31/10/2012'), mese(2, '01/11/2012', '30/11/2012')];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const periodi = p.dipendenti[0].periodi;
    expect(periodi).toHaveLength(2);
    expect(periodi[0].GiornoInizio).toBe('2012-10-01');
  });

  it('emette la terna anche quando il pagamento cade nel mese di competenza', () => {
    // mese() mette la denuncia nel mese stesso del periodo. La terna serve
    // comunque: la somma degli EV deve ricostruire l'imponibile dichiarato.
    const rows = [mese(1, '01/10/2012', '31/10/2012')];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    const tc1 = q.enteVersante.filter(e => e.TipoContributo === '1');
    expect(tc1).toHaveLength(1);
    expect(tc1[0].AnnoMeseErogazione).toBe('2012-10');
    expect(tc1[0].Imponibile).toBe(q.ImpCPDEL);
  });

  it('la somma delle terne quadra con gli imponibili del quadro', () => {
    const rows = [
      mese(1, '01/11/2024', '30/11/2024'),                              // pagata nel mese
      mese(2, '01/11/2024', '30/11/2024', { 'Denuncia': '2026 - Marzo' }),
      mese(3, '01/11/2024', '30/11/2024', { 'Denuncia': '2026 - Aprile' }),
    ];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    const somma = (tc: string) => q.enteVersante
      .filter(e => e.TipoContributo === tc)
      .reduce((s, e) => s + Number(e.Imponibile.replace(',', '.')), 0);
    expect(somma('1').toFixed(2)).toBe('3000.00');
    expect(q.ImpCPDEL).toBe('3000,00');
    expect(somma('9').toFixed(2)).toBe('3000.00');
  });

  it('ente versante col mese della denuncia quando il pagamento è differito', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Denuncia': '2022 - Dicembre' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.enteVersante.length).toBeGreaterThan(0);
    for (const ev of q.enteVersante) expect(ev.AnnoMeseErogazione).toBe('2022-12');
  });

  it('una terna per ogni mese di pagamento distinto', () => {
    const rows = [
      mese(1, '01/11/2024', '30/11/2024', { 'Denuncia': '2026 - Marzo' }),
      mese(2, '01/11/2024', '30/11/2024', { 'Denuncia': '2026 - Aprile' }),
      mese(3, '01/11/2024', '30/11/2024', { 'Denuncia': '2024 - Dicembre' }),
    ];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    const mesi = Array.from(new Set(q.enteVersante.map(e => e.AnnoMeseErogazione))).sort();
    expect(mesi).toEqual(['2024-12', '2026-03', '2026-04']);
  });

  it('fino al 09/2012 aggrega l\'anno, con le terne per mese di pagamento', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011'),
      mese(2, '01/02/2011', '28/02/2011'),
      mese(3, '01/03/2011', '31/03/2011'),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const periodi = p.dipendenti[0].periodi;
    expect(periodi).toHaveLength(1);
    expect(periodi[0].GiornoInizio).toBe('2011-01-01');
    expect(periodi[0].GiornoFine).toBe('2011-03-31');
    expect(periodi[0].ImpCPDEL).toBe('3000,00');
    // L'aggregazione riguarda il quadro, non gli enti versanti: il quadro è
    // annuale ma il dettaglio per mese di erogazione resta.
    const mesi = Array.from(new Set(periodi[0].enteVersante.map(e => e.AnnoMeseErogazione))).sort();
    expect(mesi).toEqual(['2011-01', '2011-02', '2011-03']);
  });
});

describe('terna di fine servizio', () => {
  it('usa TC7 in regime TFS', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Imponibile TFS': '780.00', 'Contributo TFS': '47.58' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.regimeTFS).toBe('TFS');
    const fs = q.enteVersante.filter(e => e.TipoContributo === '7');
    expect(fs).toHaveLength(1);
    expect(fs[0].Imponibile).toBe('780,00');
  });

  it('usa TC8 in regime TFR, non TC7', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Imponibile TFR': '780.00', 'Contributo TFR': '47.58' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.regimeTFS).toBe('TFR');
    expect(q.enteVersante.some(e => e.TipoContributo === '7')).toBe(false);
    const fs = q.enteVersante.filter(e => e.TipoContributo === '8');
    expect(fs).toHaveLength(1);
    expect(fs[0].Imponibile).toBe('780,00');
    expect(fs[0].Imponibile).toBe(q.ImpTFS);
  });
});

describe('regime di fine servizio: lo dichiara il file, non gli importi', () => {
  it('il codice 3 tiene il quadro in TFS anche se ci sono importi TFR', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', {
      'Regime fine servizio': '3',
      'Imponibile TFS': '780.00', 'Contributo TFS': '47.58',
      'Imponibile TFR': '51.74', 'Contributo TFR': '3.16',
    })];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const q = p.dipendenti[0].periodi[0];
    expect(q.RegimeFineServizio).toBe('3');
    expect(q.regimeTFS).toBe('TFS');
    expect(q.ImpTFS).toBe('780,00');
    expect(q.enteVersante.filter(e => e.TipoContributo === '7')).toHaveLength(1);
    expect(q.enteVersante.some(e => e.TipoContributo === '8')).toBe(false);
  });

  it('i codici 1 e 2 tengono il quadro in TFR anche senza importi TFR', () => {
    for (const codice of ['1', '2']) {
      const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Regime fine servizio': codice })];
      const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
      expect(q.regimeTFS).toBe('TFR');
    }
  });

  it('avvisa quando l\'imponibile dell\'altro regime resta fuori', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', {
      'Regime fine servizio': '3',
      'Imponibile TFS': '780.00', 'Contributo TFS': '47.58',
      'Imponibile TFR': '51.74', 'Contributo TFR': '3.16',
    })];
    const avvisi = buildUniemensPayload(rows, sheet(rows), COLS, '5')._avvisi.join(' ');
    expect(avvisi).toContain('51,74 di imponibile TFR');
    expect(avvisi).toContain('resta fuori');
  });

  it('senza codice ripiega sugli importi, come prima', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Imponibile TFR': '780.00', 'Contributo TFR': '47.58' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.RegimeFineServizio).toBe('');
    expect(q.regimeTFS).toBe('TFR');
  });

  it('spezza il periodo aggregato al passaggio TFS → TFR', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Regime fine servizio': '3', 'Imponibile TFS': '100.00' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Regime fine servizio': '3', 'Imponibile TFS': '100.00' }),
      mese(3, '01/03/2011', '31/03/2011', { 'Regime fine servizio': '1', 'Imponibile TFR': '100.00' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const periodi = p.dipendenti[0].periodi;
    expect(periodi).toHaveLength(2);
    expect(periodi[0].regimeTFS).toBe('TFS');
    expect(periodi[1].regimeTFS).toBe('TFR');
    expect(p._avvisi.join(' ')).toContain('Regime fine servizio');
  });
});

describe('spezzatura al cambio di inquadramento', () => {
  const pt = '18 - Part-time (contratto a tempo determinato)';

  it('spezza l\'anno quando si passa da part-time a tempo pieno', () => {
    const rows = [
      mese(1, '01/01/2005', '31/01/2005', { 'Tipo impiego': pt }),
      mese(2, '01/02/2005', '28/02/2005', { 'Tipo impiego': pt }),
      mese(3, '01/03/2005', '31/03/2005'),
      mese(4, '01/04/2005', '30/04/2005'),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const periodi = p.dipendenti[0].periodi;
    expect(periodi).toHaveLength(2);
    expect(periodi[0].TipoImpiego).toBe('18');
    expect(periodi[0].GiornoFine).toBe('2005-02-28');
    expect(periodi[1].TipoImpiego).toBe('1');
    expect(periodi[1].GiornoInizio).toBe('2005-03-01');
    expect(p._avvisi.join(' ')).toContain('Tipo impiego');
  });

  it('spezza al cambio di tipo servizio (determinato ↔ indeterminato)', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Tipo Servizio': '5 - Servizio a tempo determinato' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Tipo Servizio': '4 - Servizio ordinario' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(2);
    expect(p._avvisi.join(' ')).toContain('Tipo Servizio');
  });

  it('spezza al cambio di qualifica (progressione fra le aree)', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Qualifica': '056000 ISTRUTTORE' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Qualifica': '099000 FUNZIONARIO' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(2);
    expect(p._avvisi.join(' ')).toContain('Qualifica');
  });

  it('non spezza per sola differenza di descrizione dello stesso codice', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Qualifica': '056000' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Qualifica': '056000 POSIZIONE ECONOMICA DI ACCESSO C1' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(1);
    expect(p._avvisi.join(' ')).not.toContain('periodo spezzato');
  });

  it('non spezza per il contratto, che vale sempre RALN', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Contratto': 'RALN - REGIONI AUTONOMIE LOCALI' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Contratto': 'ALTRO - QUALCOSA' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(1);
  });

  it('ignora la percentuale part time prima del 2020, ma la conserva nel quadro', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Tipo impiego': pt, 'Percentuale part time': '50' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Tipo impiego': pt, 'Percentuale part time': '75' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const periodi = p.dipendenti[0].periodi;
    expect(periodi).toHaveLength(1);
    // ignorata ai fini della spezzatura, non cancellata dal quadro
    expect(periodi[0].PercPartTime).toBe('50000');
  });

  it('considera la percentuale part time dal 2020', () => {
    const rows = [
      mese(1, '01/01/2021', '31/01/2021', { 'Tipo impiego': pt, 'Percentuale part time': '50' }),
      mese(2, '01/01/2021', '31/01/2021', { 'Tipo impiego': pt, 'Percentuale part time': '75' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(2);
  });
});

describe('anni ante 10/2012 con V1C1', () => {
  const annoConC1 = () => [
    mese(1, '01/01/2005', '31/01/2005'),
    mese(2, '01/02/2005', '28/02/2005'),
    row(3, {
      'Codice fiscale': 'PRCSVT57S12F943R',
      'Data Inizio Periodo': '01/01/2005', 'Data Fine Periodo': '31/12/2005',
      'Tipologia': 'V1', 'Causale Variazione': '1',
      'Tipo impiego': '1  - Contratto a tempo indeterminato (tempo pieno)',
      'Tipo Servizio': '4 - Servizio ordinario', 'Contratto': 'RALN - REGIONI',
      'Qualifica': '056000', 'Denuncia': '2006 - Luglio',
      'Imponibile': '480.81', 'Totale Contributi': '156.98',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
  ];

  it('riproduce l\'anno intero in un solo quadro', () => {
    const rows = annoConC1();
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const periodi = p.dipendenti[0].periodi;
    expect(periodi).toHaveLength(1);
    expect(periodi[0].GiornoInizio).toBe('2005-01-01');
    expect(periodi[0].GiornoFine).toBe('2005-12-31');
    expect(periodi[0]._righeOrigine).toHaveLength(3);
  });

  it('genera un ente versante per ogni mese di pagamento, con il mese valorizzato', () => {
    const rows = annoConC1();
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    const mesi = Array.from(new Set(q.enteVersante.map(e => e.AnnoMeseErogazione)));
    expect(mesi).toContain('2006-07');
    expect(q.enteVersante.length).toBeGreaterThanOrEqual(4);
    for (const ev of q.enteVersante) expect(ev.AnnoMeseErogazione).not.toBe('');
  });

  it('non spezza l\'anno anche se l\'inquadramento cambia', () => {
    const rows = annoConC1();
    rows[0] = mese(1, '01/01/2005', '31/01/2005', { 'Tipo impiego': '18 - Part-time (contratto a tempo determinato)' });
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(1);
  });

  it('senza V1C1 cumula il quadro ma emette comunque gli enti versanti', () => {
    const rows = [mese(1, '01/01/2005', '31/01/2005'), mese(2, '01/02/2005', '28/02/2005')];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.ImpCPDEL).toBe('2000,00');
    const mesi = Array.from(new Set(q.enteVersante.map(e => e.AnnoMeseErogazione))).sort();
    expect(mesi).toEqual(['2005-01', '2005-02']);
  });
});

describe('cumulo manuale sui pagamenti post cessazione', () => {
  /* Ultimo mese lavorato 08/2020 con cessazione, tre arretrati sullo stesso
     periodo pagati dopo, più un E0 di 10/2024 che è un errore del comune. */
  const caso = () => [
    row(5, {
      'Codice fiscale': 'LNEGPP53M09F943M', 'Data Inizio Periodo': '01/10/2024', 'Data Fine Periodo': '31/10/2024',
      'Denuncia': '2024 - Ottobre', 'Tipologia': 'E0',
      'Tipo impiego': '1  - Contratto a tempo indeterminato (tempo pieno)', 'Tipo Servizio': '4 - Servizio ordinario',
      'Contratto': 'RALN - REGIONI', 'Qualifica': '037492',
      'Imponibile': '1276.17', 'Totale Contributi': '416.67',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
    row(6, {
      'Codice fiscale': 'LNEGPP53M09F943M', 'Data Inizio Periodo': '01/08/2020', 'Data Fine Periodo': '31/08/2020',
      'Denuncia': '2020 - Agosto', 'Tipologia': 'E0', 'Codice Motivo Cessazione': '3 Limiti di eta',
      'Tipo impiego': '1  - Contratto a tempo indeterminato (tempo pieno)', 'Tipo Servizio': '4 - Servizio ordinario',
      'Contratto': 'RALN - REGIONI', 'Qualifica': '037492', 'Regime fine servizio': '3',
      'Imponibile': '2888.90', 'Totale Contributi': '943.23',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
    row(7, {
      'Codice fiscale': 'LNEGPP53M09F943M', 'Data Inizio Periodo': '01/08/2020', 'Data Fine Periodo': '31/08/2020',
      'Denuncia': '2020 - Settembre', 'Tipologia': 'V1', 'Causale Variazione': '1',
      'Tipo impiego': '1  - Contratto a tempo indeterminato (tempo pieno)', 'Tipo Servizio': '4 - Servizio ordinario',
      'Contratto': 'RALN - REGIONI', 'Qualifica': '037492',
      'Imponibile': '721.48', 'Totale Contributi': '235.56',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
    row(8, {
      'Codice fiscale': 'LNEGPP53M09F943M', 'Data Inizio Periodo': '01/08/2020', 'Data Fine Periodo': '31/08/2020',
      'Denuncia': '2022 - Dicembre', 'Tipologia': 'V1', 'Causale Variazione': '1',
      'Tipo impiego': '1  - Contratto a tempo indeterminato (tempo pieno)', 'Tipo Servizio': '4 - Servizio ordinario',
      'Contratto': 'RALN - REGIONI', 'Qualifica': '037492',
      'Imponibile': '131.18', 'Totale Contributi': '42.83',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
  ];
  const tutte = new Set([5, 6, 7, 8]);

  it('produce un solo quadro sul periodo della riga con la cessazione', () => {
    const rows = caso();
    const periodi = buildUniemensPayload(rows, sheet(rows), COLS, '5', tutte).dipendenti[0].periodi;
    expect(periodi).toHaveLength(1);
    expect(periodi[0].GiornoInizio).toBe('2020-08-01');
    expect(periodi[0].GiornoFine).toBe('2020-08-31');
    expect(periodi[0].CodiceCessazione).toBe('3');
  });

  it('somma tutti gli importi, compreso l\'E0 fuori posto', () => {
    const rows = caso();
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5', tutte).dipendenti[0].periodi[0];
    expect(q.ImpCPDEL).toBe('5017,73');   // 2888,90 + 721,48 + 131,18 + 1276,17
    expect(q._righeOrigine.slice().sort((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  });

  it('un ente versante per ogni mese di pagamento, riferimento compreso', () => {
    const rows = caso();
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5', tutte).dipendenti[0].periodi[0];
    const mesi = Array.from(new Set(q.enteVersante.map(e => e.AnnoMeseErogazione))).sort();
    expect(mesi).toEqual(['2020-08', '2020-09', '2022-12', '2024-10']);
    // Il cumulo somma quattro righe: le terne devono restituire lo stesso totale.
    const sommaTC1 = q.enteVersante
      .filter(e => e.TipoContributo === '1')
      .reduce((s, e) => s + Number(e.Imponibile.replace(',', '.')), 0);
    expect(sommaTC1.toFixed(2)).toBe('5017.73');
  });

  it('senza selezione restano quadri separati', () => {
    const rows = caso();
    const periodi = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi;
    expect(periodi.length).toBeGreaterThan(1);
  });

  it('il cumulo vale solo per la causale 5', () => {
    const rows = caso();
    const periodi = buildUniemensPayload(rows, sheet(rows), COLS, '1', tutte).dipendenti[0].periodi;
    expect(periodi.length).toBeGreaterThan(1);
  });

  it('registra il cumulo negli avvisi', () => {
    const rows = caso();
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5', tutte);
    expect(p._avvisi.join(' ')).toContain('cumulate a mano');
  });

  it('senza riga di cessazione usa il periodo più antico', () => {
    const rows = caso().filter(r => r.__id !== 6);
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5', new Set([5, 7, 8])).dipendenti[0].periodi[0];
    expect(q.GiornoInizio).toBe('2020-08-01');
  });

  it('riporta contratto e regime fine servizio, non più assenti', () => {
    const rows = caso();
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5', tutte).dipendenti[0].periodi[0];
    expect(q.Contratto).toBe('RALN');
    expect(q.RegimeFineServizio).toBe('3');
    expect(Object.keys(q)).toContain('TipoPartTime');
  });
});

describe('cumulo che mescola una riga superata e la sua sostituta', () => {
  /* Caso reale (Noto, GIUNTA): l'E0 del mese di cessazione è Spento in regime
     TFS, il V1 che l'ha rifatto è Corrente in regime TFR. Stessa data, stesso
     codice cessazione: solo lo stato distingue il dichiarato dal superato. */
  const caso = () => [
    row(10, {
      'Codice fiscale': 'GNTFNC77B03I754J', 'Data Inizio Periodo': '01/03/2020', 'Data Fine Periodo': '15/03/2020',
      'Denuncia': '2020 - Marzo', 'Tipologia': 'E0', 'Correnti, obsoleti, …': 'Spento',
      'Codice Motivo Cessazione': '13', 'Regime fine servizio': '3',
      'Tipo impiego': '1', 'Tipo Servizio': '4', 'Contratto': 'RALN', 'Qualifica': '042000',
      'Imponibile': '1229.75', 'Totale Contributi': '401.51',
      'Imponibile TFS': '966.89', 'Contributo TFS': '58.98',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
    row(11, {
      'Codice fiscale': 'GNTFNC77B03I754J', 'Data Inizio Periodo': '01/03/2020', 'Data Fine Periodo': '15/03/2020',
      'Denuncia': '2022 - Dicembre', 'Tipologia': 'V1', 'Causale Variazione': '1', 'Correnti, obsoleti, …': 'Corrente',
      'Codice Motivo Cessazione': '13', 'Regime fine servizio': '1',
      'Tipo impiego': '1', 'Tipo Servizio': '4', 'Contratto': 'RALN', 'Qualifica': '042000',
      'Imponibile': '64.67', 'Totale Contributi': '21.11',
      'Imponibile TFR': '51.74', 'Contributo TFR': '3.16',
      'Retribuzione teoriaca tabellare TFR': '64.68', 'Retribuzione valutabile ai fini TFR': '64.68',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
  ];
  const tutte = new Set([10, 11]);
  const build = () => {
    const rows = caso();
    return buildUniemensPayload(rows, sheet(rows), COLS, '5', tutte);
  };

  it('prende il riferimento dalla riga Corrente, non da quella Spenta', () => {
    const q = build().dipendenti[0].periodi[0];
    expect(q.RegimeFineServizio).toBe('1');
    expect(q.regimeTFS).toBe('TFR');
  });

  it('la gestione previdenziale non contraddice il regime dichiarato', () => {
    const q = build().dipendenti[0].periodi[0];
    // È l'incongruenza che il builder importava senza accorgersene: regime
    // TFS nell'inquadramento e gestione TFR negli importi.
    expect(regimeDaCodice(q.RegimeFineServizio)).toBe(q.regimeTFS);
    expect(q.enteVersante.some(e => e.TipoContributo === '7')).toBe(false);
    expect(q.enteVersante.filter(e => e.TipoContributo === '8')).toHaveLength(1);
  });

  it('avvisa dei due regimi e dell\'imponibile TFS che resta fuori', () => {
    const avvisi = build()._avvisi.join(' ');
    expect(avvisi).toContain('regimi di fine servizio diversi (3 | 1)');
    expect(avvisi).toContain('966,89 di imponibile TFS');
  });

  it('la retribuzione teorica arriva anche se non è sulla riga di riferimento', () => {
    const q = build().dipendenti[0].periodi[0];
    expect(q.RetribTeoricaTabellareTFR).toBe('64,68');
    expect(q.RetribValutabileTFR).toBe('64,68');
  });

  it('se ogni riga scelta è superata, lo dice', () => {
    const rows = caso().map(r => r.__id === 11
      ? row(11, { ...r.cells, 'Correnti, obsoleti, …': 'Obsoleto' })
      : r);
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5', tutte);
    expect(p._avvisi.join(' ')).toContain('è "Spento"');
  });
});

describe('causali', () => {
  const rows = [mese(1, '01/10/2020', '31/10/2020')];

  it('C5 porta gli importi cumulati', () => {
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.CausaleVariazione).toBe('5');
    expect(q.ImpCPDEL).toBe('1000,00');
  });

  it('C1 porta l\'inquadramento ma non gli importi', () => {
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '1').dipendenti[0].periodi[0];
    expect(q.TipoImpiego).toBe('1');
    expect(q.ImpCPDEL).toBe('');
    expect(q.enteVersante).toHaveLength(0);
  });

  it('C6 porta solo le date', () => {
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '6').dipendenti[0].periodi[0];
    expect(q.GiornoInizio).toBe('2020-10-01');
    expect(q.TipoImpiego).toBe('');
    expect(q.ImpCPDEL).toBe('');
  });

  it('AnnoMeseErogazione viene dalla colonna Denuncia', () => {
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.enteVersante.length).toBeGreaterThan(0);
    for (const ev of q.enteVersante) expect(ev.AnnoMeseErogazione).toBe('2020-10');
  });

  it('traccia le righe di origine di ogni quadro', () => {
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q._righeOrigine).toEqual([1]);
  });
});

describe('imponibile del Fondo Credito', () => {
  it('lo legge da "Imponibile Credito" quando è quella la colonna valorizzata', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Imponibile Credito': '900.00', 'Contributo Credito': '3.15' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.ImpCredito).toBe('900,00');
  });

  it('ripiega su "Imponibile Credito/ENPDEP", usata dalle righe più vecchie', () => {
    const rows = [mese(1, '01/03/2010', '31/03/2010', { 'Imponibile Credito/ENPDEP': '1872.72' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.ImpCredito).toBe('1872,72');
  });

  it('preferisce la colonna nuova quando entrambe sono valorizzate sulla stessa riga', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Imponibile Credito': '900.00', 'Imponibile Credito/ENPDEP': '111.11' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.ImpCredito).toBe('900,00');
  });

  it('in mancanza di entrambe rispecchia l\'imponibile pensionistico', () => {
    // Senza ImpCredito il builder non emette GestCredito, e le terne TC9
    // resterebbero senza gestione a cui riferirsi.
    const rows = [mese(1, '01/10/2020', '31/10/2020')];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.ImpCredito).toBe(q.ImpCPDEL);
    const tc9 = q.enteVersante.filter(e => e.TipoContributo === '9');
    expect(tc9[0].Imponibile).toBe(q.ImpCredito);
  });
});

describe('normalizzazioni verso lo XSD', () => {
  it('"0" nel motivo cessazione vale come assenza di cessazione', () => {
    expect(codiceCessazioneOf('0')).toBe('');
    expect(codiceCessazioneOf('18 Fine incarico')).toBe('18');
    expect(codiceCessazioneOf('')).toBe('');
  });

  it('non dichiara il codice cessazione quando il file porta "0"', () => {
    const rows = [mese(1, '01/10/2020', '31/10/2020', { 'Codice Motivo Cessazione': '0' })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.CodiceCessazione).toBe('');
  });

  it('la percentuale part time esce nel formato intero del DMA2', () => {
    // 66,67% nel flusso reale accettato da INPS si dichiara "66670".
    expect(percPartTimeOf('66.67')).toBe('66670');
    expect(percPartTimeOf('94.44')).toBe('94440');
    expect(percPartTimeOf('50.00')).toBe('50000');
    expect(percPartTimeOf('83,33')).toBe('83330');
    expect(percPartTimeOf('')).toBe('');
    // già in forma DMA2: non si riscala una seconda volta
    expect(percPartTimeOf('66670')).toBe('66670');
  });

  it('riscala la percentuale part time letta dal file', () => {
    const rows = [mese(1, '01/10/2021', '31/10/2021', {
      'Tipo impiego': '18 - Part-time (contratto a tempo determinato)',
      'Percentuale part time': '94.44',
    })];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.PercPartTime).toBe('94440');
    expect(q.hasPartTime).toBe(true);
  });

  it('il tipo part time orizzontale esce come P, mai come O', () => {
    expect(tipoPartTimeOf('P ORIZZONTALE')).toBe('P');
    expect(tipoPartTimeOf('O')).toBe('P');
    expect(tipoPartTimeOf('V VERTICALE')).toBe('V');
    expect(tipoPartTimeOf('')).toBe('');
  });
});

describe('quadri causale 5 in conflitto sullo stesso periodo', () => {
  /* Caso reale: un E0 superato ("Spento") rimasto nei filtri accanto al V1 che
     lo aveva già corretto. Due C5 sullo stesso periodo: il secondo sostituisce
     il primo e il lavoro di cumulo va perso, senza che nulla lo segnali. */
  const caso = () => [
    row(6, {
      'Codice fiscale': 'MNNSFN76C16F943U',
      'Data Inizio Periodo': '01/10/2021', 'Data Fine Periodo': '14/10/2021',
      'Denuncia': '2021 - Ottobre', 'Tipologia': 'E0',
      'Tipo impiego': '18 - Part-time', 'Tipo Servizio': '4 - Ordinario',
      'Qualifica': '058000', 'Imponibile': '5522.03', 'Totale Contributi': '1802.94',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
    row(7, {
      'Codice fiscale': 'MNNSFN76C16F943U',
      'Data Inizio Periodo': '01/10/2021', 'Data Fine Periodo': '14/10/2021',
      'Denuncia': '2021 - Dicembre', 'Tipologia': 'V1', 'Causale Variazione': '5',
      'Tipo impiego': '18 - Part-time', 'Tipo Servizio': '4 - Ordinario',
      'Qualifica': '058000', 'Imponibile': '5522.03', 'Totale Contributi': '1802.94',
      'Codice Motivo Cessazione': '18 Fine incarico',
      'Ente Dichiarante in Anagrafica': ENTE,
    }),
  ];

  it('segnala i due quadri che si sovrappongono', () => {
    const rows = caso();
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5', new Set([7]));
    expect(p.dipendenti[0].periodi).toHaveLength(2);
    const avviso = p._avvisi.find(a => a.includes('stesso periodo'));
    expect(avviso).toBeTruthy();
    expect(avviso).toContain('2021-10-01 → 2021-10-14');
    expect(avviso).toContain('sostituisce');
  });

  it('non segnala nulla quando i periodi sono distinti', () => {
    const rows = [mese(1, '01/10/2021', '31/10/2021'), mese(2, '01/11/2021', '30/11/2021')];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p._avvisi.join(' ')).not.toContain('stesso periodo');
  });

  it('non riguarda le altre causali, che non sostituiscono', () => {
    const rows = caso();
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '1');
    expect(p._avvisi.join(' ')).not.toContain('stesso periodo');
  });
});

describe('dati aggiuntivi digitati dall\'operatore', () => {
  const rows = [mese(1, '01/10/2020', '31/10/2020')];
  const CF = 'PRCSVT57S12F943R';

  it('senza anagrafica avvisa che manca cognome e nome', () => {
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].Cognome).toBe('');
    expect(p._avvisi.join(' ')).toContain('cognome e nome non compilati');
  });

  it('riporta l\'anagrafica del dipendente nel payload', () => {
    const anagrafica = new Map([[CF, { Cognome: 'VITA', Nome: 'MARIA CLARA', CodiceComune: 'L651', CAP: '98040' }]]);
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5', new Set(), { anagrafica });
    const d = p.dipendenti[0];
    expect(d.Cognome).toBe('VITA');
    expect(d.Nome).toBe('MARIA CLARA');
    expect(d.CodiceComune).toBe('L651');
    expect(d.CAP).toBe('98040');
    expect(p._avvisi.join(' ')).not.toContain('cognome e nome');
  });

  it('porta il frontespizio solo se compilato', () => {
    const senza = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(senza._mittente).toBeUndefined();
    expect(senza._azienda).toBeUndefined();

    const mittente = { ...MITTENTE_VUOTO, CFMittente: '82001480837', SedeINPS: '4800' };
    const azienda = { ...AZIENDA_VUOTA, CFAzienda: '82001480837', AnnoMeseDenuncia: '2026-01' };
    const con = buildUniemensPayload(rows, sheet(rows), COLS, '5', new Set(), { mittente, azienda });
    expect(con._mittente?.SedeINPS).toBe('4800');
    expect(con._azienda?.AnnoMeseDenuncia).toBe('2026-01');
  });

  it('elenca i codici fiscali e precompila l\'ente dal file', () => {
    expect(codiciFiscaliDi(rows, sheet(rows))).toEqual([CF]);
    expect(aziendaDalFile(rows, sheet(rows))).toEqual({
      CFAzienda: '00195880893', PRGAZIENDA: '00000', RagSocAzienda: 'COMUNE DI NOTO',
    });
  });
});
