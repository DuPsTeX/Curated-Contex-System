# Curated Context System (CCS) – Claude-Code Arbeitsnotizen

## Was ist das?

SillyTavern third-party Extension für **autor-kuratiertes Langzeitgedächtnis** beim LLM-Roleplay. Statt dass die KI frei entscheidet, was sie sich merkt, pflegt der Autor ein *Living Document* (XML pro Chat) – strukturierte Wahrheit über Charaktere, Beziehungen, Orte, Arcs, Key-Moments. Ein zweistufiger LLM-Flow (Relevance-Call → Validierung → Generation-Call) kuriert pro Turn deterministisch den Kontext.

## Kernarchitektur

- **Living Document** – XML pro Chat, strukturierte Wahrheit (Charaktere, Beziehungen, Orte, Arcs, Key-Moments, World Rules, Pins)
- **Prompt Interceptor** (`generate_interceptor` in `manifest.json`) – der zentrale Hook, läuft *vor* jeder Generierung, darf async sein, ST wartet deterministisch.
- **Zweistufiger LLM-Flow** (ab Phase 2): Relevance-Call liefert Entity-Namen → Programm validiert gegen Living Document → Generation-Call mit kuratiertem Kontext.
- **Leitprinzipien:** Autor > KI, Deterministisch > Probabilistisch, Explizit > Implizit.

## Referenz-Dokumente

Liegen im Parent-Parent-Parent (neben der SillyTavern-Installation):
- `C:\AI\Claude_Projekte\ccs-konzept.md` – vollständige Architektur & Datenstrukturen
- `C:\AI\Claude_Projekte\mvp-phase1-plan.md` – 8-Schritte-Bauplan für Phase 1
- `C:\AI\Claude_Projekte\mvp-phase2-plan.md` – 8-Schritte-Bauplan für Phase 2

## Aktueller Stand

**Phase 1 komplett abgeschlossen (Schritte 1–8).**

Vorhanden:
- `manifest.json` mit `generate_interceptor: ccsInterceptor`
- `index.js` mit Settings-Persistenz, APP_READY-Bootstrap, CHAT_CHANGED-Listener, Interceptor-Stub, Init-/View-/Delete-Buttons, Quellen- & Sprach-Popup, Brain-Status-Anzeige, Toastr-Progress
- `settings.html` mit Enable-Toggle + Status + Brain-State-Row + 3 Action-Buttons
- `style.css` mit Status-Farben + Popup-/Language-Row-Styles
- `src/storage.js` – Living Document pro Chat via Attachments-API (`chat`-Scope, eine Datei `ccs-living-document.xml`)
- `src/collector.js` – sammelt Character-Card (V2) + 4 Lorebook-Quellen (character, chat, persona, global), dedupliziert über `${world}.${uid}`. Per Config einzeln abschaltbar.
- `src/initializer.js` – Initial-Brain-Generator: Collect → Prompt-Build (systemPrompt + userPrompt) → `ctx.generateRaw()` (isoliert, **nicht** `generateQuietPrompt`, weil der den Chat-Kontext mitschleppt) → `extractBrainXml()` → `repairBrainXml()` (fixt LLM-Tag-Mismatches wie `<appearance>…</core>`) → `validateBrainXml()` → `storage.saveLivingDocument()`. Sprache per Dropdown wählbar (Default: Deutsch).
- `src/interceptor.js` – Schicht 1 "Immer-Kern". Bei jedem normalen Gen-Call wird das komplette Brain-XML in einen `<authoritative_context>…</authoritative_context>`-Envelope gewrappt und per `ctx.setExtensionPrompt(SLOT_KEY, text, IN_PROMPT=0, depth=0, scan=false, role=SYSTEM)` injected. Clean-Slate-Invariante: jeder Call leert den Slot zuerst. Skip bei `type==='quiet'` (eigene Side-Calls wie Brain-Init würden sich sonst selbst injecten). Bei Fehlern: warn + clear + return – nie ST blocken.
- **Schritt 7: Brain-Editor.** Der "Anzeigen / Bearbeiten"-Button öffnet die Brain-XML in einem editierbaren Textarea-Popup. `onClosing`-Hook validiert beim Klick auf Speichern: Auto-Repair → `validateBrainXml` → bei Fehler Toast + Popup bleibt offen (Edits gehen nicht verloren). No-op wenn nichts geändert wurde. Neuer Stand wird via `storage.saveLivingDocument` persistiert; der Interceptor zieht ihn beim nächsten Gen-Call automatisch.

Browser-Konsolen-Handle:
- `ccs.storage.saveLivingDocument(xml)` / `.getLivingDocument()` / `.hasLivingDocument()` / `.clearLivingDocument()`
- `ccs.collector.collect({ character, chat, persona, global })` – alle default true
- `ccs.initializer.generateInitial({ character, chat, persona, global, lang })` – LLM-Call, lang optional (`''` = Auto, `'de'`, `'en'`, …)
- `ccs.interceptor.buildAlwaysCoreText(xml)` – pure wrap helper; `ccs.interceptor.clearSlot(ctx)` / `setSlot(ctx, text)` für manuelle Tests

### Schema des `<brain>`-XML (Phase 1)

Root `<brain version="1" lang="…">` mit diesen Containern:
- `<world_rules>` mit `<rule>…</rule>` – nur echte Welt/Magie/Physik/Gesellschaft-Regeln
- `<characters>` mit **genau einem** `<character name="…" role="main">` (SillyTavern's `{{char}}`)
  - 7 Pflichtfelder (nie leer): `<core>`, `<appearance>`, `<background>`, `<abilities>`, `<quirks>`, `<goals>`, `<speech_style>`
  - 3 optionale Felder (bleiben leer falls Quelle nichts sagt): `<stats>`, `<inventory>`, `<reputation>`
- `<locations>`, `<relationships>`, `<key_moments>`, `<arcs>`, `<scene>`, `<pinned>` – in Phase 1 immer leer, wachsen zur Laufzeit

**Invariant:** alle Tags IMMER präsent, auch wenn leer (`<tag></tag>`).

### Wichtige API-Entscheidungen

- **`generateRaw` statt `generateQuietPrompt`** – letzteres schickt den kompletten SillyTavern-Chat-Kontext (System-Prompt + Character Card + gesamte History) mit. `generateRaw` nimmt nur unsere zwei Messages (system + user), nichts anderes. Siehe `script.js:3854`.
- **Prompt ist zweigeteilt:** statische Rolle/Regeln/Few-Shot → `systemPrompt`; per-Call Daten (Character Card + Lorebook + Task) → `userPrompt`.
- **Sprach-Override-Anweisung** steht sowohl im `systemPrompt` (Rule 6) als auch als fetter Header am Anfang des `userPrompt` – doppelt hält besser.
- **Auto-Repair vor Validate** – `repairBrainXml()` korrigiert den häufigen LLM-Fehler, unterschiedliche Opening/Closing-Tags zu mischen. Deterministisch, nur für bekannte Single-Text-Felder.
- **Injection via `setExtensionPrompt` statt `chat`-Array-Mutation** – das ist der Weg, den die Core-Extensions (vectors, memory) gehen. ST mappt Position/Depth/Rolle für TC und CC selbst. Slot wird bei jedem Interceptor-Call, bei CHAT_CHANGED, bei Brain-Delete und bei Enable-Off explizit geleert, damit keine Zombies entstehen.

### Schritt 8: Robustheits-Pass

- **Vectors-Exklusion:** nach jedem `saveLivingDocument()` wird die Attachment-URL in `extension_settings.disabled_attachments` eingetragen (via interner `markAttachmentDisabled`-Helper in `storage.js`). Damit überspringt Vectors Auto-Indexing und Kontext-Inclusion unsere Datei automatisch. Der CCS-eigene Lesepfad (`getFileAttachment(url)`) funktioniert unabhängig vom Disabled-Flag weiter. Entfernt die letzte noch bekannte Beobachtung (Doppelinjection durch Vectors).
  - Nicht genutzt: `disableAttachment()` aus `chats.js` ist nicht exportiert (nur intern für UI-Buttons). Stattdessen direkte Manipulation der stabilen Single-Source-of-Truth-Liste + `saveSettingsDebounced()`.
- **Interceptor-Härtung:** `globalThis.ccsInterceptor` ist jetzt zweistufig geschützt. Innen hat `runAlwaysCore` ein eigenes try/catch (Slot-Clear als Fallback). Außen fängt der Entry-Point selbst ggf. Fehler aus `getContext()`/`getSettings()` ab. ST darf unter keinen Umständen durch uns blockiert werden.
- **Toast-Hygiene:** stackbare Meldungen ("Bitte zuerst einen Chat öffnen", "Kein Brain vorhanden", "Kein Brain zum Löschen") bekommen `preventDuplicates: true`, damit rasches Klicken keine Toast-Lawine auslöst.

### Explizit out-of-scope

- **Group-Chats:** vom User bewusst ausgeschlossen ("brauche ich wirklich nicht"). Kein spezielles Handling, keine Speech-Style-Zusammenführung, kein mehrfaches `<character role="main">`. Wenn Group-Chat getriggert wird, läuft der Interceptor normal – er injected das Brain des aktiven Chats, was auch im Gruppenkontext semantisch sauber ist, solange nur ein Haupt-Charakter modelliert wird.

## Phase 2 (manueller Brain-Update-Flow + Prompt-Customizing)

**Phase 2 komplett abgeschlossen (Schritte 1–8).** Der Code-Teil ist implementiert; die in Schritt 8 verlangten Manual-Tests (alle 7 Fehlerpfade aus Spec §8.1 + Brain-Migration-Szenario) laufen beim User lokal in SillyTavern.

### Neue Dateien

- `src/updater.js` (~1200 LOC) – der komplette Phase-2-Flow:
  - `slugify(text)` / `generateId(prefix, name, existingSet)` – deterministische, kollisionssichere IDs (Slugify + `-2/-3/…`-Suffix-Strategie, Cap 40 Zeichen).
  - `migrateLegacyBrain(xml)` – liest Phase-1-Brain (ohne IDs, ohne `<current_state>`) und schreibt beim ersten Update IDs + leere `<current_state>`-Felder hinein. Idempotent.
  - `DEFAULT_UPDATE_SYSTEM_PROMPT` – Englischer Archivist-Prompt, der strukturiertes JSON liefert (nicht XML!). Alle 11 Proposal-Kategorien plus `reasoning`.
  - `buildScanWindow(chat, lastAnalyzedMsgIndex)` – baut das Chat-Fenster seit letztem Cursor; Cap 30 Messages; Fallback auf letzte 20 wenn Cursor fehlt.
  - `extractJson(raw)` – zieht das erste JSON-Objekt aus der LLM-Antwort (tolerant gegen Code-Fences/Prefix-Text).
  - `validateProposals(json, migratedBrainXml)` – Referenz-Integrität: jede Proposal, die auf eine bestehende Entität referenziert (z.B. `target_id` in einer Key-Moment), wird gegen das Brain geprüft. Halluzinationen werden gedroppt (mit `reason: 'hallucination'`).
  - `runUpdate({ ctx, settings })` – orchestriert: Brain lesen → migrieren → Scan-Window bauen → `generateRaw()` → JSON extrahieren → proposals validieren. Gibt `{ proposals, dropped, shape_ok, reasoning, migratedBrainXml, cursorIndex, scanWindow, scanWindowEmpty, raw }` zurück.
  - `APPLY_FNS` – pro Kategorie eine Pure-Function, die das DOM-Document mutiert (`new_npc`, `new_location`, `new_relationship`, `new_key_moment`, `new_arc`, `update_current_state`, `update_arc_progress`, `update_appearance`, `update_speech_style`, `update_reputation`, `update_inventory`). Keine String-Manipulation.
  - `applyProposals(approved, migratedBrainXml, cursorIndex, settings)` – Fail-soft-Loop: jede approved Proposal läuft in eigenem try/catch. Am Ende: wenn mindestens eine erfolgreich war (oder *alle* Proposals gedroppt wurden und damit `applied === 0 && failed.length === 0` gilt → reiner Cursor-Save), wird `last_analyzed_msg_index` gesetzt und persistiert. Wenn `applied === 0 && failed.length > 0`, wird NICHT gespeichert (Brain bleibt unverändert, Cursor bleibt stehen).

- `src/popup.js` (~850 LOC) – reine DOM-basierte Card-UI:
  - `renderUpdatePopup({ proposals, migratedBrainXml, reasoning })` → `{ wrapper, collectApproved(), validate() }`.
  - Proposals gruppiert pro Kategorie in Sektionen, pro Proposal eine Card mit Checkbox + Titel + Feldern (Text-Input, Textarea, Select für Enum-Felder wie `role="npc"`, `arc_state`).
  - Textareas mit >200 Zeichen bekommen einen "Mehr anzeigen"-Toggle (Collapsible via `.ccs-collapsed`).
  - `validate()` ist synchron, gibt `{ ok, error?, focusEl? }`. Prüft Pflichtfelder (leer = rot markieren) + Referenzen (z.B. ob die von einer Key-Moment referenzierte NPC im Brain existiert oder neu approved ist).
  - `collectApproved()` liefert nur das, was aktuell gecheckt ist (mit aktuellen Edit-Werten aus den Feldern).

### Geänderte Dateien

- `index.js` – neuer `onUpdateClicked`-Handler: Pre-Checks → Progress-Toast → `runUpdate` → Fallunterscheidung (scanWindowEmpty → Info-Toast; shape_ok=false → Error; shape_ok=true + leer → Cursor-only-Save; shape_ok=true + Proposals → Popup). Nach User-Approval `applyProposals` mit 3-Fall-Summary-Toast (alles übernommen / teilweise / alles fehlgeschlagen). Zusätzlich: Prompt-Editor-Handlers für `#ccs-init-prompt` / `#ccs-update-prompt` mit 500 ms debounced Input-Save + Blur-Flush + Reset-auf-Default via Confirm-Popup.

- `settings.html` – neuer "Brain updaten"-Button in der Action-Leiste + Collapsible "Erweitert: Prompt-Vorlagen" mit zwei Textareas + Reset-Buttons + Hinweis zum `{{LANG_RULE}}`-Platzhalter.

- `style.css` – komplettes Styling für `.ccs-update-popup`, `.ccs-card-*`, `.ccs-field-*` (Pflichtfeld-Error-Highlighting in rot, disabled-Card bei unchecked-State) + `.ccs-prompt-editor` (monospace, `white-space: pre`, `min-height: 20em`, resize vertical).

- `src/initializer.js` – `DEFAULT_INIT_SYSTEM_PROMPT` als exportierte Konstante extrahiert. `buildInitialPrompt` akzeptiert `opts.systemPromptTemplate` und ersetzt `{{LANG_RULE}}` dynamisch. `generateInitial(config)` liest `settings.initSystemPrompt` aus `config.settings`. `onInitializeClicked` reicht `{ ...config, settings: getSettings() }` durch.

### Neue Settings-Felder mit Seed-Logik

`ccs.extensionSettings['curated-context-system']` enthält ab Phase 2:
- `enabled` (bool) – unverändert.
- `initSystemPrompt` (string) – Default wird beim ersten `getSettings()`-Zugriff aus `initializer.DEFAULT_INIT_SYSTEM_PROMPT` geseedet + via `saveSettingsDebounced()` persistiert. Bewusst NICHT in `DEFAULT_SETTINGS`, weil die Strings ~3KB groß sind und sonst jeder Spread sie neu allokieren würde. Check via `typeof === 'undefined'`, damit ein vom User explizit auf `''` geleerter Textarea NICHT wieder mit Default überschrieben wird.
- `updateSystemPrompt` (string) – analog, Default aus `updater.DEFAULT_UPDATE_SYSTEM_PROMPT`.

### Brain-Schema-Änderungen (Phase 2)

- **Root-Attribut `last_analyzed_msg_index`** auf `<brain>` – Cursor für Idempotenz. Wird bei jedem erfolgreichen `applyProposals`-Save geschrieben, auch bei Empty-Proposals-Cursor-only-Pfad. Bei shape_ok=false oder applied==0+failed>0 bleibt er stehen.
- **NPC-Rolle:** `<character role="npc">` zusätzlich zu `role="main"`. NPCs kommen ausschließlich via Update-Flow ins Brain (Init ignoriert Lorebook-NPCs).
- **Deterministische IDs** auf allen mehrwertigen Container-Elementen: `id="npc-lyra"`, `id="loc-ashen-village"`, `id="rel-lyra-kael"`, `id="km-first-meeting"`, `id="arc-redemption"`. Slugify + Kollisionssuffix.
- **`<current_state>`-Feld** pro Charakter (main UND npc). Bei Init immer leer. Wird per `update_current_state`-Proposal mutiert.

### Console-Handles (Phase 2)

Zusätzlich zu Phase 1 verfügbar über `window.ccs`:
- `ccs.updater.runUpdate({ ctx, settings })` – kompletter Update-Flow bis zum Popup-Input
- `ccs.updater.applyProposals(approved, migratedBrainXml, cursorIndex, settings)` – reiner Apply-Schritt (unit-testbar)
- `ccs.updater.migrateLegacyBrain(xml)` – Phase-1→Phase-2-Migration
- `ccs.updater.APPLY_FNS` – alle 11 Kategorie-Handler (pure DOM-mutators)
- `ccs.updater.validateProposals(json, migratedBrainXml)` – Referenz-Validation in Isolation
- `ccs.updater.extractJson(raw)` / `.buildScanWindow(chat, cursor)` / `.slugify(s)` / `.generateId(prefix, name, set)` – pure Helpers
- `ccs.popup.renderUpdatePopup({ proposals, migratedBrainXml, reasoning })` – Popup-Bau ohne Live-Daten (Test-Harness)

### Wichtige Design-Entscheidungen (Phase 2)

- **Cursor-basierte Idempotenz statt Hash-Tracking.** `last_analyzed_msg_index` ist der einzige State, der zwischen Update-Läufen bleiben muss. Rückwärts-"editierte" Messages werden als neu angesehen, was im Roleplay-Kontext okay ist (der Autor will dann typisch neue Proposals).
- **Fail-soft pro Proposal.** Eine kaputte Proposal (z.B. ID-Kollision mit bestehender Entity nach manueller User-Edit des Brains zwischen runUpdate und Apply) blockt die anderen nie. Alles wird protokolliert (`applyResult.failed[]` → Konsole).
- **Applied==0 && failed==0 → Save erlaubt.** Dieser Pfad ist der "Cursor-only-Save", wenn `shape_ok=true` aber das Array leer ist. Kein User-Input-Popup, nur Cursor nachziehen.
- **Applied==0 && failed>0 → KEIN Save.** Brain + Cursor bleiben stehen. Der Autor bekommt Error-Toast und kann entweder das Brain manuell reparieren oder den Update-Button erneut klicken.
- **Popup-Validation synchron.** `popupApi.validate()` ist synchron und deterministisch; kann im `onClosing`-Hook direkt ausgewertet werden. Fehler → `return false` → Popup bleibt offen mit rotem Highlighting + Focus-Fallback.
- **Prompt-Customizing über Seed-in-Settings.** User sieht beim ersten Öffnen den kompletten Default im Textarea (weil gerade geseedet), nicht ein leeres Feld mit Placeholder. Änderung wird nach 500 ms debounced oder sofort bei Blur gespeichert. Reset nur via Confirm-Popup (kein versehentlicher Datenverlust).
- **System-Prompts auf Englisch, UI auf Deutsch.** LLMs folgen strukturellen Anweisungen in Englisch zuverlässiger. UI-Strings und Code-Kommentare bleiben Deutsch.

## Coding-Guidelines

- **Karpathy-Stil:** Einfachheit, chirurgische Änderungen, keine spekulativen Features.
- **Ein Schritt = ein Prompt = ein Test.** Nie mehrere Schritte zusammenfassen, bevor der vorherige verifiziert ist.
- **Keine Unit-Tests in Phase 1.** Verifikation ist manuelles Testen in SillyTavern.
- **Fallbacks überall** (ab Schritt 8): Extension darf SillyTavern nie blocken.
- **Console-Logs:** alle mit Präfix `[CCS]`.
- **Sprache:** UI-Strings Deutsch (Default), Code-Kommentare Deutsch ok.
