// Ozon Seller Content Script (Reviews Auto-Reply & Bulk Rich-Content Filler)

(function() {
    if (window.__optExtSellerScriptLoaded) {
        console.log('[opt-ext] Скрипт Ozon Seller уже загружен, пропускаю повторную инициализацию.');
        return;
    }
    window.__optExtSellerScriptLoaded = true;

    // Helper functions
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function cleanRichContentText(text) {
        if (!text) return '';
        let result = text;
        // Replace <br>, <br/>, <br />, &lt;br/&gt;, &lt;br&gt; with \n
        result = result.replace(/(&lt;|<)br\s*\/?>?(&gt;|>)/gi, '\n');
        // Replace block end tags like </p>, </div>, </li>, </tr>, &lt;/p&gt; etc. with \n
        result = result.replace(/(&lt;|<)\/(p|div|li|tr|h[1-6])(&gt;|>)/gi, '\n');
        // Decode common HTML entities
        result = result.replace(/&nbsp;/gi, ' ')
                       .replace(/&quot;/gi, '"')
                       .replace(/&apos;|&#39;/gi, "'")
                       .replace(/&lt;/gi, '<')
                       .replace(/&gt;/gi, '>')
                       .replace(/&amp;/gi, '&');
        // Remove any remaining HTML tags if present
        result = result.replace(/<[^>]+>/g, '');
        // Normalize line breaks
        result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        // Reduce 3 or more consecutive newlines to 2 newlines
        result = result.replace(/\n{3,}/g, '\n\n');
        // Trim each line and join back with \n
        return result.split('\n').map(line => line.trim()).join('\n').trim();
    }

    function setNativeValue(element, value) {
        const proto = Object.getPrototypeOf(element);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function realDblClick(el) {
        const rect1 = el.getBoundingClientRect();
        const opts1 = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect1.left + rect1.width / 2,
            clientY: rect1.top + rect1.height / 2,
            detail: 1
        };

        // Click 1: mousedown -> mouseup -> click
        el.dispatchEvent(new MouseEvent('mousedown', opts1));
        el.dispatchEvent(new MouseEvent('mouseup', opts1));
        el.dispatchEvent(new MouseEvent('click', opts1));

        // Pause ~200ms between separate clicks
        await sleep(200);

        const rect2 = el.getBoundingClientRect();
        const opts2 = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect2.left + rect2.width / 2,
            clientY: rect2.top + rect2.height / 2,
            detail: 2
        };

        // Click 2: mousedown -> mouseup -> click (+ dblclick)
        el.dispatchEvent(new MouseEvent('mousedown', opts2));
        el.dispatchEvent(new MouseEvent('mouseup', opts2));
        el.dispatchEvent(new MouseEvent('click', opts2));
        el.dispatchEvent(new MouseEvent('dblclick', opts2));
    }

    // =========================================================================
    // MODULE 1: Reviews Auto-Reply (seller.ozon.ru/app/reviews*)
    // =========================================================================

    let rowStates = new Map();
    let overlayElements = new Map();
    let savedTemplates = [];
    let replySettings = { delayEnabled: false, minDelay: 2, maxDelay: 5 };
    let isRunning = false;
    let failedReplies = [];

    let observer = null;
    let overlayContainer = null;
    let checkAllWrapper = null;
    let bulkSelectWrapper = null;
    let isRepositioning = false;

    let floatBtnContainer = null;
    let floatBtn = null;

    function initReviewsAutoReply() {
        if (document.getElementById('opt-ext-float-container')) return;

        chrome.storage.local.get(['ozonReplyTemplates', 'ozonReplySettings'], (result) => {
            if (result.ozonReplyTemplates) {
                savedTemplates = result.ozonReplyTemplates;
            }
            if (result.ozonReplySettings) {
                replySettings = result.ozonReplySettings;
            }
            initReviewsUI();
        });
    }

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.ozonReplyTemplates) {
                savedTemplates = changes.ozonReplyTemplates.newValue || [];
                updateAllDropdowns();
                requestReposition();
            }
            if (changes.ozonReplySettings) {
                replySettings = changes.ozonReplySettings.newValue || { delayEnabled: false, minDelay: 2, maxDelay: 5 };
            }
        }
    });

    function initReviewsUI() {
        if (document.getElementById('opt-ext-float-container')) return;

        // 1. Floating panel
        floatBtnContainer = document.createElement('div');
        floatBtnContainer.id = 'opt-ext-float-container';
        floatBtnContainer.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 10px;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
        `;

        floatBtn = document.createElement('button');
        floatBtn.id = 'opt-ext-submit-btn';
        floatBtn.textContent = 'Отправить ответы (0)';
        floatBtn.disabled = true;
        floatBtn.style.cssText = `
            background: linear-gradient(135deg, #005bff, #003db3);
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 8px;
            font-weight: bold;
            font-size: 14px;
            box-shadow: 0 4px 15px rgba(0, 91, 255, 0.3);
            cursor: pointer;
            transition: all 0.2s ease;
        `;

        floatBtn.addEventListener('click', handleFloatBtnClick);
        floatBtnContainer.appendChild(floatBtn);
        document.body.appendChild(floatBtnContainer);

        // 2. Overlay container
        overlayContainer = document.createElement('div');
        overlayContainer.id = 'opt-ext-checkbox-overlay';
        overlayContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible; z-index: 9998; pointer-events: none;';
        document.body.appendChild(overlayContainer);

        // 3. Select-all checkbox wrapper
        checkAllWrapper = document.createElement('div');
        checkAllWrapper.id = 'opt-ext-check-all-wrapper';
        checkAllWrapper.style.cssText = 'position: absolute; display: none; z-index: 9999; pointer-events: none; box-sizing: border-box;';
        
        const selectAllCheck = document.createElement('input');
        selectAllCheck.type = 'checkbox';
        selectAllCheck.className = 'opt-ext-reply-checkbox-all';
        selectAllCheck.style.cssText = 'cursor: pointer; transform: scale(1.2); pointer-events: auto;';
        selectAllCheck.addEventListener('change', handleSelectAllChange);
        checkAllWrapper.appendChild(selectAllCheck);
        overlayContainer.appendChild(checkAllWrapper);

        // 4. Bulk select dropdown wrapper
        bulkSelectWrapper = document.createElement('div');
        bulkSelectWrapper.id = 'opt-ext-bulk-select-wrapper';
        bulkSelectWrapper.style.cssText = 'position: absolute; display: none; z-index: 9999; pointer-events: none; box-sizing: border-box;';

        const bulkSelect = document.createElement('select');
        bulkSelect.className = 'opt-ext-bulk-template-select';
        bulkSelect.style.cssText = `
            padding: 4px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 11px;
            outline: none;
            width: 100px;
            background: white;
            pointer-events: auto;
        `;
        bulkSelect.addEventListener('change', handleBulkSelectChange);
        bulkSelectWrapper.appendChild(bulkSelect);
        overlayContainer.appendChild(bulkSelectWrapper);

        // Position on window events
        window.addEventListener('resize', requestReposition);
        window.addEventListener('scroll', requestReposition, true);

        // Observe DOM changes
        observer = new MutationObserver((mutations) => {
            const hasExternalMutations = mutations.some(mut => {
                const target = mut.target;
                if (!target || typeof target.closest !== 'function') return true;
                return !target.closest('#opt-ext-checkbox-overlay') && !target.closest('#opt-ext-float-container');
            });
            if (hasExternalMutations) {
                detectColumnIndices();
                requestReposition();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        detectColumnIndices();
        requestReposition();
        populateBulkSelect();
    }

    function updateFloatBtn() {
        if (!floatBtn) return;

        if (isRunning) {
            floatBtn.textContent = 'Остановить';
            floatBtn.disabled = false;
            floatBtn.style.background = '#dc3545';
            floatBtn.style.boxShadow = '0 4px 15px rgba(220, 53, 69, 0.3)';
        } else {
            const count = getQueueItems().length;
            floatBtn.textContent = `Отправить ответы (${count})`;
            floatBtn.disabled = count === 0;
            floatBtn.style.background = count > 0 
                ? 'linear-gradient(135deg, #005bff, #003db3)' 
                : '#cccccc';
            floatBtn.style.boxShadow = count > 0 
                ? '0 4px 15px rgba(0, 91, 255, 0.3)' 
                : 'none';
        }
    }

    function getQueueItems() {
        return Array.from(rowStates.entries())
            .filter(([_, state]) => state.checked && state.templateId && state.repliesCount === 0)
            .map(([rowId, state]) => ({ rowId, ...state }));
    }

    let reviewColIndex = -1;
    let repliesColIndex = -1;
    let productColIndex = -1;
    let dateColIndex = -1;
    let registeredScrollParents = new Set();

    function findHeaderTable() {
        const tables = document.querySelectorAll('table');
        for (let table of tables) {
            const headers = Array.from(table.querySelectorAll('thead th'));
            let hasReview = false;
            let hasProduct = false;
            
            headers.forEach(th => {
                const text = th.textContent.trim().toLowerCase();
                if (text.includes('отзыв')) hasReview = true;
                if (text.includes('товар') || text.includes('название') || text.includes('артикул')) hasProduct = true;
            });
            
            if (hasReview && hasProduct) {
                return table;
            }
        }
        return null;
    }

    function findRowsTable() {
        const tables = document.querySelectorAll('table');
        for (let table of tables) {
            const tbody = table.querySelector('tbody');
            if (tbody) {
                const trs = tbody.querySelectorAll('tr');
                for (let tr of trs) {
                    if (tr.querySelector('img')) {
                        return table;
                    }
                }
            }
        }
        const headerTable = findHeaderTable();
        for (let table of tables) {
            if (table === headerTable) continue;
            const tbody = table.querySelector('tbody');
            if (tbody && tbody.querySelectorAll('tr').length > 0) {
                return table;
            }
        }
        return null;
    }

    function registerScrollParentListener(table) {
        if (!table) return;
        let parent = table.parentElement;
        while (parent && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
                if (!registeredScrollParents.has(parent)) {
                    parent.addEventListener('scroll', requestReposition);
                    registeredScrollParents.add(parent);
                }
            }
            parent = parent.parentElement;
        }
    }

    function detectColumnIndices() {
        const table = findHeaderTable();
        if (!table) return;

        const ths = table.querySelectorAll('thead th');
        const headers = Array.from(ths);
        if (headers.length > 0) {
            let currentCellIndex = 0;
            headers.forEach((th) => {
                const text = th.textContent.trim().toLowerCase();
                const colspan = parseInt(th.getAttribute('colspan') || '1', 10) || 1;
                
                if (text === 'отзыв') {
                    reviewColIndex = currentCellIndex;
                } else if (text === 'ответы' || text === 'ответ') {
                    repliesColIndex = currentCellIndex;
                } else if (text === 'название товара' || text === 'товар') {
                    productColIndex = currentCellIndex;
                } else if (text === 'дата публикации' || text === 'дата') {
                    dateColIndex = currentCellIndex;
                }
                
                currentCellIndex += colspan;
            });
        }
    }

    function requestReposition() {
        if (isRepositioning) return;
        isRepositioning = true;
        requestAnimationFrame(() => {
            repositionOverlay();
            isRepositioning = false;
        });
    }

    function repositionOverlay() {
        const headerTable = findHeaderTable();
        const rowsTable = findRowsTable();
        
        if (rowsTable) {
            registerScrollParentListener(rowsTable);
        }

        if (!rowsTable || !overlayContainer) {
            if (checkAllWrapper) checkAllWrapper.style.display = 'none';
            overlayElements.forEach(elPair => {
                elPair.checkWrapper.style.display = 'none';
                elPair.selectWrapper.style.display = 'none';
            });
            return;
        }

        const firstTh = headerTable ? headerTable.querySelector('thead th') : null;
        if (firstTh && checkAllWrapper && bulkSelectWrapper) {
            const thRect = firstTh.getBoundingClientRect();
            const checkWidth = 32;
            const dropdownWidth = 90;
            const gap = 6;

            let checkLeft = thRect.left - checkWidth - gap + window.scrollX;
            if (checkLeft < window.scrollX) {
                checkLeft = thRect.right + window.scrollX;
            }

            checkAllWrapper.style.left = `${checkLeft}px`;
            checkAllWrapper.style.top = `${thRect.top + window.scrollY}px`;
            checkAllWrapper.style.width = `${checkWidth}px`;
            checkAllWrapper.style.height = `${thRect.height}px`;
            checkAllWrapper.style.display = 'flex';
            checkAllWrapper.style.cssText += `
                align-items: center;
                justify-content: center;
                background: #e3efff;
                border-right: 1px dashed #c0d6ff;
            `;

            const dropdownLeft = checkLeft + checkWidth + gap;
            bulkSelectWrapper.style.left = `${dropdownLeft}px`;
            bulkSelectWrapper.style.top = `${thRect.top + window.scrollY}px`;
            bulkSelectWrapper.style.width = `${dropdownWidth}px`;
            bulkSelectWrapper.style.height = `${thRect.height}px`;
            bulkSelectWrapper.style.display = 'flex';
            bulkSelectWrapper.style.cssText += `
                align-items: center;
                justify-content: center;
            `;
        } else {
            if (checkAllWrapper) checkAllWrapper.style.display = 'none';
            if (bulkSelectWrapper) bulkSelectWrapper.style.display = 'none';
        }

        const rows = rowsTable.querySelectorAll('tbody > tr');
        const visibleRowIds = new Set();

        rows.forEach((tr, i) => {
            try {
                const cells = tr.querySelectorAll('td');
                if (cells.length === 0) return;

                const rowData = getRowData(tr, i);
                if (!rowData) return;

                const firstTd = cells[0];
                const lastTd = cells[cells.length - 1];

                visibleRowIds.add(rowData.rowId);

                if (!rowStates.has(rowData.rowId)) {
                    rowStates.set(rowData.rowId, {
                        checked: false,
                        templateId: '',
                        templateText: '',
                        repliesCount: rowData.repliesCount
                    });
                } else {
                    const st = rowStates.get(rowData.rowId);
                    if (st.repliesCount !== rowData.repliesCount) {
                        st.repliesCount = rowData.repliesCount;
                        if (rowData.repliesCount > 0) {
                            st.checked = false;
                        }
                    }
                }

                const state = rowStates.get(rowData.rowId);

                let elPair = overlayElements.get(rowData.rowId);
                if (!elPair) {
                    elPair = createRowOverlayElements(rowData.rowId);
                    overlayElements.set(rowData.rowId, elPair);
                }

                const checkInput = elPair.checkWrapper.querySelector('.opt-ext-reply-checkbox');
                if (checkInput) {
                    checkInput.checked = state.checked;
                    checkInput.disabled = rowData.repliesCount > 0;
                }

                const select = elPair.selectWrapper.querySelector('.opt-ext-template-select');
                if (select) {
                    select.value = state.templateId;
                    select.disabled = !state.checked;
                }

                if (firstTd) {
                    const firstTdRect = firstTd.getBoundingClientRect();
                    const checkWidth = 40;
                    const gap = 8;
                    let checkLeft = firstTdRect.left - checkWidth - gap + window.scrollX;
                    if (checkLeft < window.scrollX) {
                        checkLeft = firstTdRect.right + window.scrollX;
                    }
                    elPair.checkWrapper.style.left = `${checkLeft}px`;
                    elPair.checkWrapper.style.top = `${firstTdRect.top + window.scrollY}px`;
                    elPair.checkWrapper.style.width = `${checkWidth}px`;
                    elPair.checkWrapper.style.height = `${firstTdRect.height}px`;
                    elPair.checkWrapper.style.display = 'flex';
                } else {
                    elPair.checkWrapper.style.display = 'none';
                }

                if (lastTd) {
                    const lastTdRect = lastTd.getBoundingClientRect();
                    const dropdownWidth = 140;
                    elPair.selectWrapper.style.left = `${lastTdRect.right - dropdownWidth + window.scrollX}px`;
                    elPair.selectWrapper.style.top = `${lastTdRect.top + window.scrollY}px`;
                    elPair.selectWrapper.style.width = `${dropdownWidth}px`;
                    elPair.selectWrapper.style.height = `${lastTdRect.height}px`;

                    if (rowData.repliesCount > 0) {
                        elPair.selectWrapper.style.display = 'flex';
                        if (select) select.style.display = 'none';
                        let span = elPair.selectWrapper.querySelector('.opt-ext-replied-span');
                        if (!span) {
                            span = document.createElement('span');
                            span.className = 'opt-ext-replied-span';
                            span.textContent = 'Уже отвечено';
                            span.style.cssText = 'color: #888; font-size: 12px; font-style: italic; margin-right: 10px;';
                            elPair.selectWrapper.appendChild(span);
                        }
                    } else {
                        let span = elPair.selectWrapper.querySelector('.opt-ext-replied-span');
                        if (span) span.remove();
                        if (select) select.style.display = 'block';
                        elPair.selectWrapper.style.display = state.checked ? 'flex' : 'none';
                    }
                } else {
                    elPair.selectWrapper.style.display = 'none';
                }
            } catch (e) {
                console.error(`[opt-ext] Ошибка на строке ${i}:`, e);
            }
        });

        overlayElements.forEach((elPair, rowId) => {
            if (!visibleRowIds.has(rowId)) {
                elPair.checkWrapper.style.display = 'none';
                elPair.selectWrapper.style.display = 'none';
            }
        });

        updateSelectAllState();
        updateFloatBtn();
    }

    function createRowOverlayElements(rowId) {
        const checkWrapper = document.createElement('div');
        checkWrapper.className = 'opt-ext-checkbox-wrapper';
        checkWrapper.style.cssText = `
            position: absolute;
            display: none;
            align-items: center;
            justify-content: center;
            background: rgba(240, 245, 255, 0.95);
            border-right: 1px dashed #c0d6ff;
            pointer-events: none;
            z-index: 9999;
        `;

        const checkInput = document.createElement('input');
        checkInput.type = 'checkbox';
        checkInput.className = 'opt-ext-reply-checkbox';
        checkInput.style.cssText = 'cursor: pointer; transform: scale(1.1); pointer-events: auto;';
        checkInput.addEventListener('change', (e) => {
            const state = rowStates.get(rowId);
            if (state) {
                state.checked = e.target.checked;
                if (!state.checked) {
                    state.templateId = '';
                    state.templateText = '';
                }
                requestReposition();
            }
        });
        checkWrapper.appendChild(checkInput);
        overlayContainer.appendChild(checkWrapper);

        const selectWrapper = document.createElement('div');
        selectWrapper.className = 'opt-ext-select-wrapper';
        selectWrapper.style.cssText = `
            position: absolute;
            display: none;
            align-items: center;
            justify-content: flex-end;
            padding-right: 10px;
            pointer-events: none;
            z-index: 9999;
            box-sizing: border-box;
        `;

        const select = document.createElement('select');
        select.className = 'opt-ext-template-select';
        select.style.cssText = `
            padding: 6px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 12px;
            outline: none;
            width: 130px;
            background: white;
            pointer-events: auto;
        `;
        populateSelect(select, rowId);
        select.addEventListener('change', (e) => handleSelectChange(e, rowId));
        selectWrapper.appendChild(select);
        overlayContainer.appendChild(selectWrapper);

        return { checkWrapper, selectWrapper };
    }

    function getReviewTextElement(reviewCell) {
        if (!reviewCell) return null;
        const candidates = Array.from(reviewCell.querySelectorAll('[title]'));
        const found = candidates.find(c => {
            const tag = c.tagName.toLowerCase();
            if (tag === 'img' || tag === 'svg' || tag === 'button') return false;
            if (c.querySelector('img') || c.querySelector('svg')) return false;
            if (c.closest('[class*="media"]') || c.closest('[class*="photo"]') || c.closest('[class*="video"]')) return false;
            return true;
        });
        return found || candidates[0] || null;
    }

    function getRowData(tr, i = 0) {
        const cells = tr.querySelectorAll('td');
        if (cells.length === 0) return null;

        let reviewText = '';
        let repliesCount = 0;
        let productText = '';
        let dateText = '';

        if (reviewColIndex !== -1 && cells[reviewColIndex]) {
            const titleEl = getReviewTextElement(cells[reviewColIndex]);
            reviewText = titleEl ? titleEl.getAttribute('title').trim() : cells[reviewColIndex].textContent.trim();
        }

        if (repliesColIndex !== -1 && cells[repliesColIndex]) {
            const repliesStr = cells[repliesColIndex].textContent.trim();
            repliesCount = parseInt(repliesStr.replace(/[^\d]/g, ''), 10) || 0;
        }

        if (productColIndex !== -1 && cells[productColIndex]) {
            productText = cells[productColIndex].textContent.trim();
        }

        if (dateColIndex !== -1 && cells[dateColIndex]) {
            dateText = cells[dateColIndex].textContent.trim();
        }

        const rowId = `${productText}::${reviewText}::${dateText}::row_${i}`;
        return { rowId, reviewText, repliesCount, productText, dateText };
    }

    function populateSelect(select, rowId) {
        select.innerHTML = '';
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Не выбран';
        select.appendChild(defaultOpt);

        savedTemplates.forEach(tpl => {
            const opt = document.createElement('option');
            opt.value = tpl.id;
            opt.textContent = tpl.title;
            select.appendChild(opt);
        });

        if (rowStates.has(rowId)) {
            select.value = rowStates.get(rowId).templateId;
        } else {
            select.value = '';
        }
    }

    function populateBulkSelect() {
        const bulkSelect = bulkSelectWrapper ? bulkSelectWrapper.querySelector('.opt-ext-bulk-template-select') : null;
        if (!bulkSelect) return;
        bulkSelect.innerHTML = '';

        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = 'Применить...';
        bulkSelect.appendChild(defaultOpt);

        savedTemplates.forEach(tpl => {
            const opt = document.createElement('option');
            opt.value = tpl.id;
            opt.textContent = tpl.title;
            select.appendChild(opt);
        });
        bulkSelect.value = '';
    }

    function handleBulkSelectChange(e) {
        const templateId = e.target.value;
        if (!templateId) return;

        const checkedRows = Array.from(rowStates.entries()).filter(([_, state]) => state.checked && state.repliesCount === 0);
        if (checkedRows.length === 0) {
            alert('Сначала отметьте товары чекбоксом');
            e.target.value = '';
            return;
        }

        const tpl = savedTemplates.find(t => t.id === templateId);
        if (tpl) {
            checkedRows.forEach(([_, state]) => {
                state.templateId = tpl.id;
                state.templateText = tpl.text;
            });
        }

        e.target.value = '';
        requestReposition();
    }

    function updateAllDropdowns() {
        populateBulkSelect();
        const selects = document.querySelectorAll('.opt-ext-template-select');
        selects.forEach(select => {
            const wrapper = select.closest('.opt-ext-select-wrapper');
            if (wrapper) {
                for (let [key, val] of overlayElements.entries()) {
                    if (val.selectWrapper === wrapper) {
                        populateSelect(select, key);
                        break;
                    }
                }
            }
        });
    }

    function handleSelectChange(e, rowId) {
        const templateId = e.target.value;
        const state = rowStates.get(rowId);
        if (!state) return;

        if (!templateId) {
            state.templateId = '';
            state.templateText = '';
        } else {
            const tpl = savedTemplates.find(t => t.id === templateId);
            if (tpl) {
                state.templateId = tpl.id;
                state.templateText = tpl.text;
            }
        }

        const bulkSelect = bulkSelectWrapper ? bulkSelectWrapper.querySelector('.opt-ext-bulk-template-select') : null;
        if (bulkSelect) {
            bulkSelect.value = '';
        }

        updateFloatBtn();
    }

    function handleSelectAllChange(e) {
        const checked = e.target.checked;
        const rowsTable = findRowsTable();
        if (!rowsTable) return;

        const rows = rowsTable.querySelectorAll('tbody > tr');
        rows.forEach((tr, i) => {
            const rowData = getRowData(tr, i);
            if (!rowData || rowData.repliesCount > 0) return;

            const state = rowStates.get(rowData.rowId);
            if (state) {
                state.checked = checked;
                if (!checked) {
                    state.templateId = '';
                    state.templateText = '';
                }
            }
        });

        requestReposition();
    }

    function updateSelectAllState() {
        const selectAllCheck = document.querySelector('.opt-ext-reply-checkbox-all');
        if (!selectAllCheck) return;

        const rowsTable = findRowsTable();
        if (!rowsTable) return;

        const rows = rowsTable.querySelectorAll('tbody > tr');
        let totalEnabled = 0;
        let totalChecked = 0;

        rows.forEach((tr, i) => {
            const rowData = getRowData(tr, i);
            if (rowData && rowData.repliesCount === 0) {
                totalEnabled++;
                const state = rowStates.get(rowData.rowId);
                if (state && state.checked) {
                    totalChecked++;
                }
            }
        });

        if (totalEnabled === 0) {
            selectAllCheck.checked = false;
            selectAllCheck.indeterminate = false;
        } else if (totalChecked === totalEnabled) {
            selectAllCheck.checked = true;
            selectAllCheck.indeterminate = false;
        } else if (totalChecked === 0) {
            selectAllCheck.checked = false;
            selectAllCheck.indeterminate = false;
        } else {
            selectAllCheck.checked = false;
            selectAllCheck.indeterminate = true;
        }
    }

    function handleFloatBtnClick() {
        if (isRunning) {
            isRunning = false;
            updateFloatBtn();
        } else {
            startSending();
        }
    }

    async function startSending() {
        isRunning = true;
        failedReplies = [];
        updateFloatBtn();

        const itemsToSend = getQueueItems();

        for (let i = 0; i < itemsToSend.length; i++) {
            if (!isRunning) break;

            const item = itemsToSend[i];
            let success = false;

            try {
                success = await sendSingleReply(item);
            } catch (err) {
                console.error("Error processing row:", item.rowId, err);
            }

            if (success) {
                const state = rowStates.get(item.rowId);
                if (state) {
                    state.checked = false;
                    state.templateId = '';
                    state.templateText = '';
                    state.repliesCount = 1;
                }
            } else {
                failedReplies.push(item);
            }

            requestReposition();

            if (isRunning && i < itemsToSend.length - 1) {
                if (replySettings.delayEnabled) {
                    const min = replySettings.minDelay || 2;
                    const max = replySettings.maxDelay || 5;
                    const delaySec = Math.floor(Math.random() * (max - min + 1)) + min;
                    await sleep(delaySec * 1000);
                }
            }
        }

        isRunning = false;
        requestReposition();

        if (failedReplies.length > 0) {
            const details = failedReplies.map(f => f.rowId.split('::')[0] || 'Отзыв').join('\n');
            alert(`Отправка завершена.\nНе удалось отправить автоответы на следующие отзывы:\n\n${details}`);
        } else {
            alert('Все автоответы успешно отправлены!');
        }
    }

    async function sendSingleReply(item) {
        try {
            let tr = findRowElement(item.rowId);
            if (!tr) {
                for (let waitCount = 0; waitCount < 10; waitCount++) {
                    await sleep(300);
                    tr = findRowElement(item.rowId);
                    if (tr) break;
                }
                if (!tr) return false;
            }

            let rowIdx = 0;
            const parts = item.rowId.split('::row_');
            if (parts.length > 1) {
                rowIdx = parseInt(parts[1], 10) || 0;
            }

            const rowData = getRowData(tr, rowIdx);
            if (rowData && rowData.repliesCount > 0) {
                return true;
            }

            tr.scrollIntoView({ block: 'center' });
            await sleep(500);

            const cells = tr.querySelectorAll('td');
            const reviewCell = cells[reviewColIndex];
            if (!reviewCell) return false;

            const clickable = getReviewTextElement(reviewCell);
            if (!clickable) return false;

            clickable.click();

            const formLoaded = await waitForElement('#AnswerCommentForm', 5000);
            if (!formLoaded) return false;

            const textarea = document.querySelector('#AnswerCommentForm');
            if (!textarea) return false;

            setNativeValue(textarea, item.templateText);

            let parent = textarea.parentElement;
            let submitBtn = null;
            while (parent) {
                const candidates = parent.querySelectorAll('button[type="submit"]');
                for (let btn of candidates) {
                    if (btn.textContent.trim() === '') {
                        submitBtn = btn;
                        break;
                    }
                }
                if (submitBtn) break;
                parent = parent.parentElement;
            }

            if (!submitBtn) return false;
            submitBtn.click();

            let sentConfirmed = false;
            for (let poll = 0; poll < 10; poll++) {
                await sleep(300);
                const currentTextarea = document.querySelector('#AnswerCommentForm');
                if (!currentTextarea || currentTextarea.value === '') {
                    sentConfirmed = true;
                    break;
                }
            }

            const closeBtn = findCloseButton(textarea);
            if (closeBtn) {
                closeBtn.click();
                await sleep(500);
            }

            return true;
        } catch (e) {
            console.error('[opt-ext] Ошибка в sendSingleReply:', e);
            return false;
        }
    }

    function findRowElement(rowId) {
        const rowsTable = findRowsTable();
        if (!rowsTable) return null;
        const rows = rowsTable.querySelectorAll('tbody > tr');
        for (let i = 0; i < rows.length; i++) {
            const tr = rows[i];
            const data = getRowData(tr, i);
            if (data && data.rowId === rowId) {
                return tr;
            }
        }
        return null;
    }

    function findCloseButton(textarea) {
        let parent = textarea.parentElement;
        while (parent) {
            const closeBtn = parent.querySelector('button[type="button"]');
            if (closeBtn) return closeBtn;
            parent = parent.parentElement;
        }
        return document.querySelector('button[type="button"]');
    }

    function waitForElement(selector, timeout) {
        return new Promise((resolve) => {
            const start = Date.now();
            const timer = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(timer);
                    resolve(true);
                } else if (Date.now() - start > timeout) {
                    clearInterval(timer);
                    resolve(false);
                }
            }, 100);
        });
    }

    // =========================================================================
    // MODULE 2: Bulk Rich-Content Filling (seller.ozon.ru/app/products/edit/*)
    // =========================================================================

    const COL_ID_ANNOTATION = 'attribute#4191';
    const COL_ID_RICH_CONTENT = 'attribute#11254';
    const COL_ID_BRAND = 'attribute#85';
    const COL_ID_MODEL = 'attribute#9048';

    let richFillerRunning = false;
    let richFillerPaused = false;
    let richFillerStopRequested = false;

    let richFillerContainer = null;
    let richFillerControlsRow = null;
    let richFillerBtn = null;
    let richFillerPauseBtn = null;
    let richFillerStopBtn = null;
    let richFillerProgress = null;

    function initRichContentBulkFiller() {
        if (document.getElementById('opt-ext-rich-filler-container')) return;

        // 1. Create Floating UI Container
        richFillerContainer = document.createElement('div');
        richFillerContainer.id = 'opt-ext-rich-filler-container';
        richFillerContainer.style.cssText = `
            position: fixed;
            bottom: 90px;
            right: 20px;
            z-index: 10000;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 8px;
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
        `;

        // 2. Progress Indicator Text
        richFillerProgress = document.createElement('div');
        richFillerProgress.id = 'opt-ext-rich-filler-progress';
        richFillerProgress.style.cssText = `
            background: rgba(15, 23, 42, 0.85);
            color: #ffffff;
            padding: 6px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            display: none;
            backdrop-filter: blur(8px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.1);
        `;
        richFillerProgress.textContent = '';

        // 3. Control buttons row (Stop and Pause buttons left of main button)
        richFillerControlsRow = document.createElement('div');
        richFillerControlsRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
        `;

        // 3a. Stop Button
        richFillerStopBtn = document.createElement('button');
        richFillerStopBtn.id = 'opt-ext-rich-filler-stop-btn';
        richFillerStopBtn.textContent = '⏹ Остановить';
        richFillerStopBtn.title = 'Остановить процесс (завершится после текущего сохранения)';
        richFillerStopBtn.style.cssText = `
            background: rgba(225, 29, 72, 0.9);
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 12px;
            box-shadow: 0 4px 12px rgba(225, 29, 72, 0.3);
            cursor: pointer;
            transition: all 0.2s ease;
            display: none;
            align-items: center;
            gap: 6px;
            backdrop-filter: blur(8px);
        `;
        richFillerStopBtn.addEventListener('click', () => {
            if (richFillerRunning) {
                richFillerStopRequested = true;
                richFillerStopBtn.textContent = '⏳ Остановка...';
                richFillerStopBtn.disabled = true;
                richFillerStopBtn.style.opacity = '0.7';
                console.log('[opt-ext] Запрошена остановка процесса...');
            }
        });

        // 3b. Pause / Resume Button
        richFillerPauseBtn = document.createElement('button');
        richFillerPauseBtn.id = 'opt-ext-rich-filler-pause-btn';
        richFillerPauseBtn.textContent = '⏸ Пауза';
        richFillerPauseBtn.title = 'Поставить на паузу (остановится после нажатия Применить)';
        richFillerPauseBtn.style.cssText = `
            background: rgba(217, 119, 6, 0.9);
            color: white;
            border: none;
            padding: 10px 16px;
            border-radius: 20px;
            font-weight: 600;
            font-size: 12px;
            box-shadow: 0 4px 12px rgba(217, 119, 6, 0.3);
            cursor: pointer;
            transition: all 0.2s ease;
            display: none;
            align-items: center;
            gap: 6px;
            backdrop-filter: blur(8px);
        `;
        richFillerPauseBtn.addEventListener('click', () => {
            if (!richFillerRunning) return;
            if (richFillerPaused) {
                // Resume
                richFillerPaused = false;
                richFillerPauseBtn.textContent = '⏸ Пауза';
                richFillerPauseBtn.style.background = 'rgba(217, 119, 6, 0.9)';
                console.log('[opt-ext] Процесс возобновлен пользователем.');
            } else {
                // Pause
                richFillerPaused = true;
                richFillerPauseBtn.textContent = '▶ Продолжить';
                richFillerPauseBtn.style.background = 'rgba(16, 185, 129, 0.9)';
                console.log('[opt-ext] Запрошена пауза...');
            }
        });

        // 3c. Main Floating Action Button
        richFillerBtn = document.createElement('button');
        richFillerBtn.id = 'opt-ext-rich-filler-btn';
        richFillerBtn.textContent = '✨ Заполнить Rich-контент';
        richFillerBtn.title = 'Массово вставить Rich-контент из описания/аннотации товаров';
        richFillerBtn.style.cssText = `
            background: linear-gradient(135deg, #005bff, #003db3);
            color: white;
            border: none;
            padding: 12px 20px;
            border-radius: 24px;
            font-weight: 600;
            font-size: 13px;
            box-shadow: 0 4px 15px rgba(0, 91, 255, 0.35);
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        `;

        richFillerBtn.addEventListener('mouseenter', () => {
            if (!richFillerRunning) {
                richFillerBtn.style.transform = 'translateY(-2px)';
                richFillerBtn.style.boxShadow = '0 6px 20px rgba(0, 91, 255, 0.45)';
            }
        });
        richFillerBtn.addEventListener('mouseleave', () => {
            if (!richFillerRunning) {
                richFillerBtn.style.transform = 'none';
                richFillerBtn.style.boxShadow = '0 4px 15px rgba(0, 91, 255, 0.35)';
            }
        });

        richFillerBtn.addEventListener('click', startRichContentProcessing);

        richFillerControlsRow.appendChild(richFillerStopBtn);
        richFillerControlsRow.appendChild(richFillerPauseBtn);
        richFillerControlsRow.appendChild(richFillerBtn);

        richFillerContainer.appendChild(richFillerProgress);
        richFillerContainer.appendChild(richFillerControlsRow);

        attachRichFillerUI();

        // Reposition observer relative to Ozon floating assistant button
        const repositionObserver = new MutationObserver(() => {
            attachRichFillerUI();
        });
        repositionObserver.observe(document.body, { childList: true, subtree: true });
    }

    function attachRichFillerUI() {
        if (!richFillerContainer) return;
        if (!document.body.contains(richFillerContainer)) {
            document.body.appendChild(richFillerContainer);
        }

        const assistantBtn = document.querySelector('[data-onboarding-target="floating-ai-assistant-button"]');
        if (assistantBtn) {
            const parentWrapper = assistantBtn.closest('.n2d-a9f') || assistantBtn.parentElement;
            if (parentWrapper && typeof parentWrapper.getBoundingClientRect === 'function') {
                const rect = parentWrapper.getBoundingClientRect();
                if (rect.bottom > 0 && rect.right > 0) {
                    const bottomOffset = window.innerHeight - rect.top + 12;
                    richFillerContainer.style.bottom = `${bottomOffset}px`;
                    richFillerContainer.style.right = `${window.innerWidth - rect.right}px`;
                }
            }
        }
    }

    function findCellInGridRow(rowIndex, colId) {
        // 1. Check center container row first
        let cell = document.querySelector(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"] [col-id="${colId}"]`);
        if (cell) return cell;

        // 2. Check all row elements for this row-index
        const rowEls = document.querySelectorAll(`.ag-row[row-index="${rowIndex}"]`);
        for (const r of rowEls) {
            cell = r.querySelector(`[col-id="${colId}"]`);
            if (cell) return cell;
        }

        // 3. Fallback: check by col-id directly in table body
        const allColCells = Array.from(document.querySelectorAll(`[col-id="${colId}"]`));
        for (const c of allColCells) {
            const parentRow = c.closest('.ag-row');
            if (parentRow && parentRow.getAttribute('row-index') === String(rowIndex)) {
                return c;
            }
        }

        return null;
    }

    async function checkPauseAndStopState() {
        if (richFillerStopRequested) {
            console.log('[opt-ext] Процесс остановлен по запросу пользователя.');
            return false;
        }

        if (richFillerPaused) {
            console.log('[opt-ext] Процесс на паузе...');
            if (richFillerProgress) {
                richFillerProgress.textContent = `⏸ На паузе (${richFillerProgress.textContent.replace(' ⏸ Пауза', '')})`;
            }
            while (richFillerPaused && !richFillerStopRequested) {
                await sleep(200);
            }
            if (richFillerStopRequested) {
                console.log('[opt-ext] Процесс остановлен во время паузы.');
                return false;
            }
            console.log('[opt-ext] Возобновление работы...');
        }
        return true;
    }

    async function startRichContentProcessing() {
        if (richFillerRunning) return;

        richFillerRunning = true;
        richFillerPaused = false;
        richFillerStopRequested = false;

        richFillerBtn.disabled = true;
        richFillerBtn.style.opacity = '0.6';
        richFillerBtn.style.cursor = 'not-allowed';

        // Show Pause and Stop buttons
        richFillerStopBtn.style.display = 'inline-flex';
        richFillerStopBtn.textContent = '⏹ Остановить';
        richFillerStopBtn.disabled = false;
        richFillerStopBtn.style.opacity = '1';

        richFillerPauseBtn.style.display = 'inline-flex';
        richFillerPauseBtn.textContent = '⏸ Пауза';
        richFillerPauseBtn.style.background = 'rgba(217, 119, 6, 0.9)';

        richFillerProgress.style.display = 'block';
        richFillerProgress.textContent = 'Подготовка очереди...';

        console.log('[opt-ext] Начало динамической обработки очереди Rich-контента с виртуальным скроллингом AG-Grid...');

        const processedIndices = new Set();
        let iterationCount = 0;
        let consecutiveFails = 0;

        function getGridViewport() {
            return document.querySelector('.ag-body-viewport') || 
                   document.querySelector('.ag-center-cols-viewport') || 
                   document.querySelector('.ag-scrolls') || window;
        }

        while (richFillerRunning && !richFillerStopRequested) {
            if (!(await checkPauseAndStopState())) break;
            // 1. Scan current DOM for unprocessed row-index attributes
            const currentRows = Array.from(document.querySelectorAll('.ag-row'));
            const availableIndices = [];

            currentRows.forEach(r => {
                const idxStr = r.getAttribute('row-index');
                if (idxStr !== null) {
                    const idxNum = parseInt(idxStr, 10);
                    if (!isNaN(idxNum) && !processedIndices.has(idxNum)) {
                        availableIndices.push(idxNum);
                    }
                }
            });

            // Sort numeric row indices
            availableIndices.sort((a, b) => a - b);

            // 2. If no unprocessed rows found in DOM, scroll down to load next virtual batch
            if (availableIndices.length === 0) {
                console.log('[opt-ext] Не найдено новых строк в области видимости. Скроллим таблицу вниз...');
                const lastRow = document.querySelector('.ag-center-cols-container .ag-row:last-child') || document.querySelector('.ag-row:last-child');
                if (lastRow) {
                    lastRow.scrollIntoView({ block: 'end', behavior: 'instant' });
                } else {
                    const vp = getGridViewport();
                    if (vp.scrollBy) vp.scrollBy(0, 400);
                }

                await sleep(350);

                // Re-scan DOM after scroll
                const newRows = Array.from(document.querySelectorAll('.ag-row'));
                const newIndices = [];
                newRows.forEach(r => {
                    const idxStr = r.getAttribute('row-index');
                    if (idxStr !== null) {
                        const idxNum = parseInt(idxStr, 10);
                        if (!isNaN(idxNum) && !processedIndices.has(idxNum)) {
                            newIndices.push(idxNum);
                        }
                    }
                });

                if (newIndices.length === 0) {
                    consecutiveFails++;
                    console.log(`[opt-ext] Проверка подгрузки строк (${consecutiveFails}/3): новые строки не появились.`);
                    if (consecutiveFails >= 3) {
                        console.log(`[opt-ext] Достигнут конец таблицы. Всего обработано строк: ${processedIndices.size}.`);
                        break;
                    }
                    await sleep(400);
                    continue;
                } else {
                    consecutiveFails = 0;
                    availableIndices.push(...newIndices.sort((a, b) => a - b));
                }
            }

            const nextIdx = availableIndices[0];
            if (nextIdx === undefined) break;

            iterationCount++;
            processedIndices.add(nextIdx);

            richFillerProgress.textContent = `Обработано: ${processedIndices.size} товаров (строка #${nextIdx + 1})`;
            console.log(`[opt-ext] Итерация #${iterationCount}: обработка row-index="${nextIdx}"...`);

            try {
                await processSingleRowByIndex(nextIdx, iterationCount, processedIndices.size);
            } catch (err) {
                console.error(`[opt-ext] Ошибка при обработке row-index=${nextIdx}:`, err);
            }
        }

        console.log(`[opt-ext] Массовое заполнение Rich-контента завершено! Всего обработано строк: ${processedIndices.size}.`);

        richFillerRunning = false;
        richFillerPaused = false;
        richFillerStopRequested = false;

        richFillerBtn.disabled = false;
        richFillerBtn.style.opacity = '1';
        richFillerBtn.style.cursor = 'pointer';

        // Hide Pause and Stop buttons
        richFillerStopBtn.style.display = 'none';
        richFillerPauseBtn.style.display = 'none';

        setTimeout(() => {
            if (!richFillerRunning && richFillerProgress) {
                richFillerProgress.style.display = 'none';
            }
        }, 4000);
    }

    async function processSingleRowByIndex(rowIndex, index, total) {
        // 1. Find any row container for this row-index to scroll into view
        let rowEl = document.querySelector(`.ag-center-cols-container .ag-row[row-index="${rowIndex}"]`) || 
                    document.querySelector(`.ag-row[row-index="${rowIndex}"]`);

        if (!rowEl) {
            const anyRow = document.querySelector('.ag-row');
            if (anyRow) anyRow.scrollIntoView({ block: 'center' });
            await sleep(150);
            rowEl = document.querySelector(`.ag-row[row-index="${rowIndex}"]`);
        }

        if (!rowEl) {
            console.error(`[opt-ext] Строка ${index}/${total}: .ag-row[row-index="${rowIndex}"] не найден в DOM.`);
            return;
        }

        // 2. Scroll row into view center vertically
        rowEl.scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(100);

        // 3. Find annotation cell across containers
        let annotationCell = await scrollAndFindCell(rowIndex, COL_ID_ANNOTATION);

        if (!annotationCell) {
            console.log(`[opt-ext] Строка ${index}/${total} (row-index=${rowIndex}): ячейка аннотации [col-id="${COL_ID_ANNOTATION}"] не найдена.`);
            return;
        }

        const cellVal = annotationCell.querySelector('.ag-cell-value') || annotationCell;
        const rawAnnotation = cellVal.innerHTML || cellVal.textContent || '';
        const annotationText = cleanRichContentText(rawAnnotation);

        if (!annotationText) {
            console.log(`[opt-ext] Строка ${index}/${total} (row-index=${rowIndex}): аннотация пустая. Пропуск.`);
            return;
        }

        console.log(`[opt-ext] Строка ${index}/${total} (row-index=${rowIndex}): найдена аннотация (${annotationText.length} символов).`);

        // 3b. Extract Brand from [col-id="attribute#85"]
        let brandText = '';
        let brandCell = await scrollAndFindCell(rowIndex, COL_ID_BRAND);
        if (brandCell) {
            const brandValEl = brandCell.querySelector('.dn0-o4c') || brandCell.querySelector('.dn0-c1p') || brandCell.querySelector('.ag-cell-value') || brandCell;
            brandText = (brandValEl.textContent || '').trim();
        }
        console.log(`[opt-ext] Строка ${index}/${total}: бренд = "${brandText}"`);

        // 3c. Extract Model from [col-id="attribute#9048"]
        let modelText = '';
        let modelCell = await scrollAndFindCell(rowIndex, COL_ID_MODEL);
        if (modelCell) {
            const modelValEl = modelCell.querySelector('.dn0-c1p') || modelCell.querySelector('.dn0-o4c') || modelCell.querySelector('.ag-cell-value') || modelCell;
            let rawModel = (modelValEl.textContent || '').trim();
            // Remove underscore and everything after it
            const underscoreIdx = rawModel.indexOf('_');
            if (underscoreIdx !== -1) {
                rawModel = rawModel.substring(0, underscoreIdx).trim();
            }
            modelText = rawModel;
        }
        console.log(`[opt-ext] Строка ${index}/${total}: модель = "${modelText}"`);

        // 3d. Build product title from Brand + Model
        const productTitle = cleanRichContentText([brandText, modelText].filter(Boolean).join(' ')) || 'Товар';

        // 4. Find Rich-content cell across containers
        let richCell = await scrollAndFindCell(rowIndex, COL_ID_RICH_CONTENT);

        if (!richCell) {
            console.error(`[opt-ext] Строка ${index}/${total} (row-index=${rowIndex}): ячейка Rich-контента [col-id="${COL_ID_RICH_CONTENT}"] не найдена.`);
            return;
        }

        // Target .ag-cell-value inside Rich-content cell
        console.log(`[opt-ext] Строка ${index}/${total}: подготовка к двойному клику по ячейке Rich-контента...`);
        await triggerCellDblClick(richCell);

        // 6. Wait for modal "Добавление Rich-контента"
        const modalFound = await waitForModalByTitle('Rich-контент', 3000);
        if (!modalFound) {
            console.error(`[opt-ext] Строка ${index}/${total}: модалка "Добавление Rich-контента" не появилась за 3 сек. Пропуск.`);
            return;
        }

        const modal = findModalByTitle('Rich-контент');
        if (!modal) {
            console.error(`[opt-ext] Строка ${index}/${total}: узел модалки не найден.`);
            return;
        }

        // 7. Find JSON Textarea inside modal (with async retry loop)
        const textarea = await waitForRichContentTextarea(modal, 2500);
        if (!textarea) {
            console.error(`[opt-ext] Строка ${index}/${total}: textarea для JSON не найдена в модалке за 2.5 сек.`);
            return;
        }

        // 8. Build Rich-content JSON payload
        const jsonPayload = {
            "content": [
                {
                    "widgetName": "raTextBlock",
                    "title": {
                        "items": [{ "type": "text", "content": productTitle }],
                        "size": "size5",
                        "color": "color1"
                    },
                    "theme": "primary",
                    "padding": "type2",
                    "gapSize": "m",
                    "text": {
                        "size": "size2",
                        "align": "left",
                        "color": "color1",
                        "items": [
                            { "type": "text", "content": annotationText }
                        ]
                    }
                }
            ],
            "version": 0.3
        };

        const jsonString = JSON.stringify(jsonPayload, null, 2);

        // 9. Inject JSON into textarea via native setter
        console.log(`[opt-ext] Строка ${index}/${total}: вставка JSON в textarea...`);
        setNativeValue(textarea, jsonString);
        await sleep(300);

        // 10. Find and click "Применить" button (with async retry loop)
        const applyBtn = await waitForModalButton(modal, 'Применить', 2500);
        if (!applyBtn) {
            console.error(`[opt-ext] Строка ${index}/${total}: кнопка "Применить" не найдена за 2.5 сек.`);
            return;
        }

        console.log(`[opt-ext] Строка ${index}/${total}: нажатие кнопки "Применить"...`);
        applyBtn.click();

        // 11. Wait for modal close
        await waitForModalClose(modal, 2500);

        // Check pause or stop immediately after apply and modal close (during the 1 sec pause)
        if (richFillerPaused || richFillerStopRequested) {
            console.log(`[opt-ext] Строка ${index}/${total}: сохранена. Проверка статуса паузы/остановки...`);
        }
        await checkPauseAndStopState();

        await sleep(1000);

        // Second check after the 1 second pause before proceeding to next row
        await checkPauseAndStopState();

        console.log(`[opt-ext] Строка ${index}/${total}: успешно обработана.`);
    }

    async function scrollAndFindCell(rowIndex, colId) {
        // 1. Try direct query first (cell already in DOM)
        let cell = findCellInGridRow(rowIndex, colId);
        if (cell) return cell;

        // 2. Find the horizontal scroll viewport (AG-Grid syncs header + body through this)
        const hScrollVP = document.querySelector('.ag-body-horizontal-scroll-viewport') ||
                          document.querySelector('.ag-center-cols-viewport');

        if (!hScrollVP) {
            console.log(`[opt-ext] scrollAndFindCell: горизонтальный скролл-вьюпорт не найден.`);
            return null;
        }

        // 3. Determine target scroll position from header cell's left offset
        // AG-Grid header cells have style="left: Npx" or transform with translateX
        const headerCell = document.querySelector(`.ag-header-cell[col-id="${colId}"]`);
        let targetLeft = -1;

        if (headerCell) {
            // Try reading 'left' from style
            const leftStyle = headerCell.style.left;
            if (leftStyle) {
                targetLeft = parseInt(leftStyle, 10);
            }
            // Fallback: try reading from computed transform  
            if (targetLeft <= 0) {
                const transform = window.getComputedStyle(headerCell).transform;
                if (transform && transform !== 'none') {
                    const match = transform.match(/matrix.*,\s*([\d.]+)\)/);
                    if (match) targetLeft = parseFloat(match[1]);
                }
            }
        }

        // 4. If we couldn't find header, search in column definitions or guess from other cells
        if (targetLeft < 0) {
            // Try to find any cell with this col-id anywhere in DOM to get its left offset
            const anyCell = document.querySelector(`[col-id="${colId}"]`);
            if (anyCell) {
                const leftStyle = anyCell.style.left;
                if (leftStyle) targetLeft = parseInt(leftStyle, 10);
            }
        }

        if (targetLeft >= 0) {
            // Center the column in the viewport
            const vpWidth = hScrollVP.clientWidth;
            const scrollTarget = Math.max(0, targetLeft - vpWidth / 2 + 100);
            
            console.log(`[opt-ext] scrollAndFindCell: скролл к col-id="${colId}" (left=${targetLeft}px, scrollTo=${scrollTarget}px)`);
            hScrollVP.scrollLeft = scrollTarget;
            await sleep(300);

            cell = findCellInGridRow(rowIndex, colId);
            if (cell) return cell;

            // Try exact position
            hScrollVP.scrollLeft = targetLeft;
            await sleep(300);
            cell = findCellInGridRow(rowIndex, colId);
            if (cell) return cell;
        }

        // 5. Fallback: sweep scroll through entire grid width to find the column
        const totalWidth = hScrollVP.scrollWidth;
        const vpWidth = hScrollVP.clientWidth;
        const step = vpWidth * 0.7; // overlap 30%

        console.log(`[opt-ext] scrollAndFindCell: начинаю sweep-скролл (totalWidth=${totalWidth}, step=${step}) для col-id="${colId}"...`);
        
        for (let pos = 0; pos < totalWidth; pos += step) {
            hScrollVP.scrollLeft = pos;
            await sleep(250);
            cell = findCellInGridRow(rowIndex, colId);
            if (cell) {
                console.log(`[opt-ext] scrollAndFindCell: найдена ячейка col-id="${colId}" на scrollLeft=${pos}px`);
                return cell;
            }
        }

        console.log(`[opt-ext] scrollAndFindCell: ячейка [col-id="${colId}"] для row-index=${rowIndex} не найдена после полного sweep-скролла.`);
        return null;
    }
    async function triggerCellDblClick(richCell) {
        // Scroll cell into center both horizontally and vertically
        richCell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        await sleep(200);

        // Find target inner element or fallback to richCell container
        const innerTextEl = richCell.querySelector('.dn0-c1p') || richCell.querySelector('[class*="-c1p"]') || richCell.querySelector('.ag-cell-value') || richCell;

        function singleClick(target) {
            const rect = target.getBoundingClientRect();
            const opts = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
                detail: 1
            };
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
        }

        // Click 1: focus cell (causes ag-cell-focus class)
        console.log('[opt-ext] Клик 1: фокус на ячейку Rich-контента...');
        singleClick(innerTextEl);
        if (typeof richCell.focus === 'function') richCell.focus();
        if (typeof innerTextEl.focus === 'function') innerTextEl.focus();

        // Wait for AG Grid cell focus state to update
        await sleep(250);

        // Click 2: click focused cell to open modal
        console.log('[opt-ext] Клик 2: открытие модалки на сфокусированной ячейке...');
        singleClick(innerTextEl);

        // Check if modal opens within 600ms
        const modalOpened = await waitForModalByTitle('Rich-контент', 600);
        if (!modalOpened) {
            console.log('[opt-ext] Фолбэк клик 2 по родителю [col-id]...');
            singleClick(richCell);
            richCell.click?.();
        }
    }

    function findModalByTitle(titleText) {
        const lowerTarget = titleText.toLowerCase();

        const elements = Array.from(document.querySelectorAll('div, section, dialog, [role="dialog"]'));
        for (const el of elements) {
            if (!el.textContent) continue;
            const txt = el.textContent.toLowerCase();
            if (txt.includes(lowerTarget) || txt.includes('добавление rich-контента') || txt.includes('rich-контент')) {
                const style = window.getComputedStyle(el);
                if ((style.position === 'fixed' || style.position === 'absolute' || el.getAttribute('role') === 'dialog') && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetHeight > 0) {
                    return el;
                }
            }
        }

        const labels = Array.from(document.querySelectorAll('label'));
        const jsonLabel = labels.find(l => l.textContent && l.textContent.toLowerCase().includes('rich-контент json'));
        if (jsonLabel) {
            let parent = jsonLabel.parentElement;
            while (parent && parent !== document.body) {
                const style = window.getComputedStyle(parent);
                if (style.position === 'fixed' || style.position === 'absolute' || parent.getAttribute('role') === 'dialog') {
                    return parent;
                }
                parent = parent.parentElement;
            }
            return jsonLabel.closest('div');
        }

        return null;
    }

    function waitForModalByTitle(titleText, timeoutMs) {
        return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
                const modal = findModalByTitle(titleText);
                if (modal) {
                    clearInterval(interval);
                    resolve(true);
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    resolve(false);
                }
            }, 100);
        });
    }

    function waitForModalClose(modal, timeoutMs) {
        return new Promise((resolve) => {
            const start = Date.now();
            const interval = setInterval(() => {
                if (!document.body.contains(modal) || window.getComputedStyle(modal).display === 'none') {
                    clearInterval(interval);
                    resolve(true);
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(interval);
                    resolve(false);
                }
            }, 100);
        });
    }

    function waitForRichContentTextarea(modal, timeoutMs = 2000) {
        return new Promise((resolve) => {
            const start = Date.now();
            const timer = setInterval(() => {
                const searchRoot = (modal && document.body.contains(modal)) ? modal : document;
                const labels = Array.from(searchRoot.querySelectorAll('label'));
                const label = labels.find(l => l.textContent && l.textContent.toLowerCase().includes('rich-контент json'));
                
                if (label) {
                    const htmlFor = label.getAttribute('for');
                    if (htmlFor) {
                        const el = document.getElementById(htmlFor);
                        if (el && el.tagName.toLowerCase() === 'textarea') {
                            clearInterval(timer);
                            return resolve(el);
                        }
                    }
                    const parentContainer = label.closest('[class*="ct6134"]') || label.parentElement?.parentElement;
                    if (parentContainer) {
                        const ta = parentContainer.querySelector('textarea');
                        if (ta) {
                            clearInterval(timer);
                            return resolve(ta);
                        }
                    }
                }

                if (modal) {
                    const modalTa = modal.querySelector('textarea');
                    if (modalTa) {
                        clearInterval(timer);
                        return resolve(modalTa);
                    }
                }

                const globalTa = document.querySelector('textarea');
                if (globalTa) {
                    clearInterval(timer);
                    return resolve(globalTa);
                }

                if (Date.now() - start > timeoutMs) {
                    clearInterval(timer);
                    resolve(null);
                }
            }, 100);
        });
    }

    function waitForModalButton(modal, btnText, timeoutMs = 2500) {
        return new Promise((resolve) => {
            const start = Date.now();
            const lowerText = btnText.toLowerCase();
            const timer = setInterval(() => {
                if (modal && document.body.contains(modal)) {
                    const modalBtns = Array.from(modal.querySelectorAll('button'));
                    const foundInModal = modalBtns.find(b => b.textContent && b.textContent.toLowerCase().includes(lowerText));
                    if (foundInModal) {
                        clearInterval(timer);
                        return resolve(foundInModal);
                    }
                }

                const allBtns = Array.from(document.querySelectorAll('button'));
                const foundGlobal = allBtns.find(b => b.textContent && b.textContent.toLowerCase().includes(lowerText));
                if (foundGlobal) {
                    clearInterval(timer);
                    return resolve(foundGlobal);
                }

                if (Date.now() - start > timeoutMs) {
                    clearInterval(timer);
                    resolve(null);
                }
            }, 100);
        });
    }

    // =========================================================================
    // Router & SPA URL Observer
    // =========================================================================

    function routePage() {
        const href = window.location.href;
        if (href.includes('/app/products/edit/') || href.includes('behavior=bulk_extended') || href.includes('/products/edit/')) {
            initRichContentBulkFiller();
        } else if (href.includes('/app/reviews')) {
            initReviewsAutoReply();
        }
    }

    routePage();

    let lastLocation = window.location.href;
    setInterval(() => {
        if (window.location.href !== lastLocation) {
            lastLocation = window.location.href;
            routePage();
        }
    }, 1000);

})();
