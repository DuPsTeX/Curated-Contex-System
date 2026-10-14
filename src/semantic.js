// Semantic: Bedeutungs-Suche über Schlüsselmomente und Chronik.
//
// Die Aktivierung (activation.js) startet bei Namen und Orten, die genannt
// wird. „Weißt du noch, wie du mich verraten hast?“ enthält keinen Namen – die
// passende Erinnerung findet nur eine Suche nach Bedeutung.
//
// Nutzt die Vektor-API von SillyTavern (/api/vector/*, dieselbe wie die
// eingebaute Vectors-Extension) mit dem lokalen transformers-Embedding-Modell
// aus config.yaml (extensions.models.embedding). Eine Sammlung pro Chat.
// Alles fail-soft: ohne Antwort gibt es eben keine semantischen Treffer.

const LOG_PREFIX = '[CCS]';
const SOURCE = 'transformers';
const TOP_K = 6;
const THRESHOLD = 0.35;
const QUERY_CHARS = 1200;
const TIMEOUT_MS = 15000;

/** Letzter synchronisierter Stand pro Sammlung (Signatur der Einträge). */
const synced = new Map();

function hash32(text) {
    let h = 5381;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
}

export function collectionId(chatId) {
    return `ccs_${hash32(chatId)}`;
}

function text(el, sel) {
    return el?.querySelector(`:scope > ${sel}`)?.textContent?.trim() || '';
}

/**
 * Durchsuchbare Einträge des Brains: Schlüsselmomente + Chronik.
 * @param {string} brainXml
 * @returns {Array<{ id: string, hash: number, text: string }>}
 */
export function memoryItems(brainXml) {
    const doc = new DOMParser().parseFromString(brainXml || '', 'application/xml');
    const root = doc.documentElement;
    if (doc.querySelector('parsererror') || !root || root.nodeName !== 'brain') return [];
    const items = [];
    for (const km of root.querySelectorAll(':scope > key_moments > key_moment')) {
        if (km.getAttribute('silenced') === '1') continue;
        const who = [...km.querySelectorAll(':scope > who > person')].map(p => p.textContent.trim()).join(', ');
        const t = [text(km, 'summary'), text(km, 'impact'), [text(km, 'where'), who].filter(Boolean).join(' – ')].filter(Boolean).join(' ');
        if (t) items.push({ id: km.getAttribute('id'), text: t });
    }
    for (const h of root.querySelectorAll(':scope > history > entry')) {
        if (h.getAttribute('silenced') === '1') continue;
        const t = [h.getAttribute('scene') || '', text(h, 'summary'), text(h, 'key_outcome')].filter(Boolean).join(' ');
        if (t) items.push({ id: h.getAttribute('id'), text: t });
    }
    return items
        .filter(i => i.id)
        .map(i => ({ ...i, hash: hash32(`${i.id}|${i.text}`) }));
}

async function post(path, body) {
    const ctx = SillyTavern.getContext();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`/api/vector/${path}`, {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ source: SOURCE, ...body }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`/api/vector/${path}: HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        return type.includes('json') ? res.json() : null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Bringt die Sammlung des Chats auf den Stand des Brains (neue Einträge rein,
 * veraltete raus). Läuft nur, wenn sich die Einträge seit dem letzten Mal geändert haben.
 */
export async function sync(chatId, brainXml) {
    const id = collectionId(chatId);
    const items = memoryItems(brainXml);
    const signature = items.map(i => i.hash).join(',');
    if (synced.get(id) === signature) return items;

    const existing = new Set((await post('list', { collectionId: id }) || []).map(Number));
    const wanted = new Set(items.map(i => i.hash));
    const toInsert = items.filter(i => !existing.has(i.hash));
    const toDelete = [...existing].filter(h => !wanted.has(h));
    if (toInsert.length) {
        await post('insert', { collectionId: id, items: toInsert.map((i, index) => ({ hash: i.hash, text: i.text, index })) });
    }
    if (toDelete.length) await post('delete', { collectionId: id, hashes: toDelete });
    synced.set(id, signature);
    if (toInsert.length || toDelete.length) {
        console.log(`${LOG_PREFIX} semantic: synced ${items.length} memories (+${toInsert.length} / -${toDelete.length})`);
    }
    return items;
}

/**
 * IDs der Erinnerungen, die inhaltlich zur aktuellen Szene passen.
 * @param {string} chatId
 * @param {string} brainXml
 * @param {string} queryText – jüngste Nachrichten
 * @returns {Promise<Set<string>>}
 */
export async function relevantIds(chatId, brainXml, queryText) {
    const query = String(queryText || '').slice(-QUERY_CHARS).trim();
    if (!query) return new Set();
    const items = await sync(chatId, brainXml);
    if (!items.length) return new Set();
    const result = await post('query', { collectionId: collectionId(chatId), searchText: query, topK: TOP_K, threshold: THRESHOLD });
    const byHash = new Map(items.map(i => [i.hash, i.id]));
    const ids = new Set((result?.metadata || []).map(m => byHash.get(Number(m.hash))).filter(Boolean));
    console.log(`${LOG_PREFIX} semantic: ${ids.size} memories matched by meaning`);
    return ids;
}

/** Sammlung des Chats löschen (z.B. beim Löschen des Brains). */
export async function purge(chatId) {
    synced.delete(collectionId(chatId));
    await post('purge', { collectionId: collectionId(chatId) });
}
