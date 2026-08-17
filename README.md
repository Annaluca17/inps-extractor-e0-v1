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

### Dati che il file INPS non contiene

Il tracciato PASSWEB non porta l'anagrafica del lavoratore né l'intestazione
della denuncia, ma l'XML non può farne a meno: `Cognome` e `Nome` sono
obbligatori e il frontespizio è tutto il blocco `DatiMittente` / `Azienda`. Il
pannello **Dati per il builder**, sotto il pulsante di export, li raccoglie.

Valgono **solo per il file .json**: l'export .xlsx resta la trascrizione fedele
del file INPS e non ne è toccato.

Cognome e nome mancanti non bloccano l'export — il JSON esce comunque, con
l'avviso dentro `_avvisi` — ma il builder non produrrà un XML valido. Il
frontespizio lasciato in bianco non viene scritto nel JSON, così il builder
conserva quello che ha già caricato; l'ente si può riprendere dal file, che lo
conosce dalla colonna del dichiarante.

### Cumulo manuale (colonna ∑)

Tutti i pagamenti successivi alla cessazione vanno sommati all'**ultimo mese
lavorato**. Ma distinguere un E0 fuori posto — un errore del comune — da una
riassunzione, per esempio uno stagionale, non è deducibile dal file: lo decide
l'operatore.

Le due colonne di spunta fanno cose diverse e indipendenti:

| colonna | cosa fa |
|---|---|
| **∑** | fonde la riga nel quadro unico. Non decide se esportarla: le righe non spuntate escono comunque, come quadri a sé |
| **✕** | toglie la riga dall'export |

I filtri lavorano per valore e non bastano da soli: un doppione da scartare e
la riga buona possono avere lo stesso stato e lo stesso periodo, e nessun
filtro sa distinguerli. Serve anche il contrario — tenere una riga *Spento*
perché serve nella somma, e insieme buttare una *Corrente* ripetuta. La
colonna ✕ copre entrambi i casi.

L'esclusione manuale passa dalla stessa partizione dei filtri: la riga compare
nel registro con il motivo «esclusa a mano dall'operatore», il conteggio
`tenute + escluse = righe nel foglio` continua a tornare, e da lì si
**ripristina** con un clic, singolarmente o tutte insieme.

Nella tabella ogni riga ha una casella nella colonna **∑**. Le righe spuntate
confluiscono in un **unico V1C5**: periodo di riferimento quello della riga che
porta il codice cessazione (in mancanza, la più antica fra le scelte), importi
sommati, e un ente versante per ogni mese di pagamento diverso dal riferimento.
Vale solo per la causale 5; il cumulo finisce in `_avvisi` con l'elenco delle
righe di origine.

Fra le righe scelte il riferimento è preso fra quelle **non superate**: da lì il
quadro copia inquadramento, regime e date, e quelli di una riga *Spenta* sono
una dichiarazione già sostituita. Nel file PASSWEB l'E0 rifatto e il V1 che lo
rifà hanno la stessa data e lo stesso codice cessazione — solo lo stato li
distingue. I campi che il riferimento non porta vengono completati dalle altre
righe scelte, prima le Correnti. Se ogni riga della selezione è superata il
riferimento sarà per forza una di quelle, e `_avvisi` lo dice.

Regole di aggregazione automatiche, per le righe non spuntate:

| periodo | quadro |
|---|---|
| dal 10/2012 | uno per mese |
| fino al 09/2012, anno **con** V1C1 | anno intero, mai spezzato |
| fino al 09/2012, anno **senza** V1C1 | cumulato |

L'aggregazione riguarda il **quadro**. Gli enti versanti seguono una regola
sola e valida sempre: **una terna per ciascun mese di pagamento**, compreso il
mese di competenza. La somma delle terne deve ricostruire per intero gli
imponibili dichiarati — i controlli INPS 00171I e 00032I sono bidirezionali e
contestano tanto l'eccesso quanto il residuo. Le versioni precedenti
omettevano la terna quando il pagamento cadeva nel mese del quadro, e non ne
emettevano affatto sugli anni cumulati senza V1C1: entrambe le regole si sono
rivelate sbagliate sui flussi realmente accettati da INPS.

La terna di fine servizio è **TC7 in regime TFS e TC8 in regime TFR**: sono
gestioni distinte e la congruità le confronta separate.

Il regime è quello **dichiarato** nella colonna `Regime fine servizio` — `1` e
`2` valgono TFR, `3` vale TFS — non quello dedotto da dove ci sono gli importi.
Sono due cose diverse appena un blocco mescola righe di regime diverso, ed è
frequente: il passaggio da TFS a TFR lascia nel file la vecchia riga *Spenta* in
regime TFS accanto al V1 *Corrente* che l'ha rifatta in TFR. Dedurre il regime
dagli importi produceva quadri in cui `RegimeFineServizio` diceva TFS e la
gestione previdenziale TFR, con la terna emessa sulla gestione sbagliata e
l'imponibile dell'altro regime scartato senza che si vedesse. Gli importi
decidono solo dove il codice manca, cioè sulle righe ante 10/2012.

Quando le righe di un quadro portano comunque due regimi — succede sul cumulo
manuale e sugli anni riprodotti interi, dove la spezzatura non si applica — il
quadro ne dichiara uno solo e `_avvisi` riporta sia i due codici sia
l'imponibile dell'altro regime che resta fuori, con i numeri di riga.

La **percentuale part-time** viene riscalata: il DMA2 la vuole come intero, cioè
la percentuale con tre decimali e senza separatore — 66,67% si dichiara `66670`
— mentre PASSWEB la espone come decimale (`66.67`). Passarla così com'è
produrrebbe un valore cento volte più piccolo del dovuto.

L'imponibile del Fondo Credito si legge da `Imponibile Credito` oppure, sulle
righe più vecchie che usano l'altro tracciato, da `Imponibile Credito/ENPDEP`;
se non c'è né l'una né l'altra rispecchia l'imponibile pensionistico, perché è
su quello che il Fondo Credito insiste e senza `ImpCredito` il builder non
emette `GestCredito`.

`AnnoMeseErogazione` è valorizzato dalla colonna `Denuncia`. È il mese di
trasmissione, che sugli arretrati coincide con quello di erogazione ma non è la
stessa cosa: resta un valore da controllare nel builder.

I quadri aggregati si spezzano quando cambia l'inquadramento:

| campo | perché |
|---|---|
| Tipo impiego | passaggio part-time ↔ tempo pieno |
| Tipo Servizio | passaggio tempo determinato ↔ indeterminato |
| Qualifica | progressione fra le aree |
| Regime fine servizio | passaggio TFS ↔ TFR: sono gestioni previdenziali distinte, un quadro ne dichiara una sola e gli importi dell'altra non avrebbero dove andare |
| Percentuale part-time | **solo dai periodi 2020 in poi**: prima le percentuali dichiarate erano spesso errate e spezzare produrrebbe frammentazione inutile |

`Contratto` è escluso: vale sempre RALN, quindi non discrimina. Il confronto è
sui **codici**, non sulle descrizioni — `056000` e `056000 POSIZIONE ECONOMICA
DI ACCESSO C1` sono la stessa qualifica e non spezzano.

### Quadri causale 5 in conflitto

Due quadri C5 sullo stesso periodo si annullano a vicenda: la C5 sostituisce il
dichiarato, INPS li elabora in sequenza e l'ultimo vince. Il file resta
formalmente valido, quindi l'errore non si vede — ma il lavoro fatto sul primo
quadro va perso.

Il caso tipico è una riga già superata rimasta nei filtri accanto al V1 che
l'aveva corretta: nei file PASSWEB l'E0 sostituito resta presente con stato
**Spento**. Filtrare su *Corrente* lo toglie di mezzo. Se accade comunque, il
fatto finisce in `_avvisi` con i numeri di riga dei quadri coinvolti.

Il controllo riguarda i periodi identici. Le sovrapposizioni parziali non sono
segnalate: lì la scelta dipende da cosa si vuole sostituire, e non è deducibile
dal file.

Gli anni riprodotti interi per la presenza di un V1C1 non si spezzano mai: se
al loro interno l'inquadramento varia, il quadro ne porta un solo valore e la
cosa finisce in `_avvisi`.

Ogni quadro porta `_righeOrigine` con i numeri di riga del file INPS. Le
incongruenze finiscono in `_avvisi` dentro il JSON, non nell'interfaccia.

## La tabella come strumento di lavoro

Il pannello **Selezione colonne** si richiude: dopo la scelta iniziale occupa
quasi 400 pixel che servono ai dati, e l'intestazione continua a dire quante
colonne sono attive. Lo stato aperto o chiuso resta memorizzato.

La tabella ha un **schermo intero** (ESC per uscire) e il numero di righe per
pagina è regolabile fino a mostrarle tutte: sui file da un dipendente, che sono
il caso normale, si vede l'intero periodo senza cambiare pagina.

Le colonne **∑**, **✕** e **Riga** restano bloccate a sinistra durante lo
scorrimento orizzontale: con ottanta colonne attive, le caselle da spuntare
sarebbero altrimenti la prima cosa a sparire proprio mentre si leggono gli
importi.

Spuntando le righe nella colonna ∑, una barra mostra i **totali delle righe
selezionate** — imponibile, contributi, TFS/TFR, credito — che è la somma che
prima si faceva a parte in Excel.

Le spunte sopravvivono al cambio dei filtri, ma nell'export finiscono solo le
righe ancora selezionate. Quando qualcuna resta fuori dai filtri attuali viene
detto esplicitamente, con il conteggio: il totale mostrato è sempre quello che
uscirà davvero.

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
- **Intestazioni identiche al file INPS**: il nome della colonna resta quello
  di origine, senza sigle. L'export deve poter essere confrontato a occhio con
  il file di partenza, che è il primo controllo che si fa. Le larghezze sono
  calcolate sul dato e non sull'intestazione, che può allargare la colonna solo
  fino a 14 caratteri: nei tracciati PASSWEB l'intestazione è più lunga del
  contenuto in 66 colonne su 80, e lasciarla comandare produceva colonne
  larghissime e mezze vuote.
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
