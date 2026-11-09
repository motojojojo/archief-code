# Archief: Visualisator en telefoon-plugin

Code voor Milo's kunstarchief (een Obsidian-kluis). Milo spreekt Nederlands: antwoord altijd in het Nederlands, kort en zonder vakjargon.

## Wat staat waar
- `index.html` — de Visualisator (één bestand, draait in Chrome/Edge op een gekozen Archief-map). Live via GitHub Pages.
- `experiment.html` — de experiment-versie van de Visualisator. Elke wijziging aan de Visualisator gaat in **beide** bestanden, tenzij Milo zegt dat het alleen een experiment is.
- `plugin/archief-mobiel/` — de Obsidian-plugin voor de telefoon (`main.js`, `manifest.json`, `styles.css`).
- `test/` — alles om te testen zonder het echte archief:
  - `test/kluis/` — een NEP-kluis met verzonnen notities en plaatjes (maak opnieuw met `python test/maak-testkluis.py`; vul hem gerust aan als je iets nieuws wilt testen).
  - `test/visualisator.html` — opent de Visualisator op de nepkluis (`?f=experiment.html` voor de experiment-versie). Schrijven gebeurt alleen in het geheugen van het tabblad.
  - `test/plugin.html` — draait de plugin in een nep-Obsidian op de nepkluis. Variabelen: `PLUGIN`, `VIEW`, `LOG`; `window.GH` / `window.GH_OFFLINE` doen alsof GitHub iets anders heeft of offline is.
- Testserver: `python -m http.server 8770` vanuit deze map (staat ook in `.claude/launch.json`), dan `http://localhost:8770/test/visualisator.html` of `/test/plugin.html`.

## Vaste regels
- **Het echte archief komt nooit in deze repository.** Geen echte notities, foto's, namen of andere persoonlijke gegevens committen. Testen gebeurt op `test/kluis`.
- **Snelheid gaat altijd boven mooi.**
- In alles wat je ziet heet het **Project / Projecten**, nooit "lijn" (in de code heten sommige dingen nog `lijn`, dat mag).
- Weggegooide dingen gaan naar `.trash` in de kluis, nooit echt verwijderen.
- Raak `taggroepen.json` in de pluginmap op de telefoon nooit aan (de update-code schrijft alleen `main.js`, `styles.css` en `manifest.json`).
- Test elke wijziging eerst op de testpagina's (echte klikken, niet alleen nagebootste events: `setPointerCapture` meteen bij pointerdown maakt bijvoorbeeld klikken kapot).

## Plugin-versie (belangrijk)
- Bij **elke** wijziging aan de plugin: verhoog de versie in `plugin/archief-mobiel/manifest.json` **en** `const BUILD = '…'` bovenin `main.js` naar hetzelfde nummer. Noem het nieuwe nummer aan Milo.
- De ↻-knop in de plugin haalt de nieuwste versie van de `main`-branch op GitHub (`REPO` bovenin `main.js`) en installeert hem alleen als het versienummer hoger is en `BUILD` gelijk is aan `manifest.json`. Lukt dat niet, dan synchroniseert hij via Remotely Save zoals vroeger.
- Dus: pas als de wijziging op `main` staat, kan Milo op zijn telefoon op ↻ tikken.

## Werken vanuit een cloudsessie (telefoon)
- Werk op een eigen branch en maak een pull request. Merge hem daarna zelf naar `main`, zonder het eerst te vragen (Milo heeft daar vast toestemming voor gegeven, 9 nov 2026), maar alleen als alles op de testpagina's werkt. Vertel Milo daarna kort wat er veranderd is en wat hij moet doen (bijv. op ↻ tikken).
- Na het mergen: Visualisator is binnen een paar minuten bijgewerkt op GitHub Pages; plugin via ↻ op de telefoon.

## Werken op Milo's pc
- De repository staat in `E:\archief-code`. Eerst `git pull`.
- De Visualisator op de pc staat ook als los bestand in `E:\New folder\OneDrive\Milo\kunstportfolio\Visualisator.html` (en `Visualisator-experiment.html`): kopieer `index.html` / `experiment.html` daarheen na een wijziging, met eerst een reservekopie in `kunstportfolio\backups`.
- Plugin rechtstreeks uitrollen (zonder GitHub): kopieer de drie bestanden naar `E:\New folder\OneDrive\Apps\remotely-save\Archief\.obsidian-telefoon\plugins\archief-mobiel\` (nooit `taggroepen.json` overschrijven), met eerst een reservekopie.
- Reservekopieën altijd op E:, nooit op C:.
