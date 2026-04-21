// Collector: sammelt Rohmaterial für den Initial-LLM-Call.
//
// Quellen (alle einzeln per Config abschaltbar):
//   - character  → V2-Character-Card-Felder + Primary-Book (data.extensions.world)
//                  + Additional-Books (world_info.charLore[].extraBooks)
//   - chat       → chat_metadata['world_info'] (einzelnes Buch pro Chat)
//   - persona    → power_user.persona_description + persona_description_lorebook
//   - global     → selected_world_info (Array aktivierter globaler Bücher)
//
// Alle Lorebook-Einträge werden zusätzlich in `merged` dedupliziert über den
// Composite-Key `${world}.${uid}` – uid ist nur pro Buch eindeutig.
//
// Konzept-Referenz: ccs-konzept.md §4 + mvp-phase1-plan.md Schritt 4.

import {
    loadWorldInfo,
    selected_world_info,
    world_info,
    METADATA_KEY,
} from '../../../../world-info.js';
import { characters, this_chid, chat_metadata } from '../../../../../script.js';
import { power_user } from '../../../../power-user.js';
import { getCharaFilename } from '../../../../utils.js';

const LOG_PREFIX = '[CCS]';

const DEFAULT_CONFIG = {
    character: true,
    chat: true,
    persona: true,
    global: true,
};

/**
 * Sammelt Character-Card-Felder (V2-Format) des aktiven Charakters.
 * @returns {object|null}
 */
function collectCharacter() {
    if (typeof this_chid === 'undefined' || this_chid === null) return null;
    const char = characters?.[this_chid];
    if (!char) return null;
    const d = char.data || {};
    return {
        name: char.name || d.name || '',
        description: d.description || char.description || '',
        personality: d.personality || char.personality || '',
        scenario: d.scenario || char.scenario || '',
        first_mes: d.first_mes || char.first_mes || '',
        avatar: char.avatar || '',
    };
}

/**
 * Sammelt Persona-Description + zugehöriges Lorebook (Name).
 */
function collectPersona() {
    const desc = power_user?.persona_description || '';
    const lore = power_user?.persona_description_lorebook || '';
    if (!desc && !lore) return { name: '', description: '', lorebook: '' };
    return {
        name: power_user?.personas?.[power_user?.default_persona] || '',
        description: desc,
        lorebook: lore,
    };
}

/**
 * Liefert Character-Primary- und Additional-Books für den aktiven Charakter.
 * @returns {string[]}
 */
function getCharacterBooks() {
    if (typeof this_chid === 'undefined' || this_chid === null) return [];
    const char = characters?.[this_chid];
    if (!char) return [];
    const books = [];
    const primary = char.data?.extensions?.world;
    if (primary) books.push(primary);
    const fileName = getCharaFilename(this_chid);
    const extra = world_info?.charLore?.find(e => e?.name === fileName);
    if (extra && Array.isArray(extra.extraBooks)) {
        for (const b of extra.extraBooks) if (b) books.push(b);
    }
    // Duplikate innerhalb dieser Quelle entfernen
    return [...new Set(books)];
}

/**
 * Liefert den Namen des Chat-Lorebooks (falls gesetzt), sonst leere Liste.
 */
function getChatBooks() {
    const name = chat_metadata?.[METADATA_KEY];
    return name ? [name] : [];
}

function getGlobalBooks() {
    return Array.isArray(selected_world_info) ? [...selected_world_info] : [];
}

function getPersonaBooks() {
    const name = power_user?.persona_description_lorebook;
    return name ? [name] : [];
}

/**
 * Lädt alle Einträge aus einer Bücherliste, entfernt Leereinträge, taggt jeden
 * Eintrag mit seinem Buchnamen (falls nicht schon vorhanden).
 */
async function loadEntries(bookNames) {
    const result = [];
    for (const name of bookNames) {
        if (!name) continue;
        try {
            const data = await loadWorldInfo(name);
            if (!data || !data.entries) continue;
            for (const entry of Object.values(data.entries)) {
                if (!entry) continue;
                // Eintrag flach kopieren, damit wir .world setzen dürfen ohne Cache-Mutation
                const tagged = { ...entry, world: entry.world || name };
                result.push(tagged);
            }
        } catch (err) {
            console.warn(`${LOG_PREFIX} loadEntries: failed to load "${name}"`, err);
        }
    }
    return result;
}

/**
 * Dedupliziert Einträge über `${world}.${uid}`. Erste Vorkommen gewinnt.
 */
function dedupe(entries) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
        const key = `${e.world}.${e.uid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
    }
    return out;
}

/**
 * Hauptfunktion – sammelt alles laut `config`.
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 * @returns {Promise<object>}
 */
export async function collect(config = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    const character = cfg.character ? collectCharacter() : null;
    const persona = cfg.persona ? collectPersona() : null;

    const charBooks = cfg.character ? getCharacterBooks() : [];
    const chatBooks = cfg.chat ? getChatBooks() : [];
    const globalBooks = cfg.global ? getGlobalBooks() : [];
    const personaBooks = cfg.persona ? getPersonaBooks() : [];

    const [charEntries, chatEntries, globalEntries, personaEntries] = await Promise.all([
        loadEntries(charBooks),
        loadEntries(chatBooks),
        loadEntries(globalBooks),
        loadEntries(personaBooks),
    ]);

    const merged = dedupe([
        ...charEntries,
        ...chatEntries,
        ...globalEntries,
        ...personaEntries,
    ]);

    const result = {
        character,
        persona,
        sources: {
            character: { enabled: cfg.character, books: charBooks, entries: charEntries },
            chat: { enabled: cfg.chat, books: chatBooks, entries: chatEntries },
            global: { enabled: cfg.global, books: globalBooks, entries: globalEntries },
            persona: { enabled: cfg.persona, books: personaBooks, entries: personaEntries },
        },
        merged,
        stats: {
            totalEntries: charEntries.length + chatEntries.length + globalEntries.length + personaEntries.length,
            uniqueEntries: merged.length,
            perSource: {
                character: charEntries.length,
                chat: chatEntries.length,
                global: globalEntries.length,
                persona: personaEntries.length,
            },
            books: {
                character: charBooks.length,
                chat: chatBooks.length,
                global: globalBooks.length,
                persona: personaBooks.length,
            },
        },
    };

    console.log(`${LOG_PREFIX} collector.collect done`, {
        config: cfg,
        stats: result.stats,
    });

    return result;
}
