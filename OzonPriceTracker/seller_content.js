// Ozon Seller Auto-Reply Content Script

(function() {
    if (window.__optExtSellerScriptLoaded) {
        console.log('[opt-ext] Скрипт автоответов Ozon Seller уже загружен, пропускаю повторную инициализацию.');
        return;
    }
    window.__optExtSellerScriptLoaded = true;

    let rowStates = new Map(); // Key: rowId, Value: { checked: boolean, templateId: string, templateText: string, repliesCount: number }
    let overlayElements = new Map(); // Key: rowId, Value: { checkWrapper: HTMLDivElement, selectWrapper: HTMLDivElement }
    let savedTemplates = [];
    let replySettings = { delayEnabled: false, minDelay: 2, maxDelay: 5 };
    let isRunning = false;
    let failedReplies = [];

    let observer = null;
    let overlayContainer = null;
    let checkAllWrapper = null;
    let bulkSelectWrapper = null;
    let isRepositioning = false;

    // Initialize templates and settings from storage
    chrome.storage.local.get(['ozonReplyTemplates', 'ozonReplySettings'], (result) => {
        if (result.ozonReplyTemplates) {
            savedTemplates = result.ozonReplyTemplates;
        }
        if (result.ozonReplySettings) {
            replySettings = result.ozonReplySettings;
        }
        initUI();
    });

    // Listen for storage changes
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

    // Create and inject floating control button and overlays
    let floatBtnContainer = null;
    let floatBtn = null;

    function initUI() {
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

        // Observe DOM changes (Read-only, never modifying Ozon DOM nodes to prevent loops)
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

    // Dynamic table processing
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
        // Look for the table having tbody tr with images (product images)
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
        // Fallback to table having tbody rows and is not the header table
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
        const thDumps = Array.from(ths).map(th => ({
            text: th.textContent.trim(),
            colspan: th.getAttribute('colspan') || '1'
        }));
        console.log('[opt-ext] Заголовки (th):', thDumps);

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
            console.log('[opt-ext] Вычисленные индексы колонок (с учетом colspan):', {
                reviewColIndex,
                repliesColIndex,
                productColIndex,
                dateColIndex
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

        // 1. Position Bulk Select check-all th (using headerTable)
        const firstTh = headerTable ? headerTable.querySelector('thead th') : null;
        if (firstTh && checkAllWrapper && bulkSelectWrapper) {
            const thRect = firstTh.getBoundingClientRect();
            const nativeCheckboxEl = firstTh.querySelector('input[type="checkbox"]') || firstTh.querySelector('[class*="checkbox"]') || firstTh;
            const nativeCheckboxRect = nativeCheckboxEl.getBoundingClientRect();

            const checkWidth = 32;
            const dropdownWidth = 90;
            const gap = 6;

            let checkLeft = thRect.left - checkWidth - gap + window.scrollX;
            if (checkLeft < window.scrollX) {
                checkLeft = thRect.right + window.scrollX; // Fallback to right side if no room on the left
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

            // Dropdown is positioned immediately to the right of our checkbox wrapper
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

            // Verification log
            console.log('[opt-ext] Порядок в шапке (left→right):', {
                ourCheckbox: checkAllWrapper.getBoundingClientRect().left,
                templateDropdown: bulkSelectWrapper.getBoundingClientRect().left,
                nativeCheckbox: nativeCheckboxRect.left
            });
        } else {
            if (checkAllWrapper) checkAllWrapper.style.display = 'none';
            if (bulkSelectWrapper) bulkSelectWrapper.style.display = 'none';
        }

        const rows = rowsTable.querySelectorAll('tbody > tr');
        const visibleRowIds = new Set();

        rows.forEach((tr, i) => {
            try {
                const cells = tr.querySelectorAll('td');
                if (cells.length === 0) {
                    return;
                }

                const rowData = getRowData(tr, i);
                if (!rowData) {
                    return;
                }

                // Calculate coordinates
                const firstTd = cells[0];
                const lastTd = cells[cells.length - 1];

                visibleRowIds.add(rowData.rowId);

                // Maintain state mapping
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

                // Get or create overlay DOM elements
                let elPair = overlayElements.get(rowData.rowId);
                if (!elPair) {
                    elPair = createRowOverlayElements(rowData.rowId);
                    overlayElements.set(rowData.rowId, elPair);
                }

                // Sync values to DOM controls
                const checkInput = elPair.checkWrapper.querySelector('.opt-ext-reply-checkbox');
                if (checkInput) {
                    checkInput.checked = state.checked;
                    checkInput.disabled = rowData.repliesCount > 0;
                }

                // Sync select values
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
                        checkLeft = firstTdRect.right + window.scrollX; // Fallback to right side
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

                    // Logic for select visibility
                    if (rowData.repliesCount > 0) {
                        elPair.selectWrapper.style.display = 'flex';
                        // Show "Уже отвечено"
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
                        
                        // Show only if checked
                        elPair.selectWrapper.style.display = state.checked ? 'flex' : 'none';
                    }
                } else {
                    elPair.selectWrapper.style.display = 'none';
                }
            } catch (e) {
                console.error(`[opt-ext] Ошибка на строке ${i}:`, e);
            }
        });

        // Hide overlay elements that are not currently in the viewport/DOM
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
        // 1. Checkbox Wrapper
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

        // 2. Select Dropdown Wrapper
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
            bulkSelect.appendChild(opt);
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

        // Reset bulk select back to empty (one-off trigger)
        e.target.value = '';
        requestReposition();
    }

    function updateAllDropdowns() {
        populateBulkSelect();
        const selects = document.querySelectorAll('.opt-ext-template-select');
        selects.forEach(select => {
            const wrapper = select.closest('.opt-ext-select-wrapper');
            if (wrapper) {
                // Find matching rowId key from Map
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

        // Reset the bulk select to empty
        const bulkSelect = bulkSelectWrapper ? bulkSelectWrapper.querySelector('.opt-ext-bulk-template-select') : null;
        if (bulkSelect) {
            bulkSelect.value = '';
        }

        updateFloatBtn();
    }

    function handleSelectAllChange(e) {
        const checked = e.target.checked;
        
        // Loop all states and update checked status for visible rows with repliesCount == 0
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

    // Floating Button click handler
    function handleFloatBtnClick() {
        console.log('[opt-ext] handleFloatBtnClick вызван, timestamp:', Date.now());
        if (isRunning) {
            isRunning = false;
            updateFloatBtn();
        } else {
            startSending();
        }
    }

    // Automation Runner
    async function startSending() {
        isRunning = true;
        failedReplies = [];
        updateFloatBtn();

        const itemsToSend = getQueueItems();
        console.log('[opt-ext] Очередь на отправку:', itemsToSend.map(item => ({
            rowKey: item.rowId,
            templateId: item.templateId,
            templateText: item.templateText?.slice(0, 30)
        })));

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
                // Reset states
                const state = rowStates.get(item.rowId);
                if (state) {
                    state.checked = false;
                    state.templateId = '';
                    state.templateText = '';
                    state.repliesCount = 1; // Mark as answered
                }
            } else {
                failedReplies.push(item);
            }

            requestReposition();

            // Delay if enabled and not the last element
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
        console.log('[opt-ext] sendSingleReply: ищу строку с rowKey =', item.rowId);
        
        try {
            const rowsTable = findRowsTable();
            console.log('[opt-ext] rowsTable на момент отправки найдена:', !!rowsTable);

            if (rowsTable) {
                const currentRows = rowsTable.querySelectorAll('tbody > tr');
                console.log('[opt-ext] Строк в DOM на момент отправки:', currentRows.length);
                const allKeys = Array.from(currentRows).map((r, idx) => {
                    const rowData = getRowData(r, idx);
                    return rowData ? rowData.rowId : null;
                });
                console.log('[opt-ext] Все rowKey текущих строк:', allKeys);
            }

            // Find row in DOM
            let tr = findRowElement(item.rowId);
            console.log('[opt-ext] Строка найдена:', !!tr, 'сравнение с искомым ключом:', item.rowId);

            if (!tr) {
                console.warn("Row not found in DOM, attempting to scroll or wait...");

                // Find similar keys by product text (article)
                if (rowsTable) {
                    const currentRows = rowsTable.querySelectorAll('tbody > tr');
                    const targetProduct = item.rowId.split('::')[0];
                    let closestKey = null;
                    for (let idx = 0; idx < currentRows.length; idx++) {
                        const rowData = getRowData(currentRows[idx], idx);
                        if (rowData) {
                            const prod = rowData.rowId.split('::')[0];
                            if (prod === targetProduct) {
                                closestKey = rowData.rowId;
                                break;
                            }
                        }
                    }
                    console.log('[opt-ext] Искомый key:', JSON.stringify(item.rowId));
                    console.log('[opt-ext] Похожий по артикулу key:', JSON.stringify(closestKey));
                }

                console.log('[opt-ext] Пытаюсь scrollIntoView для рядов с похожим индексом / жду появления строки, таймаут = 3000ms');
                // Scroll / wait loop
                for (let waitCount = 0; waitCount < 10; waitCount++) {
                    await sleep(300);
                    tr = findRowElement(item.rowId);
                    if (tr) break;
                }
                console.log('[opt-ext] После ожидания строка найдена:', !!tr);

                if (!tr) {
                    return false;
                }
            }

            // Extract index from rowId (e.g. key ends with ::row_N)
            let rowIdx = 0;
            const parts = item.rowId.split('::row_');
            if (parts.length > 1) {
                rowIdx = parseInt(parts[1], 10) || 0;
            }

            // Re-verify repliesCount before real sending
            const rowData = getRowData(tr, rowIdx);
            if (rowData && rowData.repliesCount > 0) {
                console.log(`Review already answered (repliesCount = ${rowData.repliesCount}), skipping:`, item.rowId);
                return true;
            }

            // Scroll into view
            tr.scrollIntoView({ block: 'center' });
            await sleep(500);

            // Click on the review cell's title element
            const cells = tr.querySelectorAll('td');
            console.log('[opt-ext] Индекс колонки "Отзыв":', reviewColIndex);
            
            const reviewCell = cells[reviewColIndex];
            console.log('[opt-ext] Ячейка отзыва (проверка):', reviewCell?.outerHTML?.slice(0, 150));

            if (!reviewCell) {
                console.error('[opt-ext] Ячейка отзыва не найдена по индексу:', reviewColIndex);
                return false;
            }

            const clickable = getReviewTextElement(reviewCell);
            if (!clickable) {
                console.error('[opt-ext] Element for review text not found inside reviewCell!');
                return false;
            }

            console.log('[opt-ext] Элемент всё ещё в DOM перед кликом:', document.body.contains(clickable));
            console.log('[opt-ext] Кликаю по элементу строки:', clickable, 'outerHTML:', clickable?.outerHTML?.slice(0, 150));
            
            try {
                clickable.click();
                console.log('[opt-ext] Клик по строке выполнен успешно');
            } catch (e) {
                console.error('[opt-ext] Ошибка при клике по строке:', e);
            }

            // Wait for side panel / textarea to load
            console.log('[opt-ext] Жду появления #AnswerCommentForm...');
            const startTime = Date.now();
            const formLoaded = await waitForElement('#AnswerCommentForm', 5000);
            const elapsedMs = Date.now() - startTime;
            if (!formLoaded) {
                console.error('[opt-ext] #AnswerCommentForm НЕ найден за', 5000, 'мс');
                return false;
            }

            const textarea = document.querySelector('#AnswerCommentForm');
            console.log('[opt-ext] #AnswerCommentForm найден:', !!textarea, 'через', elapsedMs, 'мс');
            if (!textarea) return false;

            // Set React controlled textarea value
            console.log('[opt-ext] Вставляю текст шаблона:', item.templateText.slice(0, 50));
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
            ).set;
            nativeSetter.call(textarea, item.templateText);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            console.log('[opt-ext] Значение textarea после вставки:', textarea.value.slice(0, 50));

            // Find submit button in the parent container
            console.log('[opt-ext] Ищу кнопку отправки среди button[type=submit] без текста...');
            let parent = textarea.parentElement;
            let submitBtn = null;
            while (parent) {
                const candidates = parent.querySelectorAll('button[type="submit"]');
                console.log('[opt-ext] Найдено кандидатов:', candidates.length, 
                    Array.from(candidates).map(b => ({
                        text: b.textContent.trim(),
                        html: b.outerHTML.slice(0, 100)
                    }))
                );
                for (let btn of candidates) {
                    if (btn.textContent.trim() === '') {
                        submitBtn = btn;
                        break;
                    }
                }
                if (submitBtn) break;
                parent = parent.parentElement;
            }

            console.log('[opt-ext] Выбрана кнопка отправки:', !!submitBtn);
            if (!submitBtn) {
                console.error("Submit button not found.");
                return false;
            }

            // Click submit
            console.log('[opt-ext] Кликаю кнопку отправки...');
            submitBtn.click();
            console.log('[opt-ext] Клик выполнен, жду подтверждения...');

            // Wait for confirmation (textarea cleared or disappeared)
            let sentConfirmed = false;
            for (let poll = 0; poll < 10; poll++) {
                await sleep(300);
                const currentTextarea = document.querySelector('#AnswerCommentForm');
                if (!currentTextarea || currentTextarea.value === '') {
                    sentConfirmed = true;
                    break;
                }
            }

            if (!sentConfirmed) {
                console.warn("Could not confirm reply submission, but proceeding.");
            }

            // Close side panel
            const closeBtn = findCloseButton(textarea);
            if (closeBtn) {
                closeBtn.click();
                await sleep(500);
            }

            return true;
        } catch (e) {
            console.error('[opt-ext] Ошибка в sendSingleReply для rowKey =', item.rowId, e, e.stack);
            return false;
        }
    }

    function findRowElement(rowId) {
        console.log('[opt-ext] findRowElement: тип rowId:', typeof rowId, 'значение:', rowId);
        const rowsTable = findRowsTable();
        if (!rowsTable) return null;
        const rows = rowsTable.querySelectorAll('tbody > tr');
        for (let i = 0; i < rows.length; i++) {
            const tr = rows[i];
            const data = getRowData(tr, i);
            const key = data ? data.rowId : null;
            const match = key === rowId;
            console.log('[opt-ext] Сравниваю:', JSON.stringify(key), 'vs', 
                JSON.stringify(rowId), '-> совпадение:', match, 
                'типы:', typeof key, typeof rowId,
                'длины:', key?.length, rowId?.length);
            if (match) {
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

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
})();
