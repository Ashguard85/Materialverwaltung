# Maker Inventar · GitHub Pages PWA · v6

Statisches Zusatz-Frontend für **Maker Inventar Docker v6**. Das Release-ZIP enthält ausschließlich statische App-Dateien: kein Flask, kein Python-Backend, keine SQLite-Datei, keine serverseitigen Secrets und keine `.github/`-Workflow-Infrastruktur. Bestehende Repository-Workflows bleiben beim ZIP-Import unangetastet.

## Betriebsmodi

### Lokal

- App-Shell aus Service-Worker-Cache
- strukturierte Fachdaten in IndexedDB (`maker-inventar-local`)
- kein Backend, keine Backend-URL, kein Cloudflare-Token
- nach erfolgreicher Installation/Cache-Befüllung weitgehend offline nutzbar
- Vollbackup-ZIP mit Daten + Bauteilbildern dringend empfohlen, da Website-/PWA-Daten auf dem Gerät verloren gehen können

### Server

- dieselbe UI und Fachlogik
- `ServerProvider` spricht per HTTPS mit dem Docker-Backend
- Backend URL + Cloudflare Service Token werden nur auf diesem Gerät in einer separaten IndexedDB (`maker-inventar-config`) gespeichert
- Service Secret wird nach Speicherung nicht wieder vollständig angezeigt
- Secrets sind nicht Bestandteil von Exporten/Backups

Ein Moduswechsel ändert **nur den aktiven Provider**. Es gibt keine automatische Synchronisation. Die Funktionen „Lokale Daten auf Server übertragen“ und „Serverdaten lokal übernehmen“ sind bewusst bestätigte Migrationen mit Vorschau; vor destruktiven Zieländerungen wird ein Sicherheitsbackup erzeugt bzw. exportiert.

## Gemeinsame Frontend-/Provider-Struktur

- `index.html`, `app.css`, `app.js`: gemeinsame UI/Fachlogik
- `providers.js`: `ServerProvider` und `LocalProvider`
- `db.js`: IndexedDB-Versionierung, lokale Bild-Blobs und getrennte Konfigurationsdatenbank
- `zip.js`: kleine lokale ZIP-Implementierung für bildfähige Vollbackups ohne CDN-Abhängigkeit
- `config.json`: einziges Build-spezifisches, nicht geheimes Runtime-Profil

Die gleichen Frontend-Dateien liegen im Docker-Paket unter `app/frontend/`. Docker v6 ↔ Pages v6 gehören zum selben Release. v6 erweitert Datenmodell und Backupformat um optionale Bauteilbilder; alte Backup-Version 1 bleibt importierbar.

## Konfiguration

`config.json` darf **keine Secrets** enthalten. Optional können dort feste öffentliche Defaults eingetragen werden:

```json
{
  "appName": "Maker Inventar",
  "version": "v6",
  "buildTarget": "pages",
  "defaultMode": null,
  "defaultServerUrl": "https://api.example.com",
  "dockerWebUrl": "https://docker-app.example.com"
}
```

Bei leerer `defaultServerUrl` wird die Backend-URL im Setup eingegeben. Für externe Server erzwingt der Client HTTPS.

## Cloudflare Access / CORS

Für Server-Modus kann ein separates Cloudflare Access Service Token pro Gerät verwendet werden. Token eng berechtigen und bei Verlust des Geräts einzeln widerrufen.

Das Docker-Backend muss z. B. erhalten:

`PWA_ALLOWED_ORIGIN=https://app.example.com`

CORS-Preflight erlaubt die Cloudflare-Header nur von dieser exakten Origin. Cloudflare Access sollte für API-Zugriff eine passende Service-Auth-Policy besitzen; die normale Docker-Oberfläche kann parallel über OTP/Allow geschützt bleiben.

### CSP

GitHub Pages erlaubt keine frei konfigurierbaren Response-Header. Deshalb enthält `index.html` eine restriktive CSP als Meta-Policy: keine Inline-Scripts, keine Inline-Handler, kein `eval`, keine CDN-Abhängigkeiten. `connect-src https:` ist nötig, weil die Server-URL zur Laufzeit frei konfigurierbar ist. Bei fest gebauter Backend-URL kann diese Direktive projektspezifisch weiter eingeschränkt werden.

## Backup / Restore

Das gemeinsame Datenformat ist ab v6 Version 2. Die App exportiert standardmäßig ein **Vollbackup als ZIP**:

```text
maker-inventar-backup-….zip
├── backup.json
└── images/
    └── <item-id>.jpg
```

`backup.json` enthält Kategorien, Lagerorte, Bauteile, Projekte und Projektpositionen. Bilder liegen separat im ZIP, nicht als Base64 im JSON. Cloudflare- und App-Zugangsdaten werden nie exportiert. Alte reine JSON-Backups mit Formatversion 1 bleiben importierbar.

Im Local-Modus werden Bilder als Blob in IndexedDB gespeichert. Beim Restore wird die Datei zuerst validiert, die Anzahl der Datensätze angezeigt und zwischen Ersetzen/Zusammenführen gewählt. Vor einem lokalen Ersetzen wird ein Vollbackup des aktuellen Zustands angeboten. Auf iPhone wird beim Export bevorzugt die Web Share API verwendet; ansonsten erfolgt ein Download-Fallback.

## Offline-App-Shell

`service-worker.js` precacht mindestens:

- `index.html`
- `app.js`, `app.css`, `db.js`, `providers.js`, `zip.js`
- `config.json`
- `manifest.webmanifest`
- `offline.html`
- alle PWA-Icons

Es gibt keine externen Laufzeit-CDNs. Nach erfolgreichem ersten Online-Lauf kann die installierte App daher aus dem lokalen Cache starten, wenn GitHub Pages vorübergehend nicht erreichbar ist.

- Local-Modus: UI + IndexedDB funktionieren ohne Backend
- Server-Modus: gecachte UI kann weiterhin direkt die Docker-API ansprechen
- ist Docker nicht erreichbar, werden Schreibaktionen nicht als erfolgreich vorgetäuscht; v2 implementiert bewusst keine Offline-Schreibqueue

## PWA-Update-Lifecycle

Cache-Version: `maker-inventar-pwa-v6`.

- Browser/Client prüft auf neuen Service Worker
- neue App-Shell wird im Hintergrund in einem neuen versionsbezogenen Cache vorbereitet
- während der laufenden Sitzung wird **kein automatisches `skipWaiting()`** erzwungen
- keine automatische `location.reload()`-Kette bei `activate`/`controllerchange`
- „Jetzt aktualisieren“ setzt bewusst `SKIP_WAITING` und erlaubt genau einen Reload
- aktive Hauptansicht wird in `localStorage` behalten
- Local-IndexedDB und Server-Zugangsdaten werden von App-Updates nicht gelöscht

Für jede neue Release-Version müssen `APP_VERSION`/Cache-Name in `service-worker.js`, `config.json` und Release-Dokumentation gemeinsam erhöht werden.

## Verhalten bei Hosting-Ausfall

Die App führt bei Pages-Builds gelegentlich einen expliziten Netzwerkcheck aus. Ist Pages nicht erreichbar, zeigt sie dezent an, dass die lokal installierte Version verwendet wird. Es erfolgt keine automatische Umleitung zur Docker-Oberfläche. Ein manueller Docker-Fallback kann über `dockerWebUrl` konfiguriert werden.

## ZIP-Import und Deployment

Der Release-ZIP enthält bewusst **keine aktive `.github/`-Infrastruktur und keine `.gitignore`**. Diese Dateien gehören dem Repository und bleiben über Releases hinweg bestehen.

Der einmalig im Repository installierte Import-/Deploy-Workflow:

1. reagiert auf genau ein neu hinzugefügtes Root-`*.zip`,
2. validiert Pfade und typische Secret-Dateien,
3. lehnt aktive Workflow-Dateien im ZIP ab,
4. schützt `.github/`, `.gitignore` und `.git/` vollständig,
5. ersetzt nur die eigentlichen App-/Release-Dateien,
6. entfernt das ZIP,
7. committet/pusht die neue Repository-Version,
8. veröffentlicht GitHub Pages **im selben Workflow-Lauf**.

Das ist absichtlich so gebaut: Ein normales `GITHUB_TOKEN` soll keine Workflow-Dateien während eines Release-Imports ändern müssen. Der durch `GITHUB_TOKEN` erzeugte Commit muss außerdem keinen zweiten Push-Workflow auslösen, weil der Pages-Deploy direkt im laufenden Import-Workflow erfolgt.

Das ZIP repräsentiert direkt das Repository-Root; keine zusätzliche Ordnerhülle.

## GitHub Pages Einrichtung

Im Repository unter **Settings → Pages** als Source **GitHub Actions** verwenden. Danach kann ein neues Release-ZIP ins Root des Repositories hochgeladen werden; der Import-Workflow übernimmt den Rest.

## Bekannte Einschränkungen v6

- keine echte Offline-/Server-Synchronisationsengine
- keine Konfliktauflösung nach Feldversionen; Merge arbeitet über stabile IDs
- keine Barcode-/QR-Erfassung
- ein Hauptbild pro Bauteil; noch keine Bildergalerie oder Datenblattverwaltung
- keine externe Lieferantensuche
- iOS kann Website-Daten unter bestimmten Systembedingungen verwalten/löschen; regelmäßige lokale Backups bleiben wichtig

## v2 UI-Update

v2 richtet die iPhone-Oberfläche am freigegebenen Mockup-Stil aus: großer Header, Status-Badge, Statistik-Karten, visuelle Bauteilkarten, Projekt-Fortschritt, Bottom-Sheet-Formulare und gruppierte Setup-Karten. Das Datenmodell und Backupformat bleiben gegenüber v1 kompatibel.

### Release-ZIP, `.gitignore` und `.github/`

Release-ZIPs enthalten absichtlich **keine `.gitignore` und keine aktive `.github/`-Workflow-Infrastruktur**. Der Import-Workflow schließt beide Bereiche zusätzlich bei `rsync --delete` aus. Damit bleiben eigene Ignore-Regeln, Workflows und Repository-Einstellungen bei jedem App-Update unverändert.

Für ein bestehendes Repository muss der bestehende Import-/Deploy-Workflow **einmalig manuell** in `.github/workflows/` installiert bzw. der bisherige Import-Workflow ersetzt werden. Danach werden normale App-Releases nur noch als ZIP hochgeladen.

Für neue Repositories liegt `.gitignore.example` als Vorlage bei; die echte `.gitignore` wird bewusst nicht als Release-Datei ausgeliefert.


## UI-Feinschliff v5

v5 ersetzt die bisherigen Unicode-Platzhalter in der Oberfläche durch ein vollständig lokales SVG-Iconset. Navigation, Status, Setup, Aktionen und Bauteil-Platzhalter verwenden nun eine einheitliche abgerundete Linienoptik ohne externe CDN-Abhängigkeit.

## Bauteilbilder v6

v6 unterstützt ein optionales Hauptbild pro Bauteil. Auf iPhone stehen getrennte Aktionen für Kamera und Fotobibliothek zur Verfügung. Das Bild wird vor Speicherung clientseitig auf maximal 1600 px Kantenlänge skaliert und als JPEG neu erzeugt; dadurch werden typische EXIF-Metadaten nicht übernommen. Thumbnails erscheinen in Inventar-, Knapp- und Projektansichten.

Local Provider: Bild-Blob in IndexedDB `item_images`. Server Provider: Upload über `/api/items/<id>/image`; Cloudflare-Header werden wie bei anderen API-Aufrufen gesetzt. Bilder werden beim bewussten Local↔Server-Transfer mit übertragen.
