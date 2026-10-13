# Curated Context System (CCS)

**Status:** Alpha / Phase 5 (kompakte Zwei-Block-Injektion, Verdichten, Versionen, Hub-Editor)

SillyTavern-Extension für autor-kuratiertes Langzeitgedächtnis beim LLM-Roleplay. Der Autor kuriert ein *Living Document* (XML pro Chat); die Extension injiziert pro Turn deterministisch den relevanten Kontext.

## Features

- **Brain initialisieren** – erzeugt das XML-Brain aus Character Card + Lorebook-Quellen via LLM.
- **Brain updaten** – analysiert neue Chat-Messages in Blöcken (älteste zuerst, nichts geht verloren) und schlägt strukturierte Updates vor. Reviewbare Card-UI mit Checkbox pro Vorschlag, Inline-Edit, Referenz-Validation. Obergrenzen pro Kategorie, keine LLM-Pins.
- **Auto-Update** – alle N Nachrichten im Hintergrund; Vorschläge werden gesammelt zur Freigabe angeboten oder ohne Rückfrage übernommen.
- **Injektion** – kompakter Text statt XML, aufgeteilt in den stabilen Kanon (oben im Prompt) und die aktuelle Lage (nahe der letzten Nachricht). Statische Felder der Hauptfigur werden nicht doppelt zur Character Card geschickt. Relevanz über Name/Alias als ganzes Wort in den letzten N Nachrichten plus Szene.
- **Verdichten** – fasst ältere Chronik-Einträge zu Kapiteln zusammen und führt ältere Schlüsselmomente zusammen (mit Vorschau).
- **Versionen** – die letzten 8 Brain-Stände pro Chat, wiederherstellbar (auch nach Löschen).
- **Hub** – schwebendes Dashboard; jeder Eintrag per Klick bearbeitbar, „+“ legt neue an.
- **Director** (optional) – narrativer Brief vor jeder Generierung, wird bei Swipe/Regenerate wiederverwendet.
- **Pins** – Merkzettel des Autors, immer im Kontext.
- **Prompts anpassbar via Files** – siehe `prompts/` (wandert per git zwischen PCs).

Das Brain liegt pro Chat in den Chat-Metadaten (atomar, Branches bekommen eine eigene Kopie).

## Installation

Diesen Ordner nach `SillyTavern/public/scripts/extensions/third-party/` legen, SillyTavern neu laden, im Extensions-Panel aktivieren. Alternativ über den ST-Extensions-Manager direkt vom Repo installieren.

## Prompts customizen

Die System-Prompts für "Brain initialisieren" und "Brain updaten" liegen als Textdateien im Extension-Ordner:

- `prompts/init-system.txt` – Prompt für die Brain-Initialisierung
- `prompts/update-system.txt` – Prompt für Brain-Updates
- `prompts/director-system.txt` – Prompt für den Director
- `prompts/compact-system.txt` – Prompt fürs Verdichten
- `prompts/README.md` – Editier-Anleitung + Hinweise zum `{{LANG_RULE}}`-Platzhalter

Editieren, speichern, SillyTavern neu laden (F5). Änderungen wandern per `git push/pull` zwischen PCs mit. Fehlt/ist eine Datei leer, greift ein in-Code-Fallback — die Extension bricht nie.

## Konzept

Siehe `ccs-konzept.md`, `mvp-phase1-plan.md` und `mvp-phase2-plan.md` im übergeordneten Projektverzeichnis.
