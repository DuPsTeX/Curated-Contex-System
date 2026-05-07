// Updater: Phase-2-Kern. Baut Update-Vorschläge aus dem Chat-Fortschritt,
// kuratiert sie durch ein Popup und patcht das Living Document deterministisch.
//
// Schritt 1: Basis-Infrastruktur. Deterministische Slug/ID-Helfer und
// die Brain-Migration (Phase-1 → Phase-2: IDs nachtragen, <current_state>
// auffüllen).
//
// Schritt 2: LLM-Call-Pfad. Scan-Window aus dem Chat, System-/User-Prompt,
// Fence-Stripper für die Antwort, Shape-/Referenz-Validator der Proposals,
// `runUpdate`-Orchestrator bis einschließlich Validator (ohne Popup/Apply).
//
// Referenz: docs/superpowers/specs/2026-04-19-ccs-phase2-state-update-design.md
//           §3.4 (Schema), §5 (Proposals), §9 (Prompt), §4 (Datenfluss)
//
// Leitprinzip: chirurgische DOM-Mutation via DOMParser + XMLSerializer.
// String-Manipulation ist tabu – zu fragil bei beliebig formatiertem XML.

import * as storage from './storage.js';
import { validateBrainXml } from './initializer.js';

const LOG_PREFIX = '[CCS]';

// Slugify-Cap – 40 Zeichen reichen für alle sinnvollen Seeds (Namen, Titel,
// Key-Moment-Summaries). Größer wird unhandlich in Tools, kleiner verliert
// Unterscheidungskraft bei langen Namen.
const SLUG_MAX = 40;

/**
 * Normalisiert einen Freitext-String zu einem ASCII-Lowercase-Snake-Slug.
 * NFD-Zerlegung strippt Diakritika (ä → a, é → e), alle Nicht-alnum-Zeichen
 * werden zu `_`, führende/trailing `_` entfernt, gekappt auf SLUG_MAX.
 *
 * Deterministisch und idempotent (`slugify(slugify(x)) === slugify(x)`).
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
    if (typeof text !== 'string') return '';
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, SLUG_MAX);
}

/**
 * Generiert eine stabile ID `{prefix}_{slug(seed)}` und löst Kollisionen gegen
 * `existingIds` mit Suffix `_2`, `_3`, … . `existingIds` wird by-reference
 * um die vergebene ID erweitert, damit der Aufrufer die Kollisions-Kette
 * über mehrere Aufrufe hält.
 *
 * Beispiel:
 *   const ids = new Set(['loc_taverne']);
 *   generateId('loc', 'Taverne', ids) → 'loc_taverne_2'
 *   generateId('loc', 'Taverne', ids) → 'loc_taverne_3'
 *
 * @param {string} prefix – z.B. 'char', 'loc', 'rel', 'km', 'arc', 'pin'
 * @param {string} seed – Freitext (Name, Summary, etc.)
 * @param {Set<string>} existingIds – mutierbare Set-Instanz
 * @returns {string}
 */
export function generateId(prefix, seed, existingIds) {
    const slug = slugify(seed) || 'unnamed';
    const base = `${prefix}_${slug}`;
    let id = base;
    let i = 2;
    while (existingIds.has(id)) {
        id = `${base}_${i++}`;
    }
    existingIds.add(id);
    return id;
}

/**
 * Sammelt alle bereits vergebenen IDs aus dem übergebenen DOM.
 * @param {Document} doc
 * @returns {Set<string>}
 */
function collectExistingIds(doc) {
    const ids = new Set();
    // Wir schauen nur auf Elemente, die wir auch migrations-/update-seitig mit IDs versehen.
    const selector = 'character[id], location[id], relationship[id], key_moment[id], arc[id], pin[id]';
    for (const el of doc.querySelectorAll(selector)) {
        const id = el.getAttribute('id');
        if (id) ids.add(id);
    }
    return ids;
}

/**
 * Hängt ein leeres Kind-Element vor `</parent>` an, falls es noch nicht existiert.
 * Markiert, ob tatsächlich etwas hinzugefügt wurde (für Logging/Idempotenz-Checks).
 *
 * @param {Element} parent
 * @param {string} tagName
 * @param {Document} doc
 * @returns {boolean} true wenn appended, false wenn schon da
 */
function ensureChild(parent, tagName, doc) {
    if (parent.querySelector(`:scope > ${tagName}`)) return false;
    const el = doc.createElement(tagName);
    parent.appendChild(el);
    return true;
}

/**
 * Formatiert XML mit Einrückung (2 Leerzeichen pro Ebene).
 * XMLSerializer.serializeToString() liefert minimiertes XML ohne Zeilenumbrüche.
 * Diese Funktion parsed das XML und gibt es formatiert zurück.
 * @param {string} xml
 * @returns {string}
 */
export function prettyPrintXml(xml) {
    if (typeof xml !== 'string' || !xml.trim()) return xml;

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return xml;

    const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    function walk(node, depth) {
        const parts = [];
        const indent = '  '.repeat(depth);

        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text) parts.push(escapeText(text));
            return parts;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.nodeName;
            const attrs = node.attributes && node.attributes.length
                ? ' ' + [...node.attributes].map(a => `${a.name}="${escapeAttr(a.value)}"`).join(' ')
                : '';

            const children = [];
            for (const child of node.childNodes) {
                if (child.nodeType === Node.ELEMENT_NODE) {
                    children.push(child);
                } else if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
                    children.push(child);
                }
            }

            if (children.length === 0) {
                parts.push(`${indent}<${tag}${attrs}></${tag}>`);
            } else if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE) {
                parts.push(`${indent}<${tag}${attrs}>${escapeText(children[0].textContent.trim())}</${tag}>`);
            } else {
                parts.push(`${indent}<${tag}${attrs}>`);
                for (const child of children) {
                    parts.push(...walk(child, depth + 1));
                }
                parts.push(`${indent}</${tag}>`);
            }
        }

        return parts;
    }

    return walk(doc.documentElement, 0).join('\n');
}

/**
 * Idempotente Brain-Migration Phase 1 → Phase 2:
 *  - Vergibt fehlende `id`-Attribute an <character>, <location>, <relationship>,
 *    <key_moment>, <arc>, <pin> (deterministisch aus Name/Summary/Text).
 *  - Hängt an jeden <character> ein leeres <current_state></current_state>, falls
 *    noch nicht vorhanden.
 *
 * Kollisionen werden mit Suffix `_2`, `_3`, … aufgelöst (innerhalb desselben
 * Laufs). Beim zweiten Aufruf auf einem bereits migrierten Brain findet die
 * Funktion nichts zu tun und liefert semantisch identisches XML zurück.
 *
 * Mutiert KEIN persistiertes Brain – Arbeitsbasis ist ein in-memory-Dokument,
 * der Aufrufer entscheidet, ob das Ergebnis gespeichert wird.
 *
 * @param {string} xmlString
 * @returns {{ xml: string, stats: { idsAssigned: number, currentStatesAdded: number } }}
 */
export function migrateLegacyBrain(xmlString) {
    if (typeof xmlString !== 'string' || !xmlString.length) {
        throw new TypeError('migrateLegacyBrain expects a non-empty XML string');
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        throw new Error(`Brain XML unparseable: ${parseError.textContent?.slice(0, 200)}`);
    }
    if (!doc.documentElement || doc.documentElement.nodeName !== 'brain') {
        throw new Error(`Root element is not <brain> (got <${doc.documentElement?.nodeName}>)`);
    }

    const existingIds = collectExistingIds(doc);
    let idsAssigned = 0;
    let currentStatesAdded = 0;

    // --- Characters: id + current_state -----------------------------------------
    for (const ch of doc.querySelectorAll('characters > character')) {
        if (!ch.hasAttribute('id')) {
            const name = ch.getAttribute('name') || 'unnamed';
            ch.setAttribute('id', generateId('char', name, existingIds));
            idsAssigned++;
        }
        if (ensureChild(ch, 'current_state', doc)) {
            currentStatesAdded++;
        }
    }

    // --- Locations -------------------------------------------------------------
    for (const loc of doc.querySelectorAll('locations > location')) {
        if (!loc.hasAttribute('id')) {
            const name = loc.getAttribute('name') || 'unnamed';
            loc.setAttribute('id', generateId('loc', name, existingIds));
            idsAssigned++;
        }
    }

    // --- Relationships ---------------------------------------------------------
    for (const rel of doc.querySelectorAll('relationships > relationship')) {
        if (!rel.hasAttribute('id')) {
            const from = rel.getAttribute('from') || 'x';
            const to = rel.getAttribute('to') || 'y';
            rel.setAttribute('id', generateId('rel', `${from}_${to}`, existingIds));
            idsAssigned++;
        }
    }

    // --- Key-Moments -----------------------------------------------------------
    for (const km of doc.querySelectorAll('key_moments > key_moment')) {
        if (!km.hasAttribute('id')) {
            const summary = km.querySelector(':scope > summary')?.textContent?.trim() || 'moment';
            km.setAttribute('id', generateId('km', summary.slice(0, SLUG_MAX), existingIds));
            idsAssigned++;
        }
    }

    // --- Arcs ------------------------------------------------------------------
    for (const arc of doc.querySelectorAll('arcs > arc')) {
        if (!arc.hasAttribute('id')) {
            const title = arc.querySelector(':scope > title')?.textContent?.trim() || 'arc';
            arc.setAttribute('id', generateId('arc', title, existingIds));
            idsAssigned++;
        }
    }

    // --- Pins ------------------------------------------------------------------
    for (const pin of doc.querySelectorAll('pinned > pin')) {
        if (!pin.hasAttribute('id')) {
            const text = pin.textContent?.trim() || 'pin';
            pin.setAttribute('id', generateId('pin', text, existingIds));
            idsAssigned++;
        }
    }

    const xml = prettyPrintXml(new XMLSerializer().serializeToString(doc));
    if (idsAssigned > 0 || currentStatesAdded > 0) {
        console.log(
            `${LOG_PREFIX} migrateLegacyBrain: assigned ${idsAssigned} IDs, added ${currentStatesAdded} <current_state> nodes`,
        );
    }
    return {
        xml,
        stats: { idsAssigned, currentStatesAdded },
    };
}

// =============================================================================
// Schritt 2: LLM-Call-Pfad
// =============================================================================

// Caps & Konstanten laut Spec §4 / §9.4.
const SCAN_WINDOW_MAX = 30;
const SCAN_WINDOW_FALLBACK = 20;   // wenn kein Cursor gesetzt ist
const UPDATE_RESPONSE_LENGTH = 6000;

/**
 * Referenz-Kopie des Update-System-Prompts. Dient nur als Dokumentation und
 * zur manuellen Wiederherstellung. Zur Laufzeit wird der Prompt AUSSCHLIESSLICH
 * aus `prompts/update-system.txt` geladen – fehlt die Datei, bricht die
 * Generierung mit einem Fehler ab, statt still auf diesen Default zu fallen.
 *
 * Wichtig: *kein* Markdown-Fence-Output erlaubt – wir strippen zwar in
 * `extractJson`, aber je weniger das LLM hineinschreibt, desto robuster.
 */
export const DEFAULT_UPDATE_SYSTEM_PROMPT = `You are an archivist assistant for a narrative roleplay memory system.
Your job: analyze recent roleplay messages and propose structured updates
to a "Living Document" (a curated canon in XML).

# Your output format
Return ONLY one valid JSON object. No prose, no markdown fences, no
explanation outside the JSON.

# Schema
{
  "reasoning": "1–3 sentences explaining why these proposals",
  "new_key_moments":         [ { when, where, who[], summary, importance, verbatim?, tags?[], impact? } ],
  "new_locations":           [ { name, description, atmosphere?, events_here?[] } ],
  "new_characters":          [ { name, core, appearance?, quirks?, background?, aliases?[] } ],
  "character_field_updates": [ { character, field, new, reason? } ],
  "new_relationships":       [ { from, to, current, from_current?, history?[], key_moments?[] } ],
  "relationship_updates":    [ { from, to, delta, reason, new_current? } ],
  "new_arcs":                [ { title, tension, open_threads?[], growth_opportunities? } ],
  "arc_updates":             [ { id, change_type, new_value, reason? } ],
  "scene_update":            { location, present[], time?, mood?, active_tension? } | null,
  "new_world_rules":         [ "string", … ],
  "new_pins":                [ "string", … ],
  "new_history_entries":     [ { summary, scene?, tags?[], key_outcome?, involved?[] } ]
}
Any array may be []. scene_update may be null. reasoning MUST be present.
- new_history_entries.summary is a 1-3 sentence summary of a concluded scene or narrative block.
- new_history_entries.scene is an optional scene/chapter name.
- new_history_entries.tags are 2-5 keywords for filtering.
- new_history_entries.key_outcome is an optional 1-sentence result.
- new_history_entries.involved are optional character names.

# Enums
- importance: low | medium | high | critical
- character_field_updates.field: core | appearance | background | abilities | quirks | goals | speech_style | stats | inventory | reputation | current_state
  (NEVER: name, id, role)
- arc_updates.change_type: status | threads | growth_opportunities
  * status → new_value is a string ∈ {active, resolved, abandoned}
  * threads → new_value is an array of strings (replaces <open_threads> fully)
  * growth_opportunities → new_value is a string

# Core rules (absolute)
1. Be CONSERVATIVE. Only propose what is clearly NEW or clearly CHANGED.
   If in doubt, omit. Not every chat message needs a key_moment.
2. When referencing existing entities (character_field_updates.character,
   relationship_updates.{from,to}, arc_updates.id, scene_update.present[]),
   use the EXACT name/id from the <brain_current>. Do not invent or paraphrase.
3. Character evolution → prefer character_field_updates on field="current_state".
   core = static personality; current_state = dynamic mood/stance/trust-level.
4. Key-Moments: only for narratively significant beats.
5. World rules: only if EXPLICITLY stated in the chat. No inference from
   atmosphere or behavior.
6. Scene update: only if location/present/mood actually changed in the window.
7. Language: match the brain root's @lang attribute. String contents in the
   language of the brain; JSON keys and enum values stay English.
8. History entries: propose a new_history_entry when a narrative block (scene,
   chapter, or significant sequence) concluded in the scan window. Summarize
   what happened, not every message. Propose even for smaller blocks (3+ messages
   of substance). A history entry is a compressed chronicle, NOT a key_moment
    (which captures a single pivotal beat).
9. Relationships are BIDIRECTIONAL. When you propose a new relationship from→to
   with `current` describing from's view of to, also provide `from_current`
   describing to's view of from (the reverse direction). If the scan window shows
   nothing about the reverse, leave `from_current` empty – the reverse will be
   auto-created as a placeholder.

# Few-Shot example
<brain_current>
  <brain version="1" lang="de" last_analyzed_msg_index="5">
    <characters>
      <character name="Aria" role="main">
        <core>misstrauisch, sarkastisch</core>
        <current_state></current_state>
      </character>
    </characters>
    <locations></locations>
    <key_moments></key_moments>
  </brain>
</brain_current>
<chat_since_last_update>
  User: "Ich trete die Tür der Taverne auf."
  AI: "Aria blickt überrascht auf. 'Kael? Du hast den Mut, hier aufzutauchen?'"
  User: "Ich lege das Medaillon auf den Tisch."
  AI: "Aria starrt darauf. Sie sagt nichts. Aber sie nimmt es."
</chat_since_last_update>
<task>Propose structured brain updates.</task>

{
  "reasoning": "Neuer Ort (Taverne) erstmals etabliert. Kael erscheint als NPC. Zentraler Moment: Medaillon-Rückgabe verändert Arias Haltung.",
  "new_locations": [{ "name": "Taverne", "description": "Holz, rauchig, wenig Licht.", "atmosphere": "angespannt" }],
  "new_characters": [{ "name": "Kael", "core": "reumütig", "background": "hat Aria zuvor verraten" }],
  "new_key_moments": [{ "when": "gerade eben", "where": "Taverne", "who": ["Aria","Kael"],
      "summary": "Kael gibt Aria das Medaillon zurück, sie nimmt es wortlos an.",
      "importance": "high" }],
  "character_field_updates": [{ "character": "Aria", "field": "current_state",
      "new": "beginnt, Kael wieder eine Chance zu geben",
      "reason": "Sie nimmt das Medaillon wortlos." }],
  "scene_update": { "location": "Taverne", "present": ["Aria","Kael"], "mood": "angespannt, leise" },
  "new_relationships": [
    { "from": "Aria", "to": "Kael", "current": "beginnt, Kael wieder eine Chance zu geben", "from_current": "Kael ist reumütig und hofft auf Vergebung" }
  ],
  "relationship_updates": [],
  "new_arcs": [],
  "arc_updates": [],
  "new_world_rules": [],
  "new_pins": [],
  "new_history_entries": [
    { "summary": "Kael taucht unerwartet in der Taverne auf und gibt Aria das Medaillon zurück.", "scene": "Rückkehr", "tags": ["Kael", "Aria", "Medaillon"], "key_outcome": "Aria beginnt Kael wieder zu vertrauen.", "involved": ["Aria", "Kael"] }
  ]
}
`;

/**
 * Cache für das aus `prompts/update-system.txt` geladene Template. Beim ersten
 * Call wird gefetcht; danach in-memory wiederverwendet. Null = noch nicht geladen.
 */
let _cachedUpdatePromptTemplate = null;

/**
 * Lädt den Update-System-Prompt aus `prompts/update-system.txt` (Extension-Root).
 * Source of Truth wandert per `git push/pull` zwischen PCs. Bei Fetch-Fehler
 * (404 / Netzwerk / leere Datei) → in-Code-Fallback `DEFAULT_UPDATE_SYSTEM_PROMPT`.
 *
 * Siehe auch `initializer.loadInitSystemPrompt()` – gleiche Mechanik. Cache
 * invalidiert erst bei SillyTavern-Reload (F5), damit wir pro Session nur einmal
 * fetchen.
 *
 * @returns {Promise<string>} – das Template (getrimmt)
 */
export async function loadUpdateSystemPrompt() {
    if (typeof _cachedUpdatePromptTemplate === 'string') return _cachedUpdatePromptTemplate;
    const url = new URL('../prompts/update-system.txt', import.meta.url);
    const res = await fetch(url.href, { cache: 'no-cache' });
    if (!res.ok) {
        throw new Error(`Konnte prompts/update-system.txt nicht laden (HTTP ${res.status}). Prüfe, ob die Datei im Extension-Ordner unter dem Verzeichnis prompts/ vorhanden ist. URL: ${url.href}`);
    }
    const text = (await res.text()).trim();
    if (!text) {
        throw new Error(`prompts/update-system.txt ist leer. Die Datei muss einen gültigen System-Prompt enthalten. Pfad: ${url.href}`);
    }
    _cachedUpdatePromptTemplate = text;
    console.log(`${LOG_PREFIX} loaded update prompt from file (${text.length} chars)`);
    return text;
}

/**
 * Baut das Scan-Window laut Spec §4:
 *   • wenn `cursor` eine gültige Zahl ist → `chat.slice(cursor+1)`
 *   • sonst (NaN / fehlt) → letzte `SCAN_WINDOW_FALLBACK` Messages
 *   • System-Messages (`is_system === true` – SillyTavern-Flag für
 *     impersonate/quiet/narrator) herausgefiltert
 *   • am Ende auf die letzten `SCAN_WINDOW_MAX` Messages gecappt
 *
 * @param {object} ctx – SillyTavern-Context (wir lesen `ctx.chat`)
 * @param {number} cursor – 0-basierter Message-Index oder NaN
 * @returns {Array} Flache Kopie der relevanten Messages
 */
export function buildScanWindow(ctx, cursor) {
    if (!ctx || !Array.isArray(ctx.chat)) return [];
    const chat = ctx.chat;

    const usingCursor = Number.isFinite(cursor) && cursor >= -1;
    const slice = usingCursor ? chat.slice(cursor + 1) : chat.slice(-SCAN_WINDOW_FALLBACK);

    // is_system filtert unsere eigenen stillen Calls (Quiet/Impersonate) ebenso aus
    // wie Narrator/Toast-artige Einträge. Narrative User/AI-Messages bleiben übrig.
    const filtered = slice.filter(m => m && m.is_system !== true);

    // Letzte SCAN_WINDOW_MAX behalten – hintere Seite ist immer relevanter als vordere.
    return filtered.slice(-SCAN_WINDOW_MAX);
}

/**
 * Extrahiert genau ein JSON-Objekt aus einer rohen LLM-Antwort.
 * 1. Trim + optionales Markdown-Fence-Strip (```json … ``` oder ``` … ```).
 * 2. Balance-Matching: ersten `{` finden, Klammer-Counter hochzählen,
 *    String-Literale dabei ignorieren (inkl. Escapes), erstes `}` auf Tiefe 0
 *    schließt das Objekt.
 * Liefert den JSON-Text (String). Rufer muss noch `JSON.parse` aufrufen.
 *
 * @param {string} raw
 * @returns {string}
 */
export function extractJson(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();

    // Fence-Strip: greedy, wir akzeptieren auch unterschiedliche Case-Varianten.
    const fence = s.match(/^```(?:[a-zA-Z]+)?\s*\n?([\s\S]*?)\n?```\s*$/);
    if (fence) s = fence[1].trim();

    const start = s.indexOf('{');
    if (start < 0) return '';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (esc) { esc = false; continue; }
        if (inStr) {
            if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    // Unbalanced – gib alles ab dem ersten `{` zurück, JSON.parse wird werfen.
    return s.slice(start);
}

/**
 * Baut den userPrompt pro Update-Call (Spec §9.3). Das Brain muss bereits
 * migriert sein (IDs + current_state vorhanden), damit das LLM stabile
 * Referenzen sieht. `langOverride` kommt üblicherweise aus dem
 * `@lang`-Attribut des Brains und dient als expliziter Hinweis.
 */
function buildUpdateUserPrompt({ systemPrompt, brainXml, scanWindow, langOverride, capped }) {
    const lines = [];
    lines.push('====== CCS ARCHIVIST MODE – UPDATE ======', '',
        'YOU ARE AN ARCHIVIST, NOT A ROLEPLAYER. Analyze the data below and output structured JSON.',
        '', systemPrompt, '',
        '====== END OF INSTRUCTIONS ======', '',
        '====== SOURCE DATA (analyze, do NOT continue) ======', '');
    if (langOverride) {
        lines.push(`[TARGET LANGUAGE: ${langOverride}]`, '');
    }
    lines.push('<brain_current>', brainXml, '</brain_current>', '');
    lines.push('<chat_since_last_update>');
    for (const m of scanWindow) {
        const speaker = m.is_user ? 'User' : 'AI';
        const text = String(m.mes ?? '').trim();
        lines.push(`${speaker}: ${text}`);
    }
    lines.push('</chat_since_last_update>', '');
    lines.push('====== END OF SOURCE DATA ======', '');
    lines.push('<task>', 'ARCHIVIST MODE – produce JSON OUTPUT ONLY:');
    lines.push('Propose structured brain updates based on what happened in the chat since the last update. Follow all rules from the system prompt above. Output ONE JSON object matching the schema. No prose, no markdown fences.');
    if (capped) {
        lines.push('');
        lines.push(`Note: Only the most recent ${SCAN_WINDOW_MAX} messages are shown; older context is already in the brain.`);
    }
    lines.push('START JSON NOW:', '</task>');
    return lines.join('\n');
}

// --- Validator-Helfer ------------------------------------------------------

const CHAR_FIELD_ENUM = new Set([
    'core', 'appearance', 'background', 'abilities', 'quirks', 'goals',
    'speech_style', 'stats', 'inventory', 'reputation', 'current_state',
]);
const IMPORTANCE_ENUM = new Set(['low', 'medium', 'high', 'critical']);
const ARC_CHANGE_ENUM = new Set(['status', 'threads', 'growth_opportunities']);
const ARC_STATUS_ENUM = new Set(['active', 'resolved', 'abandoned']);

function trimString(x) {
    return typeof x === 'string' ? x.trim() : '';
}

function cleanStringArray(x) {
    if (!Array.isArray(x)) return [];
    const out = [];
    for (const item of x) {
        if (typeof item === 'string') {
            const t = item.trim();
            if (t) out.push(t);
        }
    }
    return out;
}

/**
 * Liest aus einem migrierten Brain-DOM alle Referenz-Indizes, die der
 * Hallucination-Filter braucht.
 */
function collectBrainIndex(doc) {
    const charNames = new Set();
    for (const c of doc.querySelectorAll('characters > character')) {
        const n = c.getAttribute('name');
        if (n) charNames.add(n);
    }
    const locNames = new Set();
    for (const l of doc.querySelectorAll('locations > location')) {
        const n = l.getAttribute('name');
        if (n) locNames.add(n);
    }
    const relPairs = new Set();
    for (const r of doc.querySelectorAll('relationships > relationship')) {
        const f = r.getAttribute('from');
        const t = r.getAttribute('to');
        if (f && t) relPairs.add(`${f}||${t}`);
    }
    const arcIds = new Set();
    const arcTitles = new Set();
    for (const a of doc.querySelectorAll('arcs > arc')) {
        const id = a.getAttribute('id');
        if (id) arcIds.add(id);
        const title = a.querySelector(':scope > title')?.textContent?.trim();
        if (title) arcTitles.add(title);
    }
    return { charNames, locNames, relPairs, arcIds, arcTitles };
}

/**
 * Shape- + Referenz-Validator für die LLM-Response (Spec §5.1, §5.2).
 *
 * Reihenfolge der Prüfung folgt der Ordering-Invariant (§7.2):
 *   new_characters → new_locations → new_arcs → new_key_moments → new_relationships
 *   → new_world_rules → new_pins
 *   → character_field_updates → relationship_updates → arc_updates → scene_update
 * Damit können Updates auf innerhalb desselben Batches neu vergebene Namen/IDs
 * referenzieren.
 *
 * @param {object} json – bereits geparste LLM-Response
 * @param {string} migratedBrainXml – post-migriertes Brain als String
 * @returns {{ proposals: Array, dropped: Array, shape_ok: boolean, reasoning: string }}
 */
export function validateProposals(json, migratedBrainXml) {
    const empty = { proposals: [], dropped: [], shape_ok: false, reasoning: '' };

    if (!json || typeof json !== 'object' || Array.isArray(json)) return empty;
    const reasoning = trimString(json.reasoning);
    if (!reasoning) return empty;

    // Normalizer: fehlende Top-Level-Keys tolerieren
    const src = {
        new_key_moments: Array.isArray(json.new_key_moments) ? json.new_key_moments : [],
        new_locations: Array.isArray(json.new_locations) ? json.new_locations : [],
        new_characters: Array.isArray(json.new_characters) ? json.new_characters : [],
        character_field_updates: Array.isArray(json.character_field_updates) ? json.character_field_updates : [],
        new_relationships: Array.isArray(json.new_relationships) ? json.new_relationships : [],
        relationship_updates: Array.isArray(json.relationship_updates) ? json.relationship_updates : [],
        new_arcs: Array.isArray(json.new_arcs) ? json.new_arcs : [],
        arc_updates: Array.isArray(json.arc_updates) ? json.arc_updates : [],
        scene_update: (json.scene_update && typeof json.scene_update === 'object' && !Array.isArray(json.scene_update))
            ? json.scene_update
            : null,
        new_world_rules: Array.isArray(json.new_world_rules) ? json.new_world_rules : [],
        new_pins: Array.isArray(json.new_pins) ? json.new_pins : [],
        new_history_entries: Array.isArray(json.new_history_entries) ? json.new_history_entries : [],
    };

    const doc = new DOMParser().parseFromString(migratedBrainXml, 'application/xml');
    if (doc.querySelector('parsererror')) {
        throw new Error('validateProposals: migratedBrainXml unparseable');
    }
    const idx = collectBrainIndex(doc);
    const existingIds = collectExistingIds(doc);

    const proposals = [];
    const dropped = [];
    const drop = (category, item, reason) => dropped.push({ category, item, reason });

    // --- new_characters (erweitert Namensraum) --------------------------------
    const addedCharNames = new Set();
    for (const item of src.new_characters) {
        if (!item || typeof item !== 'object') { drop('new_characters', item, 'not an object'); continue; }
        const name = trimString(item.name);
        const core = trimString(item.core);
        if (!name) { drop('new_characters', item, 'missing name'); continue; }
        if (!core) { drop('new_characters', item, 'missing core'); continue; }
        if (idx.charNames.has(name) || addedCharNames.has(name)) {
            drop('new_characters', item, `character "${name}" already exists`);
            continue;
        }
        const id = generateId('char', name, existingIds);
        addedCharNames.add(name);
        proposals.push({
            category: 'new_characters',
            id,
            name,
            core,
            appearance: trimString(item.appearance),
            quirks: trimString(item.quirks),
            background: trimString(item.background),
            aliases: cleanStringArray(item.aliases),
        });
    }
    const knownCharNames = new Set([...idx.charNames, ...addedCharNames]);

    // --- new_locations -------------------------------------------------------
    const addedLocNames = new Set();
    for (const item of src.new_locations) {
        if (!item || typeof item !== 'object') { drop('new_locations', item, 'not an object'); continue; }
        const name = trimString(item.name);
        const description = trimString(item.description);
        if (!name) { drop('new_locations', item, 'missing name'); continue; }
        if (!description) { drop('new_locations', item, 'missing description'); continue; }
        if (idx.locNames.has(name) || addedLocNames.has(name)) {
            drop('new_locations', item, `location "${name}" already exists`);
            continue;
        }
        const id = generateId('loc', name, existingIds);
        addedLocNames.add(name);
        proposals.push({
            category: 'new_locations',
            id,
            name,
            description,
            atmosphere: trimString(item.atmosphere),
            events_here: cleanStringArray(item.events_here),
        });
    }

    // --- new_arcs (erweitert Arc-ID-Raum) ------------------------------------
    const addedArcIds = new Set();
    const addedArcTitles = new Set();
    for (const item of src.new_arcs) {
        if (!item || typeof item !== 'object') { drop('new_arcs', item, 'not an object'); continue; }
        const title = trimString(item.title);
        const tension = trimString(item.tension);
        if (!title) { drop('new_arcs', item, 'missing title'); continue; }
        if (!tension) { drop('new_arcs', item, 'missing tension'); continue; }
        if (idx.arcTitles.has(title) || addedArcTitles.has(title)) {
            drop('new_arcs', item, `arc "${title}" already exists`);
            continue;
        }
        const id = generateId('arc', title, existingIds);
        addedArcIds.add(id);
        addedArcTitles.add(title);
        proposals.push({
            category: 'new_arcs',
            id,
            title,
            tension,
            open_threads: cleanStringArray(item.open_threads),
            growth_opportunities: trimString(item.growth_opportunities),
        });
    }
    const knownArcIds = new Set([...idx.arcIds, ...addedArcIds]);

    // --- new_key_moments (ref: knownCharNames) --------------------------------
    for (const item of src.new_key_moments) {
        if (!item || typeof item !== 'object') { drop('new_key_moments', item, 'not an object'); continue; }
        const when = trimString(item.when);
        const where = trimString(item.where);
        const summary = trimString(item.summary);
        const importance = trimString(item.importance);
        const who = cleanStringArray(item.who);
        if (!when) { drop('new_key_moments', item, 'missing when'); continue; }
        if (!where) { drop('new_key_moments', item, 'missing where'); continue; }
        if (!summary) { drop('new_key_moments', item, 'missing summary'); continue; }
        if (!IMPORTANCE_ENUM.has(importance)) { drop('new_key_moments', item, `invalid importance "${importance}"`); continue; }
        if (who.length === 0) { drop('new_key_moments', item, 'who[] empty'); continue; }
        const unknown = who.filter(w => !knownCharNames.has(w));
        if (unknown.length > 0) { drop('new_key_moments', item, `unknown characters: ${unknown.join(', ')}`); continue; }
        const id = generateId('km', summary.slice(0, SLUG_MAX), existingIds);
        proposals.push({
            category: 'new_key_moments',
            id, when, where, who, summary, importance,
            verbatim: trimString(item.verbatim),
            tags: cleanStringArray(item.tags),
            impact: trimString(item.impact),
        });
    }

    // --- new_relationships (ref: knownCharNames, BIDIRECTIONAL) ---------------
    const addedRelPairs = new Set();
    for (const item of src.new_relationships) {
        if (!item || typeof item !== 'object') { drop('new_relationships', item, 'not an object'); continue; }
        const from = trimString(item.from);
        const to = trimString(item.to);
        const current = trimString(item.current);
        if (!from) { drop('new_relationships', item, 'missing from'); continue; }
        if (!to) { drop('new_relationships', item, 'missing to'); continue; }
        if (!current) { drop('new_relationships', item, 'missing current'); continue; }
        if (!knownCharNames.has(from)) { drop('new_relationships', item, `unknown from "${from}"`); continue; }
        if (!knownCharNames.has(to)) { drop('new_relationships', item, `unknown to "${to}"`); continue; }
        if (from === to) { drop('new_relationships', item, 'from equals to'); continue; }
        const pairKey = `${from}||${to}`;
        if (idx.relPairs.has(pairKey) || addedRelPairs.has(pairKey)) {
            drop('new_relationships', item, `relationship ${from}→${to} already exists`);
            continue;
        }
        const id = generateId('rel', `${from}_${to}`, existingIds);
        addedRelPairs.add(pairKey);
        proposals.push({
            category: 'new_relationships',
            id, from, to, current,
            history: cleanStringArray(item.history),
            key_moments: cleanStringArray(item.key_moments),
            reverseCurrent: trimString(item.from_current), // LLM's reverse-view if provided
        });
    }

    // Auto-generiere fehlende Rückrichtungen (Bidirectional-Invariante)
    for (const prop of [...proposals.filter(p => p.category === 'new_relationships')]) {
        const reverseKey = `${prop.to}||${prop.from}`;
        if (idx.relPairs.has(reverseKey) || addedRelPairs.has(reverseKey)) continue;
        if (!knownCharNames.has(prop.to) || !knownCharNames.has(prop.from)) continue;
        const revId = generateId('rel', `${prop.to}_${prop.from}`, existingIds);
        addedRelPairs.add(reverseKey);
        proposals.push({
            category: 'new_relationships',
            id: revId,
            from: prop.to,
            to: prop.from,
            current: prop.reverseCurrent || '(keine Angabe)',
            history: [],
            key_moments: [],
            reverseCurrent: prop.current, // die Ursprungsrichtung als reverseCurrent
            _auto: true, // markiert als auto-generiert für Popup-Logging
        });
    }

    const knownRelPairs = new Set([...idx.relPairs, ...addedRelPairs]);

    // --- new_world_rules (flattened: String → Card) ---------------------------
    for (const item of src.new_world_rules) {
        if (typeof item !== 'string') { drop('new_world_rules', item, 'not a string'); continue; }
        const text = item.trim();
        if (!text) { drop('new_world_rules', item, 'empty string'); continue; }
        proposals.push({ category: 'new_world_rules', text });
    }

    // --- new_pins (flattened + IDs) ------------------------------------------
    for (const item of src.new_pins) {
        if (typeof item !== 'string') { drop('new_pins', item, 'not a string'); continue; }
        const text = item.trim();
        if (!text) { drop('new_pins', item, 'empty string'); continue; }
        const id = generateId('pin', text, existingIds);
        proposals.push({ category: 'new_pins', id, text });
    }

    // --- new_history_entries (ref: knownCharNames for involved[]) -------------
    for (const item of src.new_history_entries) {
        if (!item || typeof item !== 'object') { drop('new_history_entries', item, 'not an object'); continue; }
        const summary = trimString(item.summary);
        if (!summary) { drop('new_history_entries', item, 'missing summary'); continue; }
        const involved = cleanStringArray(item.involved);
        if (involved.length > 0) {
            const unknown = involved.filter(n => !knownCharNames.has(n));
            if (unknown.length > 0) { drop('new_history_entries', item, `unknown involved: ${unknown.join(', ')}`); continue; }
        }
        const id = generateId('h', summary.slice(0, SLUG_MAX), existingIds);
        proposals.push({
            category: 'new_history_entries',
            id, summary,
            scene: trimString(item.scene),
            tags: cleanStringArray(item.tags),
            key_outcome: trimString(item.key_outcome),
            involved,
        });
    }

    // --- character_field_updates (ref: knownCharNames) ------------------------
    for (const item of src.character_field_updates) {
        if (!item || typeof item !== 'object') { drop('character_field_updates', item, 'not an object'); continue; }
        const character = trimString(item.character);
        const field = trimString(item.field);
        if (!character) { drop('character_field_updates', item, 'missing character'); continue; }
        if (!CHAR_FIELD_ENUM.has(field)) { drop('character_field_updates', item, `invalid field "${field}"`); continue; }
        if (typeof item.new !== 'string') { drop('character_field_updates', item, 'new must be string'); continue; }
        if (!knownCharNames.has(character)) { drop('character_field_updates', item, `unknown character "${character}"`); continue; }
        proposals.push({
            category: 'character_field_updates',
            character, field,
            new: item.new,
            reason: trimString(item.reason),
        });
    }

    // --- relationship_updates (ref: knownRelPairs) ----------------------------
    for (const item of src.relationship_updates) {
        if (!item || typeof item !== 'object') { drop('relationship_updates', item, 'not an object'); continue; }
        const from = trimString(item.from);
        const to = trimString(item.to);
        const delta = trimString(item.delta);
        const reason = trimString(item.reason);
        if (!from) { drop('relationship_updates', item, 'missing from'); continue; }
        if (!to) { drop('relationship_updates', item, 'missing to'); continue; }
        if (!delta) { drop('relationship_updates', item, 'missing delta'); continue; }
        if (!reason) { drop('relationship_updates', item, 'missing reason'); continue; }
        const pairKey = `${from}||${to}`;
        if (!knownRelPairs.has(pairKey)) {
            drop('relationship_updates', item, `relationship ${from}→${to} does not exist`);
            continue;
        }
        proposals.push({
            category: 'relationship_updates',
            from, to, delta, reason,
            new_current: trimString(item.new_current),
        });
    }

    // --- arc_updates (ref: knownArcIds, typed new_value) ----------------------
    for (const item of src.arc_updates) {
        if (!item || typeof item !== 'object') { drop('arc_updates', item, 'not an object'); continue; }
        const id = trimString(item.id);
        const change_type = trimString(item.change_type);
        if (!id) { drop('arc_updates', item, 'missing id'); continue; }
        if (!ARC_CHANGE_ENUM.has(change_type)) { drop('arc_updates', item, `invalid change_type "${change_type}"`); continue; }
        if (!knownArcIds.has(id)) { drop('arc_updates', item, `unknown arc id "${id}"`); continue; }
        let new_value;
        if (change_type === 'status') {
            new_value = trimString(item.new_value);
            if (!ARC_STATUS_ENUM.has(new_value)) { drop('arc_updates', item, `invalid status "${new_value}"`); continue; }
        } else if (change_type === 'threads') {
            const threads = cleanStringArray(item.new_value);
            if (threads.length === 0) { drop('arc_updates', item, 'threads new_value must be non-empty string array'); continue; }
            new_value = threads;
        } else { // growth_opportunities
            new_value = trimString(item.new_value);
            if (!new_value) { drop('arc_updates', item, 'growth_opportunities new_value missing'); continue; }
        }
        proposals.push({
            category: 'arc_updates',
            id, change_type, new_value,
            reason: trimString(item.reason),
        });
    }

    // --- scene_update (single object, ref: knownCharNames) --------------------
    if (src.scene_update) {
        const s = src.scene_update;
        const location = trimString(s.location);
        const present = cleanStringArray(s.present);
        if (!location) {
            drop('scene_update', s, 'missing location');
        } else if (present.length === 0) {
            drop('scene_update', s, 'present[] empty');
        } else {
            const unknownPresent = present.filter(p => !knownCharNames.has(p));
            if (unknownPresent.length > 0) {
                drop('scene_update', s, `unknown characters in present: ${unknownPresent.join(', ')}`);
            } else {
                proposals.push({
                    category: 'scene_update',
                    location, present,
                    time: trimString(s.time),
                    mood: trimString(s.mood),
                    active_tension: trimString(s.active_tension),
                });
            }
        }
    }

    if (dropped.length > 0) {
        console.warn(`${LOG_PREFIX} validateProposals dropped ${dropped.length} items:`, dropped);
    }

    return { proposals, dropped, shape_ok: true, reasoning };
}

/**
 * Der Phase-2-Orchestrator bis einschließlich Validator. Keine Popup-/Apply-
 * Phase – das kommt in Schritt 4–6. Zurückgegeben wird alles, was die folgenden
 * Schritte brauchen.
 *
 * Fehler-Semantik:
 *   • storage / Parser / generateRaw werfen direkt (Caller fängt und zeigt Toast)
 *   • JSON-Parse-Fehler wird als Error mit `.raw` propagiert
 *   • Leeres Scan-Window → keine Exception, Return mit `scanWindowEmpty: true`
 *   • Shape-Fehler → `shape_ok: false`, `proposals: []` (kein Throw)
 *
 * @param {object} opts
 * @param {object} opts.ctx – SillyTavern getContext()
 * @param {object} [opts.settings] – CCS-Settings (für historyEnabled etc.)
 *
 * Der System-Prompt wird aus `prompts/update-system.txt` gefetcht (oder aus dem
 * in-Code-Fallback, falls die Datei fehlt). Es gibt KEIN `settings.updateSystemPrompt`
 * mehr – Anpassungen landen direkt in der Datei und wandern per git push/pull.
 */
export async function runUpdate({ ctx, settings }) {
    if (!ctx) throw new Error('runUpdate: ctx required');

    const originalXml = await storage.getLivingDocument();
    if (!originalXml) throw new Error('runUpdate: no living document');

    // Schritt 1: Migration (idempotent)
    const { xml: migratedBrainXml } = migrateLegacyBrain(originalXml);

    // Cursor aus dem migrierten Brain lesen (Migration wirft keinen ID-Salat ins
    // Root; last_analyzed_msg_index bleibt, falls schon gesetzt)
    const doc = new DOMParser().parseFromString(migratedBrainXml, 'application/xml');
    const root = doc.documentElement;
    const cursorAttr = root ? root.getAttribute('last_analyzed_msg_index') : null;
    const cursor = cursorAttr == null || cursorAttr === '' ? NaN : parseInt(cursorAttr, 10);
    const lang = (root && root.getAttribute('lang')) || '';

    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const cursorIndex = Math.max(0, chat.length - 1);
    const scanWindow = buildScanWindow(ctx, cursor);

    if (scanWindow.length === 0) {
        console.log(`${LOG_PREFIX} runUpdate: scan window empty (cursor=${cursorAttr ?? 'none'}, chat.length=${chat.length})`);
        return {
            proposals: [],
            dropped: [],
            shape_ok: true,
            reasoning: '',
            migratedBrainXml,
            cursorIndex,
            scanWindow: [],
            scanWindowEmpty: true,
        };
    }

    // Determine whether the raw (unfiltered) slice would have exceeded the cap –
    // dann setzen wir den expliziten "Note" in den userPrompt.
    const rawSliceLength = Number.isFinite(cursor) && cursor >= -1
        ? Math.max(0, chat.length - (cursor + 1))
        : Math.min(SCAN_WINDOW_FALLBACK, chat.length);
    const capped = rawSliceLength > SCAN_WINDOW_MAX;

    const systemPrompt = await loadUpdateSystemPrompt();
    const userPrompt = buildUpdateUserPrompt({
        systemPrompt,
        brainXml: migratedBrainXml,
        scanWindow,
        langOverride: lang,
        capped,
    });

    console.log(`${LOG_PREFIX} runUpdate: scanning ${scanWindow.length} messages (cursor=${cursorAttr ?? 'none'}, capped=${capped})`);

    if (typeof ctx.generateRaw !== 'function') {
        throw new Error('runUpdate: ctx.generateRaw not available');
    }

    const raw = await ctx.generateRaw({
        prompt: userPrompt,
        systemPrompt: '',
        instructOverride: true,
        responseLength: UPDATE_RESPONSE_LENGTH,
    });

    const jsonText = extractJson(raw);
    let json;
    try {
        json = JSON.parse(jsonText);
    } catch (e) {
        console.warn(`${LOG_PREFIX} runUpdate JSON parse failed: ${e?.message || e}\nraw response:\n`, raw);
        const err = new Error(`Update-Antwort nicht als JSON verwertbar: ${e?.message || e}`);
        err.raw = raw;
        err.cause = e;
        throw err;
    }

    const result = validateProposals(json, migratedBrainXml);

    // History deaktiviert → alle new_history_entries rausfiltern
    if (settings && settings.historyEnabled === false) {
        const before = result.proposals.length;
        result.proposals = result.proposals.filter(p => p.category !== 'new_history_entries');
        const removed = before - result.proposals.length;
        if (removed > 0) {
            console.log(`${LOG_PREFIX} runUpdate: history disabled, removed ${removed} history proposals`);
        }
    }

    console.log(`${LOG_PREFIX} runUpdate: ${result.proposals.length} proposals (dropped=${result.dropped.length}, shape_ok=${result.shape_ok})`);

    return {
        ...result,
        migratedBrainXml,
        cursorIndex,
        scanWindow,
        scanWindowEmpty: false,
        raw,
    };
}

// =============================================================================
// Schritt 3: APPLY_FNS pro Kategorie (Spec §7.2)
// =============================================================================
// Alle Apply-Funktionen sind rein und idempotent-unfriendly: sie mutieren NUR
// das übergebene `doc`-Objekt, werfen bei Voraussetzungs-Verletzung (z.B.
// fehlendem Referenz-Ziel), und machen keine Seiteneffekte auf Storage,
// Netzwerk oder Globals. Reihenfolge der Aufrufe → Sache von applyProposals.

/** Sucht den Top-Level-Container `<tag>` unter `<brain>` – legt ihn an, wenn nicht da. */
function ensureContainer(doc, tagName) {
    const root = doc.documentElement;
    let c = root.querySelector(`:scope > ${tagName}`);
    if (!c) {
        c = doc.createElement(tagName);
        root.appendChild(c);
    }
    return c;
}

/** Erstellt ein Kind-Element mit optionalem textContent. */
function appendTextChild(parent, tagName, text, doc) {
    const el = doc.createElement(tagName);
    if (text != null && text !== '') el.textContent = String(text);
    parent.appendChild(el);
    return el;
}

/** Entfernt alle Kinder eines Elements, lässt Attribute in Ruhe. */
function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

/** `querySelector` mit `name`-Attribut ist wegen Sonderzeichen/Leerzeichen
 *  fragil, daher manuelle Linear-Suche. Bei <50 chars ist das okay. */
function findCharByName(doc, name) {
    for (const ch of doc.querySelectorAll('characters > character')) {
        if (ch.getAttribute('name') === name) return ch;
    }
    return null;
}

function findRelationshipByPair(doc, from, to) {
    for (const r of doc.querySelectorAll('relationships > relationship')) {
        if (r.getAttribute('from') === from && r.getAttribute('to') === to) return r;
    }
    return null;
}

function findArcById(doc, id) {
    for (const a of doc.querySelectorAll('arcs > arc')) {
        if (a.getAttribute('id') === id) return a;
    }
    return null;
}

// --- Apply-Funktionen -----------------------------------------------------

function applyNewKeyMoment(doc, p) {
    const container = ensureContainer(doc, 'key_moments');
    const el = doc.createElement('key_moment');
    el.setAttribute('id', p.id);
    if (p.importance) el.setAttribute('importance', p.importance);
    if (Array.isArray(p.tags) && p.tags.length) el.setAttribute('tags', p.tags.join(', '));
    appendTextChild(el, 'when', p.when, doc);
    appendTextChild(el, 'where', p.where, doc);
    const who = doc.createElement('who');
    for (const name of (p.who || [])) {
        appendTextChild(who, 'person', name, doc);
    }
    el.appendChild(who);
    appendTextChild(el, 'summary', p.summary, doc);
    appendTextChild(el, 'verbatim', p.verbatim || '', doc);
    appendTextChild(el, 'impact', p.impact || '', doc);
    container.appendChild(el);
}

function applyNewLocation(doc, p) {
    const container = ensureContainer(doc, 'locations');
    const el = doc.createElement('location');
    el.setAttribute('id', p.id);
    el.setAttribute('name', p.name);
    appendTextChild(el, 'description', p.description, doc);
    appendTextChild(el, 'atmosphere', p.atmosphere || '', doc);
    const events = doc.createElement('events_here');
    for (const ev of (p.events_here || [])) {
        appendTextChild(events, 'event', ev, doc);
    }
    el.appendChild(events);
    container.appendChild(el);
}

function applyNewCharacter(doc, p) {
    const container = ensureContainer(doc, 'characters');
    const el = doc.createElement('character');
    el.setAttribute('id', p.id);
    el.setAttribute('name', p.name);
    el.setAttribute('role', 'npc');   // HART: LLM-Feld wird ignoriert, NPC-Status Pflicht.
    appendTextChild(el, 'core', p.core, doc);
    appendTextChild(el, 'appearance', p.appearance || '', doc);
    appendTextChild(el, 'quirks', p.quirks || '', doc);
    appendTextChild(el, 'background', p.background || '', doc);
    const aliases = doc.createElement('aliases');
    for (const a of (p.aliases || [])) {
        appendTextChild(aliases, 'alias', a, doc);
    }
    el.appendChild(aliases);
    appendTextChild(el, 'current_state', '', doc);   // wächst erst später durch character_field_updates
    container.appendChild(el);
}

function applyCharacterFieldUpdate(doc, p) {
    const ch = findCharByName(doc, p.character);
    if (!ch) throw new Error(`character "${p.character}" not found`);
    let field = ch.querySelector(`:scope > ${p.field}`);
    if (!field) {
        field = doc.createElement(p.field);
        ch.appendChild(field);
    }
    field.textContent = p.new != null ? String(p.new) : '';
}

function applyNewRelationship(doc, p) {
    const container = ensureContainer(doc, 'relationships');
    const el = doc.createElement('relationship');
    el.setAttribute('id', p.id);
    el.setAttribute('from', p.from);
    el.setAttribute('to', p.to);
    appendTextChild(el, 'current', p.current, doc);
    const history = doc.createElement('history');
    for (const h of (p.history || [])) appendTextChild(history, 'entry', h, doc);
    el.appendChild(history);
    const km = doc.createElement('key_moments');
    for (const m of (p.key_moments || [])) appendTextChild(km, 'moment', m, doc);
    el.appendChild(km);
    container.appendChild(el);
}

function applyRelationshipUpdate(doc, p) {
    const rel = findRelationshipByPair(doc, p.from, p.to);
    if (!rel) throw new Error(`relationship ${p.from}→${p.to} not found`);
    let km = rel.querySelector(':scope > key_moments');
    if (!km) {
        km = doc.createElement('key_moments');
        rel.appendChild(km);
    }
    appendTextChild(km, 'moment', p.delta, doc);
    if (p.new_current) {
        let current = rel.querySelector(':scope > current');
        if (!current) {
            current = doc.createElement('current');
            rel.appendChild(current);
        }
        current.textContent = String(p.new_current);
    }
}

function applyNewArc(doc, p) {
    const container = ensureContainer(doc, 'arcs');
    const el = doc.createElement('arc');
    el.setAttribute('id', p.id);
    el.setAttribute('status', 'active');
    appendTextChild(el, 'title', p.title, doc);
    appendTextChild(el, 'tension', p.tension, doc);
    const threads = doc.createElement('open_threads');
    for (const t of (p.open_threads || [])) appendTextChild(threads, 'thread', t, doc);
    el.appendChild(threads);
    appendTextChild(el, 'growth_opportunities', p.growth_opportunities || '', doc);
    container.appendChild(el);
}

function applyArcUpdate(doc, p) {
    const arc = findArcById(doc, p.id);
    if (!arc) throw new Error(`arc id "${p.id}" not found`);
    if (p.change_type === 'status') {
        arc.setAttribute('status', String(p.new_value));
    } else if (p.change_type === 'threads') {
        let threads = arc.querySelector(':scope > open_threads');
        if (!threads) {
            threads = doc.createElement('open_threads');
            arc.appendChild(threads);
        }
        clearChildren(threads);
        for (const t of p.new_value) {
            appendTextChild(threads, 'thread', t, doc);
        }
    } else if (p.change_type === 'growth_opportunities') {
        let go = arc.querySelector(':scope > growth_opportunities');
        if (!go) {
            go = doc.createElement('growth_opportunities');
            arc.appendChild(go);
        }
        go.textContent = String(p.new_value);
    } else {
        throw new Error(`unknown change_type "${p.change_type}"`);
    }
}

function applySceneUpdate(doc, p) {
    const scene = ensureContainer(doc, 'scene');
    clearChildren(scene);
    appendTextChild(scene, 'location', p.location, doc);
    const present = doc.createElement('present');
    for (const name of (p.present || [])) {
        appendTextChild(present, 'person', name, doc);
    }
    scene.appendChild(present);
    if (p.time)           appendTextChild(scene, 'time', p.time, doc);
    if (p.mood)           appendTextChild(scene, 'mood', p.mood, doc);
    if (p.active_tension) appendTextChild(scene, 'active_tension', p.active_tension, doc);
}

function applyNewWorldRule(doc, p) {
    const container = ensureContainer(doc, 'world_rules');
    appendTextChild(container, 'rule', p.text, doc);
}

function applyNewPin(doc, p) {
    const container = ensureContainer(doc, 'pinned');
    const pin = doc.createElement('pin');
    pin.setAttribute('id', p.id);
    pin.textContent = String(p.text);
    container.appendChild(pin);
}

function applyNewHistoryEntry(doc, p) {
    const container = ensureContainer(doc, 'history');
    const el = doc.createElement('entry');
    el.setAttribute('id', p.id);
    if (p.scene) el.setAttribute('scene', p.scene);
    appendTextChild(el, 'summary', p.summary, doc);
    if (p.tags && p.tags.length) appendTextChild(el, 'tags', p.tags.join(', '), doc);
    if (p.key_outcome) appendTextChild(el, 'key_outcome', p.key_outcome, doc);
    if (p.involved && p.involved.length) appendTextChild(el, 'involved', p.involved.join(', '), doc);
    container.appendChild(el);
}

/**
 * Die Plural-Keys stimmen 1:1 mit dem JSON-Schema-Top-Level (Spec §5.1) und mit
 * dem `proposal.category`-Tag überein, den `validateProposals` an jedes Item
 * klebt. Ein Schlüssel → genau eine Apply-Funktion → deterministischer DOM-Patch.
 */
export const APPLY_FNS = {
    new_key_moments: applyNewKeyMoment,
    new_locations: applyNewLocation,
    new_characters: applyNewCharacter,
    character_field_updates: applyCharacterFieldUpdate,
    new_relationships: applyNewRelationship,
    relationship_updates: applyRelationshipUpdate,
    new_arcs: applyNewArc,
    arc_updates: applyArcUpdate,
    scene_update: applySceneUpdate,
    new_world_rules: applyNewWorldRule,
    new_pins: applyNewPin,
    new_history_entries: applyNewHistoryEntry,
};

// =============================================================================
// Schritt 4: applyProposals – Orchestrator + Cursor-Handling (Spec §7.1)
// =============================================================================

/**
 * Priority-Map für die stabile Sortierung: alle `new_*` laufen VOR allen
 * `*_updates`, damit Updates auf Entities zeigen können, die im selben Batch
 * gerade erst erzeugt wurden. `scene_update` ist konzeptuell ebenfalls ein
 * Update und kommt ganz zum Schluss. Die konkreten Zahlen sind nur Ordner –
 * Lücken dürfen, solange die Grobsortierung stimmt.
 */
const CATEGORY_PRIORITY = {
    new_characters: 0,
    new_locations: 1,
    new_arcs: 2,
    new_key_moments: 3,
    new_relationships: 4,
    new_world_rules: 5,
    new_pins: 6,
    character_field_updates: 7,
    relationship_updates: 8,
    arc_updates: 9,
    scene_update: 10,
    new_history_entries: 11,
};

function sortProposalsByCategory(approved) {
    return [...approved]
        .map((p, i) => ({ p, i, pri: CATEGORY_PRIORITY[p.category] ?? 99 }))
        .sort((a, b) => a.pri - b.pri || a.i - b.i)   // stabil über Original-Index
        .map(x => x.p);
}

/**
 * Wendet die (vom Popup bestätigten) Proposals deterministisch auf das
 * migrierte Brain an, aktualisiert den Analyse-Cursor und persistiert.
 *
 * Semantik (Spec §7.1, §7.3, §7.4):
 *   • Pro Proposal eigenes try/catch → fail-soft (results.failed)
 *   • Wenn applied===0 && failed>0 → KEIN Save, KEIN Cursor-Write (altes Brain bleibt)
 *   • Sonst: Cursor setzen, validateBrainXml, storage.saveLivingDocument
 *   • Post-validate-Fail wirft → Caller zeigt Error-Toast, altes Brain bleibt
 *
 * @param {Array} approved – Proposal-Items mit `.category`
 * @param {string} migratedBrainXml – bereits migriertes Brain (aus runUpdate)
 * @param {number} cursorIndex – neuer `last_analyzed_msg_index` (0-basiert)
 * @param {object} [settings] – aktuell ungenutzt; Hook für Phase-3-Flags
 * @returns {Promise<{ applied: number, failed: Array<{proposal:object, error:string}> }>}
 */
export async function applyProposals(approved, migratedBrainXml, cursorIndex, settings) {
    if (!Array.isArray(approved)) throw new TypeError('applyProposals: approved must be an array');
    if (typeof migratedBrainXml !== 'string' || !migratedBrainXml) {
        throw new TypeError('applyProposals: migratedBrainXml must be a non-empty string');
    }
    if (!Number.isFinite(cursorIndex)) {
        throw new TypeError('applyProposals: cursorIndex must be a finite number');
    }

    const doc = new DOMParser().parseFromString(migratedBrainXml, 'application/xml');
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
        throw new Error(`applyProposals: brain XML unparseable: ${parseError.textContent?.slice(0, 200)}`);
    }

    const ordered = sortProposalsByCategory(approved);
    const results = { applied: 0, failed: [] };

    for (const proposal of ordered) {
        const fn = APPLY_FNS[proposal.category];
        if (!fn) {
            console.warn(`${LOG_PREFIX} applyProposals: unknown category "${proposal.category}"`, proposal);
            results.failed.push({ proposal, error: `unknown category "${proposal.category}"` });
            continue;
        }
        try {
            fn(doc, proposal);
            results.applied++;
        } catch (e) {
            console.warn(`${LOG_PREFIX} applyProposals: apply failed for`, proposal, e);
            results.failed.push({ proposal, error: e?.message || String(e) });
        }
    }

    // Zero-applied-with-failures: kein Save, kein Cursor, altes Brain bleibt.
    if (results.applied === 0 && results.failed.length > 0) {
        console.log(`${LOG_PREFIX} applyProposals: 0 applied, ${results.failed.length} failed – skipping save`);
        return results;
    }

    // Cursor setzen + Post-Validate
    doc.documentElement.setAttribute('last_analyzed_msg_index', String(cursorIndex));
    const newXml = prettyPrintXml(new XMLSerializer().serializeToString(doc));

    const v = validateBrainXml(newXml);
    if (!v.ok) {
        // Strukturell kaputt → wir werfen. Caller fängt und zeigt Toast, altes Brain bleibt.
        throw new Error(`Patched brain invalid: ${v.error}`);
    }

    await storage.saveLivingDocument(newXml);
    console.log(`${LOG_PREFIX} applyProposals: saved (applied=${results.applied}, failed=${results.failed.length}, cursor=${cursorIndex})`);
    return results;
}
