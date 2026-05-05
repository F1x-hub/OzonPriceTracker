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
    const wbTrackedItemsList = document.getElementById('wbTrackedItemsList');

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

    // Load Ozon items on startup
    loadItems();
    updateLastCheckTime();
    loadInterval();

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
    loadWbResults();

    wbStartBtn.addEventListener('click', async () => {
        const text = wbArticlesInput.value.trim();
        if (!text) return;

        const articles = parseArticles(text);
        if (articles.length === 0) return;

        // Clear previous results from storage and DOM
        chrome.storage.local.set({ wbLastResults: {} });
        wbTrackedItemsList.innerHTML = '';
        
        articles.forEach(id => {
            const row = document.createElement('div');
            row.className = 'wb-item';
            row.id = `wb-row-${id}`;
            row.innerHTML = `
                <span class="wb-article">${id}</span>
                <span class="wb-wallet-price">загрузка...</span>
                <span class="wb-regular-price">загрузка...</span>
            `;
            wbTrackedItemsList.appendChild(row);
        });

        // 2. Message to background to fetch via DOM
        chrome.runtime.sendMessage(
            { action: 'fetchWbPrices', articles },
            (results) => {
                if (chrome.runtime.lastError) {
                    console.error("Runtime error:", chrome.runtime.lastError);
                    articles.forEach(id => updateWbRow(id, null, null));
                    return;
                }
                
                // Save results to storage
                chrome.storage.local.set({ wbLastResults: results });

                for (const [id, data] of Object.entries(results)) {
                    updateWbRow(id, data.wallet, data.total);
                }
            }
        );
    });

    function loadWbResults() {
        chrome.storage.local.get({ wbLastResults: {} }, (result) => {
            const results = result.wbLastResults;
            if (Object.keys(results).length > 0) {
                wbTrackedItemsList.innerHTML = '';
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
        });
    }

    function parseArticles(text) {
        return text.split('\n')
                   .map(s => s.trim())
                   .filter(s => /^\d+$/.test(s));
    }

    function updateWbRow(id, wallet, regular) {
        const row = document.getElementById(`wb-row-${id}`);
        if (!row) return;

        const walletSpan = row.querySelector('.wb-wallet-price');
        const regularSpan = row.querySelector('.wb-regular-price');

        const format = (val) => val != null ? val.toLocaleString('ru-RU') + ' ₽' : '—';

        walletSpan.textContent = format(wallet);
        regularSpan.textContent = format(regular);
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
        }
    });
});
