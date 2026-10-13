// Render: Relevanz-Auswahl + kompakte Text-Darstellung des Brains für die Injektion.
//
// Gespeichert wird weiter als XML (gut zum Editieren, IDs für Updates). In den
// Prompt geht aber kompakter Text in ZWEI Blöcken:
//   • core  – stabiler Kanon (Welt, Figuren, Orte, Beziehungen, Momente, Arcs,
//             ältere Chronik). Wird oben im Prompt injiziert.
//   • state – aktuelle Lage (Szene, Zustände, Pins, jüngste Chronik). Wird nahe
//             der letzten Nachricht injiziert, wo das Modell am meisten darauf achtet.
//
// Pure Functions auf DOM-Basis, keine Seiteneffekte.

const LABELS = {
    de: {
        world: 'Weltregeln', characters: 'Figuren', locations: 'Orte', relationships: 'Beziehungen',
        moments: 'Schlüsselmomente', arcs: 'Handlungsbögen', chronicle: 'Chronik', situation: 'Aktuelle Lage',
        place: 'Ort', time: 'Zeit', mood: 'Stimmung', present: 'Anwesend', tension: 'Spannung', chapter: 'Kapitel',
        states: 'Zustand', pins: 'Merkzettel (Autor)', recent: 'Zuletzt geschehen', aka: 'auch',
        dormant: 'Liegengebliebene Fäden', dormantHint: 'Greife einen davon auf, wenn es sich natürlich ergibt – nicht erzwingen.',
        atmosphere: 'Atmosphäre', threads: 'Offene Fäden', outcome: 'Ergebnis', npc: 'NSC', main: 'Hauptfigur',
        fields: {
            core: 'Kern', appearance: 'Aussehen', background: 'Hintergrund', abilities: 'Fähigkeiten',
            quirks: 'Eigenheiten', goals: 'Ziele', speech_style: 'Sprechweise', stats: 'Werte',
            inventory: 'Inventar', reputation: 'Ruf',
        },
    },
    en: {
        world: 'World rules', characters: 'Characters', locations: 'Locations', relationships: 'Relationships',
        moments: 'Key moments', arcs: 'Story arcs', chronicle: 'Chronicle', situation: 'Current situation',
        place: 'Location', time: 'Time', mood: 'Mood', present: 'Present', tension: 'Tension', chapter: 'Chapter',
        states: 'State', pins: 'Notes (author)', recent: 'Recently', aka: 'aka',
        dormant: 'Dormant threads', dormantHint: 'Pick one up if it fits naturally – do not force it.',
        atmosphere: 'Atmosphere', threads: 'Open threads', outcome: 'Outcome', npc: 'NPC', main: 'Main character',
        fields: {
            core: 'Core', appearance: 'Appearance', background: 'Background', abilities: 'Abilities',
            quirks: 'Quirks', goals: 'Goals', speech_style: 'Speech', stats: 'Stats',
            inventory: 'Inventory', reputation: 'Reputation',
        },
    },
};

/** Charakter-Felder in Ausgabe-Reihenfolge (current_state geht in den State-Block). */
const CHAR_FIELDS = ['core', 'appearance', 'background', 'abilities', 'quirks', 'goals', 'speech_style', 'stats', 'inventory', 'reputation'];

/**
 * Felder des Hauptcharakters, die sich im Spiel ändern. Die statischen Felder
 * stammen aus der Character Card, die ST ohnehin mitschickt – bei dedupeCard
 * werden sie nur injiziert, wenn ein Update sie verändert hat (updated="1").
 */
const MAIN_DYNAMIC_FIELDS = new Set(['goals', 'stats', 'inventory', 'reputation']);

/** Wie viele der jüngsten Chronik-Einträge in den State-Block wandern. */
const RECENT_HISTORY = 2;

function text(el, sel) {
    return el?.querySelector(`:scope > ${sel}`)?.textContent?.trim() || '';
}

function texts(el, sel) {
    return [...(el?.querySelectorAll(`:scope > ${sel}`) || [])].map(e => e.textContent.trim()).filter(Boolean);
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prüft, ob `name` in `haystack` als eigenes Wort vorkommt (case-insensitive,
 * Unicode-fähig). Erlaubt deutsche/englische Endungen wie „Seraphinas“, „Kael's“.
 * „Ed“ trifft dadurch nicht mehr „edel“.
 */
export function mentions(haystack, name) {
    const n = (name || '').trim();
    if (n.length < 2 || !haystack) return false;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?:s|es|n|en|'s|’s)?(?![\\p{L}\\p{N}])`, 'iu');
    return re.test(haystack);
}

/** Name + Aliase eines Charakters/Orts. */
export function namesOf(el) {
    return [el.getAttribute('name') || '', ...texts(el.querySelector(':scope > aliases'), 'alias')].filter(Boolean);
}

/**
 * Bestimmt die relevanten Figuren und Orte.
 *   • Figuren: Name/Alias kommt im Text vor ODER steht in scene/present
 *   • Orte: Name/Alias kommt im Text vor ODER ist der Szenen-Ort
 * Der Hauptcharakter ist immer relevant (separat geliefert).
 *
 * @param {Element} root – <brain>
 * @param {string} recentText – jüngste Nachrichten (Relevanz-Fenster)
 * @returns {{ mainName: string, chars: Set<string>, locs: Set<string> }}
 *   chars enthält nur aktiv erwähnte/anwesende Namen (main nur, wenn erwähnt/anwesend)
 */
export function selectRelevant(root, recentText) {
    const mainName = root.querySelector(':scope > characters > character[role="main"]')?.getAttribute('name') || '';
    const sceneEl = root.querySelector(':scope > scene');
    const present = texts(sceneEl?.querySelector(':scope > present'), 'person');
    const sceneLoc = text(sceneEl, 'location');

    const chars = new Set();
    for (const ch of root.querySelectorAll(':scope > characters > character')) {
        const names = namesOf(ch);
        const isPresent = present.some(p => names.some(n => n.toLowerCase() === p.toLowerCase()));
        if (isPresent || names.some(n => mentions(recentText, n))) chars.add(ch.getAttribute('name'));
    }

    const locs = new Set();
    for (const loc of root.querySelectorAll(':scope > locations > location')) {
        const names = namesOf(loc);
        const isScene = sceneLoc && names.some(n => n.toLowerCase() === sceneLoc.toLowerCase() || mentions(sceneLoc, n));
        if (isScene || names.some(n => mentions(recentText, n))) locs.add(loc.getAttribute('name'));
    }
    return { mainName, chars, locs };
}

/**
 * Kompakter Text aus einem (bereits gefilterten) Brain-XML.
 * @param {string} brainXml
 * @param {object} [opts]
 * @param {boolean} [opts.dedupeCard=true] – statische Felder des Hauptcharakters weglassen
 * @param {number} [opts.chatLength] – aktuelle Chat-Länge (für liegengebliebene Fäden)
 * @param {number} [opts.threadAge=0] – ab so vielen Nachrichten ohne Bezug gilt ein Faden
 *   als liegengeblieben (0 = Hinweis aus)
 * @returns {{ core: string, state: string }}
 */
export function renderCompact(brainXml, { dedupeCard = true, chatLength, threadAge = 0 } = {}) {
    const doc = new DOMParser().parseFromString(brainXml || '', 'application/xml');
    const root = doc.documentElement;
    if (doc.querySelector('parsererror') || !root || root.nodeName !== 'brain') return { core: '', state: '' };

    const L = LABELS[(root.getAttribute('lang') || '').toLowerCase().startsWith('de') ? 'de' : 'en'];
    const core = [];
    const state = [];
    const section = (out, title, lines) => {
        if (lines.length) out.push(`[${title}]`, ...lines, '');
    };

    // --- Core ---------------------------------------------------------------
    section(core, L.world, texts(root.querySelector(':scope > world_rules'), 'rule').map(r => `- ${r}`));

    // Anwesende: Werte + Inventar gehören zur aktuellen Lage (harte Fakten direkt
    // vor der letzten Nachricht), nicht in den Kanon oben.
    const sceneEl = root.querySelector(':scope > scene');
    const presentNames = new Set(texts(sceneEl?.querySelector(':scope > present'), 'person').map(n => n.toLowerCase()));
    const charLines = [];
    const stateLines = [];
    for (const ch of root.querySelectorAll(':scope > characters > character')) {
        const name = ch.getAttribute('name') || '?';
        const isMain = ch.getAttribute('role') === 'main';
        const aliases = texts(ch.querySelector(':scope > aliases'), 'alias');
        const isPresent = [name, ...aliases].some(n => presentNames.has(n.toLowerCase()));
        const fields = [];
        const presentFacts = [];
        for (const f of CHAR_FIELDS) {
            const el = ch.querySelector(`:scope > ${f}`);
            const v = el?.textContent?.trim();
            if (!v) continue;
            if (isPresent && (f === 'stats' || f === 'inventory')) {
                presentFacts.push(`    ${L.fields[f]}: ${v}`);
                continue;
            }
            if (isMain && dedupeCard && !MAIN_DYNAMIC_FIELDS.has(f) && el.getAttribute('updated') !== '1') continue;
            fields.push(`  ${L.fields[f]}: ${v}`);
        }
        if (fields.length) {
            const tag = isMain ? L.main : L.npc;
            charLines.push(`## ${name} (${tag}${aliases.length ? `; ${L.aka}: ${aliases.join(', ')}` : ''})`, ...fields);
        }
        const cs = text(ch, 'current_state');
        if (cs || presentFacts.length) stateLines.push(`- ${name}: ${cs || '—'}`, ...presentFacts);
    }
    section(core, L.characters, charLines);

    section(core, L.locations, [...root.querySelectorAll(':scope > locations > location')].map(loc => {
        const atm = text(loc, 'atmosphere');
        const desc = text(loc, 'description');
        return `- ${loc.getAttribute('name')}: ${desc}${atm ? ` (${L.atmosphere}: ${atm})` : ''}`;
    }));

    section(core, L.relationships, [...root.querySelectorAll(':scope > relationships > relationship')]
        .map(r => ({ r, cur: text(r, 'current') }))
        .filter(x => x.cur)
        .map(({ r, cur }) => `- ${r.getAttribute('from')} → ${r.getAttribute('to')}: ${cur}`));

    section(core, L.moments, [...root.querySelectorAll(':scope > key_moments > key_moment')].map(km => {
        const where = text(km, 'where');
        const when = text(km, 'when');
        const impact = text(km, 'impact');
        const meta = [where, when].filter(Boolean).join(', ');
        return `- ${text(km, 'summary')}${meta ? ` (${meta})` : ''}${impact ? ` → ${impact}` : ''}`;
    }));

    section(core, L.arcs, [...root.querySelectorAll(':scope > arcs > arc')].map(arc => {
        const threads = texts(arc.querySelector(':scope > open_threads'), 'thread');
        return `- ${text(arc, 'title')}: ${text(arc, 'tension')}${threads.length ? ` ${L.threads}: ${threads.join('; ')}` : ''}`;
    }));

    const historyLine = (h) => {
        const scene = h.getAttribute('scene');
        const outcome = text(h, 'key_outcome');
        return `- ${scene ? `${scene}: ` : ''}${text(h, 'summary')}${outcome ? ` (${L.outcome}: ${outcome})` : ''}`;
    };
    const history = [...root.querySelectorAll(':scope > history > entry')];
    const older = history.slice(0, Math.max(0, history.length - RECENT_HISTORY));
    const recent = history.slice(older.length);
    section(core, L.chronicle, older.map(historyLine));

    // --- State --------------------------------------------------------------
    const scene = root.querySelector(':scope > scene');
    const sceneLines = [];
    const sceneMeta = [
        [L.place, text(scene, 'location')],
        [L.time, text(scene, 'time')],
        [L.mood, text(scene, 'mood')],
        [L.chapter, text(scene, 'chapter')],
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    if (sceneMeta.length) sceneLines.push(sceneMeta.join(' | '));
    const present = texts(scene?.querySelector(':scope > present'), 'person');
    if (present.length) sceneLines.push(`${L.present}: ${present.join(', ')}`);
    const tension = text(scene, 'active_tension');
    if (tension) sceneLines.push(`${L.tension}: ${tension}`);
    if (stateLines.length) sceneLines.push(`${L.states}:`, ...stateLines);
    section(state, L.situation, sceneLines);

    section(state, L.pins, texts(root.querySelector(':scope > pinned'), 'pin').map(p => `- ${p}`));

    // Fäden-Register: die zwei am längsten unberührten offenen Fäden aktiver Arcs
    if (threadAge > 0 && Number.isFinite(chatLength)) {
        const dormant = [...root.querySelectorAll(':scope > arcs > arc[status="active"] > open_threads > thread')]
            .map(t => {
                const last = Math.max(Number(t.getAttribute('since') ?? NaN), Number(t.getAttribute('touched') ?? -1));
                return { text: t.textContent.trim(), age: chatLength - last };
            })
            .filter(t => t.text && Number.isFinite(t.age) && t.age >= threadAge)
            .sort((a, b) => b.age - a.age)
            .slice(0, 2);
        if (dormant.length) section(state, L.dormant, [...dormant.map(t => `- ${t.text}`), L.dormantHint]);
    }
    section(state, L.recent, recent.map(historyLine));

    return { core: core.join('\n').trim(), state: state.join('\n').trim() };
}
