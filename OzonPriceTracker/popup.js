document.addEventListener('DOMContentLoaded', () => {
    const urlInput = document.getElementById('productUrl');
    const targetPriceInput = document.getElementById('targetPrice');
    const addBtn = document.getElementById('addBtn');
    const statusMessage = document.getElementById('statusMessage');
    const trackedItemsList = document.getElementById('trackedItemsList');
    const lastCheckTimeSpan = document.getElementById('lastCheckTime');
    const checkIntervalInput = document.getElementById('checkInterval');
    const saveIntervalBtn = document.getElementById('saveIntervalBtn');

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
            // Remove active class from all
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // Add active class to clicked
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            document.getElementById(targetId).classList.add('active');

            // If switching to history, load it
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

    // Load items on startup
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
                showStatus('Добавлено! Следующая проверка через 2 часа');
                urlInput.value = '';
                targetPriceInput.value = '';
                renderItems(items);
                
                // Trigger immediate check in background (optional, but good UX)
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

        // Sort by newest first
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

        // Add history link listeners
        document.querySelectorAll('.history-link-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                currentHistoryFilter = e.target.dataset.id;
                showAllHistoryBtn.style.display = 'block';
                
                // Switch to history tab
                document.querySelector('[data-tab="history-tab"]').click();
            });
        });

        // Add delete listeners
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                deleteItem(e.target.dataset.id);
            });
        });
    }

    function deleteItem(id) {
        chrome.storage.local.get({ trackedItems: [], notificationHistory: [] }, (result) => {
            const items = result.trackedItems.filter(item => item.id !== id);
            
            // Optionally, we could clean up history too, but keeping it might be useful.
            // Let's clean up related history to save space.
            const newHistory = result.notificationHistory.filter(entry => entry.itemId !== id);

            chrome.storage.local.set({ trackedItems: items, notificationHistory: newHistory }, () => {
                renderItems(items);
                if (document.getElementById('history-tab').classList.contains('active')) {
                    loadHistory();
                }
            });
        });
    }

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

        // Sort by newest first
        filteredHistory.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        filteredHistory.forEach(entry => {
            const date = new Date(entry.timestamp);
            const historyElement = document.createElement('div');
            historyElement.className = 'history-item';
            
            const displayTitle = entry.title ? entry.title : entry.url;
            
            historyElement.innerHTML = `
                <div class="history-header">
                    <span>${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU')}</span>
                </div>
                <div class="history-body">
                    <span class="entry-price">${entry.price} ₽</span>
                    <span class="entry-target">Цель: ${entry.targetPrice} ₽</span>
                </div>
                <a href="${entry.url}" target="_blank" class="item-url" title="${displayTitle}">${displayTitle}</a>
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

    // Listen for updates from background script
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.trackedItems) {
                renderItems(changes.trackedItems.newValue);
            }
            if (changes.notificationHistory) {
                // Only update if history tab is active
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
