# INPS Extractor — Quadri E0/V1

Estrazione selettiva di righe e colonne dai file PASSWEB "Elenco Quadri E0 e V1"
e riepilogo degli sgravi contributivi. Tutto avviene nel browser: il file non
viene mai caricato su un server.

## Avvio

```bash
npm install
npm run dev
```

Altri comandi: `npm run test` (test di regressione), `npm run typecheck`,
`npm run lint`, `npm run build`.

Richiede Node 20+. In Windows PowerShell 5.1 il concatenatore `&&` non esiste:
usa `;` oppure `; if ($?) { ... }`.

## Dipendenze

Next 16 / React 19 / ESLint 9 (flat config in `eslint.config.mjs`; `next lint`
è stato rimosso da Next 16, si usa `eslint .`).

`xlsx` **non** viene da npm ma dal CDN ufficiale SheetJS:

```
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

La copia su npm è ferma alla 0.18.5 del 2022 e ha due vulnerabilità note
(prototype pollution e ReDoS nel parser) senza fix pubblicato lì. Il build deve
poter raggiungere `cdn.sheetjs.com`: se la pipeline di deploy è in rete chiusa,
va messo in whitelist o va reso disponibile un mirror interno del tarball.

## Sezioni

- **Quadri E0/V1** — filtri per periodo, tipologia e stato; selezione colonne;
  subtotali per anno; export XLSX.
- **Sgravi contributivi** — riepilogo del foglio "Elenco Sgravi" per codice e per
  anno di competenza, con dettaglio mensile ed export su tre fogli
  (per codice, per anno, dettaglio righe).

## Integrità dei dati

Ad agosto 2026 un off-by-one nel percorso filtro → export produceva estrazioni
sbagliate in modo silenzioso: il predicato veniva valutato sulla riga *i* ma
veniva scritta la riga *i+1*. Effetti su un file reale da 265 righe:

- la prima riga dati veniva sempre persa;
- 10 righe "Corrente" scomparivano;
- 9 righe "Obsoleto"/"Annullato" prendevano il loro posto;
- l'ultima riga veniva duplicata.

Il conteggio finale tornava (250 righe attese, 250 prodotte), quindi il difetto
era invisibile a un controllo superficiale. Il core è stato riscritto attorno a
tre invarianti che rendono la stessa classe di errore impossibile da nascondere.

**1. Identità, non posizione.** Ogni riga è un oggetto immutabile con `__id`
pari al numero di riga nel foglio Excel di origine. Nessun modulo seleziona
righe per indice di array; l'`__id` è visibile in tabella e nell'export, così
un confronto con il file INPS è sempre possibile a occhio.

**2. Ogni filtro è una partizione.** `partitionRows` restituisce righe tenute
**ed** escluse-con-motivo; `assertPartition` verifica che la somma copra
l'input, che nessuna riga sia duplicata, estranea o fuori ordine. L'interfaccia
mostra sempre `tenute + escluse = righe nel foglio` e un registro consultabile
delle esclusioni.

**3. L'export viene riletto.** `assertRoundTrip` rilegge il foglio appena
costruito e lo confronta cella per cella con la matrice sorgente, prima di
scrivere il file.

Se un'invariante salta viene lanciato `IntegrityError`: l'app mostra l'errore e
blocca l'export, invece di produrre un file plausibile ma sbagliato.

I test in `lib/inps.test.ts` riproducono la sequenza reale che generò il bug
(prima riga Corrente, righe Obsolete subito prima di righe Correnti) e
verificano che una selezione sfasata venga rifiutata.

## Struttura

```
lib/inps.ts        parsing, filtri, invarianti, export XLSX
lib/sgravi.ts      dominio sgravi: codici, competenza, aggregazioni
lib/inps.test.ts   test di regressione sull'off-by-one
components/        QuadriPanel, SgraviPanel, primitive UI
app/page.tsx       upload del file e navigazione fra le sezioni
```

## Note sul formato PASSWEB

- Le intestazioni reali non sono in prima riga: vengono individuate cercando la
  riga con più nomi di colonna noti (2-3 righe di metadati sopra, e nel foglio
  sgravi anche una riga di intestazioni di gruppo).
- I nomi colonna sono risolti in modo tollerante a punteggiatura, ellissi e
  troncature (`Correnti, obsoleti, …`). Un filtro la cui colonna non esiste
  viene ignorato con un avviso, mai applicato a vuoto.
- Date accettate: `gg/mm/aaaa`, `aaaa-mm-gg`, `2024 - Ottobre`, `2014-Settembre`,
  seriali Excel. Numeri accettati: `1234.56` e `1.234,56`.
- Il file contiene tre fogli: quadri, "Altro Ente" e "Elenco Sgravi". Vengono
  letti tutti; l'interfaccia espone quadri e sgravi.

Immedia S.p.A.
