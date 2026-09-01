# Maker Inventar · Docker · v8

Schlankes self-hosted Inventar für Elektronik, ESP/Arduino, Module und Maker-Projekte. **Docker ist die vollständige, eigenständig nutzbare Fullstack-App**. Das separate Pages-Paket ist nur ein zusätzlicher Client.

## Architektur

- Flask + SQLite unter `/app/data/app.sqlite`
- Vollständiges Docker-Frontend + installierbare PWA
- REST API für Bauteile, Kategorien, Lagerorte, Projekte und Projektbedarf
- Separates Pages-Frontend nutzt dieselben Frontend-Dateien und wählt Server Provider oder Local Provider (IndexedDB)
- Keine Microservices, kein Redis/PostgreSQL/Node-Backend

## Datenmodell

- `categories`: Kategorien wie Mikrocontroller, Sensoren, Widerstände
- `locations`: physische Lagerorte
- `items`: Name, Bestand, Einheit, Mindestbestand, Kategorie, Lagerort, Wert/Variante, Hersteller, Teilenummer, Package, Link, Notizen sowie Bild-Metadaten
- Bauteilbilder: getrennte Dateien unter `/app/data/uploads/items/`; keine Binärdaten in SQLite
- `projects`: Name, Status, Notizen
- `project_items`: benötigte Menge eines Inventarartikels pro Projekt

Die Projektansicht zeigt direkt, wie viele benötigte Positionen bereits ausreichend vorhanden sind.

## Docker / Portainer

Der Container läuft intern auf `8080`, Arbeitsverzeichnis ist `/app`, persistente Nutzdaten liegen ausschließlich unter `/app/data`.

Beispiel für Portainer/Git-Build: siehe `docker-compose.example.yml`. Repository-URL z. B.:

`https://github.com/USER/maker-inventar-docker.git#main`

Persistentes Volume z. B.:

`/home/USER/docker/maker-inventar/data:/app/data`

Nach Git-Update kann der Stack neu deployed werden; die SQLite-Datei bleibt im Host-Volume erhalten.

## Environment-Variablen

- `APP_TITLE` – Anzeigename
- `APP_URL` – öffentliche Docker/API-URL, z. B. `https://api.example.com`
- `DOCKER_WEB_URL` – optionaler manueller Fallback zur vollständigen Docker-Weboberfläche; Standard ist `APP_URL`
- `SECRET_KEY` – reserviert für serverseitige Sicherheitsfunktionen; geheim halten
- `AUTH_ENABLED` – `true` aktiviert zusätzlichen Bearer-Token-Schutz der API
- `APP_API_TOKEN` – Token für `Authorization: Bearer ...`, nur nötig bei `AUTH_ENABLED=true`
- `BACKUP_KEEP` – Anzahl rotierender SQLite-/Upload-Sicherheitsbackups, Standard `50`
- `IMAGE_MAX_BYTES` – maximales serverseitiges Bild-Uploadlimit, Standard `4194304` (4 MiB)
- `PWA_ALLOWED_ORIGIN` – exakt erlaubte Pages-Origin, z. B. `https://app.example.com`
- `DATA_DIR` – standardmäßig `/app/data`

Secrets niemals ins Repository oder Image schreiben. `.env.example` enthält nur Platzhalter.

## Cloudflare Access / CORS

Typischer Betrieb:

- Docker-Weboberfläche: Cloudflare Access OTP/Allow
- Pages-PWA im Server-Modus: Cloudflare Access Service Token (`CF-Access-Client-Id`, `CF-Access-Client-Secret`)
- Pages lokal: kein Server/Token nötig

Die Browser-PWA speichert Service-Token nur in einer separaten IndexedDB-Konfigurationsdatenbank auf dem jeweiligen Gerät. Secrets werden nicht in Backups exportiert und nach Speicherung nicht wieder vollständig angezeigt.

CORS wird nur für die **exakte** `PWA_ALLOWED_ORIGIN` gesetzt. Unterstützt werden GET/POST/PUT/PATCH/DELETE/OPTIONS sowie `Content-Type`, `Authorization`, `CF-Access-Client-Id` und `CF-Access-Client-Secret`. Kein `Access-Control-Allow-Origin: *`.

## API

Wichtige Endpunkte:

- `GET /health`
- `GET /api/config`
- `GET /api/bootstrap`
- `/api/items`, `/api/items/<id>`
- `GET/POST/DELETE /api/items/<id>/image`
- `/api/categories`, `/api/locations`
- `/api/projects`, `/api/project-items`
- `GET /api/export/backup`
- `GET /api/export/items.csv`
- `POST /api/import/preview`
- `POST /api/import/restore`

## SQLite / Migrationen

SQLite wird mit `WAL`, `synchronous=FULL`, `foreign_keys=ON` und Busy-Timeout betrieben. Die Schema-Version liegt in `PRAGMA user_version`; Migrationsschritte werden beim Start automatisch angewendet. Die Bild-Migration aus v6 auf Schema-Version 2 bleibt erhalten. v8 benötigt keine weitere SQLite-Schemaänderung; die frühere Tags-Spalte bleibt intern nur aus Kompatibilitätsgründen bestehen und wird von API, UI, CSV und neuen Backups nicht mehr verwendet. Vor Migrationen wird automatisch ein DB-Backup erzeugt.

## Backup / Restore

Backupformat: `maker-inventar-backup`, Version 2. Die UI exportiert ein Vollbackup-ZIP mit `backup.json` und `images/`. Alte JSON-Backups der Version 1 bleiben importierbar. Zugangsdaten/Cloudflare-Secrets sind nie Bestandteil eines Backups.

Vor destruktivem Restore/Import erzeugt das Backend automatisch ein SQLite-Backup unter `/app/data/backups/`; vorhandene Uploads werden zusätzlich als `uploads-…zip` gesichert. Alte Sicherungen werden gemäß `BACKUP_KEEP` rotiert. `replace` ersetzt den Zielbestand und seine Bilder, `merge` arbeitet nach stabiler ID und behält bestehende Zielbilder, sofern kein neues Bild übertragen wird. Es gibt keine Fake-Synchronisation.

## PWA / Offline-App-Shell

Docker- und Pages-Frontend enthalten Manifest, Service Worker, Apple Touch Icon, 192/512-Icons, Maskable-Icon und Offline-Fallback. App-Shell-Dateien werden vollständig vorgecached; externe CDN-Abhängigkeiten gibt es nicht.

Die installierte PWA kann daher nach einem erfolgreichen Cache-Lauf ihre Oberfläche lokal starten. Im Pages-Server-Modus kann diese lokale App-Shell weiterhin direkt die Docker-API verwenden, auch wenn Pages vorübergehend ausfällt. Im Local-Modus liegen Fachdaten in IndexedDB.

## Update-Lifecycle

Service-Worker-Cache: `maker-inventar-pwa-v8`.

- neue Version wird installiert und vorbereitet
- `skipWaiting()` wird **nicht** automatisch bei Installation aufgerufen
- laufende Sitzung bleibt auf der alten Version
- Update wird beim sicheren späteren Start aktiv oder per „Jetzt aktualisieren“ bewusst aktiviert
- `controllerchange` löst nur bei einem ausdrücklich manuellen Update höchstens einen Reload aus
- aktive Ansicht wird in `localStorage` erhalten
- IndexedDB und Server-Zugangsdaten werden bei App-Updates nicht gelöscht

Bei jeder relevanten Frontendänderung müssen App-/Cache-Version gemeinsam erhöht werden.

## ZIP-/Git-Workflow

Der Release-ZIP enthält bewusst **keine aktive `.github/`-Infrastruktur und keine `.gitignore`**. Diese Dateien werden repositoryseitig gepflegt und bei App-Releases nie ersetzt.

Der einmalig im Repository installierte Import-Workflow:

1. akzeptiert genau ein neues Root-`*.zip`,
2. prüft ZIP-Pfade und typische Secret-Dateien,
3. lehnt aktive Workflow-Dateien im ZIP ab,
4. schützt `.git`, `.github/` und `.gitignore`,
5. ersetzt nur App-/Release-Dateien,
6. entfernt das ZIP,
7. committet und pusht den neuen Stand.

Der Bot-Commit löst keinen erneuten Import aus; dadurch entsteht keine Commit-Schleife. Das Release-ZIP repräsentiert direkt das Repository-Root.

## Pages-Kompatibilität

Docker v8 ↔ Pages v8. Backupformat Version 2 bleibt kompatibel; v8 entfernt die Tags-Funktion aus UI, API-Ausgabe, CSV und neuen Backups. Bei Änderungen an API, Datenmodell, Provider, Backupformat oder Service Worker beide Pakete gemeinsam versionieren.

## Bekannte Einschränkungen v8

- keine echte bidirektionale Offline-Synchronisationsengine; Datenübertragung ist bewusst manuell
- keine Barcode-/QR-Erfassung
- keine automatischen Mouser/DigiKey/Octopart-Abfragen
- ein Hauptbild pro Bauteil; noch keine Bildergalerie oder Datenblattverwaltung
- keine Reservierung von Bestand zwischen mehreren gleichzeitig geplanten Projekten
- Server-Modus bietet ohne echte Offline-Queue keine Offline-Schreiboperationen

## Tests

`python -m unittest discover -s tests -v`

Zusätzlich vor Release: Python-Syntax, Flask-Routen/API, Migration/Restore, JavaScript-Syntax, Manifest/Service Worker, Local/Server Provider, CORS, iPhone-Layout und PWA-Lifecycle prüfen.

## v2 UI-Update

v2 richtet die iPhone-Oberfläche am freigegebenen Mockup-Stil aus: großer Header, Status-Badge, Statistik-Karten, visuelle Bauteilkarten, Projekt-Fortschritt, Bottom-Sheet-Formulare und gruppierte Setup-Karten. Das Datenmodell und Backupformat bleiben gegenüber v1 kompatibel.

### Release-ZIP, `.gitignore` und `.github/`

Release-ZIPs enthalten absichtlich **keine `.gitignore` und keine aktive `.github/`-Workflow-Infrastruktur**. Der Import-Workflow schließt beide Bereiche zusätzlich bei `rsync --delete` aus. Damit bleiben eigene Ignore-Regeln und Workflows bei jedem App-Update unverändert.

Für ein bestehendes Repository muss der bestehende Import-Workflow **einmalig manuell** in `.github/workflows/` installiert bzw. der bisherige Import-Workflow ersetzt werden. Danach werden normale Releases nur noch als ZIP hochgeladen.

Für neue Repositories liegt `.gitignore.example` als Vorlage bei; die echte `.gitignore` wird bewusst nicht als Release-Datei ausgeliefert.


## UI-Feinschliff v5

v5 ersetzt die bisherigen Unicode-Platzhalter in der Oberfläche durch ein vollständig lokales SVG-Iconset. Navigation, Status, Setup, Aktionen und Bauteil-Platzhalter verwenden nun eine einheitliche abgerundete Linienoptik ohne externe Abhängigkeiten.

## Änderungen v8

Die frühere Tags-Funktion wurde entfernt. Alte Tag-Werte werden nicht mehr angezeigt, durchsucht, über die API ausgegeben, in CSV exportiert oder in neue Backups übernommen. Alte Backups mit einem `tags`-Feld bleiben importierbar; das Feld wird ignoriert.

## Bauteilbilder

Bauteile können ein optionales Hauptbild erhalten. Der gemeinsame Frontend-Code bietet Kamera und Fotobibliothek an und skaliert Bilder vor dem Upload auf maximal 1600 px. Serverseitig werden nur JPEG, PNG und WebP bis `IMAGE_MAX_BYTES` akzeptiert; neue PWA-Aufnahmen werden als JPEG gespeichert. Dateien liegen persistent unter `/app/data/uploads/items/`. Beim Löschen eines Bauteils wird das zugehörige Bild entfernt.

## Änderungen v8

Der Service-Worker-Lifecycle wurde gehärtet: Registrierung mit `updateViaCache: none`, sofortige und periodische Update-Prüfung, erneute Prüfung bei `online` und nach Rückkehr in den Vordergrund, `clients.claim()` nach Aktivierung sowie ein kontrollierter Einmal-Reload nach bewusstem `SKIP_WAITING`. Ein bereits in einer früheren Sitzung vollständig vorbereitetes Update wird beim nächsten App-Start als sicherem Neustart automatisch aktiviert. Während einer laufenden Sitzung werden neue Versionen weiterhin nur vorbereitet und nicht erzwungen.
