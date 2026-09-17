import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const store = {
  storageSchemaVersion: 0,
  trackedItems: 'broken',
  notificationHistory: null,
  wbStatus: [],
  citilinkStatus: { total: 1, done: 0, running: true },
  priceCheckStatus: null,
  theme: '',
  checkInterval: 0,
  deepseekModel: 'deepseek-chat',
  deepseekThinking: '',
  deepseekReasoningEffort: ''
};
const listeners = { installed: [], startup: [], message: [], alarm: [], changed: [], tabUpdated: [] };
const event = (key) => ({ addListener(fn) { listeners[key].push(fn); } });
const tabUpdated = {
  addListener(fn) { listeners.tabUpdated.push(fn); },
  removeListener(fn) {
    const index = listeners.tabUpdated.indexOf(fn);
    if (index >= 0) listeners.tabUpdated.splice(index, 1);
  }
};
const local = {
  async get(keys, callback) {
    const requested = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const defaults = Array.isArray(keys) ? {} : (keys || {});
    const result = {};
    for (const key of requested) result[key] = key in store ? store[key] : defaults[key];
    if (callback) callback(result);
    return result;
  },
  async set(values) { Object.assign(store, values); }
};
const chrome = {
  runtime: { getURL: (path) => 'chrome-extension://test/' + path, onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), lastError: null },
  alarms: { create() {}, onAlarm: event('alarm') },
  storage: { local, onChanged: event('changed') },
  notifications: { create() {}, onClicked: event('changed') },
  tabs: {
    onUpdated: tabUpdated,
    query: async () => [],
    create: async () => ({ id: 7 }),
    get: (_tabId, callback) => callback({ id: 7, status: 'loading' }),
    update: async () => ({}),
    remove: async () => {},
    sendMessage: (_tabId, _message, callback) => callback({ wallet: 100, total: 120 })
  }
};
const fastTimer = (callback, delay, ...args) => setTimeout(callback, delay === 1000 ? 0 : delay, ...args);
const context = { chrome, console, URL, Date, Math, Promise, setTimeout: fastTimer, clearTimeout, fetch, AbortController, AbortSignal, structuredClone };
vm.runInNewContext(await fs.readFile(new URL('../background.js', import.meta.url), 'utf8'), context, { filename: 'background.js' });

listeners.startup[0]();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(store.storageSchemaVersion, 4);
assert.deepEqual(Array.from(store.trackedItems), []);
assert.deepEqual(Array.from(store.notificationHistory), []);
assert.equal(store.checkInterval, 120);
assert.equal(store.wbStatus.running, false);
assert.equal(store.deepseekModel, 'deepseek-flash');
assert.equal(store.deepseekThinking, 'disabled');
assert.equal(store.deepseekReasoningEffort, 'high');
assert.equal(store.wbConcurrency, 1);
assert.equal(store.citilinkConcurrency, 1);
assert.equal(store.theme, 'light');

const send = (request) => new Promise((resolve) => listeners.message[0](request, {}, resolve));
let response = await send({ action: 'settings_update', values: { theme: 'dark', checkInterval: 15, wbConcurrency: 5, citilinkConcurrency: 3, deepseekModel: 'deepseek-v4-pro', deepseekThinking: 'enabled', deepseekReasoningEffort: 'max' } });
assert.equal(response.success, true);
assert.equal(store.theme, 'dark');
assert.equal(store.checkInterval, 15);
assert.equal(store.wbConcurrency, 5);
assert.equal(store.citilinkConcurrency, 3);
assert.equal(store.notificationHistory.at(-1).type, 'action');
assert.equal(store.notificationHistory.at(-1).action, 'settings_updated');
response = await send({ action: 'history_append', entry: { action: 'test_action', status: 'completed', title: 'Тестовое действие', message: 'История работает.', platform: 'citilink' } });
assert.equal(response.success, true);
assert.equal(store.notificationHistory.at(-1).action, 'test_action');
assert.equal(store.notificationHistory.at(-1).platform, 'citilink');
assert.equal(store.deepseekModel, 'deepseek-v4-pro');
assert.equal(store.deepseekThinking, 'enabled');
assert.equal(store.deepseekReasoningEffort, 'max');
store.deepseekApiKey = 'test-key';
let generationBody;
context.fetch = async (url, options = {}) => {
  if (url.endsWith('/chat/completions')) {
    generationBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Готово' } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) };
  }
  return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] }) };
};
response = await context.handleDeepSeekGenerateAnswer({ question: 'Тестовый вопрос', product: 'Тестовый товар' });
assert.equal(response.success, true);
assert.equal(generationBody.model, 'deepseek-v4-pro');
assert.deepEqual(generationBody.thinking, { type: 'enabled' });
assert.equal(generationBody.reasoning_effort, 'max');
assert.equal('temperature' in generationBody, false);
assert.equal(store.deepseekStats.totalRequests, 1);
assert.equal(store.deepseekStats.estimatedCostUSD > 0, true);
assert.equal(Object.keys(store.deepseekStats.daily).length, 1);
const dailyStats = Object.values(store.deepseekStats.daily)[0];
assert.equal(dailyStats.requests, 1);
assert.equal(dailyStats.totalTokens, 150);
assert.equal(dailyStats.models['deepseek-v4-pro'].requests, 1);
const officialUsage = context.parseDeepSeekOfficialUsage({
  costPayload: { data: { biz_data: { data: [{ currency: 'USD', series: [{ model: 'deepseek-v4-flash', buckets: [{ time: 100, cost: '0.14' }] }] }] } } },
  amountPayload: { data: { biz_data: { series: [{ model: 'deepseek-v4-flash', buckets: [{ time: 100, usage: { PROMPT_CACHE_HIT_TOKEN: '10', PROMPT_CACHE_MISS_TOKEN: '20', RESPONSE_TOKEN: '30', REQUEST: '2' } }] }] } } },
  window: { start: 0, end: 200, tz: 0 },
  fetchedAt: 123
});
assert.equal(officialUsage.source, 'platform');
assert.equal(officialUsage.currency, 'USD');
assert.equal(officialUsage.totalCost, 0.14);
assert.equal(officialUsage.totalRequests, 2);
assert.equal(officialUsage.totalTokens, 60);
assert.equal(Object.keys(officialUsage.daily).length, 1);
response = await send({ action: 'deepseek_reset_stats' });
assert.equal(response.success, true);
assert.equal(Object.keys(response.stats.daily).length, 0);
assert.equal(Object.keys(store.deepseekStats.daily).length, 0);
response = await send({ action: 'settings_update', values: { checkInterval: 0 } });
assert.equal(response.success, false);
response = await send({ action: 'settings_update', values: { wbConcurrency: 6 } });
assert.equal(response.success, false);
response = await send({ action: 'collection_clear', marketplace: 'wb' });
assert.equal(response.success, true);
assert.deepEqual({ ...store.wbLastResults }, {});
assert.equal(store.wbStatus.phase, 'idle');
store.citilinkStatus.running = true;
response = await send({ action: 'collection_clear', marketplace: 'citilink' });
assert.equal(response.success, false);
store.citilinkStatus.running = false;
response = await send({ action: 'collection_clear', marketplace: 'unknown' });
assert.equal(response.success, false);
response = await send({
  action: 'tracking_upsert',
  item: {
    id: 'original-id',
    url: 'https://www.ozon.ru/product/example-1/',
    title: 'Исходное название',
    targetPrice: 2000,
    priceType: 'bank',
    lastPrice: 1500,
    addedAt: '2026-01-01T00:00:00.000Z'
  }
});
assert.equal(response.success, true);
response = await send({
  action: 'tracking_upsert',
  item: {
    id: 'replacement-id',
    url: 'https://www.ozon.ru/product/example-1/?from=dashboard',
    title: 'Второй ввод',
    targetPrice: 1800,
    priceType: 'nobank',
    lastPrice: null,
    addedAt: '2026-09-17T00:00:00.000Z'
  }
});
assert.equal(response.success, true);
assert.equal(store.trackedItems.length, 1);
assert.equal(store.trackedItems[0].id, 'original-id');
assert.equal(store.trackedItems[0].lastPrice, 1500);
assert.equal(store.trackedItems[0].addedAt, '2026-01-01T00:00:00.000Z');
assert.equal(store.trackedItems[0].targetPrice, 1800);
const wbFetch = context.fetchOneWb('123');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(listeners.tabUpdated.length, 1);
listeners.tabUpdated[0](7, { status: 'complete' });
assert.deepEqual({ ...(await wbFetch) }, { wallet: 100, total: 120 });
assert.equal(listeners.tabUpdated.length, 0);

let activeWorkers = 0;
let maxActiveWorkers = 0;
await context.runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
  activeWorkers += 1;
  maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
  await new Promise((resolve) => setTimeout(resolve, 0));
  activeWorkers -= 1;
  return item;
});
assert.equal(maxActiveWorkers, 2);

console.log('background schema/settings/clear smoke ok');
