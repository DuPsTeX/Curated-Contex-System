// Interceptor: Schicht 1 – Immer-Kern.
// Bei jeder normalen Generierung injizieren wir das komplette Brain-XML
// als System-Kontext via setExtensionPrompt. Keine Relevanz-Filterung, keine
// Szenen-Logik, keine Selektion – das ist die einfachste mögliche Schicht.
// Phase 2+ baut Schicht 2 (Relevance/Szene) obenauf.

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

        const text = buildAlwaysCoreText(brain);
        if (!text) {
            return { action: 'cleared', reason: 'empty-envelope' };
        }

        setSlot(ctx, text);
        return { action: 'injected', chars: text.length };
    } catch (err) {
        // Fallback: bei unerwarteten Fehlern nie ST blocken. Slot ist bereits geleert.
        console.error(`${LOG_PREFIX} interceptor: unexpected error`, err);
        return { action: 'cleared', reason: 'unexpected-error' };
    }
}
