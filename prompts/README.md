# Prompts

Hier liegen die System-Prompts, die die Extension an das LLM schickt.

- **`init-system.txt`** – System-Prompt für "Brain initialisieren". Wird genutzt,
  wenn du ein Brain aus Character Card + Lorebook erzeugen lässt.
- **`update-system.txt`** – System-Prompt für "Brain updaten". Wird genutzt,
  wenn die Extension Chat-Fortschritt analysiert und Update-Vorschläge erzeugt.

## Warum zwei Dateien hier im Repo?

Damit deine Anpassungen zwischen PCs mit-wandern. Editier die Files, `git commit`,
`git push` — auf dem anderen PC einmal `git pull` (oder "Update" im ST-Extension-
Manager), und deine Änderungen sind dort.

## Editieren

1. Prompt-Datei in einem beliebigen Text-Editor öffnen (VS Code, Notepad++, …).
2. Änderungen speichern.
3. SillyTavern neu laden (F5) oder die Tab-Seite neu laden — die Extension
   cached den Prompt nach erstem Fetch, also zieht ein reload die neue Version.
4. Committen + pushen, sonst bleiben die Änderungen PC-lokal.

## Platzhalter

Der Init-Prompt kennt einen Platzhalter `{{LANG_RULE}}`, der zur Laufzeit durch
die Sprach-Direktive (abhängig vom Dropdown im Init-Popup) ersetzt wird. Lass ihn
stehen, sonst verliert die Sprach-Auswahl ihre Wirkung im systemPrompt. Die
doppelte Absicherung im userPrompt-Header bleibt aber bestehen.

## Fallback

Wenn eine Prompt-Datei fehlt oder leer ist, greift die Extension auf einen
in-Code Fallback zurück (siehe `src/initializer.js` → `DEFAULT_INIT_SYSTEM_PROMPT`
bzw. `src/updater.js` → `DEFAULT_UPDATE_SYSTEM_PROMPT`). Die Extension bricht
also nicht, auch wenn du die Files versehentlich löschst.

## Prompt zurücksetzen

Datei löschen + SillyTavern neu laden → in-Code-Fallback greift. Oder: File-
Inhalt durch den Default aus `src/initializer.js` / `src/updater.js` ersetzen.
