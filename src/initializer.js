// Initializer: baut den Initial-Prompt fürs LLM, ruft generateRaw auf,
// validiert XML-Ausgabe, speichert als Living Document.
//
// Schema: siehe ccs-konzept.md §4 und konsolidierte Entscheidungen mit Autor.
// Root-Tag: <brain>. 11 Character-Felder immer präsent (leer bleibt leer):
// 7 Pflichtfelder mit Inhalt + stats/inventory/reputation (leer falls Quelle nichts sagt)
// + current_state (leer bei Init, wächst durch Phase-2-Updates).
//
// Wichtig: Wir nutzen generateRaw (nicht generateQuietPrompt), weil nur generateRaw
// einen isolierten Prompt ohne den laufenden Chat-Kontext an den LLM schickt.
// generateQuietPrompt würde die komplette SillyTavern-Session (System + History)
// mitschicken und unseren Archivar-Prompt kontaminieren.

import * as storage from './storage.js';
import * as collector from './collector.js';

const LOG_PREFIX = '[CCS]';

// Weiches Limit fürs Prompt-Input. Große Lorebooks können tausende Einträge haben;
// wir kappen jeden Eintrag bei ENTRY_CONTENT_CAP und stoppen bei INPUT_CHAR_CAP insgesamt.
const ENTRY_CONTENT_CAP = 1200; // Zeichen pro Lorebook-Eintrag
const INPUT_CHAR_CAP = 60000;   // Gesamt-Input-Limit (zum Schutz vor Kontext-Überlauf)

/**
 * Mappt Sprach-Codes auf menschenlesbare Namen für die Prompt-Override-Anweisung.
 */
const LANG_NAMES = {
    de: 'German (Deutsch)',
    en: 'English',
    fr: 'French (Français)',
    es: 'Spanish (Español)',
    it: 'Italian (Italiano)',
    pt: 'Portuguese',
    nl: 'Dutch',
    pl: 'Polish',
    ru: 'Russian',
    ja: 'Japanese',
    zh: 'Chinese',
    ko: 'Korean',
};

/**
 * Default-System-Prompt für die Initial-Brain-Generierung.
 *
 * Enthält den Platzhalter `{{LANG_RULE}}` – der zur Laufzeit durch die konkrete
 * Sprach-Direktive ersetzt wird (dynamisch abhängig vom User-Dropdown). Der
 * Platzhalter steht in Regel 6. Wenn der User den Prompt im Settings-Panel
 * editiert und den Platzhalter entfernt, bleibt die Sprach-Anweisung im
 * userPrompt-Header trotzdem erhalten (doppelte Absicherung).
 *
 * Wird als Default genutzt, wenn `settings.initSystemPrompt` leer ist.
 */
export const DEFAULT_INIT_SYSTEM_PROMPT = `You are an archivist. Your job: read the Character Card and Lorebook entries provided by the user, then produce a filled XML "brain document" describing what is KNOWN at the start of the roleplay.

CRITICAL: Output ONLY the XML. No prose, no explanation, no markdown code fences. Do NOT copy the example below verbatim — fill the fields based on the ACTUAL sources the user provides.

=== EXAMPLE OUTPUT (for a fictional healer character "Lyra" — for reference only; do NOT copy) ===

<brain version="1" lang="en">
  <world_rules>
    <rule>Magic requires an elemental bond formed during childhood</rule>
    <rule>The dead cannot be resurrected except by forbidden rites</rule>
  </world_rules>

  <characters>
    <character name="Lyra" role="main">
      <core>gentle healer, deeply compassionate, hides old trauma behind calm smiles, fiercely protective of the weak</core>
      <appearance>mid-twenties, long auburn hair usually braided, green eyes, slender build, wears linen healer's robes with a silver crescent pendant</appearance>
      <background>orphan from Ashen Village, trained by the Sisters of the Moon, now travelling healer; no formal titles</background>
      <abilities>restorative magic, herbalism, minor wards; cannot cast offensive magic; fluent in the Old Tongue</abilities>
      <quirks>talks to her herbs while brewing, blushes at compliments, secretly loves honey cakes, can't sleep without a small oil lamp lit</quirks>
      <goals>short-term: reach the city of Anath before the winter storms; long-term: find the healer who saved her life as a child</goals>
      <speech_style>soft and formal with strangers, warmer with friends, avoids raising her voice, uses gentle endearments like "child" or "dear"</speech_style>
      <stats></stats>
      <inventory></inventory>
      <reputation></reputation>
      <current_state></current_state>
    </character>
  </characters>

  <locations></locations>
  <relationships></relationships>
  <key_moments></key_moments>
  <arcs></arcs>
  <scene></scene>
  <pinned></pinned>
</brain>

Notice: Lyra's <stats>, <inventory>, <reputation>, <current_state> are empty. Stats/inventory/reputation are empty because the fictional source didn't mention game mechanics, gear, or faction standing. <current_state> is ALWAYS empty at initialization — it tracks dynamic personality evolution during the roleplay and only grows during Phase-2 brain-updates.

=== FIELD MEANINGS ===

world_rules  — genuine rules about how the WORLD works (magic, physics, society). NOT character descriptions, NOT place descriptions, NOT items.
characters   — ONLY the main character from the Character Card. Do NOT extract NPCs from lorebooks, even if they're named there.
  core         — personality traits, temperament, core drives (include edgy/adult traits if present: "extremely perverted", "sadistic-loyal", "deeply religious", ...).
  appearance   — physical description in detail (hair, eyes, build, clothing, distinguishing marks, body features).
  background   — age, species/race, profession, titles, origin — the "CV".
  abilities    — skills, magic, combat style. Include LIMITATIONS (e.g., "cannot swim", "no offensive magic").
  quirks       — macken, habits, kinks, notable behaviors, small tics.
  goals        — motivations, short-term AND long-term drives.
  speech_style — how they speak (tone, dialect, verbal tics, common phrases).
  stats        — game-mechanical values (HP/Mana/Level/attributes). EMPTY if the Card says nothing stat-related.
  inventory    — notable equipment/possessions. EMPTY if not mentioned.
  reputation   — standing with factions/cities/guilds. EMPTY if not mentioned.
  current_state — dynamic personality evolution during roleplay (e.g., "beginning to trust Kael again"). ALWAYS EMPTY at initialization; grows via brain-updates during the story.

The containers <locations>, <relationships>, <key_moments>, <arcs>, <scene>, <pinned> ALWAYS stay empty. They grow during the roleplay.

=== ABSOLUTE RULES ===

1. EMIT ALL TAGS even when empty — never remove a tag. Empty tags look like <tag></tag>.
2. <characters> MUST contain EXACTLY ONE <character role="main"> element — the main character from the "MAIN CHARACTER" section (SillyTavern's {{char}}). This is NEVER skipped, NEVER left empty.
3. For that main character, these SEVEN fields MUST be filled with text from the Description/Personality/Scenario/First Message: <core>, <appearance>, <background>, <abilities>, <quirks>, <goals>, <speech_style>. If the source is sparse, summarize what IS there — but do NOT leave these seven empty.
4. <stats>, <inventory>, <reputation> may stay empty — and only if the sources genuinely don't mention them. <current_state> ALWAYS stays empty at initialization regardless of sources; it is reserved for runtime evolution.
5. NEVER invent facts. If the Card says nothing about stats, don't invent HP.
6. {{LANG_RULE}}
7. world_rules: extract ONLY world/magic/physics/society rules. Skip lorebook entries that describe characters, places, items, lore trivia — even if plentiful.
8. Main character name: use EXACTLY the name shown in "MAIN CHARACTER: [NAME]" above (case-sensitive).
9. Escape XML special chars: & → &amp;, < → &lt;, > → &gt; inside text content.
10. Output valid XML, nothing else. No code fences. No "Here is the document:" prefix. Start with <brain and end with </brain>.`;

/**
 * Baut die dynamische Sprach-Regel, die in Rule 6 des Init-System-Prompts
 * eingesetzt wird. Getrennt vom Default-Prompt, damit User den Default-Prompt
 * bearbeiten können, ohne die Sprach-Logik zu verlieren.
 * @param {string} lang – Sprachcode (z.B. 'de', ''). Lowercase, getrimmt.
 */
function buildLangRule(lang) {
    return lang
        ? `Language: WRITE ALL TEXT CONTENT IN ${LANG_NAMES[lang] || lang.toUpperCase()}. Set the root attribute lang="${lang}". Even if the source material is in another language, translate it into ${LANG_NAMES[lang] || lang.toUpperCase()} for the brain. XML tag names stay in English (<core>, <appearance>, ...), only the TEXT INSIDE tags is translated.`
        : `Language: match the dominant language of the sources. English sources → English XML (lang="en"). German sources → German XML (lang="de"). etc.`;
}

/**
 * Hilfs-Helper: trim und als leere String behandeln, falls nicht-String.
 */
function trimString(s) {
    return typeof s === 'string' ? s.trim() : '';
}

/**
 * Baut den Prompt fürs LLM. Gibt systemPrompt (Rolle + Regeln + Beispiel) und
 * userPrompt (die eigentlichen Quellen + Task) getrennt zurück. generateRaw
 * setzt sie als zwei saubere Messages ohne jeglichen Chat-Kontext ab.
 * @param {object} data – Rückgabe von collector.collect(...)
 * @param {object} [opts]
 * @param {string} [opts.lang] – Sprach-Code (z.B. 'de', 'en'). Leer/null = Auto (aus Quellen).
 * @param {string} [opts.systemPromptTemplate] – Override des Default-System-Prompts.
 *                   Darf den Platzhalter `{{LANG_RULE}}` enthalten; er wird mit der
 *                   aktiven Sprach-Regel ersetzt. Leer/null → Default wird verwendet.
 * @returns {{ systemPrompt: string, userPrompt: string, stats: object }}
 */
export function buildInitialPrompt(data, opts = {}) {
    const lang = (opts.lang || '').toLowerCase().trim();
    const template = trimString(opts.systemPromptTemplate) || DEFAULT_INIT_SYSTEM_PROMPT;
    const langRule = buildLangRule(lang);
    // Platzhalter einsetzen (nur falls vorhanden – User-Override kann ihn entfernen)
    const systemPrompt = template.includes('{{LANG_RULE}}')
        ? template.replace('{{LANG_RULE}}', langRule)
        : template;
    // === USER-PROMPT: die eigentlichen Quellen + Task ===
    const parts = [];
    let totalChars = 0;
    let truncated = false;

    const push = (s) => {
        if (truncated) return;
        const remaining = INPUT_CHAR_CAP - totalChars;
        if (s.length > remaining) {
            parts.push(s.slice(0, remaining));
            parts.push('\n\n[...TRUNCATED: input cap reached...]');
            truncated = true;
            totalChars = INPUT_CHAR_CAP;
            return;
        }
        parts.push(s);
        totalChars += s.length;
    };

    // === LANGUAGE DIRECTIVE (user's explicit choice wins over source language) ===
    if (lang) {
        const langName = LANG_NAMES[lang] || lang.toUpperCase();
        push(`=== TARGET LANGUAGE: ${langName} ===

Write ALL text content of the brain XML in ${langName}. Set <brain lang="${lang}">. If the sources below are in a different language, TRANSLATE the information into ${langName}. XML tag names stay English; only the text inside tags is translated.

`);
    }

    // === MAIN CHARACTER (the one the user is roleplaying with) ===
    if (data.character) {
        const charName = data.character.name || '(unknown)';
        push(`=== MAIN CHARACTER: ${charName} ===

This is the ONE and ONLY main character. You MUST produce exactly one <character name="${charName}" role="main"> element inside <characters>, filled from the fields below. This is what SillyTavern calls {{char}}.

Description ({{char}}'s description field):
${data.character.description || '(empty)'}

Personality ({{char}}'s personality field):
${data.character.personality || '(empty)'}

Scenario:
${data.character.scenario || '(empty)'}

First Message (how {{char}} first greets the user — use it to infer speech_style, mood, goals):
${data.character.first_mes || '(empty)'}
`);
    } else {
        push(`
=== MAIN CHARACTER ===
(no active character — leave <characters></characters> empty)
`);
    }

    // === PERSONA (context only; the user persona is not the main character) ===
    if (data.persona && (data.persona.description || data.persona.name)) {
        push(`
=== USER PERSONA (for context; this is NOT the main character) ===
${data.persona.name ? `Name: ${data.persona.name}\n` : ''}${data.persona.description || ''}
`);
    }

    // === LOREBOOK ENTRIES ===
    // Wir senden ALLE Einträge, aber jeder Eintrag wird bei ENTRY_CONTENT_CAP gekappt.
    // Das LLM soll selbst erkennen, was eine "rule" ist.
    const merged = Array.isArray(data.merged) ? data.merged : [];
    if (merged.length === 0) {
        push(`
=== LOREBOOK ENTRIES ===
(none)
`);
    } else {
        push(`
=== LOREBOOK ENTRIES (${merged.length} total) ===
Use ONLY the ones that describe world/magic/physics/society rules for <world_rules>. Ignore character/place/item entries entirely.
`);
        for (let i = 0; i < merged.length; i++) {
            if (truncated) break;
            const e = merged[i];
            const keys = Array.isArray(e.key) ? e.key.slice(0, 5).join(', ') : '';
            const comment = e.comment || '(no comment)';
            const content = (e.content || '').slice(0, ENTRY_CONTENT_CAP);
            const cut = (e.content && e.content.length > ENTRY_CONTENT_CAP) ? ' [TRUNCATED]' : '';
            push(`
--- Entry #${i + 1} ---
Book: ${e.world}
Comment: ${comment}
Keys: ${keys}
Content:
${content}${cut}
`);
        }
    }

    const mainName = data.character?.name || '(main character)';
    push(`
=== YOUR TASK ===

Produce the brain XML now. Core reminders (full rules in system prompt):

1. <characters> MUST contain exactly ONE <character name="${mainName}" role="main"> element. Fill its seven mandatory fields (<core>, <appearance>, <background>, <abilities>, <quirks>, <goals>, <speech_style>) from the MAIN CHARACTER section above. These seven are NEVER empty.
2. <stats>, <inventory>, <reputation> inside that <character> stay empty unless the source mentions them. <current_state></current_state> MUST be present and MUST be empty.
3. <world_rules>: only world/magic/physics/society rules from lorebook entries. No character/place/item descriptions.
4. <locations>, <relationships>, <key_moments>, <arcs>, <scene>, <pinned>: ALWAYS empty.
5. Output ONLY the XML, starting with <brain and ending with </brain>. No other text, no code fences.

XML:
`);

    const userPrompt = parts.join('');

    return {
        systemPrompt,
        userPrompt,
        stats: {
            systemChars: systemPrompt.length,
            userChars: userPrompt.length,
            inputChars: systemPrompt.length + userPrompt.length,
            truncated,
            entriesIncluded: merged.length,
        },
    };
}

/**
 * Extrahiert das `<brain>...</brain>`-Element aus einer potenziell verrauschten
 * LLM-Antwort. Entfernt führende Markdown-Fences, erkennt Start/Ende.
 * @param {string} raw
 * @returns {string|null}
 */
export function extractBrainXml(raw) {
    if (typeof raw !== 'string') return null;
    // Fences entfernen
    let s = raw.replace(/^```(?:xml)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const startIdx = s.indexOf('<brain');
    if (startIdx < 0) return null;
    const endToken = '</brain>';
    const endIdx = s.lastIndexOf(endToken);
    if (endIdx < 0) return null;
    return s.slice(startIdx, endIdx + endToken.length);
}

// Bekannte Einzel-Text-Felder im Brain. Für all diese gilt: Inhalt ist reiner Text,
// also nie verschachtelte Tags. Wenn der LLM das Closing-Tag falsch setzt
// (z.B. `<appearance>...</core>`), reparieren wir deterministisch.
const REPAIRABLE_FIELDS = [
    'core',
    'appearance',
    'background',
    'abilities',
    'quirks',
    'goals',
    'speech_style',
    'stats',
    'inventory',
    'reputation',
    'current_state',
    'rule',
];

/**
 * Korrigiert klassische LLM-Tag-Mismatches in Brain-XML. Fixt Fälle wie
 * `<appearance>text</core>` → `<appearance>text</appearance>`.
 * Touched nur die bekannten Single-Text-Felder; wenn der Inhalt ein `<` enthält
 * (d.h. verschachtelt wirkt), wird nicht angefasst.
 * @param {string} xml
 * @returns {{ xml: string, repairs: number }}
 */
export function repairBrainXml(xml) {
    let repairs = 0;
    let out = xml;
    for (const field of REPAIRABLE_FIELDS) {
        // <FIELD>inhalt-ohne-tags</WRONG>  →  <FIELD>inhalt</FIELD>
        const re = new RegExp(`<${field}>([^<]*)</(?!${field}\\s*>)([a-z_][a-z0-9_]*)\\s*>`, 'gi');
        out = out.replace(re, (_m, inner) => {
            repairs++;
            return `<${field}>${inner}</${field}>`;
        });
    }
    return { xml: out, repairs };
}

/**
 * Prüft, ob eine Zeichenkette parsebares XML mit Root <brain> ist.
 * @param {string} xml
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateBrainXml(xml) {
    if (typeof xml !== 'string' || !xml.length) {
        return { ok: false, error: 'empty output' };
    }
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, 'application/xml');
        const errorNode = doc.querySelector('parsererror');
        if (errorNode) {
            return { ok: false, error: `XML parse error: ${errorNode.textContent.slice(0, 200)}` };
        }
        if (!doc.documentElement || doc.documentElement.nodeName !== 'brain') {
            return { ok: false, error: `root element is not <brain> (got <${doc.documentElement?.nodeName}>)` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: `parse threw: ${err?.message || err}` };
    }
}

/**
 * Kompletter Initial-Call: Collect → Prompt → LLM → Validate → Save.
 * @param {object} [config] – Collector-Config (character/chat/persona/global) + optional lang
 * @param {boolean} [config.character]
 * @param {boolean} [config.chat]
 * @param {boolean} [config.persona]
 * @param {boolean} [config.global]
 * @param {string}  [config.lang] – Ziel-Sprachcode ('de', 'en', ...). Leer = Auto aus Quellen.
 * @param {object}  [config.settings] – Extension-Settings (für initSystemPrompt-Override).
 *                   Wenn gesetzt und nicht-leer: überschreibt DEFAULT_INIT_SYSTEM_PROMPT.
 * @returns {Promise<{ xml: string, stats: object }>}
 */
export async function generateInitial(config = {}) {
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    if (!ctx || typeof ctx.generateRaw !== 'function') {
        throw new Error('generateRaw not available on SillyTavern context');
    }

    const { lang, settings, ...collectorConfig } = config;
    console.log(`${LOG_PREFIX} generateInitial: collecting sources...`, { ...collectorConfig, lang: lang || '(auto)' });
    const collected = await collector.collect(collectorConfig);

    const { systemPrompt, userPrompt, stats } = buildInitialPrompt(collected, {
        lang,
        systemPromptTemplate: trimString(settings?.initSystemPrompt),
    });
    console.log(`${LOG_PREFIX} generateInitial: prompt built`, stats);

    // generateRaw schickt NUR unsere systemPrompt + userPrompt – keine Character Card,
    // keine Chat-History, kein World Info. Das ist der Unterschied zu generateQuietPrompt.
    console.log(`${LOG_PREFIX} generateInitial: calling LLM (generateRaw, isolated)...`);
    const raw = await ctx.generateRaw({
        prompt: userPrompt,
        systemPrompt,
        instructOverride: true,  // egal welcher Instruct-Mode aktiv ist: roh senden
        responseLength: 8000,
    });

    if (typeof raw !== 'string' || !raw.length) {
        throw new Error('LLM returned empty response');
    }
    console.log(`${LOG_PREFIX} generateInitial: LLM response received (${raw.length} chars)`);

    const extracted = extractBrainXml(raw);
    if (!extracted) {
        console.warn(`${LOG_PREFIX} raw LLM response (no <brain> found):`, raw);
        throw new Error('LLM response did not contain <brain>...</brain>');
    }

    // Auto-Repair: klassische LLM-Mismatches (z.B. <appearance>...</core>) korrigieren.
    const { xml, repairs } = repairBrainXml(extracted);
    if (repairs > 0) {
        console.warn(`${LOG_PREFIX} auto-repaired ${repairs} mismatched closing tag(s) in LLM output`);
    }

    const validation = validateBrainXml(xml);
    if (!validation.ok) {
        console.warn(`${LOG_PREFIX} invalid XML from LLM (after repair):`, xml);
        throw new Error(`XML validation failed: ${validation.error}`);
    }

    await storage.saveLivingDocument(xml);
    console.log(`${LOG_PREFIX} generateInitial: saved brain (${xml.length} chars, repairs=${repairs})`);

    return {
        xml,
        stats: {
            ...stats,
            rawResponseChars: raw.length,
            xmlChars: xml.length,
            repairs,
        },
    };
}
