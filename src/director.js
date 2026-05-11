// Director-Agent: Phase 3 – Narrative Director.
// Analysiert die aktuelle Szene via Brain + Chat-Fenster und produziert einen
// Director's Brief, der die Haupt-Generierung narrativ führt.
//
// Architektur: Ein Director (denkt) → ein Performer (schreibt).
// Der Director läuft als isolated generateRaw()-Call im Interceptor,
// sein Output wird via setExtensionPrompt() als SYSTEM-Rolle injected.
//
// Leitprinzip: Fail-soft. Director-Fehler blocken nie die Hauptgenerierung.
// Der Performer läuft auch ohne Director-Brief normal weiter.

const LOG_PREFIX = '[CCS]';

const DETAIL_CONFIG = {
    brief: {
        responseLength: 1000,
        instruction: 'Keep the brief extremely concise. Character beats in one short phrase each. Skip DETAILS section unless critical.',
    },
    standard: {
        responseLength: 2000,
        instruction: 'Keep the brief focused and concise. Character beats in one sentence each.',
    },
    detailed: {
        responseLength: 4000,
        instruction: 'Elaborate on character motivations, include subtext, and provide rich sensory details.',
    },
};

const DEFAULT_DIRECTOR_SYSTEM_PROMPT = `You are a Narrative Director for a roleplay session. Your job is to analyze the current situation and guide the performer AI that will write the actual character response.

INPUT:
- A Brain document (canonical facts: characters, locations, relationships, arcs, world rules)
- Recent chat messages showing what just happened

OUTPUT — Director's Brief (ONLY this structure, no preamble, no markdown fences):

[DIRECTOR'S BRIEF]
SITUATION: One line — what just happened and what is at stake right now.
PRESENT: Which characters are currently active in the scene.
CHARACTER BEATS:
- Name: immediate emotional state, inner motivation, and likely action in this moment.
TONE: Emotional atmosphere for the upcoming response (2-3 words).
DIRECTION: Where should this scene naturally move next? One sentence of narrative momentum.
DETAILS: 2-3 concrete sensory/world details to weave into the response (sounds, smells, visuals, physical sensations).

Keep the brief tight. Focus on what matters NOW — not summarizing the entire story. The performer AI already knows the chat history; your job is to frame the next response with narrative intent.`;

let cachedDirectorPrompt = null;

async function loadDirectorSystemPrompt() {
    if (cachedDirectorPrompt) return cachedDirectorPrompt;
    try {
        const url = new URL('../prompts/director-system.txt', import.meta.url);
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).trim();
        if (!text) throw new Error('empty file');
        cachedDirectorPrompt = text;
        return text;
    } catch (err) {
        console.warn(`${LOG_PREFIX} director: failed to load prompts/director-system.txt, using fallback`, err);
        cachedDirectorPrompt = DEFAULT_DIRECTOR_SYSTEM_PROMPT;
        return cachedDirectorPrompt;
    }
}

/**
 * Ruft den Director-Agent auf. Isolierter generateRaw()-Call — kontaminiert
 * den Chat-Kontext nicht.
 *
 * @param {object} params
 * @param {object} params.ctx – SillyTavern-Context
 * @param {string} params.brain – Brain-XML (bereits relevance-gefiltert)
 * @param {Array}  params.chatWindow – letzte N Chat-Messages [{name, mes, is_user}]
 * @param {string} params.detail – 'brief' | 'standard' | 'detailed'
 * @returns {Promise<{ brief: string, chars: number }>}
 */
export async function runDirector({ ctx, brain, chatWindow, detail = 'standard' }) {
    if (!ctx || typeof ctx.generateRaw !== 'function') {
        throw new Error('generateRaw not available on SillyTavern context');
    }

    const systemPrompt = await loadDirectorSystemPrompt();
    const dc = DETAIL_CONFIG[detail] || DETAIL_CONFIG.standard;

    const chatText = chatWindow.map((m) => {
        const label = m.is_user ? 'User' : (m.name || 'Character');
        return `[${label}]: ${String(m.mes ?? '')}`;
    }).join('\n\n');

    const userPrompt = [
        '=== BRAIN (canonical facts) ===',
        '',
        brain || '(no brain data)',
        '',
        '=== RECENT CHAT ===',
        '',
        chatText,
        '',
        '=== TASK ===',
        `Analyze the situation and produce a Director's Brief following the format in your system prompt. ${dc.instruction}`,
    ].join('\n');

    console.log(`${LOG_PREFIX} director: calling LLM (detail=${detail}, brainChars=${brain?.length || 0}, chatMessages=${chatWindow.length})`);

    const raw = await ctx.generateRaw({
        prompt: userPrompt,
        systemPrompt,
        instructOverride: true,
        responseLength: dc.responseLength,
    });

    if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error('Director returned empty response');
    }

    let brief = raw.trim();

    // Strip markdown code fences if present
    brief = brief.replace(/^```[^\n]*\n?/g, '').replace(/\n?```$/g, '').trim();

    console.log(`${LOG_PREFIX} director: brief received (${brief.length} chars)`);

    return { brief, chars: brief.length };
}
