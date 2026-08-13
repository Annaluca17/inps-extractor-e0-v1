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

- **Quadri E0/V1** — filtri per periodo, tipologia e stato; ordinamento per
  Data Inizio/Fine Periodo; selezione colonne; subtotali per anno; export XLSX.
- **Sgravi contributivi** — riepilogo del foglio "Elenco Sgravi" per codice e per
  anno di competenza, con dettaglio mensile ed export su tre fogli
  (per codice, per anno, dettaglio righe).

## Export verso UniEmens Variazione Builder

Il pulsante *UniEmens Builder (.json)* produce un file nella forma esatta dello
stato del builder (`mkPer()` / `dips`), pronto per l'import. Formati: date
`AAAA-MM-GG`, `AnnoMeseErogazione` `AAAA-MM`, importi `1234,56`.

La causale la sceglie l'operatore — non è derivabile dal file. **C1** aggiunge
al dichiarato (esce con inquadramento e periodo, senza importi: il denaro nuovo
non è nel file), **C5** lo sostituisce, **C6** lo cancella (solo date).

Regole di aggregazione applicate al C5:

| periodo | quadro | enti versanti |
|---|---|---|
| dal 10/2012 | uno per mese | una terna per ogni mese di pagamento **diverso** dal mese di competenza; se il pagamento cade nel mese stesso, nessuno |
| fino al 09/2012, anno **con** V1C1 | anno intero, mai spezzato | una terna per **ciascun** mese di pagamento |
| fino al 09/2012, anno **senza** V1C1 | cumulato | nessuno |

`AnnoMeseErogazione` è valorizzato dalla colonna `Denuncia`. È il mese di
trasmissione, che sugli arretrati coincide con quello di erogazione ma non è la
stessa cosa: resta un valore da controllare nel builder.

I quadri aggregati si spezzano quando cambia l'inquadramento:

| campo | perché |
|---|---|
| Tipo impiego | passaggio part-time ↔ tempo pieno |
| Tipo Servizio | passaggio tempo determinato ↔ indeterminato |
| Qualifica | progressione fra le aree |
| Percentuale part-time | **solo dai periodi 2020 in poi**: prima le percentuali dichiarate erano spesso errate e spezzare produrrebbe frammentazione inutile |

`Contratto` è escluso: vale sempre RALN, quindi non discrimina. Il confronto è
sui **codici**, non sulle descrizioni — `056000` e `056000 POSIZIONE ECONOMICA
DI ACCESSO C1` sono la stessa qualifica e non spezzano.

Gli anni riprodotti interi per la presenza di un V1C1 non si spezzano mai: se
al loro interno l'inquadramento varia, il quadro ne porta un solo valore e la
cosa finisce in `_avvisi`.

Ogni quadro porta `_righeOrigine` con i numeri di riga del file INPS. Le
incongruenze finiscono in `_avvisi` dentro il JSON, non nell'interfaccia.

## Filtri sulle intestazioni

Ogni intestazione della tabella ha un imbuto (▼) che apre l'elenco dei valori
distinti di quella colonna con il numero di righe per valore, una ricerca e il
comando *solo questo*. Serve soprattutto a isolare l'ente di interesse quando
il file ne contiene più d'uno. I filtri attivi sono elencati sopra la tabella e
si combinano in AND con periodo, tipologia e stato.

Il pannello sta **sopra** la tabella e non è un menu a comparsa
sull'intestazione: la tabella vive in un contenitore con scorrimento, che
ritaglierebbe un elemento posizionato in modo assoluto.

## Selezione delle colonne

All'apertura di un file sono già selezionate le colonne **popolate**; quelle
senza alcun valore restano spente e sono mostrate tratteggiate con l'etichetta
"vuota". Ogni colonna riporta quanti valori contiene. Sul tracciato PASSWEB
tipico ciò significa 80 colonne attive su 115.

Con **Salva la selezione attuale** l'elenco viene memorizzato nel browser
(`localStorage`) come *colonne predefinite*: da quel momento sono sempre
attive a ogni caricamento, anche se nel file risultano vuote — sono marcate
con 📌. Se una predefinita non esiste proprio nel file caricato viene
segnalata. Sono disponibili anche le selezioni rapide *Solo colonne con dati*,
*Colonne principali*, *Solo le predefinite*, *Tutte*, *Nessuna*.

Nessun dato del file viene salvato: solo i nomi delle colonne scelte.

## Il file esportato

- **Ordinamento** per Data Inizio Periodo e, a parità, Data Fine Periodo.
  Decrescente per impostazione predefinita; commutabile dall'interfaccia.
  L'ordinamento è stabile e le righe con data non interpretabile finiscono in
  coda in entrambe le direzioni, per non mescolarsi ai dati validi.
- **Colonna `Riga`** in testa, con il numero di riga del file INPS di origine:
  permette di risalire alla riga sorgente di qualunque valore.
- **Intestazioni brevi**: la sigla quando esiste (`CF`, `DT_INIZ`, `IMP`…),
  altrimenti il nome originale. Le larghezze sono calcolate sul dato e non
  sull'intestazione, che può allargare la colonna solo fino a 14 caratteri:
  nei tracciati PASSWEB l'intestazione è più lunga del contenuto in 66 colonne
  su 80, e lasciarla comandare produceva colonne larghissime e mezze vuote.
- **Filtro automatico** sulla riga di intestazione.
- **Subtotali come formula** `SUBTOTAL(9;intervallo)`. Aggiungendo o togliendo
  righe in Excel i totali si aggiornano; le righe nascoste dal filtro non
  vengono conteggiate e i subtotali annidati non sono contati due volte.
  Disattivabile per ottenere valori fissi.

Due conseguenze da conoscere. Il raggruppamento per anno segue l'ordinamento e
crea un subtotale al termine di ogni blocco contiguo: è ciò che rende gli
intervalli delle formule validi. E le celle con formula sono scritte senza
valore in cache — Excel e LibreOffice ricalcolano all'apertura, ma anteprime e
visualizzatori che non ricalcolano possono mostrarle vuote.

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

**3. Riordinare non è modificare.** `sortByPeriod` passa da
`assertPermutation`: stesse righe, stessi oggetti, nessuna persa o duplicata.
Filtro e ordinamento restano due passi distinti — il filtro non può riordinare,
l'ordinamento non può aggiungere o togliere righe.

**4. L'export viene riletto.** `assertSheetMatches` rilegge il foglio appena
costruito e lo confronta cella per cella con la matrice sorgente, prima di
scrivere il file. Per le celle con formula confronta la formula, non il valore.

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
