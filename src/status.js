// Status: liest die Statusfenster aus KI-Antworten (RPG-Presets) und
// übernimmt sie deterministisch ins Brain – ohne LLM-Call.
//
// Erwartetes Format (tolerant, Felder dürfen fehlen, Reihenfolge egal):
//   **Ort — Region**
//   **Tag 1 · Abenddämmerung · ARC I: Name**
//   ═══════════════
//    NAME: Tay (alias „Kael")      LEVEL: 1
//    TITEL: …   XP: 0 / 100   GELD: 3G 42S 15K   GRÖSSE: Mittel – 1,79 m
//   ═══════════════
//    STR 12 | AGI 11 | …            (oder eine Zeile pro Attribut)
//    HP = 102 / 102 | MP = 160      (Rechenwege „= 50 + … = 722“ erlaubt)
//    FÄHIGKEITEN: [Jägersinn (St.1/5)] …
//    AUSRÜSTUNG:  Waffe: … / Rüstung: … / Acc: …
//    INVENTAR: …   ZUSTÄNDE: …
//   ═══════════════
//
// Pure Functions, nur applyStatusToBrain arbeitet auf einem XML-String.

const SEPARATOR = /^\s*[═]{8,}\s*$/;
const ATTRS = ['STR', 'AGI', 'VIT', 'INT', 'WIS', 'DEX', 'LUK'];
/** Schlüssel, die ein neues Feld beginnen (für mehrzeilige Felder). */
const KEY_LINE = /^\s*(NAME|LEVEL|TITEL|XP|GRUPPE|GILDE|GILDENRANG|GRÖSSE|GELD|BEZIEHUNG|ATTRIBUTE|ABGELEITET|FÄHIGKEITEN|AUSRÜSTUNG|INVENTAR|ZUSTÄNDE|FREIE PUNKTE)\s*:/i;
const EMPTY = /^[—–\-\s]*$/;

/** Bereich des Statusfensters: erste bis letzte Trennlinie – nur wenn er Werte enthält. */
function statusRange(lines) {
    let first = -1;
    let last = -1;
    lines.forEach((l, i) => {
        if (SEPARATOR.test(l)) {
            if (first < 0) first = i;
            last = i;
        }
    });
    if (first < 0 || last <= first) return null;
    const body = lines.slice(first, last + 1).join('\n');
    if (!/\bNAME\s*:|\bSTR\s+\d|\bHP\s*=/.test(body)) return null;
    return { first, last };
}

/** Fett gedruckte Kopfzeilen (Ort, Zeit/ARC) direkt vor dem Statusfenster. */
function headerLines(lines, first) {
    const out = [];
    for (let i = 0; i < first; i++) {
        const m = /^\s*\*\*(.+?)\*\*\s*$/.exec(lines[i]);
        if (m) out.push({ index: i, text: m[1].trim() });
        else if (lines[i].trim()) return [];   // Fließtext vor dem Block → keine Kopfzeilen
    }
    return out;
}

/**
 * Wert eines Feldes. Felder können sich eine Zeile teilen
 * („TITEL: —      XP: 0 / 100“) – der Wert endet vor 2+ Leerzeichen + nächstem SCHLÜSSEL:.
 * @returns {string|null|undefined} undefined = Feld fehlt, null = Feld leer („—“)
 */
function field(text, key) {
    const re = new RegExp(`(?:^|\\s)${key}\\s*:[ \\t]*(.*?)(?=\\s{2,}[A-ZÄÖÜ][A-ZÄÖÜ ]*:|$)`, 'm');
    const m = re.exec(text);
    if (!m) return undefined;
    const v = m[1].trim();
    return EMPTY.test(v) ? null : v;
}

/** Mehrzeiliges Feld: Wert der Schlüsselzeile + eingerückte Folgezeilen bis zum nächsten Schlüssel. */
function block(lines, key) {
    const start = lines.findIndex(l => new RegExp(`^\\s*${key}\\s*:`, 'i').test(l));
    if (start < 0) return undefined;
    const out = [];
    const first = lines[start].replace(new RegExp(`^\\s*${key}\\s*:`, 'i'), '').trim();
    if (first && !EMPTY.test(first)) out.push(first);
    for (let i = start + 1; i < lines.length; i++) {
        if (KEY_LINE.test(lines[i]) || SEPARATOR.test(lines[i])) break;
        const t = lines[i].trim();
        if (t && !EMPTY.test(t)) out.push(t);
    }
    return out.length ? out : null;
}

/** „102 / 102“ → „102/102“; Rechenwege „50 + 74×4 = 722“ → „722“. */
function pool(text, key) {
    const m = new RegExp(`\\b${key}\\s*=\\s*([^|\\n]+)`).exec(text);
    if (!m) return undefined;
    const seg = m[1].replace(/\(.*?\)/g, '').trim();
    const frac = /([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(seg);
    if (frac) return `${frac[1]}/${frac[2]}`;
    const nums = seg.match(/[\d.]+/g);
    return nums ? nums[nums.length - 1] : undefined;
}

/** „Tay (alias „Kael")“ → ['Tay', 'Kael'] */
function parseNames(raw) {
    const m = /^(.*?)\s*\(\s*alias\s+[„"'“]?([^"“”'()]+?)["“”']?\s*\)/i.exec(raw);
    if (m) return [m[1].trim(), m[2].trim()].filter(Boolean);
    return [raw.trim()];
}

function parseSheet(text) {
    const lines = text.split('\n');
    const nameRaw = field(text, 'NAME');
    if (!nameRaw) return null;
    const sheet = { names: parseNames(nameRaw), data: {} };
    const d = sheet.data;

    const set = (key, value) => { if (value !== undefined) d[key] = value; };
    set('level', field(text, 'LEVEL'));
    set('xp', field(text, 'XP'));
    set('title', field(text, 'TITEL'));
    set('money', field(text, 'GELD'));
    set('size', field(text, 'GRÖSSE'));
    set('group', field(text, 'GRUPPE'));
    set('guild', field(text, 'GILDE'));

    const attrs = ATTRS.map(a => {
        const m = new RegExp(`\\b${a}\\s+(\\d+)`).exec(text);
        return m ? `${a} ${m[1]}` : null;
    }).filter(Boolean);
    if (attrs.length) d.attrs = attrs.join(' ');
    set('hp', pool(text, 'HP'));
    set('mp', pool(text, 'MP'));

    const abilities = block(lines, 'FÄHIGKEITEN');
    if (abilities !== undefined) {
        const names = abilities === null ? [] : [...abilities.join('\n').matchAll(/([^\[\]\n|·–]+?)\s*\(\s*St\.\s*(\d+)\s*\/\s*(\d+)\s*\)/g)]
            .map(m => `${m[1].replace(/^[\s\-–•]+/, '').trim()} St.${m[2]}/${m[3]}`);
        d.abilities = names.length ? names.join(', ') : null;
    }

    const equipment = block(lines, 'AUSRÜSTUNG');
    if (equipment !== undefined) {
        const items = (equipment || [])
            .map(l => l.replace(/\s{2,}/g, ' ').replace(/\s*·?\s*Effekt:\s*[—–-]?\s*$/, '').trim())
            .filter(l => !/^[^:]+:\s*[—–-]?\s*$/.test(l));
        d.equipment = items.length ? items.join('; ') : null;
    }

    set('inventory', field(text, 'INVENTAR'));
    set('conditions', field(text, 'ZUSTÄNDE'));
    return sheet;
}

/**
 * Liest Kopfzeilen + Statusfenster einer Nachricht.
 * @param {string} text
 * @returns {{ location?: string, time?: string, chapter?: string, sheets: Array<{ names: string[], data: object }> } | null}
 */
export function parseStatus(text) {
    if (typeof text !== 'string' || !text) return null;
    const lines = text.split('\n');
    const range = statusRange(lines);
    if (!range) return null;

    const result = { sheets: [] };
    const header = headerLines(lines, range.first);
    if (header[0]) result.location = header[0].text.split(/\s+[—–]\s+/)[0].trim();
    if (header[1]) {
        const parts = header[1].text.split('·').map(s => s.trim()).filter(Boolean);
        const arc = parts.find(p => /^ARC\b/i.test(p));
        if (arc) result.chapter = arc;
        const time = parts.filter(p => p !== arc).join(' · ');
        if (time) result.time = time;
    }

    // In Charakterblätter aufteilen: jedes beginnt mit einer NAME:-Zeile.
    const region = lines.slice(range.first, range.last + 1);
    const starts = region.map((l, i) => (/^\s*NAME\s*:/i.test(l) ? i : -1)).filter(i => i >= 0);
    starts.forEach((s, k) => {
        const sheet = parseSheet(region.slice(s, starts[k + 1] ?? region.length).join('\n'));
        if (sheet) result.sheets.push(sheet);
    });
    return result.sheets.length || result.location || result.time ? result : null;
}

/**
 * Entfernt Kopfzeilen + Statusfenster aus einer Nachricht (für ältere Nachrichten
 * im Prompt und für das Update-LLM – die Werte stehen ja im Brain).
 * @param {string} text
 * @returns {string}
 */
export function stripStatus(text) {
    if (typeof text !== 'string' || !text) return text;
    const lines = text.split('\n');
    const range = statusRange(lines);
    if (!range) return text;
    const header = headerLines(lines, range.first);
    const from = header.length ? header[0].index : range.first;
    return [...lines.slice(0, from), ...lines.slice(range.last + 1)].join('\n').trim();
}

/**
 * Teilt eine Nachricht in Statusteil (Kopfzeilen + Fenster) und Erzähltext.
 * Ohne Statusfenster ist `head` leer. `join(body)` setzt beides wieder zusammen
 * (Statusteil oben oder unten – je nachdem, wo er stand).
 * @param {string} text
 * @returns {{ head: string, body: string, join: (body: string) => string }}
 */
export function splitStatus(text) {
    if (typeof text !== 'string' || !text) return { head: '', body: text || '', join: b => b };
    const lines = text.split('\n');
    const range = statusRange(lines);
    if (!range) return { head: '', body: text, join: b => b };
    const header = headerLines(lines, range.first);
    const from = header.length ? header[0].index : range.first;
    const head = lines.slice(from, range.last + 1).join('\n');
    const headFirst = lines.slice(0, from).every(l => !l.trim());
    return {
        head,
        body: [...lines.slice(0, from), ...lines.slice(range.last + 1)].join('\n').trim(),
        join: b => (headFirst ? `${head}\n\n${b.trim()}` : `${b.trim()}\n\n${head}`),
    };
}

/** Kompakter Werte-Text für <stats>. */
function statsText(d) {
    const parts = [];
    if (d.level) parts.push(`Lv ${d.level}${d.xp ? ` (XP ${d.xp.replace(/\s+/g, '')})` : ''}`);
    if (d.title) parts.push(`Titel: ${d.title}`);
    if (d.hp) parts.push(`HP ${d.hp}`);
    if (d.mp) parts.push(`MP ${d.mp}`);
    if (d.attrs) parts.push(d.attrs);
    if (d.abilities) parts.push(`Fähigkeiten: ${d.abilities}`);
    if (d.conditions) parts.push(`Zustände: ${d.conditions}`);
    if (d.money) parts.push(`Geld: ${d.money}`);
    if (d.size) parts.push(`Größe: ${d.size}`);
    if (d.group) parts.push(`Gruppe: ${d.group}`);
    if (d.guild) parts.push(`Gilde: ${d.guild}`);
    return parts.join(' · ');
}

/** Kompakter Text für <inventory>. */
function inventoryText(d) {
    return [d.inventory, d.equipment ? `Ausrüstung: ${d.equipment}` : ''].filter(Boolean).join(' | ');
}

function setText(doc, parent, tag, value, markUpdated) {
    let el = parent.querySelector(`:scope > ${tag}`);
    if (!el) el = parent.appendChild(doc.createElement(tag));
    if (el.textContent === value) return false;
    el.textContent = value;
    if (markUpdated) el.setAttribute('updated', '1');
    return true;
}

/**
 * Überträgt ein geparstes Statusfenster ins Brain.
 *   • Szene: Ort, Zeit, Kapitel (ARC)
 *   • Figuren (Name oder Alias): <stats>, <inventory>; neuer Name aus „X (alias Y)“
 *     wird als Alias ergänzt. Unbekannte Figuren werden NICHT angelegt (das macht
 *     das Update mit Beschreibung).
 * Teilblöcke werden mit dem bisherigen Stand zusammengeführt (Attribut `status`
 * am Charakter, JSON) – fehlt ein Feld in dieser Antwort, bleibt der alte Wert.
 *
 * @param {string} brainXml
 * @param {object} status – Ergebnis von parseStatus
 * @returns {{ xml: string, changed: boolean, matched: string[] }}
 */
export function applyStatusToBrain(brainXml, status) {
    const doc = new DOMParser().parseFromString(brainXml || '', 'application/xml');
    const root = doc.documentElement;
    if (!status || doc.querySelector('parsererror') || !root || root.nodeName !== 'brain') {
        return { xml: brainXml, changed: false, matched: [] };
    }
    let changed = false;

    if (status.location || status.time || status.chapter) {
        const scene = root.querySelector(':scope > scene') || root.appendChild(doc.createElement('scene'));
        if (status.location) changed = setText(doc, scene, 'location', status.location) || changed;
        if (status.time) changed = setText(doc, scene, 'time', status.time) || changed;
        if (status.chapter) changed = setText(doc, scene, 'chapter', status.chapter) || changed;
    }

    const matched = [];
    const chars = [...root.querySelectorAll(':scope > characters > character')];
    for (const sheet of status.sheets || []) {
        const wanted = sheet.names.map(n => n.toLowerCase());
        const ch = chars.find(c => {
            const names = [c.getAttribute('name') || '', ...[...c.querySelectorAll(':scope > aliases > alias')].map(a => a.textContent)];
            return names.some(n => wanted.includes(n.trim().toLowerCase()));
        });
        if (!ch) continue;
        matched.push(ch.getAttribute('name'));

        // Neue Namen aus „X (alias Y)“ als Alias merken
        const aliases = ch.querySelector(':scope > aliases') || ch.appendChild(doc.createElement('aliases'));
        const known = new Set([ch.getAttribute('name'), ...[...aliases.children].map(a => a.textContent)].map(n => (n || '').toLowerCase()));
        for (const n of sheet.names) {
            if (!known.has(n.toLowerCase())) {
                const a = doc.createElement('alias');
                a.textContent = n;
                aliases.appendChild(a);
                changed = true;
            }
        }

        let prev = {};
        try { prev = JSON.parse(ch.getAttribute('status') || '{}'); } catch { /* neu anfangen */ }
        const merged = { ...prev };
        for (const [k, v] of Object.entries(sheet.data)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
        }
        const json = JSON.stringify(merged);
        if (json !== ch.getAttribute('status')) {
            ch.setAttribute('status', json);
            changed = true;
        }
        const isMain = ch.getAttribute('role') === 'main';
        const stats = statsText(merged);
        const inv = inventoryText(merged);
        if (stats) changed = setText(doc, ch, 'stats', stats, isMain) || changed;
        if (inv) changed = setText(doc, ch, 'inventory', inv, isMain) || changed;
    }

    return { xml: changed ? new XMLSerializer().serializeToString(doc) : brainXml, changed, matched };
}
