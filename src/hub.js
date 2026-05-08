// CCS Hub: Schwebendes Dashboard mit allen Brain-Kategorien auf einen Blick.
// Dragbar, collapsible Sections, auto-refresh bei Chat-Wechsel / Brain-Update.
//
// API: hub.toggle() / hub.refresh() / hub.destroy()

import * as storage from './storage.js';
import * as chardetail from './chardetail.js';

const LOG_PREFIX = '[CCS]';

let panel = null;
let visible = false;

const CATEGORY_ICONS = {
    scene: 'fa-film',
    characters: 'fa-users',
    relationships: 'fa-heart',
    locations: 'fa-map-marker',
    key_moments: 'fa-star',
    arcs: 'fa-book-open',
    world_rules: 'fa-scroll',
    history: 'fa-clock-rotate-left',
    pinned: 'fa-thumbtack',
};

const CATEGORY_LABELS = {
    scene: 'Szene',
    characters: 'Charaktere',
    relationships: 'Beziehungen',
    locations: 'Orte',
    key_moments: 'Schlüsselmomente',
    arcs: 'Arcs',
    world_rules: 'Welt-Regeln',
    history: 'Chronik',
    pinned: 'Pins',
};

function el(tag, opts = {}) {
    const e = document.createElement(tag);
    if (opts.cls) e.className = opts.cls;
    if (opts.html != null) e.innerHTML = opts.html;
    if (opts.text != null) e.textContent = opts.text;
    return e;
}

function parseBrain(xml) {
    if (!xml || !xml.trim()) return null;
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'brain') return null;

    const text = (el) => (el && el.textContent ? el.textContent.trim() : '');

    const data = {};

    // Scene
    const scene = root.querySelector(':scope > scene');
    if (scene) {
        const present = [...scene.querySelectorAll(':scope > present > person')].map(text);
        data.scene = {
            location: text(scene.querySelector(':scope > location')),
            present,
            time: text(scene.querySelector(':scope > time')),
            mood: text(scene.querySelector(':scope > mood')),
        };
    }

    // Characters
    data.characters = [...root.querySelectorAll(':scope > characters > character')].map(ch => ({
        name: ch.getAttribute('name') || '?',
        role: ch.getAttribute('role') || 'npc',
        state: text(ch.querySelector(':scope > current_state')),
        core: text(ch.querySelector(':scope > core')),
        appearance: text(ch.querySelector(':scope > appearance')),
        background: text(ch.querySelector(':scope > background')),
        abilities: text(ch.querySelector(':scope > abilities')),
        quirks: text(ch.querySelector(':scope > quirks')),
        goals: text(ch.querySelector(':scope > goals')),
        speech_style: text(ch.querySelector(':scope > speech_style')),
        stats: text(ch.querySelector(':scope > stats')),
        inventory: text(ch.querySelector(':scope > inventory')),
        reputation: text(ch.querySelector(':scope > reputation')),
        image: text(ch.querySelector(':scope > image')),
    }));

    // Locations
    data.locations = [...root.querySelectorAll(':scope > locations > location')].map(loc => ({
        name: loc.getAttribute('name') || '?',
        desc: text(loc.querySelector(':scope > description')),
        atmosphere: text(loc.querySelector(':scope > atmosphere')),
    }));

    // Relationships — paired bidirectional
    const rawRels = [...root.querySelectorAll(':scope > relationships > relationship')].map(rel => ({
        from: rel.getAttribute('from') || '?',
        to: rel.getAttribute('to') || '?',
        current: text(rel.querySelector(':scope > current')),
    }));
    const relPairs = new Map();
    for (const r of rawRels) {
        const key = [r.from, r.to].sort().join('||');
        if (!relPairs.has(key)) relPairs.set(key, { names: new Set(), dirs: [] });
        relPairs.get(key).names.add(r.from);
        relPairs.get(key).names.add(r.to);
        relPairs.get(key).dirs.push(r);
    }
    data.relationships = [...relPairs.values()].map(pair => ({
        names: [...pair.names],
        dirs: pair.dirs,
    }));

    // Key Moments
    data.key_moments = [...root.querySelectorAll(':scope > key_moments > key_moment')].map(km => ({
        summary: text(km.querySelector(':scope > summary')),
        importance: km.getAttribute('importance') || 'low',
        where: text(km.querySelector(':scope > where')),
    }));

    // Arcs
    data.arcs = [...root.querySelectorAll(':scope > arcs > arc')].map(arc => ({
        title: text(arc.querySelector(':scope > title')),
        status: arc.getAttribute('status') || 'active',
        tension: text(arc.querySelector(':scope > tension')),
    }));

    // World Rules
    data.world_rules = [...root.querySelectorAll(':scope > world_rules > rule')].map(text);

    // History
    data.history = [...root.querySelectorAll(':scope > history > entry')].map(entry => ({
        scene: entry.getAttribute('scene') || '',
        summary: text(entry.querySelector(':scope > summary')),
        outcome: text(entry.querySelector(':scope > key_outcome')),
    }));

    // Pins
    data.pins = [...root.querySelectorAll(':scope > pinned > pin')].map(text);

    return data;
}

function renderCategory(titleKey, items, builder) {
    if (!items || !items.length) return null;
    const section = el('div', { cls: 'ccs-hub-section' });
    const icon = CATEGORY_ICONS[titleKey] || 'fa-circle';
    const label = CATEGORY_LABELS[titleKey] || titleKey;

    const header = el('div', { cls: 'ccs-hub-section-header' });
    header.innerHTML = `<i class="fa-solid ${icon}"></i> <b>${label}</b> <span class="ccs-hub-count">(${items.length})</span>`;
    section.appendChild(header);

    const body = el('div', { cls: 'ccs-hub-section-body' });
    for (const item of items) {
        const card = builder(item);
        if (card) body.appendChild(card);
    }
    section.appendChild(body);

    // Collapse-Toggle
    let collapsed = false;
    header.addEventListener('click', () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : '';
        header.classList.toggle('ccs-hub-collapsed', collapsed);
    });

    return section;
}

function buildSceneCard(item) {
    const d = el('div', { cls: 'ccs-hub-card ccs-hub-card--scene' });
    let html = '';
    if (item.location) html += `<div><i class="fa-solid fa-location-dot"></i> ${esc(item.location)}</div>`;
    if (item.time) html += `<div><i class="fa-solid fa-clock"></i> ${esc(item.time)}</div>`;
    if (item.mood) html += `<div><i class="fa-solid fa-cloud"></i> ${esc(item.mood)}</div>`;
    if (item.present.length) html += `<div><i class="fa-solid fa-user-check"></i> ${esc(item.present.join(', '))}</div>`;
    d.innerHTML = html;
    return d;
}

function buildCharCard(ch) {
    const d = el('div', { cls: 'ccs-hub-card ccs-hub-card--char' });
    const star = ch.role === 'main' ? ' <i class="fa-solid fa-star" style="color:gold"></i>' : '';
    let html = '';
    if (ch.image && ch.image.startsWith('data:image')) {
        html += `<img class="ccs-hub-char-thumb" src="${esc(ch.image)}" />`;
    }
    html += `<div class="ccs-hub-char-name">${esc(ch.name)}${star}</div>`;
    if (ch.core) html += `<div class="ccs-hub-sub">${esc(ch.core)}</div>`;
    if (ch.state) html += `<div class="ccs-hub-state">${esc(ch.state)}</div>`;
    d.innerHTML = html;
    d.style.cursor = 'pointer';
    d.addEventListener('click', () => {
        // Get fresh brain XML for save context
        storage.getLivingDocument().then(xml => {
            chardetail.open(ch, xml || '');
        }).catch(() => {
            chardetail.open(ch, '');
        });
    });
    return d;
}

function buildLocCard(loc) {
    const d = el('div', { cls: 'ccs-hub-card' });
    let html = `<div class="ccs-hub-name">${esc(loc.name)}</div>`;
    if (loc.desc) html += `<div class="ccs-hub-sub">${esc(loc.desc)}</div>`;
    if (loc.atmosphere) html += `<div class="ccs-hub-sub ccs-hub-mood">${esc(loc.atmosphere)}</div>`;
    d.innerHTML = html;
    return d;
}

function buildRelCard(pair) {
    const d = el('div', { cls: 'ccs-hub-card ccs-hub-card--rel' });
    const nameLabel = pair.names.join(' ↔ ');
    let html = `<div class="ccs-hub-name">${esc(nameLabel)}</div>`;
    for (const dir of pair.dirs) {
        html += `<div class="ccs-hub-sub">${esc(dir.from)} → ${esc(dir.to)}: ${esc(dir.current)}</div>`;
    }
    d.innerHTML = html;
    return d;
}

function buildKmCard(km) {
    const d = el('div', { cls: 'ccs-hub-card' });
    const impColors = { critical: '#e74c3c', high: '#e67e22', medium: '#f1c40f', low: '#95a5a6' };
    const color = impColors[km.importance] || '#95a5a6';
    let html = `<span class="ccs-hub-km-badge" style="background:${color}">${esc(km.importance)}</span> `;
    html += esc(km.summary || '(keine Zusammenfassung)');
    if (km.where) html += ` <span class="ccs-hub-sub">— ${esc(km.where)}</span>`;
    d.innerHTML = html;
    return d;
}

function buildArcCard(arc) {
    const d = el('div', { cls: 'ccs-hub-card' });
    const statusColors = { active: '#4caf50', resolved: '#2196f3', abandoned: '#95a5a6' };
    const color = statusColors[arc.status] || '#95a5a6';
    d.innerHTML = `<span class="ccs-hub-arc-badge" style="background:${color}">${esc(arc.status)}</span> <b>${esc(arc.title)}</b>${arc.tension ? ` <span class="ccs-hub-sub">— ${esc(arc.tension)}</span>` : ''}`;
    return d;
}

function buildHistoryCard(h) {
    const d = el('div', { cls: 'ccs-hub-card' });
    let html = '';
    if (h.scene) html += `<div class="ccs-hub-name">${esc(h.scene)}</div>`;
    if (h.summary) html += `<div class="ccs-hub-sub">${esc(h.summary)}</div>`;
    if (h.outcome) html += `<div class="ccs-hub-state">→ ${esc(h.outcome)}</div>`;
    d.innerHTML = html;
    return d;
}

function buildTextCard(text) {
    const d = el('div', { cls: 'ccs-hub-card' });
    d.textContent = text;
    return d;
}

function esc(str) {
    if (!str) return '';
    const t = document.createTextNode(String(str));
    const div = document.createElement('div');
    div.appendChild(t);
    return div.innerHTML;
}

function buildPanel(data) {
    const container = el('div', { cls: 'ccs-hub-panel' });

    // Drag-Handle
    const handle = el('div', { cls: 'ccs-hub-handle' });
    handle.innerHTML = '<i class="fa-solid fa-grip"></i> <b>CCS Hub</b>';
    container.appendChild(handle);

    // Toolbar
    const toolbar = el('div', { cls: 'ccs-hub-toolbar' });
    const btnRefresh = el('button', { cls: 'ccs-hub-btn', html: '<i class="fa-solid fa-rotate"></i>' });
    btnRefresh.title = 'Aktualisieren';
    toolbar.appendChild(btnRefresh);
    const btnClose = el('button', { cls: 'ccs-hub-btn ccs-hub-btn--close', html: '<i class="fa-solid fa-xmark"></i>' });
    btnClose.title = 'Schließen';
    toolbar.appendChild(btnClose);
    container.appendChild(toolbar);

    // Content
    const content = el('div', { cls: 'ccs-hub-content' });

    if (!data) {
        content.appendChild(el('div', { cls: 'ccs-hub-empty', text: 'Kein Brain vorhanden. Erst initialisieren.' }));
    } else {
        const sections = [
            { key: 'scene', items: data.scene ? [data.scene] : [], builder: buildSceneCard },
            { key: 'characters', items: data.characters || [], builder: buildCharCard },
            { key: 'relationships', items: data.relationships || [], builder: buildRelCard },
            { key: 'locations', items: data.locations || [], builder: buildLocCard },
            { key: 'key_moments', items: data.key_moments || [], builder: buildKmCard },
            { key: 'arcs', items: data.arcs || [], builder: buildArcCard },
            { key: 'world_rules', items: (data.world_rules || []).map(t => ({ text: t })), builder: (x) => buildTextCard(x.text) },
            { key: 'history', items: data.history || [], builder: buildHistoryCard },
            { key: 'pinned', items: (data.pins || []).map(t => ({ text: t })), builder: (x) => buildTextCard(x.text) },
        ];

        for (const sec of sections) {
            const el = renderCategory(sec.key, sec.items, sec.builder);
            if (el) content.appendChild(el);
        }

        if (!content.children.length) {
            content.appendChild(el('div', { cls: 'ccs-hub-empty', text: 'Brain ist leer – warte auf Updates.' }));
        }
    }

    container.appendChild(content);

    // Drag
    makeDraggable(container, handle);

    // Events
    btnRefresh.addEventListener('click', () => refresh());
    btnClose.addEventListener('click', () => toggle(false));

    return container;
}

function makeDraggable(panelEl, handleEl) {
    let offsetX = 0, offsetY = 0, dragging = false;

    const onDown = (e) => {
        if (e.target.closest('button, .ccs-hub-section-header')) return;
        dragging = true;
        const rect = panelEl.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        offsetX = clientX - rect.left;
        offsetY = clientY - rect.top;
        panelEl.style.transition = 'none';
        e.preventDefault();
    };

    const onMove = (e) => {
        if (!dragging) return;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        panelEl.style.left = (clientX - offsetX) + 'px';
        panelEl.style.top = (clientY - offsetY) + 'px';
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
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

export async function refresh() {
    if (!panel) return;
    let xml = null;
    try {
        xml = await storage.getLivingDocument();
    } catch { /* nop */ }
    const data = parseBrain(xml);
    const content = panel.querySelector('.ccs-hub-content');
    const newPanel = buildPanel(data);
    const newContent = newPanel.querySelector('.ccs-hub-content');
    if (content && newContent) {
        content.innerHTML = '';
        while (newContent.firstChild) content.appendChild(newContent.firstChild);
    }
    // Re-bind close + refresh
    const btnClose = panel.querySelector('.ccs-hub-btn--close');
    const btnRefresh = panel.querySelector('.ccs-hub-btn');
    if (btnClose) btnClose.addEventListener('click', () => toggle(false));
    if (btnRefresh) btnRefresh.addEventListener('click', () => refresh());
    console.log(`${LOG_PREFIX} hub refreshed`);
}

export function toggle(force) {
    const show = typeof force === 'boolean' ? force : !visible;
    if (show === visible) return;
    visible = show;

    if (show) {
        if (panel) {
            panel.style.display = '';
        } else {
            panel = buildPanel(null);
            panel.style.display = '';
            document.body.appendChild(panel);
            // Default position: top-right of viewport
            panel.style.top = '80px';
            panel.style.right = '20px';
            refresh();
        }
    } else {
        if (panel) panel.style.display = 'none';
    }

    updateToggleButton();
}

export function destroy() {
    if (panel) {
        panel.remove();
        panel = null;
    }
    visible = false;
    updateToggleButton();
}

function updateToggleButton() {
    const btn = document.getElementById('ccs-hub-toggle-btn');
    if (btn) {
        btn.classList.toggle('ccs-hub-toggle--active', visible);
        btn.title = visible ? 'CCS Hub ausblenden' : 'CCS Hub einblenden';
    }
}

export function injectToggleButton() {
    if (document.getElementById('ccs-hub-toggle-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'ccs-hub-toggle-btn';
    btn.className = 'ccs-hub-toggle';
    btn.innerHTML = '<i class="fa-solid fa-brain"></i>';
    btn.title = 'CCS Hub einblenden';
    btn.addEventListener('click', () => toggle());
    document.body.appendChild(btn);
    updateToggleButton();
}
