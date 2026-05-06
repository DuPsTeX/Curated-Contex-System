// Popup-Rendering für Phase 2 Update-Vorschläge.
//
// renderUpdatePopup() baut das Card-Layout aus Spec §6:
//   • Header mit Reasoning, Counter, "Alle"/"Nichts"-Quick-Actions
//   • Sektion pro nicht-leerer Kategorie mit FontAwesome-Icon
//   • Card pro Proposal: Checkbox (default checked), editierbare Felder,
//     read-only ID-Zeile (live aus Seed-Feld abgeleitet).
//
// Gibt { wrapper, collectApproved, validate } zurück:
//   - wrapper → an callGenericPopup() übergeben
//   - collectApproved() → liest die finalen Proposal-Objekte aus dem DOM
//   - validate() → Pflichtfeld- + Referenz-Integritätsprüfung (für onClosing)
//
// Keine Seiteneffekte auf Brain, Storage oder Globals. Alle Edits leben im
// DOM bis zum Collect; Apply läuft danach über updater.applyProposals().
//
// Ref: docs/superpowers/specs/2026-04-19-ccs-phase2-state-update-design.md §6

import { slugify, generateId } from './updater.js';

const LOG_PREFIX = '[CCS]';

// Collapse-Schwelle für Felder, die als Textarea laufen. Kürzere Werte
// bleiben als Single-Line-Input, längere bekommen die zugeklappt-/ausklappbar-Textarea.
const COLLAPSE_THRESHOLD = 200;

// Icon + deutscher Titel pro Kategorie. Reihenfolge = Sektion-Reihenfolge
// im Popup (entspricht CATEGORY_PRIORITY aus updater.js).
const CATEGORY_META = {
    new_characters:         { icon: 'fa-user-plus',   title: 'Neue Charaktere' },
    new_locations:          { icon: 'fa-map-marker',  title: 'Neue Orte' },
    new_arcs:               { icon: 'fa-book-open',   title: 'Neue Arcs' },
    new_key_moments:        { icon: 'fa-star',        title: 'Schlüsselmomente' },
    new_relationships:      { icon: 'fa-heart',       title: 'Neue Beziehungen' },
    new_world_rules:        { icon: 'fa-scroll',      title: 'Welt-Regeln' },
    new_pins:               { icon: 'fa-thumbtack',   title: 'Pins' },
    character_field_updates:{ icon: 'fa-pen',         title: 'Charakter-Updates' },
    relationship_updates:   { icon: 'fa-heart-pulse', title: 'Beziehungs-Updates' },
    arc_updates:            { icon: 'fa-book',        title: 'Arc-Updates' },
    scene_update:           { icon: 'fa-film',        title: 'Szenen-Update' },
    new_history_entries:    { icon: 'fa-clock-rotate-left', title: 'Chronik-Einträge' },
};

// Enum-Werte gespiegelt aus updater.validateProposals (bewusst Duplikat: die Popup-
// Dropdowns sollen unabhängig von Validator-Interna bleiben, wenn sich später das
// Schema erweitert – dann wird hier explizit angepasst, nicht implizit mitgezogen).
const CHAR_FIELD_ENUM = [
    'core', 'appearance', 'background', 'abilities', 'quirks', 'goals',
    'speech_style', 'stats', 'inventory', 'reputation', 'current_state',
];
const IMPORTANCE_ENUM = ['low', 'medium', 'high', 'critical'];
const ARC_CHANGE_ENUM = ['status', 'threads', 'growth_opportunities'];
const ARC_STATUS_ENUM = ['active', 'resolved', 'abandoned'];

// =============================================================================
// DOM-Helfer – kein jQuery, alles nativ für bessere Testbarkeit
// =============================================================================

function el(tag, opts = {}) {
    const e = document.createElement(tag);
    if (opts.className) e.className = opts.className;
    if (opts.text != null) e.textContent = String(opts.text);
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
    return e;
}

function labeledInput(labelText, inputEl, opts = {}) {
    const wrap = el('div', { className: 'ccs-field' });
    const label = el('label', { text: labelText, className: 'ccs-field-label' });
    if (opts.required) label.classList.add('ccs-required');
    wrap.appendChild(label);
    wrap.appendChild(inputEl);
    return wrap;
}

function textInput(value = '', opts = {}) {
    const i = el('input', { className: 'text_pole ccs-field-input' });
    i.type = 'text';
    i.value = value ?? '';
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.dataField) i.dataset.field = opts.dataField;
    return i;
}

function textareaField(value = '', opts = {}) {
    const long = (value || '').length > COLLAPSE_THRESHOLD;
    const container = el('div', { className: 'ccs-textarea-wrap' });
    const ta = el('textarea', { className: 'text_pole ccs-field-input ccs-textarea' });
    ta.value = value ?? '';
    ta.spellcheck = false;
    if (opts.placeholder) ta.placeholder = opts.placeholder;
    if (opts.dataField) ta.dataset.field = opts.dataField;
    // Enter-Submit-Guard: Popup würde sonst bei Enter im Textarea schließen.
    ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.stopPropagation(); });
    container.appendChild(ta);
    if (long) {
        container.classList.add('ccs-collapsible', 'ccs-collapsed');
        const toggle = el('button', { className: 'ccs-collapse-toggle menu_button', text: 'Vollansicht' });
        toggle.type = 'button';
        toggle.addEventListener('click', () => {
            container.classList.toggle('ccs-collapsed');
            toggle.textContent = container.classList.contains('ccs-collapsed') ? 'Vollansicht' : 'Einklappen';
        });
        container.appendChild(toggle);
    }
    return container;
}

// Bei Textarea-Wrap liegt das <textarea> drin; sonst kriegen wir direkt das <input>
function inputOf(fieldEl) {
    return fieldEl.querySelector('textarea, input, select') || fieldEl;
}

function selectField(options, current, opts = {}) {
    const s = el('select', { className: 'text_pole ccs-field-input' });
    if (opts.dataField) s.dataset.field = opts.dataField;
    for (const v of options) {
        const o = el('option', { text: v });
        o.value = v;
        if (v === current) o.selected = true;
        s.appendChild(o);
    }
    return s;
}

function commaInput(arr = [], opts = {}) {
    return textInput(Array.isArray(arr) ? arr.join(', ') : '', {
        placeholder: 'kommagetrennt…',
        dataField: opts.dataField,
    });
}

function parseCommaList(str) {
    if (typeof str !== 'string') return [];
    return str.split(',').map(s => s.trim()).filter(Boolean);
}

function escapeText(str) {
    const t = document.createTextNode(String(str ?? ''));
    const d = document.createElement('div');
    d.appendChild(t);
    return d.innerHTML;
}

// =============================================================================
// Brain-Index – einmal pro Popup aufbauen; fließt in Validation + Reference-Checks
// =============================================================================

function buildBrainIndex(migratedBrainXml) {
    const charNames = new Set();
    const locNames = new Set();
    const arcIds = new Set();
    const relPairs = new Set();
    const allIds = new Set();

    try {
        const doc = new DOMParser().parseFromString(migratedBrainXml, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('brain unparseable');
        for (const c of doc.querySelectorAll('characters > character')) {
            const n = c.getAttribute('name'); if (n) charNames.add(n);
            const id = c.getAttribute('id'); if (id) allIds.add(id);
        }
        for (const l of doc.querySelectorAll('locations > location')) {
            const n = l.getAttribute('name'); if (n) locNames.add(n);
            const id = l.getAttribute('id'); if (id) allIds.add(id);
        }
        for (const a of doc.querySelectorAll('arcs > arc')) {
            const id = a.getAttribute('id'); if (id) { arcIds.add(id); allIds.add(id); }
        }
        for (const r of doc.querySelectorAll('relationships > relationship')) {
            const f = r.getAttribute('from'); const t = r.getAttribute('to');
            if (f && t) relPairs.add(`${f}||${t}`);
            const id = r.getAttribute('id'); if (id) allIds.add(id);
        }
        for (const km of doc.querySelectorAll('key_moments > key_moment')) {
            const id = km.getAttribute('id'); if (id) allIds.add(id);
        }
        for (const p of doc.querySelectorAll('pinned > pin')) {
            const id = p.getAttribute('id'); if (id) allIds.add(id);
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} buildBrainIndex failed – popup läuft mit leerem Index:`, e);
    }

    return { charNames, locNames, arcIds, relPairs, allIds };
}

// =============================================================================
// Card-Builder – pro Kategorie genau eine Funktion, die das Card-DOM +
// { getValues(), validate(effIdx) } liefert.
// =============================================================================

/**
 * Base-Card: Checkbox + Titel + optional Icon + ID-Zeile. Content-Area wird
 * von der aufrufenden Spezialfunktion befüllt.
 */
function makeCard(category, title, opts = {}) {
    const root = el('div', { className: 'ccs-card' });
    root.dataset.category = category;

    const header = el('div', { className: 'ccs-card-header' });
    const cb = el('input', { attrs: { type: 'checkbox' }, className: 'ccs-card-checkbox' });
    cb.checked = true;
    header.appendChild(cb);

    if (CATEGORY_META[category]?.icon) {
        header.appendChild(el('i', { className: `fa-solid ${CATEGORY_META[category].icon} ccs-card-icon` }));
    }
    header.appendChild(el('span', { className: 'ccs-card-title', text: title || '' }));
    root.appendChild(header);

    const body = el('div', { className: 'ccs-card-body' });
    root.appendChild(body);

    let idRow = null;
    if (opts.showId) {
        idRow = el('div', { className: 'ccs-card-id', text: `ID: ${opts.initialId || ''}` });
        root.appendChild(idRow);
    }

    // Disabled-Visuals an Checkbox koppeln
    const reflectChecked = () => {
        root.classList.toggle('ccs-card-disabled', !cb.checked);
    };
    cb.addEventListener('change', reflectChecked);
    reflectChecked();

    return { root, header, body, checkbox: cb, idRow };
}

// --- Einzelne Card-Funktionen ---------------------------------------------

function cardNewCharacter(proposal, existingIds) {
    const card = makeCard('new_characters', proposal.name || '(unbenannt)', {
        showId: true, initialId: proposal.id,
    });
    const fName = labeledInput('Name*', textInput(proposal.name, { dataField: 'name' }), { required: true });
    const fCore = labeledInput('Kern*', textareaField(proposal.core, { dataField: 'core' }), { required: true });
    const fAppearance = labeledInput('Aussehen', textareaField(proposal.appearance, { dataField: 'appearance' }));
    const fQuirks = labeledInput('Eigenheiten', textareaField(proposal.quirks, { dataField: 'quirks' }));
    const fBackground = labeledInput('Hintergrund', textareaField(proposal.background, { dataField: 'background' }));
    const fAliases = labeledInput('Aliasse', commaInput(proposal.aliases, { dataField: 'aliases' }));

    card.body.append(fName, fCore, fAppearance, fQuirks, fBackground, fAliases);

    // Live-ID-Update beim Tippen im Name-Feld
    const nameInput = inputOf(fName);
    const reflectId = () => {
        const seed = nameInput.value.trim() || 'unnamed';
        const live = new Set(existingIds); // klonen, sonst verschieben wir die Kollisions-Kette
        live.delete(proposal.id);          // eigene alte ID freigeben für Self-Stabilität
        const newId = generateId('char', seed, live);
        card.root.dataset.liveId = newId;
        card.idRow.textContent = `ID: ${newId}`;
    };
    nameInput.addEventListener('input', reflectId);
    reflectId();

    return {
        ...card,
        getValues: () => ({
            category: 'new_characters',
            id: card.root.dataset.liveId || proposal.id,
            name: inputOf(fName).value.trim(),
            core: inputOf(fCore).value,
            appearance: inputOf(fAppearance).value,
            quirks: inputOf(fQuirks).value,
            background: inputOf(fBackground).value,
            aliases: parseCommaList(inputOf(fAliases).value),
        }),
        validate: (eff) => {
            const v = { category: 'new_characters' };
            const name = inputOf(fName).value.trim();
            const core = inputOf(fCore).value.trim();
            if (!name) return { msg: 'Name ist Pflicht', el: inputOf(fName) };
            if (!core) return { msg: 'Kern ist Pflicht', el: inputOf(fCore) };
            // Namenskonflikt gegen bestehende Chars (ohne eff.charNames des eigenen Batches)
            // Achtung: effCharNames enthält ggf. schon diesen Namen (weil wir oben hinzugefügt haben).
            // Dedupe-Check erfolgt zentral in validate() über effCharNamesAll.
            return null;
        },
    };
}

function cardNewLocation(proposal, existingIds) {
    const card = makeCard('new_locations', proposal.name || '(unbenannt)', {
        showId: true, initialId: proposal.id,
    });
    const fName = labeledInput('Name*', textInput(proposal.name, { dataField: 'name' }), { required: true });
    const fDesc = labeledInput('Beschreibung*', textareaField(proposal.description, { dataField: 'description' }), { required: true });
    const fAtm = labeledInput('Atmosphäre', textInput(proposal.atmosphere, { dataField: 'atmosphere' }));
    const fEvents = labeledInput('Ereignisse hier', commaInput(proposal.events_here, { dataField: 'events_here' }));

    card.body.append(fName, fDesc, fAtm, fEvents);

    const nameInput = inputOf(fName);
    const reflectId = () => {
        const seed = nameInput.value.trim() || 'unnamed';
        const live = new Set(existingIds); live.delete(proposal.id);
        const newId = generateId('loc', seed, live);
        card.root.dataset.liveId = newId;
        card.idRow.textContent = `ID: ${newId}`;
    };
    nameInput.addEventListener('input', reflectId);
    reflectId();

    return {
        ...card,
        getValues: () => ({
            category: 'new_locations',
            id: card.root.dataset.liveId || proposal.id,
            name: inputOf(fName).value.trim(),
            description: inputOf(fDesc).value,
            atmosphere: inputOf(fAtm).value,
            events_here: parseCommaList(inputOf(fEvents).value),
        }),
        validate: () => {
            if (!inputOf(fName).value.trim()) return { msg: 'Name ist Pflicht', el: inputOf(fName) };
            if (!inputOf(fDesc).value.trim()) return { msg: 'Beschreibung ist Pflicht', el: inputOf(fDesc) };
            return null;
        },
    };
}

function cardNewArc(proposal, existingIds) {
    const card = makeCard('new_arcs', proposal.title || '(kein Titel)', {
        showId: true, initialId: proposal.id,
    });
    const fTitle = labeledInput('Titel*', textInput(proposal.title, { dataField: 'title' }), { required: true });
    const fTension = labeledInput('Spannung*', textareaField(proposal.tension, { dataField: 'tension' }), { required: true });
    const fThreads = labeledInput('Offene Stränge', commaInput(proposal.open_threads, { dataField: 'open_threads' }));
    const fGrowth = labeledInput('Wachstumschance', textareaField(proposal.growth_opportunities, { dataField: 'growth_opportunities' }));

    card.body.append(fTitle, fTension, fThreads, fGrowth);

    const titleInput = inputOf(fTitle);
    const reflectId = () => {
        const seed = titleInput.value.trim() || 'arc';
        const live = new Set(existingIds); live.delete(proposal.id);
        const newId = generateId('arc', seed, live);
        card.root.dataset.liveId = newId;
        card.idRow.textContent = `ID: ${newId}`;
    };
    titleInput.addEventListener('input', reflectId);
    reflectId();

    return {
        ...card,
        getValues: () => ({
            category: 'new_arcs',
            id: card.root.dataset.liveId || proposal.id,
            title: inputOf(fTitle).value.trim(),
            tension: inputOf(fTension).value,
            open_threads: parseCommaList(inputOf(fThreads).value),
            growth_opportunities: inputOf(fGrowth).value,
        }),
        validate: () => {
            if (!inputOf(fTitle).value.trim()) return { msg: 'Titel ist Pflicht', el: inputOf(fTitle) };
            if (!inputOf(fTension).value.trim()) return { msg: 'Spannung ist Pflicht', el: inputOf(fTension) };
            return null;
        },
    };
}

function cardNewKeyMoment(proposal, existingIds) {
    const titleStr = proposal.summary ? proposal.summary.slice(0, 60) + (proposal.summary.length > 60 ? '…' : '') : '(leer)';
    const card = makeCard('new_key_moments', titleStr, { showId: true, initialId: proposal.id });

    const fWhen = labeledInput('Wann*', textInput(proposal.when, { dataField: 'when' }), { required: true });
    const fWhere = labeledInput('Wo*', textInput(proposal.where, { dataField: 'where' }), { required: true });
    const fWho = labeledInput('Wer* (kommagetrennt, muss im Brain existieren)', commaInput(proposal.who, { dataField: 'who' }), { required: true });
    const fSummary = labeledInput('Zusammenfassung*', textareaField(proposal.summary, { dataField: 'summary' }), { required: true });
    const fImportance = labeledInput('Wichtigkeit*', selectField(IMPORTANCE_ENUM, proposal.importance || 'medium', { dataField: 'importance' }), { required: true });
    const fVerbatim = labeledInput('Wortlaut', textareaField(proposal.verbatim, { dataField: 'verbatim' }));
    const fTags = labeledInput('Tags', commaInput(proposal.tags, { dataField: 'tags' }));
    const fImpact = labeledInput('Auswirkung', textareaField(proposal.impact, { dataField: 'impact' }));

    card.body.append(fWhen, fWhere, fWho, fSummary, fImportance, fVerbatim, fTags, fImpact);

    const summaryInput = inputOf(fSummary);
    const reflectId = () => {
        const seed = (summaryInput.value.trim() || 'moment').slice(0, 40);
        const live = new Set(existingIds); live.delete(proposal.id);
        const newId = generateId('km', seed, live);
        card.root.dataset.liveId = newId;
        card.idRow.textContent = `ID: ${newId}`;
    };
    summaryInput.addEventListener('input', reflectId);
    reflectId();

    return {
        ...card,
        getValues: () => ({
            category: 'new_key_moments',
            id: card.root.dataset.liveId || proposal.id,
            when: inputOf(fWhen).value.trim(),
            where: inputOf(fWhere).value.trim(),
            who: parseCommaList(inputOf(fWho).value),
            summary: inputOf(fSummary).value,
            importance: inputOf(fImportance).value,
            verbatim: inputOf(fVerbatim).value,
            tags: parseCommaList(inputOf(fTags).value),
            impact: inputOf(fImpact).value,
        }),
        validate: (eff) => {
            if (!inputOf(fWhen).value.trim()) return { msg: 'Wann ist Pflicht', el: inputOf(fWhen) };
            if (!inputOf(fWhere).value.trim()) return { msg: 'Wo ist Pflicht', el: inputOf(fWhere) };
            const who = parseCommaList(inputOf(fWho).value);
            if (!who.length) return { msg: 'Wer darf nicht leer sein', el: inputOf(fWho) };
            if (!inputOf(fSummary).value.trim()) return { msg: 'Zusammenfassung ist Pflicht', el: inputOf(fSummary) };
            if (!IMPORTANCE_ENUM.includes(inputOf(fImportance).value)) return { msg: 'Wichtigkeit ungültig', el: inputOf(fImportance) };
            const unknown = who.filter(w => !eff.charNames.has(w));
            if (unknown.length) return { msg: `Unbekannte Charaktere in "Wer": ${unknown.join(', ')}`, el: inputOf(fWho) };
            return null;
        },
    };
}

function cardNewRelationship(proposal, existingIds) {
    const card = makeCard('new_relationships', `${proposal.from || '?'} → ${proposal.to || '?'}`, {
        showId: true, initialId: proposal.id,
    });
    const fFrom = labeledInput('Von*', textInput(proposal.from, { dataField: 'from' }), { required: true });
    const fTo = labeledInput('Zu*', textInput(proposal.to, { dataField: 'to' }), { required: true });
    const fCurrent = labeledInput('Aktueller Stand*', textareaField(proposal.current, { dataField: 'current' }), { required: true });
    const fHistory = labeledInput('Historie', commaInput(proposal.history, { dataField: 'history' }));
    const fMoments = labeledInput('Schlüsselmomente', commaInput(proposal.key_moments, { dataField: 'key_moments' }));

    card.body.append(fFrom, fTo, fCurrent, fHistory, fMoments);

    const reflectId = () => {
        const f = inputOf(fFrom).value.trim() || 'x';
        const t = inputOf(fTo).value.trim() || 'y';
        const live = new Set(existingIds); live.delete(proposal.id);
        const newId = generateId('rel', `${f}_${t}`, live);
        card.root.dataset.liveId = newId;
        card.idRow.textContent = `ID: ${newId}`;
        // Titel aktualisieren
        card.header.querySelector('.ccs-card-title').textContent = `${f} → ${t}`;
    };
    inputOf(fFrom).addEventListener('input', reflectId);
    inputOf(fTo).addEventListener('input', reflectId);
    reflectId();

    return {
        ...card,
        getValues: () => ({
            category: 'new_relationships',
            id: card.root.dataset.liveId || proposal.id,
            from: inputOf(fFrom).value.trim(),
            to: inputOf(fTo).value.trim(),
            current: inputOf(fCurrent).value,
            history: parseCommaList(inputOf(fHistory).value),
            key_moments: parseCommaList(inputOf(fMoments).value),
        }),
        validate: (eff) => {
            const from = inputOf(fFrom).value.trim();
            const to = inputOf(fTo).value.trim();
            if (!from) return { msg: 'Von ist Pflicht', el: inputOf(fFrom) };
            if (!to) return { msg: 'Zu ist Pflicht', el: inputOf(fTo) };
            if (!inputOf(fCurrent).value.trim()) return { msg: 'Aktueller Stand ist Pflicht', el: inputOf(fCurrent) };
            if (!eff.charNames.has(from)) return { msg: `Unbekannter Charakter "${from}"`, el: inputOf(fFrom) };
            if (!eff.charNames.has(to)) return { msg: `Unbekannter Charakter "${to}"`, el: inputOf(fTo) };
            return null;
        },
    };
}

function cardNewWorldRule(proposal) {
    const card = makeCard('new_world_rules', (proposal.text || '').slice(0, 60) || '(leer)');
    const fText = labeledInput('Regel*', textareaField(proposal.text, { dataField: 'text' }), { required: true });
    card.body.append(fText);

    // Titel live halten
    inputOf(fText).addEventListener('input', () => {
        const t = inputOf(fText).value.trim();
        card.header.querySelector('.ccs-card-title').textContent = (t.slice(0, 60) || '(leer)') + (t.length > 60 ? '…' : '');
    });

    return {
        ...card,
        getValues: () => ({
            category: 'new_world_rules',
            text: inputOf(fText).value.trim(),
        }),
        validate: () => {
            if (!inputOf(fText).value.trim()) return { msg: 'Regel-Text darf nicht leer sein', el: inputOf(fText) };
            return null;
        },
    };
}

function cardNewPin(proposal, existingIds) {
    const card = makeCard('new_pins', (proposal.text || '').slice(0, 60) || '(leer)', {
        showId: true, initialId: proposal.id,
    });
    const fText = labeledInput('Pin-Text*', textareaField(proposal.text, { dataField: 'text' }), { required: true });
    card.body.append(fText);

    const reflectId = () => {
        const seed = inputOf(fText).value.trim() || 'pin';
        const live = new Set(existingIds); live.delete(proposal.id);
        const newId = generateId('pin', seed, live);
        card.root.dataset.liveId = newId;
        card.idRow.textContent = `ID: ${newId}`;
        const t = inputOf(fText).value.trim();
        card.header.querySelector('.ccs-card-title').textContent = (t.slice(0, 60) || '(leer)') + (t.length > 60 ? '…' : '');
    };
    inputOf(fText).addEventListener('input', reflectId);
    reflectId();

    return {
        ...card,
        getValues: () => ({
            category: 'new_pins',
            id: card.root.dataset.liveId || proposal.id,
            text: inputOf(fText).value.trim(),
        }),
        validate: () => {
            if (!inputOf(fText).value.trim()) return { msg: 'Pin-Text darf nicht leer sein', el: inputOf(fText) };
            return null;
        },
    };
}

function cardNewHistoryEntry(proposal, existingIds) {
    const titlePreview = (proposal.summary || '').slice(0, 60) || '(leer)';
    const card = makeCard('new_history_entries', titlePreview, {
        showId: true, initialId: proposal.id,
    });
    const fSummary = labeledInput('Zusammenfassung*', textareaField(proposal.summary, { dataField: 'summary' }), { required: true });
    const fScene = labeledInput('Szene / Kapitel', textInput(proposal.scene, { dataField: 'scene' }));
    const fTags = labeledInput('Tags', commaInput(proposal.tags, { dataField: 'tags' }));
    const fKeyOutcome = labeledInput('Ergebnis', textareaField(proposal.key_outcome, { dataField: 'key_outcome' }));
    const fInvolved = labeledInput('Beteiligte', commaInput(proposal.involved, { dataField: 'involved' }));

    card.body.append(fSummary, fScene, fTags, fKeyOutcome, fInvolved);

    const reflectId = () => {
        const seed = inputOf(fSummary).value.trim() || 'history';
        const live = new Set(existingIds); live.delete(proposal.id);
        const newId = generateId('h', seed, live);
        card.root.dataset.liveId = newId;
        card.idRow.textContent = `ID: ${newId}`;
        const t = inputOf(fSummary).value.trim();
        card.header.querySelector('.ccs-card-title').textContent = (t.slice(0, 60) || '(leer)') + (t.length > 60 ? '…' : '');
    };
    inputOf(fSummary).addEventListener('input', reflectId);
    reflectId();

    return {
        ...card,
        getValues: () => ({
            category: 'new_history_entries',
            id: card.root.dataset.liveId || proposal.id,
            summary: inputOf(fSummary).value.trim(),
            scene: inputOf(fScene).value.trim(),
            tags: parseCommaList(inputOf(fTags).value),
            key_outcome: inputOf(fKeyOutcome).value.trim(),
            involved: parseCommaList(inputOf(fInvolved).value),
        }),
        validate: (eff) => {
            const summary = inputOf(fSummary).value.trim();
            if (!summary) return { msg: 'Zusammenfassung ist Pflicht', el: inputOf(fSummary) };
            const involved = parseCommaList(inputOf(fInvolved).value);
            const unknown = involved.filter(n => !eff.charNames.has(n));
            if (unknown.length) return { msg: `Unbekannte Beteiligte: ${unknown.join(', ')}`, el: inputOf(fInvolved) };
            return null;
        },
    };
}

function cardCharacterFieldUpdate(proposal) {
    const card = makeCard('character_field_updates', `${proposal.character || '?'}: ${proposal.field || '?'}`);
    const fChar = labeledInput('Charakter*', textInput(proposal.character, { dataField: 'character' }), { required: true });
    const fField = labeledInput('Feld*', selectField(CHAR_FIELD_ENUM, proposal.field || 'current_state', { dataField: 'field' }), { required: true });
    const fNew = labeledInput('Neuer Wert*', textareaField(proposal.new, { dataField: 'new' }), { required: true });
    const fReason = labeledInput('Grund', textareaField(proposal.reason, { dataField: 'reason' }));

    card.body.append(fChar, fField, fNew, fReason);

    const updateTitle = () => {
        card.header.querySelector('.ccs-card-title').textContent =
            `${inputOf(fChar).value.trim() || '?'}: ${inputOf(fField).value || '?'}`;
    };
    inputOf(fChar).addEventListener('input', updateTitle);
    inputOf(fField).addEventListener('change', updateTitle);

    return {
        ...card,
        getValues: () => ({
            category: 'character_field_updates',
            character: inputOf(fChar).value.trim(),
            field: inputOf(fField).value,
            new: inputOf(fNew).value,
            reason: inputOf(fReason).value,
        }),
        validate: (eff) => {
            const c = inputOf(fChar).value.trim();
            const f = inputOf(fField).value;
            if (!c) return { msg: 'Charakter ist Pflicht', el: inputOf(fChar) };
            if (!CHAR_FIELD_ENUM.includes(f)) return { msg: `Ungültiges Feld "${f}"`, el: inputOf(fField) };
            if (typeof inputOf(fNew).value !== 'string' || !inputOf(fNew).value.length) {
                return { msg: 'Neuer Wert darf nicht leer sein', el: inputOf(fNew) };
            }
            if (!eff.charNames.has(c)) return { msg: `Unbekannter Charakter "${c}"`, el: inputOf(fChar) };
            return null;
        },
    };
}

function cardRelationshipUpdate(proposal) {
    const card = makeCard('relationship_updates', `${proposal.from || '?'} → ${proposal.to || '?'}`);
    const fFrom = labeledInput('Von*', textInput(proposal.from, { dataField: 'from' }), { required: true });
    const fTo = labeledInput('Zu*', textInput(proposal.to, { dataField: 'to' }), { required: true });
    const fDelta = labeledInput('Delta*', textareaField(proposal.delta, { dataField: 'delta' }), { required: true });
    const fReason = labeledInput('Grund*', textareaField(proposal.reason, { dataField: 'reason' }), { required: true });
    const fNewCurrent = labeledInput('Neuer Stand (optional, überschreibt <current>)', textareaField(proposal.new_current, { dataField: 'new_current' }));

    card.body.append(fFrom, fTo, fDelta, fReason, fNewCurrent);

    const updateTitle = () => {
        card.header.querySelector('.ccs-card-title').textContent =
            `${inputOf(fFrom).value.trim() || '?'} → ${inputOf(fTo).value.trim() || '?'}`;
    };
    inputOf(fFrom).addEventListener('input', updateTitle);
    inputOf(fTo).addEventListener('input', updateTitle);

    return {
        ...card,
        getValues: () => ({
            category: 'relationship_updates',
            from: inputOf(fFrom).value.trim(),
            to: inputOf(fTo).value.trim(),
            delta: inputOf(fDelta).value,
            reason: inputOf(fReason).value,
            new_current: inputOf(fNewCurrent).value,
        }),
        validate: (eff) => {
            const from = inputOf(fFrom).value.trim();
            const to = inputOf(fTo).value.trim();
            if (!from) return { msg: 'Von ist Pflicht', el: inputOf(fFrom) };
            if (!to) return { msg: 'Zu ist Pflicht', el: inputOf(fTo) };
            if (!inputOf(fDelta).value.trim()) return { msg: 'Delta ist Pflicht', el: inputOf(fDelta) };
            if (!inputOf(fReason).value.trim()) return { msg: 'Grund ist Pflicht', el: inputOf(fReason) };
            if (!eff.relPairs.has(`${from}||${to}`)) {
                return { msg: `Beziehung ${from}→${to} existiert nicht`, el: inputOf(fFrom) };
            }
            return null;
        },
    };
}

function cardArcUpdate(proposal) {
    const card = makeCard('arc_updates', proposal.id || '(keine ID)');
    const fId = labeledInput('Arc-ID*', textInput(proposal.id, { dataField: 'id' }), { required: true });
    const fChange = labeledInput('Änderungstyp*', selectField(ARC_CHANGE_ENUM, proposal.change_type || 'status', { dataField: 'change_type' }), { required: true });
    // new_value wird abhängig von change_type gerendert; wir rendern alle drei,
    // blenden per CSS aus, was gerade nicht aktiv ist. So bleibt getValues() ohne Re-Render.
    const fStatus = labeledInput('Neuer Status*', selectField(ARC_STATUS_ENUM, typeof proposal.new_value === 'string' ? proposal.new_value : 'active', { dataField: 'new_value_status' }), { required: true });
    const fThreads = labeledInput('Neue Stränge* (kommagetrennt)', commaInput(Array.isArray(proposal.new_value) ? proposal.new_value : [], { dataField: 'new_value_threads' }), { required: true });
    const fGrowth = labeledInput('Neue Wachstumschance*', textareaField(typeof proposal.new_value === 'string' ? proposal.new_value : '', { dataField: 'new_value_growth' }), { required: true });
    const fReason = labeledInput('Grund', textareaField(proposal.reason, { dataField: 'reason' }));

    card.body.append(fId, fChange, fStatus, fThreads, fGrowth, fReason);

    const reflectVariant = () => {
        const t = inputOf(fChange).value;
        fStatus.style.display = t === 'status' ? '' : 'none';
        fThreads.style.display = t === 'threads' ? '' : 'none';
        fGrowth.style.display = t === 'growth_opportunities' ? '' : 'none';
        card.header.querySelector('.ccs-card-title').textContent =
            `${inputOf(fId).value.trim() || '?'} (${t || '?'})`;
    };
    inputOf(fChange).addEventListener('change', reflectVariant);
    inputOf(fId).addEventListener('input', reflectVariant);
    reflectVariant();

    return {
        ...card,
        getValues: () => {
            const t = inputOf(fChange).value;
            let new_value;
            if (t === 'status') new_value = inputOf(fStatus).value;
            else if (t === 'threads') new_value = parseCommaList(inputOf(fThreads).value);
            else new_value = inputOf(fGrowth).value;
            return {
                category: 'arc_updates',
                id: inputOf(fId).value.trim(),
                change_type: t,
                new_value,
                reason: inputOf(fReason).value,
            };
        },
        validate: (eff) => {
            const id = inputOf(fId).value.trim();
            const t = inputOf(fChange).value;
            if (!id) return { msg: 'Arc-ID ist Pflicht', el: inputOf(fId) };
            if (!ARC_CHANGE_ENUM.includes(t)) return { msg: 'Änderungstyp ungültig', el: inputOf(fChange) };
            if (!eff.arcIds.has(id)) return { msg: `Arc "${id}" existiert nicht`, el: inputOf(fId) };
            if (t === 'status') {
                if (!ARC_STATUS_ENUM.includes(inputOf(fStatus).value)) return { msg: 'Status ungültig', el: inputOf(fStatus) };
            } else if (t === 'threads') {
                const arr = parseCommaList(inputOf(fThreads).value);
                if (!arr.length) return { msg: 'Mindestens einen Strang angeben', el: inputOf(fThreads) };
            } else {
                if (!inputOf(fGrowth).value.trim()) return { msg: 'Wachstumschance-Wert fehlt', el: inputOf(fGrowth) };
            }
            return null;
        },
    };
}

function cardSceneUpdate(proposal) {
    const card = makeCard('scene_update', proposal.location || 'Szene');
    const fLoc = labeledInput('Ort*', textInput(proposal.location, { dataField: 'location' }), { required: true });
    const fPresent = labeledInput('Anwesende* (kommagetrennt)', commaInput(proposal.present, { dataField: 'present' }), { required: true });
    const fTime = labeledInput('Zeit', textInput(proposal.time, { dataField: 'time' }));
    const fMood = labeledInput('Stimmung', textInput(proposal.mood, { dataField: 'mood' }));
    const fTension = labeledInput('Aktive Spannung', textInput(proposal.active_tension, { dataField: 'active_tension' }));

    card.body.append(fLoc, fPresent, fTime, fMood, fTension);

    inputOf(fLoc).addEventListener('input', () => {
        card.header.querySelector('.ccs-card-title').textContent = inputOf(fLoc).value.trim() || 'Szene';
    });

    return {
        ...card,
        getValues: () => ({
            category: 'scene_update',
            location: inputOf(fLoc).value.trim(),
            present: parseCommaList(inputOf(fPresent).value),
            time: inputOf(fTime).value,
            mood: inputOf(fMood).value,
            active_tension: inputOf(fTension).value,
        }),
        validate: (eff) => {
            if (!inputOf(fLoc).value.trim()) return { msg: 'Ort ist Pflicht', el: inputOf(fLoc) };
            const present = parseCommaList(inputOf(fPresent).value);
            if (!present.length) return { msg: 'Anwesende darf nicht leer sein', el: inputOf(fPresent) };
            const unknown = present.filter(n => !eff.charNames.has(n));
            if (unknown.length) return { msg: `Unbekannte Anwesende: ${unknown.join(', ')}`, el: inputOf(fPresent) };
            return null;
        },
    };
}

// =============================================================================
// Router: passende Card-Funktion pro Kategorie
// =============================================================================

const CARD_BUILDERS = {
    new_characters: cardNewCharacter,
    new_locations: cardNewLocation,
    new_arcs: cardNewArc,
    new_key_moments: cardNewKeyMoment,
    new_relationships: cardNewRelationship,
    new_world_rules: cardNewWorldRule,
    new_pins: cardNewPin,
    character_field_updates: cardCharacterFieldUpdate,
    relationship_updates: cardRelationshipUpdate,
    arc_updates: cardArcUpdate,
    scene_update: cardSceneUpdate,
    new_history_entries: cardNewHistoryEntry,
};

// =============================================================================
// Haupt-Funktion
// =============================================================================

/**
 * Rendert das Update-Popup und liefert die API zurück, die der Orchestrator
 * in `index.js` braucht.
 *
 * @param {object} opts
 * @param {Array}  opts.proposals           – aus updater.runUpdate
 * @param {string} opts.migratedBrainXml    – für Referenz-Integritäts-Check
 * @param {string} [opts.reasoning]         – LLM-Reasoning für Header
 * @returns {{ wrapper: HTMLElement, collectApproved(): Array, validate(): {ok:boolean, error?:string, focusEl?:HTMLElement} }}
 */
export function renderUpdatePopup({ proposals, migratedBrainXml, reasoning }) {
    const brainIndex = buildBrainIndex(migratedBrainXml || '<brain></brain>');

    // existingIds wandert durch ALLE Card-Builder, damit frische IDs kollisionsfrei sind.
    // Wir klonen den Satz pro Card (in den reflectId-Closures), damit User-Edits
    // nicht permanent den Zähler hochschrauben.
    const existingIds = new Set(brainIndex.allIds);

    const wrapper = document.createElement('div');
    wrapper.className = 'ccs-update-popup';

    // Header -----------------------------------------------------------------
    const header = el('div', { className: 'ccs-update-header' });
    const h = el('h3', { text: 'Vorschläge – Brain-Update' });
    header.appendChild(h);
    if (reasoning && reasoning.trim()) {
        const r = el('div', { className: 'ccs-reasoning' });
        r.innerHTML = `<b>Reasoning:</b> ${escapeText(reasoning)}`;
        header.appendChild(r);
    }
    const toolbar = el('div', { className: 'ccs-toolbar' });
    const counter = el('span', { className: 'ccs-counter', text: '0 / 0 ausgewählt' });
    const btnAll = el('button', { className: 'ccs-qa-all menu_button', text: 'Alle wählen' });
    btnAll.type = 'button';
    const btnNone = el('button', { className: 'ccs-qa-none menu_button', text: 'Nichts wählen' });
    btnNone.type = 'button';
    toolbar.append(counter, btnAll, btnNone);
    header.appendChild(toolbar);
    wrapper.appendChild(header);

    // Gruppieren nach Kategorie ---------------------------------------------
    const byCat = {};
    for (const p of (proposals || [])) {
        const k = p?.category;
        if (!k) continue;
        (byCat[k] ??= []).push(p);
    }

    const cards = [];
    for (const category of Object.keys(CATEGORY_META)) {
        const list = byCat[category];
        if (!list || !list.length) continue;

        const section = el('section', { className: 'ccs-section' });
        const sh = el('div', { className: 'ccs-section-header' });
        sh.innerHTML = `<i class="fa-solid ${CATEGORY_META[category].icon}"></i> <b>${escapeText(CATEGORY_META[category].title)}</b> <span class="ccs-section-count">(${list.length})</span>`;
        section.appendChild(sh);

        const builder = CARD_BUILDERS[category];
        if (!builder) {
            console.warn(`${LOG_PREFIX} renderUpdatePopup: no builder for category "${category}"`);
            continue;
        }
        for (const proposal of list) {
            const card = builder(proposal, existingIds);
            cards.push(card);
            section.appendChild(card.root);
        }
        wrapper.appendChild(section);
    }

    // Hinweis wenn leer ------------------------------------------------------
    if (cards.length === 0) {
        wrapper.appendChild(el('div', {
            className: 'ccs-empty-hint',
            text: 'Keine Vorschläge – Popup dient nur zur Information.',
        }));
    }

    // Counter live halten ----------------------------------------------------
    const refreshCounter = () => {
        const sel = cards.filter(c => c.checkbox.checked).length;
        counter.textContent = `${sel} / ${cards.length} ausgewählt`;
    };
    for (const c of cards) c.checkbox.addEventListener('change', refreshCounter);
    btnAll.addEventListener('click', () => {
        for (const c of cards) { c.checkbox.checked = true; c.root.classList.remove('ccs-card-disabled'); }
        refreshCounter();
    });
    btnNone.addEventListener('click', () => {
        for (const c of cards) { c.checkbox.checked = false; c.root.classList.add('ccs-card-disabled'); }
        refreshCounter();
    });
    refreshCounter();

    // API --------------------------------------------------------------------
    function collectApproved() {
        return cards.filter(c => c.checkbox.checked).map(c => c.getValues());
    }

    function validate() {
        // Vorherige Error-Markierungen wegputzen
        wrapper.querySelectorAll('.ccs-field-error').forEach(e => e.classList.remove('ccs-field-error'));

        const selected = cards.filter(c => c.checkbox.checked);

        // Effektiver Namensraum: Brain + angehakte new_*
        const effCharNames = new Set(brainIndex.charNames);
        const effLocNames = new Set(brainIndex.locNames);
        const effArcIds = new Set(brainIndex.arcIds);
        const effRelPairs = new Set(brainIndex.relPairs);
        for (const c of selected) {
            const v = c.getValues();
            if (v.category === 'new_characters' && v.name) effCharNames.add(v.name);
            if (v.category === 'new_locations' && v.name) effLocNames.add(v.name);
            if (v.category === 'new_arcs' && v.id) effArcIds.add(v.id);
            if (v.category === 'new_relationships' && v.from && v.to) effRelPairs.add(`${v.from}||${v.to}`);
        }
        const eff = { charNames: effCharNames, locNames: effLocNames, arcIds: effArcIds, relPairs: effRelPairs };

        for (const c of selected) {
            const err = c.validate(eff);
            if (err) {
                if (err.el) err.el.classList.add('ccs-field-error');
                return { ok: false, error: err.msg, focusEl: err.el || null };
            }
        }
        return { ok: true };
    }

    return { wrapper, collectApproved, validate };
}
