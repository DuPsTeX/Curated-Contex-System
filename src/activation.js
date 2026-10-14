// Activation: assoziatives Erinnern nach dem Vorbild eines Leaky-Integrate-and-Fire-Netzes.
//
// Das Brain wird als Netz gelesen: Figuren, Orte, Schlüsselmomente, Beziehungen,
// Handlungsbögen und Chronik-Einträge sind Knoten; wer bei welchem Moment war,
// wo er geschah, wer zu wem steht usw. sind Verbindungen.
//
//   1. Reize   – Nennungen in den jüngsten Nachrichten (ältere abgeschwächt: "leaky"),
//                Anwesende, Szenen-Ort, Hauptfigur, Treffer der Bedeutungs-Suche.
//   2. Ausbreitung – in wenigen Schritten entlang der Verbindungen, gedämpft. Knoten
//                mit sehr vielen Verbindungen (die Hauptfigur) geben pro Verbindung
//                weniger weiter, sonst wäre alles aktiv.
//   3. Schwelle – was stark genug aktiviert ist, kommt in den Kontext.
// Einträge mit silenced="1" nehmen nie teil (stummgeschaltet).
//
// Zustandslos: das Abklingen ergibt sich aus dem Alter der Nachrichten, daher
// swipe-sicher und ohne Speicher.

import { mentions, namesOf } from './render.js';

export const DEFAULTS = {
    decay: 0.75,     // Gewicht einer Nennung pro Nachricht Alter (0 = nur jüngste, 1 = kein Abklingen)
    spread: 0.6,     // Anteil, der pro Schritt weitergegeben wird
    steps: 2,        // Ausbreitungsschritte
};

/** Schwellen für die Aufnahme in den Kontext (kalibriert an echten Brains). */
export const THRESHOLDS = {
    char: 0.3,
    loc: 0.3,
    km: 0.25,
    hist: 0.25,
};

/** Bonus für wichtige Momente – sie bleiben leichter im Kontext. */
export const IMPORTANCE_BONUS = { critical: 0.25, high: 0.12, medium: 0, low: -0.05 };

const EDGE = {
    kmChar: 0.8,
    kmLoc: 0.6,
    kmMention: 0.5,
    relChar: 0.9,
    arcRef: 0.6,
    histChar: 0.5,
    histLoc: 0.5,
};

export function isSilenced(el) {
    return el?.getAttribute?.('silenced') === '1';
}

function text(el, sel) {
    return el?.querySelector(`:scope > ${sel}`)?.textContent?.trim() || '';
}

function short(s, n = 50) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Baut das Netz aus dem Brain.
 * @param {Element} root – <brain>
 * @returns {{ nodes: Map<string, {key: string, type: string, el: Element, label: string, names?: string[]}>, adj: Map<string, Map<string, number>> }}
 */
export function buildGraph(root) {
    const nodes = new Map();
    const adj = new Map();
    const add = (key, type, el, label, names) => {
        nodes.set(key, { key, type, el, label, names });
        adj.set(key, new Map());
    };
    const link = (a, b, w) => {
        if (a === b || !adj.has(a) || !adj.has(b)) return;
        adj.get(a).set(b, Math.max(w, adj.get(a).get(b) || 0));
        adj.get(b).set(a, Math.max(w, adj.get(b).get(a) || 0));
    };

    const chars = [];
    for (const ch of root.querySelectorAll(':scope > characters > character')) {
        if (isSilenced(ch)) continue;
        const name = ch.getAttribute('name');
        if (!name) continue;
        const key = `char:${name}`;
        add(key, 'char', ch, name, namesOf(ch));
        chars.push(nodes.get(key));
    }
    const locs = [];
    for (const loc of root.querySelectorAll(':scope > locations > location')) {
        if (isSilenced(loc)) continue;
        const name = loc.getAttribute('name');
        if (!name) continue;
        const key = `loc:${name}`;
        add(key, 'loc', loc, name, namesOf(loc));
        locs.push(nodes.get(key));
    }
    const charsIn = (t) => chars.filter(c => c.names.some(n => mentions(t, n))).map(c => c.key);
    const locsIn = (t) => locs.filter(l => l.names.some(n => mentions(t, n) || (t || '').toLowerCase().includes(n.toLowerCase()))).map(l => l.key);
    const charByName = (n) => chars.find(c => c.names.some(x => x.toLowerCase() === n.trim().toLowerCase()))?.key;

    [...root.querySelectorAll(':scope > key_moments > key_moment')].forEach((km, i) => {
        if (isSilenced(km)) return;
        const key = `km:${km.getAttribute('id') || i}`;
        add(key, 'km', km, short(text(km, 'summary')));
        for (const p of km.querySelectorAll(':scope > who > person')) {
            const c = charByName(p.textContent || '');
            if (c) link(key, c, EDGE.kmChar);
        }
        for (const l of locsIn(text(km, 'where'))) link(key, l, EDGE.kmLoc);
        for (const c of charsIn(`${text(km, 'summary')} ${text(km, 'impact')}`)) link(key, c, EDGE.kmMention);
    });

    [...root.querySelectorAll(':scope > relationships > relationship')].forEach((rel, i) => {
        if (isSilenced(rel)) return;
        const key = `rel:${rel.getAttribute('id') || i}`;
        add(key, 'rel', rel, `${rel.getAttribute('from')} → ${rel.getAttribute('to')}`);
        for (const n of [rel.getAttribute('from'), rel.getAttribute('to')]) {
            const c = n && charByName(n);
            if (c) link(key, c, EDGE.relChar);
        }
    });

    [...root.querySelectorAll(':scope > arcs > arc')].forEach((arc, i) => {
        if (isSilenced(arc)) return;
        const key = `arc:${arc.getAttribute('id') || i}`;
        add(key, 'arc', arc, short(text(arc, 'title')));
        const all = arc.textContent || '';
        for (const c of charsIn(all)) link(key, c, EDGE.arcRef);
        for (const l of locsIn(all)) link(key, l, EDGE.arcRef);
    });

    [...root.querySelectorAll(':scope > history > entry')].forEach((h, i) => {
        if (isSilenced(h)) return;
        const key = `hist:${h.getAttribute('id') || i}`;
        add(key, 'hist', h, short(h.getAttribute('scene') || text(h, 'summary')));
        const all = `${h.getAttribute('scene') || ''} ${text(h, 'summary')} ${text(h, 'key_outcome')}`;
        for (const n of text(h, 'involved').split(',')) {
            const c = n.trim() && charByName(n);
            if (c) link(key, c, EDGE.histChar);
        }
        for (const c of charsIn(all)) link(key, c, EDGE.histChar);
        for (const l of locsIn(all)) link(key, l, EDGE.histLoc);
    });

    return { nodes, adj };
}

/**
 * Berechnet die Aktivierung aller Knoten.
 * @param {Element} root – <brain>
 * @param {object} opts
 * @param {string[]} [opts.messages] – jüngste Nachrichten, älteste zuerst
 * @param {Set<string>|null} [opts.forceIds] – IDs aus der Bedeutungs-Suche
 * @returns {{ act: Map<string, number>, input: Map<string, number>, reason: Map<string, string>, via: Map<string, {from: string, amount: number}>, graph: object }}
 */
export function computeActivation(root, { messages = [], forceIds = null, decay = DEFAULTS.decay, spread = DEFAULTS.spread, steps = DEFAULTS.steps } = {}) {
    const graph = buildGraph(root);
    const input = new Map();
    const reason = new Map();
    // Gesättigte Kombination: 1-(1-a)(1-b). Bleibt in [0,1]; wiederholte Reize halten
    // einen Knoten länger warm, ohne dass Dauer-Nennungen alles überstrahlen.
    const combine = (a, b) => 1 - (1 - a) * (1 - Math.min(1, b));
    const bump = (key, v, why) => {
        if (!graph.nodes.has(key) || v <= 0) return;
        input.set(key, combine(input.get(key) || 0, v));
        if (!reason.has(key) || v > reason.get(key).v) reason.set(key, { v, why });
    };

    // 1. Reize: Nennungen, je älter die Nachricht, desto schwächer
    messages.forEach((msg, idx) => {
        const age = messages.length - 1 - idx;
        const w = decay ** age;
        for (const node of graph.nodes.values()) {
            if ((node.type === 'char' || node.type === 'loc') && node.names.some(n => mentions(msg, n))) {
                bump(node.key, w, age === 0 ? 'gerade genannt' : `vor ${age} ${age === 1 ? 'Nachricht' : 'Nachrichten'} genannt`);
            }
        }
    });
    const scene = root.querySelector(':scope > scene');
    for (const p of scene?.querySelectorAll(':scope > present > person') || []) {
        const node = [...graph.nodes.values()].find(n => n.type === 'char' && n.names.some(x => x.toLowerCase() === p.textContent.trim().toLowerCase()));
        if (node) bump(node.key, 1, 'anwesend');
    }
    const sceneLoc = text(scene, 'location');
    if (sceneLoc) {
        for (const node of graph.nodes.values()) {
            if (node.type === 'loc' && node.names.some(n => n.toLowerCase() === sceneLoc.toLowerCase() || mentions(sceneLoc, n))) bump(node.key, 1, 'Szenen-Ort');
        }
    }
    const main = root.querySelector(':scope > characters > character[role="main"]');
    if (main && !isSilenced(main)) bump(`char:${main.getAttribute('name')}`, 1, 'Hauptfigur');
    if (forceIds?.size) {
        for (const node of graph.nodes.values()) {
            if ((node.type === 'km' || node.type === 'hist') && forceIds.has(node.el.getAttribute('id'))) bump(node.key, 0.8, 'inhaltlich passend');
        }
    }

    // 2. Ausbreitung: nur die jeweils neu hinzugekommene Aktivierung wandert weiter
    const act = new Map(input);
    const via = new Map();
    let frontier = new Map(input);
    for (let step = 0; step < steps; step++) {
        const next = new Map();
        for (const [j, aj] of frontier) {
            const nbrs = graph.adj.get(j);
            if (!nbrs?.size) continue;
            const norm = Math.sqrt(nbrs.size);
            for (const [i, w] of nbrs) {
                const d = spread * w * aj / norm;
                next.set(i, combine(next.get(i) || 0, d));
                if (!via.has(i) || via.get(i).amount < d) via.set(i, { from: j, amount: d });
            }
        }
        for (const [i, d] of next) act.set(i, combine(act.get(i) || 0, d));
        frontier = next;
    }

    return { act, input, reason: new Map([...reason].map(([k, r]) => [k, r.why])), via, graph };
}

/** Punktzahl eines Knotens inkl. Wichtigkeits-Bonus (Momente). */
export function scoreOf(result, key) {
    const node = result.graph.nodes.get(key);
    const base = result.act.get(key) || 0;
    if (node?.type !== 'km') return base;
    return base + (IMPORTANCE_BONUS[(node.el.getAttribute('importance') || 'medium').toLowerCase()] ?? 0);
}

/**
 * Warum ist ein Knoten aktiv? Kette bis zum auslösenden Reiz.
 * z.B. „Keim-Faden ← Biss am Silbersee ← Silbersee (gerade genannt)“
 */
export function explain(result, key, maxHops = 3) {
    const parts = [];
    const seen = new Set();
    let cur = key;
    for (let hop = 0; hop <= maxHops && cur && !seen.has(cur); hop++) {
        seen.add(cur);
        const node = result.graph.nodes.get(cur);
        const direct = result.input.get(cur) || 0;
        const spreadIn = result.via.get(cur);
        if (direct > 0 && (!spreadIn || direct >= spreadIn.amount)) {
            parts.push(`${node?.label ?? cur} (${result.reason.get(cur)})`);
            break;
        }
        parts.push(node?.label ?? cur);
        cur = spreadIn?.from;
    }
    return parts.join(' ← ');
}
