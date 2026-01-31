# PUN/PSV Tracker (GNOME Shell)

Estensione GNOME Shell che mostra **PUN** (luce) e **PSV** (gas) del mercato italiano nella top bar, con popup dedicati e serie storiche recenti.

## Funzionamento

- **Top bar**: icona lampadina (PUN) e fiamma (PSV) con i valori di oggi.
- **Popup**: cliccando sul valore luce si apre il popup **solo PUN**, cliccando sul gas si apre il popup **solo PSV**.
- **Serie storica**: ultimi **30 giorni**, organizzati in 6 colonne (3 coppie data/valore per riga).
- **Mese precedente**: mostra il valore medio del mese precedente (in grassetto).
- **Colori**: le celle dei valori sono verdi se **minori** del mese precedente, rosse se **maggiori**, con intensità proporzionale alla distanza.
- **Refresh**: aggiornamento **una volta al giorno** con cache locale.
- **Precisione**: la precisione dei valori è configurabile tramite costanti nel sorgente.

## Fonte dati

I dati vengono letti dalle pagine HTML pubbliche di:

- PUN: `https://www.abbassalebollette.it/glossario/pun-prezzo-unico-nazionale/`
- PSV: `https://www.abbassalebollette.it/glossario/psv/`

> Nota: il parsing è HTML, senza usare API. Se la pagina cambia struttura, potrebbe servire un aggiornamento del parser.

## Screenshot

_(Incolla qui lo screenshot)_

## Installazione

1. Copia la cartella dell’estensione in:
   - `~/.local/share/gnome-shell/extensions/pun-psv@sydro.github.com/`
2. Abilita l’estensione:
   - `gnome-extensions enable pun-psv@sydro.github.com`
3. Riavvia GNOME Shell (Xorg: `Alt+F2` → `r`, Wayland: logout/login).

## Requisiti

- GNOME Shell **45 / 46 / 47**

## Build / Packaging

Per creare un archivio installabile:

```
gnome-extensions pack -f \
  --extra-source=data.js \
  --extra-source=icons \
  --extra-source=stylesheet.css \
  .
```

### Installazione da ZIP

```
gnome-extensions install -f ./pun-psv@sydro.github.com.shell-extension.zip
```

Poi abilita l’estensione:

```
gnome-extensions enable pun-psv@sydro.github.com
```

### Disinstallazione

```
gnome-extensions uninstall pun-psv@sydro.github.com
```

## Struttura progetto

- `extension.js`: UI, menu e interazioni.
- `data.js`: fetch HTML, parsing, cache e normalizzazione.
- `stylesheet.css`: stile top bar e popup.
- `icons/`: icone SVG (lampadina e fiamma).

## Personalizzazione precisione

Nel file `extension.js` puoi modificare la precisione dei valori:

- `PUN_DISPLAY_DECIMALS` e `PSV_DISPLAY_DECIMALS`: precisione **top bar**
- `PUN_TABLE_DECIMALS` e `PSV_TABLE_DECIMALS`: precisione **tabelle**
