// Editor: Einträge des Brains direkt im Hub bearbeiten, anlegen und löschen –
// als Formular statt roher XML.
//
// API: editor.open(type, ref, onSaved) / editor.openNew(type, onSaved)
//   type – Schlüssel aus TYPES
//   ref  – { id } (bevorzugt) oder { index } innerhalb des Containers
// Gespeichert wird immer auf dem AKTUELLEN Brain (frisch gelesen), damit
// zwischenzeitliche Updates nicht überschrieben werden.

import * as storage from './storage.js';
import { generateId, prettyPrintXml } from './updater.js';
import { validateBrainXml } from './initializer.js';

const LOG_PREFIX = '[CCS]';

const LABELS = {
    core: 'Kern', appearance: 'Aussehen', background: 'Hintergrund', abilities: 'Fähigkeiten',
    quirks: 'Eigenheiten', goals: 'Ziele', speech_style: 'Sprechweise', current_state: 'Aktueller Zustand',
    stats: 'Werte', inventory: 'Inventar', reputation: 'Ruf', aliases: 'Aliasse (eine pro Zeile)',
    name: 'Name', description: 'Beschreibung', atmosphere: 'Atmosphäre', events_here: 'Ereignisse hier (eins pro Zeile)',
    current: 'Aktuelle Haltung', key_moments: 'Wendepunkte (einer pro Zeile)', from: 'Von', to: 'Zu',
    importance: 'Wichtigkeit', when: 'Wann', where: 'Wo', who: 'Beteiligte (eine pro Zeile)', summary: 'Zusammenfassung',
    impact: 'Auswirkung', status: 'Status', title: 'Titel', tension: 'Spannung', open_threads: 'Offene Fäden (einer pro Zeile)',
    growth_opportunities: 'Entwicklungschancen', scene: 'Szene / Kapitel', key_outcome: 'Ergebnis', involved: 'Beteiligte',
    text: 'Text', location: 'Ort', time: 'Zeit', mood: 'Stimmung', active_tension: 'Aktive Spannung', present: 'Anwesend (eine pro Zeile)',
};

const ENUMS = {
    importance: ['low', 'medium', 'high', 'critical'],
    status: ['active', 'resolved', 'abandoned'],
};

/**
 * Beschreibung der Eintragstypen.
 *   container/tag – Ort im Brain
 *   attrs  – Attribute (Enum → Auswahlliste)
 *   fields – Text-Kindelemente
 *   lists  – Kind-Container mit wiederholten Einträgen: { container: itemTag }
 *   text   – Eintrag ist reiner Text (Regel, Pin)
 *   idPrefix – Präfix für neue IDs (fehlt → Eintrag hat keine ID)
 */
const TYPES = {
    character: {
        title: 'Figur', container: 'characters', tag: 'character', idPrefix: 'char', nameAttr: 'name',
        attrs: ['name'],
        fields: ['core', 'appearance', 'background', 'abilities', 'quirks', 'goals', 'speech_style', 'current_state', 'stats', 'inventory', 'reputation'],
        lists: { aliases: 'alias' },
    },
    location: {
        title: 'Ort', container: 'locations', tag: 'location', idPrefix: 'loc', nameAttr: 'name',
        attrs: ['name'], fields: ['description', 'atmosphere'], lists: { aliases: 'alias', events_here: 'event' },
    },
    relationship: {
        title: 'Beziehung', container: 'relationships', tag: 'relationship', idPrefix: 'rel',
        attrs: ['from', 'to'], fields: ['current'], lists: { key_moments: 'moment' },
    },
    key_moment: {
        title: 'Schlüsselmoment', container: 'key_moments', tag: 'key_moment', idPrefix: 'km',
        attrs: ['importance'], fields: ['when', 'where', 'summary', 'impact'], lists: { who: 'person' },
    },
    arc: {
        title: 'Handlungsbogen', container: 'arcs', tag: 'arc', idPrefix: 'arc',
        attrs: ['status'], fields: ['title', 'tension', 'growth_opportunities'], lists: { open_threads: 'thread' },
    },
    history: {
        title: 'Chronik-Eintrag', container: 'history', tag: 'entry', idPrefix: 'h',
        attrs: ['scene'], fields: ['summary', 'key_outcome', 'involved'],
    },
    rule: { title: 'Weltregel', container: 'world_rules', tag: 'rule', text: true },
    pin: { title: 'Pin', container: 'pinned', tag: 'pin', idPrefix: 'pin', text: true },
    scene: {
        title: 'Szene', single: 'scene',
        fields: ['location', 'time', 'mood', 'active_tension'], lists: { present: 'person' },
    },
};

function parse(xml) {
    const doc = new DOMParser().parseFromString(xml || '', 'application/xml');
    const root = doc.documentElement;
    if (doc.querySelector('parsererror') || !root || root.nodeName !== 'brain') throw new Error('Brain-XML ist ungültig.');
    return { doc, root };
}

function ensure(doc, parent, tag) {
    return parent.querySelector(`:scope > ${tag}`) || parent.appendChild(doc.createElement(tag));
}

/** Findet den Eintrag im Brain (id bevorzugt, sonst Index). */
function locate(root, type, ref) {
    const t = TYPES[type];
    if (t.single) return root.querySelector(`:scope > ${t.single}`);
    const items = [...root.querySelectorAll(`:scope > ${t.container} > ${t.tag}`)];
    if (ref?.id) return items.find(e => e.getAttribute('id') === ref.id) || null;
    if (Number.isInteger(ref?.index)) return items[ref.index] || null;
    return null;
}

/** Liest die aktuellen Werte eines Elements in ein flaches Objekt. */
function readValues(type, el) {
    const t = TYPES[type];
    const v = {};
    if (t.text) {
        v.text = el?.textContent?.trim() || '';
        return v;
    }
    for (const a of t.attrs || []) v[a] = el?.getAttribute(a) || '';
    for (const f of t.fields || []) v[f] = el?.querySelector(`:scope > ${f}`)?.textContent?.trim() || '';
    for (const [c, item] of Object.entries(t.lists || {})) {
        v[c] = [...(el?.querySelectorAll(`:scope > ${c} > ${item}`) || [])].map(e => e.textContent.trim()).join('\n');
    }
    return v;
}

/** Schreibt Formularwerte zurück ins Element. */
function writeValues(doc, type, el, v) {
    const t = TYPES[type];
    if (t.text) {
        el.textContent = v.text;
        return;
    }
    for (const a of t.attrs || []) {
        if (v[a]) el.setAttribute(a, v[a]);
        else el.removeAttribute(a);
    }
    for (const f of t.fields || []) {
        const child = ensure(doc, el, f);
        if (child.textContent.trim() !== v[f]) {
            child.textContent = v[f];
            // Feld weicht jetzt von der Character Card ab → auch bei "Karte nicht doppeln" injizieren
            if (type === 'character') child.setAttribute('updated', '1');
        }
    }
    for (const [c, item] of Object.entries(t.lists || {})) {
        const container = ensure(doc, el, c);
        // Attribute unveränderter Einträge behalten (z.B. Zeitstempel offener Fäden)
        const keep = new Map([...container.children].map(e => [e.textContent.trim(), e]));
        while (container.firstChild) container.removeChild(container.firstChild);
        for (const line of v[c].split('\n').map(s => s.trim()).filter(Boolean)) {
            const e = doc.createElement(item);
            e.textContent = line;
            for (const a of keep.get(line)?.attributes || []) e.setAttribute(a.name, a.value);
            container.appendChild(e);
        }
    }
}

function buildForm(type, values, { isNew, canDelete, canSilence, silenced }) {
    const t = TYPES[type];
    const form = document.createElement('div');
    form.className = 'ccs-editor-form';
    const h = document.createElement('h3');
    h.textContent = `${t.title} ${isNew ? 'anlegen' : 'bearbeiten'}`;
    form.appendChild(h);

    const inputs = {};
    const addRow = (key, input) => {
        const label = document.createElement('label');
        label.className = 'ccs-editor-row';
        const span = document.createElement('span');
        span.textContent = LABELS[key] || key;
        label.append(span, input);
        form.appendChild(label);
        inputs[key] = input;
    };

    const keys = t.text ? ['text'] : [...(t.attrs || []), ...(t.fields || []), ...Object.keys(t.lists || {})];
    for (const key of keys) {
        let input;
        if (ENUMS[key]) {
            input = document.createElement('select');
            input.className = 'text_pole';
            for (const opt of ENUMS[key]) {
                const o = document.createElement('option');
                o.value = o.textContent = opt;
                input.appendChild(o);
            }
            input.value = values[key] || ENUMS[key][key === 'importance' ? 1 : 0];
        } else if ((t.attrs || []).includes(key)) {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'text_pole';
            input.value = values[key] || '';
            // Namen von Figuren und Beziehungs-Enden sind Referenzen (Szene, Beziehungen,
            // Momente) – Umbenennen würde sie brechen, daher nur beim Anlegen editierbar.
            if (!isNew && (type === 'character' || type === 'relationship')) input.disabled = true;
        } else {
            input = document.createElement('textarea');
            input.className = 'text_pole';
            input.rows = Math.min(8, Math.max(2, Math.ceil((values[key] || '').length / 70)));
            input.value = values[key] || '';
            input.addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.stopPropagation(); });
        }
        addRow(key, input);
    }

    let silenceBox = null;
    if (canSilence) {
        const label = document.createElement('label');
        label.className = 'checkbox_label ccs-editor-silence';
        label.title = 'Der Eintrag bleibt im Brain, kommt aber nie in den Kontext der Erzähl-KI – z.B. Geheimnisse, die erst später herauskommen sollen.';
        silenceBox = document.createElement('input');
        silenceBox.type = 'checkbox';
        silenceBox.checked = !!silenced;
        const span = document.createElement('span');
        span.textContent = 'Stummschalten – nie in den Kontext';
        label.append(silenceBox, span);
        form.appendChild(label);
    }

    let deleteBox = null;
    if (canDelete) {
        const label = document.createElement('label');
        label.className = 'checkbox_label ccs-editor-delete';
        deleteBox = document.createElement('input');
        deleteBox.type = 'checkbox';
        const span = document.createElement('span');
        span.textContent = 'Diesen Eintrag löschen';
        label.append(deleteBox, span);
        form.appendChild(label);
    }

    const collect = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, String(el.value ?? '').trim()]));
    return { form, collect, isDelete: () => !!deleteBox?.checked, isSilenced: () => !!silenceBox?.checked, inputs };
}

/** Bedeutungstragende Wörter (≥ 4 Buchstaben) eines Textes. */
function words(s) {
    return new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []));
}

/**
 * Andere Einträge mit ähnlichem Inhalt. Wer ein Geheimnis stummschaltet, muss
 * wissen, ob es noch woanders steht (z.B. zusätzlich in der Chronik).
 * @returns {string[]} Beschreibungen der ähnlichen Einträge
 */
function similarEntries(root, target) {
    const own = words(target.textContent);
    if (own.size < 4) return [];
    const candidates = root.querySelectorAll(':scope > key_moments > key_moment, :scope > history > entry, :scope > world_rules > rule, :scope > pinned > pin, :scope > relationships > relationship');
    const out = [];
    for (const el of candidates) {
        if (el === target || el.getAttribute('silenced') === '1') continue;
        const other = words(el.textContent);
        let shared = 0;
        for (const w of own) if (other.has(w)) shared++;
        if (shared / Math.min(own.size, other.size || 1) >= 0.4) {
            const kind = { key_moment: 'Schlüsselmoment', entry: 'Chronik', rule: 'Weltregel', pin: 'Pin', relationship: 'Beziehung' }[el.nodeName] || el.nodeName;
            const label = el.getAttribute('scene') || el.querySelector(':scope > summary')?.textContent || el.textContent;
            out.push(`${kind}: „${String(label).trim().slice(0, 60)}“`);
        }
    }
    return out;
}

async function showEditor(type, ref, onSaved) {
    const ctx = SillyTavern.getContext();
    const t = TYPES[type];
    if (!t) throw new Error(`Unbekannter Typ "${type}"`);
    const chatId = ctx.chatId;
    const xml = await storage.getLivingDocument();
    if (!xml) {
        toastr.info('Kein Brain vorhanden – bitte zuerst initialisieren.', 'CCS');
        return;
    }
    const isNew = ref === null;
    const { root } = parse(xml);
    const el = isNew ? null : locate(root, type, ref);
    if (!isNew && !el) {
        toastr.warning('Eintrag nicht gefunden – der Hub war veraltet.', 'CCS');
        onSaved?.();
        return;
    }
    const canDelete = !isNew && !t.single && !(type === 'character' && el.getAttribute('role') === 'main');
    const original = readValues(type, el);
    const isMainChar = type === 'character' && el?.getAttribute('role') === 'main';
    const canSilence = !t.single && type !== 'pin' && !isMainChar;
    const ui = buildForm(type, original, { isNew, canDelete, canSilence, silenced: el?.getAttribute('silenced') === '1' });

    const required = t.text ? ['text'] : (t.nameAttr ? [t.nameAttr] : []).concat(type === 'relationship' ? ['from', 'to'] : []);
    const choice = await ctx.callGenericPopup(ui.form, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Speichern', cancelButton: 'Abbrechen', wide: true, allowVerticalScrolling: true,
        onClosing: (popup) => {
            if (popup.result !== ctx.POPUP_RESULT.AFFIRMATIVE || ui.isDelete()) return true;
            const v = ui.collect();
            const missing = required.find(k => !v[k]);
            if (missing) {
                toastr.warning(`${LABELS[missing] || missing} ist Pflicht.`, 'CCS');
                ui.inputs[missing]?.focus();
                return false;
            }
            return true;
        },
    });
    if (choice !== ctx.POPUP_RESULT.AFFIRMATIVE) return;

    // Auf dem aktuellen Brain anwenden
    const current = await storage.getLivingDocument();
    const { doc, root: cur } = parse(current);
    const values = ui.collect();
    let label;
    if (isNew) {
        const container = t.single ? cur : ensure(doc, cur, t.container);
        const created = doc.createElement(t.tag);
        if (t.idPrefix) {
            const ids = new Set([...cur.querySelectorAll('[id]')].map(e => e.getAttribute('id')));
            const seed = values.name || values.title || (values.from && `${values.from} ${values.to}`) || values.summary || values.text || t.title;
            created.setAttribute('id', generateId(t.idPrefix, seed, ids));
        }
        if (type === 'character') created.setAttribute('role', 'npc');
        if (type === 'arc' && !values.status) values.status = 'active';
        writeValues(doc, type, created, values);
        if (ui.isSilenced()) created.setAttribute('silenced', '1');
        if (type === 'character') created.querySelectorAll('[updated]').forEach(e => e.removeAttribute('updated'));
        container.appendChild(created);
        label = `${t.title} angelegt`;
    } else {
        const target = locate(cur, type, ref);
        if (!target) throw new Error('Eintrag wurde inzwischen entfernt – nichts gespeichert.');
        if (ui.isDelete()) {
            target.remove();
            label = `${t.title} gelöscht`;
        } else {
            const silenceChanged = canSilence && ui.isSilenced() !== (target.getAttribute('silenced') === '1');
            const valuesChanged = JSON.stringify(values) !== JSON.stringify(readValues(type, target));
            if (!valuesChanged && !silenceChanged) {
                toastr.info('Keine Änderungen.', 'CCS');
                return;
            }
            if (valuesChanged) writeValues(doc, type, target, values);
            if (silenceChanged) {
                if (ui.isSilenced()) target.setAttribute('silenced', '1');
                else target.removeAttribute('silenced');
            }
            label = silenceChanged && !valuesChanged
                ? `${t.title} ${ui.isSilenced() ? 'stummgeschaltet' : 'wieder aktiv'}`
                : `${t.title} bearbeitet`;
        }
    }

    const newXml = prettyPrintXml(new XMLSerializer().serializeToString(doc));
    const v = validateBrainXml(newXml);
    if (!v.ok) throw new Error(`Ergebnis ungültig: ${v.error}`);
    await storage.saveLivingDocument(newXml, chatId, label);
    toastr.success(`${label}.`, 'CCS');
    if (label.endsWith('stummgeschaltet') || (!isNew && ui.isSilenced())) {
        const target = locate(parse(newXml).root, type, ref);
        const similar = target ? similarEntries(target.ownerDocument.documentElement, target) : [];
        if (similar.length) {
            toastr.warning(`Ähnlicher Inhalt steht noch in: ${similar.join('; ')} – ggf. dort ebenfalls stummschalten.`, 'CCS: Geheimnis noch sichtbar', { timeOut: 15000 });
        }
    }
    console.log(`${LOG_PREFIX} editor: ${label}`);
    onSaved?.();
}

function guard(promise) {
    return promise.catch(err => {
        toastr.error(err?.message || String(err), 'CCS: Speichern fehlgeschlagen', { timeOut: 10000 });
        console.error(`${LOG_PREFIX} editor failed`, err);
    });
}

/** Vorhandenen Eintrag bearbeiten/löschen. */
export function open(type, ref, onSaved) {
    return guard(showEditor(type, ref || {}, onSaved));
}

/** Neuen Eintrag anlegen. */
export function openNew(type, onSaved) {
    return guard(showEditor(type, null, onSaved));
}

export const EDITABLE_TYPES = Object.keys(TYPES);
