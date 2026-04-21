# Curated Context System (CCS)

**Status:** Alpha / Phase 2 (Manueller Brain-Update-Flow + Prompt-Customizing)

SillyTavern-Extension für autor-kuratiertes Langzeitgedächtnis beim LLM-Roleplay. Der Autor kuriert ein *Living Document* (XML pro Chat); die Extension injiziert pro Turn deterministisch den relevanten Kontext.

## Features (Phase 2)

- **Brain initialisieren** – erzeugt das XML-Brain aus Character Card + Lorebook-Quellen via LLM.
- **Anzeigen / Bearbeiten** – Textarea-Editor mit Auto-Repair und Validation beim Speichern.
- **Brain updaten** – analysiert neue Chat-Messages, schlägt strukturierte Updates pro Kategorie vor (NPCs, Beziehungen, Orte, Key-Moments, Arc-Fortschritt, current_state, …). Reviewbare Card-UI mit Checkbox pro Proposal, Inline-Edit, Referenz-Validation. Cursor-basierte Idempotenz.
- **Löschen** – entfernt das Brain des aktuellen Chats.
- **Prompts anpassbar via Files** – siehe `prompts/` (wandert per git zwischen PCs).

Der Interceptor (Schicht 1 "Immer-Kern") injiziert das komplette Brain pro Gen-Call als `<authoritative_context>`-Envelope via `setExtensionPrompt`.

## Installation

Diesen Ordner nach `SillyTavern/public/scripts/extensions/third-party/` legen, SillyTavern neu laden, im Extensions-Panel aktivieren. Alternativ über den ST-Extensions-Manager direkt vom Repo installieren.

## Prompts customizen

Die System-Prompts für "Brain initialisieren" und "Brain updaten" liegen als Textdateien im Extension-Ordner:

- `prompts/init-system.txt` – Prompt für die Brain-Initialisierung
- `prompts/update-system.txt` – Prompt für Brain-Updates
- `prompts/README.md` – Editier-Anleitung + Hinweise zum `{{LANG_RULE}}`-Platzhalter

Editieren, speichern, SillyTavern neu laden (F5). Änderungen wandern per `git push/pull` zwischen PCs mit. Fehlt/ist eine Datei leer, greift ein in-Code-Fallback — die Extension bricht nie.

## Konzept

Siehe `ccs-konzept.md`, `mvp-phase1-plan.md` und `mvp-phase2-plan.md` im übergeordneten Projektverzeichnis.
