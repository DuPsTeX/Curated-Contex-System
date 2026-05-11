# Prompts

Hier liegen die System-Prompts, die die Extension an das LLM schickt.

- **`init-system.txt`** – System-Prompt für "Brain initialisieren". Wird genutzt,
  wenn du ein Brain aus Character Card + Lorebook erzeugen lässt.
- **`update-system.txt`** – System-Prompt für "Brain updaten". Wird genutzt,
  wenn die Extension Chat-Fortschritt analysiert und Update-Vorschläge erzeugt.
- **`director-system.txt`** – System-Prompt für den Director-Agenten. Wird genutzt,
  wenn der Director vor jeder Generierung die Szene analysiert und einen
  narrativen Brief für den Performer produziert.

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

## Fehlerbehandlung

Wenn eine Prompt-Datei fehlt oder leer ist, **bricht die Extension mit einer
Fehlermeldung ab**. Es gibt keinen stillschweigenden Fallback mehr — der Fehler
wird als Toast-Meldung angezeigt und enthält den Dateipfad, unter dem die
Extension die Datei erwartet.

## Prompt zurücksetzen

Datei-Inhalt durch den Default aus `src/initializer.js` / `src/updater.js`
ersetzen und SillyTavern neu laden.
