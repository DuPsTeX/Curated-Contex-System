// Persistenz für das Living Document.
//
// Strategie: Das Brain-XML liegt als String in den Chat-Metadaten
// (`chat_metadata[META_KEY]`) und wird mit der Chat-Datei gespeichert.
// Vorteile gegenüber dem früheren Attachment-Ansatz:
//   • Atomar – kein delete+upload, bei dem ein fehlgeschlagener Upload das Brain löscht.
//   • Branch-sicher – ein Chat-Branch bekommt eine eigene Kopie. Früher teilten sich
//     Branches dieselbe Datei, und ein Save im Branch löschte das Brain des Originals.
//   • Kein Vectors-Workaround nötig (Metadaten werden nicht indiziert).
//
// Migration: Alte Brains (Attachment `ccs-living-document.xml` im Chat-Scope)
// werden beim ersten Lesen in die Metadaten kopiert. Die alte Datei wird dabei
// NICHT gelöscht – andere Branches können noch auf sie zeigen. Nur der
// Attachment-Eintrag dieses Chats wird entfernt.

import {
    getFileAttachment,
    getDataBankAttachmentsForSource,
} from '../../../../chats.js';

const LOG_PREFIX = '[CCS]';
const META_KEY = 'ccs_brain';
const LEGACY_SCOPE = 'chat';
const LEGACY_DOC_NAME = 'ccs-living-document.xml';

function getContext() {
    return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
}

function findLegacyAttachment() {
    try {
        const list = getDataBankAttachmentsForSource(LEGACY_SCOPE, true) || [];
        return list.find(a => a && a.name === LEGACY_DOC_NAME) || null;
    } catch (err) {
        console.warn(`${LOG_PREFIX} findLegacyAttachment failed:`, err);
        return null;
    }
}

function readMeta() {
    const value = getContext()?.chatMetadata?.[META_KEY];
    return typeof value === 'string' && value.trim() ? value : null;
}

/** Entfernt den Legacy-Attachment-Eintrag aus diesem Chat (Datei bleibt liegen). */
function dropLegacyEntry(ctx) {
    const meta = ctx?.chatMetadata;
    if (!meta || !Array.isArray(meta.attachments)) return;
    meta.attachments = meta.attachments.filter(a => !(a && a.name === LEGACY_DOC_NAME));
}

/** Prüft synchron, ob für den aktiven Chat ein Living Document existiert. */
export function hasLivingDocument() {
    return readMeta() !== null || findLegacyAttachment() !== null;
}

/**
 * Lädt das Living Document des aktiven Chats als XML-String.
 * Migriert ein Legacy-Attachment beim ersten Zugriff in die Metadaten.
 * @returns {Promise<string|null>} XML-Inhalt oder null, wenn keins existiert.
 */
export async function getLivingDocument() {
    const fromMeta = readMeta();
    if (fromMeta) return fromMeta;

    const att = findLegacyAttachment();
    if (!att) return null;
    const ctx = getContext();
    const chatId = ctx?.chatId;
    try {
        const content = await getFileAttachment(att.url);
        if (typeof content !== 'string' || !content.trim()) return null;
        // Chat während des Ladens gewechselt → nicht in fremde Metadaten schreiben.
        if (getContext()?.chatId !== chatId) return content;
        await saveLivingDocument(content, chatId);
        console.log(`${LOG_PREFIX} migrated living document from attachment to chat metadata (${content.length} chars)`);
        return content;
    } catch (err) {
        console.warn(`${LOG_PREFIX} failed to load legacy living document:`, err);
        return null;
    }
}

/**
 * Speichert (oder ersetzt) das Living Document des aktiven Chats.
 * @param {string} xmlString – vollständiger XML-Inhalt
 * @param {string} [expectedChatId] – wenn gesetzt: Abbruch, falls inzwischen ein
 *   anderer Chat aktiv ist (verhindert, dass ein laufendes Update in den falschen Chat schreibt)
 */
export async function saveLivingDocument(xmlString, expectedChatId) {
    if (typeof xmlString !== 'string') {
        throw new TypeError('saveLivingDocument expects a string');
    }
    const ctx = getContext();
    if (!ctx?.chatId || !ctx.chatMetadata) throw new Error('Kein Chat aktiv – Brain nicht gespeichert.');
    if (expectedChatId !== undefined && ctx.chatId !== expectedChatId) {
        throw new Error('Chat wurde gewechselt – Brain nicht gespeichert.');
    }
    ctx.chatMetadata[META_KEY] = xmlString;
    dropLegacyEntry(ctx);
    await ctx.saveMetadata();
    console.log(`${LOG_PREFIX} living document saved (${xmlString.length} chars, chat metadata)`);
}

/** Löscht das Living Document des aktiven Chats, falls vorhanden. */
export async function clearLivingDocument() {
    const ctx = getContext();
    if (!ctx?.chatMetadata) return;
    delete ctx.chatMetadata[META_KEY];
    dropLegacyEntry(ctx);
    await ctx.saveMetadata();
    console.log(`${LOG_PREFIX} living document cleared`);
}
