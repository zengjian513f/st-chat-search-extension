import {
    characters,
    this_chid,
    getRequestHeaders,
    selectCharacterById,
    openCharacterChat,
    getCurrentChatId,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

let panelOpen = false;
let activeAbort = null;
let searchPromise = null;

// Persisted state across open/close
const savedState = {
    query: '',
    scope: 'all',
    mode: 'keyword',
    onePerChat: true,
    dedup: true,
    days: 0,
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
        </div>
        <div class="chat-search-options">
            <fieldset class="chat-search-radio-group">
                <legend>Mode</legend>
                <label><input type="radio" name="chat-search-mode" value="keyword" checked /> Keyword</label>
                <label><input type="radio" name="chat-search-mode" value="vector" /> Fuzzy</label>
            </fieldset>
            <fieldset class="chat-search-radio-group">
                <legend>Scope</legend>
                <label><input type="radio" name="chat-search-scope" value="current_character" /> Current Char</label>
                <label><input type="radio" name="chat-search-scope" value="all" checked /> All</label>
            </fieldset>
            <fieldset class="chat-search-radio-group">
                <legend>Filter</legend>
                <label><input type="checkbox" id="chat-search-one-per-chat" checked /> One per chat</label>
                <label><input type="checkbox" id="chat-search-dedup" checked /> Dedup branches</label>
                <label>Days: <input type="number" id="chat-search-days" min="0" value="0" style="width:50px;" title="Only search chats within N days (0 = unlimited)" /></label>
            </fieldset>
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
    const resultsContainer = panel.querySelector('.chat-search-results');

    input.value = savedState.query;
    const modeRadio = panel.querySelector(`input[name="chat-search-mode"][value="${savedState.mode}"]`);
    if (modeRadio) modeRadio.checked = true;
    const scopeRadio = panel.querySelector(`input[name="chat-search-scope"][value="${savedState.scope}"]`);
    if (scopeRadio) scopeRadio.checked = true;
    panel.querySelector('#chat-search-one-per-chat').checked = savedState.onePerChat;
    panel.querySelector('#chat-search-dedup').checked = savedState.dedup;
    panel.querySelector('#chat-search-days').value = savedState.days;
    if (savedState.hasResults) {
        resultsContainer.innerHTML = savedState.resultsHtml;
        bindResultClicks(resultsContainer);
        setTimeout(() => { resultsContainer.scrollTop = savedState.scrollTop; }, 0);
    }

    // Bind events
    panel.querySelector('.chat-search-close').addEventListener('click', closeSearchPanel);
    panel.querySelector('#chat-search-btn').addEventListener('click', () => doSearch());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });

    setTimeout(() => input.focus(), 100);
    panelOpen = true;
}

function closeSearchPanel() {
    if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
    }

    const panel = document.getElementById('chat-search-panel');
    const overlay = document.getElementById('chat-search-overlay');

    if (panel) {
        const input = panel.querySelector('#chat-search-input');
        const resultsContainer = panel.querySelector('.chat-search-results');
        if (input) savedState.query = input.value;
        const modeRadio = panel.querySelector('input[name="chat-search-mode"]:checked');
        if (modeRadio) savedState.mode = modeRadio.value;
        const scopeRadio = panel.querySelector('input[name="chat-search-scope"]:checked');
        if (scopeRadio) savedState.scope = scopeRadio.value;
        const onePerChat = panel.querySelector('#chat-search-one-per-chat');
        const dedup = panel.querySelector('#chat-search-dedup');
        if (onePerChat) savedState.onePerChat = onePerChat.checked;
        if (dedup) savedState.dedup = dedup.checked;
        const daysInput = panel.querySelector('#chat-search-days');
        if (daysInput) savedState.days = Number(daysInput.value) || 0;
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
    if (activeAbort) {
        activeAbort.abort();
        activeAbort = null;
    }
    // Wait for previous search to fully finish after abort
    if (searchPromise) {
        await searchPromise.catch(() => {});
    }
    const mode = document.querySelector('input[name="chat-search-mode"]:checked').value;
    if (mode === 'vector') {
        searchPromise = doVectorSearch();
    } else {
        searchPromise = doKeywordSearch();
    }
    await searchPromise;
    searchPromise = null;
}

// ========== Keyword Search ==========

async function doKeywordSearch() {
    const input = document.getElementById('chat-search-input');
    const scopeSelect = document.querySelector('input[name="chat-search-scope"]:checked');
    const resultsContainer = document.querySelector('#chat-search-panel .chat-search-results');

    const query = input.value.trim();
    if (!query) return;

    const scope = scopeSelect.value;
    const characterName = getCharacterAvatarStem();

    if (scope === 'current_character' && (!characterName || selected_group)) {
        resultsContainer.innerHTML = '<div class="chat-search-status">No character is currently selected.</div>';
        return;
    }

    resultsContainer.innerHTML = '<div class="chat-search-status"><i class="fa-solid fa-spinner fa-spin"></i> Searching...</div>';

    try {
        const onePerChat = document.getElementById('chat-search-one-per-chat').checked;
        const dedup = document.getElementById('chat-search-dedup').checked;
        const days = Number(document.getElementById('chat-search-days').value) || 0;

        const body = { query, scope, onePerChat, days };
        if (scope === 'current_character') body.characterName = characterName;

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
        let results = data.results;
        if (dedup) results = deduplicateResults(results);
        renderKeywordResults(results, query);
    } catch (error) {
        console.error('[chat-search] Search error:', error);
        resultsContainer.innerHTML = `<div class="chat-search-status">Error: ${error.message}</div>`;
    }
}

// ========== Vector Search ==========

async function doVectorSearch() {
    const input = document.getElementById('chat-search-input');
    const scopeSelect = document.querySelector('input[name="chat-search-scope"]:checked');
    const resultsContainer = document.querySelector('#chat-search-panel .chat-search-results');
    const progressDiv = document.querySelector('#chat-search-panel .chat-search-progress');

    const query = input.value.trim();
    if (!query) return;

    const scope = scopeSelect.value;
    const characterName = getCharacterAvatarStem();

    if (scope === 'current_character' && (!characterName || selected_group)) {
        resultsContainer.innerHTML = '<div class="chat-search-status">No character is currently selected.</div>';
        return;
    }

    const vectorSettings = getVectorSettings();
    if (!vectorSettings || !vectorSettings.source) {
        resultsContainer.innerHTML = '<div class="chat-search-status">Vector Storage extension is not configured. Please set it up first.</div>';
        return;
    }

    resultsContainer.innerHTML = '<div class="chat-search-status"><i class="fa-solid fa-spinner fa-spin"></i> Preparing vector search...</div>';
    progressDiv.style.display = '';

    try {
        // Step 1: Vectorize all chats via SSE streaming
        const vBody = buildVectorBody(vectorSettings);
        const days = Number(document.getElementById('chat-search-days').value) || 0;
        const sseBody = {
            scope,
            source: vBody.source,
            model: vBody.model || '',
            chunkSize: vectorSettings.message_chunk_size || 400,
            days,
        };
        if (scope === 'current_character') sseBody.characterName = characterName;

        const collectionIds = await streamVectorizeAll(sseBody, progressDiv);
        progressDiv.style.display = 'none';

        if (!collectionIds || collectionIds.length === 0) {
            resultsContainer.innerHTML = '<div class="chat-search-status">No chats found.</div>';
            return;
        }

        // Step 2: Query all collections with scores
        resultsContainer.innerHTML = '<div class="chat-search-status"><i class="fa-solid fa-spinner fa-spin"></i> Querying vectors...</div>';

        const onePerChat = document.getElementById('chat-search-one-per-chat').checked;
        const dedup = document.getElementById('chat-search-dedup').checked;

        const queryResp = await fetch('/api/plugins/chat-search/query-with-scores', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                collectionIds,
                searchText: query,
                source: vBody.source,
                model: vBody.model || '',
                threshold: vectorSettings.score_threshold || 0.25,
                topK: onePerChat ? 1 : 10,
            }),
        });
        if (!queryResp.ok) throw new Error(`Query failed: ${queryResp.status}`);
        const scoredResults = await queryResp.json();

        // Step 3: Get chat→character mapping
        const listBody = { scope };
        if (scope === 'current_character') listBody.characterName = characterName;
        const chatsResp = await fetch('/api/plugins/chat-search/list-chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(listBody),
        });
        const chats = await chatsResp.json();

        // Step 4: Build results (already sorted by score desc)
        const results = scoredResults.map(r => {
            const chat = chats.find(c => c.file === r.collectionId);
            return {
                character: chat?.character || '?',
                file: r.collectionId,
                text: r.text,
                index: r.index,
                score: r.score,
            };
        });

        renderVectorResults(dedup ? deduplicateResults(results) : results, query);
    } catch (error) {
        if (error.name === 'AbortError') return;
        console.error('[chat-search] Vector search error:', error);
        resultsContainer.innerHTML = `<div class="chat-search-status">Error: ${error.message}</div>`;
        progressDiv.style.display = 'none';
    }
}

// ========== SSE Vectorization ==========

async function streamVectorizeAll(body, progressDiv) {
    return new Promise((resolve, reject) => {
        const headers = getRequestHeaders();
        activeAbort = new AbortController();
        const signal = activeAbort.signal;

        const params = new URLSearchParams(body);
        params.set('requestId', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        fetch('/api/plugins/chat-search/vectorize-all?' + params.toString(), {
            method: 'GET',
            headers,
            signal,
        }).then(async response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Parse SSE events from buffer
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line

                let eventType = null;
                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        eventType = line.slice(7).trim();
                    } else if (line.startsWith('data: ') && eventType) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (eventType === 'progress') {
                                updateProgress(progressDiv, data.message, data.done, data.total);
                            } else if (eventType === 'complete') {
                                resolve(data.collectionIds);
                                return;
                            } else if (eventType === 'error') {
                                reject(new Error(data.message));
                                return;
                            }
                        } catch { /* skip malformed */ }
                        eventType = null;
                    }
                }
            }

            reject(new Error('SSE stream ended without complete event'));
        }).catch(reject);
    });
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
        openai: 'openai_model', cohere: 'cohere_model', togetherai: 'togetherai_model',
        openrouter: 'openrouter_model', electronhub: 'electronhub_model', chutes: 'chutes_model',
        nanogpt: 'nanogpt_model', siliconflow: 'siliconflow_model', ollama: 'ollama_model',
        vllm: 'vllm_model', webllm: 'webllm_model',
    };

    if (modelMap[src]) body.model = vectorSettings[modelMap[src]];
    if (src === 'palm' || src === 'vertexai') {
        body.model = vectorSettings.google_model;
        body.api = src === 'palm' ? 'makersuite' : 'vertexai';
    }

    return body;
}


// ========== Progress ==========

function updateProgress(progressDiv, text, done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
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

        const scoreText = result.score !== undefined ? ` (${(result.score * 100).toFixed(1)}%)` : '';

        item.innerHTML = `
            <div class="chat-search-result-meta">
                <span class="chat-search-result-character">${escapeHtml(result.character)}${scoreText}</span>
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
        if (idx !== -1 && idx < earliest) earliest = idx;
    }

    let start = Math.max(0, earliest - Math.floor(maxLen / 4));
    let end = Math.min(clean.length, start + maxLen);
    if (end - start < maxLen) start = Math.max(0, end - maxLen);

    let snippet = clean.substring(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < clean.length) snippet = snippet + '...';
    return snippet;
}

function deduplicateResults(results) {
    const seen = new Set();
    return results.filter(r => {
        // Use matched text (or mes) as dedup key, truncated to first 100 chars
        const text = (r.mes || r.text || '').substring(0, 100);
        if (seen.has(text)) return false;
        seen.add(text);
        return true;
    });
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
        if (panelOpen) closeSearchPanel();
        else createSearchPanel();
    });

    container.appendChild(button);
}

// ========== Keyboard Shortcut ==========

document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        if (panelOpen) closeSearchPanel();
        else createSearchPanel();
    }
    if (e.key === 'Escape' && panelOpen) closeSearchPanel();
});

// ========== Init ==========

jQuery(() => {
    addSearchButton();

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'chat-search',
        callback: async () => {
            if (panelOpen) closeSearchPanel();
            else createSearchPanel();
            return '';
        },
        helpString: 'Open the global chat search panel.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'purge-all-vectors',
        callback: async () => {
            const resp = await fetch('/api/plugins/chat-search/purge-all-vectors', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            if (!resp.ok) {
                toastr.error('Failed to purge vectors');
                return '';
            }
            const data = await resp.json();
            toastr.success(data.message);
            return '';
        },
        helpString: 'Purge all vector indexes for all sources.',
    }));

    console.log('[chat-search] Extension loaded.');
});
