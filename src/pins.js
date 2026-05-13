// Pins: Manuelle Merkzettel, die immer in den Kontext injected werden.
// Für Aufgaben, aktuelle Ziele, Dinge die der Performer nicht vergessen soll.
//
// DOM-basierte Mutation (wie der Rest von CCS) – keine String-Manipulation.

import * as storage from './storage.js';

const LOG_PREFIX = '[CCS]';

/**
 * Extrahiert alle Pin-Texte aus dem Brain-XML.
 * @param {string} brainXml
 * @returns {string[]}
 */
export function getPins(brainXml) {
    if (!brainXml || !brainXml.trim()) return [];
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(brainXml, 'application/xml');
        if (doc.querySelector('parsererror')) return [];
        return [...doc.querySelectorAll(':scope > pinned > pin')]
            .map(p => p.textContent?.trim() || '')
            .filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Fügt einen Pin hinzu und gibt das komplette Brain-XML zurück.
 * @param {string} brainXml
 * @param {string} text
 * @returns {string}
 */
export function brainWithPin(brainXml, text) {
    if (!brainXml || !text || !text.trim()) return brainXml;
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(brainXml, 'application/xml');
        if (doc.querySelector('parsererror')) return brainXml;

        const root = doc.documentElement;
        if (!root || root.nodeName !== 'brain') return brainXml;

        let container = root.querySelector(':scope > pinned');
        if (!container) {
            container = doc.createElement('pinned');
            root.appendChild(container);
        }

        const pin = doc.createElement('pin');
        pin.textContent = text.trim();
        container.appendChild(pin);

        return new XMLSerializer().serializeToString(doc);
    } catch (err) {
        console.warn(`${LOG_PREFIX} pins: failed to add pin`, err);
        return brainXml;
    }
}

/**
 * Entfernt einen Pin anhand seines Index (0-basiert) und gibt das Brain-XML zurück.
 * @param {string} brainXml
 * @param {number} index
 * @returns {string}
 */
export function brainWithoutPin(brainXml, index) {
    if (!brainXml) return brainXml;
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(brainXml, 'application/xml');
        if (doc.querySelector('parsererror')) return brainXml;

        const pins = [...doc.querySelectorAll(':scope > pinned > pin')];
        if (index >= 0 && index < pins.length) {
            pins[index].remove();
        }

        // Container leeren, wenn kein Pin mehr drin ist (hält XML sauber)
        const container = doc.querySelector(':scope > pinned');
        if (container && container.children.length === 0) {
            // <pinned></pinned> bleibt – siehe Schema-Invariante
        }

        return new XMLSerializer().serializeToString(doc);
    } catch (err) {
        console.warn(`${LOG_PREFIX} pins: failed to remove pin`, err);
        return brainXml;
    }
}

/**
 * Ersetzt den Text eines Pins an Index und gibt das Brain-XML zurück.
 * @param {string} brainXml
 * @param {number} index
 * @param {string} newText
 * @returns {string}
 */
export function brainWithUpdatedPin(brainXml, index, newText) {
    if (!brainXml || !newText || !newText.trim()) return brainXml;
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(brainXml, 'application/xml');
        if (doc.querySelector('parsererror')) return brainXml;

        const pins = [...doc.querySelectorAll(':scope > pinned > pin')];
        if (index >= 0 && index < pins.length) {
            pins[index].textContent = newText.trim();
        }

        return new XMLSerializer().serializeToString(doc);
    } catch (err) {
        console.warn(`${LOG_PREFIX} pins: failed to update pin`, err);
        return brainXml;
    }
}

/**
 * Convenience: Aktuelles Brain laden, Pin hinzufügen, speichern.
 * @param {string} text
 */
export async function addPinAndSave(text) {
    const xml = await storage.getLivingDocument();
    if (!xml) throw new Error('Kein Brain vorhanden');
    const updated = brainWithPin(xml, text);
    await storage.saveLivingDocument(updated);
    console.log(`${LOG_PREFIX} pins: added "${text.trim()}"`);
}

/**
 * Convenience: Aktuelles Brain laden, Pin löschen, speichern.
 * @param {number} index
 */
export async function deletePinAndSave(index) {
    const xml = await storage.getLivingDocument();
    if (!xml) throw new Error('Kein Brain vorhanden');
    const updated = brainWithoutPin(xml, index);
    await storage.saveLivingDocument(updated);
    console.log(`${LOG_PREFIX} pins: removed index ${index}`);
}

/**
 * Convenience: Aktuelles Brain laden, Pin-Text ersetzen, speichern.
 * @param {number} index
 * @param {string} text
 */
export async function updatePinAndSave(index, text) {
    const xml = await storage.getLivingDocument();
    if (!xml) throw new Error('Kein Brain vorhanden');
    const updated = brainWithUpdatedPin(xml, index, text);
    await storage.saveLivingDocument(updated);
    console.log(`${LOG_PREFIX} pins: updated index ${index}`);
}
