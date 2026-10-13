import * as storage from './src/storage.js';
import * as collector from './src/collector.js';
import * as initializer from './src/initializer.js';
import * as interceptor from './src/interceptor.js';
import * as updater from './src/updater.js';
import * as popup from './src/popup.js';
import * as hub from './src/hub.js';
import * as director from './src/director.js';
import * as pins from './src/pins.js';
import * as render from './src/render.js';
import * as cursor from './src/cursor.js';

/**
 * Stabile Identität der Extension. Wird als Key in `extensionSettings` genutzt
 * und darf sich NICHT ändern, sonst verlieren User ihre Einstellungen, sobald
 * der Extension-Ordner anders heißt (z.B. nach Install via GitHub-Repo-Name).
 */
const MODULE_NAME = 'curated-context-system';
const LOG_PREFIX = '[CCS]';

/**
 * Tatsächlicher Ordnername der Extension auf der Disk. Wird zur Laufzeit aus
 * `import.meta.url` abgeleitet, weil SillyTavern's Extension-Cloner den Ordner
 * typischerweise nach dem GitHub-Repo-Namen benennt (z.B. "Curated-Contex-System"),
 * der von unserem stabilen MODULE_NAME abweichen kann. Dieser Wert wird NUR für
 * `renderExtensionTemplateAsync` gebraucht – überall sonst reicht MODULE_NAME.
 * Fallback auf MODULE_NAME, falls die URL-Analyse unerwartet fehlschlägt
 * (dann verhält sich die Extension genau wie vor dem Fix).
 */
const EXTENSION_FOLDER = (() => {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('third-party');
        if (idx >= 0 && idx + 1 < parts.length) {
            return parts[idx + 1];
        }
    } catch { /* fall through */ }
    return MODULE_NAME;
})();

const DEFAULT_SETTINGS = {
    enabled: true,
    historyEnabled: true,
    ccsTokenBudget: 0,
    maxChatMessages: 0,
    directorEnabled: false,
    directorDetail: 'standard',
    autoUpdateEnabled: false,
    autoUpdateEvery: 10,
    autoUpdateAccept: false,
    dedupeCard: true,
    stateDepth: 1,
    relevanceWindow: 6,
};

function getContext() {
    return typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
}

function getSettings() {
    const ctx = getContext();
    if (!ctx) return { ...DEFAULT_SETTINGS };

    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    const s = ctx.extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (typeof s[key] === 'undefined') s[key] = DEFAULT_SETTINGS[key];
    }
    // Hinweis: frühere Versionen haben hier `initSystemPrompt` /
    // `updateSystemPrompt` in die Settings geseedet. Das war PC-lokal und hat
    // verhindert, dass User-Anpassungen zwischen PCs synchronisiert werden.
    // Jetzt liegen die Prompts als Dateien im `prompts/`-Ordner und wandern per
    // git push/pull mit. Wenn ein User ein altes Profile mit den obsoleten
    // Keys hat, stören sie nicht – sie werden einfach nicht mehr gelesen.
    return s;
}

function saveSettings() {
    const ctx = getContext();
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

function updateStatusUI() {
    const settings = getSettings();
    const $status = $('#ccs-status');
    if ($status.length) {
        $status.text(settings.enabled ? 'Aktiv' : 'Deaktiviert');
        $status.toggleClass('ccs-status--active', !!settings.enabled);
        $status.toggleClass('ccs-status--inactive', !settings.enabled);
    }
}

function updateBrainStateUI() {
    const $el = $('#ccs-brain-state');
    if (!$el.length) return;
    const ctx = getContext();
    if (!ctx?.chatId) {
        $el.text('Brain: (kein Chat geladen)');
        $el.removeClass('ccs-brain-state--has ccs-brain-state--empty');
        return;
    }
    const has = storage.hasLivingDocument();
    $el.text(has ? 'Brain: vorhanden' : 'Brain: leer');
    $el.toggleClass('ccs-brain-state--has', has);
    $el.toggleClass('ccs-brain-state--empty', !has);
}

async function refreshPinsUI() {
    const $list = $('#ccs-pins-list');
    if (!$list.length) return;

    let pinList = [];
    try {
        const xml = await storage.getLivingDocument();
        pinList = pins.getPins(xml);
    } catch { /* nop */ }

    if (!pinList.length) {
        $list.html('<div class="ccs-pins-empty">Keine Pins</div>');
        return;
    }

    $list.empty();
    pinList.forEach((text, i) => {
        const item = document.createElement('div');
        item.className = 'ccs-pin-item';

        const textEl = document.createElement('span');
        textEl.className = 'ccs-pin-text';
        textEl.textContent = text;
        textEl.title = 'Doppelklick zum Bearbeiten';
        textEl.addEventListener('dblclick', () => {
            if (textEl.querySelector('textarea')) return;

            const ta = document.createElement('textarea');
            ta.className = 'ccs-pin-edit';
            ta.value = text;
            ta.style.width = '100%';
            ta.style.minHeight = '2.5em';
            ta.style.resize = 'vertical';
            ta.style.fontFamily = 'inherit';
            ta.style.fontSize = 'inherit';
            textEl.textContent = '';
            textEl.appendChild(ta);
            ta.focus();

            const finish = async (save) => {
                const newText = ta.value.trim();
                textEl.innerHTML = '';
                if (save && newText && newText !== text) {
                    try {
                        await pins.updatePinAndSave(i, newText);
                        hub.refresh();
                    } catch (err) {
                        toastr.error(err?.message || String(err), 'CCS: Pin bearbeiten fehlgeschlagen');
                        console.error(`${LOG_PREFIX} update pin failed`, err);
                    }
                }
                refreshPinsUI();
            };

            ta.addEventListener('blur', () => finish(true));
            ta.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' && !ev.shiftKey) {
                    ev.preventDefault();
                    ta.blur();
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    finish(false);
                }
            });
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'ccs-pin-delete-btn';
        delBtn.title = 'Pin löschen';
        delBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        delBtn.addEventListener('click', async function () {
            try {
                await pins.deletePinAndSave(i);
                refreshPinsUI();
                hub.refresh();
            } catch (err) {
                toastr.error(err?.message || String(err), 'CCS: Pin löschen fehlgeschlagen');
                console.error(`${LOG_PREFIX} delete pin failed`, err);
            }
        });

        item.appendChild(textEl);
        item.appendChild(delBtn);
        $list.append(item);
    });
}

async function onInitializeClicked() {
    const ctx = getContext();
    if (!ctx) return;
    if (!ctx.chatId) {
        toastr.warning('Bitte zuerst einen Chat öffnen.', 'CCS', { preventDuplicates: true });
        return;
    }

    // Überschreib-Check
    if (storage.hasLivingDocument()) {
        const res = await ctx.callGenericPopup(
            'Für diesen Chat existiert bereits ein Brain. Überschreiben?',
            ctx.POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Überschreiben', cancelButton: 'Abbrechen' },
        );
        if (res !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
    }

    // Quellen-Auswahl-Popup
    const content = document.createElement('div');
    content.className = 'ccs-source-popup';
    content.innerHTML = `
        <h3 style="margin-top:0">Quellen auswählen</h3>
        <p>Welche Quellen sollen für die Initialisierung verwendet werden?</p>
        <label class="checkbox_label"><input type="checkbox" data-ccs-source="character" checked><span>Character (Card + Character-Lorebook)</span></label>
        <label class="checkbox_label"><input type="checkbox" data-ccs-source="chat" checked><span>Chat-Lorebook</span></label>
        <label class="checkbox_label"><input type="checkbox" data-ccs-source="persona" checked><span>Persona-Lorebook</span></label>
        <label class="checkbox_label"><input type="checkbox" data-ccs-source="global" checked><span>Globale Lorebooks</span></label>
        <div class="ccs-lang-row">
            <label for="ccs-init-lang"><strong>Ziel-Sprache des Brains:</strong></label>
            <select id="ccs-init-lang" class="text_pole">
                <option value="de" selected>Deutsch</option>
                <option value="en">English</option>
                <option value="">Auto (Quellsprache)</option>
                <option value="fr">Français</option>
                <option value="es">Español</option>
                <option value="it">Italiano</option>
                <option value="pt">Português</option>
                <option value="nl">Nederlands</option>
                <option value="pl">Polski</option>
                <option value="ru">Русский</option>
                <option value="ja">日本語</option>
                <option value="zh">中文</option>
                <option value="ko">한국어</option>
            </select>
            <small class="ccs-lang-hint">Überschreibt die Sprache der Quellen. Das LLM übersetzt bei Bedarf.</small>
        </div>
    `;

    const choice = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.TEXT, '', {
        okButton: 'Initialisieren',
        cancelButton: 'Abbrechen',
    });
    if (choice !== ctx.POPUP_RESULT.AFFIRMATIVE) return;

    const config = {
        character: !!content.querySelector('[data-ccs-source="character"]')?.checked,
        chat: !!content.querySelector('[data-ccs-source="chat"]')?.checked,
        persona: !!content.querySelector('[data-ccs-source="persona"]')?.checked,
        global: !!content.querySelector('[data-ccs-source="global"]')?.checked,
        lang: content.querySelector('#ccs-init-lang')?.value || '',
    };

    // Progress-Toast (sticky bis wir ihn killen)
    const $btn = $('#ccs-init-btn').prop('disabled', true);
    toastr.clear();
    const progress = toastr.info('Brain wird erstellt... Das kann einen Moment dauern.', 'CCS', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
    });

    try {
        // System-Prompt wird intern via `loadInitSystemPrompt()` aus `prompts/init-system.txt`
        // geladen. `skipSave: true` verhindert, dass generateInitial selbst speichert –
        // wir zeigen stattdessen einen Review-Popup vor dem finalen Save.
        const result = await initializer.generateInitial({ ...config, skipSave: true });
        toastr.clear(progress);

        // Review-Popup: XML prüfen und ggf. anpassen, dann speichern oder verwerfen
        const wrapper = document.createElement('div');
        wrapper.className = 'ccs-edit-popup';
        const hint = document.createElement('p');
        hint.className = 'ccs-edit-hint';
        hint.innerHTML = 'Brain-XML vor dem Speichern prüfen und bei Bedarf anpassen – wie beim Bearbeiten. Speichern übernimmt das Brain. Abbrechen verwirft alles.';
        wrapper.appendChild(hint);

        const ta = document.createElement('textarea');
        ta.value = result.xml;
        ta.className = 'ccs-view-textarea text_pole';
        ta.style.width = '100%';
        ta.style.minHeight = '60vh';
        ta.style.fontFamily = 'monospace';
        ta.style.whiteSpace = 'pre';
        ta.spellcheck = false;
        wrapper.appendChild(ta);

        ta.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') ev.stopPropagation();
        });

        const choice = await ctx.callGenericPopup(wrapper, ctx.POPUP_TYPE.TEXT, '', {
            okButton: 'Speichern',
            cancelButton: 'Abbrechen',
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            onClosing: async (popup) => {
                if (popup.result !== ctx.POPUP_RESULT.AFFIRMATIVE) return true;

                const edited = (ta.value || '').trim();
                if (!edited) {
                    toastr.warning('Brain darf nicht leer sein.', 'CCS');
                    return false;
                }

                const { xml: repaired, repairs } = initializer.repairBrainXml(edited);
                const v = initializer.validateBrainXml(repaired);
                if (!v.ok) {
                    toastr.error(`Ungültiges XML: ${v.error}`, 'CCS', { timeOut: 10000 });
                    return false;
                }

                if (repairs > 0) {
                    ta.value = repaired;
                    toastr.info(`${repairs} Tag-Fehler automatisch korrigiert.`, 'CCS');
                }
                return true;
            },
        });

        if (choice !== ctx.POPUP_RESULT.AFFIRMATIVE) {
            toastr.info('Initialisierung abgebrochen – Brain verworfen.', 'CCS');
            return;
        }

        const finalXml = (ta.value || '').trim();
        await storage.saveLivingDocument(finalXml);
        pendingUpdate = null;
        updatePendingUI();
        toastr.success(`Brain gespeichert (${finalXml.length} Zeichen).`, 'CCS');
        updateBrainStateUI();
        refreshPinsUI();
        hub.refresh();
    } catch (err) {
        toastr.clear(progress);
        const msg = err?.message || String(err);
        toastr.error(msg, 'CCS: Fehler bei Initialisierung', { timeOut: 10000 });
        console.error(`${LOG_PREFIX} init failed`, err);
    } finally {
        $btn.prop('disabled', false);
    }
}

async function onViewClicked() {
    const ctx = getContext();
    if (!ctx) return;
    if (!ctx.chatId) {
        toastr.warning('Bitte zuerst einen Chat öffnen.', 'CCS', { preventDuplicates: true });
        return;
    }
    const originalXml = await storage.getLivingDocument();
    if (!originalXml) {
        toastr.info('Kein Brain für diesen Chat vorhanden.', 'CCS', { preventDuplicates: true });
        return;
    }

    // Wrapper-Div: Hinweis oben + Textarea darunter. Hilft dem User zu verstehen,
    // dass er hier direkt editieren kann und was beim Speichern passiert.
    const wrapper = document.createElement('div');
    wrapper.className = 'ccs-edit-popup';
    const hint = document.createElement('p');
    hint.className = 'ccs-edit-hint';
    hint.innerHTML = 'Brain-XML direkt editierbar. Beim Speichern wird automatisch validiert – ungültiges XML wird nicht übernommen und das Popup bleibt offen. Abbrechen verwirft alle Änderungen.';
    wrapper.appendChild(hint);

    const ta = document.createElement('textarea');
    ta.value = originalXml;
    ta.className = 'ccs-view-textarea text_pole';
    ta.style.width = '100%';
    ta.style.minHeight = '60vh';
    ta.style.fontFamily = 'monospace';
    ta.style.whiteSpace = 'pre';
    ta.spellcheck = false;
    wrapper.appendChild(ta);

    // Verhindert, dass der Popup-Default-Enter-Submit unser Textarea frustriert.
    ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') ev.stopPropagation();
    });

    const choice = await ctx.callGenericPopup(wrapper, ctx.POPUP_TYPE.TEXT, '', {
        okButton: 'Speichern',
        cancelButton: 'Abbrechen',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        // onClosing: Validation-Gate. Nur bei AFFIRMATIVE (Speichern) prüfen wir.
        // Auto-Repair läuft mit: fixt gleiche Tag-Mismatches wie nach LLM-Call.
        // Rückgabe `false` → Popup bleibt offen, Edits intakt.
        onClosing: async (popup) => {
            if (popup.result !== ctx.POPUP_RESULT.AFFIRMATIVE) return true;

            const edited = (ta.value || '').trim();
            if (!edited) {
                toastr.warning('Brain darf nicht leer sein. Zum Entfernen bitte den Löschen-Button verwenden.', 'CCS');
                return false;
            }

            const { xml: repaired, repairs } = initializer.repairBrainXml(edited);
            const v = initializer.validateBrainXml(repaired);
            if (!v.ok) {
                toastr.error(`Ungültiges XML: ${v.error}`, 'CCS', { timeOut: 10000 });
                return false;
            }

            if (repairs > 0) {
                // Sichtbar machen, was wir geändert haben, bevor wir speichern.
                ta.value = repaired;
                toastr.info(`${repairs} Tag-Fehler automatisch korrigiert.`, 'CCS');
            }
            return true;
        },
    });

    if (choice !== ctx.POPUP_RESULT.AFFIRMATIVE) return;

    const finalXml = (ta.value || '').trim();
    // Wenn nichts geändert wurde: Save überspringen (kein unnötiges delete+reupload).
    if (finalXml === originalXml) {
        toastr.info('Keine Änderungen – nichts gespeichert.', 'CCS');
        return;
    }

    try {
        await storage.saveLivingDocument(finalXml);
        toastr.success(`Brain gespeichert (${finalXml.length} Zeichen).`, 'CCS');
        updateBrainStateUI();
        refreshPinsUI();
        hub.refresh();
    } catch (err) {
        toastr.error(err?.message || String(err), 'CCS: Speichern fehlgeschlagen', { timeOut: 10000 });
        console.error(`${LOG_PREFIX} save-from-viewer failed`, err);
    }
}

// --- Brain-Update (manuell + automatisch) ------------------------------------
//
// Beide Wege nutzen updater.runUpdate(). Manuell: sofort Review-Popup.
// Automatisch (alle N Nachrichten): Ergebnis wird als `pendingUpdate` gesammelt
// und per Toast/Badge zur Freigabe angeboten – oder, wenn "ohne Rückfrage"
// aktiv ist, direkt übernommen.

/** Analysierter, noch nicht freigegebener Update-Block: { chatId, result } */
let pendingUpdate = null;
let updateRunning = false;
let autoUpdateTimer = null;

/** Auto-Update analysiert die jüngsten N Messages nicht (Swipe/Edit möglich). */
const AUTO_HOLD_BACK = 2;

function setUpdateBusy(busy) {
    updateRunning = busy;
    $('#ccs-update-btn').prop('disabled', busy);
}

function updatePendingUI() {
    const ctx = getContext();
    const n = pendingUpdate && pendingUpdate.chatId === ctx?.chatId
        ? pendingUpdate.result.proposals.length
        : 0;
    $('#ccs-pending-badge')
        .text(n ? `${n} ${n === 1 ? 'Vorschlag wartet' : 'Vorschläge warten'} auf Freigabe – hier klicken` : '')
        .toggle(n > 0);
}

function notifyRemaining(remaining) {
    if (remaining > 0) {
        toastr.info(`Noch ${remaining} Nachricht${remaining === 1 ? '' : 'en'} offen – für den nächsten Block erneut "Brain updaten".`, 'CCS', { timeOut: 8000 });
    }
}

function refreshAfterSave() {
    updateBrainStateUI();
    refreshPinsUI();
    hub.refresh();
}

/**
 * Wendet Proposals auf das AKTUELLE Brain an. Zwischen Analyse und Freigabe
 * können Pins oder manuelle Edits dazugekommen sein – die dürfen nicht durch
 * den Analyse-Stand überschrieben werden. Hat sich der Cursor verändert (ein
 * anderes Update lief dazwischen), ist das Ergebnis veraltet → Abbruch.
 */
async function applyUpdateResult(result, approved) {
    const current = await storage.getLivingDocument();
    if (!current) throw new Error('Brain nicht mehr vorhanden.');
    if (!Object.is(cursor.resolveCursor(current, getContext()?.chat), result.baseCursor)) {
        throw new Error('Brain wurde inzwischen anderweitig aktualisiert – Vorschläge verworfen.');
    }
    const { xml: base } = updater.migrateLegacyBrain(current);
    return updater.applyProposals(approved, base, result.cursorIndex, getSettings(), result.chatId);
}

function toastApplySummary(applyResult) {
    const appliedN = applyResult.applied;
    const failedN = applyResult.failed.length;
    if (appliedN > 0 && failedN === 0) {
        toastr.success(`${appliedN} Änderung${appliedN === 1 ? '' : 'en'} übernommen.`, 'CCS');
    } else if (appliedN > 0 && failedN > 0) {
        toastr.warning(`${appliedN} übernommen, ${failedN} fehlgeschlagen (siehe Konsole).`, 'CCS', { timeOut: 10000 });
    } else if (failedN > 0) {
        // applied === 0 && failed > 0: kein Save; Brain ist unverändert.
        toastr.error(`0 übernommen, ${failedN} fehlgeschlagen. Brain unverändert.`, 'CCS', { timeOut: 10000 });
    }
}

/**
 * Zeigt das Review-Popup für ein Update-Ergebnis und wendet die freigegebenen
 * Proposals an. Leere Proposal-Liste → nur Cursor nachziehen.
 * @returns {Promise<boolean>} true, wenn gespeichert wurde
 */
async function reviewAndApply(result) {
    const ctx = getContext();

    // Shape ok, aber leere Vorschläge → nur Cursor nachziehen, damit die schon
    // analysierten Messages bei nächstem Klick nicht wieder gescannt werden.
    if (!result.proposals.length) {
        await applyUpdateResult(result, []);
        refreshAfterSave();
        toastr.info('Keine neuen Einträge – Cursor aktualisiert.', 'CCS');
        notifyRemaining(result.remaining);
        return true;
    }

    const popupApi = popup.renderUpdatePopup({
        proposals: result.proposals,
        migratedBrainXml: result.migratedBrainXml,
        reasoning: result.reasoning || '',
    });

    const choice = await ctx.callGenericPopup(popupApi.wrapper, ctx.POPUP_TYPE.TEXT, '', {
        okButton: 'Übernehmen',
        cancelButton: 'Abbrechen',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        // Validation-Gate: bei "Übernehmen" prüfen wir Pflichtfelder + Referenz-
        // Integrität. Rückgabe `false` → Popup bleibt offen, Edits intakt,
        // rotes Highlighting bleibt. Bei Cancel immer `true` → Popup schließt.
        onClosing: async (pop) => {
            if (pop.result !== ctx.POPUP_RESULT.AFFIRMATIVE) return true;
            const v = popupApi.validate();
            if (!v.ok) {
                toastr.error(v.error || 'Ungültige Eingabe', 'CCS', { timeOut: 7000 });
                if (v.focusEl && typeof v.focusEl.focus === 'function') {
                    try { v.focusEl.focus(); } catch { /* nop */ }
                }
                return false;
            }
            return true;
        },
    });

    if (choice !== ctx.POPUP_RESULT.AFFIRMATIVE) {
        toastr.info('Update abgebrochen – Cursor unverändert. Die Nachrichten werden beim nächsten Update erneut analysiert.', 'CCS');
        return false;
    }

    const applyResult = await applyUpdateResult(result, popupApi.collectApproved());
    refreshAfterSave();
    toastApplySummary(applyResult);
    if (applyResult.applied > 0) notifyRemaining(result.remaining);
    return applyResult.applied > 0;
}

/** Prüft ein frisches runUpdate-Ergebnis auf "nichts zu tun" / "kaputt". */
function checkUpdateResult(result, { silent = false } = {}) {
    if (result.scanWindowEmpty) {
        if (!silent) toastr.info('Nichts Neues seit letztem Update.', 'CCS', { preventDuplicates: true });
        return false;
    }
    if (!result.shape_ok) {
        toastr.error('Update-Antwort strukturell ungültig (shape_ok=false). Brain unverändert.', 'CCS', { timeOut: 10000 });
        console.warn(`${LOG_PREFIX} update shape_ok=false`, result);
        return false;
    }
    return true;
}

async function onUpdateClicked() {
    const ctx = getContext();
    if (!ctx) return;
    if (!ctx.chatId) {
        toastr.warning('Bitte zuerst einen Chat öffnen.', 'CCS', { preventDuplicates: true });
        return;
    }
    const settings = getSettings();
    if (!settings.enabled) {
        toastr.warning('CCS ist deaktiviert – bitte oben aktivieren.', 'CCS', { preventDuplicates: true });
        return;
    }
    if (!storage.hasLivingDocument()) {
        toastr.info('Kein Brain vorhanden – bitte zuerst initialisieren.', 'CCS', { preventDuplicates: true });
        return;
    }
    if (updateRunning) {
        toastr.info('Ein Update läuft bereits – bitte kurz warten.', 'CCS', { preventDuplicates: true });
        return;
    }

    setUpdateBusy(true);
    try {
        // Gesammelte Auto-Update-Vorschläge haben Vorrang – die sind schon analysiert.
        let result;
        if (pendingUpdate && pendingUpdate.chatId === ctx.chatId) {
            result = pendingUpdate.result;
            pendingUpdate = null;
            updatePendingUI();
        } else {
            toastr.clear();
            const progress = toastr.info('Chat wird analysiert... Das kann einen Moment dauern.', 'CCS', {
                timeOut: 0,
                extendedTimeOut: 0,
                tapToDismiss: false,
            });
            try {
                // System-Prompt wird intern via `loadUpdateSystemPrompt()` aus
                // `prompts/update-system.txt` geladen.
                result = await updater.runUpdate({ ctx, settings });
            } finally {
                toastr.clear(progress);
            }
            if (!checkUpdateResult(result)) return;
        }

        await reviewAndApply(result);
    } catch (err) {
        toastr.error(err?.message || String(err), 'CCS: Fehler beim Update', { timeOut: 10000 });
        console.error(`${LOG_PREFIX} update failed`, err);
    } finally {
        setUpdateBusy(false);
    }
    scheduleAutoUpdate();
}

/** Zählt narrative Messages seit dem Cursor (ohne die zurückgehaltenen jüngsten). */
async function countUnanalyzed(ctx) {
    const xml = await storage.getLivingDocument();
    if (!xml) return 0;
    const chat = Array.isArray(ctx.chat) ? ctx.chat.slice(0, Math.max(0, ctx.chat.length - AUTO_HOLD_BACK)) : [];
    const plan = updater.planScanWindow(chat, cursor.resolveCursor(xml, ctx.chat));
    return plan.messages.length + plan.remaining;
}

async function runAutoUpdate() {
    const ctx = getContext();
    const settings = getSettings();
    if (!ctx?.chatId || !settings.enabled || !settings.autoUpdateEnabled) return;
    if (updateRunning || (pendingUpdate && pendingUpdate.chatId === ctx.chatId)) return;
    if (!storage.hasLivingDocument()) return;

    const open = await countUnanalyzed(ctx);
    if (open < settings.autoUpdateEvery) return;

    console.log(`${LOG_PREFIX} auto-update: ${open} unanalyzed messages (threshold=${settings.autoUpdateEvery})`);
    setUpdateBusy(true);
    let again = false;
    try {
        const result = await updater.runUpdate({ ctx, settings, holdBack: AUTO_HOLD_BACK });
        if (getContext()?.chatId !== result.chatId) return; // Chat gewechselt → verwerfen
        if (!checkUpdateResult(result, { silent: true })) return;

        // "Ohne Rückfrage": Popup-Logik unsichtbar nutzen – gleiche IDs, gleiche
        // Validierung wie beim manuellen Freigeben. Ungültig → doch zur Freigabe.
        let approved = null;
        if (!result.proposals.length) {
            approved = [];
        } else if (settings.autoUpdateAccept) {
            const api = popup.renderUpdatePopup({ proposals: result.proposals, migratedBrainXml: result.migratedBrainXml, reasoning: '' });
            if (api.validate().ok) approved = api.collectApproved();
        }

        if (approved) {
            const applyResult = await applyUpdateResult(result, approved);
            refreshAfterSave();
            if (result.proposals.length) {
                toastr.success(`Auto-Update: ${applyResult.applied} Änderung${applyResult.applied === 1 ? '' : 'en'} übernommen.`, 'CCS');
            }
            if (applyResult.failed.length) toastApplySummary(applyResult);
            again = result.remaining > 0;
        } else {
            pendingUpdate = { chatId: result.chatId, result };
            updatePendingUI();
            const n = result.proposals.length;
            toastr.info(`${n} ${n === 1 ? 'Vorschlag' : 'Vorschläge'} bereit – hier klicken zum Prüfen.`, 'CCS Auto-Update', {
                timeOut: 15000,
                onclick: () => onUpdateClicked(),
            });
        }
    } catch (err) {
        console.warn(`${LOG_PREFIX} auto-update failed`, err);
        toastr.warning(err?.message || String(err), 'CCS: Auto-Update fehlgeschlagen', { timeOut: 8000, preventDuplicates: true });
    } finally {
        setUpdateBusy(false);
    }
    if (again) scheduleAutoUpdate();
}

/** Entprellt: mehrere Events kurz hintereinander lösen nur einen Lauf aus. */
function scheduleAutoUpdate() {
    clearTimeout(autoUpdateTimer);
    autoUpdateTimer = setTimeout(() => {
        runAutoUpdate().catch(err => console.warn(`${LOG_PREFIX} auto-update error`, err));
    }, 1500);
}

async function onDeleteClicked() {
    const ctx = getContext();
    if (!ctx) return;
    if (!ctx.chatId) {
        toastr.warning('Bitte zuerst einen Chat öffnen.', 'CCS', { preventDuplicates: true });
        return;
    }
    if (!storage.hasLivingDocument()) {
        toastr.info('Kein Brain zum Löschen vorhanden.', 'CCS', { preventDuplicates: true });
        return;
    }
    const res = await ctx.callGenericPopup(
        'Brain dieses Chats wirklich löschen? Das kann nicht rückgängig gemacht werden.',
        ctx.POPUP_TYPE.CONFIRM,
        '',
        { okButton: 'Löschen', cancelButton: 'Abbrechen' },
    );
    if (res !== ctx.POPUP_RESULT.AFFIRMATIVE) return;
    try {
        await storage.clearLivingDocument();
        pendingUpdate = null;
        updatePendingUI();
        // Auch den Injection-Slot leeren, damit bis zum nächsten Gen-Event
                    // kein Zombie-Brain mehr hängt.
                    interceptor.clearSlot(ctx);
                    interceptor.clearDirectorSlot(ctx);
        toastr.success('Brain gelöscht.', 'CCS');
        updateBrainStateUI();
        refreshPinsUI();
        hub.refresh();
    } catch (err) {
        toastr.error(err?.message || String(err), 'CCS');
        console.error(`${LOG_PREFIX} delete failed`, err);
    }
}

function bindUI() {
    const settings = getSettings();
    const $enabled = $('#ccs-enabled');
    $enabled.prop('checked', settings.enabled === true);
    $enabled.on('change', function () {
        const s = getSettings();
        s.enabled = $(this).prop('checked');
        saveSettings();
        updateStatusUI();
        // Beim Ausschalten den Slot sofort leeren, damit der nächste Turn
        // kein Brain mehr sieht – auch ohne dass der Interceptor zwischendurch lief.
        if (!s.enabled) {
            interceptor.clearSlot(getContext());
            interceptor.clearDirectorSlot(getContext());
        }
        console.log(`${LOG_PREFIX} enabled set to ${s.enabled}`);
    });
    // Checkbox für History – dynamisch einfügen falls nicht via settings.html gerendert
    if (!$('#ccs-history-enabled').length) {
        const $historyRow = $(`
            <label class="checkbox_label" for="ccs-history-enabled" title="Komprimiert abgeschlossene Szenen in eine verdichtete Chronologie. Reduziert Token-Verbrauch bei langen Chats.">
                <input id="ccs-history-enabled" type="checkbox" />
                <span>History (Chronik-Kompression)</span>
            </label>
        `);
        $('#ccs-enabled').closest('label').after($historyRow);
    }

    const $historyEnabled = $('#ccs-history-enabled');
    $historyEnabled.prop('checked', settings.historyEnabled === true);
    $historyEnabled.on('change', function () {
        const s = getSettings();
        s.historyEnabled = $(this).prop('checked');
        saveSettings();
        console.log(`${LOG_PREFIX} historyEnabled set to ${s.historyEnabled}`);
    });

    const $tokenBudget = $('#ccs-token-budget');
    $tokenBudget.val(settings.ccsTokenBudget ?? 0);
    $tokenBudget.on('change', function () {
        const s = getSettings();
        const v = parseInt($(this).val(), 10);
        s.ccsTokenBudget = Number.isFinite(v) && v >= 0 ? v : 0;
        saveSettings();
        console.log(`${LOG_PREFIX} ccsTokenBudget set to ${s.ccsTokenBudget}`);
    });

    const $maxChat = $('#ccs-max-chat-messages');
    $maxChat.val(settings.maxChatMessages ?? 0);
    $maxChat.on('change', function () {
        const s = getSettings();
        const v = parseInt($(this).val(), 10);
        s.maxChatMessages = Number.isFinite(v) && v >= 0 ? v : 0;
        saveSettings();
        console.log(`${LOG_PREFIX} maxChatMessages set to ${s.maxChatMessages}`);
    });

    // Auto-Update
    const $autoEnabled = $('#ccs-auto-update-enabled');
    $autoEnabled.prop('checked', settings.autoUpdateEnabled === true);
    $autoEnabled.on('change', function () {
        const s = getSettings();
        s.autoUpdateEnabled = $(this).prop('checked');
        saveSettings();
        console.log(`${LOG_PREFIX} autoUpdateEnabled set to ${s.autoUpdateEnabled}`);
        if (s.autoUpdateEnabled) scheduleAutoUpdate();
    });

    const $autoEvery = $('#ccs-auto-update-every');
    $autoEvery.val(settings.autoUpdateEvery);
    $autoEvery.on('change', function () {
        const s = getSettings();
        const v = parseInt($(this).val(), 10);
        s.autoUpdateEvery = Number.isFinite(v) && v >= 2 ? v : DEFAULT_SETTINGS.autoUpdateEvery;
        $(this).val(s.autoUpdateEvery);
        saveSettings();
        console.log(`${LOG_PREFIX} autoUpdateEvery set to ${s.autoUpdateEvery}`);
    });

    const $autoAccept = $('#ccs-auto-update-accept');
    $autoAccept.prop('checked', settings.autoUpdateAccept === true);
    $autoAccept.on('change', function () {
        const s = getSettings();
        s.autoUpdateAccept = $(this).prop('checked');
        saveSettings();
        console.log(`${LOG_PREFIX} autoUpdateAccept set to ${s.autoUpdateAccept}`);
    });

    $('#ccs-pending-badge').on('click', onUpdateClicked);

    // Injektion
    const $dedupe = $('#ccs-dedupe-card');
    $dedupe.prop('checked', settings.dedupeCard !== false);
    $dedupe.on('change', function () {
        const s = getSettings();
        s.dedupeCard = $(this).prop('checked');
        saveSettings();
        console.log(`${LOG_PREFIX} dedupeCard set to ${s.dedupeCard}`);
    });

    const bindNumber = (selector, key, min) => {
        const $el = $(selector);
        $el.val(settings[key]);
        $el.on('change', function () {
            const s = getSettings();
            const v = parseInt($(this).val(), 10);
            s[key] = Number.isFinite(v) && v >= min ? v : DEFAULT_SETTINGS[key];
            $(this).val(s[key]);
            saveSettings();
            console.log(`${LOG_PREFIX} ${key} set to ${s[key]}`);
        });
    };
    bindNumber('#ccs-state-depth', 'stateDepth', 0);
    bindNumber('#ccs-relevance-window', 'relevanceWindow', 1);

    $('#ccs-init-btn').on('click', onInitializeClicked);
    $('#ccs-view-btn').on('click', onViewClicked);
    $('#ccs-update-btn').on('click', onUpdateClicked);
    $('#ccs-delete-btn').on('click', onDeleteClicked);

    // Director-Agent Einstellungen
    const $directorEnabled = $('#ccs-director-enabled');
    $directorEnabled.prop('checked', settings.directorEnabled === true);
    $directorEnabled.on('change', function () {
        const s = getSettings();
        s.directorEnabled = $(this).prop('checked');
        saveSettings();
        console.log(`${LOG_PREFIX} directorEnabled set to ${s.directorEnabled}`);
    });

    const $directorDetail = $('#ccs-director-detail');
    $directorDetail.val(settings.directorDetail || 'standard');
    $directorDetail.on('change', function () {
        const s = getSettings();
        s.directorDetail = $(this).val() || 'standard';
        saveSettings();
        console.log(`${LOG_PREFIX} directorDetail set to ${s.directorDetail}`);
    });

    // Hinweis: Die früheren Prompt-Editor-Textareas wurden entfernt. Die System-
    // Prompts leben jetzt als Dateien unter `prompts/init-system.txt` bzw.
    // `prompts/update-system.txt` und wandern per `git push/pull` zwischen PCs.

    // Pin-Eingabe: Enter fügt hinzu
    const $pinInput = $('#ccs-pin-input');
    $pinInput.on('keydown', async function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        const text = $(this).val().trim();
        if (!text) return;
        const ctx = getContext();
        if (!ctx?.chatId) {
            toastr.warning('Bitte zuerst einen Chat öffnen.', 'CCS');
            return;
        }
        if (!storage.hasLivingDocument()) {
            toastr.info('Kein Brain vorhanden – bitte zuerst initialisieren.', 'CCS');
            return;
        }
        try {
            await pins.addPinAndSave(text);
            $(this).val('');
            refreshPinsUI();
            hub.refresh();
        } catch (err) {
            toastr.error(err?.message || String(err), 'CCS: Pin hinzufügen fehlgeschlagen');
            console.error(`${LOG_PREFIX} add pin failed`, err);
        }
    });

    updateStatusUI();
    updateBrainStateUI();
    refreshPinsUI();
}

async function mountSettingsPanel() {
    const ctx = getContext();
    if (!ctx || typeof ctx.renderExtensionTemplateAsync !== 'function') {
        console.warn(`${LOG_PREFIX} renderExtensionTemplateAsync not available, panel not mounted`);
        return;
    }
    const html = await ctx.renderExtensionTemplateAsync(
        `third-party/${EXTENSION_FOLDER}`,
        'settings',
        {},
        true,
        true,
    );
    $('#extensions_settings2').append(html);
    bindUI();
}

function onChatChanged() {
    const ctx = getContext();
    const chatId = ctx?.chatId ?? '(none)';
    const hasDoc = storage.hasLivingDocument();
    console.log(`${LOG_PREFIX} chat changed, chatId=${chatId}, hasLivingDocument=${hasDoc}`);
    // Chat-Wechsel: Slots leeren. Der nächste Interceptor-Call befüllt sie ggf. wieder
    // mit dem Brain des neuen Chats. Ohne Clear würde ein Chat ohne Brain den Inhalt
    // des vorigen Chats tragen, bis das nächste Gen-Event die Slots überschreibt.
    interceptor.clearSlot(ctx);
    interceptor.clearDirectorSlot(ctx);
    clearTimeout(autoUpdateTimer);
    updateBrainStateUI();
    updatePendingUI();
    refreshPinsUI();
    hub.refresh();
}

function addWandButtons() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        console.warn(`${LOG_PREFIX} extensionsMenu not found – wand buttons skipped`);
        return;
    }

    const makeBtn = (id, icon, label, handler) => {
        const row = document.createElement('div');
        row.id = id;
        row.className = 'list-group-item flex-container flexGap5';
        row.style.cursor = 'pointer';
        const ic = document.createElement('div');
        ic.className = `fa-solid ${icon} extensionsMenuExtensionButton`;
        const span = document.createElement('span');
        span.textContent = label;
        row.appendChild(ic);
        row.appendChild(span);
        row.addEventListener('click', handler);
        return row;
    };

    menu.appendChild(makeBtn('ccs-wand-init', 'fa-brain', 'CCS: Brain initialisieren', onInitializeClicked));
    menu.appendChild(makeBtn('ccs-wand-update', 'fa-arrows-rotate', 'CCS: Brain updaten', onUpdateClicked));
    menu.appendChild(makeBtn('ccs-wand-view', 'fa-magnifying-glass', 'CCS: Brain anzeigen', onViewClicked));

    console.log(`${LOG_PREFIX} wand buttons added to extensions menu`);
}

async function init() {
    console.log(`${LOG_PREFIX} extension initializing...`);
    const ctx = getContext();
    if (!ctx) {
        console.error(`${LOG_PREFIX} SillyTavern context not available, aborting init`);
        return;
    }

    getSettings();

    await mountSettingsPanel();

    // Slash-Commands: CCS-Aktionen direkt aus der Chat-Eingabe aufrufbar.
    // SlashCommandParser/SlashCommand kommen aus dem ST-Kontext (st-context.js),
    // nicht als direkter Import (der via transitive imports scheitert).
    const { SlashCommandParser, SlashCommand } = ctx;
    if (SlashCommandParser && SlashCommand) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'ccs-init',
            callback: () => { onInitializeClicked(); return ''; },
            helpString: 'CCS: Brain für diesen Chat initialisieren (Quellen-Auswahl + Review).',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'ccs-update',
            callback: () => { onUpdateClicked(); return ''; },
            helpString: 'CCS: Brain mit neuen Chat-Ereignissen updaten.',
        }));
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'ccs-view',
            callback: () => { onViewClicked(); return ''; },
            helpString: 'CCS: Brain-XML anzeigen und bearbeiten.',
        }));
        console.log(`${LOG_PREFIX} slash commands registered: /ccs-init, /ccs-update, /ccs-view`);
    } else {
        console.warn(`${LOG_PREFIX} SlashCommandParser not available – slash commands not registered`);
    }

    // Wand-Menü-Buttons: sichtbare Knöpfe im Extensions-Dropdown (Zauberstab-Icon)
    addWandButtons();

    // CCS Hub: schwebender Brain-Toggle-Button + auto-refresh
    hub.injectToggleButton();

    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes || ctx.event_types;
    if (eventSource && eventTypes && eventTypes.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
        // Auto-Update: nach jeder fertigen KI-Antwort prüfen, ob genug Neues da ist.
        if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, scheduleAutoUpdate);
    } else {
        console.warn(`${LOG_PREFIX} CHAT_CHANGED event not wired (missing eventSource or eventTypes)`);
    }

    console.log(`${LOG_PREFIX} extension initialized`);
}

// Browser-Konsolen-Handle für manuelles Testen, z.B.:
//   await ccs.storage.saveLivingDocument('...')
//   await ccs.collector.collect({ global: false })
//   await ccs.initializer.generateInitial({ global: false })
//   ccs.interceptor.buildAlwaysCoreText('<brain>...</brain>')
//   ccs.updater.migrateLegacyBrain('<brain>...</brain>')    // Phase 2
//   ccs.updater.slugify('Ägyptens Sonne') / .generateId('loc', name, set)
//   ccs.popup.renderUpdatePopup({ proposals, migratedBrainXml, reasoning })   // Phase 2
globalThis.ccs = { storage, collector, initializer, interceptor, updater, popup, hub, director, pins, render, cursor };

globalThis.ccsInterceptor = async function (chat, contextSize, abort, type) {
    try {
        const ctx = getContext();
        const settings = getSettings();

        // Kappen auf maxChatMessages passiert in runAlwaysCore (braucht den Brain-Cursor).
        const result = await interceptor.runAlwaysCore({ ctx, settings, type, chat });
        console.log(`${LOG_PREFIX} interceptor ${result.action}${result.reason ? ` (${result.reason})` : ''}${typeof result.chars === 'number' ? ` chars=${result.chars}` : ''}`, {
            type,
            contextSize,
            messages: Array.isArray(chat) ? chat.length : undefined,
        });
    } catch (err) {
        // Letzte Verteidigungslinie. Versuch die Slots sicherheitshalber zu leeren,
        // damit bei einem Fehler kein Zombie-Inject verbleibt.
        console.error(`${LOG_PREFIX} interceptor: catastrophic error (swallowed to not block ST)`, err);
        try { interceptor.clearSlot(getContext()); } catch { /* give up */ }
        try { interceptor.clearDirectorSlot(getContext()); } catch { /* give up */ }
    }
};

(function registerInit() {
    try {
        const ctx = getContext();
        const eventTypes = ctx?.eventTypes || ctx?.event_types;
        if (ctx && ctx.eventSource && eventTypes && eventTypes.APP_READY) {
            ctx.eventSource.on(eventTypes.APP_READY, init);
        } else {
            $(document).ready(() => {
                if (typeof SillyTavern !== 'undefined') {
                    init();
                }
            });
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} registration error`, err);
    }
})();
