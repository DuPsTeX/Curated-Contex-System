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

- `index.js` – neuer `onUpdateClicked`-Handler: Pre-Checks → Progress-Toast → `runUpdate` → Fallunterscheidung (scanWindowEmpty → Info-Toast; shape_ok=false → Error; shape_ok=true + leer → Cursor-only-Save; shape_ok=true + Proposals → Popup). Nach User-Approval `applyProposals` mit 3-Fall-Summary-Toast (alles übernommen / teilweise / alles fehlgeschlagen).

- `settings.html` – neuer "Brain updaten"-Button in der Action-Leiste + Hinweis-Box, die auf den `prompts/`-Ordner verweist (File-basierte Prompt-Anpassung).

- `style.css` – komplettes Styling für `.ccs-update-popup`, `.ccs-card-*`, `.ccs-field-*` (Pflichtfeld-Error-Highlighting in rot, disabled-Card bei unchecked-State).

- `src/initializer.js` – `DEFAULT_INIT_SYSTEM_PROMPT` als exportierte Konstante (nur noch in-Code-Fallback). `loadInitSystemPrompt()` fetcht `prompts/init-system.txt` via `import.meta.url`, cached module-scoped. `buildInitialPrompt` akzeptiert `opts.systemPromptTemplate` und ersetzt `{{LANG_RULE}}` dynamisch. `generateInitial(config)` ruft intern `loadInitSystemPrompt()` auf – keine Settings-Param-Kopplung mehr.

- `src/updater.js` – analog: `loadUpdateSystemPrompt()` fetcht `prompts/update-system.txt`, `runUpdate({ ctx })` (ohne `settings`) zieht den Prompt intern.

### File-basierte System-Prompts (statt Settings-Seed)

Die System-Prompts leben NICHT in `extensionSettings`, sondern als Dateien im Extension-Ordner:

- `prompts/init-system.txt` – Prompt für `initializer.generateInitial()`
- `prompts/update-system.txt` – Prompt für `updater.runUpdate()`
- `prompts/README.md` – Editier-Anleitung für User

**Warum files statt settings?** SillyTavern speichert `extensionSettings` pro User-Profil in einem ST-Data-Ordner außerhalb des Repos. Das heißt, Prompt-Edits wanderten früher nicht per `git push/pull` zwischen PCs mit. Mit Files im Repo sind sie Teil des Git-Zustands und synchronisieren sich sauber.

**Lade-Mechanismus:** `new URL('../prompts/...', import.meta.url)` + `fetch()` mit `cache: 'no-cache'`. Eine module-scoped Variable cached das Ergebnis pro Session (F5 bustet den Cache). Bei Fetch-Fehler (404, Netzwerk, leere Datei) greift der in-Code-Fallback (`DEFAULT_INIT_SYSTEM_PROMPT` bzw. `DEFAULT_UPDATE_SYSTEM_PROMPT`). Extension bricht nie, auch wenn Files fehlen.

**Settings-Feld:** ab dieser Version nur noch `enabled` (bool). Die alten Keys `initSystemPrompt` / `updateSystemPrompt` aus früheren Installs bleiben in `extensionSettings` liegen, werden aber ignoriert – sie stören nicht.

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
- **Prompt-Customizing über Files im Repo (statt Settings).** Ursprünglich waren die Prompts in `extensionSettings` geseedet, editierbar via Textarea im Panel. Problem: `extensionSettings` liegen außerhalb des Git-Repos, also wanderten Edits nicht zwischen PCs mit. Jetzt leben die Prompts als `prompts/*.txt` im Repo, werden per `fetch()` geladen und via in-Code-Fallback abgesichert. Editor-UI entfernt; User editieren die Files direkt im Text-Editor und reloaden SillyTavern.
- **System-Prompts auf Englisch, UI auf Deutsch.** LLMs folgen strukturellen Anweisungen in Englisch zuverlässiger. UI-Strings und Code-Kommentare bleiben Deutsch.

## Coding-Guidelines

- **Karpathy-Stil:** Einfachheit, chirurgische Änderungen, keine spekulativen Features.
- **Ein Schritt = ein Prompt = ein Test.** Nie mehrere Schritte zusammenfassen, bevor der vorherige verifiziert ist.
- **Keine Unit-Tests in Phase 1.** Verifikation ist manuelles Testen in SillyTavern.
- **Fallbacks überall** (ab Schritt 8): Extension darf SillyTavern nie blocken.
- **Console-Logs:** alle mit Präfix `[CCS]`.
- **Sprache:** UI-Strings Deutsch (Default), Code-Kommentare Deutsch ok.

## Phase 4: Robustheit + Auto-Update

- **Speicherung in `chat_metadata.ccs_brain`** statt Attachment (`src/storage.js`). Atomar, branch-sicher (Branch = eigene Kopie). Legacy-Attachments werden beim ersten Lesen migriert; die alte Datei wird nicht gelöscht (andere Branches können darauf zeigen), nur der Eintrag des aktuellen Chats. `saveLivingDocument(xml, expectedChatId)` bricht ab, wenn inzwischen ein anderer Chat aktiv ist.
- **Update in Blöcken:** `planScanWindow(chat, cursor)` liefert die ältesten max. 30 narrativen Messages ab dem Cursor + `lastIndex` + `remaining`. Der Cursor springt nur bis zum Blockende – vorher gingen bei >30 neuen Messages die älteren verloren. Ohne Cursor startet der Scan bei Message 0.
- **Interceptor nutzt das `chat`-Argument** (nicht `ctx.chat`): beim Swipe fehlt dort die ersetzte Nachricht. Achtung: ST übergibt **flache Kopien** der Messages (`{...chatItem, mes: regexed}`), Objekt-Identität mit `ctx.chat` gibt es nicht. `trimChatToMax` ordnet deshalb per Position (gleicher Filter wie ST) + `send_date` zu.
- **Max Chat-Nachrichten** kappt nur Messages mit Index <= Cursor (schon im Brain); ohne Cursor wird nichts gekappt.
- **Auto-Update** (`autoUpdateEnabled`, `autoUpdateEvery`, `autoUpdateAccept`): nach `MESSAGE_RECEIVED` (entprellt) wird geprüft, ob genug unanalysierte Messages da sind; die 2 jüngsten werden zurückgehalten (Swipe/Edit). Ergebnis landet als `pendingUpdate` (Badge + Toast) oder wird bei „ohne Rückfrage“ über die unsichtbar gerenderte Popup-Logik (gleiche IDs/Validierung) direkt übernommen. Apply läuft immer auf dem **aktuellen** Brain (Pins/Edits zwischendurch bleiben erhalten); hat sich der Cursor verändert, wird das Ergebnis verworfen.
- **Reasoning-Modelle:** Update-Budget 16000 Tokens – DeepSeek hat 6000 komplett fürs Nachdenken verbraucht (`No message generated`).

## Phase 5: Injektion, Verdichten, Versionen, Hub-Editor

- **`src/render.js`**: `selectRelevant` (Name/Alias als ganzes Wort, Unicode, Endungen -s/-es/-n/-en/'s; Szene-Anwesende + Szene-Ort immer) und `renderCompact` → `{ core, state }` als kompakter Text. Statische Hauptfigur-Felder entfallen bei `dedupeCard`, außer sie tragen `updated="1"` (gesetzt von `character_field_updates` und vom Hub-Editor).
- **Injektion**: `CCS_CORE` IN_PROMPT (Kanon), `CCS_STATE` IN_CHAT @ `stateDepth` (Szene, Zustände, Pins, 2 jüngste Chronik-Einträge). `<image>` (Base64) wird nie injiziert oder ans Update-LLM geschickt. Gemessen am Test-Brain: ~50 % weniger Zeichen.
- **`src/cursor.js`**: Cursor zusätzlich über `last_analyzed_send_date` verankert (ST-`send_date` ist ein ISO-Zeitstempel); `resolveCursor` findet die Nachricht nach Löschungen wieder.
- **Update**: `buildUpdateBrain` zeigt dem LLM nur die 6 jüngsten Key-Moments / 3 History-Einträge (`older_entries_omitted`), `capProposals` begrenzt pro Kategorie, `new_pins` = 0 (Pins nur vom Autor). Aliase für Figuren und Orte.
- **`src/compactor.js`**: ältere History → Kapitel (`kind="chapter"`), ältere Key-Moments konsolidiert; jüngste 3/5 bleiben. Bricht ab, wenn das LLM keine Kapitel liefert oder kritische Momente verwirft.
- **Versionen** (`storage.js`): `ccs_brain_versions` (max. 8, neueste zuerst) + `ccs_brain_label` für den aktuellen Stand. Löschen und Wiederherstellen sind selbst rückgängig machbar.
- **`src/editor.js`**: generischer Formular-Editor (Typen in `TYPES`), speichert immer auf dem frisch gelesenen Brain. Figurennamen und Beziehungs-Enden sind beim Bearbeiten gesperrt (Referenzen). Hub feuert `ccs:brain-changed` → index.js aktualisiert Pins/Status.
- **Director**: Brief wird per Schlüssel (Chat + letzte Nachricht) gecacht und bei Swipe/Regenerate wiederverwendet; bei Continue/Impersonate kein Director.

## Phase 6: Status-Sync, Wächter, Bedeutungs-Suche, Fäden

- **`src/status.js`**: `parseStatus` liest Kopfzeilen (`**Ort — Region**`, `**Tag · Zeit · ARC …**`) und Charakterblätter zwischen `═`-Linien (tolerant: Attribute ein- oder mehrzeilig, Rechenwege bei HP/MP). `applyStatusToBrain` schreibt Szene (inkl. `<chapter>`), `<stats>`/`<inventory>` und ergänzt Aliase aus „X (alias Y)“; Teilblöcke werden über das JSON-Attribut `status` am Charakter mit dem alten Stand zusammengeführt. Unbekannte Figuren werden nicht angelegt. Aufeinanderfolgende Saves mit Label `Status-Sync` erzeugen keine neue Version.
- **`src/guard.js`**: nach `CHARACTER_MESSAGE_RENDERED` LLM-Check (Kanon + jüngster Chat + Antwort ohne Statusfenster) → JSON `issues` (hard/soft; Zitat nicht auffindbar → soft). Modus `fix`: Umschreiben nur der Stellen, Plausibilitätsprüfung (Länge 0,6–1,5×), Ergebnis als neuer Swipe (`swipes`/`swipe_info`), Original bleibt; Record in `extra.ccs_guard` pro Swipe. `whenIdle()` lässt die nächste normale Generierung auf eine laufende Prüfung warten; während Swipe/Regenerate derselben Nachricht wird nicht eingesetzt.
- **`src/semantic.js`**: ST-Vektor-API (`/api/vector/list|insert|delete|query|purge`, Quelle `transformers`), Sammlung `ccs_<hash(chatId)>`, Einträge = Key-Moments + Chronik, Hash = djb2(`id|text`). Treffer (`forceIds`) erzwingen Key-Moments im Filter; mit aktiver Suche bleiben von der Chronik nur Kapitel, Treffer und die 3 jüngsten Einträge. Embedding-Modell kommt aus `config.yaml` (wird nur beim Serverstart gelesen).
- **Fäden-Register**: `<thread since="…" touched="…">` (Chat-Index). Update-JSON `threads_advanced` (exakter Text) → `touched`; neue/ungestempelte Fäden bekommen `since` beim nächsten Apply; Arc-Thread-Ersatz und Hub-Editor behalten die Stempel. `renderCompact({ chatLength, threadAge })` zeigt die zwei ältesten liegengebliebenen Fäden aktiver Arcs in der aktuellen Lage.

## Phase 7: Aktivierungs-Gedächtnis

- **`src/activation.js`** (Prinzip: Leaky-Integrate-and-Fire-Netz, vgl. fly-brain): Knoten = Figuren, Orte, Key-Moments, Beziehungen, Arcs, Chronik; Kanten aus `who`/`where`/Nennungen/`involved`/`from`-`to`. Reize: Nennungen (Name/Alias) in den letzten `relevanceWindow` Nachrichten mit Gewicht `activationDecay^Alter`, Anwesende, Szenen-Ort, Hauptfigur, Semantik-Treffer (0,8). Kombination gesättigt `1-(1-a)(1-b)`; Ausbreitung 2 Schritte, `spread·w·a/√Grad` (Hauptfigur flutet nicht). Schwellen: Figur/Ort 0,3, Moment/Chronik 0,25; Momente + Wichtigkeits-Bonus. `explain()` liefert die Kette für den Hub.
- **Filter** (`interceptor.filterBrainByRelevance`): nutzt nur noch die Aktivierung (`opts.messages` einzeln, älteste zuerst). Immer: Weltregeln, Hauptfigur, Szene, Pins, aktive Arcs, Chronik-Kapitel + 3 jüngste Einträge. Behaltene Momente/Chronik tragen `act`; `trimToBudget` kürzt die schwächsten zuerst. `render.selectRelevant` entfernt.
- **Stummschalten**: `silenced="1"` an Figur (nicht Hauptfigur), Ort, Beziehung, Moment, Arc, Chronik, Weltregel – nie im Kontext, nicht im Semantik-Index, im Hub ausgegraut. Der Editor warnt, wenn ähnlicher Inhalt (≥ 40 % gemeinsame Wörter) noch in anderen Einträgen steht. Charakter-Felder, Fäden und Statusfenster der KI-Antwort werden davon nicht erfasst.
