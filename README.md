# OSM Landgewinn

Interaktive Karte der aktivsten OpenStreetMap-User in einem Gebiet:

**[supaplexosm.github.io/osm-land-gain](https://supaplexosm.github.io/osm-land-gain/)**

## Datenquelle und OSM-Zugang

Geofabrik-Extract mit User-Metadaten. Öffentliche Geofabrik-Extracts enthalten keine User-Metadaten, daher lädt die Pipeline den Internal Extract mit OSM-Login-Daten. Diesen lokal anlegen (schreibt `pipeline/_cache/geofabrik-credentials.json`):

```bash
python -m pipeline.geofabrik --write-credentials
```

Einmal pro Quartal wird ein neuer Datenstand bezogen und ausgewertet. Die Datenstände der vergangenen Quartale bleiben zum Vergleich erhalten. Historische Stände können aber auch lokal aus den zugehörigen `*-internal.osh.pbf`-History-Dateien rekonstruiert werden (`osmium time-filter`).

Die Karte läuft derzeit als GitHub Action; für ein automatisches Datenupdate sind die OSM-Login-Daten als Repository-Secrets `OSM_USER` und `OSM_PASSWORD` nötig.

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

Die Pipeline schreibt je Stichtag nach `web/public/data/YYYY-MM-DD/` und dazu `web/public/data/snapshots.json`. PBFs liegen unter `pipeline/_cache/` und werden nicht committet.

Damit die Karte schnell erscheint, ist ein Stichtag auf mehrere Dateien verteilt. Auf dem kritischen Pfad liegen nur die ersten fünf: rund 1,3 MB fest plus die Kacheln des sichtbaren Ausschnitts. Alles Weitere wird nachgeladen und hält nichts auf.

| Datei | Inhalt |
| --- | --- |
| `cells.pmtiles` | Alle Hexagone mit ihren Kennzahlen; daraus wird gezeichnet |
| `cells.json` | Metadaten, Aktivitätszentren, Farbtabelle |
| `overlays.json.gz` | Fertig berechnete Usergebiete |
| `fronts.json.gz` | Fertig berechnete Frontabschnitte für die Haifischzähne |
| `users.json.gz` | Namen, Punkte und Schwerpunkte je Mapper:in |
| `cells.bin.gz` | Top-User je Hexagon; wird im Worker nachgeladen und füllt nur die Panels |
| `scalars.bin.gz` | Kennzahlen je Hexagon; nur die Pipeline liest sie |

Nur die Vektorkacheln neu erzeugen:

```bash
python -m pipeline.run --tiles-only --snapshot 2026-06-21
```

Ältere Snapshot-Ordner auf das aktuelle Dateiformat bringen (ohne PBF, läuft auch automatisch bei jedem Pipelinelauf):

```bash
python -m pipeline.run --upgrade
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
- Gegenwärtig aktiv: letzte Berührung im Ausschnitt vor weniger als 40 Tagen (ebenfalls relativ zum Stichtag).
- Leere Felder ohne Objekte im Filter bleiben ungefärbt; schwach kartierte Felder mit Objekten: leichte Schraffur, ohne Fähnchen.
- Gebietsgrenzen: Zähne (Haifischzahnlinie) markieren Verschiebungen gegenüber dem vorherigen Quartalsstand; die Größe entspricht etwa 1, 2 oder mehr Hexfeldern. Neue Inselgebiete ohne Vorgänger richten sich nach ihrer Breite bzw. Höhe. Der älteste Stand hat keine Zähne.

## Lizenzhinweis

Kartendaten © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende.
