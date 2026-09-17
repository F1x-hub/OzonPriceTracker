const STORAGE_SCHEMA_VERSION = 4;
const DEFAULT_COLLECTION_CONCURRENCY = 1;
const MAX_COLLECTION_CONCURRENCY = 5;
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
const DEFAULT_DEEPSEEK_THINKING = 'disabled';
const DEFAULT_DEEPSEEK_REASONING_EFFORT = 'high';
const DEFAULT_THEME = 'light';
const DEEPSEEK_MODEL_ALIASES = Object.freeze({
    'deepseek-chat': 'deepseek-flash',
    'deepseek-reasoner': 'deepseek-flash',
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash'
});
const DEFAULT_WB_STATUS = Object.freeze({ total: 0, done: 0, running: false, phase: 'idle' });
const DEFAULT_CITILINK_STATUS = Object.freeze({ total: 0, done: 0, running: false, phase: 'idle', error: '' });
const DEFAULT_PRICE_CHECK_STATUS = Object.freeze({ total: 0, done: 0, running: false, phase: 'idle', error: '' });
const EXTENSION_ICON_URL = chrome.runtime.getURL('assets/marketpilot-mark-128.png');
const SETTINGS_KEYS = new Set([
    'theme',
    'checkInterval',
    'wbConcurrency',
    'citilinkConcurrency',
    'deepseekApiKey',
    'deepseekPrompt',
    'deepseekReviewPrompt',
    'deepseekCitilinkPrompt',
    'deepseekModel',
    'deepseekThinking',
    'deepseekReasoningEffort',
    'deepseekAutoSend',
    'deepseekDelay',
    'ozonReplySettings',
    'ozonReplyTemplates'
]);

// Setup alarm on install
chrome.runtime.onInstalled.addListener(() => {
    void migrateStorageSchema()
        .then(() => chrome.storage.local.get({ checkInterval: 120 }))
        .then((result) => {
            chrome.alarms.create("priceCheck", {
                periodInMinutes: result.checkInterval
            });
            return launchPriceCheck();
        })
        .catch(error => {
            console.error('Не удалось подготовить схему и расписание:', error);
        });
});

const COLLECTION_JOB_STALE_MS = 90_000;
const pendingCollectionRuns = new Set();
let trackedItemsWriteQueue = Promise.resolve();
let notificationHistoryWriteQueue = Promise.resolve();
let deepseekStatsWriteQueue = Promise.resolve();
let priceCheckRunActive = false;

chrome.runtime.onStartup.addListener(() => {
    migrateStorageSchema().then(() => recoverStaleCollectionJobs()).catch(error => {
        console.error('Не удалось восстановить статусы фоновых заданий:', error);
    });
});

function normalizeDeepSeekModel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return DEEPSEEK_MODEL_ALIASES[normalized] || normalized || DEFAULT_DEEPSEEK_MODEL;
}

function normalizeDeepSeekThinking(value) {
    return String(value || '').trim().toLowerCase() === 'enabled' ? 'enabled' : DEFAULT_DEEPSEEK_THINKING;
}

function normalizeDeepSeekReasoningEffort(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['low', 'high', 'max'].includes(normalized) ? normalized : DEFAULT_DEEPSEEK_REASONING_EFFORT;
}

function isDeepSeekModernModel(model) {
    return model === 'deepseek-flash' || model === 'deepseek-v4-pro';
}

function isDeepSeekPeakPeriod(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const weekday = date.getUTCDay();
    const hour = date.getUTCHours() + (date.getUTCMinutes() / 60);
    return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

function estimateDeepSeekCostUsd(model, usage, timestamp = Date.now()) {
    const isPro = model === 'deepseek-v4-pro';
    const peak = isDeepSeekPeakPeriod(timestamp);
    const rates = isPro
        ? { cacheHit: peak ? 0.30 : 0.15, cacheMiss: peak ? 9 : 4.5, output: peak ? 27 : 13.5 }
        : { cacheHit: peak ? 0.04 : 0.02, cacheMiss: peak ? 2 : 1, output: peak ? 8 : 4 };
    const promptTokens = Number(usage?.prompt_tokens) || 0;
    const completionTokens = Number(usage?.completion_tokens) || 0;
    const cachedTokens = Math.min(promptTokens, Math.max(0, Number(
        usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0
    ) || 0));
    const cacheMissTokens = Math.max(0, promptTokens - cachedTokens);
    return ((cachedTokens * rates.cacheHit) + (cacheMissTokens * rates.cacheMiss) + (completionTokens * rates.output)) / 1_000_000;
}

function getLocalDayKey(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const DEEPSEEK_OFFICIAL_USAGE_DAYS = 30;

function getDeepSeekUsageWindow(days = DEEPSEEK_OFFICIAL_USAGE_DAYS) {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    return {
        start: Math.floor(start.getTime() / 1000),
        end: Math.floor(end.getTime() / 1000),
        tz: -start.getTimezoneOffset() * 60
    };
}

function getDeepSeekUsageDayKey(timestamp, timeZoneOffsetSeconds) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return null;
    const date = new Date((seconds + Number(timeZoneOffsetSeconds || 0)) * 1000);
    if (Number.isNaN(date.getTime())) return null;
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function normalizeDeepSeekUsageModel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return DEEPSEEK_MODEL_ALIASES[normalized] || normalized || 'unknown';
}

function getDeepSeekUsageBizData(payload) {
    return payload?.data?.biz_data || payload?.biz_data || payload?.data?.data?.biz_data || {};
}

function parseDeepSeekOfficialUsage({ costPayload, amountPayload, window, fetchedAt = Date.now() }) {
    const daily = {};
    const totals = {
        totalCost: 0,
        totalRequests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0
    };
    let currency = String(getDeepSeekUsageBizData(costPayload)?.currency || '').trim().toUpperCase();

    const ensureDay = (dayKey) => {
        if (!dayKey) return null;
        if (!daily[dayKey]) {
            daily[dayKey] = {
                cost: 0,
                requests: 0,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                models: {}
            };
        }
        return daily[dayKey];
    };
    const ensureModel = (dayStats, model) => {
        const modelId = normalizeDeepSeekUsageModel(model);
        if (!dayStats.models[modelId]) {
            dayStats.models[modelId] = {
                cost: 0,
                requests: 0,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0
            };
        }
        return dayStats.models[modelId];
    };
    const inWindow = (timestamp) => {
        const seconds = Number(timestamp);
        return Number.isFinite(seconds) && seconds >= window.start && seconds < window.end;
    };
    const addCost = (series, bucket, cost) => {
        if (!inWindow(bucket?.time)) return;
        const amount = Number(cost);
        if (!Number.isFinite(amount)) return;
        const dayStats = ensureDay(getDeepSeekUsageDayKey(bucket.time, window.tz));
        if (!dayStats) return;
        const modelStats = ensureModel(dayStats, series?.model);
        dayStats.cost += amount;
        modelStats.cost += amount;
        totals.totalCost += amount;
    };

    const costBizData = getDeepSeekUsageBizData(costPayload);
    const costGroups = Array.isArray(costBizData.data)
        ? costBizData.data
        : (Array.isArray(costBizData.series) ? [{ currency: costBizData.currency, series: costBizData.series }] : []);
    if (!currency) {
        currency = String(costGroups.find((group) => group?.currency)?.currency || 'USD').trim().toUpperCase();
    }
    for (const group of costGroups) {
        const groupCurrency = String(group?.currency || '').trim().toUpperCase();
        if (groupCurrency && groupCurrency !== currency) continue;
        for (const series of Array.isArray(group?.series) ? group.series : []) {
            for (const bucket of Array.isArray(series?.buckets) ? series.buckets : []) {
                addCost(series, bucket, bucket?.cost);
            }
        }
    }

    const readUsageValue = (usage, names) => {
        for (const name of names) {
            const value = Number(usage?.[name]);
            if (Number.isFinite(value)) return Math.max(0, value);
        }
        return 0;
    };
    const amountBizData = getDeepSeekUsageBizData(amountPayload);
    const amountSeries = Array.isArray(amountBizData.series) ? amountBizData.series : [];
    for (const series of amountSeries) {
        for (const bucket of Array.isArray(series?.buckets) ? series.buckets : []) {
            if (!inWindow(bucket?.time)) continue;
            const dayStats = ensureDay(getDeepSeekUsageDayKey(bucket.time, window.tz));
            if (!dayStats) continue;
            const modelStats = ensureModel(dayStats, series?.model);
            const usage = bucket?.usage || {};
            const cacheHitTokens = readUsageValue(usage, ['PROMPT_CACHE_HIT_TOKEN', 'prompt_cache_hit_tokens']);
            const cacheMissTokens = readUsageValue(usage, ['PROMPT_CACHE_MISS_TOKEN', 'prompt_cache_miss_tokens']);
            const completionTokens = readUsageValue(usage, ['RESPONSE_TOKEN', 'response_tokens', 'completion_tokens']);
            const requests = readUsageValue(usage, ['REQUEST', 'requests']);
            const promptTokens = cacheHitTokens + cacheMissTokens;
            const totalTokens = promptTokens + completionTokens;
            dayStats.requests += requests;
            dayStats.promptTokens += promptTokens;
            dayStats.completionTokens += completionTokens;
            dayStats.totalTokens += totalTokens;
            modelStats.requests += requests;
            modelStats.promptTokens += promptTokens;
            modelStats.completionTokens += completionTokens;
            modelStats.totalTokens += totalTokens;
            totals.totalRequests += requests;
            totals.totalPromptTokens += promptTokens;
            totals.totalCompletionTokens += completionTokens;
            totals.totalTokens += totalTokens;
        }
    }

    if (!currency) currency = 'USD';
    const roundCost = (value) => Number(Number(value || 0).toFixed(6));
    const roundCount = (value) => Math.round(Number(value) || 0);
    for (const dayStats of Object.values(daily)) {
        dayStats.cost = roundCost(dayStats.cost);
        dayStats.requests = roundCount(dayStats.requests);
        dayStats.promptTokens = roundCount(dayStats.promptTokens);
        dayStats.completionTokens = roundCount(dayStats.completionTokens);
        dayStats.totalTokens = roundCount(dayStats.totalTokens);
        for (const modelStats of Object.values(dayStats.models)) {
            modelStats.cost = roundCost(modelStats.cost);
            modelStats.requests = roundCount(modelStats.requests);
            modelStats.promptTokens = roundCount(modelStats.promptTokens);
            modelStats.completionTokens = roundCount(modelStats.completionTokens);
            modelStats.totalTokens = roundCount(modelStats.totalTokens);
        }
    }

    const hasData = totals.totalCost > 0 || totals.totalRequests > 0 || totals.totalTokens > 0;
    if (!hasData) return null;
    return {
        source: 'platform',
        currency,
        totalCost: roundCost(totals.totalCost),
        totalRequests: roundCount(totals.totalRequests),
        totalPromptTokens: roundCount(totals.totalPromptTokens),
        totalCompletionTokens: roundCount(totals.totalCompletionTokens),
        totalTokens: roundCount(totals.totalTokens),
        daily,
        fetchedAt,
        rangeStart: window.start,
        rangeEnd: window.end,
        timeZoneOffsetSeconds: window.tz
    };
}

async function fetchOfficialDeepSeekUsage() {
    const tabs = await chrome.tabs.query({ url: ['https://platform.deepseek.com/*'] });
    const tab = tabs.find((candidate) => candidate.active) || tabs[0];
    if (!tab?.id) {
        return { success: false, error: 'Для официальной статистики откройте https://platform.deepseek.com/usage и войдите в аккаунт.' };
    }

    const window = getDeepSeekUsageWindow();
    try {
        const execution = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async (usageWindow) => {
                const rawToken = localStorage.getItem('userToken');
                let parsedToken = rawToken;
                try { parsedToken = JSON.parse(rawToken); } catch (_) {}
                const token = typeof parsedToken === 'string'
                    ? parsedToken
                    : (parsedToken?.value || parsedToken?.token || parsedToken?.access_token || '');
                if (!token) return { success: false, error: 'На странице DeepSeek не найдена активная сессия. Войдите в аккаунт на platform.deepseek.com.' };

                const request = async (path) => {
                    const response = await fetch(`${location.origin}${path}?start=${usageWindow.start}&end=${usageWindow.end}&tz=${usageWindow.tz}`, {
                        credentials: 'include',
                        headers: {
                            Accept: 'application/json',
                            Authorization: `Bearer ${token}`,
                            'x-client-platform': 'web'
                        }
                    });
                    const text = await response.text();
                    let body = null;
                    try { body = JSON.parse(text); } catch (_) {}
                    return { ok: response.ok, status: response.status, body };
                };

                const [cost, amount] = await Promise.all([
                    request('/api/v0/usage/by_api_key/cost'),
                    request('/api/v0/usage/by_api_key/amount')
                ]);
                if (!cost.ok && !amount.ok) {
                    const status = cost.status || amount.status;
                    return { success: false, error: status === 401 || status === 403
                        ? 'Сессия DeepSeek истекла. Войдите в аккаунт на platform.deepseek.com заново.'
                        : `Не удалось получить официальный usage DeepSeek (${status}).` };
                }
                return {
                    success: true,
                    costPayload: cost.ok ? cost.body : null,
                    amountPayload: amount.ok ? amount.body : null
                };
            },
            args: [window]
        });
        const result = execution?.[0]?.result;
        if (!result?.success) return result || { success: false, error: 'Не удалось прочитать usage DeepSeek.' };
        const usage = parseDeepSeekOfficialUsage({ ...result, window });
        if (!usage) return { success: false, error: 'DeepSeek вернул пустую статистику за последние 30 дней.' };
        await chrome.storage.local.set({ deepseekOfficialUsage: usage });
        return { success: true, usage };
    } catch (error) {
        console.error('DeepSeek official usage fetch error:', error);
        return { success: false, error: 'Не удалось прочитать usage со страницы DeepSeek. Откройте platform.deepseek.com/usage и обновите страницу.' };
    }
}

function isObjectRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimDeepSeekDailyUsage(dailyUsage, timestamp = Date.now()) {
    const cutoff = new Date(timestamp);
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - 180);
    const cutoffKey = getLocalDayKey(cutoff.getTime());
    return Object.fromEntries(Object.entries(dailyUsage).filter(([dayKey]) => dayKey >= cutoffKey));
}

async function migrateStorageSchema() {
    const data = await chrome.storage.local.get({
        storageSchemaVersion: 0,
        trackedItems: [],
        notificationHistory: [],
        wbStatus: null,
        citilinkStatus: null,
        priceCheckStatus: null,
        theme: DEFAULT_THEME,
        checkInterval: 120,
        wbConcurrency: null,
        citilinkConcurrency: null,
        deepseekModel: '',
        deepseekThinking: '',
        deepseekReasoningEffort: ''
    });
    const updates = {};

    if (!Array.isArray(data.trackedItems)) updates.trackedItems = [];
    if (!Array.isArray(data.notificationHistory)) updates.notificationHistory = [];
    if (data.wbStatus !== null && (typeof data.wbStatus !== 'object' || Array.isArray(data.wbStatus))) {
        updates.wbStatus = { ...DEFAULT_WB_STATUS };
    }
    if (data.citilinkStatus !== null && (typeof data.citilinkStatus !== 'object' || Array.isArray(data.citilinkStatus))) {
        updates.citilinkStatus = { ...DEFAULT_CITILINK_STATUS };
    }
    if (data.priceCheckStatus !== null && (typeof data.priceCheckStatus !== 'object' || Array.isArray(data.priceCheckStatus))) {
        updates.priceCheckStatus = { ...DEFAULT_PRICE_CHECK_STATUS };
    }
    if (!['light', 'dark'].includes(String(data.theme || '').trim().toLowerCase())) {
        updates.theme = DEFAULT_THEME;
    }
    const interval = Number(data.checkInterval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 10080) {
        updates.checkInterval = 120;
    }
    for (const key of ['wbConcurrency', 'citilinkConcurrency']) {
        const concurrency = Number(data[key]);
        if (!Number.isInteger(concurrency) || concurrency < DEFAULT_COLLECTION_CONCURRENCY || concurrency > MAX_COLLECTION_CONCURRENCY) {
            updates[key] = DEFAULT_COLLECTION_CONCURRENCY;
        }
    }
    const storedModel = String(data.deepseekModel || '').trim().toLowerCase();
    const storedThinking = String(data.deepseekThinking || '').trim().toLowerCase();
    const legacyThinking = storedModel === 'deepseek-reasoner' ? 'enabled' : DEFAULT_DEEPSEEK_THINKING;
    const normalizedModel = normalizeDeepSeekModel(storedModel);
    if (!storedModel || storedModel !== normalizedModel) updates.deepseekModel = normalizedModel;
    if (!['enabled', 'disabled'].includes(storedThinking)) updates.deepseekThinking = legacyThinking;
    if (!['low', 'high', 'max'].includes(String(data.deepseekReasoningEffort || '').trim().toLowerCase())) {
        updates.deepseekReasoningEffort = DEFAULT_DEEPSEEK_REASONING_EFFORT;
    }
    if (data.storageSchemaVersion !== STORAGE_SCHEMA_VERSION) {
        updates.storageSchemaVersion = STORAGE_SCHEMA_VERSION;
    }

    if (Object.keys(updates).length > 0) {
        await chrome.storage.local.set(updates);
    }
    return { migrated: Object.keys(updates).length > 0, version: STORAGE_SCHEMA_VERSION };
}

async function recoverStaleCollectionJobs() {
    const data = await chrome.storage.local.get({ wbStatus: null, citilinkStatus: null, priceCheckStatus: null });
    const now = Date.now();
    const interruptedAt = new Date(now).toISOString();
    const recoveryReason = 'Задание прервано после остановки service worker. Запустите его заново.';
    const updates = {};

    for (const [key, status] of [
        ['wbStatus', data.wbStatus],
        ['citilinkStatus', data.citilinkStatus],
        ['priceCheckStatus', data.priceCheckStatus]
    ]) {
        if (!status?.running) continue;
        const updatedAt = Date.parse(status.updatedAt || '');
        const stale = !Number.isFinite(updatedAt) || now - updatedAt > COLLECTION_JOB_STALE_MS;
        if (!stale) continue;
        updates[key] = {
            ...status,
            running: false,
            phase: 'interrupted',
            error: recoveryReason,
            interruptedAt,
            updatedAt: interruptedAt
        };
    }

    if (Object.keys(updates).length > 0) {
        await chrome.storage.local.set(updates);
    }
}

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "priceCheck") {
        void launchPriceCheck();
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
        launchPriceCheck()
            .then(sendResponse)
            .catch(error => sendResponse({ status: 'error', error: error.message }));
        return true;
    } else if (request.action === 'fetchWbPrices') {
        launchCollectionJob('wb', 'wbStatus', () => startWbBackgroundFetch(request.articles))
            .then(sendResponse)
            .catch(error => sendResponse({ status: 'error', error: error.message }));
        return true;
    } else if (request.action === 'fetchCitilinkProducts') {
        launchCollectionJob('citilink', 'citilinkStatus', () => startCitilinkBackgroundFetch(request.articles, {
            generateDescription: request.generateDescription !== false
        }))
            .then(sendResponse)
            .catch(error => sendResponse({ status: 'error', error: error.message }));
        return true;
    } else if (request.action === 'tracking_upsert') {
        upsertTrackedItem(request.item)
            .then(item => sendResponse({ success: true, item }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (request.action === 'tracking_remove') {
        removeTrackedItem(request.id)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (request.action === 'history_clear') {
        clearNotificationHistory()
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (request.action === 'history_remove_for_item') {
        removeHistoryForItem(request.itemId)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (request.action === 'history_append') {
        appendActivityHistory(request.entry)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (request.action === 'collection_clear') {
        clearCollectionResults(request.marketplace)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (request.action === 'settings_update') {
        updateSettings(request.values)
            .then(values => sendResponse({ success: true, values }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (request.action === 'deepseek_check_balance') {
        handleDeepSeekCheckBalance(request.apiKey, { includeUsage: request.includeUsage === true })
            .then(res => {
                void appendActivityHistory({
                    action: 'deepseek_balance_check',
                    status: res?.success ? 'success' : 'error',
                    title: res?.success ? 'DeepSeek: баланс обновлён' : 'DeepSeek: ошибка проверки баланса',
                    message: res?.success ? 'Баланс и доступность API проверены.' : (res?.error || 'Не удалось проверить баланс DeepSeek.')
                });
                sendResponse(res);
            })
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
            .then(res => {
                void appendActivityHistory({
                    action: 'deepseek_stats_reset',
                    status: res?.success ? 'success' : 'error',
                    title: res?.success ? 'DeepSeek: статистика сброшена' : 'DeepSeek: статистику не удалось сбросить',
                    message: res?.success ? 'Локальная статистика использования очищена.' : (res?.error || 'Не удалось сбросить статистику.')
                });
                sendResponse(res);
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Async response
    }
});

function isSupportedTrackingUrl(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.replace(/^www\./, '');
        if (url.protocol !== 'https:') return false;
        if (['ozon.ru', 'ozon.com'].includes(host)) return url.pathname.startsWith('/product/');
        if (host === 'wildberries.ru') return /\/catalog\/\d+\/detail/.test(url.pathname);
        return false;
    } catch {
        return false;
    }
}

function normalizeTrackingUrl(value) {
    try {
        const url = new URL(value);
        url.search = '';
        url.hash = '';
        return `${url.origin}${url.pathname}`.replace(/\/$/, '');
    } catch {
        return String(value || '').trim();
    }
}

function enqueueTrackedItemsWrite(work) {
    const next = trackedItemsWriteQueue.then(work, work);
    trackedItemsWriteQueue = next.catch(() => {});
    return next;
}

function enqueueNotificationHistoryWrite(work) {
    const next = notificationHistoryWriteQueue.then(work, work);
    notificationHistoryWriteQueue = next.catch(() => {});
    return next;
}

function enqueueDeepSeekStatsWrite(work) {
    const next = deepseekStatsWriteQueue.then(work, work);
    deepseekStatsWriteQueue = next.catch(() => {});
    return next;
}

function clearNotificationHistory() {
    return enqueueNotificationHistoryWrite(() => chrome.storage.local.set({ notificationHistory: [] }));
}

async function removeHistoryForItem(itemId) {
    const targetId = String(itemId || '');
    if (!targetId) throw new Error('Не указан товар.');
    return enqueueNotificationHistoryWrite(async () => {
        const data = await chrome.storage.local.get({ notificationHistory: [] });
        const history = Array.isArray(data.notificationHistory) ? data.notificationHistory : [];
        await chrome.storage.local.set({
            notificationHistory: history.filter(entry => String(entry.itemId) !== targetId)
        });
    });
}

function createHistoryEntryId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendHistoryEntry(entry) {
    return enqueueNotificationHistoryWrite(async () => {
        const data = await chrome.storage.local.get({ notificationHistory: [] });
        const history = Array.isArray(data.notificationHistory) ? [...data.notificationHistory] : [];
        history.push({
            ...entry,
            id: String(entry?.id || createHistoryEntryId()),
            timestamp: entry?.timestamp || new Date().toISOString()
        });
        await chrome.storage.local.set({ notificationHistory: history });
    });
}

function appendActivityHistory(rawEntry = {}) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        throw new Error('Событие истории имеет неверный формат.');
    }
    const allowedStatuses = ['started', 'success', 'completed', 'partial', 'error', 'noop'];
    const status = allowedStatuses.includes(String(rawEntry.status || 'success'))
        ? String(rawEntry.status || 'success')
        : 'success';
    const platform = rawEntry.platform ? String(rawEntry.platform).trim().slice(0, 40) : '';
    const entityId = rawEntry.entityId ? String(rawEntry.entityId).trim().slice(0, 160) : '';
    const url = rawEntry.url ? String(rawEntry.url).trim().slice(0, 1000) : '';
    const title = String(rawEntry.title || 'Действие MarketPilot').trim().slice(0, 240);
    const message = String(rawEntry.message || '').trim().slice(0, 2000);
    const action = String(rawEntry.action || 'user_action').trim().slice(0, 80);
    return appendHistoryEntry({
        type: 'action',
        action,
        status,
        title,
        message,
        ...(platform ? { platform } : {}),
        ...(entityId ? { entityId } : {}),
        ...(url ? { url } : {})
    });
}

function appendNotificationHistory(entry) {
    return appendHistoryEntry({ type: 'price_alert', ...entry });
}

async function upsertTrackedItem(rawItem) {
    if (!rawItem || typeof rawItem !== 'object' || !isSupportedTrackingUrl(rawItem.url)) {
        throw new Error('Недопустимая ссылка товара.');
    }

    const targetPrice = Number(rawItem.targetPrice);
    if (!Number.isInteger(targetPrice) || targetPrice < 1 || targetPrice > 1000000000) {
        throw new Error('Целевая цена должна быть целым числом больше нуля.');
    }

    const parsedLastPrice = rawItem.lastPrice === null || rawItem.lastPrice === undefined || rawItem.lastPrice === ''
        ? null
        : Number(rawItem.lastPrice);
    const item = {
        id: String(rawItem.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        url: normalizeTrackingUrl(rawItem.url),
        title: String(rawItem.title || rawItem.url).slice(0, 500),
        targetPrice,
        priceType: rawItem.priceType === 'nobank' ? 'nobank' : 'bank',
        lastPrice: Number.isFinite(parsedLastPrice) && parsedLastPrice >= 0 ? parsedLastPrice : null,
        addedAt: rawItem.addedAt || new Date().toISOString()
    };
    return enqueueTrackedItemsWrite(async () => {
        const data = await chrome.storage.local.get({ trackedItems: [] });
        const items = Array.isArray(data.trackedItems) ? [...data.trackedItems] : [];
        const index = items.findIndex((entry) => String(entry.id) === item.id || normalizeTrackingUrl(entry.url) === item.url);
        if (index >= 0) {
            const existing = items[index];
            items[index] = {
                ...existing,
                ...item,
                id: String(existing.id || item.id),
                addedAt: existing.addedAt || item.addedAt,
                lastPrice: rawItem.lastPrice === null || rawItem.lastPrice === undefined || rawItem.lastPrice === ''
                    ? (existing.lastPrice ?? null)
                    : item.lastPrice
            };
        } else {
            items.push(item);
        }
        await chrome.storage.local.set({ trackedItems: items });
        const savedItem = items[index >= 0 ? index : items.length - 1];
        await appendActivityHistory({
            action: index >= 0 ? 'tracking_updated' : 'tracking_added',
            title: index >= 0 ? 'Ozon: отслеживание обновлено' : 'Ozon: товар добавлен в мониторинг',
            message: `${savedItem.title || savedItem.url} · цель ${savedItem.targetPrice.toLocaleString('ru-RU')} ₽`,
            platform: 'ozon',
            entityId: savedItem.id,
            url: savedItem.url
        });
        return savedItem;
    });
}

async function removeTrackedItem(id) {
    const itemId = String(id || '');
    if (!itemId) throw new Error('Не указан товар.');
    return enqueueTrackedItemsWrite(async () => {
        const data = await chrome.storage.local.get({ trackedItems: [] });
        const items = Array.isArray(data.trackedItems) ? data.trackedItems : [];
        const removedItem = items.find((item) => String(item.id) === itemId);
        await chrome.storage.local.set({ trackedItems: items.filter((item) => String(item.id) !== itemId) });
        await appendActivityHistory({
            action: 'tracking_removed',
            status: removedItem ? 'success' : 'noop',
            title: removedItem ? 'Ozon: отслеживание удалено' : 'Ozon: товар для удаления не найден',
            message: removedItem ? (removedItem.title || removedItem.url) : `Идентификатор: ${itemId}`,
            platform: 'ozon',
            entityId: itemId,
            ...(removedItem?.url ? { url: removedItem.url } : {})
        });
    });
}

function normalizeSettingsPatch(rawValues) {
    if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
        throw new Error('Настройки должны быть объектом.');
    }

    const values = {};
    for (const [key, rawValue] of Object.entries(rawValues)) {
        if (!SETTINGS_KEYS.has(key)) continue;

        if (key === 'theme') {
            const value = String(rawValue ?? '').trim().toLowerCase();
            if (!['light', 'dark'].includes(value)) throw new Error('Тема имеет неверное значение.');
            values[key] = value;
            continue;
        }

        if (key === 'checkInterval') {
            const value = Number(rawValue);
            if (!Number.isInteger(value) || value < 1 || value > 10080) {
                throw new Error('Интервал должен быть целым числом от 1 до 10080 минут.');
            }
            values[key] = value;
            continue;
        }

        if (key === 'wbConcurrency' || key === 'citilinkConcurrency') {
            const value = Number(rawValue);
            if (!Number.isInteger(value) || value < DEFAULT_COLLECTION_CONCURRENCY || value > MAX_COLLECTION_CONCURRENCY) {
                throw new Error('Количество одновременных запросов должно быть целым числом от 1 до 5.');
            }
            values[key] = value;
            continue;
        }

        if (key === 'deepseekModel') {
            const value = normalizeDeepSeekModel(rawValue);
            if (value.length > 500) throw new Error('Идентификатор модели слишком длинный.');
            values[key] = value;
            continue;
        }

        if (key === 'deepseekThinking') {
            const value = String(rawValue ?? '').trim().toLowerCase();
            if (!['enabled', 'disabled'].includes(value)) throw new Error('Режим мышления DeepSeek имеет неверное значение.');
            values[key] = value;
            continue;
        }

        if (key === 'deepseekReasoningEffort') {
            const value = String(rawValue ?? '').trim().toLowerCase();
            if (!['low', 'high', 'max'].includes(value)) throw new Error('Сила мышления DeepSeek имеет неверное значение.');
            values[key] = value;
            continue;
        }

        if (key === 'deepseekAutoSend') {
            values[key] = Boolean(rawValue);
            continue;
        }

        if (key === 'deepseekDelay') {
            const value = Number(rawValue);
            if (!Number.isInteger(value) || value < 1 || value > 60) {
                throw new Error('Задержка DeepSeek должна быть от 1 до 60 секунд.');
            }
            values[key] = value;
            continue;
        }

        if (key === 'ozonReplySettings') {
            if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
                throw new Error('Настройки задержки ответа имеют неверный формат.');
            }
            const minDelay = Number(rawValue.minDelay);
            const maxDelay = Number(rawValue.maxDelay);
            if (!Number.isInteger(minDelay) || !Number.isInteger(maxDelay)
                || minDelay < 1 || maxDelay < minDelay || maxDelay > 120) {
                throw new Error('Диапазон задержки ответа имеет неверный формат.');
            }
            values[key] = {
                delayEnabled: Boolean(rawValue.delayEnabled),
                minDelay,
                maxDelay
            };
            continue;
        }

        if (key === 'ozonReplyTemplates') {
            if (!Array.isArray(rawValue) || rawValue.length > 100) {
                throw new Error('Шаблоны ответов имеют неверный формат.');
            }
            values[key] = rawValue.map((template) => ({
                id: String(template?.id || '').slice(0, 120),
                title: String(template?.title || '').trim().slice(0, 200),
                text: String(template?.text || '').trim().slice(0, 10000),
                ...(template?.createdAt ? { createdAt: String(template.createdAt).slice(0, 80) } : {})
            })).filter(template => template.id && template.title && template.text);
            continue;
        }

        const value = String(rawValue ?? '').trim();
        const maxLength = key === 'deepseekApiKey' || key === 'deepseekModel' ? 500 : 30000;
        if (value.length > maxLength) {
            throw new Error('Значение ' + key + ' слишком длинное.');
        }
        values[key] = value;
    }

    if (!Object.keys(values).length) {
        throw new Error('Нет поддерживаемых настроек для сохранения.');
    }
    return values;
}

async function updateSettings(rawValues) {
    const values = normalizeSettingsPatch(rawValues);
    await chrome.storage.local.set(values);
    const labels = {
        theme: 'тема интерфейса',
        checkInterval: 'интервал проверки',
        wbConcurrency: 'параллельность WB',
        citilinkConcurrency: 'параллельность Citilink',
        deepseekApiKey: 'API-ключ DeepSeek',
        deepseekPrompt: 'системный промпт',
        deepseekReviewPrompt: 'промпт отзывов',
        deepseekCitilinkPrompt: 'промпт Citilink',
        deepseekModel: 'модель DeepSeek',
        deepseekThinking: 'режим мышления DeepSeek',
        deepseekReasoningEffort: 'сила мышления DeepSeek',
        deepseekAutoSend: 'автоотправка DeepSeek',
        deepseekDelay: 'задержка DeepSeek',
        ozonReplySettings: 'настройки ответов Ozon',
        ozonReplyTemplates: 'шаблоны ответов Ozon'
    };
    await appendActivityHistory({
        action: 'settings_updated',
        title: 'Настройки изменены',
        message: Object.keys(values).map((key) => labels[key] || key).join(', ')
    });
    return values;
}

async function clearCollectionResults(marketplace) {
    const keyByMarketplace = {
        wb: ['wbLastResults', 'wbStatus'],
        citilink: ['citilinkLastResults', 'citilinkStatus']
    };
    const keys = keyByMarketplace[String(marketplace || '').toLowerCase()];
    if (!keys) throw new Error('Неизвестный магазин для очистки.');
    const [resultsKey, statusKey] = keys;
    const current = await chrome.storage.local.get({ [statusKey]: null });
    if (current[statusKey]?.running) {
        throw new Error('Нельзя очистить результаты во время выполнения задания.');
    }
    await chrome.storage.local.set({
        [resultsKey]: {},
        [statusKey]: statusKey === 'wbStatus'
            ? { ...DEFAULT_WB_STATUS }
            : { ...DEFAULT_CITILINK_STATUS }
    });
    await appendActivityHistory({
        action: `${String(marketplace).toLowerCase()}_results_cleared`,
        title: `${String(marketplace).toLowerCase() === 'wb' ? 'Wildberries' : 'Citilink'}: результаты очищены`,
        message: 'Сохранённые результаты сбора удалены.',
        platform: String(marketplace).toLowerCase() === 'wb' ? 'wildberries' : 'citilink'
    });
}

async function launchPriceCheck() {
    if (priceCheckRunActive) {
        return { status: 'already_running', jobId: null };
    }

    priceCheckRunActive = true;
    try {
        const data = await chrome.storage.local.get({ priceCheckStatus: null });
        if (isFreshCollectionRun(data.priceCheckStatus)) {
            priceCheckRunActive = false;
            return { status: 'already_running', jobId: data.priceCheckStatus.jobId || null };
        }

        const jobId = createCollectionJobId('price-check');
        void checkPrices(jobId).catch(error => {
            console.error('Не удалось выполнить проверку цен:', error);
        }).finally(() => {
            priceCheckRunActive = false;
        });
        return { status: 'started', jobId };
    } catch (error) {
        priceCheckRunActive = false;
        throw error;
    }
}

async function checkPrices(jobId = createCollectionJobId('price-check')) {
    console.log("Starting price check...");

    const startedAt = new Date().toISOString();
    let done = 0;
    let failed = 0;
    const priceUpdates = new Map();
    const data = await chrome.storage.local.get({ trackedItems: [] });
    const items = Array.isArray(data.trackedItems) ? data.trackedItems : [];
    await appendActivityHistory({
        action: 'price_check',
        status: 'started',
        title: 'Ozon: проверка цен запущена',
        message: `Товаров: ${items.length}.`,
        platform: 'ozon',
        entityId: jobId
    });
    const persistStatus = (patch = {}) => chrome.storage.local.set({
        priceCheckStatus: {
            jobId,
            total: items.length,
            done,
            running: true,
            phase: 'checking',
            startedAt,
            updatedAt: new Date().toISOString(),
            error: '',
            ...patch
        }
    });

    await persistStatus({ running: items.length > 0, phase: items.length ? 'checking' : 'idle' });
    if (items.length === 0) {
        console.log("No items to check.");
        await appendActivityHistory({
            action: 'price_check',
            status: 'noop',
            title: 'Ozon: проверка цен не выполнена',
            message: 'Нет товаров для проверки.',
            platform: 'ozon',
            entityId: jobId
        });
        return;
    }

    try {
        // Check sequentially to avoid overwhelming browser/tab system.
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            try {
                const currentData = await checkSingleItem(item);

                const hasCurrentPrice = currentData && Number.isFinite(Number(currentData.price)) && Number(currentData.price) >= 0;
                if (hasCurrentPrice) {
                    const latestData = await chrome.storage.local.get({ trackedItems: [] });
                    const latestItem = (Array.isArray(latestData.trackedItems) ? latestData.trackedItems : [])
                        .find((entry) => String(entry.id) === String(item.id));
                    if (!latestItem || normalizeTrackingUrl(latestItem.url) !== normalizeTrackingUrl(item.url)) {
                        console.warn(`Товар изменён или удалён во время проверки: ${item.url}`);
                    } else {
                        const currentPrice = currentData.price;
                        const title = currentData.title || latestItem.title || item.title || item.url;
                        const update = { lastPrice: currentPrice, updatedAt: new Date().toISOString() };
                        if (currentData.title && item.title !== currentData.title) update.title = currentData.title;
                        priceUpdates.set(String(item.id), update);

                        if (currentPrice <= latestItem.targetPrice) {
                            chrome.notifications.create({
                                type: "basic",
                                title: "Цена достигла цели на Ozon!",
                                message: `Цена ${currentPrice}₽ (цель: ${latestItem.targetPrice}₽)\n${title}`,
                                iconUrl: EXTENSION_ICON_URL,
                                requireInteraction: true
                            });

                            await appendNotificationHistory({
                                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                                itemId: item.id,
                                url: item.url,
                                title,
                                price: currentPrice,
                                targetPrice: latestItem.targetPrice,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                } else {
                    failed++;
                    console.warn(`Цена не найдена для ${item.url}:`, currentData?.error || 'нет значения');
                }
            } catch (error) {
                failed++;
                console.error(`Error checking item ${item.url}:`, error);
            }

            done++;
            await persistStatus({ done });
        }

        if (priceUpdates.size > 0) {
            await enqueueTrackedItemsWrite(async () => {
                const latestData = await chrome.storage.local.get({ trackedItems: [] });
                const latestItems = Array.isArray(latestData.trackedItems) ? latestData.trackedItems : [];
                const mergedItems = latestItems.map((item) => ({
                    ...item,
                    ...(priceUpdates.get(String(item.id)) || {})
                }));
                await chrome.storage.local.set({ trackedItems: mergedItems });
            });
        }

        await chrome.storage.local.set({ lastCheckTimestamp: Date.now() });
        await persistStatus({
            done: items.length,
            running: false,
            phase: failed === items.length ? 'error' : failed > 0 ? 'partial' : 'done',
            error: failed > 0 ? `Не удалось проверить товаров: ${failed}.` : ''
        });
        await appendActivityHistory({
            action: 'price_check',
            status: failed === items.length ? 'error' : failed ? 'partial' : 'completed',
            title: `Ozon: проверка цен ${failed ? 'завершена частично' : 'завершена'}`,
            message: `Проверено: ${items.length - failed} из ${items.length}${failed ? `. Ошибок: ${failed}.` : '.'}`,
            platform: 'ozon',
            entityId: jobId
        });
        console.log("Price check finished.");
    } catch (error) {
        await persistStatus({
            done,
            running: false,
            phase: 'error',
            error: error?.message || 'Проверка цен завершилась с ошибкой.'
        });
        await appendActivityHistory({
            action: 'price_check',
            status: 'error',
            title: 'Ozon: проверка цен завершилась ошибкой',
            message: error?.message || 'Проверка цен завершилась с ошибкой.',
            platform: 'ozon',
            entityId: jobId
        });
        throw error;
    }
}

async function checkSingleItem(item) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create({ url: item.url, active: false }, (tab) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }
            if (!tab?.id) {
                reject(new Error('Не удалось открыть вкладку товара.'));
                return;
            }

            const tabId = tab.id;

            const isWildberries = (() => {
                try { return new URL(item.url).hostname.replace(/^www\./, '') === 'wildberries.ru'; } catch { return false; }
            })();

            const finish = () => {
                const action = isWildberries ? 'getPrices' : 'get_current_product';
                chrome.tabs.sendMessage(tabId, { action, priceType: item.priceType }, (response) => {
                    const messageError = chrome.runtime.lastError;
                    chrome.tabs.remove(tabId, () => {
                        if (chrome.runtime.lastError) console.error('Error closing tab:', chrome.runtime.lastError);
                    });
                    if (messageError) {
                        reject(messageError);
                        return;
                    }
                    if (!response) {
                        resolve({ price: null, title: null, error: 'Content script не вернул данные.' });
                        return;
                    }
                    if (isWildberries) {
                        const price = [response.wallet, response.total]
                            .map((value) => Number(value))
                            .find((value) => Number.isFinite(value)) ?? null;
                        resolve({ ...response, price, title: response.title || null });
                    } else {
                        resolve(response);
                    }
                });
            };

            setTimeout(() => {
                finish();
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

function createCollectionJobId(kind) {
    return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCollectionArticles(articles) {
    return Array.from(new Set((articles || [])
        .map(article => String(article).trim())
        .filter(Boolean)));
}

function normalizeCollectionConcurrency(value) {
    const concurrency = Number(value);
    return Number.isInteger(concurrency)
        && concurrency >= DEFAULT_COLLECTION_CONCURRENCY
        && concurrency <= MAX_COLLECTION_CONCURRENCY
        ? concurrency
        : DEFAULT_COLLECTION_CONCURRENCY;
}

async function runWithConcurrency(items, concurrency, worker) {
    let nextIndex = 0;
    const workerCount = Math.min(normalizeCollectionConcurrency(concurrency), items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            await worker(items[index], index);
        }
    }));
}

function createCollectionStateWriter(statusKey, resultsKey, getStatus, getResults) {
    let writeQueue = Promise.resolve();
    return (patch = {}) => {
        const status = getStatus(patch);
        const results = { ...getResults() };
        writeQueue = writeQueue.then(() => chrome.storage.local.set({
            [statusKey]: status,
            [resultsKey]: results
        }));
        return writeQueue;
    };
}

function isFreshCollectionRun(status) {
    if (!status?.running) return false;
    const updatedAt = Date.parse(status.updatedAt || '');
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt <= COLLECTION_JOB_STALE_MS;
}

async function launchCollectionJob(kind, statusKey, runner) {
    if (pendingCollectionRuns.has(kind)) {
        return { status: 'already_running', jobId: null };
    }

    pendingCollectionRuns.add(kind);
    try {
        const data = await chrome.storage.local.get({ [statusKey]: null });
        const existingStatus = data[statusKey];
        if (isFreshCollectionRun(existingStatus)) {
            pendingCollectionRuns.delete(kind);
            return { status: 'already_running', jobId: existingStatus.jobId || null };
        }

        void runner().catch(error => {
            console.error(`Не удалось выполнить задание ${kind}:`, error);
            void appendActivityHistory({
                action: `${kind}_collection`,
                status: 'error',
                title: `${kind === 'wb' ? 'Wildberries' : 'Citilink'}: сбор завершился ошибкой`,
                message: error?.message || 'Неизвестная ошибка фонового задания.',
                platform: kind === 'wb' ? 'wildberries' : 'citilink'
            });
        }).finally(() => {
            pendingCollectionRuns.delete(kind);
        });
        return { status: 'started' };
    } catch (error) {
        pendingCollectionRuns.delete(kind);
        throw error;
    }
}

async function startWbBackgroundFetch(articles) {
    const settings = await chrome.storage.local.get({ wbConcurrency: DEFAULT_COLLECTION_CONCURRENCY });
    const concurrency = normalizeCollectionConcurrency(settings.wbConcurrency);
    const normalizedArticles = normalizeCollectionArticles(articles);
    const total = normalizedArticles.length;
    let done = 0;
    const results = {};
    const jobId = createCollectionJobId('wb');
    const startedAt = new Date().toISOString();
    const getStatus = (patch = {}) => ({
        jobId,
        articles: normalizedArticles,
        total,
        done,
        running: true,
        phase: 'processing',
        startedAt,
        updatedAt: new Date().toISOString(),
        error: '',
        ...patch
    });

    if (total === 0) {
        await chrome.storage.local.set({
            wbStatus: {
                jobId: null,
                articles: [],
                total: 0,
                done: 0,
                running: false,
                phase: 'idle',
                startedAt: null,
                updatedAt: new Date().toISOString(),
                error: ''
            },
            wbLastResults: {}
        });
        return;
    }

    // Initialize status
    const persistState = createCollectionStateWriter('wbStatus', 'wbLastResults', getStatus, () => results);
    await persistState();
    await appendActivityHistory({
        action: 'wb_collection',
        status: 'started',
        title: 'Wildberries: сбор запущен',
        message: `Артикулов: ${total}. Одновременная обработка: ${concurrency}.`,
        platform: 'wildberries',
        entityId: jobId
    });

    await runWithConcurrency(normalizedArticles, concurrency, async (id) => {
        const result = await fetchOneWb(id).catch(error => ({
            wallet: null,
            total: null,
            error: error?.message || 'Неизвестная ошибка обработки'
        }));
        results[id] = result;
        done++;
        await persistState({
            done,
            running: done < total,
            phase: done < total ? 'processing' : 'done'
        });
    });

    const failed = Object.values(results).filter((result) => result?.error).length;
    await appendActivityHistory({
        action: 'wb_collection',
        status: failed === total ? 'error' : failed ? 'partial' : 'completed',
        title: `Wildberries: сбор ${failed ? 'завершён частично' : 'завершён'}`,
        message: `Обработано: ${total - failed} из ${total}${failed ? `. Ошибок: ${failed}.` : '.'}`,
        platform: 'wildberries',
        entityId: jobId
    });

    // Show completion notification
    chrome.notifications.create(`wb-done-${Date.now()}`, {
        type: "basic",
        title: "Wildberries: Загрузка завершена",
        message: `Готово! Цены по ${total} артикулам успешно загружены.`,
        iconUrl: EXTENSION_ICON_URL,
        requireInteraction: true
    });
}

async function fetchOneWb(articleId) {
    const url = 'https://www.wildberries.ru/catalog/' + articleId + '/detail.aspx';
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab?.id) throw new Error('Не удалось открыть карточку Wildberries.');

    return new Promise((resolve) => {
        let settled = false;
        let timeoutId = null;
        let settleDelayId = null;

        const finish = async (result) => {
            if (settled) return;
            settled = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            if (timeoutId) clearTimeout(timeoutId);
            if (settleDelayId) clearTimeout(settleDelayId);
            try {
                await chrome.tabs.remove(tab.id);
            } catch (_) {
                // The tab may already be closed by the browser.
            }
            resolve(result);
        };

        const onUpdated = (tabId, changeInfo) => {
            if (tabId !== tab.id || changeInfo.status !== 'complete') return;
            if (settled || settleDelayId) return;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            settleDelayId = setTimeout(() => {
                try {
                    chrome.tabs.sendMessage(tab.id, { action: 'getPrices' }, (response) => {
                        if (chrome.runtime.lastError) {
                            void finish({
                                wallet: null,
                                total: null,
                                error: chrome.runtime.lastError.message
                            });
                            return;
                        }
                        void finish(response ?? { wallet: null, total: null });
                    });
                } catch (error) {
                    void finish({
                        wallet: null,
                        total: null,
                        error: error?.message || 'Не удалось получить цены Wildberries.'
                    });
                }
            }, 1000);
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tab.id, (currentTab) => {
            if (!chrome.runtime.lastError && currentTab?.status === 'complete') {
                onUpdated(tab.id, { status: 'complete' });
            }
        });
        timeoutId = setTimeout(() => {
            void finish({ wallet: null, total: null, error: 'Таймаут загрузки карточки Wildberries.' });
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

async function fetchOneCitilink(articleId, options = {}) {
    const generateDescription = options.generateDescription !== false;
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

    const { characteristics, characteristicsText, ...productForStorage } = product;
    const imageCount = Array.isArray(productForStorage.imageUrls)
        ? productForStorage.imageUrls.length
        : 0;
    let description = '';
    let descriptionStatus = 'not_requested';

    if (generateDescription) {
        const aiResult = await handleDeepSeekGenerateDescription(product);
        if (!aiResult.success) {
            throw new Error(aiResult.error || 'DeepSeek не вернул описание');
        }
        description = aiResult.description || '';
        descriptionStatus = 'generated';
    }

    return {
        ...productForStorage,
        article: normalizedArticle,
        imageCount,
        description,
        descriptionStatus,
        status: 'done',
        error: ''
    };
}

async function startCitilinkBackgroundFetch(articles, options = {}) {
    const settings = await chrome.storage.local.get({ citilinkConcurrency: DEFAULT_COLLECTION_CONCURRENCY });
    const concurrency = normalizeCollectionConcurrency(settings.citilinkConcurrency);
    const generateDescription = options.generateDescription !== false;
    const normalizedArticles = normalizeCollectionArticles(articles);
    const total = normalizedArticles.length;
    const results = {};
    const jobId = createCollectionJobId('citilink');
    const startedAt = new Date().toISOString();
    let done = 0;
    const getStatus = (patch = {}) => ({
        jobId,
        articles: normalizedArticles,
        generateDescription,
        total,
        done,
        running: true,
        phase: 'starting',
        startedAt,
        updatedAt: new Date().toISOString(),
        error: '',
        ...patch
    });

    if (total === 0) {
        await chrome.storage.local.set({
            citilinkStatus: {
                jobId: null,
                articles: [],
                generateDescription,
                total: 0,
                done: 0,
                running: false,
                phase: 'idle',
                startedAt: null,
                updatedAt: new Date().toISOString(),
                error: ''
            },
            citilinkLastResults: {}
        });
        return;
    }

    await chrome.storage.local.set({
        citilinkStatus: getStatus(),
        citilinkLastResults: {}
    });
    await appendActivityHistory({
        action: 'citilink_collection',
        status: 'started',
        title: 'Citilink: сбор запущен',
        message: `Товаров: ${total}. Одновременная обработка: ${concurrency}${generateDescription ? ', с генерацией описаний.' : '.'}`,
        platform: 'citilink',
        entityId: jobId
    });

    if (generateDescription && !(await getDeepSeekApiKey())) {
        const error = 'DeepSeek API-ключ не настроен. Откройте вкладку AI и сохраните ключ.';
        normalizedArticles.forEach(article => {
            results[article] = { article, status: 'error', error };
        });
        await chrome.storage.local.set({
            citilinkStatus: getStatus({ done: total, running: false, phase: 'error', error }),
            citilinkLastResults: results
        });
        await appendActivityHistory({
            action: 'citilink_collection',
            status: 'error',
            title: 'Citilink: сбор не запущен',
            message: error,
            platform: 'citilink',
            entityId: jobId
        });
        return;
    }

    const persistState = createCollectionStateWriter('citilinkStatus', 'citilinkLastResults', getStatus, () => results);
    await runWithConcurrency(normalizedArticles, concurrency, async (article) => {
        results[article] = { article, status: 'searching', error: '' };
        await persistState({ phase: 'searching' });

        try {
            results[article] = await fetchOneCitilink(article, { generateDescription });
        } catch (error) {
            results[article] = {
                article,
                status: 'error',
                error: error?.message || 'Неизвестная ошибка обработки'
            };
        }

        done += 1;
        await persistState({
            done,
            running: done < total,
            phase: done < total ? 'processing' : 'done'
        });
    });

    const failed = Object.values(results).filter((result) => result?.error || result?.status === 'error').length;
    await appendActivityHistory({
        action: 'citilink_collection',
        status: failed === total ? 'error' : failed ? 'partial' : 'completed',
        title: `Citilink: сбор ${failed ? 'завершён частично' : 'завершён'}`,
        message: `Обработано: ${total - failed} из ${total}${failed ? `. Ошибок: ${failed}.` : '.'}`,
        platform: 'citilink',
        entityId: jobId
    });

    chrome.notifications.create(`citilink-done-${Date.now()}`, {
        type: 'basic',
        title: 'Citilink: обработка завершена',
        message: `Готово! Обработано товаров: ${total}.`,
        iconUrl: EXTENSION_ICON_URL,
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

function recordDeepSeekActivity(action, title, result, extra = {}) {
    void appendActivityHistory({
        action,
        status: result?.success ? 'success' : 'error',
        title: result?.success ? title : `${title}: ошибка`,
        message: result?.success ? 'Генерация завершена.' : (result?.error || 'DeepSeek не вернул результат.'),
        ...extra
    }).catch((error) => console.error('Не удалось записать действие DeepSeek:', error));
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

async function handleDeepSeekCheckBalance(explicitKey, options = {}) {
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

        let officialUsage = null;
        let usageError = '';
        if (options.includeUsage) {
            const usageResult = await fetchOfficialDeepSeekUsage();
            officialUsage = usageResult.usage || null;
            usageError = usageResult.success ? '' : (usageResult.error || 'Официальный usage пока недоступен.');
        }

        return { success: true, balanceInfo: data, officialUsage, usageError };
    } catch (err) {
        console.error('DeepSeek balance fetch error:', err);
        const isTimeout = err.name === 'TimeoutError';
        return {
            success: false,
            error: isTimeout ? 'Превышено время ожидания ответа DeepSeek (таймаут 15с)' : (err.message || 'Сетевая ошибка при проверке баланса')
        };
    }
}

async function requestDeepSeekCompletion({ systemPrompt, userMessageContent, model, temperature, thinking, reasoningEffort }) {
    const apiKey = await getDeepSeekApiKey();
    if (!apiKey) {
        return { success: false, error: 'DeepSeek API-ключ не настроен. Укажите его в расширении.' };
    }

    try {
        const modelId = normalizeDeepSeekModel(model);
        const modernModel = isDeepSeekModernModel(modelId);
        const thinkingMode = normalizeDeepSeekThinking(thinking);
        const effort = normalizeDeepSeekReasoningEffort(reasoningEffort);
        const requestBody = {
            model: modelId,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessageContent }
            ],
            max_tokens: 1024
        };
        if (modernModel) {
            requestBody.thinking = { type: thinkingMode };
            requestBody.reasoning_effort = thinkingMode === 'enabled' ? effort : 'none';
        } else {
            requestBody.temperature = Number(temperature) || 0.5;
        }
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody),
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
        const promptTokens = usage.prompt_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const totalTokens = usage.total_tokens || (promptTokens + completionTokens);
        const usedAt = Date.now();
        const requestCostUSD = estimateDeepSeekCostUsd(modelId, usage, usedAt);

        const stats = await enqueueDeepSeekStatsWrite(async () => {
            const statsData = await chrome.storage.local.get({
                deepseekStats: {
                    totalRequests: 0,
                    totalPromptTokens: 0,
                    totalCompletionTokens: 0,
                    totalTokens: 0,
                    estimatedCostUSD: 0,
                    daily: {}
                }
            });
            const nextStats = { ...(statsData.deepseekStats || {}) };
            nextStats.totalRequests = (nextStats.totalRequests || 0) + 1;
            nextStats.totalPromptTokens = (nextStats.totalPromptTokens || 0) + promptTokens;
            nextStats.totalCompletionTokens = (nextStats.totalCompletionTokens || 0) + completionTokens;
            nextStats.totalTokens = (nextStats.totalTokens || 0) + totalTokens;
            const previousCostUSD = Number(nextStats.estimatedCostUSD ?? nextStats.estimatedCostCNY) || 0;
            nextStats.estimatedCostUSD = Number((previousCostUSD + requestCostUSD).toFixed(6));
            delete nextStats.estimatedCostCNY;
            const dailyUsage = isObjectRecord(nextStats.daily) ? { ...nextStats.daily } : {};
            const dayKey = getLocalDayKey(usedAt);
            const dayStats = isObjectRecord(dailyUsage[dayKey]) ? { ...dailyUsage[dayKey] } : {};
            dayStats.requests = (dayStats.requests || 0) + 1;
            dayStats.promptTokens = (dayStats.promptTokens || 0) + promptTokens;
            dayStats.completionTokens = (dayStats.completionTokens || 0) + completionTokens;
            dayStats.totalTokens = (dayStats.totalTokens || 0) + totalTokens;
            const previousDayCostUSD = Number(dayStats.estimatedCostUSD ?? dayStats.estimatedCostCNY) || 0;
            dayStats.estimatedCostUSD = Number((previousDayCostUSD + requestCostUSD).toFixed(6));
            delete dayStats.estimatedCostCNY;
            const models = isObjectRecord(dayStats.models) ? { ...dayStats.models } : {};
            const modelStats = isObjectRecord(models[modelId]) ? { ...models[modelId] } : {};
            modelStats.requests = (modelStats.requests || 0) + 1;
            modelStats.totalTokens = (modelStats.totalTokens || 0) + totalTokens;
            const previousModelCostUSD = Number(modelStats.estimatedCostUSD ?? modelStats.estimatedCostCNY) || 0;
            modelStats.estimatedCostUSD = Number((previousModelCostUSD + requestCostUSD).toFixed(6));
            delete modelStats.estimatedCostCNY;
            models[modelId] = modelStats;
            dayStats.models = models;
            dailyUsage[dayKey] = dayStats;
            nextStats.daily = trimDeepSeekDailyUsage(dailyUsage, usedAt);
            nextStats.lastUsedAt = usedAt;
            await chrome.storage.local.set({ deepseekStats: nextStats });
            return nextStats;
        });
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
        deepseekModel: DEFAULT_DEEPSEEK_MODEL,
        deepseekThinking: DEFAULT_DEEPSEEK_THINKING,
        deepseekReasoningEffort: DEFAULT_DEEPSEEK_REASONING_EFFORT,
        deepseekTemperature: 0.5
    });
    const rawSystemPrompt = settings.deepseekPrompt || DEFAULT_DEEPSEEK_SYSTEM_PROMPT;
    const model = normalizeDeepSeekModel(settings.deepseekModel);
    const thinking = normalizeDeepSeekThinking(settings.deepseekThinking);
    const reasoningEffort = normalizeDeepSeekReasoningEffort(settings.deepseekReasoningEffort);
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
        temperature,
        thinking,
        reasoningEffort
    });

    recordDeepSeekActivity('deepseek_answer_generated', 'DeepSeek: ответ на вопрос сгенерирован', result, { platform: 'ozon' });
    return result.success ? { ...result, answer: result.text } : result;
}

async function handleDeepSeekGenerateReviewAnswer(inputData) {
    const settings = await chrome.storage.local.get({
        deepseekReviewPrompt: DEFAULT_DEEPSEEK_REVIEW_PROMPT,
        deepseekModel: DEFAULT_DEEPSEEK_MODEL,
        deepseekThinking: DEFAULT_DEEPSEEK_THINKING,
        deepseekReasoningEffort: DEFAULT_DEEPSEEK_REASONING_EFFORT,
        deepseekTemperature: 0.5
    });
    const rawSystemPrompt = (settings.deepseekReviewPrompt || '').trim() || DEFAULT_DEEPSEEK_REVIEW_PROMPT;
    const model = normalizeDeepSeekModel(settings.deepseekModel);
    const thinking = normalizeDeepSeekThinking(settings.deepseekThinking);
    const reasoningEffort = normalizeDeepSeekReasoningEffort(settings.deepseekReasoningEffort);
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
        temperature,
        thinking,
        reasoningEffort
    });

    recordDeepSeekActivity('deepseek_review_generated', 'DeepSeek: ответ на отзыв сгенерирован', result, { platform: 'ozon' });
    return result.success ? { ...result, answer: result.text } : result;
}

async function handleDeepSeekGenerateDescription(inputData) {
    const settings = await chrome.storage.local.get({
        deepseekCitilinkPrompt: DEFAULT_CITILINK_SYSTEM_PROMPT,
        deepseekModel: DEFAULT_DEEPSEEK_MODEL,
        deepseekThinking: DEFAULT_DEEPSEEK_THINKING,
        deepseekReasoningEffort: DEFAULT_DEEPSEEK_REASONING_EFFORT,
        deepseekTemperature: 0.5
    });
    const rawSystemPrompt = settings.deepseekCitilinkPrompt || DEFAULT_CITILINK_SYSTEM_PROMPT;
    const model = normalizeDeepSeekModel(settings.deepseekModel);
    const thinking = normalizeDeepSeekThinking(settings.deepseekThinking);
    const reasoningEffort = normalizeDeepSeekReasoningEffort(settings.deepseekReasoningEffort);
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
        temperature,
        thinking,
        reasoningEffort
    });

    recordDeepSeekActivity('deepseek_description_generated', 'DeepSeek: описание Citilink сгенерировано', result, {
        platform: 'citilink',
        ...(article ? { entityId: String(article) } : {})
    });
    return result.success ? { ...result, description: result.text } : result;
}

async function handleDeepSeekResetStats() {
    const freshStats = {
        totalRequests: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        estimatedCostUSD: 0,
        daily: {},
        lastResetAt: Date.now()
    };
    await enqueueDeepSeekStatsWrite(() => chrome.storage.local.set({ deepseekStats: freshStats }));
    return { success: true, stats: freshStats };
}
