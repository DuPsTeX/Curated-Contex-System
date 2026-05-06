// Interceptor: Schicht 1 – Relevance-gefilterter Immer-Kern.
// Bei jeder normalen Generierung scannen wir die letzten beiden Chat-Nachrichten
// nach Namen von Charakteren und Orten aus dem Brain. Nur gematchte Entitäten
// plus immer-relevante Teile (Main-Char, World Rules, Scene, Pins, aktive Arcs)
// werden ins Injection-Prompt aufgenommen. Kein LLM-Call – rein string-basiert.

import * as storage from './storage.js';

const LOG_PREFIX = '[CCS]';

// Eindeutiger Slot-Key im setExtensionPrompt-Store. Muss extensionweit unique sein.
export const SLOT_KEY = 'CCS_CORE';

// Numerische Enums aus SillyTavern (extension_prompt_types / extension_prompt_roles).
// Third-Party-Extensions haben keinen sauberen Import auf die Core-Konstanten, also
// hardcoden wir die stabilen Werte hier und dokumentieren sie.
//   IN_PROMPT (0) = nach Story-String, vor Chat-Messages – passt für Welt-Etablierung.
//   IN_CHAT  (1)  = mitten im Chat bei Depth N – brauchen wir für Szenen-Inject in Phase 2+.
export const POSITION_IN_PROMPT = 0;
export const ROLE_SYSTEM = 0;

// Envelope um das Brain. Der LLM soll verstehen, was er da liest und wie er es
// gegen die laufende Chat-History abwägen soll.
const ENVELOPE_HEADER = `<authoritative_context>
This is the curated canon of the story: world rules, main character facts, established locations, relationships, and key moments. Treat it as ground truth. When recent chat-history events conflict with this context, follow the chat (recent overrides stale state) – but otherwise use this as the source of truth for who the character is, what they can do, and what has happened.`;

const ENVELOPE_FOOTER = `</authoritative_context>`;

/**
 * Wickelt das Brain-XML in den Authoritative-Context-Envelope.
 * Pure function – keine Side-Effects, leicht testbar.
 * @param {string} brainXml
 * @returns {string}
 */
export function buildAlwaysCoreText(brainXml) {
    if (typeof brainXml !== 'string' || !brainXml.trim()) return '';
    return `${ENVELOPE_HEADER}\n\n${brainXml.trim()}\n\n${ENVELOPE_FOOTER}`;
}

/**
 * Filtert das Brain-XML: behält nur Entitäten, deren Name in `messagesText`
 * vorkommt, plus immer-relevante Teile (Main-Char, World Rules, Scene, Pins,
 * aktive Arcs). Reiner String-Match, kein LLM-Call.
 *
 * Immer enthalten:
 *   - world_rules (wenn nicht leer)
 *   - Haupt-Charakter (role="main") – vollständig
 *   - scene (wenn nicht leer)
 *   - pinned (wenn nicht leer)
 *   - arcs mit status="active"
 *
 * Bei Namens-Treffer in messagesText (case-insensitive):
 *   - NPCs, deren name-Attribut matched
 *   - Locations, deren name-Attribut matched
 *   - Relationships, bei denen from ODER to matched
 *   - Key-Moments, deren <who>/<person> matched
 *
 * @param {string} brainXml
 * @param {string} messagesText – zusammengefügte letzte Nachrichten (lowercase)
 * @param {object} [opts]
 * @param {boolean} [opts.includeHistory=true] – ob <history> immer mit ausgegeben wird
 * @returns {string} gefiltertes XML
 */
export function filterBrainByRelevance(brainXml, messagesText, { includeHistory = true } = {}) {
    if (!brainXml || !brainXml.trim()) return brainXml;

    const parser = new DOMParser();
    const doc = parser.parseFromString(brainXml, 'application/xml');
    if (doc.querySelector('parsererror')) return brainXml;

    const root = doc.documentElement;
    if (!root || root.nodeName !== 'brain') return brainXml;

    const text = (messagesText || '').toLowerCase();

    // Namen aller Charaktere und Orte aus dem Brain sammeln
    const charNames = new Set();
    const locNames = new Set();
    for (const ch of root.querySelectorAll('characters > character')) {
        const n = ch.getAttribute('name');
        if (n) charNames.add(n);
    }
    for (const loc of root.querySelectorAll('locations > location')) {
        const n = loc.getAttribute('name');
        if (n) locNames.add(n);
    }

    // Matchen (case-insensitive substring) – diese Sets enthalten NUR Text-Treffer
    const matchedChars = new Set();
    const matchedLocs = new Set();
    for (const n of charNames) {
        if (text.includes(n.toLowerCase())) matchedChars.add(n);
    }
    for (const n of locNames) {
        if (text.includes(n.toLowerCase())) matchedLocs.add(n);
    }

    // main character immer dazurechnen (für Output, nicht für Relationship/Key-Moment-Filter!)
    const mainCharEl = root.querySelector('characters > character[role="main"]');
    const activeChars = new Set([...matchedChars]);         // NUR Text-Treffer
    const allRelevantChars = new Set([...activeChars]);     // Text-Treffer + main
    if (mainCharEl) allRelevantChars.add(mainCharEl.getAttribute('name'));

    // Log: welche Namen wurden gematcht?
    if (allRelevantChars.size > 1 || matchedLocs.size > 0) {
        const allChars = [...charNames];
        const allLocs = [...locNames];
        const hits = [
            ...allChars.filter(n => allRelevantChars.has(n)).map(n => `  char="${n}"${n === mainCharEl?.getAttribute('name') && !activeChars.has(n) ? ' (main, auto)' : ''}`),
            ...allLocs.filter(n => matchedLocs.has(n)).map(n => `  loc="${n}"`),
        ];
        const misses = [
            ...allChars.filter(n => !allRelevantChars.has(n)).map(n => `  char="${n}"`),
            ...allLocs.filter(n => !matchedLocs.has(n)).map(n => `  loc="${n}"`),
        ];
        console.log(`${LOG_PREFIX} filter: matched names:\n${hits.join('\n')}${misses.length ? '\n  --- filtered out ---\n' + misses.join('\n') : ''}`);
    } else {
        console.log(`${LOG_PREFIX} filter: no names matched in recent messages – injecting base context only`);
    }

    // Neues Dokument bauen
    const filteredDoc = parser.parseFromString('<brain version="1"/>', 'application/xml');
    const out = filteredDoc.documentElement;
    const clone = (el) => filteredDoc.importNode(el, true);

    // Immer: world_rules
    const wr = root.querySelector(':scope > world_rules');
    if (wr && wr.children.length > 0) out.appendChild(clone(wr));

    // characters: main + gematchte NPCs
    const charsContainer = filteredDoc.createElement('characters');
    for (const ch of root.querySelectorAll('characters > character')) {
        if (allRelevantChars.has(ch.getAttribute('name'))) {
            charsContainer.appendChild(clone(ch));
        }
    }
    out.appendChild(charsContainer);

    // locations: nur gematchte
    if (matchedLocs.size > 0) {
        const locsContainer = filteredDoc.createElement('locations');
        for (const loc of root.querySelectorAll('locations > location')) {
            if (matchedLocs.has(loc.getAttribute('name'))) {
                locsContainer.appendChild(clone(loc));
            }
        }
        out.appendChild(locsContainer);
    }

    // relationships: from UND to müssen relevant sein (nicht nur einer)
    const relsContainer = filteredDoc.createElement('relationships');
    for (const rel of root.querySelectorAll('relationships > relationship')) {
        if (allRelevantChars.has(rel.getAttribute('from')) && allRelevantChars.has(rel.getAttribute('to'))) {
            relsContainer.appendChild(clone(rel));
        }
    }
    if (relsContainer.children.length > 0) out.appendChild(relsContainer);

    // key_moments: mindestens eine Person muss AKTIV im Text gematcht sein,
    // UND zusätzlich Orts-/Importance-Filter: nur behalten wenn
    //   (a) <where> den aktuellen Szenen-Ort ODER einen gematchten Ort enthält, ODER
    //   (b) importance = critical oder high
    // Verhindert dass alte Medium/Low-Moments ohne Ortsbezug durchrutschen.
    const sceneLocText = root.querySelector(':scope > scene > location')?.textContent?.trim().toLowerCase() || '';
    const kmContainer = filteredDoc.createElement('key_moments');
    for (const km of root.querySelectorAll('key_moments > key_moment')) {
        // Person-Check wie gehabt
        let personMatch = false;
        for (const p of km.querySelectorAll('who > person')) {
            if (activeChars.has(p.textContent?.trim())) { personMatch = true; break; }
        }
        if (!personMatch) continue;

        const importance = (km.getAttribute('importance') || '').toLowerCase();
        const whereText = km.querySelector(':scope > where')?.textContent?.trim().toLowerCase() || '';

        // Orts-Match: <where> enthält Szenen-Ort ODER einen aktiv gematchten Ort
        let locMatch = false;
        if (sceneLocText && whereText.includes(sceneLocText)) locMatch = true;
        if (!locMatch) {
            for (const ln of matchedLocs) {
                if (whereText.includes(ln.toLowerCase())) { locMatch = true; break; }
            }
        }

        if (locMatch || importance === 'critical' || importance === 'high') {
            kmContainer.appendChild(clone(km));
        }
    }
    if (kmContainer.children.length > 0) out.appendChild(kmContainer);

    // arcs: alle mit status="active"
    const arcsContainer = filteredDoc.createElement('arcs');
    for (const arc of root.querySelectorAll('arcs > arc')) {
        if (arc.getAttribute('status') === 'active') arcsContainer.appendChild(clone(arc));
    }
    if (arcsContainer.children.length > 0) out.appendChild(arcsContainer);

    // Immer: scene
    const scene = root.querySelector(':scope > scene');
    if (scene && scene.children.length > 0) out.appendChild(clone(scene));

    // Immer: pinned
    const pinned = root.querySelector(':scope > pinned');
    if (pinned && pinned.children.length > 0) out.appendChild(clone(pinned));

    // Immer: history (wenn enabled + vorhanden – komprimierte Chronik ist Kern-Feature)
    if (includeHistory) {
        const history = root.querySelector(':scope > history');
        if (history && history.children.length > 0) out.appendChild(clone(history));
    }

    // Log: was wurde behalten / verworfen?
    const sections = [];
    for (const container of ['world_rules', 'characters', 'locations', 'relationships', 'key_moments', 'arcs', 'scene', 'pinned', 'history']) {
        const srcCount = root.querySelectorAll(`:scope > ${container} > *`).length;
        const outCount = out.querySelectorAll(`:scope > ${container} > *`).length;
        if (srcCount > 0 || outCount > 0) {
            sections.push(`  ${container}: ${outCount}/${srcCount} kept`);
        }
    }
    console.log(`${LOG_PREFIX} filter: section summary:\n${sections.join('\n')}`);

    return new XMLSerializer().serializeToString(filteredDoc);
}

/**
 * Leert den Injection-Slot. Wichtig bei Chat-Wechsel / Brain gelöscht / Extension aus,
 * damit keine Leiche vom vorigen Zustand mitgeschleppt wird.
 * @param {object} ctx – SillyTavern-Context
 */
export function clearSlot(ctx) {
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    ctx.setExtensionPrompt(SLOT_KEY, '', POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
}

/**
 * Setzt den Slot mit dem Always-Core-Text.
 * @param {object} ctx – SillyTavern-Context
 * @param {string} text – bereits gewrappter Envelope-Text
 */
export function setSlot(ctx, text) {
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    ctx.setExtensionPrompt(SLOT_KEY, text, POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
}

/**
 * Hauptlogik des Interceptors. Wird aus `globalThis.ccsInterceptor` aufgerufen.
 * Fängt alle Fehler intern ab – blockiert niemals die Generierung.
 *
 * @param {object} params
 * @param {object} params.ctx – SillyTavern-Context
 * @param {object} params.settings – CCS-Settings-Objekt
 * @param {string} params.type – Generation-Type ('normal', 'quiet', 'regenerate', ...)
 * @returns {Promise<{ action: 'skip'|'cleared'|'injected', reason?: string, chars?: number }>}
 */
export async function runAlwaysCore({ ctx, settings, type }) {
    // Immer zuerst clearen – "clean-slate"-Invariante.
    // Auch wenn wir gleich wieder setzen: der Clear garantiert, dass kein Zombie
    // aus einem früheren Call übrigbleibt.
    clearSlot(ctx);

    try {
        if (!settings || settings.enabled === false) {
            return { action: 'cleared', reason: 'disabled' };
        }
        if (type === 'quiet') {
            // Quiet-Prompts sind unsere eigenen Side-Calls (z.B. Brain-Init).
            // Da NIE injecten – würde sich selbst füttern.
            return { action: 'skip', reason: 'quiet' };
        }
        if (!ctx || !ctx.chatId) {
            return { action: 'cleared', reason: 'no-chat' };
        }

        let brain = null;
        try {
            brain = await storage.getLivingDocument();
        } catch (err) {
            console.warn(`${LOG_PREFIX} interceptor: failed to read brain`, err);
            return { action: 'cleared', reason: 'storage-error' };
        }

        if (!brain || !brain.trim()) {
            return { action: 'cleared', reason: 'no-brain' };
        }

        // Letzte 2 narrative Messages für Name-Matching extrahieren
        let recentText = '';
        try {
            const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
            const narrative = chat.filter(m => m && m.is_system !== true);
            const lastTwo = narrative.slice(-2);
            recentText = lastTwo.map(m => String(m.mes ?? '')).join(' ');
        } catch { /* nop */ }

        const originalLen = brain.length;
        const filtered = filterBrainByRelevance(brain, recentText, { includeHistory: settings.historyEnabled !== false });
        const filteredLen = filtered.length;

        const text = buildAlwaysCoreText(filtered);
        if (!text) {
            return { action: 'cleared', reason: 'empty-envelope' };
        }

        setSlot(ctx, text);

        const reduction = originalLen > 0
            ? Math.round((1 - filteredLen / originalLen) * 100)
            : 0;

        console.log(
            `${LOG_PREFIX} interceptor: injected ${filteredLen}/${originalLen} chars (${reduction}% reduction)`,
        );

        return { action: 'injected', chars: text.length };
    } catch (err) {
        // Fallback: bei unerwarteten Fehlern nie ST blocken. Slot ist bereits geleert.
        console.error(`${LOG_PREFIX} interceptor: unexpected error`, err);
        return { action: 'cleared', reason: 'unexpected-error' };
    }
}
