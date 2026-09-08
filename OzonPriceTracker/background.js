// Setup alarm on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get({ checkInterval: 120 }, (result) => {
        chrome.alarms.create("priceCheck", {
            periodInMinutes: result.checkInterval
        });
    });
    // Trigger initial check on install
    checkPrices();
});

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "priceCheck") {
        checkPrices();
    }
});

// Listen for interval setting change
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.checkInterval) {
        chrome.alarms.create("priceCheck", {
            periodInMinutes: changes.checkInterval.newValue
        });
        console.log(`Alarm updated to ${changes.checkInterval.newValue} minutes`);
    }
});

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "checkPricesNow") {
        checkPrices();
        sendResponse({status: "started"});
    } else if (request.action === 'fetchWbPrices') {
        // Start background processing
        startWbBackgroundFetch(request.articles);
        sendResponse({status: "started"});
        return false; // Sync response, processing continues in background
    } else if (request.action === 'deepseek_check_balance') {
        handleDeepSeekCheckBalance(request.apiKey)
            .then(res => sendResponse(res))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Async response
    } else if (request.action === 'deepseek_generate_answer') {
        handleDeepSeekGenerateAnswer(request.data)
            .then(res => sendResponse(res))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Async response
    } else if (request.action === 'deepseek_reset_stats') {
        handleDeepSeekResetStats()
            .then(res => sendResponse(res))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Async response
    }
});

async function checkPrices() {
    console.log("Starting price check...");
    
    // Get tracked items
    const data = await chrome.storage.local.get({ trackedItems: [] });
    let items = data.trackedItems;
    
    if (items.length === 0) {
        console.log("No items to check.");
        return;
    }

    let itemsUpdated = false;

    // Check sequentially to avoid overwhelming browser/tab system
    for (let i = 0; i < items.length; i++) {
        let item = items[i];
        try {
            const currentData = await checkSingleItem(item);
            
            if (currentData && currentData.price !== null) {
                const currentPrice = currentData.price;
                const title = currentData.title || item.title || item.url;
                
                // Track item title update
                if (currentData.title && item.title !== currentData.title) {
                    items[i].title = currentData.title;
                    itemsUpdated = true;
                }

                // Check if price dropped below or hit target
                if (currentPrice <= item.targetPrice) {
                    
                    // Create notification
                    chrome.notifications.create({
                        type: "basic",
                        title: "Цена достигла цели на Ozon!",
                        message: `Цена ${currentPrice}₽ (цель: ${item.targetPrice}₽)\n${title}`,
                        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
                        requireInteraction: true
                    });

                    // Save to history
                    const historyData = await chrome.storage.local.get({ notificationHistory: [] });
                    const history = historyData.notificationHistory;
                    
                    history.push({
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                        itemId: item.id,
                        url: item.url,
                        title: title,
                        price: currentPrice,
                        targetPrice: item.targetPrice,
                        timestamp: new Date().toISOString()
                    });

                    await chrome.storage.local.set({ notificationHistory: history });
                }
                
                // Update item with new price
                items[i].lastPrice = currentPrice;
                itemsUpdated = true;
            }
        } catch (error) {
            console.error(`Error checking item ${item.url}:`, error);
        }
    }

    // Save updated items back to storage
    if (itemsUpdated) {
        await chrome.storage.local.set({ trackedItems: items });
    }
    
    // Update last check time
    await chrome.storage.local.set({ lastCheckTimestamp: Date.now() });
    console.log("Price check finished.");
}

async function checkSingleItem(item) {
    return new Promise((resolve, reject) => {
        // 1. Open background tab
        chrome.tabs.create({ url: item.url, active: false }, (tab) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            const tabId = tab.id;

            // 2. Wait 4000ms
            setTimeout(() => {
                // 3. Inject variables and execute script
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: (type) => { window.ozonPriceTargetType = type; },
                    args: [item.priceType]
                }, () => {
                    chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        files: ['content.js']
                    }, (results) => {
                        // 4. Close the tab immediately
                        chrome.tabs.remove(tabId, () => {
                            if (chrome.runtime.lastError) {
                                console.error("Error closing tab:", chrome.runtime.lastError);
                            }
                        });

                        // 5. Parse result
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else if (results && results[0] && results[0].result !== undefined) {
                            resolve(results[0].result); // returns { price, title } or null if issues occur
                        } else {
                            resolve({ price: null, title: null });
                        }
                    });
                });
            }, 4000); 
        });
    });
}

// Handle notification click to open the URL
chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId.startsWith('wb-')) {
        // Handled by user opening popup
    } else {
        chrome.tabs.create({ url: "https://www.ozon.ru/cart" });
    }
});

// --- Wildberries Background Fetch logic ---

async function startWbBackgroundFetch(articles) {
    const total = articles.length;
    let done = 0;
    const results = {};

    // Initialize status
    await chrome.storage.local.set({ 
        wbStatus: { total, done, running: true },
        wbLastResults: {} 
    });

    for (const id of articles) {
        const result = await fetchOneWb(id);
        results[id] = result;
        done++;
        
        // Update status and partial results
        await chrome.storage.local.set({ 
            wbStatus: { total, done, running: done < total },
            wbLastResults: results
        });
    }

    // Show completion notification
    chrome.notifications.create(`wb-done-${Date.now()}`, {
        type: "basic",
        title: "Wildberries: Загрузка завершена",
        message: `Готово! Цены по ${total} артикулам успешно загружены.`,
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        requireInteraction: true
    });
}

async function fetchOneWb(articleId) {
  return new Promise(async (resolve) => {
    const url = `https://www.wildberries.ru/catalog/${articleId}/detail.aspx`;
    const tab = await chrome.tabs.create({ url, active: false });

    const onUpdated = (tabId, changeInfo) => {
      if (tabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);

      setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'getPrices' }, async (response) => {
            await chrome.tabs.remove(tab.id);
            resolve(response ?? { wallet: null, total: null });
          });
      }, 1000); // 1s buffer for content script stability
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    
    // Safety timeout
    setTimeout(async () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        try { await chrome.tabs.remove(tab.id); } catch(e) {}
        resolve({ wallet: null, total: null });
    }, 20000);
  });
}

// =========================================================================
// DEEPSEEK API INTEGRATION
// =========================================================================

const DEFAULT_DEEPSEEK_SYSTEM_PROMPT = `Ты — вежливый и компетентный представитель магазина на Ozon. Твоя задача — профессионально ответить на вопрос покупателя о товаре.
Правила:
1. Обращайся к покупателю вежливо и по имени (если указано).
2. Отвечай строго по существу вопроса, помогая принять решение о покупке.
3. Если вопрос о совместимости (например, подойдет ли пульт к определенной модели техники): поясни, что если модель указана в описании или совпадает с оригинальным пультом, то устройство гарантированно подойдет. Если модель старая или редкая, посоветуй сверить расположение и назначение основных кнопок со старым пультом или задать уточняющий вопрос.
4. Ответ должен быть лаконичным, уверенным и доброжелательным (2-5 предложений).
5. Завершай ответ пожеланием приятных покупок или отличного настроения.`;

async function getDeepSeekApiKey(explicitKey) {
    if (explicitKey && explicitKey.trim()) {
        return explicitKey.trim();
    }
    const data = await chrome.storage.local.get(['deepseekApiKey']);
    return (data.deepseekApiKey || '').trim();
}

function cleanAiMarkdownText(text) {
    if (!text) return '';
    let result = text;
    // Strip code blocks ```...```
    result = result.replace(/```[\s\S]*?```/g, '');
    // Strip bold/italic markdown (**text**, *text*, __text__, _text_)
    result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
    result = result.replace(/\*([^*]+)\*/g, '$1');
    result = result.replace(/__([^_]+)__/g, '$1');
    result = result.replace(/_([^_]+)_/g, '$1');
    // Strip markdown headers like # Header
    result = result.replace(/^#{1,6}\s+/gm, '');
    // Strip leading list bullet dashes or asterisks like "* item" or "- item"
    result = result.replace(/^[\*\-]\s+/gm, '');
    // Trim extra empty lines
    result = result.replace(/\n{3,}/g, '\n\n');
    return result.trim();
}

async function handleDeepSeekCheckBalance(explicitKey) {
    const apiKey = await getDeepSeekApiKey(explicitKey);
    if (!apiKey) {
        return { success: false, error: 'API-ключ не указан' };
    }

    try {
        const response = await fetch('https://api.deepseek.com/user/balance', {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            const errText = await response.text();
            let errMsg = `Ошибка DeepSeek API (${response.status})`;
            try {
                const parsedErr = JSON.parse(errText);
                if (parsedErr.error && parsedErr.error.message) {
                    errMsg = parsedErr.error.message;
                } else if (parsedErr.message) {
                    errMsg = parsedErr.message;
                }
            } catch (_) {}
            return { success: false, error: errMsg, statusCode: response.status };
        }

        const data = await response.json();

        // Save latest balance info
        await chrome.storage.local.set({
            deepseekLastBalance: data,
            deepseekBalanceLastChecked: Date.now()
        });

        return { success: true, balanceInfo: data };
    } catch (err) {
        console.error('DeepSeek balance fetch error:', err);
        const isTimeout = err.name === 'TimeoutError';
        return { 
            success: false, 
            error: isTimeout ? 'Превышено время ожидания ответа DeepSeek (таймаут 15с)' : (err.message || 'Сетевая ошибка при проверке баланса')
        };
    }
}

async function handleDeepSeekGenerateAnswer(inputData) {
    const apiKey = await getDeepSeekApiKey();
    if (!apiKey) {
        return { success: false, error: 'DeepSeek API-ключ не настроен. Укажите его в расширении.' };
    }

    const settings = await chrome.storage.local.get({
        deepseekPrompt: DEFAULT_DEEPSEEK_SYSTEM_PROMPT,
        deepseekModel: 'deepseek-chat',
        deepseekTemperature: 0.5,
        deepseekStats: {
            totalRequests: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            estimatedCostCNY: 0
        }
    });

    const rawSystemPrompt = settings.deepseekPrompt || DEFAULT_DEEPSEEK_SYSTEM_PROMPT;
    const model = settings.deepseekModel || 'deepseek-chat';
    const temperature = Number(settings.deepseekTemperature) || 0.5;

    const { product, brand, sku, question, buyer, article } = inputData || {};

    if (!question || !question.trim()) {
        return { success: false, error: 'Текст вопроса пуст' };
    }

    // Substitute user chips in system prompt if present
    const systemPrompt = rawSystemPrompt
        .replaceAll('{product}', product || 'товар')
        .replaceAll('{brand}', brand || 'бренд')
        .replaceAll('{sku}', sku || article || '')
        .replaceAll('{buyer}', buyer || 'покупатель')
        .replaceAll('{question}', question || '')
        .replaceAll('{article}', article || sku || '');

    const userMessageContent = `Информация о товаре и вопрос покупателя:
- Товар: ${product || 'Не указан'}
- Бренд: ${brand || 'Не указан'}
- Артикул / SKU: ${sku || article || 'Не указан'}
- Покупатель: ${buyer || 'Покупатель'}
- Вопрос: ${question.trim()}

Сформируй качественный и вежливый ответ покупателю. Ответ пиши обычным чистым текстом, без звездочек, без markdown-разметки и без списков.`;

    try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessageContent }
                ],
                temperature: temperature,
                max_tokens: 1024
            }),
            signal: AbortSignal.timeout(25000)
        });

        if (!response.ok) {
            const errText = await response.text();
            let errMsg = `Ошибка генерации DeepSeek (${response.status})`;
            try {
                const parsed = JSON.parse(errText);
                if (parsed.error && parsed.error.message) {
                    errMsg = parsed.error.message;
                }
            } catch (_) {}
            return { success: false, error: errMsg };
        }

        const data = await response.json();
        const rawAnswer = data.choices?.[0]?.message?.content?.trim() || '';
        const answer = cleanAiMarkdownText(rawAnswer);
        const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        // Update statistics
        const stats = settings.deepseekStats || {
            totalRequests: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            totalTokens: 0,
            estimatedCostCNY: 0
        };

        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const totalTokens = usage.total_tokens || (promptTokens + completionTokens);

        // DeepSeek Pricing:
        // deepseek-chat (V3): ~2 CNY / 1M in, ~8 CNY / 1M out
        // deepseek-reasoner (R1): ~4 CNY / 1M in, ~16 CNY / 1M out
        const isReasoner = model === 'deepseek-reasoner';
        const inputRate = isReasoner ? 0.000004 : 0.000002;
        const outputRate = isReasoner ? 0.000016 : 0.000008;
        const requestCostCNY = (promptTokens * inputRate) + (completionTokens * outputRate);

        stats.totalRequests = (stats.totalRequests || 0) + 1;
        stats.totalPromptTokens = (stats.totalPromptTokens || 0) + promptTokens;
        stats.totalCompletionTokens = (stats.totalCompletionTokens || 0) + completionTokens;
        stats.totalTokens = (stats.totalTokens || 0) + totalTokens;
        stats.estimatedCostCNY = Number(((stats.estimatedCostCNY || 0) + requestCostCNY).toFixed(6));
        stats.lastUsedAt = Date.now();

        await chrome.storage.local.set({ deepseekStats: stats });

        // Asynchronously check balance to keep dashboard fresh
        handleDeepSeekCheckBalance(apiKey).catch(() => {});

        return {
            success: true,
            answer: answer,
            usage: usage,
            stats: stats
        };
    } catch (err) {
        console.error('DeepSeek generation error:', err);
        const isTimeout = err.name === 'TimeoutError';
        return { 
            success: false, 
            error: isTimeout ? 'Превышено время ожидания ответа DeepSeek (таймаут 25с)' : (err.message || 'Ошибка связи с DeepSeek API')
        };
    }
}

async function handleDeepSeekResetStats() {
    const freshStats = {
        totalRequests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        estimatedCostCNY: 0,
        lastResetAt: Date.now()
    };
    await chrome.storage.local.set({ deepseekStats: freshStats });
    return { success: true, stats: freshStats };
}
