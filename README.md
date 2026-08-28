# OSM Landgewinn

Interaktive MapLibre-Karte der aktivsten OpenStreetMap-User in Berlin (H3-Auflösung 9):

**[supaplexosm.github.io/osm-land-gain](https://supaplexosm.github.io/osm-land-gain/)**

## Datenquelle

OSM-Snapshot als PBF, **ohne Overpass**.

Öffentliche Geofabrik-Extracts enthalten seit 2018 keine Usernamen/UIDs (Datenschutz). Deshalb lädt die Pipeline den Berlin-Extract von [BBBike](https://download.bbbike.org/osm/bbbike/Berlin/), der Last-Editor-Metadaten mitführt:

`https://download.bbbike.org/osm/bbbike/Berlin/Berlin.osm.pbf`

Optional: Geofabrik-Internal (`berlin-latest-internal.osm.pbf`) mit OSM-Login.

Eine GitHub Action läuft am **1. jedes Monats** (06:00 UTC) und kann manuell über *workflow_dispatch* gestartet werden.

## Lokal bauen

Python 3.12+ und Node 22+:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r pipeline/requirements.txt
python -m pipeline.run --download

cd web
npm install
npm run dev
```

Die Pipeline schreibt `web/public/data/berlin.pmtiles`, `cells.json` und `users.json` (ein Lauf für Berlin dauert etwa 10–15 Minuten). Das PBF liegt unter `pipeline/_cache/` und wird nicht committet.

Nur die Vektorkacheln neu erzeugen (nach Änderungen am Tile-Export):

```bash
python -m pipeline.run --tiles-only
```

Unter den Hexagonen liegt eine dezente [OpenFreeMap](https://openfreemap.org)-Basemap (Gewässer, Wälder, Straßen, Ortsnamen).

Die GitHub-Page kommt vom Branch `gh-pages` (wird von der Action befüllt). Erster Stand und monatliche Updates: Workflow *Update OSM Land Gain* (manuell oder am 1. jedes Monats).

## Methodik (Kurz)

- Letzter Bearbeiter jedes aktuellen OSM-Objekts (Snapshot): getaggte Nodes, Linien-Ways, Flächen (geschlossene Ways und Multipolygone mit u. a. building/landuse). Keine Routenrelationen.
- Objekt zählt in allen geschnittenen H3-9-Zellen.
- Index: Anzahl × Altersgewicht (&lt;1 Jahr = 1,0 … ≥5 Jahre = 0,05), plus Nachbar-Glättung (Ring 1–2) und Majority-Filter gegen Einzelfelder.
- Filter: alle Features, Straßen (`highway=*`), Gebäude (`building=*`), Landschaft (`landuse`/`natural`/`landcover`/`water`/`waterway` sowie Parks), Einrichtungen (Läden, Gastronomie, Bildung, Hotels …) und Stadtmöbel (Bänke, Laternen, Parkplätze …).
- Fähnchen: lokales Maximum eines Usergebiets (≥ 3 Zellen, Peak ≥ 50 % des persönlichen Maximums).
- Krone: Aktivitätszentrum der 10 User mit der höchsten Indexsumme.
- Gegenwärtig aktiv: letzte Berührung im Ausschnitt vor weniger als 90 Tagen.
- Leere Felder ohne Objekte im Filter bleiben ungefärbt; schwach kartierte Felder mit Objekten: leichte Schraffur, ohne Fähnchen.

## Lizenzhinweis

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende.
