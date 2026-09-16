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
    } else if (request.action === 'fetchCitilinkProducts') {
        // Start background processing
        startCitilinkBackgroundFetch(request.articles);
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
    } else if (request.action === 'deepseek_generate_review_answer') {
        handleDeepSeekGenerateReviewAnswer(request.data)
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

// --- Citilink product export logic ---

const DEFAULT_CITILINK_SYSTEM_PROMPT = `Ты — редактор объявлений для Avito.
Подготовь только готовое описание товара на русском языке на основе данных Citilink.
Правила:
1. Не выдумывай характеристики, комплектацию, цену, наличие и преимущества, которых нет в исходных данных.
2. Сохрани важные технические характеристики, модель и бренд.
3. Сделай текст понятным, аккуратным и подходящим для объявления Avito.
4. Не добавляй заголовок, цену, ссылки, служебные комментарии и markdown-разметку.
5. Верни только итоговый текст описания.`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createBackgroundTab(url) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create({ url, active: false }, (tab) => {
            if (chrome.runtime.lastError || !tab?.id) {
                reject(chrome.runtime.lastError || new Error('Не удалось открыть страницу Citilink'));
                return;
            }
            resolve(tab);
        });
    });
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
    return new Promise(resolve => {
        let finished = false;

        const finish = (isComplete) => {
            if (finished) return;
            finished = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timeoutId);
            resolve(isComplete);
        };

        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === 'complete') {
                finish(true);
            }
        };

        const timeoutId = setTimeout(() => finish(false), timeoutMs);
        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId, tab => {
            if (!chrome.runtime.lastError && tab?.status === 'complete') {
                finish(true);
            }
        });
    });
}

function sendTabMessage(tabId, message) {
    return new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, message, response => {
            void chrome.runtime.lastError;
            resolve(response || null);
        });
    });
}

async function waitForCitilinkContent(tabId, message, isReady, timeoutMs = 25000, settleMs = 0) {
    const startedAt = Date.now();
    let bestResponse = null;
    let firstReadyAt = 0;
    let stableSince = 0;
    let lastFingerprint = '';

    while (Date.now() - startedAt < timeoutMs) {
        const response = await sendTabMessage(tabId, message);
        if (response && isReady(response)) {
            if (!settleMs) return response;

            const currentImageUrls = Array.isArray(response.imageUrls) ? response.imageUrls : [];
            const bestImageCount = Array.isArray(bestResponse?.imageUrls) ? bestResponse.imageUrls.length : 0;
            if (!bestResponse || currentImageUrls.length > bestImageCount) {
                bestResponse = response;
            }

            const fingerprint = JSON.stringify({
                article: response.article,
                name: response.name,
                brand: response.brand,
                imageUrls: currentImageUrls
            });
            const now = Date.now();
            if (!firstReadyAt) firstReadyAt = now;
            if (fingerprint !== lastFingerprint) {
                lastFingerprint = fingerprint;
                stableSince = now;
            }

            // Let the gallery finish hydrating before accepting the product data.
            if (now - firstReadyAt >= settleMs && now - stableSince >= 1000) {
                return bestResponse;
            }
        }
        await sleep(700);
    }

    return bestResponse;
}

async function closeBackgroundTab(tabId) {
    try {
        await new Promise(resolve => {
            chrome.tabs.remove(tabId, () => {
                void chrome.runtime.lastError;
                resolve();
            });
        });
    } catch (_) {
        // The tab may already have been closed by the browser.
    }
}

async function fetchCitilinkPage(url, action, articleId, isReady, settleProduct = false) {
    const tab = await createBackgroundTab(url);

    try {
        await waitForTabComplete(tab.id);
        return await waitForCitilinkContent(
            tab.id,
            { action, articleId },
            isReady,
            25000,
            settleProduct ? 2800 : 0
        );
    } finally {
        await closeBackgroundTab(tab.id);
    }
}

async function fetchOneCitilink(articleId) {
    const normalizedArticle = String(articleId || '').trim();
    const searchUrl = `https://www.citilink.ru/search/?text=${encodeURIComponent(normalizedArticle)}`;
    const searchResult = await fetchCitilinkPage(
        searchUrl,
        'getCitilinkSearchResult',
        normalizedArticle,
        response => response.found && response.url
    );

    if (!searchResult) {
        throw new Error('Товар не найден в поиске Citilink или страница не загрузилась');
    }

    const product = await fetchCitilinkPage(
        searchResult.url,
        'getCitilinkProductData',
        normalizedArticle,
        response => response.found && (response.name || response.characteristicsText),
        true
    );

    if (!product) {
        throw new Error('Не удалось получить данные карточки товара Citilink');
    }

    const aiResult = await handleDeepSeekGenerateDescription(product);
    if (!aiResult.success) {
        throw new Error(aiResult.error || 'DeepSeek не вернул описание');
    }

    const { characteristics, characteristicsText, ...productForStorage } = product;
    const imageCount = Array.isArray(productForStorage.imageUrls)
        ? productForStorage.imageUrls.length
        : 0;
    return {
        ...productForStorage,
        article: normalizedArticle,
        imageCount,
        description: aiResult.description,
        status: 'done',
        error: ''
    };
}

async function startCitilinkBackgroundFetch(articles) {
    const normalizedArticles = Array.from(new Set((articles || []).map(article => String(article).trim()).filter(Boolean)));
    const total = normalizedArticles.length;
    const results = {};

    if (total === 0) return;

    await chrome.storage.local.set({
        citilinkStatus: { total, done: 0, running: true, phase: 'starting', error: '' },
        citilinkLastResults: {}
    });

    if (!(await getDeepSeekApiKey())) {
        const error = 'DeepSeek API-ключ не настроен. Откройте вкладку AI и сохраните ключ.';
        normalizedArticles.forEach(article => {
            results[article] = { article, status: 'error', error };
        });
        await chrome.storage.local.set({
            citilinkStatus: { total, done: total, running: false, phase: 'error', error },
            citilinkLastResults: results
        });
        return;
    }

    let done = 0;
    for (const article of normalizedArticles) {
        results[article] = { article, status: 'searching', error: '' };
        await chrome.storage.local.set({
            citilinkStatus: { total, done, running: true, phase: 'searching', error: '' },
            citilinkLastResults: results
        });

        try {
            results[article] = await fetchOneCitilink(article);
        } catch (error) {
            results[article] = {
                article,
                status: 'error',
                error: error?.message || 'Неизвестная ошибка обработки'
            };
        }

        done += 1;
        await chrome.storage.local.set({
            citilinkStatus: { total, done, running: done < total, phase: done < total ? 'processing' : 'done', error: '' },
            citilinkLastResults: results
        });
    }

    chrome.notifications.create(`citilink-done-${Date.now()}`, {
        type: 'basic',
        title: 'Citilink: обработка завершена',
        message: `Готово! Обработано товаров: ${total}.`,
        iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        requireInteraction: true
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

const DEFAULT_DEEPSEEK_REVIEW_PROMPT = `Ты — вежливый и внимательный представитель магазина на Ozon. Твоя задача — ответить на отзыв покупателя о товаре.
Правила:
1. Поблагодари покупателя за отзыв и обратись к сути его впечатления.
2. Отвечай доброжелательно и профессионально, не спорь с покупателем и не выдумывай факты.
3. Если отзыв негативный, признай неудобство и предложи обратиться в поддержку магазина для решения вопроса.
4. Ответ должен быть лаконичным — 2-4 предложения, без markdown-разметки и служебных комментариев.
5. Заверши ответ пожеланием приятных покупок.`;

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

async function requestDeepSeekCompletion({ systemPrompt, userMessageContent, model, temperature }) {
    const apiKey = await getDeepSeekApiKey();
    if (!apiKey) {
        return { success: false, error: 'DeepSeek API-ключ не настроен. Укажите его в расширении.' };
    }

    try {
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model || 'deepseek-chat',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessageContent }
                ],
                temperature: Number(temperature) || 0.5,
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
        const rawText = data.choices?.[0]?.message?.content?.trim() || '';
        const text = cleanAiMarkdownText(rawText);
        const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        const statsData = await chrome.storage.local.get({
            deepseekStats: {
                totalRequests: 0,
                totalPromptTokens: 0,
                totalCompletionTokens: 0,
                totalTokens: 0,
                estimatedCostCNY: 0
            }
        });
        const stats = statsData.deepseekStats || {};

        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const totalTokens = usage.total_tokens || (promptTokens + completionTokens);
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
        handleDeepSeekCheckBalance(apiKey).catch(() => {});

        return { success: true, text, usage, stats };
    } catch (err) {
        console.error('DeepSeek generation error:', err);
        const isTimeout = err.name === 'TimeoutError';
        return {
            success: false,
            error: isTimeout ? 'Превышено время ожидания ответа DeepSeek (таймаут 25с)' : (err.message || 'Ошибка связи с DeepSeek API')
        };
    }
}

async function handleDeepSeekGenerateAnswer(inputData) {
    const settings = await chrome.storage.local.get({
        deepseekPrompt: DEFAULT_DEEPSEEK_SYSTEM_PROMPT,
        deepseekModel: 'deepseek-chat',
        deepseekTemperature: 0.5
    });
    const rawSystemPrompt = settings.deepseekPrompt || DEFAULT_DEEPSEEK_SYSTEM_PROMPT;
    const model = settings.deepseekModel || 'deepseek-chat';
    const temperature = Number(settings.deepseekTemperature) || 0.5;
    const { product, brand, sku, question, buyer, article } = inputData || {};

    if (!question || !question.trim()) {
        return { success: false, error: 'Текст вопроса пуст' };
    }

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

    const result = await requestDeepSeekCompletion({
        systemPrompt,
        userMessageContent,
        model,
        temperature
    });

    return result.success ? { ...result, answer: result.text } : result;
}

async function handleDeepSeekGenerateReviewAnswer(inputData) {
    const settings = await chrome.storage.local.get({
        deepseekReviewPrompt: DEFAULT_DEEPSEEK_REVIEW_PROMPT,
        deepseekModel: 'deepseek-chat',
        deepseekTemperature: 0.5
    });
    const rawSystemPrompt = (settings.deepseekReviewPrompt || '').trim() || DEFAULT_DEEPSEEK_REVIEW_PROMPT;
    const model = settings.deepseekModel || 'deepseek-chat';
    const temperature = Number(settings.deepseekTemperature) || 0.5;
    const { product, brand, review, date, buyer } = inputData || {};

    if (!review || !review.trim()) {
        return { success: false, error: 'Текст отзыва пуст' };
    }

    const systemPrompt = rawSystemPrompt
        .replaceAll('{product}', product || 'товар')
        .replaceAll('{brand}', brand || 'бренд')
        .replaceAll('{review}', review || '')
        .replaceAll('{date}', date || '');

    const userMessageContent = `Информация об отзыве покупателя:
- Товар: ${product || 'Не указан'}
- Бренд: ${brand || 'Не указан'}
- Покупатель: ${buyer || 'Покупатель'}
- Дата публикации: ${date || 'Не указана'}
- Отзыв: ${review.trim()}

Сформируй качественный и вежливый ответ покупателю. Ответ пиши обычным чистым текстом, без звездочек, без markdown-разметки и без списков.`;

    const result = await requestDeepSeekCompletion({
        systemPrompt,
        userMessageContent,
        model,
        temperature
    });

    return result.success ? { ...result, answer: result.text } : result;
}

async function handleDeepSeekGenerateDescription(inputData) {
    const settings = await chrome.storage.local.get({
        deepseekCitilinkPrompt: DEFAULT_CITILINK_SYSTEM_PROMPT,
        deepseekModel: 'deepseek-chat',
        deepseekTemperature: 0.5
    });
    const rawSystemPrompt = settings.deepseekCitilinkPrompt || DEFAULT_CITILINK_SYSTEM_PROMPT;
    const model = settings.deepseekModel || 'deepseek-chat';
    const temperature = Number(settings.deepseekTemperature) || 0.5;
    const {
        article,
        name,
        brand,
        description: sourceDescription,
        characteristicsText
    } = inputData || {};

    if (!name && !characteristicsText) {
        return { success: false, error: 'Нет исходных данных товара для DeepSeek' };
    }

    const systemPrompt = rawSystemPrompt
        .replaceAll('{article}', article || '')
        .replaceAll('{name}', name || 'товар')
        .replaceAll('{brand}', brand || 'бренд')
        .replaceAll('{description}', sourceDescription || '')
        .replaceAll('{characteristics}', characteristicsText || '');

    const userMessageContent = `Исходные данные товара Citilink:
- Артикул: ${article || 'Не указан'}
- Название: ${name || 'Не указано'}
- Бренд: ${brand || 'Не указан'}
- Описание Citilink: ${sourceDescription || 'Не указано'}

Характеристики:
${characteristicsText || 'Не указаны'}

Сформируй итоговое описание для объявления Avito строго по этим данным.`;

    const result = await requestDeepSeekCompletion({
        systemPrompt,
        userMessageContent,
        model,
        temperature
    });

    return result.success ? { ...result, description: result.text } : result;
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
