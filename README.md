# OSM Landgewinn

Interaktive MapLibre-Karte der aktivsten OpenStreetMap-User (H3-Auflösung 9):

**[supaplexosm.github.io/osm-land-gain](https://supaplexosm.github.io/osm-land-gain/)**

## Datenquelle

OSM-Snapshot als PBF mit Last-Editor-Metadaten, **ohne Overpass**.

Öffentliche Geofabrik-Extracts enthalten seit 2018 keine Usernamen/UIDs. Die Pipeline lädt deshalb **Geofabrik Internal** (OSM-Login):

- **dev:** `berlin-latest-internal.osm.pbf`, zugeschnitten auf eine Test-BBOX in Berlin (`13.2753,52.4382,13.5005,52.5519`)
- **prod:** `berlin-latest-internal.osm.pbf` (Stadt) plus `brandenburg-latest-internal.osm.pbf` (Umland, gleiche Berlin-BBOX) und `freiburg-regbez-latest-internal.osm.pbf` (Lörrach); die Ausschnitte werden gemerged

Historische Stände kommen lokal aus den zugehörigen `*-internal.osh.pbf`-History-Dateien (`osmium time-filter`).

### OSM-Zugang

Geofabrik Internal braucht einen OSM-Account. Die Zugangsdaten **niemals** committen oder im Chat teilen.

Lokal anlegen (fragt interaktiv ab, schreibt `pipeline/_cache/geofabrik-credentials.json` mit Rechten `600`):

```bash
python -m pipeline.geofabrik --write-credentials
```

Alternativ Umgebungsvariablen `OSM_USER` und `OSM_PASSWORD` (nicht in die Repo-Dateien schreiben).

GitHub Action: Repository-Secrets `OSM_USER` und `OSM_PASSWORD` — nicht in der YAML, nur in den GitHub-Secret-Einstellungen.

Zusätzlich: Python 3.12+, Node 22+, [osmium-tool](https://osmcode.org/osmium-tool/) (`sudo apt-get install osmium-tool`).

## Lokal bauen

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r pipeline/requirements.txt

# Testausschnitt + Backfill Winter 2025 / Frühling / Sommer 2026
python -m pipeline.run --profile dev --download --history --dates 2025-12-21,2026-03-21,2026-06-21

# Produktion: Berlin+Umland+Lörrach, letzte 12 Quartale aus History
python -m pipeline.run --profile prod --history

# Aktuellen Stichtag aus Latest (ohne History)
python -m pipeline.run --profile dev --download --snapshot 2026-06-21

cd web
npm install
npm run dev
```

Die Pipeline schreibt je Stichtag nach `web/public/data/YYYY-MM-DD/` (`cells.json`, `users.json`, `cells.pmtiles`) und `web/public/data/snapshots.json`. PBFs liegen unter `pipeline/_cache/` und werden nicht committet.

Nur die Vektorkacheln neu erzeugen:

```bash
python -m pipeline.run --tiles-only --snapshot 2026-06-21
```

Unter den Hexagonen liegt eine dezente [OpenFreeMap](https://openfreemap.org)-Basemap (Gewässer, Wälder, Straßen, Ortsnamen).

## Quartals-Stände

Jeweils am **21. März, 21. Juni, 21. September und 21. Dezember** (12:00 UTC) berechnet die GitHub Action einen neuen Stand und behält die vorherigen. Anzeige:

- 21. März → Datenstand: Frühling $Jahr
- 21. Juni → Datenstand: Sommer $Jahr
- 21. September → Datenstand: Herbst $Jahr
- 21. Dezember → Datenstand: Winter $Jahr

Maximal **12 Snapshots** (drei Jahre). Ältere fallen weg. Das Archiv liegt auf `gh-pages`; die Action holt bestehende Ordner vor dem Deploy zurück.

Manueller Action-Lauf (`workflow_dispatch`) rechnet den letzten Quartalsstichtag neu, legt keinen Extra-Stand an.

Die GitHub-Page kommt vom Branch `gh-pages`. Workflow: *Update OSM Land Gain*.

## Methodik (Kurz)

- Letzter Bearbeiter jedes aktuellen OSM-Objekts (Snapshot): getaggte Nodes, Linien-Ways, Flächen (geschlossene Ways und Multipolygone mit u. a. building/landuse). Keine Routenrelationen.
- Objekt zählt in allen geschnittenen H3-9-Zellen.
- Index: Anzahl × Altersgewicht (&lt;1 Jahr = 1,0 … ≥5 Jahre = 0,05), plus Nachbar-Glättung (Ring 1–2) und Majority-Filter gegen Einzelfelder. Gewichte gelten relativ zum **Stichtag** des Datenstands.
- Filter: alle Features, Straßen (`highway=*`), Gebäude (`building=*`), Landschaft (`landuse`/`natural`/`landcover`/`water`/`waterway` sowie Parks), Einrichtungen (Läden, Gastronomie, Bildung, Hotels …) und Stadtmöbel (Bänke, Laternen, Parkplätze …).
- Fähnchen: lokales Maximum eines Usergebiets (≥ 3 Zellen, Peak ≥ 50 % des persönlichen Maximums).
- Krone: Aktivitätszentrum der 10 User mit der höchsten Indexsumme.
- Gegenwärtig aktiv: letzte Berührung im Ausschnitt vor weniger als 90 Tagen (ebenfalls relativ zum Stichtag).
- Leere Felder ohne Objekte im Filter bleiben ungefärbt; schwach kartierte Felder mit Objekten: leichte Schraffur, ohne Fähnchen.
- Gebietsgrenzen: Zähne (Haifischzahnlinie) markieren Verschiebungen gegenüber dem vorherigen Quartalsstand; die Größe entspricht etwa 1, 2 oder mehr Hexfeldern. Neue Inselgebiete ohne Vorgänger richten sich nach ihrer Breite bzw. Höhe. Der älteste Stand hat keine Zähne.

## Lizenzhinweis

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende.
