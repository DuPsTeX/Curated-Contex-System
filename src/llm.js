// LLM: gemeinsamer Aufrufweg für alle CCS-Hintergrundaufgaben
// (Update, Wächter, Verdichten, Director).
//
// settings.ccsProfile   – Verbindungsprofil aus dem Connection Manager ('' = aktive Verbindung)
// settings.ccsNoReasoning – Nachdenken für CCS-Aufgaben abschalten. Reasoning-Modelle
//   (z.B. DeepSeek) verbrauchen sonst 20–40 s pro Aufgabe; für JSON-Extraktion und
//   Prüfungen bringt das kaum Qualität. Wirkt nur über den Connection Manager
//   (include_reasoning=false → bei DeepSeek "thinking: disabled").
//
// Ohne Profil und ohne Reasoning-Abschaltung: ctx.generateRaw wie bisher.
// Schlägt der Profil-Weg fehl, wird einmal über generateRaw wiederholt.

const LOG_PREFIX = '[CCS]';

let getSettings = () => ({});

export function init(opts) {
    getSettings = opts.getSettings;
}

function connectionManager(ctx) {
    const svc = ctx?.ConnectionManagerRequestService;
    if (!svc || ctx.extensionSettings?.disabledExtensions?.includes('connection-manager')) return null;
    return svc;
}

/** Profile, die der Connection Manager für Anfragen unterstützt. */
export function listProfiles() {
    const ctx = SillyTavern.getContext();
    try {
        return connectionManager(ctx)?.getSupportedProfiles() || [];
    } catch {
        return [];
    }
}

/** Welches Profil würde für CCS-Aufgaben genutzt? ('' = generateRaw) */
function resolveProfileId(ctx, s) {
    const svc = connectionManager(ctx);
    if (!svc) return '';
    const wanted = s.ccsProfile || (s.ccsNoReasoning !== false ? ctx.extensionSettings?.connectionManager?.selectedProfile : '');
    if (!wanted) return '';
    try {
        svc.getProfile(wanted);
        return wanted;
    } catch {
        return '';
    }
}

/**
 * Text-Anfrage für eine CCS-Aufgabe.
 * @param {object} ctx – SillyTavern-Context
 * @param {object} req
 * @param {string} req.prompt – User-Nachricht
 * @param {string} [req.systemPrompt]
 * @param {number} req.responseLength – max. Antwort-Tokens
 * @param {string} [req.task] – nur fürs Log
 * @param {boolean} [req.json] – Antwort als JSON-Objekt erzwingen (Profil-Weg: response_format/json_schema)
 * @returns {Promise<string>}
 */
export async function generate(ctx, { prompt, systemPrompt = '', responseLength, task = 'task', json = false }) {
    const s = getSettings();
    const profileId = resolveProfileId(ctx, s);
    if (profileId) {
        const svc = connectionManager(ctx);
        const t0 = Date.now();
        try {
            const messages = [
                ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                { role: 'user', content: prompt },
            ];
            const res = await svc.sendRequest(
                profileId,
                svc.constructPrompt(messages, profileId),
                responseLength,
                { stream: false, extractData: true, includePreset: true, includeInstruct: true },
                {
                    ...(s.ccsNoReasoning !== false ? { include_reasoning: false } : {}),
                    // Lockeres Schema: erzwingt gültiges JSON (DeepSeek: json_object), Struktur steht im Prompt.
                    ...(json ? { json_schema: { name: 'ccs_result', strict: false, value: { type: 'object' } } } : {}),
                },
            );
            // Mit json_schema liefert ST `content` bereits als geparstes Objekt.
            const content = typeof res === 'string' ? res : res?.content;
            const text = content && typeof content === 'object' ? JSON.stringify(content) : content;
            if (typeof text !== 'string' || !text.trim()) throw new Error('empty response');
            console.log(`${LOG_PREFIX} llm: ${task} via profile in ${((Date.now() - t0) / 1000).toFixed(1)}s${s.ccsNoReasoning !== false ? ' (no reasoning)' : ''}`);
            return text;
        } catch (err) {
            console.warn(`${LOG_PREFIX} llm: ${task} via profile failed – falling back to active connection`, err?.cause || err);
            toastr.warning('CCS-Verbindungsprofil fehlgeschlagen – nutze die aktive Verbindung.', 'CCS', { preventDuplicates: true, timeOut: 6000 });
        }
    }
    if (typeof ctx.generateRaw !== 'function') throw new Error('generateRaw not available on SillyTavern context');
    return ctx.generateRaw({ prompt, systemPrompt, instructOverride: true, responseLength });
}
