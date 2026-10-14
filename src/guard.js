// Kontinuitäts-Wächter: prüft jede neue KI-Antwort gegen das Brain.
//
// Modi (settings.guardMode):
//   off  – nichts
//   mark – Widersprüche an der Nachricht markieren (Klick → Details, "Korrigieren")
//   fix  – harte Widersprüche automatisch korrigieren: die Erzähl-KI schreibt NUR die
//          betroffenen Stellen um; das Ergebnis wird ein neuer Swipe, das Original
//          bleibt als Swipe erhalten (zurückwischen = rückgängig).
// settings.guardHold – Antwort bis zum Ende der Prüfung unscharf zeigen.
//
// Vorbeugung (vor der Generierung) passiert im Interceptor: die aktuelle Lage
// samt Werten/Inventar der Anwesenden steht als "harte Fakten" direkt vor der
// letzten Nachricht.

import * as storage from './storage.js';
import { filterBrainByRelevance } from './interceptor.js';
import { renderCompact } from './render.js';
import { splitStatus, stripStatus } from './status.js';
import { extractJson } from './updater.js';

const LOG_PREFIX = '[CCS]';
const CHECK_RESPONSE_LENGTH = 8000;
const FIX_RESPONSE_LENGTH = 16000;
const RECENT_CONTEXT = 4;
const IDLE_TIMEOUT_MS = 90000;

const DEFAULT_CHECK_PROMPT = `You are a continuity checker for a roleplay story. Compare the REPLY against the CANON (curated facts) and the RECENT CHAT (newer events, also true). Report only HARD contradictions – statements in the REPLY that cannot be true given these facts:
- a character who is dead or not present acts or speaks in the scene
- wrong location, or an impossible jump in time or place
- using or having an item the character does not have, lost or broke
- ignoring an injury or condition (e.g. fighting with a crippled arm)
- a character knowing something they never witnessed and were never told (check who was present in key moments)
- wrong names, contradicting established relationship facts or world rules

NOT contradictions: lies, deception, dreams, flashbacks, speculation, rumors, jokes, deliberate plot twists, new information that does not conflict, stylistic choices, anything the canon simply does not mention.
If you are unsure, use severity "soft". Quote the exact passage from the REPLY (verbatim, short).

Return ONLY one JSON object, no prose, no markdown fences:
{"issues":[{"severity":"hard|soft","quote":"...","problem":"...","fix":"..."}]}
Use an empty list if everything is consistent. Write problem and fix in the language of the reply. Keep internal deliberation brief.`;

const DEFAULT_FIX_PROMPT = `You are revising your own roleplay reply to fix continuity errors. Change ONLY what is needed to fix the listed contradictions, with the smallest possible edit. Keep everything else exactly as it is: wording, style, formatting (markdown, asterisks, quotes), paragraphs, length and perspective. Do not add any commentary. Output ONLY the full revised reply.`;

const promptCache = {};

async function loadPrompt(file, fallback) {
    if (promptCache[file]) return promptCache[file];
    try {
        const res = await fetch(new URL(`../prompts/${file}`, import.meta.url), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = (await res.text()).trim();
        if (!text) throw new Error('empty file');
        promptCache[file] = text;
    } catch (err) {
        console.warn(`${LOG_PREFIX} guard: prompts/${file} not loaded, using fallback`, err);
        promptCache[file] = fallback;
    }
    return promptCache[file];
}

/** Kurzer, stabiler Hash (djb2) – erkennt, ob eine Nachricht schon geprüft wurde. */
export function hashText(text) {
    let h = 5381;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
}

const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// --- Zustand -------------------------------------------------------------------

let getSettings = () => ({});
let running = null;
let currentGen = null;

export function init(opts) {
    getSettings = opts.getSettings;
}

function hold(on) {
    document.body.classList.toggle('ccs-guard-holding', !!on);
}

/** Wartet, bis eine laufende Prüfung fertig ist (max. IDLE_TIMEOUT_MS). */
export async function whenIdle() {
    if (!running) return;
    await Promise.race([running.catch(() => {}), new Promise(r => setTimeout(r, IDLE_TIMEOUT_MS))]);
}

export function onGenerationStarted(type, _opts, dryRun) {
    if (dryRun) return;
    currentGen = type || 'normal';
    const s = getSettings();
    if (s.enabled && s.guardMode && s.guardMode !== 'off' && s.guardHold && !['quiet', 'impersonate'].includes(type)) hold(true);
}

export function onGenerationFinished() {
    currentGen = null;
    if (!running) hold(false);
}

function lastAiIndex(chat) {
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

/** Darf die Korrektur jetzt eingesetzt werden? Nicht, wenn die Nachricht gerade neu generiert wird. */
function canApply(chat, messageId) {
    if (!currentGen || currentGen === 'normal') return true;
    return messageId !== lastAiIndex(chat);
}

// --- Prüfen & Korrigieren ------------------------------------------------------

function textOf(m) {
    return stripStatus(String(m?.mes ?? '')).trim();
}

function buildCanon(brainXml, chat, messageId) {
    const messages = chat.slice(Math.max(0, messageId - RECENT_CONTEXT), messageId + 1).filter(m => m && !m.is_system).map(textOf);
    const filtered = filterBrainByRelevance(brainXml, '', { includeHistory: true, messages });
    const { core, state } = renderCompact(filtered, { dedupeCard: false });
    return [core, state].filter(Boolean).join('\n\n');
}

/**
 * Prüft eine Antwort. Liefert alle gefundenen Widersprüche.
 * @returns {Promise<{ issues: Array<{severity: string, quote: string, problem: string, fix: string}>, canon: string }>}
 */
export async function checkMessage({ ctx, brainXml, messageId }) {
    const chat = ctx.chat;
    const canon = buildCanon(brainXml, chat, messageId);
    const recentChat = chat.slice(Math.max(0, messageId - RECENT_CONTEXT), messageId)
        .filter(m => m && !m.is_system)
        .map(m => `${m.is_user ? 'User' : (m.name || 'AI')}: ${textOf(m)}`)
        .join('\n\n');
    const reply = splitStatus(chat[messageId].mes).body;

    const prompt = [
        '=== CANON ===', canon || '(empty)', '',
        '=== RECENT CHAT (newer than the canon, also true) ===', recentChat || '(none)', '',
        '=== REPLY TO CHECK ===', reply, '',
        'Return the JSON object now.',
    ].join('\n');

    const raw = await ctx.generateRaw({
        prompt,
        systemPrompt: await loadPrompt('guard-check-system.txt', DEFAULT_CHECK_PROMPT),
        instructOverride: true,
        responseLength: CHECK_RESPONSE_LENGTH,
    });
    let json;
    try {
        json = JSON.parse(extractJson(raw));
    } catch (e) {
        throw new Error(`Prüf-Antwort nicht als JSON verwertbar: ${e?.message || e}`);
    }
    const str = (x) => (typeof x === 'string' ? x.trim() : '');
    const replyNorm = normalize(reply);
    const issues = (Array.isArray(json.issues) ? json.issues : [])
        .map(i => ({ severity: i?.severity === 'hard' ? 'hard' : 'soft', quote: str(i?.quote), problem: str(i?.problem), fix: str(i?.fix) }))
        .filter(i => i.problem)
        // Zitat nicht in der Antwort auffindbar → unsicher, nur markieren
        .map(i => (i.severity === 'hard' && i.quote && !replyNorm.includes(normalize(i.quote)) ? { ...i, severity: 'soft' } : i));
    return { issues, canon };
}

/**
 * Lässt die Erzähl-KI nur die betroffenen Stellen umschreiben. Das Statusfenster
 * wird nicht angefasst (wird danach wieder angefügt).
 * @returns {Promise<string|null>} neue Nachricht oder null, wenn das Ergebnis nicht plausibel ist
 */
export async function rewriteMessage({ ctx, text, issues, canon }) {
    const parts = splitStatus(text);
    const list = issues.map((i, n) => `${n + 1}. "${i.quote}" – ${i.problem}${i.fix ? ` → ${i.fix}` : ''}`).join('\n');
    const prompt = [
        '=== FACTS ===', canon || '(none)', '',
        '=== CONTRADICTIONS TO FIX ===', list, '',
        '=== REPLY ===', parts.body, '',
        'Output the full revised reply now.',
    ].join('\n');

    const raw = await ctx.generateRaw({
        prompt,
        systemPrompt: await loadPrompt('guard-fix-system.txt', DEFAULT_FIX_PROMPT),
        instructOverride: true,
        responseLength: FIX_RESPONSE_LENGTH,
    });
    let revised = String(raw ?? '').trim().replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    const ratio = revised.length / Math.max(1, parts.body.length);
    if (!revised || ratio < 0.6 || ratio > 1.5 || normalize(revised) === normalize(parts.body)) {
        console.warn(`${LOG_PREFIX} guard: rewrite rejected (ratio=${ratio.toFixed(2)})`);
        return null;
    }
    return parts.join(revised);
}

/** Setzt die korrigierte Fassung als neuen Swipe ein; das Original bleibt zurückwischbar. */
function applyAsSwipe(ctx, messageId, newText, record) {
    const msg = ctx.chat[messageId];
    msg.extra = msg.extra || {};
    if (!Array.isArray(msg.swipes) || !msg.swipes.length) {
        msg.swipes = [msg.mes];
        msg.swipe_id = 0;
    }
    if (!Array.isArray(msg.swipe_info)) msg.swipe_info = [];
    const info = (extra) => ({ send_date: msg.send_date, gen_started: msg.gen_started, gen_finished: msg.gen_finished, extra });

    const originalId = msg.swipe_id ?? 0;
    msg.swipes[originalId] = msg.mes;
    msg.extra.ccs_guard = { ...record, fixed: false, correctedIn: msg.swipes.length };
    msg.swipe_info[originalId] = info(structuredClone(msg.extra));

    const fixedExtra = structuredClone(msg.extra);
    delete fixedExtra.token_count;
    fixedExtra.ccs_guard = { ...record, hash: hashText(newText), fixed: true, originalSwipe: originalId };
    msg.swipes.push(newText);
    msg.swipe_info[msg.swipes.length - 1] = info(fixedExtra);
    msg.swipe_id = msg.swipes.length - 1;
    msg.mes = newText;
    msg.extra = structuredClone(fixedExtra);

    ctx.updateMessageBlock(messageId, msg);
    ctx.swipe?.refresh?.(true);
}

function setRecord(msg, record) {
    msg.extra = msg.extra || {};
    msg.extra.ccs_guard = record;
    if (Array.isArray(msg.swipe_info) && msg.swipe_info[msg.swipe_id ?? 0]) {
        msg.swipe_info[msg.swipe_id ?? 0].extra = structuredClone(msg.extra);
    }
}

/**
 * Prüft (und korrigiert ggf.) eine Nachricht.
 * @param {number} messageId
 * @param {object} [opts]
 * @param {boolean} [opts.forceFix] – auch im Modus "mark" korrigieren (Button im Detail-Popup)
 * @param {boolean} [opts.recheck] – bereits geprüfte Nachricht erneut prüfen
 */
export async function runGuard(messageId, { forceFix = false, recheck = false } = {}) {
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const chatId = ctx.chatId;
    const msg = ctx.chat?.[messageId];
    if (!msg || msg.is_user || msg.is_system || messageId === 0) return;
    const brainXml = await storage.getLivingDocument();
    if (!brainXml) return;
    const hash = hashText(msg.mes);
    const existing = msg.extra?.ccs_guard;
    if (!recheck && !forceFix && existing?.hash === hash) return;

    renderBadge(messageId, { checking: true });
    const t0 = Date.now();
    let issues = existing?.hash === hash && !recheck ? existing.issues : null;
    let canon = '';
    if (!issues) ({ issues, canon } = await checkMessage({ ctx, brainXml, messageId }));
    else canon = buildCanon(brainXml, ctx.chat, messageId);

    const stillValid = () => SillyTavern.getContext().chatId === chatId && hashText(ctx.chat[messageId]?.mes) === hash;
    if (!stillValid()) return;

    const hard = issues.filter(i => i.severity === 'hard');
    const record = { hash, issues, fixed: false, at: Date.now() };
    let fixed = false;
    if (hard.length && (s.guardMode === 'fix' || forceFix) && canApply(ctx.chat, messageId)) {
        const revised = await rewriteMessage({ ctx, text: msg.mes, issues: hard, canon });
        if (revised && stillValid() && canApply(ctx.chat, messageId)) {
            applyAsSwipe(ctx, messageId, revised, record);
            fixed = true;
        }
    }
    if (!fixed) setRecord(msg, record);
    await ctx.saveChat();
    renderBadge(messageId);
    console.log(`${LOG_PREFIX} guard: message ${messageId} checked in ${((Date.now() - t0) / 1000).toFixed(1)}s – ${issues.length} issue(s), ${hard.length} hard${fixed ? ', fixed as new swipe' : ''}`);
    return { issues, fixed };
}

/** Event-Handler: neue Antwort gerendert. */
export function onMessageRendered(messageId, type) {
    const s = getSettings();
    const id = Number(messageId);
    if (!s.enabled || !s.guardMode || s.guardMode === 'off' || type === 'impersonate' || type === 'first_message' || !Number.isFinite(id)) {
        hold(false);
        return;
    }
    if (s.guardHold) hold(true);
    const job = runGuard(id)
        .catch(err => {
            console.warn(`${LOG_PREFIX} guard failed`, err);
            toastr.warning(err?.message || String(err), 'CCS-Wächter', { timeOut: 6000, preventDuplicates: true });
            renderBadge(id);
        })
        .finally(() => {
            if (running === job) running = null;
            if (!currentGen) hold(false);
        });
    running = job;
}

// --- Markierungen an den Nachrichten -------------------------------------------

function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = String(s ?? '');
    return div.innerHTML;
}

/** Zeichnet die Markierung einer Nachricht (oder entfernt sie). */
export function renderBadge(messageId, { checking = false } = {}) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) return;
    mesEl.querySelector('.ccs-guard-badge')?.remove();
    const record = SillyTavern.getContext().chat?.[messageId]?.extra?.ccs_guard;
    const anchor = mesEl.querySelector('.mes_text');
    if (!anchor) return;

    let cls;
    let label;
    if (checking) {
        cls = 'checking';
        label = '<i class="fa-solid fa-spinner fa-spin"></i> CCS prüft …';
    } else if (record?.fixed) {
        cls = 'fixed';
        label = `<i class="fa-solid fa-shield-halved"></i> CCS: korrigiert (${record.issues.filter(i => i.severity === 'hard').length})`;
    } else if (record?.issues?.length) {
        const hard = record.issues.filter(i => i.severity === 'hard').length;
        cls = hard ? 'issue' : 'soft';
        label = `<i class="fa-solid fa-triangle-exclamation"></i> CCS: ${hard ? `${hard} ${hard === 1 ? 'Widerspruch' : 'Widersprüche'}` : `${record.issues.length} Hinweis${record.issues.length === 1 ? '' : 'e'}`}`;
    } else {
        return;
    }
    const badge = document.createElement('div');
    badge.className = `ccs-guard-badge ccs-guard-badge--${cls}`;
    badge.innerHTML = label;
    if (!checking) {
        badge.title = 'Details anzeigen';
        badge.addEventListener('click', () => showDetails(messageId));
    }
    anchor.parentNode.insertBefore(badge, anchor);
}

export function renderAllBadges() {
    const chat = SillyTavern.getContext().chat || [];
    chat.forEach((m, i) => { if (m?.extra?.ccs_guard) renderBadge(i); });
}

async function showDetails(messageId) {
    const ctx = SillyTavern.getContext();
    const record = ctx.chat?.[messageId]?.extra?.ccs_guard;
    if (!record) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ccs-guard-popup';
    const intro = record.fixed
        ? `<p>Diese Fassung wurde automatisch korrigiert. Das Original liegt als Swipe ${Number(record.originalSwipe) + 1} – einfach zurückwischen.</p>`
        : '<p>Gefundene Widersprüche zum Brain:</p>';
    const items = record.issues.map(i => `<li><b>${i.severity === 'hard' ? 'Widerspruch' : 'Hinweis'}:</b> ${escapeHtml(i.problem)}${i.quote ? `<br><i>„${escapeHtml(i.quote)}“</i>` : ''}${i.fix ? `<br>→ ${escapeHtml(i.fix)}` : ''}</li>`).join('');
    wrapper.innerHTML = `<h3>CCS-Wächter</h3>${intro}<ul>${items}</ul>`;
    const canFix = !record.fixed && record.issues.some(i => i.severity === 'hard');
    const choice = await ctx.callGenericPopup(wrapper, canFix ? ctx.POPUP_TYPE.CONFIRM : ctx.POPUP_TYPE.TEXT, '', canFix
        ? { okButton: 'Jetzt korrigieren', cancelButton: 'Schließen', allowVerticalScrolling: true }
        : { okButton: 'Schließen', allowVerticalScrolling: true });
    if (canFix && choice === ctx.POPUP_RESULT.AFFIRMATIVE) {
        try {
            const res = await runGuard(messageId, { forceFix: true });
            if (!res?.fixed) toastr.info('Keine plausible Korrektur erhalten – Nachricht unverändert.', 'CCS-Wächter');
        } catch (err) {
            toastr.error(err?.message || String(err), 'CCS-Wächter');
        }
    }
}
