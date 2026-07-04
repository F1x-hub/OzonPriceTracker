document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('productUrl');
    const targetPriceInput = document.getElementById('targetPrice');
    const addBtn = document.getElementById('addBtn');
    const statusMessage = document.getElementById('statusMessage');
    const trackedItemsList = document.getElementById('trackedItemsList');
    const lastCheckTimeSpan = document.getElementById('lastCheckTime');
    const checkIntervalInput = document.getElementById('checkInterval');
    const saveIntervalBtn = document.getElementById('saveIntervalBtn');

    // Wildberries elements
    const wbArticlesInput = document.getElementById('wbArticles');
    const wbStartBtn = document.getElementById('wbStartBtn');
    const wbExportBtn = document.getElementById('wbExportBtn');
    const wbClearBtn = document.getElementById('wbClearBtn');
    const wbTrackedItemsList = document.getElementById('wbTrackedItemsList');
    
    // Progress Bar elements
    const wbProgressContainer = document.getElementById('wbProgressContainer');
    const wbProgressText = document.getElementById('wbProgressText');
    const wbProgressPercent = document.getElementById('wbProgressPercent');
    const wbProgressBar = document.getElementById('wbProgressBar');

    // Excel Export Logic
    wbExportBtn.addEventListener('click', () => {
        const rows = document.querySelectorAll('.wb-item');
        if (rows.length === 0) {
            alert('Нет данных для экспорта');
            return;
        }

        const data = [['Артикул', 'С кошельком', 'Без кошелька']];
        
        rows.forEach(row => {
            const article = row.querySelector('.wb-article')?.textContent || '';
            const wallet = row.querySelector('.wb-wallet-price')?.textContent || '';
            const regular = row.querySelector('.wb-regular-price')?.textContent || '';
            data.push([article, wallet, regular]);
        });

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(data);
        
        // Auto-size columns
        const colWidths = data[0].map((_, i) => ({
            wch: Math.max(...data.map(row => row[i].toString().length)) + 2
        }));
        ws['!cols'] = colWidths;

        XLSX.utils.book_append_sheet(wb, ws, "WB Prices");
        
        const date = new Date().toISOString().split('T')[0];
        const fileName = `wb_prices_${date}.xlsx`;
        
        XLSX.writeFile(wb, fileName);
    });

    // Clear WB Logic
    wbClearBtn.addEventListener('click', () => {
        if (confirm('Очистить результаты Wildberries?')) {
            chrome.storage.local.set({ 
                wbLastResults: {}, 
                wbStatus: { total: 0, done: 0, running: false } 
            }, () => {
                renderWbResults({});
                updateWbProgress({ total: 0, done: 0, running: false });
            });
        }
    });

    // History elements
    const historyList = document.getElementById('historyList');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    const showAllHistoryBtn = document.getElementById('showAllHistoryBtn');
    let currentHistoryFilter = null;

    // Tabs logic
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            document.getElementById(targetId).classList.add('active');

            if (targetId === 'history-tab') {
                loadHistory();
            }
        });
    });

    // Clear history
    clearHistoryBtn.addEventListener('click', () => {
        if (confirm('Вы уверены, что хотите очистить всю историю?')) {
            chrome.storage.local.set({ notificationHistory: [] }, () => {
                loadHistory();
            });
        }
    });

    // Show all history
    showAllHistoryBtn.addEventListener('click', () => {
        currentHistoryFilter = null;
        showAllHistoryBtn.style.display = 'none';
        loadHistory();
    });

    // Initial load
    loadItems();
    updateLastCheckTime();
    loadInterval();
    loadWbState();

    saveIntervalBtn.addEventListener('click', () => {
        const newInterval = parseInt(checkIntervalInput.value, 10);
        if (isNaN(newInterval) || newInterval < 1) {
            showStatus('Введите корректный интервал (целое число 1 и более)', true);
            return;
        }
        chrome.storage.local.set({ checkInterval: newInterval }, () => {
            showStatus(`Интервал изменён на ${newInterval} минут`);
        });
    });

    function loadInterval() {
        chrome.storage.local.get({ checkInterval: 120 }, (result) => {
            if (checkIntervalInput) {
                checkIntervalInput.value = result.checkInterval;
            }
        });
    }

    // Ozon Addition Logic
    addBtn.addEventListener('click', () => {
        const url = urlInput.value.trim();
        const targetPrice = parseInt(targetPriceInput.value, 10);
        const priceType = document.querySelector('input[name="priceType"]:checked').value;

        if (!url || !url.includes('ozon.ru')) {
            showStatus('Пожалуйста, введите корректную ссылку на Ozon.', true);
            return;
        }

        if (isNaN(targetPrice) || targetPrice <= 0) {
            showStatus('Пожалуйста, введите корректную целевую цену.', true);
            return;
        }

        addItem(url, targetPrice, priceType);
    });

    function showStatus(msg, isError = false) {
        statusMessage.textContent = msg;
        statusMessage.style.color = isError ? '#dc3545' : '#28a745';
        statusMessage.style.backgroundColor = isError ? '#f8d7da' : '#e8f5e9';
        statusMessage.classList.add('visible');
        
        setTimeout(() => {
            statusMessage.classList.remove('visible');
        }, 3000);
    }

    function addItem(url, targetPrice, priceType) {
        chrome.storage.local.get({ trackedItems: [] }, (result) => {
            const items = result.trackedItems;
            const newItem = {
                id: Date.now().toString(),
                url: url,
                title: null,
                targetPrice: targetPrice,
                priceType: priceType,
                lastPrice: null,
                addedAt: new Date().toISOString()
            };
            items.push(newItem);
            chrome.storage.local.set({ trackedItems: items }, () => {
                showStatus('Добавлено!');
                urlInput.value = '';
                targetPriceInput.value = '';
                renderItems(items);
                chrome.runtime.sendMessage({ action: "checkPricesNow" });
            });
        });
    }

    function loadItems() {
        chrome.storage.local.get({ trackedItems: [] }, (result) => {
            renderItems(result.trackedItems);
        });
    }

    function renderItems(items) {
        trackedItemsList.innerHTML = '';
        if (items.length === 0) {
            trackedItemsList.innerHTML = '<div class="empty-message">Нет отслеживаемых товаров</div>';
            return;
        }
        items.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
        items.forEach(item => {
            const itemElement = document.createElement('div');
            itemElement.className = 'tracked-item';
            const typeLabel = item.priceType === 'bank' ? 'c Ozon Банком' : 'без Ozon Банка';
            const lastPriceDisplay = item.lastPrice ? `${item.lastPrice} ₽` : 'Ожидание...';
            const isGoalMet = item.lastPrice && item.lastPrice <= item.targetPrice;
            const priceClass = isGoalMet ? 'item-price goal-met' : 'item-price';
            const displayTitle = item.title ? item.title : item.url;

            itemElement.innerHTML = `
                <a href="${item.url}" target="_blank" class="item-url" title="${displayTitle}">${displayTitle}</a>
                <div class="item-details">
                    <span>Цель: <strong>${item.targetPrice} ₽</strong></span>
                    <span>(${typeLabel})</span>
                </div>
                <div class="item-details" style="margin-top:2px;">
                    <span>Текущая цена: <span class="${priceClass}">${lastPriceDisplay}</span></span>
                </div>
                <div class="item-actions">
                    <button class="history-link-btn" data-id="${item.id}">Посмотреть историю</button>
                </div>
                <button class="delete-btn" data-id="${item.id}" title="Удалить">×</button>
            `;
            trackedItemsList.appendChild(itemElement);
        });

        document.querySelectorAll('.history-link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                currentHistoryFilter = e.target.dataset.id;
                showAllHistoryBtn.style.display = 'block';
                document.querySelector('[data-tab="history-tab"]').click();
            });
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                deleteItem(e.target.dataset.id);
            });
        });
    }

    function deleteItem(id) {
        chrome.storage.local.get({ trackedItems: [], notificationHistory: [] }, (result) => {
            const items = result.trackedItems.filter(item => item.id !== id);
            const newHistory = result.notificationHistory.filter(entry => entry.itemId !== id);
            chrome.storage.local.set({ trackedItems: items, notificationHistory: newHistory }, () => {
                renderItems(items);
                if (document.getElementById('history-tab').classList.contains('active')) {
                    loadHistory();
                }
            });
        });
    }

    // --- Wildberries Price Viewer Logic ---

    wbStartBtn.addEventListener('click', async () => {
        const text = wbArticlesInput.value.trim();
        if (!text) return;

        const articles = parseArticles(text);
        if (articles.length === 0) return;

        // Disable start button and start background process
        wbStartBtn.disabled = true;
        wbStartBtn.textContent = 'Обработка...';

        chrome.runtime.sendMessage({ action: 'fetchWbPrices', articles }, (response) => {
            console.log("Background fetch started:", response);
        });
    });

    function loadWbState() {
        chrome.storage.local.get({ wbLastResults: {}, wbStatus: { total: 0, done: 0, running: false } }, (result) => {
            renderWbResults(result.wbLastResults);
            updateWbProgress(result.wbStatus);
        });
    }

    function renderWbResults(results) {
        wbTrackedItemsList.innerHTML = '';
        if (!results || Object.keys(results).length === 0) return;

        for (const [id, data] of Object.entries(results)) {
            const row = document.createElement('div');
            row.className = 'wb-item';
            row.id = `wb-row-${id}`;
            const walletStr = data.wallet != null ? data.wallet.toLocaleString('ru-RU') + ' ₽' : '—';
            const totalStr = data.total != null ? data.total.toLocaleString('ru-RU') + ' ₽' : '—';
            row.innerHTML = `
                <span class="wb-article">${id}</span>
                <span class="wb-wallet-price">${walletStr}</span>
                <span class="wb-regular-price">${totalStr}</span>
            `;
            wbTrackedItemsList.appendChild(row);
        }
    }

    function updateWbProgress(status) {
        if (status.running) {
            wbProgressContainer.style.display = 'block';
            wbProgressText.textContent = `Обработано: ${status.done} из ${status.total}`;
            const percent = Math.round((status.done / status.total) * 100);
            wbProgressPercent.textContent = `${percent}%`;
            wbProgressBar.style.width = `${percent}%`;
            
            wbStartBtn.disabled = true;
            wbStartBtn.textContent = 'Обработка...';
        } else {
            wbProgressContainer.style.display = 'none';
            wbStartBtn.disabled = false;
            wbStartBtn.textContent = 'Старт';
        }
    }

    function parseArticles(text) {
        return text.split('\n')
                   .map(s => s.trim())
                   .filter(s => /^\d+$/.test(s));
    }

    // --- History Logic ---
    function loadHistory() {
        chrome.storage.local.get({ notificationHistory: [] }, (result) => {
            renderHistory(result.notificationHistory);
        });
    }

    function renderHistory(history) {
        historyList.innerHTML = '';
        let filteredHistory = history;
        if (currentHistoryFilter) {
            filteredHistory = history.filter(entry => entry.itemId === currentHistoryFilter);
        }
        if (filteredHistory.length === 0) {
            historyList.innerHTML = '<div class="empty-message">История пуста</div>';
            return;
        }
        filteredHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        filteredHistory.forEach(entry => {
            const date = new Date(entry.timestamp);
            const historyElement = document.createElement('div');
            historyElement.className = 'history-item';
            const displayTitle = entry.title ? entry.title : entry.url;
            const platformTag = entry.platform === 'wildberries' ? '<span class="platform-tag wb">WB</span>' : '<span class="platform-tag ozon">Ozon</span>';
            
            historyElement.innerHTML = `
                <div class="history-header">
                    <span>${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU')}</span>
                    ${platformTag}
                </div>
                <div class="history-body">
                    <span class="entry-price ${entry.platform === 'wildberries' ? 'wb-brand-color' : ''}">${entry.price} ₽</span>
                    <span class="entry-target">Цель: ${entry.targetPrice} ₽</span>
                </div>
                <a href="${entry.url}" target="_blank" class="item-url ${entry.platform === 'wildberries' ? 'wb-link' : ''}" title="${displayTitle}">${displayTitle}</a>
            `;
            historyList.appendChild(historyElement);
        });
    }

    function updateLastCheckTime() {
        chrome.storage.local.get(['lastCheckTimestamp'], (result) => {
            if (result.lastCheckTimestamp) {
                const date = new Date(result.lastCheckTimestamp);
                lastCheckTimeSpan.textContent = `Последняя проверка: ${date.toLocaleString('ru-RU')}`;
            }
        });
    }

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.trackedItems) {
                renderItems(changes.trackedItems.newValue);
            }
            if (changes.notificationHistory) {
                if (document.getElementById('history-tab').classList.contains('active')) {
                    renderHistory(changes.notificationHistory.newValue);
                }
            }
            if (changes.lastCheckTimestamp) {
                const date = new Date(changes.lastCheckTimestamp.newValue);
                lastCheckTimeSpan.textContent = `Последняя проверка: ${date.toLocaleString('ru-RU')}`;
            }
            if (changes.wbLastResults) {
                renderWbResults(changes.wbLastResults.newValue);
            }
            if (changes.wbStatus) {
                updateWbProgress(changes.wbStatus.newValue);
            }
            if (changes.ozonReplyTemplates) {
                renderReplyTemplates(changes.ozonReplyTemplates.newValue);
            }
        }
    });

    // --- Ozon Auto-Reply Templates & Settings ---
    const delayEnabledCheck = document.getElementById('delayEnabled');
    const delayInputsContainer = document.getElementById('delayInputsContainer');
    const minDelayInput = document.getElementById('minDelay');
    const maxDelayInput = document.getElementById('maxDelay');

    const formTitle = document.getElementById('formTitle');
    const templateIdInput = document.getElementById('templateId');
    const templateTitleInput = document.getElementById('templateTitle');
    const templateTextInput = document.getElementById('templateText');
    const saveTemplateBtn = document.getElementById('saveTemplateBtn');
    const cancelTemplateBtn = document.getElementById('cancelTemplateBtn');
    const templatesList = document.getElementById('templatesList');

    // Load settings and templates initially
    loadReplySettings();
    loadReplyTemplates();

    // Toggle delay inputs visibility
    delayEnabledCheck.addEventListener('change', () => {
        delayInputsContainer.style.display = delayEnabledCheck.checked ? 'flex' : 'none';
        saveReplySettings();
    });

    minDelayInput.addEventListener('change', saveReplySettings);
    maxDelayInput.addEventListener('change', saveReplySettings);

    function loadReplySettings() {
        chrome.storage.local.get({
            ozonReplySettings: { delayEnabled: false, minDelay: 2, maxDelay: 5 }
        }, (result) => {
            const settings = result.ozonReplySettings;
            delayEnabledCheck.checked = settings.delayEnabled;
            delayInputsContainer.style.display = settings.delayEnabled ? 'flex' : 'none';
            minDelayInput.value = settings.minDelay || 2;
            maxDelayInput.value = settings.maxDelay || 5;
        });
    }

    function saveReplySettings() {
        const minVal = parseInt(minDelayInput.value, 10) || 2;
        const maxVal = parseInt(maxDelayInput.value, 10) || 5;
        chrome.storage.local.set({
            ozonReplySettings: {
                delayEnabled: delayEnabledCheck.checked,
                minDelay: minVal,
                maxDelay: maxVal
            }
        });
    }

    // CRUD templates
    saveTemplateBtn.addEventListener('click', () => {
        const title = templateTitleInput.value.trim();
        const text = templateTextInput.value.trim();
        const id = templateIdInput.value;

        if (!title || !text) {
            alert('Пожалуйста, заполните все поля шаблона');
            return;
        }

        chrome.storage.local.get({ ozonReplyTemplates: [] }, (result) => {
            const templates = result.ozonReplyTemplates;
            if (id) {
                // Edit mode
                const index = templates.findIndex(t => t.id === id);
                if (index !== -1) {
                    templates[index].title = title;
                    templates[index].text = text;
                }
            } else {
                // Create mode
                templates.push({
                    id: Date.now().toString(),
                    title: title,
                    text: text,
                    createdAt: new Date().toISOString()
                });
            }

            chrome.storage.local.set({ ozonReplyTemplates: templates }, () => {
                resetTemplateForm();
                loadReplyTemplates();
            });
        });
    });

    cancelTemplateBtn.addEventListener('click', resetTemplateForm);

    function resetTemplateForm() {
        formTitle.textContent = 'Новый шаблон';
        templateIdInput.value = '';
        templateTitleInput.value = '';
        templateTextInput.value = '';
        cancelTemplateBtn.style.display = 'none';
    }

    function loadReplyTemplates() {
        chrome.storage.local.get({ ozonReplyTemplates: [] }, (result) => {
            renderReplyTemplates(result.ozonReplyTemplates);
        });
    }

    function renderReplyTemplates(templates) {
        templatesList.innerHTML = '';
        if (templates.length === 0) {
            templatesList.innerHTML = '<div class="empty-message">Нет сохранённых шаблонов</div>';
            return;
        }

        templates.forEach(tpl => {
            const el = document.createElement('div');
            el.className = 'template-item';
            el.innerHTML = `
                <div class="template-item-header">
                    <span class="template-item-title">${escapeHtml(tpl.title)}</span>
                    <button class="delete-btn" data-id="${tpl.id}" title="Удалить">&times;</button>
                </div>
                <div class="template-item-text">${escapeHtml(tpl.text)}</div>
                <div class="template-actions">
                    <button class="edit-btn" data-id="${tpl.id}">Редактировать</button>
                </div>
            `;

            // Delete handler
            el.querySelector('.delete-btn').addEventListener('click', (e) => {
                const id = e.target.getAttribute('data-id');
                if (confirm('Вы уверены, что хотите удалить этот шаблон?')) {
                    deleteTemplate(id);
                }
            });

            // Edit handler
            el.querySelector('.edit-btn').addEventListener('click', (e) => {
                const id = e.target.getAttribute('data-id');
                startEditTemplate(id);
            });

            templatesList.appendChild(el);
        });
    }

    function deleteTemplate(id) {
        chrome.storage.local.get({ ozonReplyTemplates: [] }, (result) => {
            const filtered = result.ozonReplyTemplates.filter(t => t.id !== id);
            chrome.storage.local.set({ ozonReplyTemplates: filtered }, () => {
                loadReplyTemplates();
                // If editing deleted template, reset form
                if (templateIdInput.value === id) {
                    resetTemplateForm();
                }
            });
        });
    }

    function startEditTemplate(id) {
        chrome.storage.local.get({ ozonReplyTemplates: [] }, (result) => {
            const tpl = result.ozonReplyTemplates.find(t => t.id === id);
            if (tpl) {
                formTitle.textContent = 'Редактировать шаблон';
                templateIdInput.value = tpl.id;
                templateTitleInput.value = tpl.title;
                templateTextInput.value = tpl.text;
                cancelTemplateBtn.style.display = 'block';
                document.getElementById('reviews-tab').scrollTop = 0;
            }
        });
    }

    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, function(m) { return map[m]; });
    }
});
