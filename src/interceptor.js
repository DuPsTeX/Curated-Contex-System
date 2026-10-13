// Interceptor: Relevance-gefilterte, kompakte Injektion des Brains.
// Bei jeder normalen Generierung:
//   1. Relevanz: Figuren/Orte, die in den jüngsten Nachrichten erwähnt werden
//      (Name oder Alias, als ganzes Wort) oder in der Szene stehen.
//   2. Budget: älteste Chronik / unwichtigste Momente fliegen zuerst raus.
//   3. Render: kompakter Text statt XML, aufgeteilt in
//        CCS_CORE  – stabiler Kanon, oben im Prompt
//        CCS_STATE – aktuelle Lage, nahe der letzten Nachricht (IN_CHAT @ depth)
// Kein LLM-Call außer dem optionalen Director.

import * as storage from './storage.js';
import * as director from './director.js';
import { selectRelevant, renderCompact } from './render.js';
import { readCursor, resolveCursor } from './cursor.js';
import { stripStatus } from './status.js';

export { readCursor };

const LOG_PREFIX = '[CCS]';

// Eindeutige Slot-Keys im setExtensionPrompt-Store. Müssen extensionweit unique sein.
export const SLOT_KEY = 'CCS_CORE';
export const STATE_SLOT_KEY = 'CCS_STATE';
export const DIRECTOR_SLOT_KEY = 'CCS_DIRECTOR';

// Numerische Enums aus SillyTavern (extension_prompt_types / extension_prompt_roles).
// Third-Party-Extensions haben keinen sauberen Import auf die Core-Konstanten, also
// hardcoden wir die stabilen Werte hier und dokumentieren sie.
//   IN_PROMPT (0) = nach Story-String, vor Chat-Messages – für den stabilen Kanon.
//   IN_CHAT  (1)  = mitten im Chat bei Depth N – für die aktuelle Lage.
export const POSITION_IN_PROMPT = 0;
export const POSITION_IN_CHAT = 1;
export const ROLE_SYSTEM = 0;

const CORE_HEADER = `<story_canon>
Curated canon of this story (world, characters, places, relationships, key moments, chronicle). Treat it as ground truth. If the recent chat contradicts it, the recent chat wins.`;
const CORE_FOOTER = `</story_canon>`;

const STATE_HEADER = `<current_situation>
Where the story stands right now. These are hard facts – do not contradict them: who is present, location and time, injuries and conditions, inventory and equipment, and what each character can know.`;
const STATE_FOOTER = `</current_situation>`;

/** Wickelt den Kanon-Text in den Envelope. Pure function. */
export function buildAlwaysCoreText(coreText) {
    if (typeof coreText !== 'string' || !coreText.trim()) return '';
    return `${CORE_HEADER}\n\n${coreText.trim()}\n${CORE_FOOTER}`;
}

/** Wickelt den Lage-Text in den Envelope. Pure function. */
export function buildStateText(stateText) {
    if (typeof stateText !== 'string' || !stateText.trim()) return '';
    return `${STATE_HEADER}\n\n${stateText.trim()}\n${STATE_FOOTER}`;
}

/**
 * Filtert das Brain-XML auf die relevanten Teile.
 *
 * Immer enthalten: world_rules, Haupt-Charakter, scene, pinned, aktive Arcs,
 * history (wenn includeHistory).
 * Relevanz-abhängig (siehe render.selectRelevant): NPCs, Orte, Beziehungen
 * (beide Seiten relevant), Key-Moments (Person aktiv + Ortsbezug oder high/critical).
 * Charakterbilder (<image>, Base64) werden immer entfernt – die gehören nie in den Prompt.
 *
 * @param {string} brainXml
 * @param {string} messagesText – jüngste Nachrichten (Relevanz-Fenster)
 * @param {object} [opts]
 * @param {boolean} [opts.includeHistory=true]
 * @returns {string} gefiltertes XML
 */
export function filterBrainByRelevance(brainXml, messagesText, { includeHistory = true } = {}) {
    if (!brainXml || !brainXml.trim()) return brainXml;

    const parser = new DOMParser();
    const doc = parser.parseFromString(brainXml, 'application/xml');
    if (doc.querySelector('parsererror')) return brainXml;

    const root = doc.documentElement;
    if (!root || root.nodeName !== 'brain') return brainXml;

    const { mainName, chars: activeChars, locs: matchedLocs } = selectRelevant(root, messagesText || '');
    const allRelevantChars = new Set(activeChars);
    if (mainName) allRelevantChars.add(mainName);

    console.log(`${LOG_PREFIX} filter: relevant chars=[${[...allRelevantChars].join(', ')}] locs=[${[...matchedLocs].join(', ')}]`);

    // Neues Dokument bauen (lang behalten – render.js wählt danach die Sprache)
    const filteredDoc = parser.parseFromString('<brain version="1"/>', 'application/xml');
    const out = filteredDoc.documentElement;
    if (root.getAttribute('lang')) out.setAttribute('lang', root.getAttribute('lang'));
    const clone = (el) => filteredDoc.importNode(el, true);

    const wr = root.querySelector(':scope > world_rules');
    if (wr && wr.children.length > 0) out.appendChild(clone(wr));

    const charsContainer = filteredDoc.createElement('characters');
    for (const ch of root.querySelectorAll(':scope > characters > character')) {
        if (allRelevantChars.has(ch.getAttribute('name'))) {
            const c = clone(ch);
            c.querySelectorAll(':scope > image').forEach(img => img.remove());
            charsContainer.appendChild(c);
        }
    }
    out.appendChild(charsContainer);

    if (matchedLocs.size > 0) {
        const locsContainer = filteredDoc.createElement('locations');
        for (const loc of root.querySelectorAll(':scope > locations > location')) {
            if (matchedLocs.has(loc.getAttribute('name'))) locsContainer.appendChild(clone(loc));
        }
        out.appendChild(locsContainer);
    }

    // relationships: from UND to müssen relevant sein
    const relsContainer = filteredDoc.createElement('relationships');
    for (const rel of root.querySelectorAll(':scope > relationships > relationship')) {
        if (allRelevantChars.has(rel.getAttribute('from')) && allRelevantChars.has(rel.getAttribute('to'))) {
            relsContainer.appendChild(clone(rel));
        }
    }
    if (relsContainer.children.length > 0) out.appendChild(relsContainer);

    // key_moments: mindestens eine Person aktiv (erwähnt/anwesend) UND
    //   (a) <where> enthält Szenen-Ort oder einen relevanten Ort, ODER
    //   (b) importance = critical/high
    const sceneLocText = root.querySelector(':scope > scene > location')?.textContent?.trim().toLowerCase() || '';
    const kmContainer = filteredDoc.createElement('key_moments');
    for (const km of root.querySelectorAll(':scope > key_moments > key_moment')) {
        const personMatch = [...km.querySelectorAll('who > person')].some(p => activeChars.has(p.textContent?.trim()));
        if (!personMatch) continue;
        const importance = (km.getAttribute('importance') || '').toLowerCase();
        const whereText = km.querySelector(':scope > where')?.textContent?.trim().toLowerCase() || '';
        const locMatch = (sceneLocText && whereText.includes(sceneLocText))
            || [...matchedLocs].some(ln => whereText.includes(ln.toLowerCase()));
        if (locMatch || importance === 'critical' || importance === 'high') kmContainer.appendChild(clone(km));
    }
    if (kmContainer.children.length > 0) out.appendChild(kmContainer);

    const arcsContainer = filteredDoc.createElement('arcs');
    for (const arc of root.querySelectorAll(':scope > arcs > arc')) {
        if (arc.getAttribute('status') === 'active') arcsContainer.appendChild(clone(arc));
    }
    if (arcsContainer.children.length > 0) out.appendChild(arcsContainer);

    const scene = root.querySelector(':scope > scene');
    if (scene && scene.children.length > 0) out.appendChild(clone(scene));

    const pinned = root.querySelector(':scope > pinned');
    if (pinned && pinned.children.length > 0) out.appendChild(clone(pinned));

    if (includeHistory) {
        const history = root.querySelector(':scope > history');
        if (history && history.children.length > 0) out.appendChild(clone(history));
    }

    return new XMLSerializer().serializeToString(filteredDoc);
}

/**
 * Trimmt das gefilterte Brain-XML auf ein Token-Budget.
 * Entfernt zuerst älteste History-Einträge (der jüngste bleibt), dann
 * Key-Moments von low → critical. Schätzung: ~4 Zeichen = 1 Token.
 *
 * @param {string} filteredXml – bereits relevance-gefiltertes XML
 * @param {number} tokenBudget – max Tokens (0 = unbegrenzt)
 * @param {(xml: string) => number} [measure] – Größe in Zeichen (Default: XML-Länge,
 *   der Interceptor misst die gerenderte Textform)
 * @returns {string}
 */
export function trimToBudget(filteredXml, tokenBudget, measure = (xml) => xml.length) {
    if (!tokenBudget || tokenBudget <= 0) return filteredXml;
    if (!filteredXml || !filteredXml.trim()) return filteredXml;

    const charBudget = tokenBudget * 4;
    if (measure(filteredXml) <= charBudget) return filteredXml;

    const doc = new DOMParser().parseFromString(filteredXml, 'application/xml');
    if (doc.querySelector('parsererror')) return filteredXml;
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'brain') return filteredXml;

    const size = () => measure(new XMLSerializer().serializeToString(doc));
    const kmPriority = { low: 0, medium: 1, high: 2, critical: 3 };
    const candidates = [
        ...[...root.querySelectorAll(':scope > history > entry')].slice(0, -1),
        ...[...root.querySelectorAll(':scope > key_moments > key_moment')].sort((a, b) =>
            (kmPriority[(a.getAttribute('importance') || 'low').toLowerCase()] || 0)
            - (kmPriority[(b.getAttribute('importance') || 'low').toLowerCase()] || 0)),
    ];

    let removed = 0;
    for (const el of candidates) {
        if (size() <= charBudget) break;
        el.remove();
        removed++;
    }
    if (removed > 0) {
        console.log(`${LOG_PREFIX} trimToBudget: removed ${removed} entries (budget=${tokenBudget} tokens, ~${charBudget} chars)`);
    }
    return new XMLSerializer().serializeToString(doc);
}

/**
 * Kappt den Generierungs-Chat auf die letzten `max` narrativen Nachrichten –
 * aber NUR Nachrichten, die schon ins Brain übernommen wurden (Index <= Cursor).
 * Alles danach bleibt drin, sonst würde die KI es bis zum nächsten Update vergessen.
 * Mutiert `chat` in place (das ist die Kopie, die ST an den Interceptor gibt).
 *
 * Zuordnung zum Original-Index: ST baut den Generierungs-Chat als
 * `chat.filter(!is_system || tool_invocations)` und macht daraus flache Kopien –
 * Objekt-Identität hilft also nicht. Wir rechnen dieselbe Filterung nach und
 * gleichen per Position ab, abgesichert über `send_date`. Passt etwas nicht,
 * bleibt die Nachricht drin (lieber zu viel Kontext als Gedächtnisverlust).
 *
 * @param {Array} chat – Generierungs-Chat (Interceptor-Argument)
 * @param {Array} fullChat – ctx.chat, um den Original-Index zu bestimmen
 * @param {number} max – max. narrative Nachrichten (0 = aus)
 * @param {number} cursor – aufgelöster Cursor (resolveCursor)
 * @returns {number} Anzahl entfernter Nachrichten
 */
export function trimChatToMax(chat, fullChat, max, cursor) {
    if (!(max > 0) || !Array.isArray(chat) || !Number.isFinite(cursor)) return 0;
    const origIndex = [];
    (Array.isArray(fullChat) ? fullChat : []).forEach((m, i) => {
        if (m && (!m.is_system || Array.isArray(m.extra?.tool_invocations))) origIndex.push(i);
    });
    const indexAt = (pos) => {
        const i = origIndex[pos];
        return i !== undefined && fullChat[i].send_date === chat[pos].send_date ? i : undefined;
    };

    let kept = 0;
    let removed = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system === true || m.injected) continue;
        if (kept < max) { kept++; continue; }
        const idx = indexAt(i);
        if (idx === undefined || idx > cursor) continue;
        chat.splice(i, 1);
        removed++;
    }
    return removed;
}

/**
 * Leert die Brain-Slots (Kanon + Lage). Wichtig bei Chat-Wechsel / Brain gelöscht /
 * Extension aus, damit keine Leiche vom vorigen Zustand mitgeschleppt wird.
 * @param {object} ctx – SillyTavern-Context
 */
export function clearSlot(ctx) {
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    ctx.setExtensionPrompt(SLOT_KEY, '', POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
    ctx.setExtensionPrompt(STATE_SLOT_KEY, '', POSITION_IN_CHAT, 0, false, ROLE_SYSTEM);
}

/** Leert den Director-Slot. */
export function clearDirectorSlot(ctx) {
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    ctx.setExtensionPrompt(DIRECTOR_SLOT_KEY, '', POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
}

/** Setzt den Kanon-Slot (oben im Prompt). */
export function setSlot(ctx, text) {
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    ctx.setExtensionPrompt(SLOT_KEY, text, POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
}

/** Setzt den Lage-Slot im Chat bei `depth` (0 = nach der letzten Nachricht). */
export function setStateSlot(ctx, text, depth) {
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    ctx.setExtensionPrompt(STATE_SLOT_KEY, text, POSITION_IN_CHAT, depth, false, ROLE_SYSTEM);
}

/** Setzt den Director-Slot mit dem Director's Brief. */
export function setDirectorSlot(ctx, text) {
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    ctx.setExtensionPrompt(DIRECTOR_SLOT_KEY, text, POSITION_IN_PROMPT, 0, false, ROLE_SYSTEM);
}

/**
 * Director-Brief der letzten Generierung. Swipe/Regenerate sehen dieselbe
 * Situation (gleicher Chat bis zur letzten User-Nachricht) → Brief wiederverwenden
 * statt erneut einen teuren LLM-Call zu machen.
 */
let directorCache = null;

function directorKey(ctx, narrative) {
    const last = narrative[narrative.length - 1];
    return `${ctx.chatId}|${narrative.length}|${last?.send_date ?? ''}|${String(last?.mes ?? '').length}`;
}

/**
 * Hauptlogik des Interceptors. Wird aus `globalThis.ccsInterceptor` aufgerufen.
 * Fängt alle Fehler intern ab – blockiert niemals die Generierung.
 *
 * @param {object} params
 * @param {object} params.ctx – SillyTavern-Context
 * @param {object} params.settings – CCS-Settings-Objekt
 * @param {string} params.type – Generation-Type ('normal', 'quiet', 'regenerate', ...)
 * @param {Array} [params.chat] – Generierungs-Chat aus dem Interceptor (bei Swipe ohne
 *   die ersetzte Nachricht). Fallback: ctx.chat
 * @returns {Promise<{ action: 'skip'|'cleared'|'injected', reason?: string, chars?: number }>}
 */
export async function runAlwaysCore({ ctx, settings, type, chat: genChat }) {
    // Immer zuerst clearen – "clean-slate"-Invariante.
    clearSlot(ctx);
    clearDirectorSlot(ctx);

    try {
        if (!settings || settings.enabled === false) {
            return { action: 'cleared', reason: 'disabled' };
        }
        if (type === 'quiet') {
            // Quiet-Prompts sind Side-Calls (z.B. anderer Extensions). Nie injecten.
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

        // Generierungs-Chat statt ctx.chat: beim Swipe fehlt dort die Nachricht,
        // die gerade ersetzt wird – sie darf weder Filter noch Director beeinflussen.
        const chat = Array.isArray(genChat) ? genChat : (Array.isArray(ctx.chat) ? ctx.chat : []);

        // Chat-History auf max N Nachrichten kappen – nur, was schon im Brain steht.
        const removed = trimChatToMax(chat, ctx.chat, settings.maxChatMessages, resolveCursor(brain, ctx.chat));
        if (removed > 0) {
            console.log(`${LOG_PREFIX} interceptor: trimmed ${removed} already-archived messages (max=${settings.maxChatMessages})`);
        }

        // Statusfenster älterer Antworten ausblenden – die Werte stehen im Brain.
        // Nur auf dem Generierungs-Chat (flache Kopien), nie auf ctx.chat.
        if (settings.statusStripOld !== false && Array.isArray(genChat)) {
            let lastAi = -1;
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i] && !chat[i].is_user && !chat[i].is_system) { lastAi = i; break; }
            }
            let stripped = 0;
            chat.forEach((m, i) => {
                if (i === lastAi || !m || m.is_user || m.is_system) return;
                const s = stripStatus(String(m.mes ?? ''));
                if (s !== m.mes) { m.mes = s; stripped++; }
            });
            if (stripped) console.log(`${LOG_PREFIX} interceptor: stripped status blocks from ${stripped} older messages`);
        }

        // Relevanz-Fenster: die letzten N narrativen Nachrichten. Mehr als 2, damit
        // eine Figur nicht sofort aus dem Kontext fällt, wenn sie kurz nicht genannt wird.
        const narrative = chat.filter(m => m && m.is_system !== true);
        const windowSize = Math.max(1, settings.relevanceWindow || 6);
        const recentText = narrative.slice(-windowSize).map(m => String(m.mes ?? '')).join('\n');

        const renderOpts = { dedupeCard: settings.dedupeCard !== false };
        const measure = (xml) => {
            const r = renderCompact(xml, renderOpts);
            return r.core.length + r.state.length;
        };
        let filtered = filterBrainByRelevance(brain, recentText, { includeHistory: settings.historyEnabled !== false });
        filtered = trimToBudget(filtered, settings.ccsTokenBudget ?? 0, measure);
        const { core, state } = renderCompact(filtered, renderOpts);

        // Director-Agent: narrativer Brief vor der Generierung. Fail-soft.
        // Continue/Impersonate brauchen keinen neuen Szenen-Brief.
        if (settings.directorEnabled && type !== 'continue' && type !== 'impersonate' && narrative.length > 0) {
            try {
                const key = directorKey(ctx, narrative);
                let brief;
                if (directorCache && directorCache.key === key) {
                    brief = directorCache.brief;
                    console.log(`${LOG_PREFIX} director: reusing brief (${type})`);
                } else {
                    ({ brief } = await director.runDirector({
                        ctx,
                        brain: [core, state].filter(Boolean).join('\n\n'),
                        chatWindow: narrative.slice(-3),
                        detail: settings.directorDetail || 'standard',
                    }));
                    directorCache = { key, brief };
                }
                setDirectorSlot(ctx, brief);
                console.log(`${LOG_PREFIX} director: brief injected (${brief.length} chars)`);
            } catch (err) {
                console.warn(`${LOG_PREFIX} director: failed, falling back to normal generation`, err);
                clearDirectorSlot(ctx);
            }
        }

        const coreText = buildAlwaysCoreText(core);
        const stateText = buildStateText(state);
        if (!coreText && !stateText) {
            return { action: 'cleared', reason: 'empty-envelope' };
        }

        if (coreText) setSlot(ctx, coreText);
        if (stateText) setStateSlot(ctx, stateText, Math.max(0, settings.stateDepth ?? 1));

        const injected = coreText.length + stateText.length;
        const reduction = brain.length > 0 ? Math.round((1 - injected / brain.length) * 100) : 0;
        console.log(`${LOG_PREFIX} interceptor: injected ${injected}/${brain.length} chars (${reduction}% reduction; core=${coreText.length}, state=${stateText.length})`);

        return { action: 'injected', chars: injected };
    } catch (err) {
        // Fallback: bei unerwarteten Fehlern nie ST blocken. Slots sind bereits geleert.
        console.error(`${LOG_PREFIX} interceptor: unexpected error`, err);
        return { action: 'cleared', reason: 'unexpected-error' };
    }
}
