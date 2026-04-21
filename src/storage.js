// Persistenz für das Living Document.
//
// Strategie: Nutze das bestehende SillyTavern-Attachments-System im "chat"-Scope.
// Pro Chat wird genau eine Datei mit Display-Name DOC_NAME abgelegt. Upsert über
// delete+upload. Die Datei landet im User-Data-Bank-UI und ist dort manuell
// anzeigbar/editierbar.
//
// Konzept-Referenz: siehe ccs-konzept.md §7 (Speicherung).

import {
    uploadFileAttachmentToServer,
    getFileAttachment,
    getDataBankAttachmentsForSource,
    deleteAttachment,
} from '../../../../chats.js';

const LOG_PREFIX = '[CCS]';
const SCOPE = 'chat';
const DOC_NAME = 'ccs-living-document.xml';

function findAttachment() {
    try {
        const list = getDataBankAttachmentsForSource(SCOPE, true) || [];
        return list.find(a => a && a.name === DOC_NAME) || null;
    } catch (err) {
        console.warn(`${LOG_PREFIX} findAttachment failed:`, err);
        return null;
    }
}

/**
 * Markiert unser Attachment als "disabled" in SillyTavern's Data Bank.
 * Dadurch übergehen andere Extensions (v.a. Vectors) die Datei beim Auto-Indexing
 * und bei Kontext-Inclusion. Unser eigener Lese-Pfad `getFileAttachment(url)`
 * funktioniert unabhängig vom Disabled-Flag weiter.
 *
 * Warum direkte Manipulation der Liste statt `disableAttachment()`: die Funktion
 * ist in `chats.js` nicht exportiert (nur intern für die UI-Buttons). Die Liste
 * `extension_settings.disabled_attachments` ist aber die stabile Single-Source-of-Truth,
 * die sowohl die UI-Buttons als auch `isAttachmentDisabled()` nutzen.
 *
 * @param {string} url Attachment-URL
 */
function markAttachmentDisabled(url) {
    try {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx || !ctx.extensionSettings) return;
        if (!Array.isArray(ctx.extensionSettings.disabled_attachments)) {
            ctx.extensionSettings.disabled_attachments = [];
        }
        if (!ctx.extensionSettings.disabled_attachments.includes(url)) {
            ctx.extensionSettings.disabled_attachments.push(url);
            if (typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
            console.log(`${LOG_PREFIX} marked attachment as disabled (excluded from Vectors etc.):`, url);
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} markAttachmentDisabled failed:`, err);
    }
}

/** Prüft synchron, ob für den aktiven Chat ein Living Document existiert. */
export function hasLivingDocument() {
    return findAttachment() !== null;
}

/**
 * Lädt das Living Document des aktiven Chats als XML-String.
 * @returns {Promise<string|null>} XML-Inhalt oder null, wenn keins existiert.
 */
export async function getLivingDocument() {
    const att = findAttachment();
    if (!att) return null;
    try {
        const content = await getFileAttachment(att.url);
        return typeof content === 'string' ? content : null;
    } catch (err) {
        console.warn(`${LOG_PREFIX} failed to load living document:`, err);
        return null;
    }
}

/**
 * Speichert (oder ersetzt) das Living Document des aktiven Chats.
 * @param {string} xmlString – vollständiger XML-Inhalt
 * @returns {Promise<string>} die URL des neuen Attachments
 */
export async function saveLivingDocument(xmlString) {
    if (typeof xmlString !== 'string') {
        throw new TypeError('saveLivingDocument expects a string');
    }
    // Upsert: bestehendes Attachment erst entfernen
    const existing = findAttachment();
    if (existing) {
        await new Promise(resolve => {
            try {
                deleteAttachment(existing, SCOPE, resolve, false);
            } catch (err) {
                console.warn(`${LOG_PREFIX} delete-during-upsert failed:`, err);
                resolve();
            }
        });
    }
    const file = new File([xmlString], DOC_NAME, { type: 'application/xml' });
    const url = await uploadFileAttachmentToServer(file, SCOPE);
    // Vectors & Co. würden unsere Datei sonst automatisch indizieren – redundant,
    // weil wir das Brain bereits selbst per Interceptor injecten. Disabled-Flag
    // setzen, damit der Auto-Indexer die Datei überspringt.
    markAttachmentDisabled(url);
    console.log(`${LOG_PREFIX} living document saved (${xmlString.length} chars, url=${url})`);
    return url;
}

/** Löscht das Living Document des aktiven Chats, falls vorhanden. */
export async function clearLivingDocument() {
    const existing = findAttachment();
    if (!existing) return;
    await new Promise(resolve => {
        try {
            deleteAttachment(existing, SCOPE, resolve, false);
        } catch (err) {
            console.warn(`${LOG_PREFIX} clear failed:`, err);
            resolve();
        }
    });
    console.log(`${LOG_PREFIX} living document cleared`);
}
