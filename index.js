import {
    characters,
    this_chid,
    getRequestHeaders,
    selectCharacterById,
    openCharacterChat,
    getCurrentChatId,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';

let panelOpen = false;

// ========== UI Creation ==========

function createSearchPanel() {
    if (document.getElementById('chat-search-panel')) return;

    const overlay = document.createElement('div');
    overlay.id = 'chat-search-overlay';
    overlay.addEventListener('click', closeSearchPanel);

    const panel = document.createElement('div');
    panel.id = 'chat-search-panel';
    panel.innerHTML = `
        <div class="chat-search-header">
            <h3><i class="fa-solid fa-magnifying-glass"></i> Global Chat Search</h3>
            <button class="chat-search-close" title="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="chat-search-controls">
            <div class="chat-search-input-row">
                <input type="text" id="chat-search-input" placeholder="Keywords separated by spaces..." autocomplete="off" />
                <button id="chat-search-btn"><i class="fa-solid fa-magnifying-glass"></i> Search</button>
            </div>
            <select id="chat-search-scope">
                <option value="current_chat">Current Chat</option>
                <option value="current_character">Current Character</option>
                <option value="all" selected>All Characters</option>
            </select>
        </div>
        <div class="chat-search-results">
            <div class="chat-search-status">Enter keywords to search.</div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    // Bind events
    panel.querySelector('.chat-search-close').addEventListener('click', closeSearchPanel);
    panel.querySelector('#chat-search-btn').addEventListener('click', doSearch);
    panel.querySelector('#chat-search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    // Focus input
    setTimeout(() => panel.querySelector('#chat-search-input').focus(), 100);
    panelOpen = true;
}

function closeSearchPanel() {
    const panel = document.getElementById('chat-search-panel');
    const overlay = document.getElementById('chat-search-overlay');
    if (panel) panel.remove();
    if (overlay) overlay.remove();
    panelOpen = false;
}

// ========== Search Logic ==========

async function doSearch() {
    const input = document.getElementById('chat-search-input');
    const scopeSelect = document.getElementById('chat-search-scope');
    const resultsContainer = document.querySelector('#chat-search-panel .chat-search-results');

    const query = input.value.trim();
    if (!query) return;

    const scope = scopeSelect.value;

    // Determine current character info
    let characterName = null;
    let chatFile = null;

    if (this_chid !== undefined && characters[this_chid]) {
        characterName = characters[this_chid].avatar ? characters[this_chid].avatar.replace(/\.[^.]+$/, '') : characters[this_chid].name;
        chatFile = getCurrentChatId();
    }

    // Validate scope
    if (scope === 'current_chat' && (!characterName || !chatFile || selected_group)) {
        resultsContainer.innerHTML = '<div class="chat-search-status">No character chat is currently open.</div>';
        return;
    }
    if (scope === 'current_character' && (!characterName || selected_group)) {
        resultsContainer.innerHTML = '<div class="chat-search-status">No character is currently selected.</div>';
        return;
    }

    resultsContainer.innerHTML = '<div class="chat-search-status"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>';

    try {
        const body = { query, scope };
        if (scope === 'current_chat' || scope === 'current_character') {
            body.characterName = characterName;
        }
        if (scope === 'current_chat') {
            body.chatFile = chatFile;
        }

        const response = await fetch('/api/plugins/chat-search/search', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${response.status}`);
        }

        const data = await response.json();
        renderResults(data.results, query);
    } catch (error) {
        console.error('[chat-search] Search error:', error);
        resultsContainer.innerHTML = `<div class="chat-search-status">Error: ${error.message}</div>`;
    }
}

// ========== Render Results ==========

function renderResults(results, query) {
    const container = document.querySelector('#chat-search-panel .chat-search-results');

    if (!results || results.length === 0) {
        container.innerHTML = '<div class="chat-search-status">No results found.</div>';
        return;
    }

    container.innerHTML = `<div class="chat-search-status">${results.length} chat(s) matched.</div>`;

    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

    for (const result of results) {
        const item = document.createElement('div');
        item.classList.add('chat-search-result-item');

        const highlightedText = highlightKeywords(snippetAroundKeywords(result.mes, keywords, 200), keywords);

        item.innerHTML = `
            <div class="chat-search-result-meta">
                <span class="chat-search-result-character">${escapeHtml(result.character)}</span>
                <span>${escapeHtml(result.chatCreateDate)}</span>
            </div>
            <div class="chat-search-result-sender">${escapeHtml(result.name)}:</div>
            <div class="chat-search-result-text">${highlightedText}</div>
        `;

        item.addEventListener('click', () => {
            navigateToChat(result.character, result.file);
        });

        container.appendChild(item);
    }
}

function highlightKeywords(text, keywords) {
    let result = escapeHtml(text);
    for (const kw of keywords) {
        const escaped = escapeRegex(kw);
        const regex = new RegExp(`(${escaped})`, 'gi');
        result = result.replace(regex, '<mark>$1</mark>');
    }
    return result;
}

function snippetAroundKeywords(text, keywords, maxLen) {
    const clean = text.replace(/<[^>]*>/g, '');
    if (clean.length <= maxLen) return clean;

    // Find the position of the first keyword occurrence
    const lower = clean.toLowerCase();
    let earliest = clean.length;
    for (const kw of keywords) {
        const idx = lower.indexOf(kw);
        if (idx !== -1 && idx < earliest) {
            earliest = idx;
        }
    }

    // Center the snippet around the first keyword
    let start = Math.max(0, earliest - Math.floor(maxLen / 4));
    let end = Math.min(clean.length, start + maxLen);
    if (end - start < maxLen) {
        start = Math.max(0, end - maxLen);
    }

    let snippet = clean.substring(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < clean.length) snippet = snippet + '...';
    return snippet;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ========== Navigation ==========

async function navigateToChat(characterName, chatFile) {
    closeSearchPanel();

    // Chat folder name is the avatar filename without extension (e.g. "Lilian_2")
    // Match by avatar stem, not by display name
    const charIndex = characters.findIndex(c => {
        const avatarStem = c.avatar ? c.avatar.replace(/\.[^.]+$/, '') : '';
        return avatarStem === characterName || c.name === characterName;
    });
    if (charIndex === -1) {
        toastr.error(`Character "${characterName}" not found.`);
        return;
    }

    try {
        // If different character, select it first
        if (this_chid !== charIndex || selected_group) {
            await selectCharacterById(charIndex);
        }

        // If the target chat is not the currently active one, open it
        const currentChat = getCurrentChatId();
        if (currentChat !== chatFile) {
            await openCharacterChat(chatFile);
        }
    } catch (error) {
        console.error('[chat-search] Navigation error:', error);
        toastr.error('Failed to open chat.');
    }
}

// ========== Extension Menu Button ==========

function addSearchButton() {
    const container = document.getElementById('extensionsMenu');
    if (!container) return;

    const button = document.createElement('div');
    button.id = 'chat-search-menu-button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5');

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-magnifying-glass', 'extensionsMenuExtensionButton');

    const text = document.createElement('span');
    text.textContent = 'Chat Search';

    button.appendChild(icon);
    button.appendChild(text);
    button.addEventListener('click', () => {
        if (panelOpen) {
            closeSearchPanel();
        } else {
            createSearchPanel();
        }
    });

    container.appendChild(button);
}

// ========== Keyboard Shortcut ==========

document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+F to toggle search panel
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        if (panelOpen) {
            closeSearchPanel();
        } else {
            createSearchPanel();
        }
    }
    // Escape to close
    if (e.key === 'Escape' && panelOpen) {
        closeSearchPanel();
    }
});

// ========== Init ==========

jQuery(() => {
    addSearchButton();
    console.log('[chat-search] Extension loaded.');
});
