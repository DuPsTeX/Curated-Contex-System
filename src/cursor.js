// Update-Cursor: bis zu welcher Chat-Nachricht das Brain schon Bescheid weiß.
//
// Gespeichert als Attribute am <brain>-Root:
//   last_analyzed_msg_index – Chat-Index der letzten analysierten Nachricht
//   last_analyzed_send_date – deren send_date als Anker
// Der Index allein verrutscht, wenn ältere Nachrichten gelöscht werden. Mit dem
// Anker finden wir die Nachricht wieder. send_date hat nur Minuten-Auflösung,
// daher nehmen wir bei mehreren Treffern den, der dem alten Index am nächsten liegt.

/**
 * Liest den rohen Cursor-Index aus dem Brain-Root.
 * @param {string} brainXml
 * @returns {number} Index oder NaN, wenn keiner gesetzt ist
 */
export function readCursor(brainXml) {
    const m = /<brain\b[^>]*\blast_analyzed_msg_index="(-?\d+)"/.exec(brainXml || '');
    return m ? parseInt(m[1], 10) : NaN;
}

function readAnchor(brainXml) {
    const m = /<brain\b[^>]*\blast_analyzed_send_date="([^"]*)"/.exec(brainXml || '');
    if (!m) return null;
    return m[1].replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Cursor gegen den aktuellen Chat auflösen (Anker hat Vorrang vor dem Index).
 * @param {string} brainXml
 * @param {Array} chat – ctx.chat
 * @returns {number} Index oder NaN
 */
export function resolveCursor(brainXml, chat) {
    const idx = readCursor(brainXml);
    if (!Number.isFinite(idx)) return NaN;
    const anchor = readAnchor(brainXml);
    if (!anchor || !Array.isArray(chat) || chat[idx]?.send_date === anchor) return idx;

    let best = -1;
    for (let i = 0; i < chat.length; i++) {
        if (chat[i]?.send_date === anchor && (best < 0 || Math.abs(i - idx) < Math.abs(best - idx))) best = i;
    }
    if (best >= 0) return best;
    // Anker-Nachricht gelöscht oder geändert → alter Index, auf Chat-Länge begrenzt.
    return Math.min(idx, chat.length - 1);
}

/**
 * Schreibt Cursor + Anker an das <brain>-Element.
 * @param {Element} root – <brain>
 * @param {number} index
 * @param {Array} [chat] – ctx.chat (für den Anker)
 */
export function writeCursor(root, index, chat) {
    root.setAttribute('last_analyzed_msg_index', String(index));
    const date = Array.isArray(chat) ? chat[index]?.send_date : undefined;
    if (date !== undefined && date !== null && date !== '') {
        root.setAttribute('last_analyzed_send_date', String(date));
    } else {
        root.removeAttribute('last_analyzed_send_date');
    }
}
