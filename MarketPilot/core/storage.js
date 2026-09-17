const DEFAULTS = Object.freeze({
  storageSchemaVersion: 4,
  trackedItems: [],
  wbStatus: { total: 0, done: 0, running: false },
  citilinkStatus: { total: 0, done: 0, running: false },
  priceCheckStatus: { total: 0, done: 0, running: false, phase: 'idle' },
  notificationHistory: [],
  theme: 'light',
  checkInterval: 120,
  wbConcurrency: 1,
  citilinkConcurrency: 1,
  deepseekModel: 'deepseek-flash',
  deepseekThinking: 'disabled',
  deepseekReasoningEffort: 'high',
  deepseekStats: { totalRequests: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0, estimatedCostUSD: 0, daily: {} },
  deepseekOfficialUsage: null,
  deepseekLastBalance: null,
  deepseekBalanceLastChecked: null,
  deepseekDelay: 3
});

export function storageGet(keys = DEFAULTS) {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return chrome.storage.local.get(keys);
  }
  return Promise.resolve(keys);
}

export function storageSet(values) {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return chrome.storage.local.set(values);
  }
  return Promise.resolve();
}

export function onStorageChange(listener) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function sendCommand(action, data = {}) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('Команды доступны только внутри расширения.'));
      return;
    }
    chrome.runtime.sendMessage({ action, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.success === false || response?.status === 'error') {
        reject(new Error(response.error || 'Команда не выполнена'));
        return;
      }
      resolve(response || { success: true });
    });
  });
}

export async function upsertTrackedItem(item) {
  return sendCommand('tracking_upsert', { item });
}

export async function removeTrackedItem(id) {
  return sendCommand('tracking_remove', { id });
}

export async function clearNotificationHistory() {
  return sendCommand('history_clear');
}

export function appendActivityHistory(entry) {
  return sendCommand('history_append', { entry });
}

export async function removeHistoryForItem(itemId) {
  return sendCommand('history_remove_for_item', { itemId });
}

export async function updateSettings(values) {
  return sendCommand('settings_update', { values });
}

export async function clearCollectionResults(marketplace) {
  return sendCommand('collection_clear', { marketplace });
}

export async function openDashboard(hash = '#/overview') {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL || !chrome.tabs) {
    window.open(`dashboard.html${hash}`, '_blank', 'noopener');
    return null;
  }
  const url = `${chrome.runtime.getURL('dashboard.html')}${hash}`;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url?.startsWith(chrome.runtime.getURL('dashboard.html')));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { url, active: true });
    return existing;
  }
  return chrome.tabs.create({ url });
}
