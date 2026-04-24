// ===================== STATE =====================
const state = {
    activeDocId: null,
    activeDocFilename: null,
    pages: [],          // {num, filename, image_url, ocr_text, ocr_time, formatted_text, format_time}
    activePageNum: null,
    modelLoaded: false,
    ocrRunning: false,
    ocrAbort: false,
    formatRunning: false,
    docs: [],
    // model & prompt
    ocrModel: 'glm-ocr:latest',
    codeModel: 'qwen2.5-coder:3b',
    availableModels: [],
    prompts: [],
    selectedOcrPromptId: null,
    selectedFormatPromptId: null,
    editingPromptId: null,
    promptType: 'format',
};

// ===================== DOM REFS =====================
const $ = id => document.getElementById(id);
const topFilename       = $('topFilename');
const deleteDocBtn      = $('deleteDocBtn');
const statusDot         = $('statusDot');
const statusText        = $('statusText');
const newFileBtn        = $('newFileBtn');
const ocrAllBtn         = $('ocrAllBtn');
const exportWrap        = $('exportWrap');
const exportBtn         = $('exportBtn');
const exportMenu        = $('exportMenu');
const formatWrap        = $('formatWrap');
const formatBtn         = $('formatBtn');
const formatMenu        = $('formatMenu');
const copyAllBtn        = $('copyAllBtn');
const ocrProgress       = $('ocrProgress');
const ocrProgressBar    = $('ocrProgressBar');
const panelLeft         = $('panelLeft');
const pageList          = $('pageList');
const panelCenter       = $('panelCenter');
const uploadZone        = $('uploadZone');
const previewContainer  = $('previewContainer');
const previewImage      = $('previewImage');
const panelRight        = $('panelRight');
const resultBody        = $('resultBody');
const resultTime        = $('resultTime');
const resultToolbar     = $('resultToolbar');
const rescanBtn         = $('rescanBtn');
const copyPageBtn       = $('copyPageBtn');
const fileInput         = $('fileInput');
const searchWrap        = $('searchWrap');
const searchToggle      = $('searchToggle');
const searchInput       = $('searchInput');
const searchInfo        = $('searchInfo');
const searchPrev        = $('searchPrev');
const searchNext        = $('searchNext');
const docListSection    = $('docListSection');
const docListHeader     = $('docListHeader');
const docList           = $('docList');
const docListCount      = $('docListCount');
const docListToggle     = $('docListToggle');
const resizeHandle      = $('resizeHandle');
const toastContainer    = $('toastContainer');
const ocrModelSelect    = $('ocrModelSelect');
const codeModelSelect   = $('codeModelSelect');
const promptManageBtn   = $('promptManageBtn');
const promptModal       = $('promptModal');
const promptModalClose  = $('promptModalClose');
const promptList        = $('promptList');
const promptNameInput   = $('promptNameInput');
const promptContentInput= $('promptContentInput');
const promptSaveBtn     = $('promptSaveBtn');
const promptNewBtn      = $('promptNewBtn');
const promptDeleteBtn   = $('promptDeleteBtn');
const promptTypeTabs    = document.querySelectorAll('.prompt-type-tab');

// ===================== UTIL =====================

function escHtml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fetchT(url, opts = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const existing = opts.signal;
    if (existing) existing.addEventListener('abort', () => controller.abort());
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function showToast(message, type = 'error', duration = 3500) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    toastContainer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 300);
    }, duration);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

function buildTimeLabel(ocrTime, formatTime) {
    const parts = [];
    if (ocrTime != null) parts.push(`OCR: ${ocrTime}s`);
    if (formatTime != null) parts.push(`格式化: ${formatTime}s`);
    return parts.join(' | ');
}

// ===================== RESIZE HANDLE =====================
{
    let startX, startWidth;
    resizeHandle.addEventListener('mousedown', e => {
        e.preventDefault();
        startX = e.clientX; startWidth = panelRight.offsetWidth;
        resizeHandle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onDragEnd);
    });
    function onDrag(e) {
        const delta = startX - e.clientX;
        panelRight.style.width = Math.min(Math.max(startWidth + delta, 280), window.innerWidth * 0.6) + 'px';
    }
    function onDragEnd() {
        resizeHandle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', onDragEnd);
    }
}

// ===================== STATUS =====================
async function checkStatus() {
    try {
        const res = await fetchT('/api/status', {}, 5000);
        const data = await res.json();
        state.modelLoaded = data.model_loaded;
        if (data.model_loaded) {
            statusDot.className = 'status-dot online';
            statusText.textContent = 'Ready';
        } else {
            statusDot.className = 'status-dot error';
            statusText.textContent = 'OCR model not found';
        }
    } catch {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Offline';
    }
}
checkStatus();
setInterval(checkStatus, 5000);

// ===================== MODELS =====================
async function fetchModels() {
    try {
        const res = await fetchT('/api/models', {}, 5000);
        if (!res.ok) return;
        const data = await res.json();
        state.availableModels = data.models || [];
        renderModelSelects();
    } catch { /* silent */ }
}

function renderModelSelects() {
    [[ocrModelSelect, state.ocrModel], [codeModelSelect, state.codeModel]].forEach(([sel, cur]) => {
        sel.innerHTML = '';
        if (state.availableModels.length === 0) {
            const opt = document.createElement('option');
            opt.value = cur; opt.textContent = cur; sel.appendChild(opt);
            return;
        }
        // Always ensure current default is available
        const all = state.availableModels.includes(cur)
            ? state.availableModels
            : [cur, ...state.availableModels];
        all.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m; opt.textContent = m;
            if (m === cur) opt.selected = true;
            sel.appendChild(opt);
        });
    });
}

ocrModelSelect.addEventListener('change', () => { state.ocrModel = ocrModelSelect.value; });
codeModelSelect.addEventListener('change', () => { state.codeModel = codeModelSelect.value; });

// ===================== PROMPTS =====================
async function fetchPrompts() {
    try {
        const res = await fetchT('/api/prompts', {}, 5000);
        if (!res.ok) return;
        state.prompts = await res.json();
    } catch { /* silent */ }
}


// --- Modal open/close ---
promptManageBtn.addEventListener('click', openPromptModal);
promptModalClose.addEventListener('click', closePromptModal);
promptModal.addEventListener('click', e => { if (e.target === promptModal) closePromptModal(); });

function openPromptModal() {
    state.promptType = 'format';
    promptTypeTabs.forEach(t => t.classList.toggle('active', t.dataset.type === 'format'));
    state.editingPromptId = null;
    promptModal.style.display = 'flex';
    renderPromptModalList();
}
function closePromptModal() {
    promptModal.style.display = 'none';
    state.editingPromptId = null;
}

// --- Type tabs ---
promptTypeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        promptTypeTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.promptType = tab.dataset.type;
        state.editingPromptId = null;
        promptNameInput.value = '';
        promptContentInput.value = '';
        renderPromptModalList();
    });
});

function renderPromptModalList() {
    const list = state.prompts.filter(p => p.type === state.promptType);
    promptList.innerHTML = '';
    if (list.length === 0) {
        promptList.innerHTML = '<div style="padding:12px;color:rgba(45,45,45,0.4);font-size:13px;">暂无提示词</div>';
        return;
    }
    // Which prompt is "selected for use" in this type
    const selectedId = state.promptType === 'format' ? state.selectedFormatPromptId : state.selectedOcrPromptId;
    list.forEach(p => {
        const div = document.createElement('div');
        const isEditing  = p.id === state.editingPromptId;
        const isSelected = p.id === selectedId;
        let cls = 'prompt-list-item';
        if (isEditing)  cls += ' editing';
        if (isSelected) cls += ' selected';
        div.className = cls;
        div.textContent = p.name;
        div.title = p.name;
        // Click = select for use AND load into editor (no close)
        div.addEventListener('click', () => loadAndSelectPrompt(p));
        promptList.appendChild(div);
    });
    // Auto-load first if none loaded yet
    if (!state.editingPromptId && list.length > 0) loadAndSelectPrompt(list[0]);
}

function loadAndSelectPrompt(p) {
    // Load into editor
    state.editingPromptId = p.id;
    promptNameInput.value = p.name;
    promptContentInput.value = p.content;
    // Also select it for use
    if (state.promptType === 'format') {
        state.selectedFormatPromptId = p.id;
    } else {
        state.selectedOcrPromptId = p.id;
    }
    // Refresh list to show new states
    _refreshPromptListClasses();
}

function _refreshPromptListClasses() {
    const selectedId = state.promptType === 'format' ? state.selectedFormatPromptId : state.selectedOcrPromptId;
    promptList.querySelectorAll('.prompt-list-item').forEach((el, i) => {
        const listItems = state.prompts.filter(p => p.type === state.promptType);
        const p = listItems[i];
        if (!p) return;
        el.className = 'prompt-list-item';
        if (p.id === state.editingPromptId) el.classList.add('editing');
        if (p.id === selectedId)            el.classList.add('selected');
    });
}

// --- CRUD ---
promptNewBtn.addEventListener('click', () => {
    state.editingPromptId = null;
    promptNameInput.value = '';
    promptContentInput.value = '';
    promptList.querySelectorAll('.prompt-list-item').forEach(el => el.classList.remove('editing'));
    promptNameInput.focus();
});

promptSaveBtn.addEventListener('click', async () => {
    const name = promptNameInput.value.trim();
    const content = promptContentInput.value.trim();
    if (!name || !content) { showToast('请填写名称和内容', 'warn'); return; }

    try {
        let res;
        if (state.editingPromptId) {
            res = await fetchT(`/api/prompts/${state.editingPromptId}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name, content, type: state.promptType}),
            }, 10000);
        } else {
            res = await fetchT('/api/prompts', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({name, content, type: state.promptType}),
            }, 10000);
            if (res.ok) {
                const saved = await res.json();
                state.editingPromptId = saved.id;
            }
        }
        if (!res.ok) throw new Error('Save failed');
        await fetchPrompts();
        renderPromptModalList();
        promptSaveBtn.textContent = '已保存 ✓';
        promptSaveBtn.classList.add('success');
        setTimeout(() => { promptSaveBtn.textContent = '保存'; promptSaveBtn.classList.remove('success'); }, 1500);
    } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
});

promptDeleteBtn.addEventListener('click', async () => {
    if (!state.editingPromptId) { showToast('请先选择要删除的提示词', 'warn'); return; }
    if (!confirm('确定删除此提示词？')) return;
    try {
        await fetchT(`/api/prompts/${state.editingPromptId}`, {method: 'DELETE'}, 10000);
        state.editingPromptId = null;
        promptNameInput.value = '';
        promptContentInput.value = '';
        await fetchPrompts();
        renderPromptModalList();
    } catch (e) { showToast('删除失败: ' + e.message, 'error'); }
});


// ===================== KATEX RENDER =====================
function renderLatex(container, text) {
    // Use textContent first to avoid XSS, then let KaTeX process
    container.textContent = text || '';
    if (!text) return;
    if (typeof renderMathInElement === 'undefined') return;
    renderMathInElement(container, {
        delimiters: [
            {left: '$$',            right: '$$',            display: true},
            {left: '\\[',           right: '\\]',           display: true},
            {left: '\\begin{equation}',   right: '\\end{equation}',   display: true},
            {left: '\\begin{equation*}',  right: '\\end{equation*}',  display: true},
            {left: '\\begin{align}',      right: '\\end{align}',      display: true},
            {left: '\\begin{align*}',     right: '\\end{align*}',     display: true},
            {left: '\\begin{aligned}',    right: '\\end{aligned}',    display: true},
            {left: '\\begin{gather}',     right: '\\end{gather}',     display: true},
            {left: '\\begin{gather*}',    right: '\\end{gather*}',    display: true},
            {left: '\\begin{multline}',   right: '\\end{multline}',   display: true},
            {left: '\\begin{multline*}',  right: '\\end{multline*}',  display: true},
            {left: '$',            right: '$',            display: false},
            {left: '\\(',          right: '\\)',          display: false},
        ],
        throwOnError: false,
        errorColor: '#DC2626',
    });
}

// ===================== SHOW EDITOR =====================
function showEditor(ocrText, ocrTime, formattedText, formatTime) {
    resultBody.innerHTML = '';

    // Upper: LaTeX Code textarea
    const latexSection = document.createElement('div');
    latexSection.className = 'latex-section';
    const secHeader = document.createElement('div');
    secHeader.className = 'section-header';
    secHeader.textContent = 'LaTeX Code';
    latexSection.appendChild(secHeader);

    const ta = document.createElement('textarea');
    ta.className = 'result-editor';
    ta.value = formattedText || ocrText || '';
    ta.placeholder = 'No text recognized';
    ta.addEventListener('input', () => {
        const page = state.pages.find(p => p.num === state.activePageNum);
        if (page) {
            // Edits update the ocr_text (base truth) and invalidate current formatting
            page.ocr_text = ta.value;
            page.formatted_text = null;
            page.format_time = null;
            updatePageThumbStatus(page);
        }
        
        const rBody = resultBody.querySelector('.render-body');
        if (rBody) {
            if (typeof renderMathInElement !== 'undefined') {
                renderLatex(rBody, ta.value);
            } else {
                rBody.textContent = ta.value;
            }
        }
        
        const docId = state.activeDocId, pageNum = state.activePageNum;
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            if (docId && pageNum != null) saveTextToServer(docId, pageNum, ta.value);
        }, 800);
    });
    latexSection.appendChild(ta);
    resultBody.appendChild(latexSection);

    // Lower: Rendered Preview
    const renderSection = document.createElement('div');
    renderSection.className = 'render-section';
    const renderHeader = document.createElement('div');
    renderHeader.className = 'render-header';
    renderHeader.innerHTML = '<span class="render-header-title">Rendered Preview</span>';
    renderSection.appendChild(renderHeader);
    const renderBody = document.createElement('div');
    renderBody.className = 'render-body';
    renderSection.appendChild(renderBody);
    resultBody.appendChild(renderSection);

    // Render: prefer formatted_text, fall back to ocr_text
    const displayText = formattedText || ocrText;
    if (displayText) {
        // Wait for KaTeX to load before rendering
        if (typeof renderMathInElement !== 'undefined') {
            renderLatex(renderBody, displayText);
        } else {
            renderBody.textContent = displayText;
            document.addEventListener('katex-ready', () => renderLatex(renderBody, displayText), {once: true});
        }
    }

    resultToolbar.style.display = '';
    const lbl = buildTimeLabel(ocrTime, formatTime);
    if (lbl) { resultTime.textContent = lbl; resultTime.style.display = ''; }
    else { resultTime.style.display = 'none'; }
}

// ===================== SAVE =====================
let _saveTimer = null;

function saveCurrentEditor() {
    clearTimeout(_saveTimer);
    const ta = resultBody.querySelector('.result-editor');
    if (ta && state.activePageNum != null) {
        const page = state.pages.find(p => p.num === state.activePageNum);
        if (page) {
            page.ocr_text = ta.value;
            if (state.activeDocId) saveTextToServer(state.activeDocId, state.activePageNum, ta.value);
        }
    }
}

function saveTextToServer(docId, pageNum, text) {
    fetchT(`/api/pages/${docId}/${pageNum}/text`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text}),
    }, 10000).catch(e => { console.warn('Auto-save failed:', e); showToast('Auto-save failed', 'warn'); });
}

// ===================== FORMAT =====================
async function formatPage(pageNum) {
    const page = state.pages.find(p => p.num === pageNum);
    if (!page || !page.ocr_text) { showToast('请先进行OCR识别', 'warn'); return; }
    if (state.formatRunning) return;

    state.formatRunning = true;
    formatBtn.textContent = '格式化中...';
    formatBtn.disabled = true;

    // Show loading in render area
    const renderBody = resultBody.querySelector('.render-body');
    if (renderBody) renderBody.innerHTML = '<div class="result-loading"><div class="spinner"></div>格式化中，请稍候...</div>';

    try {
        const res = await fetchT(`/api/format/${state.activeDocId}/${pageNum}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                code_model: state.codeModel, 
                prompt_id: state.selectedFormatPromptId || null
            }),
        }, 300000);
        if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'Format failed'); }
        const data = await res.json();
        page.formatted_text = data.formatted_text;
        page.format_time = data.format_time;

        if (renderBody) renderLatex(renderBody, data.formatted_text);
        const ta = resultBody.querySelector('.result-editor');
        if (ta) ta.value = data.formatted_text;
        
        const lbl = buildTimeLabel(page.ocr_time, page.format_time);
        if (lbl) { resultTime.textContent = lbl; resultTime.style.display = ''; }
        updatePageThumbStatus(page);
        showToast('格式化完成', 'success', 2000);
    } catch (e) {
        if (renderBody) renderBody.innerHTML = `<div class="result-error">格式化失败: ${escHtml(e.message)}</div>`;
        showToast('格式化失败: ' + e.message, 'error');
    } finally {
        state.formatRunning = false;
        formatBtn.textContent = 'LaTeX 格式化 ▾';
        formatBtn.disabled = false;
    }
}

let _batchAbortController = null;

async function formatAllPages() {
    if (!state.activeDocId) return;
    const pagesToFmt = state.pages.filter(p => p.ocr_text);
    if (pagesToFmt.length === 0) { showToast('请先进行OCR识别', 'warn'); return; }

    state.formatRunning = true;
    formatBtn.textContent = '格式化中...';
    formatBtn.disabled = true;
    ocrProgress.style.display = '';
    ocrProgressBar.style.width = '0%';

    let done = 0;
    for (const page of pagesToFmt) {
        try {
            _batchAbortController = new AbortController();
            
            const res = await fetchT(`/api/format/${state.activeDocId}/${page.num}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    code_model: state.codeModel, 
                    prompt_id: state.selectedFormatPromptId || null
                }),
                signal: _batchAbortController.signal,
            }, 300000);
            if (!res.ok) throw new Error('Format failed');
            const data = await res.json();
            page.formatted_text = data.formatted_text;
            page.format_time = data.format_time;
            updatePageThumbStatus(page);

            if (state.activePageNum === page.num) {
                const renderBody = resultBody.querySelector('.render-body');
                if (renderBody) renderLatex(renderBody, data.formatted_text);
                const ta = resultBody.querySelector('.result-editor');
                if (ta) ta.value = data.formatted_text;
                const lbl = buildTimeLabel(page.ocr_time, page.format_time);
                if (lbl) { resultTime.textContent = lbl; resultTime.style.display = ''; }
            }
        } catch (e) {
            console.error(`[format] Page ${page.num}:`, e);
        }
        done++;
        ocrProgressBar.style.width = Math.round((done / pagesToFmt.length) * 100) + '%';
    }
    _batchAbortController = null;
    state.formatRunning = false;
    formatBtn.textContent = 'LaTeX 格式化 ▾';
    formatBtn.disabled = false;
    setTimeout(() => { ocrProgress.style.display = 'none'; ocrProgressBar.style.width = '0%'; }, 1500);
    showToast(`格式化完成 ${done}/${pagesToFmt.length} 页`, 'success', 2500);
}

// Format dropdown
formatBtn.addEventListener('click', e => { e.stopPropagation(); formatMenu.classList.toggle('show'); });
formatMenu.addEventListener('click', e => {
    const item = e.target.closest('.format-item');
    if (!item) return;
    formatMenu.classList.remove('show');
    if (item.dataset.action === 'page') formatPage(state.activePageNum);
    else if (item.dataset.action === 'all') formatAllPages();
});

// ===================== OCR =====================
function stopBatchOcr() {
    state.ocrAbort = true;
    if (_batchAbortController) _batchAbortController.abort();
    state.ocrRunning = false;
    ocrAllBtn.textContent = 'OCR All';
    ocrAllBtn.classList.remove('danger');
    ocrProgress.style.display = 'none';
}

function updatePageThumbStatus(page) {
    const el = pageList.querySelector(`.page-thumb[data-num="${page.num}"] .page-thumb-status`);
    if (!el) return;
    if (page.formatted_text != null) {
        el.className = 'page-thumb-status fmt';
        el.textContent = page.format_time ? `格式化 (${page.format_time}s)` : '已格式化';
    } else if (page.ocr_text != null) {
        el.className = 'page-thumb-status done';
        el.textContent = page.ocr_time ? `OCR (${page.ocr_time}s)` : 'OCR完成';
    }
}

// ===================== VIEW STATE =====================
function resetViewState() {
    state.activeDocId = null;
    state.activeDocFilename = null;
    state.pages = [];
    state.activePageNum = null;
    pageList.innerHTML = '';
    previewContainer.classList.remove('show');
    previewImage.src = '';
    resultBody.innerHTML = '<div class="result-placeholder">Select a page to view OCR result</div>';
    resultTime.style.display = 'none';
    resultToolbar.style.display = 'none';
}

// ===================== UPLOAD =====================
uploadZone.addEventListener('click', () => fileInput.click());
newFileBtn.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
    e.preventDefault(); uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
});
panelCenter.addEventListener('dragover', e => { e.preventDefault(); if (!uploadZone.classList.contains('hidden')) uploadZone.classList.add('dragover'); });
panelCenter.addEventListener('drop', e => {
    e.preventDefault(); uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length > 0) uploadFiles(fileInput.files); fileInput.value = ''; });

async function uploadFiles(fileList) {
    const formData = new FormData();
    const label = fileList.length === 1 ? fileList[0].name : `${fileList.length} files`;
    for (const f of fileList) formData.append('files', f);

    if (state.ocrRunning) stopBatchOcr();
    resetViewState();
    topFilename.textContent = `Uploading ${label}...`;

    try {
        const res = await fetchT('/api/upload', {method: 'POST', body: formData}, 120000);
        if (!res.ok) {
            let msg = 'Upload failed';
            try { const e = await res.json(); msg = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail); } catch {}
            throw new Error(msg);
        }
        await handleUploadStream(res);
    } catch (e) {
        topFilename.textContent = 'Upload failed: ' + e.message;
        showToast('Upload failed: ' + e.message, 'error');
        console.error(e);
    }
}

function initDoc(docId, filename) {
    state.activeDocId = docId;
    state.activeDocFilename = filename;
    state.pages = []; state.activePageNum = null;
    topFilename.textContent = filename;
    deleteDocBtn.style.display = '';
    pageList.innerHTML = '';
    panelLeft.classList.remove('hidden');
    panelRight.classList.remove('hidden');
    resizeHandle.classList.remove('hidden');
    uploadZone.classList.add('hidden');
    formatWrap.style.display = '';
    ocrAllBtn.style.display = '';
    exportWrap.style.display = '';
    copyAllBtn.style.display = '';
    searchWrap.style.display = '';
    clearSearch();
    updateDocItemActiveState();
}

function addPage(page) {
    state.pages.push(page);
    appendPageThumb(page);
}

async function handleUploadStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
            const line = part.split('\n').find(l => l.startsWith('data: '));
            if (!line) continue;
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'init') {
                initDoc(evt.doc_id, evt.filename);
                state.docs.unshift({doc_id: evt.doc_id, filename: evt.filename, page_count: 0, ocr_count: 0, created_at: new Date().toISOString()});
                renderDocList();
            } else if (evt.type === 'page') {
                addPage(evt.page);
                const docEntry = state.docs.find(d => d.doc_id === state.activeDocId);
                if (docEntry) {
                    docEntry.page_count = state.pages.length;
                    if (evt.page.ocr_text != null) docEntry.ocr_count++;
                    updateDocItemCounts(state.activeDocId, docEntry.page_count, docEntry.ocr_count);
                }
                if (state.pages.length === 1) selectPage(1);
            }
        }
    }
}

// ===================== PAGE THUMB =====================
function appendPageThumb(page) {
    const div = document.createElement('div');
    div.className = 'page-thumb' + (page.num === state.activePageNum ? ' active' : '');
    div.dataset.num = page.num;
    let sc = '', sl = 'Pending';
    if (page.formatted_text != null) { sc = 'fmt'; sl = `格式化 (${page.format_time || 0}s)`; }
    else if (page.ocr_text != null)  { sc = 'done'; sl = `OCR (${page.ocr_time || 0}s)`; }
    div.innerHTML = `
        <img src="${page.image_url}" alt="Page ${page.num}" loading="lazy">
        <div class="page-thumb-info">
            <div class="page-thumb-label">Page ${page.num}</div>
            <div class="page-thumb-status ${sc}">${sl}</div>
        </div>`;
    div.addEventListener('click', () => selectPage(page.num));
    pageList.appendChild(div);
}

function renderPageList() {
    pageList.innerHTML = '';
    state.pages.forEach(p => appendPageThumb(p));
}

// ===================== KEYBOARD NAV =====================
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    if (!state.activeDocId || !state.pages.length) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = state.pages.findIndex(p => p.num === state.activePageNum);
        if (idx > 0) selectPage(state.pages[idx - 1].num);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        const idx = state.pages.findIndex(p => p.num === state.activePageNum);
        if (idx < state.pages.length - 1) selectPage(state.pages[idx + 1].num);
    }
});

// ===================== SELECT PAGE =====================
async function selectPage(num) {
    saveCurrentEditor();
    state.activePageNum = num;
    pageList.querySelectorAll('.page-thumb').forEach(el => el.classList.toggle('active', parseInt(el.dataset.num) === num));
    const page = state.pages.find(p => p.num === num);
    if (!page) return;
    previewContainer.classList.add('show');
    previewImage.src = page.image_url;
    if (page.ocr_text != null) {
        showEditor(page.ocr_text, page.ocr_time, page.formatted_text, page.format_time);
        preOcrNext(num);
    } else {
        await runOcrForPage(page);
    }
}

// ===================== OCR =====================
async function runOcrForPage(page, force = false) {
    resultBody.innerHTML = `<div class="result-loading"><div class="spinner"></div>Recognizing page ${page.num}...</div>`;
    resultTime.style.display = 'none';
    const thumbStatus = pageList.querySelector(`.page-thumb[data-num="${page.num}"] .page-thumb-status`);
    if (thumbStatus) { thumbStatus.className = 'page-thumb-status running'; thumbStatus.textContent = 'Running...'; }

    try {
        const params = new URLSearchParams();
        if (state.ocrModel)           params.set('model', state.ocrModel);
        if (state.selectedOcrPromptId) params.set('prompt_id', state.selectedOcrPromptId);
        if (force)                     params.set('force', 'true');
        
        const res = await fetchT(`/api/ocr/${state.activeDocId}/${page.num}?${params}`, {method: 'POST'}, 120000);
        if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'OCR failed'); }
        const data = await res.json();
        
        page.ocr_text = data.text;
        page.ocr_time = data.time;
        // If we force rescan, we clear the previous formatting result
        if (force) {
            page.formatted_text = null;
            page.format_time = null;
        }
        
        if (thumbStatus) { thumbStatus.className = 'page-thumb-status done'; thumbStatus.textContent = `OCR (${data.time}s)`; }
        if (state.activePageNum === page.num) showEditor(data.text, data.time, page.formatted_text, page.format_time);
        updateDocOcrCount();
        preOcrNext(page.num);
    } catch (e) {
        const isTimeout = e.name === 'AbortError';
        if (thumbStatus) { thumbStatus.className = 'page-thumb-status error'; thumbStatus.textContent = isTimeout ? 'Timeout' : 'Error'; }
        if (state.activePageNum === page.num) {
            resultBody.innerHTML = `<div class="result-error">${isTimeout ? 'OCR timed out — retry?' : `OCR failed: ${escHtml(e.message)}`}</div>`;
        }
        if (isTimeout) showToast('OCR timed out — retry?', 'error');
    }
}

let _preOcrRunning = false;
async function preOcrNext(currentNum) {
    if (_preOcrRunning || state.ocrRunning || !state.modelLoaded) return;
    const idx = state.pages.findIndex(p => p.num === currentNum);
    if (idx < 0 || idx >= state.pages.length - 1) return;
    const next = state.pages[idx + 1];
    if (next.ocr_text != null) return;
    _preOcrRunning = true;
    const thumbStatus = pageList.querySelector(`.page-thumb[data-num="${next.num}"] .page-thumb-status`);
    if (thumbStatus) { thumbStatus.className = 'page-thumb-status running'; thumbStatus.textContent = 'Pre-OCR...'; }
    try {
        const params = new URLSearchParams();
        if (state.ocrModel) params.set('model', state.ocrModel);
        if (state.selectedOcrPromptId) params.set('prompt_id', state.selectedOcrPromptId);
        const res = await fetchT(`/api/ocr/${state.activeDocId}/${next.num}?${params}`, {method: 'POST'}, 120000);
        if (!res.ok) throw new Error('Pre-OCR failed');
        const data = await res.json();
        next.ocr_text = data.text;
        next.ocr_time = data.time;
        if (thumbStatus) { thumbStatus.className = 'page-thumb-status done'; thumbStatus.textContent = `OCR (${data.time}s)`; }
        updateDocOcrCount();
        if (state.activePageNum === next.num) showEditor(data.text, data.time, next.formatted_text, next.format_time);
    } catch {
        if (thumbStatus) { thumbStatus.className = 'page-thumb-status'; thumbStatus.textContent = 'Pending'; }
    } finally { _preOcrRunning = false; }
}

// OCR All
ocrAllBtn.addEventListener('click', async () => {
    if (!state.activeDocId) return;
    if (state.ocrRunning) { stopBatchOcr(); return; }
    state.ocrRunning = true; state.ocrAbort = false;
    ocrAllBtn.textContent = 'Stop'; ocrAllBtn.classList.add('danger');
    const pending = state.pages.filter(p => p.ocr_text == null);
    let done = 0, totalTime = 0;
    ocrProgress.style.display = ''; ocrProgressBar.style.width = '0%';
    for (const page of state.pages) {
        if (state.ocrAbort) break;
        if (page.ocr_text != null) continue;
        const eta = done > 0 ? Math.round((totalTime / done) * (pending.length - done)) + 's' : '';
        ocrAllBtn.textContent = `Stop ${done}/${pending.length}` + (eta ? ` ~${eta}` : '');
        const thumbStatus = pageList.querySelector(`.page-thumb[data-num="${page.num}"] .page-thumb-status`);
        if (thumbStatus) { thumbStatus.className = 'page-thumb-status running'; thumbStatus.textContent = 'Running...'; }
        if (state.activePageNum === page.num) { resultBody.innerHTML = `<div class="result-loading"><div class="spinner"></div>Recognizing page ${page.num}...</div>`; resultTime.style.display = 'none'; }
        _batchAbortController = new AbortController();
        try {
            const params = new URLSearchParams();
            if (state.ocrModel) params.set('model', state.ocrModel);
            if (state.selectedOcrPromptId) params.set('prompt_id', state.selectedOcrPromptId);
            const res = await fetchT(`/api/ocr/${state.activeDocId}/${page.num}?${params}`, {method: 'POST', signal: _batchAbortController.signal}, 120000);
            if (!res.ok) { const e = await res.json(); throw new Error(e.detail || 'OCR failed'); }
            const data = await res.json();
            page.ocr_text = data.text; page.ocr_time = data.time;
            done++; totalTime += data.time || 0;
            ocrProgressBar.style.width = Math.round((done / pending.length) * 100) + '%';
            if (thumbStatus) { thumbStatus.className = 'page-thumb-status done'; thumbStatus.textContent = `OCR (${data.time}s)`; }
            if (state.activePageNum === page.num) showEditor(data.text, data.time, page.formatted_text, page.format_time);
            updateDocOcrCount();
        } catch (e) {
            if (state.ocrAbort) { if (thumbStatus) { thumbStatus.className = 'page-thumb-status'; thumbStatus.textContent = 'Pending'; } break; }
            done++; ocrProgressBar.style.width = Math.round((done / pending.length) * 100) + '%';
            if (thumbStatus) { thumbStatus.className = 'page-thumb-status error'; thumbStatus.textContent = 'Error'; }
        }
    }
    _batchAbortController = null;
    state.ocrRunning = false; state.ocrAbort = false;
    ocrAllBtn.textContent = 'OCR All'; ocrAllBtn.classList.remove('danger');
    setTimeout(() => { ocrProgress.style.display = 'none'; ocrProgressBar.style.width = '0%'; }, 1500);
});

// Re-scan
rescanBtn.addEventListener('click', async () => {
    const page = state.pages.find(p => p.num === state.activePageNum);
    if (!page || !state.activeDocId || state.ocrRunning) return;
    await runOcrForPage(page, true);
});

// ===================== COPY / EXPORT =====================
copyPageBtn.addEventListener('click', () => {
    saveCurrentEditor();
    const page = state.pages.find(p => p.num === state.activePageNum);
    if (!page) return;
    const text = page.formatted_text || page.ocr_text;
    if (text) {
        navigator.clipboard.writeText(text);
        copyPageBtn.textContent = 'Copied!';
        setTimeout(() => copyPageBtn.textContent = 'Copy', 1500);
    }
});

copyAllBtn.addEventListener('click', () => {
    saveCurrentEditor();
    const text = buildAllText();
    if (text) {
        navigator.clipboard.writeText(text);
        copyAllBtn.textContent = 'Copied!';
        setTimeout(() => copyAllBtn.textContent = 'Copy All', 1500);
    }
});

function buildAllText() {
    const pages = state.pages.filter(p => p.formatted_text || p.ocr_text);
    if (!pages.length) return '';
    if (state.pages.length === 1) return state.pages[0].formatted_text || state.pages[0].ocr_text || '';
    return state.pages.map(p => `--- Page ${p.num} ---\n\n${p.formatted_text || p.ocr_text || '(not recognized)'}`).join('\n\n\n');
}

// Export dropdown
exportBtn.addEventListener('click', e => { e.stopPropagation(); exportMenu.classList.toggle('show'); });
exportMenu.addEventListener('click', async e => {
    const item = e.target.closest('.export-item');
    if (!item) return;
    e.stopPropagation(); exportMenu.classList.remove('show');
    if (item.dataset.fmt === 'tex') {
        saveCurrentEditor();
        const baseName = (state.activeDocFilename || 'document').replace(/\.[^.]+$/, '');
        try {
            const res = await fetchT(`/api/export-tex/${state.activeDocId}`, {method: 'POST'}, 30000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            downloadBlob(await res.blob(), baseName + '.tex');
        } catch (e) { showToast('Export failed: ' + e.message, 'error'); }
    }
});

// Close dropdowns on outside click
document.addEventListener('click', () => {
    exportMenu.classList.remove('show');
    formatMenu.classList.remove('show');
});

// ===================== SEARCH =====================
let _searchMatches = [], _searchIdx = -1, _searchQuery = '';

function openSearch() { searchInput.classList.add('open'); searchToggle.classList.add('active'); searchInput.focus(); searchInput.select(); }

searchToggle.addEventListener('click', () => {
    if (searchInput.classList.contains('open')) clearSearch();
    else openSearch();
});
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f' && state.activeDocId) { e.preventDefault(); openSearch(); }
    if (e.key === 'Escape' && document.activeElement === searchInput) clearSearch();
});
searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    if (!q) { clearSearch(true); return; }
    runSearch(q);
});
searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); navSearch(e.shiftKey ? -1 : 1); }
});
searchPrev.addEventListener('click', () => navSearch(-1));
searchNext.addEventListener('click', () => navSearch(1));

function runSearch(query) {
    _searchQuery = query; _searchMatches = [];
    const lower = query.toLowerCase();
    for (const page of state.pages) {
        const text = ((page.formatted_text || page.ocr_text) || '').toLowerCase();
        let count = 0, idx = 0;
        while ((idx = text.indexOf(lower, idx)) !== -1) { count++; idx += lower.length; }
        if (count > 0) _searchMatches.push({pageNum: page.num, count});
    }
    updateSearchBadges();
    const total = _searchMatches.reduce((s, m) => s + m.count, 0);
    if (_searchMatches.length > 0) {
        searchInfo.textContent = `${_searchMatches.length} pages · ${total} hits`;
        searchPrev.disabled = false; searchNext.disabled = false;
        const onMatch = _searchMatches.find(m => m.pageNum === state.activePageNum);
        if (!onMatch) { _searchIdx = 0; selectPage(_searchMatches[0].pageNum); }
        else { _searchIdx = _searchMatches.findIndex(m => m.pageNum === state.activePageNum); }
    } else {
        searchInfo.textContent = 'No results';
        searchPrev.disabled = true; searchNext.disabled = true; _searchIdx = -1;
    }
}

function navSearch(dir) {
    if (!_searchMatches.length) return;
    _searchIdx = (_searchIdx + dir + _searchMatches.length) % _searchMatches.length;
    searchInfo.textContent = `${_searchIdx + 1}/${_searchMatches.length} pages`;
    selectPage(_searchMatches[_searchIdx].pageNum);
}

function clearSearch(keepOpen) {
    _searchQuery = ''; _searchMatches = []; _searchIdx = -1;
    searchInfo.textContent = ''; searchPrev.disabled = true; searchNext.disabled = true;
    if (!keepOpen) { searchInput.value = ''; searchInput.classList.remove('open'); searchToggle.classList.remove('active'); searchInput.blur(); }
    updateSearchBadges();
}

function updateSearchBadges() {
    pageList.querySelectorAll('.page-thumb').forEach(el => {
        const num = parseInt(el.dataset.num);
        const match = _searchMatches.find(m => m.pageNum === num);
        const badge = el.querySelector('.search-badge');
        if (_searchQuery) {
            el.classList.toggle('search-miss', !match);
            if (match) {
                if (!badge) { const b = document.createElement('span'); b.className = 'search-badge'; b.textContent = match.count; el.querySelector('.page-thumb-label').appendChild(b); }
                else badge.textContent = match.count;
            } else if (badge) badge.remove();
        } else {
            el.classList.remove('search-miss');
            if (badge) badge.remove();
        }
    });
}

// ===================== FORMAT TIME ETA =====================
function formatEta(seconds) {
    if (seconds < 60) return Math.round(seconds) + 's';
    return Math.floor(seconds / 60) + 'm' + Math.round(seconds % 60).toString().padStart(2, '0') + 's';
}

// ===================== DOC LIST =====================
docListHeader.addEventListener('click', e => {
    if (e.target.closest('.doc-item-delete')) return;
    docListSection.classList.toggle('collapsed');
});

function renderDocList() {
    docList.innerHTML = '';
    docListCount.textContent = state.docs.length ? `(${state.docs.length})` : '';
    const showList = state.docs.length > 1;
    docListSection.style.display = showList ? '' : 'none';
    docListSection.nextElementSibling.style.display = showList ? '' : 'none';
    for (const doc of state.docs) {
        const div = document.createElement('div');
        div.className = 'doc-item' + (doc.doc_id === state.activeDocId ? ' active' : '');
        div.dataset.docId = doc.doc_id;
        const badge = doc.page_count > 0 ? `${doc.ocr_count || 0}/${doc.page_count}` : '';
        div.innerHTML = `
            <div class="doc-item-info">
                <div class="doc-item-name" title="${escHtml(doc.filename)}">${escHtml(doc.filename)}</div>
                <div class="doc-item-meta"><span>${doc.page_count} page${doc.page_count !== 1 ? 's' : ''}</span>${badge ? `<span class="doc-item-badge">${badge}</span>` : ''}</div>
            </div>
            <button class="doc-item-delete" title="Delete">&times;</button>`;
        div.addEventListener('click', e => { if (e.target.closest('.doc-item-delete')) return; if (doc.doc_id !== state.activeDocId) switchDocument(doc.doc_id); });
        div.querySelector('.doc-item-delete').addEventListener('click', e => { e.stopPropagation(); deleteDocument(doc.doc_id, doc.filename); });
        docList.appendChild(div);
    }
}

function updateDocItemActiveState() {
    docList.querySelectorAll('.doc-item').forEach(el => el.classList.toggle('active', el.dataset.docId === state.activeDocId));
}

function updateDocItemCounts(docId, pageCount, ocrCount) {
    const entry = state.docs.find(d => d.doc_id === docId);
    if (!entry) return;
    if (pageCount !== undefined) entry.page_count = pageCount;
    if (ocrCount !== undefined) entry.ocr_count = ocrCount;
    const el = docList.querySelector(`.doc-item[data-doc-id="${docId}"]`);
    if (!el) return;
    const meta = el.querySelector('.doc-item-meta');
    if (meta) {
        const badge = entry.page_count > 0 ? `${entry.ocr_count || 0}/${entry.page_count}` : '';
        meta.innerHTML = `<span>${entry.page_count} page${entry.page_count !== 1 ? 's' : ''}</span>${badge ? `<span class="doc-item-badge">${badge}</span>` : ''}`;
    }
}

function updateDocOcrCount() {
    if (!state.activeDocId) return;
    updateDocItemCounts(state.activeDocId, undefined, state.pages.filter(p => p.ocr_text != null).length);
}

async function fetchDocList() {
    try {
        const res = await fetchT('/api/documents', {}, 10000);
        if (!res.ok) return;
        state.docs = await res.json();
        renderDocList();
    } catch { /* silent */ }
}

async function switchDocument(docId) {
    if (state.ocrRunning) stopBatchOcr();
    saveCurrentEditor();
    try {
        const res = await fetchT(`/api/documents/${docId}`, {}, 10000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = await res.json();
        initDoc(detail.doc_id, detail.filename);
        for (const p of detail.pages) addPage(p);
        if (detail.pages.length) selectPage(detail.pages[0].num);
    } catch (e) { showToast('Failed to load document', 'error'); console.error(e); }
}

async function deleteDocument(docId, filename) {
    if (!confirm(`Delete "${filename}"?`)) return;
    try {
        await fetchT(`/api/documents/${docId}`, {method: 'DELETE'}, 10000);
    } catch { showToast('Delete failed', 'error'); return; }
    state.docs = state.docs.filter(d => d.doc_id !== docId);
    renderDocList();
    if (docId === state.activeDocId) {
        if (state.docs.length > 0) {
            await switchDocument(state.docs[0].doc_id);
        } else {
            resetViewState();
            topFilename.textContent = 'No document';
            deleteDocBtn.style.display = 'none';
            panelLeft.classList.add('hidden');
            panelRight.classList.add('hidden');
            resizeHandle.classList.add('hidden');
            uploadZone.classList.remove('hidden');
            formatWrap.style.display = 'none';
            ocrAllBtn.style.display = 'none';
            exportWrap.style.display = 'none';
            copyAllBtn.style.display = 'none';
            searchWrap.style.display = 'none';
        }
    }
}

deleteDocBtn.addEventListener('click', () => {
    if (state.activeDocId) deleteDocument(state.activeDocId, state.activeDocFilename || 'this document');
});

// ===================== RESTORE ON LOAD =====================
async function restoreLastDocument() {
    try {
        await fetchDocList();
        if (!state.docs.length) return;
        panelLeft.classList.remove('hidden');
        const latest = state.docs[0];
        const res = await fetchT(`/api/documents/${latest.doc_id}`, {}, 10000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = await res.json();
        initDoc(detail.doc_id, detail.filename);
        for (const p of detail.pages) addPage(p);
        if (detail.pages.length) selectPage(detail.pages[0].num);
    } catch (e) { console.warn('Restore failed:', e); }
}

// ===================== INIT =====================
fetchModels();
fetchPrompts();
restoreLastDocument();