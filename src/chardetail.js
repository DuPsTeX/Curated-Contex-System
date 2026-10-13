// Character Detail: Draggable popup showing all Brain fields for one character.
// Supports image upload (base64 stored in <image> tag inside the Brain XML).
// Felder bearbeiten: "Bearbeiten"-Button öffnet den Formular-Editor (editor.js).
//
// API: chardetail.open(characterData, onEdit, onSaved) / chardetail.close()

import * as storage from './storage.js';

const LOG_PREFIX = '[CCS]';

let panel = null;

function el(tag, opts = {}) {
    const e = document.createElement(tag);
    if (opts.cls) e.className = opts.cls;
    if (opts.html != null) e.innerHTML = opts.html;
    if (opts.text != null) e.textContent = opts.text;
    return e;
}

function esc(str) {
    if (!str) return '';
    const t = document.createTextNode(String(str));
    const div = document.createElement('div');
    div.appendChild(t);
    return div.innerHTML;
}

const FIELD_LABELS = {
    core: 'Kern',
    appearance: 'Aussehen',
    background: 'Hintergrund',
    abilities: 'Fähigkeiten',
    quirks: 'Eigenheiten',
    goals: 'Ziele',
    speech_style: 'Sprechweise',
    stats: 'Werte',
    inventory: 'Inventar',
    reputation: 'Ruf',
    current_state: 'Aktueller Zustand',
};

const FIELD_ORDER = [
    'core', 'appearance', 'background', 'abilities', 'quirks',
    'goals', 'speech_style', 'current_state', 'stats', 'inventory', 'reputation',
];

function makeDraggable(panelEl, handleEl) {
    let offsetX = 0, offsetY = 0, dragging = false;

    const onDown = (e) => {
        if (e.target.closest('button, input, .ccs-cd-img-area')) return;
        dragging = true;
        const rect = panelEl.getBoundingClientRect();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        offsetX = cx - rect.left;
        offsetY = cy - rect.top;
        panelEl.style.transition = 'none';
        e.preventDefault();
    };

    const onMove = (e) => {
        if (!dragging) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        panelEl.style.left = (cx - offsetX) + 'px';
        panelEl.style.top = (cy - offsetY) + 'px';
        panelEl.style.right = 'auto';
    };

    const onUp = () => {
        dragging = false;
        panelEl.style.transition = '';
    };

    handleEl.addEventListener('mousedown', onDown);
    handleEl.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
}

function buildPanel(ch, onEdit, onSaved) {
    const container = el('div', { cls: 'ccs-cd-panel' });

    // Header
    const handle = el('div', { cls: 'ccs-cd-handle' });
    const roleLabel = ch.role === 'main' ? ' <i class="fa-solid fa-star" style="color:gold"></i>' : '';
    handle.innerHTML = `<i class="fa-solid fa-grip"></i> <b>${esc(ch.name)}</b>${roleLabel}`;
    container.appendChild(handle);

    const toolbar = el('div', { cls: 'ccs-cd-toolbar' });
    const btnEdit = el('button', { cls: 'ccs-cd-btn', html: '<i class="fa-solid fa-pen"></i> Bearbeiten' });
    btnEdit.title = 'Felder dieser Figur bearbeiten';
    btnEdit.addEventListener('click', () => {
        close();
        onEdit?.();
    });
    toolbar.appendChild(btnEdit);
    const btnSave = el('button', { cls: 'ccs-cd-btn ccs-cd-btn--save', html: '<i class="fa-solid fa-floppy-disk"></i> Speichern' });
    btnSave.title = 'Bild im Brain speichern';
    toolbar.appendChild(btnSave);
    const btnClose = el('button', { cls: 'ccs-cd-btn ccs-cd-btn--close', html: '<i class="fa-solid fa-xmark"></i>' });
    toolbar.appendChild(btnClose);
    container.appendChild(toolbar);

    // Content
    const content = el('div', { cls: 'ccs-cd-content' });

    // Image area
    const imgArea = el('div', { cls: 'ccs-cd-img-area' });
    const imgEl = el('img', { cls: 'ccs-cd-img' });
    if (ch.image && ch.image.startsWith('data:image')) {
        imgEl.src = ch.image;
    } else {
        imgEl.style.display = 'none';
    }
    imgArea.appendChild(imgEl);
    const imgHint = el('div', { cls: 'ccs-cd-img-hint', html: '<i class="fa-solid fa-cloud-arrow-up"></i><br>Klick oder Drag & Drop<br>für Charakterbild' });
    if (ch.image) imgHint.style.display = 'none';
    imgArea.appendChild(imgHint);

    // Hidden file input
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';
    imgArea.appendChild(fileInput);

    let pendingImage = null;

    const setImage = (dataUrl) => {
        imgEl.src = dataUrl;
        imgEl.style.display = '';
        imgHint.style.display = 'none';
        pendingImage = dataUrl;
    };

    imgArea.addEventListener('click', () => fileInput.click());
    imgArea.addEventListener('dragover', (e) => { e.preventDefault(); imgArea.classList.add('ccs-cd-img-area--drag'); });
    imgArea.addEventListener('dragleave', () => imgArea.classList.remove('ccs-cd-img-area--drag'));
    imgArea.addEventListener('drop', (e) => {
        e.preventDefault();
        imgArea.classList.remove('ccs-cd-img-area--drag');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = () => setImage(reader.result);
            reader.readAsDataURL(file);
        }
    });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = () => setImage(reader.result);
            reader.readAsDataURL(file);
        }
    });

    content.appendChild(imgArea);

    // Field list
    for (const field of FIELD_ORDER) {
        const val = ch[field];
        if (val === undefined || val === null) continue;
        const row = el('div', { cls: 'ccs-cd-field' });
        const label = el('div', { cls: 'ccs-cd-field-label', text: FIELD_LABELS[field] || field });
        const value = el('div', { cls: 'ccs-cd-field-value' });
        value.textContent = val || '—';
        row.appendChild(label);
        row.appendChild(value);
        content.appendChild(row);
    }

    container.appendChild(content);

    // Drag
    makeDraggable(container, handle);

    // Events
    btnClose.addEventListener('click', close);

    btnSave.addEventListener('click', async () => {
        if (!pendingImage) return;
        btnSave.disabled = true;
        btnSave.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Speichere...';
        try {
            // Immer das aktuelle Brain lesen – seit dem Öffnen kann ein Update gelaufen sein.
            const parser = new DOMParser();
            const doc = parser.parseFromString(await storage.getLivingDocument() || '', 'application/xml');
            if (doc.querySelector('parsererror')) throw new Error('Brain unparseable');
            const charEl = [...doc.querySelectorAll(':scope > characters > character')].find(c => c.getAttribute('name') === ch.name);
            if (!charEl) throw new Error(`Character "${ch.name}" not found in Brain`);

            let imgTag = charEl.querySelector(':scope > image');
            if (!imgTag) {
                imgTag = doc.createElement('image');
                charEl.appendChild(imgTag);
            }
            imgTag.textContent = pendingImage;

            const updatedXml = new XMLSerializer().serializeToString(doc);
            await storage.saveLivingDocument(updatedXml, undefined, `Bild: ${ch.name}`);
            ch.image = pendingImage;
            onSaved?.();
            pendingImage = null;
            btnSave.innerHTML = '<i class="fa-solid fa-check"></i> Gespeichert';
            setTimeout(() => {
                btnSave.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Speichern';
                btnSave.disabled = false;
            }, 1500);
        } catch (err) {
            console.error(`${LOG_PREFIX} chardetail save failed`, err);
            btnSave.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Fehler';
            setTimeout(() => {
                btnSave.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Speichern';
                btnSave.disabled = false;
            }, 2000);
        }
    });

    return container;
}

export function open(ch, onEdit, onSaved) {
    close();
    panel = buildPanel(ch, onEdit, onSaved);
    panel.style.top = '100px';
    panel.style.left = '100px';
    document.body.appendChild(panel);
}

export function close() {
    if (panel) {
        panel.remove();
        panel = null;
    }
}
