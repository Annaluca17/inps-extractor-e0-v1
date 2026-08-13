import { describe, expect, it } from 'vitest';
import { type InpsRow, type QuadriColumns, type SheetData } from './inps';
import { buildUniemensPayload, codeToken, parseEnte, toIsoDate, toItalian } from './uniemens';

const COLUMNS = [
  'Codice fiscale', 'Data Inizio Periodo', 'Data Fine Periodo', 'Tipologia',
  'Tipo impiego', 'Tipo Servizio', 'Contratto', 'Qualifica',
  'Percentuale part time', 'Imponibile', 'Totale Contributi',
  'Ente Dichiarante in Anagrafica', 'Causale Variazione', 'Denuncia',
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
  it('dal 10/2012 produce un quadro per mese, con enti versanti', () => {
    const rows = [mese(1, '01/10/2012', '31/10/2012'), mese(2, '01/11/2012', '30/11/2012')];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    const periodi = p.dipendenti[0].periodi;
    expect(periodi).toHaveLength(2);
    expect(periodi[0].GiornoInizio).toBe('2012-10-01');
    expect(periodi[0].enteVersante.length).toBeGreaterThan(0);
  });

  it('fino al 09/2012 aggrega l\'anno, senza enti versanti', () => {
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
    expect(periodi[0].enteVersante).toHaveLength(0);
    expect(periodi[0].ImpCPDEL).toBe('3000,00');
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
    expect(p._avvisi).toHaveLength(0);
  });

  it('non spezza per il contratto, che vale sempre RALN', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Contratto': 'RALN - REGIONI AUTONOMIE LOCALI' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Contratto': 'ALTRO - QUALCOSA' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(1);
  });

  it('ignora la percentuale part time prima del 2020', () => {
    const rows = [
      mese(1, '01/01/2011', '31/01/2011', { 'Tipo impiego': pt, 'Percentuale part time': '50' }),
      mese(2, '01/02/2011', '28/02/2011', { 'Tipo impiego': pt, 'Percentuale part time': '75' }),
    ];
    const p = buildUniemensPayload(rows, sheet(rows), COLS, '5');
    expect(p.dipendenti[0].periodi).toHaveLength(1);
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

  it('senza V1C1 cumula e non emette enti versanti', () => {
    const rows = [mese(1, '01/01/2005', '31/01/2005'), mese(2, '01/02/2005', '28/02/2005')];
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q.enteVersante).toHaveLength(0);
    expect(q.ImpCPDEL).toBe('2000,00');
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

  it('AnnoMeseErogazione è sempre vuoto: lo compila l\'operatore', () => {
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    for (const ev of q.enteVersante) expect(ev.AnnoMeseErogazione).toBe('');
  });

  it('traccia le righe di origine di ogni quadro', () => {
    const q = buildUniemensPayload(rows, sheet(rows), COLS, '5').dipendenti[0].periodi[0];
    expect(q._righeOrigine).toEqual([1]);
  });
});
