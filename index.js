import {
    characters,
    this_chid,
    getRequestHeaders,
    selectCharacterById,
    openCharacterChat,
    getCurrentChatId,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { getStringHash, splitRecursive } from '../../../utils.js';

let panelOpen = false;

// Persisted state across open/close
const savedState = {
    query: '',
    scope: 'all',
    mode: 'keyword',
    resultsHtml: '',
    scrollTop: 0,
    hasResults: false,
};

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
            <select id="chat-search-mode">
                <option value="keyword">Keyword</option>
                <option value="vector">Fuzzy (Vector)</option>
            </select>
            <select id="chat-search-scope">
                <option value="current_character">Current Character</option>
                <option value="all">All Characters</option>
            </select>
        </div>
        <div class="chat-search-progress" style="display:none;">
            <div class="chat-search-progress-text"></div>
            <div class="chat-search-progress-bar-bg">
                <div class="chat-search-progress-bar-fill"></div>
            </div>
        </div>
        <div class="chat-search-results">
            <div class="chat-search-status">Enter keywords to search.</div>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    // Restore saved state
    const input = panel.querySelector('#chat-search-input');
    const scopeSelect = panel.querySelector('#chat-search-scope');
    const modeSelect = panel.querySelector('#chat-search-mode');
    const resultsContainer = panel.querySelector('.chat-search-results');

    input.value = savedState.query;
    scopeSelect.value = savedState.scope;
    modeSelect.value = savedState.mode;
    if (savedState.hasResults) {
        resultsContainer.innerHTML = savedState.resultsHtml;
        bindResultClicks(resultsContainer);
        setTimeout(() => { resultsContainer.scrollTop = savedState.scrollTop; }, 0);
    }

    // Bind events
    panel.querySelector('.chat-search-close').addEventListener('click', closeSearchPanel);
    panel.querySelector('#chat-search-btn').addEventListener('click', doSearch);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    setTimeout(() => input.focus(), 100);
    panelOpen = true;
}

function closeSearchPanel() {
    const panel = document.getElementById('chat-search-panel');
    const overlay = document.getElementById('chat-search-overlay');

    if (panel) {
        const input = panel.querySelector('#chat-search-input');
        const scopeSelect = panel.querySelector('#chat-search-scope');
        const modeSelect = panel.querySelector('#chat-search-mode');
        const resultsContainer = panel.querySelector('.chat-search-results');
        if (input) savedState.query = input.value;
        if (scopeSelect) savedState.scope = scopeSelect.value;
        if (modeSelect) savedState.mode = modeSelect.value;
        if (resultsContainer) {
            savedState.resultsHtml = resultsContainer.innerHTML;
            savedState.scrollTop = resultsContainer.scrollTop;
            savedState.hasResults = resultsContainer.querySelector('.chat-search-result-item') !== null;
        }
        panel.remove();
    }
    if (overlay) overlay.remove();
    panelOpen = false;
}

// ========== Search Dispatch ==========

async function doSearch() {
    const mode = document.getElementById('chat-search-mode').value;
    if (mode === 'vector') {
        await doVectorSearch();
    } else {
        await doKeywordSearch();
    }
}

// ========== Keyword Search ==========

async function doKeywordSearch() {
    const input = document.getElementById('chat-search-input');
    const scopeSelect = document.getElementById('chat-search-scope');
    const resultsContainer = document.querySelector('#chat-search-panel .chat-search-results');

    const query = input.value.trim();
    if (!query) return;

    const scope = scopeSelect.value;
    let characterName = getCharacterAvatarStem();

    if (scope === 'current_character' && (!characterName || selected_group)) {
        resultsContainer.innerHTML = '<div class="chat-search-status">No character is currently selected.</div>';
        return;
    }

    resultsContainer.innerHTML = '<div class="chat-search-status"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>';

    try {
        const body = { query, scope };
        if (scope === 'current_character') {
            body.characterName = characterName;
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
        renderKeywordResults(data.results, query);
    } catch (error) {
        console.error('[chat-search] Search error:', error);
        resultsContainer.innerHTML = `<div class="chat-search-status">Error: ${error.message}</div>`;
    }
}

// ========== Vector Search ==========

async function doVectorSearch() {
    const input = document.getElementById('chat-search-input');
    const scopeSelect = document.getElementById('chat-search-scope');
    const resultsContainer = document.querySelector('#chat-search-panel .chat-search-results');
    const progressDiv = document.querySelector('#chat-search-panel .chat-search-progress');

    const query = input.value.trim();
    if (!query) return;

    const scope = scopeSelect.value;
    let characterName = getCharacterAvatarStem();

    if (scope === 'current_character' && (!characterName || selected_group)) {
        resultsContainer.innerHTML = '<div class="chat-search-status">No character is currently selected.</div>';
        return;
    }

    // Check vector settings
    const vectorSettings = getVectorSettings();
    if (!vectorSettings || !vectorSettings.source) {
        resultsContainer.innerHTML = '<div class="chat-search-status">Vector Storage extension is not configured. Please set it up first.</div>';
        return;
    }

    resultsContainer.innerHTML = '<div class="chat-search-status"><i class="fa-solid fa-spinner fa-spin"></i> Preparing vector search...</div>';

    try {
        // Step 1: Get all chats in scope
        const body = { scope };
        if (scope === 'current_character') body.characterName = characterName;

        const chatsResp = await fetch('/api/plugins/chat-search/list-chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        const chats = await chatsResp.json();

        if (!chats || chats.length === 0) {
            resultsContainer.innerHTML = '<div class="chat-search-status">No chats found.</div>';
            return;
        }

        // Step 2: Check vectorization status for each chat
        const collectionIds = chats.map(c => c.file);
        const vectorStatus = {};

        for (const chat of chats) {
            try {
                const hashes = await vectorListHashes(chat.file, vectorSettings);
                vectorStatus[chat.file] = { hashes, chat };
            } catch {
                vectorStatus[chat.file] = { hashes: [], chat };
            }
        }

        // Step 3: Find chats that need vectorization
        const needsVectorization = chats.filter(c => {
            const status = vectorStatus[c.file];
            return status.hashes.length === 0 && c.messageCount > 0;
        });

        // Step 4: Vectorize missing chats with progress
        if (needsVectorization.length > 0) {
            progressDiv.style.display = '';
            let done = 0;

            for (const chat of needsVectorization) {
                done++;
                updateProgress(progressDiv, `Vectorizing ${chat.character}/${chat.file}`, done, needsVectorization.length);

                try {
                    await vectorizeChat(chat.character, chat.file, vectorSettings);
                } catch (err) {
                    console.warn(`[chat-search] Failed to vectorize ${chat.file}:`, err);
                }
            }

            progressDiv.style.display = 'none';
        }

        // Step 5: Query all collections
        resultsContainer.innerHTML = '<div class="chat-search-status"><i class="fa-solid fa-spinner fa-spin"></i> Querying vectors...</div>';

        const activeCollections = collectionIds.filter(id => {
            const s = vectorStatus[id];
            return (s && s.hashes.length > 0) || needsVectorization.some(c => c.file === id);
        });

        if (activeCollections.length === 0) {
            resultsContainer.innerHTML = '<div class="chat-search-status">No vectorized chats found.</div>';
            return;
        }

        const queryResults = await vectorQueryMulti(activeCollections, query, vectorSettings);

        // Step 6: Build results with metadata
        const results = [];
        for (const [collectionId, data] of Object.entries(queryResults)) {
            if (!data.metadata || data.metadata.length === 0) continue;
            const chat = chats.find(c => c.file === collectionId);
            if (!chat) continue;

            // Take the best match from this collection
            const best = data.metadata[0];
            results.push({
                character: chat.character,
                file: collectionId,
                text: best.text,
                index: best.index,
            });
        }

        renderVectorResults(results, query);
    } catch (error) {
        console.error('[chat-search] Vector search error:', error);
        resultsContainer.innerHTML = `<div class="chat-search-status">Error: ${error.message}</div>`;
        progressDiv.style.display = 'none';
    }
}

// ========== Vector API Helpers ==========

function getVectorSettings() {
    try {
        const ctx = SillyTavern.getContext();
        const vs = ctx.extensionSettings.vectors;
        if (!vs || !vs.source) return null;
        return vs;
    } catch {
        return null;
    }
}

function buildVectorBody(vectorSettings) {
    const body = { source: vectorSettings.source };
    const src = vectorSettings.source;

    const modelMap = {
        openai: 'openai_model',
        cohere: 'cohere_model',
        togetherai: 'togetherai_model',
        openrouter: 'openrouter_model',
        electronhub: 'electronhub_model',
        chutes: 'chutes_model',
        nanogpt: 'nanogpt_model',
        siliconflow: 'siliconflow_model',
        ollama: 'ollama_model',
        vllm: 'vllm_model',
        webllm: 'webllm_model',
    };

    if (modelMap[src]) {
        body.model = vectorSettings[modelMap[src]];
    }
    if (src === 'palm' || src === 'vertexai') {
        body.model = vectorSettings.google_model;
        body.api = src === 'palm' ? 'makersuite' : 'vertexai';
    }

    return body;
}

async function vectorListHashes(collectionId, vectorSettings) {
    const response = await fetch('/api/vector/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorBody(vectorSettings),
            collectionId,
        }),
    });
    if (!response.ok) return [];
    return await response.json();
}

async function vectorQueryMulti(collectionIds, searchText, vectorSettings) {
    const response = await fetch('/api/vector/query-multi', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ...buildVectorBody(vectorSettings),
            collectionIds,
            searchText,
            topK: 200,
            threshold: vectorSettings.score_threshold || 0.25,
        }),
    });
    if (!response.ok) throw new Error(`Vector query failed: ${response.status}`);
    return await response.json();
}

async function vectorizeChat(character, file, vectorSettings) {
    // Get messages from backend plugin
    const msgResp = await fetch('/api/plugins/chat-search/chat-messages', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ character, file }),
    });
    if (!msgResp.ok) throw new Error(`Failed to get messages: ${msgResp.status}`);
    const messages = await msgResp.json();

    if (messages.length === 0) return;

    // Split messages into chunks, matching native vectors extension behavior
    const chunkSize = vectorSettings.message_chunk_size || 400;
    const delimiters = ['\n\n', '\n', ' ', ''];
    const items = [];

    for (const m of messages) {
        const hash = getStringHash(m.text);
        if (chunkSize > 0 && m.text.length > chunkSize) {
            const chunks = splitRecursive(m.text, chunkSize, delimiters);
            for (const chunk of chunks) {
                items.push({ hash, text: chunk, index: m.index });
            }
        } else {
            items.push({ hash, text: m.text, index: m.index });
        }
    }

    // Step 1: Try cached insert — reuse vectors from other collections with same hash
    const vBody = buildVectorBody(vectorSettings);
    const cachedResp = await fetch('/api/plugins/chat-search/vector-insert-cached', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            collectionId: file,
            source: vBody.source,
            model: vBody.model || '',
            items,
        }),
    });

    if (!cachedResp.ok) throw new Error(`Cached insert failed: ${cachedResp.status}`);
    const { cachedCount, uncachedItems } = await cachedResp.json();

    if (cachedCount > 0) {
        console.log(`[chat-search] Reused ${cachedCount} cached vectors for ${file}`);
    }

    // Step 2: Only call embedding API for truly new items
    if (uncachedItems.length > 0) {
        console.log(`[chat-search] Generating ${uncachedItems.length} new embeddings for ${file}`);
        const batchSize = 10;
        for (let i = 0; i < uncachedItems.length; i += batchSize) {
            const batch = uncachedItems.slice(i, i + batchSize);
            const response = await fetch('/api/vector/insert', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ...vBody,
                    collectionId: file,
                    items: batch,
                }),
            });
            if (!response.ok) throw new Error(`Vector insert failed: ${response.status}`);
        }
    }
}

// ========== Progress ==========

function updateProgress(progressDiv, text, done, total) {
    const pct = Math.round((done / total) * 100);
    progressDiv.querySelector('.chat-search-progress-text').textContent = `${text} (${done}/${total})`;
    progressDiv.querySelector('.chat-search-progress-bar-fill').style.width = `${pct}%`;
}

// ========== Render Results ==========

function renderKeywordResults(results, query) {
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
        item.dataset.character = result.character;
        item.dataset.file = result.file;

        const highlightedText = highlightKeywords(snippetAroundKeywords(result.mes, keywords, 200), keywords);

        item.innerHTML = `
            <div class="chat-search-result-meta">
                <span class="chat-search-result-character">${escapeHtml(result.character)}</span>
                <span>${escapeHtml(result.file)}</span>
            </div>
            <div class="chat-search-result-sender">${escapeHtml(result.name)}:</div>
            <div class="chat-search-result-text">${highlightedText}</div>
        `;

        item.addEventListener('click', () => {
            item.classList.add('visited');
            navigateToChat(result.character, result.file);
        });

        container.appendChild(item);
    }
}

function renderVectorResults(results, query) {
    const container = document.querySelector('#chat-search-panel .chat-search-results');

    if (!results || results.length === 0) {
        container.innerHTML = '<div class="chat-search-status">No results found.</div>';
        return;
    }

    container.innerHTML = `<div class="chat-search-status">${results.length} chat(s) matched.</div>`;

    for (const result of results) {
        const item = document.createElement('div');
        item.classList.add('chat-search-result-item');
        item.dataset.character = result.character;
        item.dataset.file = result.file;

        const snippet = snippetAroundKeywords(result.text, query.toLowerCase().split(/\s+/).filter(Boolean), 200);

        item.innerHTML = `
            <div class="chat-search-result-meta">
                <span class="chat-search-result-character">${escapeHtml(result.character)}</span>
                <span>${escapeHtml(result.file)}</span>
            </div>
            <div class="chat-search-result-text">${escapeHtml(snippet)}</div>
        `;

        item.addEventListener('click', () => {
            item.classList.add('visited');
            navigateToChat(result.character, result.file);
        });

        container.appendChild(item);
    }
}

function bindResultClicks(container) {
    container.querySelectorAll('.chat-search-result-item').forEach(item => {
        item.addEventListener('click', () => {
            item.classList.add('visited');
            navigateToChat(item.dataset.character, item.dataset.file);
        });
    });
}

// ========== Text Helpers ==========

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

    const lower = clean.toLowerCase();
    let earliest = clean.length;
    for (const kw of keywords) {
        const idx = lower.indexOf(kw);
        if (idx !== -1 && idx < earliest) {
            earliest = idx;
        }
    }

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

// ========== Helpers ==========

function getCharacterAvatarStem() {
    if (this_chid !== undefined && characters[this_chid]) {
        const c = characters[this_chid];
        return c.avatar ? c.avatar.replace(/\.[^.]+$/, '') : c.name;
    }
    return null;
}

// ========== Navigation ==========

async function navigateToChat(characterName, chatFile) {
    closeSearchPanel();

    const charIndex = characters.findIndex(c => {
        const avatarStem = c.avatar ? c.avatar.replace(/\.[^.]+$/, '') : '';
        return avatarStem === characterName || c.name === characterName;
    });
    if (charIndex === -1) {
        toastr.error(`Character "${characterName}" not found.`);
        return;
    }

    try {
        if (this_chid !== charIndex || selected_group) {
            await selectCharacterById(charIndex);
        }

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
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        if (panelOpen) {
            closeSearchPanel();
        } else {
            createSearchPanel();
        }
    }
    if (e.key === 'Escape' && panelOpen) {
        closeSearchPanel();
    }
});

// ========== Init ==========

jQuery(() => {
    addSearchButton();
    console.log('[chat-search] Extension loaded.');
});
