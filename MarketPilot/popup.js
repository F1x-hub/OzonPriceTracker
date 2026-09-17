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

    // Citilink elements
    const citilinkArticlesInput = document.getElementById('citilinkArticles');
    const citilinkStartBtn = document.getElementById('citilinkStartBtn');
    const citilinkExportBtn = document.getElementById('citilinkExportBtn');
    const citilinkClearBtn = document.getElementById('citilinkClearBtn');
    const citilinkResultsList = document.getElementById('citilinkResultsList');
    const citilinkProgressContainer = document.getElementById('citilinkProgressContainer');
    const citilinkProgressText = document.getElementById('citilinkProgressText');
    const citilinkProgressPercent = document.getElementById('citilinkProgressPercent');
    const citilinkProgressBar = document.getElementById('citilinkProgressBar');
    
    // Progress Bar elements
    const wbProgressContainer = document.getElementById('wbProgressContainer');
    const wbProgressText = document.getElementById('wbProgressText');
    const wbProgressPercent = document.getElementById('wbProgressPercent');
    const wbProgressBar = document.getElementById('wbProgressBar');

    function updateExtensionSettings(values, callback) {
        chrome.runtime.sendMessage({ action: 'settings_update', values }, (response) => {
            if (chrome.runtime.lastError) {
                callback?.(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response?.success === false || response?.status === 'error') {
                callback?.(new Error(response.error || 'Не удалось сохранить настройки.'));
                return;
            }
            callback?.(null, response);
        });
    }

    function logActivity(entry) {
        chrome.runtime.sendMessage({ action: 'history_append', entry }, () => {
            // History logging must not interrupt the primary user action.
            void chrome.runtime.lastError;
        });
    }

    function clearCollectionResults(marketplace, callback) {
        chrome.runtime.sendMessage({ action: 'collection_clear', marketplace }, (response) => {
            if (chrome.runtime.lastError) {
                callback?.(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response?.success === false || response?.status === 'error') {
                callback?.(new Error(response.error || 'Не удалось очистить результаты.'));
                return;
            }
            callback?.(null, response);
        });
    }

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
        logActivity({
            action: 'wb_export',
            title: 'Wildberries: экспорт создан',
            message: `Позиций: ${rows.length}.`,
            platform: 'wildberries'
        });
    });

    // Clear WB Logic
    wbClearBtn.addEventListener('click', () => {
        if (confirm('Очистить результаты Wildberries?')) {
            clearCollectionResults('wb', (error) => {
                if (error) {
                    showStatus(error.message, true);
                    return;
                }
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
            } else if (targetId === 'ai-questions-tab') {
                loadAiSettings();
            }
        });
    });

    // Clear history
    clearHistoryBtn.addEventListener('click', () => {
        if (confirm('Вы уверены, что хотите очистить всю историю?')) {
            chrome.runtime.sendMessage({ action: 'history_clear' }, (response) => {
                if (chrome.runtime.lastError || response?.success === false || response?.status === 'error') {
                    showStatus('Не удалось очистить историю.', true);
                    return;
                }
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
    loadCitilinkState();

    saveIntervalBtn.addEventListener('click', () => {
        const newInterval = parseInt(checkIntervalInput.value, 10);
        if (isNaN(newInterval) || newInterval < 1) {
            showStatus('Введите корректный интервал (целое число 1 и более)', true);
            return;
        }
        updateExtensionSettings({ checkInterval: newInterval }, (error) => {
            if (error) {
                showStatus(error.message, true);
                return;
            }
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

        if (!url || !/(^|\.)ozon\.(ru|com)(\/|$)/i.test(url)) {
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
        const newItem = {
            id: Date.now().toString(),
            url: url,
            title: null,
            targetPrice: targetPrice,
            priceType: priceType,
            lastPrice: null,
            addedAt: new Date().toISOString()
        };
        chrome.runtime.sendMessage({ action: 'tracking_upsert', item: newItem }, (response) => {
            if (chrome.runtime.lastError || response?.success === false || response?.status === 'error') {
                showStatus('Не удалось сохранить товар.', true);
                return;
            }
            showStatus('Добавлено!');
            urlInput.value = '';
            targetPriceInput.value = '';
            loadItems();
            chrome.runtime.sendMessage({ action: "checkPricesNow" });
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
            const hasLastPrice = item.lastPrice !== null && item.lastPrice !== undefined && item.lastPrice !== '' && Number.isFinite(Number(item.lastPrice));
            const lastPriceDisplay = hasLastPrice ? `${Number(item.lastPrice).toLocaleString('ru-RU')} ₽` : 'Ожидание...';
            const isGoalMet = hasLastPrice && Number(item.lastPrice) <= Number(item.targetPrice);
            const priceClass = isGoalMet ? 'item-price goal-met' : 'item-price';
            const displayTitle = item.title ? item.title : item.url;

            const link = document.createElement('a');
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.className = 'item-url';
            link.title = displayTitle;
            link.textContent = displayTitle;
            itemElement.appendChild(link);

            const targetDetails = document.createElement('div');
            targetDetails.className = 'item-details';
            const target = document.createElement('span');
            target.textContent = 'Цель: ';
            const targetValue = document.createElement('strong');
            targetValue.textContent = `${Number(item.targetPrice).toLocaleString('ru-RU')} ₽`;
            target.appendChild(targetValue);
            const type = document.createElement('span');
            type.textContent = ` (${typeLabel})`;
            targetDetails.append(target, type);
            itemElement.appendChild(targetDetails);

            const priceDetails = document.createElement('div');
            priceDetails.className = 'item-details';
            priceDetails.style.marginTop = '2px';
            const current = document.createElement('span');
            current.textContent = 'Текущая цена: ';
            const currentValue = document.createElement('span');
            currentValue.className = priceClass;
            currentValue.textContent = lastPriceDisplay;
            current.appendChild(currentValue);
            priceDetails.appendChild(current);
            itemElement.appendChild(priceDetails);

            const actions = document.createElement('div');
            actions.className = 'item-actions';
            const historyButton = document.createElement('button');
            historyButton.className = 'history-link-btn';
            historyButton.dataset.id = item.id;
            historyButton.type = 'button';
            historyButton.textContent = 'Посмотреть историю';
            actions.appendChild(historyButton);
            itemElement.appendChild(actions);

            const deleteButton = document.createElement('button');
            deleteButton.className = 'delete-btn';
            deleteButton.dataset.id = item.id;
            deleteButton.title = 'Удалить';
            deleteButton.type = 'button';
            deleteButton.textContent = '×';
            itemElement.appendChild(deleteButton);
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
        chrome.runtime.sendMessage({ action: 'tracking_remove', id }, (response) => {
            if (chrome.runtime.lastError || response?.success === false || response?.status === 'error') {
                showStatus('Не удалось удалить товар.', true);
                return;
            }
            chrome.runtime.sendMessage({ action: 'history_remove_for_item', itemId: id }, (historyResponse) => {
                if (chrome.runtime.lastError || historyResponse?.success === false || historyResponse?.status === 'error') {
                    showStatus('Товар удалён, но историю очистить не удалось.', true);
                    return;
                }
                loadItems();
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

    // --- Citilink Product Export Logic ---

    citilinkStartBtn.addEventListener('click', () => {
        const articles = parseCitilinkArticles(citilinkArticlesInput.value);
        if (articles.length === 0) {
            alert('Введите хотя бы один код товара Citilink');
            return;
        }

        citilinkStartBtn.disabled = true;
        citilinkStartBtn.textContent = 'Обработка...';
        chrome.runtime.sendMessage({ action: 'fetchCitilinkProducts', articles }, response => {
            if (chrome.runtime.lastError) {
                alert(`Не удалось запустить обработку: ${chrome.runtime.lastError.message}`);
                updateCitilinkProgress({ total: 0, done: 0, running: false });
                return;
            }
            console.log('Citilink fetch started:', response);
        });
    });

    citilinkExportBtn.addEventListener('click', () => {
        chrome.storage.local.get({ citilinkLastResults: {} }, result => {
            const items = Object.values(result.citilinkLastResults || {});
            if (items.length === 0) {
                alert('Нет данных для экспорта');
                return;
            }

            const data = [[
                'Код товара',
                'Бренд',
                'Название товара',
                'Описание для Avito',
                'Ссылки на картинки',
                'Количество фото',
                'Статус'
            ]];

            items.forEach(item => {
                data.push([
                    item.article || '',
                    item.brand || '',
                    item.name || '',
                    item.description || '',
                    (item.imageUrls || []).join(' | '),
                    getCitilinkImageCount(item),
                    item.status === 'done' ? 'Готово' : (item.error || 'В обработке')
                ]);
            });

            const workbook = XLSX.utils.book_new();
            const worksheet = XLSX.utils.aoa_to_sheet(data);
            worksheet['!cols'] = [
                { wch: 14 },
                { wch: 16 },
                { wch: 42 },
                { wch: 70 },
                { wch: 45 },
                { wch: 16 },
                { wch: 32 }
            ];
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Citilink');

            const date = new Date().toISOString().split('T')[0];
            XLSX.writeFile(workbook, `citilink_avito_${date}.xlsx`);
            logActivity({
                action: 'citilink_export',
                title: 'Citilink: экспорт создан',
                message: `Позиций: ${items.length}.`,
                platform: 'citilink'
            });
        });
    });

    citilinkClearBtn.addEventListener('click', () => {
        if (!confirm('Очистить результаты Citilink?')) return;

        clearCollectionResults('citilink', (error) => {
            if (error) {
                showStatus(error.message, true);
                return;
            }
            renderCitilinkResults({});
            updateCitilinkProgress({ total: 0, done: 0, running: false });
        });
    });

    function parseCitilinkArticles(text) {
        return Array.from(new Set(String(text || '')
            .split(/[\s,;]+/)
            .map(value => value.trim())
            .filter(value => /^\d+$/.test(value))));
    }

    function getCitilinkImageCount(item) {
        const storedCount = Number(item?.imageCount);
        if (Number.isFinite(storedCount) && storedCount >= 0) {
            return Math.floor(storedCount);
        }

        return Array.isArray(item?.imageUrls) ? item.imageUrls.length : 0;
    }

    function loadCitilinkState() {
        chrome.storage.local.get({
            citilinkLastResults: {},
            citilinkStatus: { total: 0, done: 0, running: false, phase: 'idle', error: '' }
        }, result => {
            renderCitilinkResults(result.citilinkLastResults);
            updateCitilinkProgress(result.citilinkStatus);
        });
    }

    function renderCitilinkResults(results) {
        citilinkResultsList.innerHTML = '';
        if (!results || Object.keys(results).length === 0) {
            citilinkResultsList.innerHTML = '<div class="empty-message">Нет результатов Citilink</div>';
            return;
        }

        const statusLabels = {
            searching: 'Поиск товара',
            processing: 'Обработка AI',
            done: 'Готово',
            error: 'Ошибка'
        };

        Object.values(results).forEach(item => {
            const row = document.createElement('div');
            row.className = 'citilink-item';
            const status = statusLabels[item.status] || 'Ожидание';
            const detail = item.status === 'error' ? item.error : item.description;
            row.innerHTML = `
                <div class="citilink-article">${escapeHtml(item.article || '')}</div>
                <div class="citilink-brand">${escapeHtml(item.brand || '—')}</div>
                <div class="citilink-photo">Фото: ${getCitilinkImageCount(item)}</div>
                <div class="citilink-status ${item.status || 'pending'}">${escapeHtml(status)}</div>
                <div class="citilink-details">
                    <div class="citilink-name">${escapeHtml(item.name || '')}</div>
                    ${detail ? `<div class="citilink-description">${escapeHtml(detail)}</div>` : ''}
                </div>
            `;
            citilinkResultsList.appendChild(row);
        });
    }

    function updateCitilinkProgress(status) {
        const total = Number(status?.total) || 0;
        const done = Math.min(Number(status?.done) || 0, total);
        if (total === 0) {
            citilinkProgressContainer.style.display = 'none';
            citilinkStartBtn.disabled = false;
            citilinkStartBtn.textContent = 'Собрать и обработать';
            return;
        }

        citilinkProgressContainer.style.display = 'block';
        citilinkProgressText.textContent = `Обработано: ${done} из ${total}`;
        const percent = Math.round((done / total) * 100);
        citilinkProgressPercent.textContent = `${percent}%`;
        citilinkProgressBar.style.width = `${percent}%`;

        if (status.running) {
            citilinkStartBtn.disabled = true;
            citilinkStartBtn.textContent = 'Обработка...';
        } else {
            citilinkStartBtn.disabled = false;
            citilinkStartBtn.textContent = 'Собрать и обработать';
        }
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
            filteredHistory = history.filter(entry => entry.itemId === currentHistoryFilter || entry.entityId === currentHistoryFilter);
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
            const displayTitle = entry.title || entry.url || 'Действие MarketPilot';
            const statusLabels = { started: 'Запущено', success: 'Успешно', completed: 'Завершено', partial: 'Частично', error: 'Ошибка', noop: 'Без изменений' };
            const status = statusLabels[entry.status] || (entry.type === 'price_alert' ? 'Уведомление' : 'Событие');
            const statusClass = entry.status === 'error' ? 'error' : entry.status === 'partial' ? 'warning' : entry.status === 'started' ? 'info' : 'success';
            const platformLabels = { ozon: 'Ozon', wildberries: 'WB', citilink: 'Citilink' };
            const platform = platformLabels[entry.platform] || 'MarketPilot';
            const message = entry.message || (Number.isFinite(Number(entry.price))
                ? `Цена ${Number(entry.price).toLocaleString('ru-RU')} ₽ · цель ${Number(entry.targetPrice || 0).toLocaleString('ru-RU')} ₽`
                : 'Событие без дополнительного описания.');
            historyElement.innerHTML = `
                <div class="history-header">
                    <span class="history-date"></span>
                    <span class="platform-tag"></span>
                </div>
                <div class="history-body">
                    <strong class="history-action-title"></strong>
                    <span class="history-status"></span>
                </div>
                <p class="history-action-message"></p>
            `;
            historyElement.querySelector('.history-date').textContent = Number.isNaN(date.getTime())
                ? 'Дата неизвестна'
                : `${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU')}`;
            historyElement.querySelector('.platform-tag').textContent = platform;
            historyElement.querySelector('.history-action-title').textContent = displayTitle;
            const statusElement = historyElement.querySelector('.history-status');
            statusElement.textContent = status;
            statusElement.classList.add(statusClass);
            historyElement.querySelector('.history-action-message').textContent = message;
            if (entry.url) {
                const link = document.createElement('a');
                link.href = entry.url;
                link.target = '_blank';
                link.rel = 'noreferrer';
                link.className = 'item-url';
                link.title = displayTitle;
                link.textContent = 'Открыть карточку';
                historyElement.appendChild(link);
            }
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
            if (changes.citilinkLastResults) {
                renderCitilinkResults(changes.citilinkLastResults.newValue);
            }
            if (changes.citilinkStatus) {
                updateCitilinkProgress(changes.citilinkStatus.newValue);
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
    notifySellerReviewsTab();

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
        updateExtensionSettings({
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

            updateExtensionSettings({ ozonReplyTemplates: templates }, (error) => {
                if (error) {
                    showStatus(error.message, true);
                    return;
                }
                resetTemplateForm();
                loadReplyTemplates();
                notifySellerReviewsTab();
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

    function notifySellerReviewsTab() {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !tab.id || !tab.url || !tab.url.includes('seller.ozon.ru/app/reviews')) return;

            chrome.tabs.sendMessage(tab.id, { action: 'refreshReplyTemplates' }, () => {
                void chrome.runtime.lastError;
            });
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
            updateExtensionSettings({ ozonReplyTemplates: filtered }, (error) => {
                if (error) {
                    showStatus(error.message, true);
                    return;
                }
                loadReplyTemplates();
                notifySellerReviewsTab();
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

    // =========================================================================
    // AI QUESTIONS & DEEPSEEK DASHBOARD
    // =========================================================================

    const DEFAULT_PROMPT = `Ты — вежливый и компетентный представитель магазина на Ozon. Твоя задача — профессионально ответить на вопрос покупателя о товаре.
Правила:
1. Обращайся к покупателю вежливо и по имени (если указано).
2. Отвечай строго по существу вопроса, помогая принять решение о покупке.
3. Если вопрос о совместимости (например, подойдет ли пульт к определенной модели техники): поясни, что если модель указана в описании или совпадает с оригинальным пультом, то устройство гарантированно подойдет. Если модель старая или редкая, посоветуй сверить расположение и назначение основных кнопок со старым пультом или задать уточняющий вопрос.
4. Ответ должен быть лаконичным, уверенным и доброжелательным (2-5 предложений).
5. Завершай ответ пожеланием приятных покупок или отличного настроения.`;

    const DEFAULT_REVIEW_PROMPT = `Ты — вежливый и внимательный представитель магазина на Ozon. Твоя задача — ответить на отзыв покупателя о товаре.
Правила:
1. Поблагодари покупателя за отзыв и обратись к сути его впечатления.
2. Отвечай доброжелательно и профессионально, не спорь с покупателем и не выдумывай факты.
3. Если отзыв негативный, признай неудобство и предложи обратиться в поддержку магазина для решения вопроса.
4. Ответ должен быть лаконичным — 2-4 предложения, без markdown-разметки и служебных комментариев.
5. Заверши ответ пожеланием приятных покупок.`;

    const DEFAULT_CITILINK_PROMPT = `Ты — редактор объявлений для Avito.
Подготовь только готовое описание товара на русском языке на основе данных Citilink.
Правила:
1. Не выдумывай характеристики, комплектацию, цену, наличие и преимущества, которых нет в исходных данных.
2. Сохрани важные технические характеристики, модель и бренд.
3. Сделай текст понятным, аккуратным и подходящим для объявления Avito.
4. Не добавляй заголовок, цену, ссылки, служебные комментарии и markdown-разметку.
5. Верни только итоговый текст описания.`;

    const deepseekStatusBadge = document.getElementById('deepseekStatusBadge');
    const deepseekApiKeyInput = document.getElementById('deepseekApiKey');
    const toggleApiKeyVisibilityBtn = document.getElementById('toggleApiKeyVisibility');
    const saveDeepSeekKeyBtn = document.getElementById('saveDeepSeekKeyBtn');
    const deepseekKeyStatusMsg = document.getElementById('deepseekKeyStatusMsg');
    const refreshBalanceBtn = document.getElementById('refreshBalanceBtn');
    const deepseekBalanceValue = document.getElementById('deepseekBalanceValue');
    const deepseekBalanceRub = document.getElementById('deepseekBalanceRub');
    const deepseekStatRequests = document.getElementById('deepseekStatRequests');
    const deepseekStatTokens = document.getElementById('deepseekStatTokens');
    const deepseekStatCost = document.getElementById('deepseekStatCost');
    const resetStatsBtn = document.getElementById('resetStatsBtn');
    const resetPromptBtn = document.getElementById('resetPromptBtn');
    const deepseekSystemPrompt = document.getElementById('deepseekSystemPrompt');
    const resetReviewPromptBtn = document.getElementById('resetReviewPromptBtn');
    const deepseekReviewPrompt = document.getElementById('deepseekReviewPrompt');
    const resetCitilinkPromptBtn = document.getElementById('resetCitilinkPromptBtn');
    const deepseekCitilinkPrompt = document.getElementById('deepseekCitilinkPrompt');
    const promptChips = document.querySelectorAll('.prompt-chip');
    const deepseekAutoSendCheck = document.getElementById('deepseekAutoSend');
    const deepseekModelSelect = document.getElementById('deepseekModelSelect');
    const deepseekCustomModelContainer = document.getElementById('deepseekCustomModelContainer');
    const deepseekCustomModelInput = document.getElementById('deepseekCustomModelInput');
    const deepseekDelayInput = document.getElementById('deepseekDelay');
    const saveAllAiSettingsBtn = document.getElementById('saveAllAiSettingsBtn');
    const aiSettingsSavedMsg = document.getElementById('aiSettingsSavedMsg');

    function getEffectiveModel() {
        if (!deepseekModelSelect) return 'deepseek-flash';
        if (deepseekModelSelect.value === 'custom') {
            return (deepseekCustomModelInput?.value || '').trim() || 'deepseek-flash';
        }
        return deepseekModelSelect.value;
    }

    function updateCustomModelVisibility() {
        if (!deepseekModelSelect || !deepseekCustomModelContainer) return;
        if (deepseekModelSelect.value === 'custom') {
            deepseekCustomModelContainer.style.display = 'flex';
            if (deepseekCustomModelInput) deepseekCustomModelInput.focus();
        } else {
            deepseekCustomModelContainer.style.display = 'none';
        }
    }

    if (deepseekModelSelect) {
        deepseekModelSelect.addEventListener('change', () => {
            updateCustomModelVisibility();
            const effectiveModel = getEffectiveModel();
            updateExtensionSettings({ deepseekModel: effectiveModel });
        });
    }

    if (deepseekCustomModelInput) {
        let modelTimeout = null;
        deepseekCustomModelInput.addEventListener('input', () => {
            if (deepseekModelSelect?.value === 'custom') {
                clearTimeout(modelTimeout);
                modelTimeout = setTimeout(() => {
                    const val = deepseekCustomModelInput.value.trim();
                    if (val) updateExtensionSettings({ deepseekModel: val });
                }, 500);
            }
        });
        deepseekCustomModelInput.addEventListener('blur', () => {
            if (deepseekModelSelect?.value === 'custom') {
                clearTimeout(modelTimeout);
                const val = deepseekCustomModelInput.value.trim();
                if (val) updateExtensionSettings({ deepseekModel: val });
            }
        });
    }

    // Toggle API Key visibility
    if (toggleApiKeyVisibilityBtn && deepseekApiKeyInput) {
        toggleApiKeyVisibilityBtn.addEventListener('click', () => {
            if (deepseekApiKeyInput.type === 'password') {
                deepseekApiKeyInput.type = 'text';
                toggleApiKeyVisibilityBtn.textContent = '🔒';
            } else {
                deepseekApiKeyInput.type = 'password';
                toggleApiKeyVisibilityBtn.textContent = '👁️';
            }
        });
    }

    // Auto-save prompt on input/change so user changes are never lost
    if (deepseekSystemPrompt) {
        let saveTimeout = null;
        deepseekSystemPrompt.addEventListener('input', () => {
            clearTimeout(saveTimeout);
            saveTimeout = setTimeout(() => {
                const val = (deepseekSystemPrompt.value || '').trim() || DEFAULT_PROMPT;
                updateExtensionSettings({ deepseekPrompt: val });
            }, 500);
        });
        deepseekSystemPrompt.addEventListener('blur', () => {
            clearTimeout(saveTimeout);
            const val = (deepseekSystemPrompt.value || '').trim() || DEFAULT_PROMPT;
            updateExtensionSettings({ deepseekPrompt: val });
        });
    }

    if (deepseekReviewPrompt) {
        let reviewPromptTimeout = null;
        const saveReviewPrompt = () => {
            const val = (deepseekReviewPrompt.value || '').trim() || DEFAULT_REVIEW_PROMPT;
            updateExtensionSettings({ deepseekReviewPrompt: val });
        };

        deepseekReviewPrompt.addEventListener('input', () => {
            clearTimeout(reviewPromptTimeout);
            reviewPromptTimeout = setTimeout(saveReviewPrompt, 500);
        });
        deepseekReviewPrompt.addEventListener('blur', () => {
            clearTimeout(reviewPromptTimeout);
            saveReviewPrompt();
        });
    }

    if (deepseekCitilinkPrompt) {
        let citilinkPromptTimeout = null;
        const saveCitilinkPrompt = () => {
            const val = (deepseekCitilinkPrompt.value || '').trim() || DEFAULT_CITILINK_PROMPT;
            updateExtensionSettings({ deepseekCitilinkPrompt: val });
        };

        deepseekCitilinkPrompt.addEventListener('input', () => {
            clearTimeout(citilinkPromptTimeout);
            citilinkPromptTimeout = setTimeout(saveCitilinkPrompt, 500);
        });
        deepseekCitilinkPrompt.addEventListener('blur', () => {
            clearTimeout(citilinkPromptTimeout);
            saveCitilinkPrompt();
        });
    }

    // Insert prompt chips into textarea
    promptChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const tag = chip.getAttribute('data-chip');
            const targetType = chip.getAttribute('data-target');
            const target = targetType === 'citilink'
                ? deepseekCitilinkPrompt
                : targetType === 'review'
                    ? deepseekReviewPrompt
                    : deepseekSystemPrompt;
            if (!tag || !target) return;
            const start = target.selectionStart;
            const end = target.selectionEnd;
            const text = target.value;
            target.value = text.substring(0, start) + tag + text.substring(end);
            target.focus();
            target.setSelectionRange(start + tag.length, start + tag.length);
            const storageKey = target === deepseekCitilinkPrompt
                ? 'deepseekCitilinkPrompt'
                : target === deepseekReviewPrompt
                    ? 'deepseekReviewPrompt'
                    : 'deepseekPrompt';
            updateExtensionSettings({ [storageKey]: target.value });
        });
    });

    // Reset prompt button
    if (resetPromptBtn) {
        resetPromptBtn.addEventListener('click', () => {
            if (confirm('Сбросить промпт ответов на вопросы на стандартный?')) {
                deepseekSystemPrompt.value = DEFAULT_PROMPT;
                updateExtensionSettings({ deepseekPrompt: DEFAULT_PROMPT });
            }
        });
    }

    if (resetReviewPromptBtn) {
        resetReviewPromptBtn.addEventListener('click', () => {
            if (confirm('Сбросить промпт ответов на отзывы на стандартный?')) {
                deepseekReviewPrompt.value = DEFAULT_REVIEW_PROMPT;
                updateExtensionSettings({ deepseekReviewPrompt: DEFAULT_REVIEW_PROMPT });
            }
        });
    }

    if (resetCitilinkPromptBtn) {
        resetCitilinkPromptBtn.addEventListener('click', () => {
            if (confirm('Сбросить промпт обработки Citilink на стандартный?')) {
                deepseekCitilinkPrompt.value = DEFAULT_CITILINK_PROMPT;
                updateExtensionSettings({ deepseekCitilinkPrompt: DEFAULT_CITILINK_PROMPT });
            }
        });
    }

    // Save & Verify Key button
    if (saveDeepSeekKeyBtn) {
        saveDeepSeekKeyBtn.addEventListener('click', () => {
            const key = (deepseekApiKeyInput.value || '').trim();
            if (!key) {
                showKeyStatus('Укажите API-ключ перед проверкой', 'error');
                return;
            }

            saveDeepSeekKeyBtn.disabled = true;
            saveDeepSeekKeyBtn.textContent = 'Проверка...';
            showKeyStatus('Связываемся с DeepSeek API...', 'info');

            chrome.runtime.sendMessage({ action: 'deepseek_check_balance', apiKey: key }, (res) => {
                saveDeepSeekKeyBtn.disabled = false;
                saveDeepSeekKeyBtn.textContent = 'Проверить';

                if (res && res.success) {
                    updateExtensionSettings({ deepseekApiKey: key }, (error) => {
                        if (error) {
                            showKeyStatus(error.message, 'error');
                            return;
                        }
                        showKeyStatus('Ключ валиден и сохранен!', 'success');
                        renderBalanceInfo(res.balanceInfo);
                        setBadgeStatus(true);
                    });
                } else {
                    const err = res?.error || 'Не удалось проверить ключ';
                    showKeyStatus(`Ошибка: ${err}`, 'error');
                    setBadgeStatus(false, 'Ошибка ключа');
                }
            });
        });
    }

    // Refresh balance button
    if (refreshBalanceBtn) {
        refreshBalanceBtn.addEventListener('click', () => {
            refreshBalanceBtn.disabled = true;
            refreshBalanceBtn.textContent = 'Загрузка...';

            chrome.runtime.sendMessage({ action: 'deepseek_check_balance' }, (res) => {
                refreshBalanceBtn.disabled = false;
                refreshBalanceBtn.textContent = '🔄 Обновить';

                if (res && res.success) {
                    renderBalanceInfo(res.balanceInfo);
                    setBadgeStatus(true);
                } else {
                    const err = res?.error || 'Ошибка обновления баланса';
                    deepseekBalanceSub.textContent = err;
                    setBadgeStatus(false, 'Ошибка');
                }
            });
        });
    }

    // Reset stats button
    if (resetStatsBtn) {
        resetStatsBtn.addEventListener('click', () => {
            if (confirm('Сбросить статистику использованных токенов и расходов?')) {
                chrome.runtime.sendMessage({ action: 'deepseek_reset_stats' }, (res) => {
                    if (res && res.success) {
                        renderStats(res.stats);
                    }
                });
            }
        });
    }

    // Save all settings button
    if (saveAllAiSettingsBtn) {
        saveAllAiSettingsBtn.addEventListener('click', () => {
            const key = (deepseekApiKeyInput.value || '').trim();
            const prompt = (deepseekSystemPrompt.value || '').trim() || DEFAULT_PROMPT;
            const reviewPrompt = (deepseekReviewPrompt.value || '').trim() || DEFAULT_REVIEW_PROMPT;
            const citilinkPrompt = (deepseekCitilinkPrompt.value || '').trim() || DEFAULT_CITILINK_PROMPT;
            const model = getEffectiveModel();
            const autoSend = deepseekAutoSendCheck.checked;
            const delay = parseInt(deepseekDelayInput.value, 10) || 3;

            updateExtensionSettings({
                deepseekApiKey: key,
                deepseekPrompt: prompt,
                deepseekReviewPrompt: reviewPrompt,
                deepseekCitilinkPrompt: citilinkPrompt,
                deepseekModel: model,
                deepseekAutoSend: autoSend,
                deepseekDelay: delay
            }, (error) => {
                if (error) {
                    aiSettingsSavedMsg.textContent = error.message;
                    aiSettingsSavedMsg.className = 'status-error';
                    return;
                }
                aiSettingsSavedMsg.textContent = '✓ Настройки успешно сохранены!';
                aiSettingsSavedMsg.className = 'status-success';
                setTimeout(() => {
                    aiSettingsSavedMsg.className = 'status-hidden';
                }, 2500);

                if (key) {
                    chrome.runtime.sendMessage({ action: 'deepseek_check_balance', apiKey: key }, (res) => {
                        if (res && res.success) {
                            renderBalanceInfo(res.balanceInfo);
                            setBadgeStatus(true);
                        } else {
                            setBadgeStatus(false, 'Ошибка ключа');
                        }
                    });
                } else {
                    setBadgeStatus(false, 'Не настроен');
                }
            });
        });
    }

    function showKeyStatus(text, type) {
        if (!deepseekKeyStatusMsg) return;
        deepseekKeyStatusMsg.textContent = text;
        if (type === 'success') {
            deepseekKeyStatusMsg.style.color = '#16a34a';
        } else if (type === 'error') {
            deepseekKeyStatusMsg.style.color = '#dc2626';
        } else {
            deepseekKeyStatusMsg.style.color = '#005bff';
        }
    }

    function setBadgeStatus(isActive, customLabel) {
        if (!deepseekStatusBadge) return;
        if (isActive) {
            deepseekStatusBadge.textContent = 'Активен';
            deepseekStatusBadge.className = 'ai-badge active';
        } else {
            deepseekStatusBadge.textContent = customLabel || 'Не подключен';
            deepseekStatusBadge.className = 'ai-badge error';
        }
    }

    function renderBalanceInfo(data) {
        if (!data || !data.balance_infos || !data.balance_infos[0]) {
            if (deepseekBalanceValue) deepseekBalanceValue.textContent = '—';
            if (deepseekBalanceRub) deepseekBalanceRub.textContent = 'Баланс недоступен';
            return;
        }

        const info = data.balance_infos[0];
        const currency = info.currency || 'CNY';
        const total = parseFloat(info.total_balance || '0');
        const symbol = currency === 'CNY' ? '¥' : '$';

        if (deepseekBalanceValue) {
            deepseekBalanceValue.textContent = `${symbol} ${total.toFixed(2)} ${currency}`;
        }

        if (deepseekBalanceRub) {
            if (currency === 'CNY') {
                const approxRub = (total * 13.5).toFixed(0);
                deepseekBalanceRub.textContent = `≈ ${approxRub} ₽ (курс 1 CNY ≈ 13.5 ₽)`;
            } else if (currency === 'USD') {
                const approxRub = (total * 95).toFixed(0);
                deepseekBalanceRub.textContent = `≈ ${approxRub} ₽`;
            } else {
                deepseekBalanceRub.textContent = `Доступно: ${total.toFixed(2)}`;
            }
        }
    }

    function renderStats(stats) {
        const s = stats || {};
        if (deepseekStatRequests) deepseekStatRequests.textContent = s.totalRequests || 0;
        if (deepseekStatTokens) {
            const tok = s.totalTokens || 0;
            deepseekStatTokens.textContent = tok > 1000000 ? (tok / 1000000).toFixed(1) + 'M' : (tok > 1000 ? (tok / 1000).toFixed(1) + 'k' : tok);
        }
        if (deepseekStatCost) {
            const cost = Number(s.totalCost ?? s.cost ?? s.estimatedCostUSD ?? s.estimatedCostCNY) || 0;
            const currency = String(s.currency || 'USD').trim().toUpperCase();
            const symbol = currency === 'USD' ? '$' : (currency === 'CNY' ? '¥' : `${currency} `);
            deepseekStatCost.textContent = `${symbol}${cost.toFixed(2)}`;
        }
    }

    function loadAiSettings() {
        chrome.storage.local.get({
            deepseekApiKey: '',
            deepseekPrompt: DEFAULT_PROMPT,
            deepseekReviewPrompt: DEFAULT_REVIEW_PROMPT,
            deepseekCitilinkPrompt: DEFAULT_CITILINK_PROMPT,
            deepseekModel: 'deepseek-flash',
            deepseekAutoSend: false,
            deepseekDelay: 3,
            deepseekStats: {
                totalRequests: 0,
                totalPromptTokens: 0,
                totalCompletionTokens: 0,
                totalTokens: 0,
                estimatedCostUSD: 0
            },
            deepseekOfficialUsage: null,
            deepseekLastBalance: null
        }, (res) => {
            if (deepseekApiKeyInput) deepseekApiKeyInput.value = res.deepseekApiKey || '';
            if (deepseekSystemPrompt) deepseekSystemPrompt.value = res.deepseekPrompt || DEFAULT_PROMPT;
            if (deepseekReviewPrompt) deepseekReviewPrompt.value = res.deepseekReviewPrompt || DEFAULT_REVIEW_PROMPT;
            if (deepseekCitilinkPrompt) deepseekCitilinkPrompt.value = res.deepseekCitilinkPrompt || DEFAULT_CITILINK_PROMPT;

            const storedModel = ({ 'deepseek-chat': 'deepseek-flash', 'deepseek-reasoner': 'deepseek-flash', 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' })[String(res.deepseekModel || '').toLowerCase()] || res.deepseekModel || 'deepseek-flash';
            const standardModels = ['deepseek-flash', 'deepseek-v4-pro'];

            if (standardModels.includes(storedModel)) {
                if (deepseekModelSelect) deepseekModelSelect.value = storedModel;
                if (deepseekCustomModelContainer) deepseekCustomModelContainer.style.display = 'none';
            } else {
                if (deepseekModelSelect) deepseekModelSelect.value = 'custom';
                if (deepseekCustomModelContainer) deepseekCustomModelContainer.style.display = 'flex';
                if (deepseekCustomModelInput) deepseekCustomModelInput.value = storedModel;
            }

            if (deepseekAutoSendCheck) deepseekAutoSendCheck.checked = !!res.deepseekAutoSend;
            if (deepseekDelayInput) deepseekDelayInput.value = res.deepseekDelay || 3;

            renderStats(res.deepseekStats);

            if (res.deepseekLastBalance) {
                renderBalanceInfo(res.deepseekLastBalance);
            }

            if (res.deepseekApiKey) {
                setBadgeStatus(true);
                // Background update balance
                chrome.runtime.sendMessage({ action: 'deepseek_check_balance' }, (balRes) => {
                    if (balRes && balRes.success) {
                        renderBalanceInfo(balRes.balanceInfo);
                        renderStats(res.deepseekStats);
                        setBadgeStatus(true);
                    }
                });
            } else {
                setBadgeStatus(false, 'Не подключен');
            }
        });
    }

    // Call loadAiSettings once on initialization
    loadAiSettings();
});
