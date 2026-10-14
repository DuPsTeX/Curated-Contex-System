// Compactor: verdichtet das Langzeitgedächtnis, damit das Brain nicht endlos wächst.
//
// Ältere Chronik-Einträge werden zu Kapiteln zusammengefasst, ältere
// Schlüsselmomente zusammengeführt bzw. aussortiert. Die jüngsten Einträge
// bleiben unangetastet (die braucht die laufende Szene im Detail).
// Ablauf: planCompaction → runCompaction (LLM, JSON) → Review → applyCompaction.

import { generateId, parseJsonLoose, prettyPrintXml } from './updater.js';
import * as llm from './llm.js';

const LOG_PREFIX = '[CCS]';

/** Diese jüngsten Einträge bleiben immer unverändert. */
const KEEP_RECENT_HISTORY = 3;
const KEEP_RECENT_KM = 5;
/** Ab so vielen älteren Einträgen lohnt sich ein Lauf. */
const MIN_OLD_HISTORY = 2;
const MIN_OLD_KM = 3;
const RESPONSE_LENGTH = 16000;

const DEFAULT_COMPACT_SYSTEM_PROMPT = `You maintain the long-term memory of a roleplay story. You receive OLDER chronicle entries and OLDER key moments as JSON. Consolidate them so the memory stays small but nothing important is lost.

Return ONLY one JSON object, no prose, no markdown fences:
{
  "chapters": [ { "title": "...", "summary": "...", "key_outcome": "...", "involved": ["..."] } ],
  "key_moments": [ { "when": "...", "where": "...", "who": ["..."], "summary": "...", "importance": "low|medium|high|critical", "impact": "..." } ]
}

Rules:
1. chapters: merge consecutive chronicle entries into chapters (roughly 3-6 entries each, fewer if there are only a few). summary = 2-4 dense sentences: who, where, what happened, what changed. Keep names and places exact. Drop trivia.
2. key_moments: this list REPLACES all older key moments. Keep every critical moment. Keep high moments unless they are fully covered by a chapter. Merge moments that describe the same event. Drop low/medium moments that a chapter already covers.
3. Never invent facts. Only use what is in the input.
4. Write all text in the same language as the input. JSON keys and importance values stay English.
5. Keep any internal deliberation brief and spend your output on the JSON.`;

let cachedPrompt = null;

async function loadCompactSystemPrompt() {
    if (cachedPrompt) return cachedPrompt;
    try {
        const res = await fetch(new URL('../prompts/compact-system.txt', import.meta.url), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).trim();
        if (!text) throw new Error('empty file');
        cachedPrompt = text;
    } catch (err) {
        console.warn(`${LOG_PREFIX} compactor: prompts/compact-system.txt not loaded, using fallback`, err);
        cachedPrompt = DEFAULT_COMPACT_SYSTEM_PROMPT;
    }
    return cachedPrompt;
}

function text(el, sel) {
    return el?.querySelector(`:scope > ${sel}`)?.textContent?.trim() || '';
}

function parse(xml) {
    const doc = new DOMParser().parseFromString(xml || '', 'application/xml');
    const root = doc.documentElement;
    if (doc.querySelector('parsererror') || !root || root.nodeName !== 'brain') throw new Error('Brain-XML ist ungültig.');
    return { doc, root };
}

/**
 * Welche Einträge würden verdichtet?
 * @param {string} brainXml
 * @returns {{ oldHistory: Element[], oldKm: Element[], canCompact: boolean }}
 */
export function planCompaction(brainXml) {
    const { root } = parse(brainXml);
    const history = [...root.querySelectorAll(':scope > history > entry')];
    const kms = [...root.querySelectorAll(':scope > key_moments > key_moment')];
    const oldHistory = history.slice(0, Math.max(0, history.length - KEEP_RECENT_HISTORY));
    const oldKm = kms.slice(0, Math.max(0, kms.length - KEEP_RECENT_KM));
    return { oldHistory, oldKm, canCompact: oldHistory.length >= MIN_OLD_HISTORY || oldKm.length >= MIN_OLD_KM };
}

/**
 * LLM-Lauf. Liefert das Ergebnis, schreibt noch nichts.
 * @param {object} params
 * @param {object} params.ctx – SillyTavern-Context
 * @param {string} params.brainXml
 * @returns {Promise<{ chapters: object[], moments: object[], oldHistoryCount: number, oldKmCount: number }>}
 */
export async function runCompaction({ ctx, brainXml }) {
    const { oldHistory, oldKm, canCompact } = planCompaction(brainXml);
    if (!canCompact) throw new Error('Zu wenig ältere Einträge – Verdichten lohnt sich noch nicht.');

    const input = {
        chronicle: oldHistory.map(h => ({
            scene: h.getAttribute('scene') || '',
            summary: text(h, 'summary'),
            key_outcome: text(h, 'key_outcome'),
            involved: text(h, 'involved'),
        })),
        key_moments: oldKm.map(km => ({
            importance: km.getAttribute('importance') || 'medium',
            when: text(km, 'when'),
            where: text(km, 'where'),
            who: [...km.querySelectorAll(':scope > who > person')].map(p => p.textContent.trim()),
            summary: text(km, 'summary'),
            impact: text(km, 'impact'),
        })),
    };

    const raw = await llm.generate(ctx, {
        prompt: `${JSON.stringify(input, null, 1)}\n\nConsolidate this memory. Output the JSON object now.`,
        systemPrompt: await loadCompactSystemPrompt(),
        responseLength: RESPONSE_LENGTH,
        task: 'compaction',
        json: true,
    });

    let json;
    try {
        json = parseJsonLoose(raw);
    } catch (e) {
        console.warn(`${LOG_PREFIX} compactor: JSON parse failed`, raw);
        throw new Error(`Antwort nicht als JSON verwertbar: ${e?.message || e}`);
    }

    const str = (x) => (typeof x === 'string' ? x.trim() : '');
    const arr = (x) => (Array.isArray(x) ? x.map(str).filter(Boolean) : []);
    const chapters = (Array.isArray(json.chapters) ? json.chapters : [])
        .map(c => ({ title: str(c?.title), summary: str(c?.summary), key_outcome: str(c?.key_outcome), involved: arr(c?.involved) }))
        .filter(c => c.summary);
    const moments = (Array.isArray(json.key_moments) ? json.key_moments : [])
        .map(m => ({
            when: str(m?.when), where: str(m?.where), who: arr(m?.who), summary: str(m?.summary), impact: str(m?.impact),
            importance: ['low', 'medium', 'high', 'critical'].includes(m?.importance) ? m.importance : 'medium',
        }))
        .filter(m => m.summary);

    // Schutz vor Gedächtnisverlust durch eine schwache Antwort.
    if (oldHistory.length && !chapters.length) throw new Error('Das Modell hat keine Kapitel geliefert – nichts verändert.');
    const hadCritical = oldKm.some(km => km.getAttribute('importance') === 'critical');
    if (hadCritical && !moments.some(m => m.importance === 'critical')) {
        throw new Error('Das Modell hat kritische Schlüsselmomente verworfen – nichts verändert.');
    }

    console.log(`${LOG_PREFIX} compactor: history ${oldHistory.length} → ${chapters.length} chapters, key moments ${oldKm.length} → ${moments.length}`);
    return { chapters, moments, oldHistoryCount: oldHistory.length, oldKmCount: oldKm.length };
}

/**
 * Ersetzt die älteren Einträge durch das verdichtete Ergebnis. Pure function.
 * @param {string} brainXml – aktuelles Brain (kann sich seit runCompaction geändert haben;
 *   ersetzt werden die dann ältesten Einträge in derselben Anzahl)
 * @param {{ chapters: object[], moments: object[], oldHistoryCount: number, oldKmCount: number }} result
 * @returns {string} neues XML
 */
export function applyCompaction(brainXml, result) {
    const { doc, root } = parse(brainXml);
    const existingIds = new Set([...root.querySelectorAll('[id]')].map(e => e.getAttribute('id')));
    const ensure = (tag) => root.querySelector(`:scope > ${tag}`) || root.appendChild(doc.createElement(tag));
    const add = (parent, tag, value) => {
        const el = doc.createElement(tag);
        if (value) el.textContent = value;
        parent.appendChild(el);
        return el;
    };

    const history = ensure('history');
    const oldHistory = [...history.querySelectorAll(':scope > entry')].slice(0, result.oldHistoryCount);
    const historyAnchor = oldHistory.length ? oldHistory[oldHistory.length - 1].nextSibling : history.firstChild;
    oldHistory.forEach(e => e.remove());
    for (const c of result.chapters) {
        const el = doc.createElement('entry');
        el.setAttribute('id', generateId('ch', c.title || c.summary, existingIds));
        el.setAttribute('kind', 'chapter');
        if (c.title) el.setAttribute('scene', c.title);
        add(el, 'summary', c.summary);
        if (c.key_outcome) add(el, 'key_outcome', c.key_outcome);
        if (c.involved.length) add(el, 'involved', c.involved.join(', '));
        history.insertBefore(el, historyAnchor);
    }

    const kmContainer = ensure('key_moments');
    const oldKm = [...kmContainer.querySelectorAll(':scope > key_moment')].slice(0, result.oldKmCount);
    const kmAnchor = oldKm.length ? oldKm[oldKm.length - 1].nextSibling : kmContainer.firstChild;
    oldKm.forEach(e => e.remove());
    for (const m of result.moments) {
        const el = doc.createElement('key_moment');
        el.setAttribute('id', generateId('km', m.summary, existingIds));
        el.setAttribute('importance', m.importance);
        add(el, 'when', m.when);
        add(el, 'where', m.where);
        const who = add(el, 'who', '');
        for (const p of m.who) add(who, 'person', p);
        add(el, 'summary', m.summary);
        add(el, 'verbatim', '');
        add(el, 'impact', m.impact);
        kmContainer.insertBefore(el, kmAnchor);
    }

    return prettyPrintXml(new XMLSerializer().serializeToString(doc));
}
