import * as storage from './src/storage.js';
import * as collector from './src/collector.js';
import * as initializer from './src/initializer.js';
import * as interceptor from './src/interceptor.js';
import * as updater from './src/updater.js';
import * as popup from './src/popup.js';

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
        toastr.success(`Brain gespeichert (${finalXml.length} Zeichen).`, 'CCS');
        updateBrainStateUI();
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
    } catch (err) {
        toastr.error(err?.message || String(err), 'CCS: Speichern fehlgeschlagen', { timeOut: 10000 });
        console.error(`${LOG_PREFIX} save-from-viewer failed`, err);
    }
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

    // Progress-Toast sticky, Button-Lock bis das Ende erreicht ist.
    const $btn = $('#ccs-update-btn').prop('disabled', true);
    toastr.clear();
    const progress = toastr.info('Chat wird analysiert... Das kann einen Moment dauern.', 'CCS', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
    });

    let result;
    try {
        // System-Prompt wird intern via `loadUpdateSystemPrompt()` aus
        // `prompts/update-system.txt` geladen (mit in-Code-Fallback).
        result = await updater.runUpdate({ ctx });
    } catch (err) {
        toastr.clear(progress);
        const msg = err?.message || String(err);
        toastr.error(msg, 'CCS: Fehler beim Update', { timeOut: 10000 });
        console.error(`${LOG_PREFIX} update failed`, err);
        $btn.prop('disabled', false);
        return;
    }
    toastr.clear(progress);

    // Scan-Window leer → nichts Neues gespielt. Kein Save, kein Cursor-Schreiben.
    if (result.scanWindowEmpty) {
        toastr.info('Nichts Neues seit letztem Update.', 'CCS', { preventDuplicates: true });
        $btn.prop('disabled', false);
        return;
    }

    // LLM-Response nicht schema-konform → Error. Cursor bleibt stehen.
    if (!result.shape_ok) {
        toastr.error('Update-Antwort strukturell ungültig (shape_ok=false). Brain unverändert.', 'CCS', { timeOut: 10000 });
        console.warn(`${LOG_PREFIX} update shape_ok=false`, result);
        $btn.prop('disabled', false);
        return;
    }

    // Shape ok, aber leere Vorschläge → nur Cursor nachziehen, damit die schon
    // analysierten Messages bei nächstem Klick nicht wieder gescannt werden.
    if (!result.proposals.length) {
        try {
            await updater.applyProposals([], result.migratedBrainXml, result.cursorIndex);
            updateBrainStateUI();
            toastr.info('Keine neuen Einträge – Cursor aktualisiert.', 'CCS');
        } catch (err) {
            toastr.error(err?.message || String(err), 'CCS: Cursor-Update fehlgeschlagen', { timeOut: 10000 });
            console.error(`${LOG_PREFIX} cursor-only save failed`, err);
        } finally {
            $btn.prop('disabled', false);
        }
        return;
    }

    // Popup bauen und anzeigen
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
        toastr.info('Update abgebrochen – Cursor unverändert.', 'CCS');
        $btn.prop('disabled', false);
        return;
    }

    // Apply
    const approved = popupApi.collectApproved();
    try {
        const applyResult = await updater.applyProposals(
            approved,
            result.migratedBrainXml,
            result.cursorIndex,
        );
        updateBrainStateUI();
        const appliedN = applyResult.applied;
        const failedN = applyResult.failed.length;
        if (appliedN > 0 && failedN === 0) {
            toastr.success(`${appliedN} Änderung${appliedN === 1 ? '' : 'en'} übernommen.`, 'CCS');
        } else if (appliedN > 0 && failedN > 0) {
            toastr.warning(`${appliedN} übernommen, ${failedN} fehlgeschlagen (siehe Konsole).`, 'CCS', { timeOut: 10000 });
        } else {
            // applied === 0 && failed > 0: kein Save; Brain ist unverändert.
            toastr.error(`0 übernommen, ${failedN} fehlgeschlagen. Brain unverändert.`, 'CCS', { timeOut: 10000 });
        }
    } catch (err) {
        toastr.error(err?.message || String(err), 'CCS: Apply fehlgeschlagen', { timeOut: 10000 });
        console.error(`${LOG_PREFIX} applyProposals failed`, err);
    } finally {
        $btn.prop('disabled', false);
    }
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
        // Auch den Injection-Slot leeren, damit bis zum nächsten Gen-Event
        // kein Zombie-Brain mehr hängt.
        interceptor.clearSlot(ctx);
        toastr.success('Brain gelöscht.', 'CCS');
        updateBrainStateUI();
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
        }
        console.log(`${LOG_PREFIX} enabled set to ${s.enabled}`);
    });
    $('#ccs-init-btn').on('click', onInitializeClicked);
    $('#ccs-view-btn').on('click', onViewClicked);
    $('#ccs-update-btn').on('click', onUpdateClicked);
    $('#ccs-delete-btn').on('click', onDeleteClicked);

    // Hinweis: Die früheren Prompt-Editor-Textareas wurden entfernt. Die System-
    // Prompts leben jetzt als Dateien unter `prompts/init-system.txt` bzw.
    // `prompts/update-system.txt` und wandern per `git push/pull` zwischen PCs.

    updateStatusUI();
    updateBrainStateUI();
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
    // Chat-Wechsel: Slot leeren. Der nächste Interceptor-Call befüllt ihn ggf. wieder
    // mit dem Brain des neuen Chats. Ohne Clear würde ein Chat ohne Brain den Inhalt
    // des vorigen Chats tragen, bis das nächste Gen-Event den Slot überschreibt.
    interceptor.clearSlot(ctx);
    updateBrainStateUI();
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

    const eventSource = ctx.eventSource;
    const eventTypes = ctx.eventTypes || ctx.event_types;
    if (eventSource && eventTypes && eventTypes.CHAT_CHANGED) {
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
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
globalThis.ccs = { storage, collector, initializer, interceptor, updater, popup };

globalThis.ccsInterceptor = async function (chat, contextSize, abort, type) {
    // Äußerster Safety-Net: selbst wenn getContext()/getSettings() oder runAlwaysCore
    // unerwartet werfen (runAlwaysCore hat selbst schon ein inneres try/catch –
    // das hier ist reiner Belt-and-Suspenders), darf ST NIEMALS blockiert werden.
    // Interceptor-Return muss erfolgreich resolven, auch im Fehlerfall.
    try {
        const ctx = getContext();
        const settings = getSettings();
        const result = await interceptor.runAlwaysCore({ ctx, settings, type });
        console.log(`${LOG_PREFIX} interceptor ${result.action}${result.reason ? ` (${result.reason})` : ''}${typeof result.chars === 'number' ? ` chars=${result.chars}` : ''}`, {
            type,
            contextSize,
            messages: Array.isArray(chat) ? chat.length : undefined,
        });
    } catch (err) {
        // Letzte Verteidigungslinie. Versuch den Slot sicherheitshalber zu leeren,
        // damit bei einem Fehler kein Zombie-Inject verbleibt.
        console.error(`${LOG_PREFIX} interceptor: catastrophic error (swallowed to not block ST)`, err);
        try { interceptor.clearSlot(getContext()); } catch { /* give up */ }
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
