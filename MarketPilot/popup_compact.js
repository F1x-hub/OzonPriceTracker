import { identifyMarketplace, isProductUrl, MARKETPLACES, normalizeProductUrl } from './core/marketplaces.js';
import { onStorageChange, openDashboard, storageGet, upsertTrackedItem } from './core/storage.js';
import { applyTheme } from './core/theme.js';

const $ = (id) => document.getElementById(id);
const contextMarketplace = $('contextMarketplace');
const contextTitle = $('contextTitle');
const contextDescription = $('contextDescription');
const contextCard = $('contextCard');
const statusDot = $('statusDot');
const quickForm = $('quickForm');
const targetPrice = $('targetPrice');
const trackButton = $('trackButton');
const actionCard = $('actionCard');
const actionTitle = $('actionTitle');
const actionDescription = $('actionDescription');
const actionList = $('actionList');
const feedback = $('feedback');
const jobStatus = $('jobStatus');
let activeTab = null;

function setFeedback(message, kind = '') {
  feedback.textContent = message;
  feedback.className = `feedback ${kind}`.trim();
}

function setFieldInvalid(input, invalid) {
  if (!input) return;
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function renderJobs(state) {
  const active = Boolean(state.wbStatus?.running || state.citilinkStatus?.running || state.priceCheckStatus?.running);
  jobStatus.textContent = active ? 'Выполняется задание' : 'Нет активных заданий';
}

function dashboardHash(marketplace, module) {
  return `#/stores?marketplace=${encodeURIComponent(marketplace.id)}&module=${encodeURIComponent(module)}`;
}

function createActionEntry(marketplace, action) {
  const entry = document.createElement('article');
  entry.className = 'action-entry';

  const copy = document.createElement('div');
  copy.className = 'action-entry-copy';

  const meta = document.createElement('span');
  meta.className = 'action-entry-meta';
  meta.textContent = marketplace.name;

  const title = document.createElement('strong');
  title.textContent = action.title;

  const description = document.createElement('p');
  description.textContent = action.description;

  copy.append(meta, title, description);

  const button = document.createElement('button');
  button.className = 'action-button';
  button.type = 'button';
  button.textContent = action.buttonLabel;
  button.addEventListener('click', async () => {
    button.disabled = true;
    setFeedback('Открываю модуль…');
    try {
      await openDashboard(dashboardHash(marketplace, action.module));
    } catch (error) {
      setFeedback(error.message || 'Не удалось открыть модуль.', 'is-error');
    } finally {
      button.disabled = false;
    }
  });

  entry.append(copy, button);
  return entry;
}

function renderActions(marketplace, options = {}) {
  const entries = marketplace
    ? (marketplace.popupActions || []).map((action) => ({ marketplace, action }))
    : MARKETPLACES.flatMap((entry) => (entry.popupActions || []).map((action) => ({ marketplace: entry, action })));

  actionTitle.textContent = options.title || (marketplace ? 'Доступные действия' : 'Что можно сделать');
  actionDescription.textContent = options.description || (marketplace
    ? 'Выберите модуль для этой площадки.'
    : 'Откройте карточку товара или выберите нужный модуль в дашборде.');
  if (entries.length) {
    actionList.replaceChildren(...entries.map(({ marketplace: entryMarketplace, action }) => createActionEntry(entryMarketplace, action)));
  } else {
    const empty = document.createElement('p');
    empty.className = 'action-empty';
    empty.textContent = 'Для этой площадки пока нет быстрых действий. Откройте дашборд для просмотра модулей.';
    actionList.replaceChildren(empty);
  }
  actionCard.hidden = false;
}

async function renderContext() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs[0] || null;
  const marketplace = identifyMarketplace(activeTab?.url || '');
  const title = activeTab?.title?.trim() || 'Текущая вкладка';
  contextTitle.textContent = title.length > 84 ? `${title.slice(0, 81)}…` : title;
  quickForm.hidden = true;
  actionCard.hidden = true;

  if (!marketplace) {
    contextMarketplace.textContent = 'Страница не подключена';
    contextDescription.textContent = 'Откройте карточку товара или выберите нужный модуль ниже.';
    statusDot.className = 'status-dot is-warn';
    renderActions(null);
    return;
  }

  contextMarketplace.textContent = marketplace.name;
  statusDot.className = 'status-dot is-ready';
  const canTrack = marketplace.capabilities.includes('trackPrice') && isProductUrl(activeTab.url, marketplace.id);
  if (!canTrack) {
    contextDescription.textContent = 'Для этой страницы нет отдельного быстрого действия.';
    renderActions(marketplace);
    return;
  }

  const state = await storageGet({ trackedItems: [] });
  const item = state.trackedItems.find((entry) => normalizeProductUrl(entry.url) === normalizeProductUrl(activeTab.url));
  const pageData = await new Promise((resolve) => {
    chrome.tabs.sendMessage(activeTab.id, { action: 'get_current_product', priceType: item?.priceType || 'bank' }, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response || null);
    });
  });
  if (pageData?.title && contextTitle.textContent === title) contextTitle.textContent = pageData.title;
  contextDescription.textContent = item
    ? `Отслеживается. Цель: ${Number(item.targetPrice).toLocaleString('ru-RU')} ₽.`
    : pageData?.price !== null && pageData?.price !== undefined
      ? `Текущая цена: ${Number(pageData.price).toLocaleString('ru-RU')} ₽. Задайте порог для проверки.`
      : 'Задайте порог. Проверка запустится в фоне.';
  if (item) {
    renderActions(marketplace, {
      title: 'Отслеживание настроено',
      description: 'Измените порог и другие параметры в модуле мониторинга.'
    });
    return;
  }
  quickForm.hidden = false;
  trackButton.textContent = 'Добавить в отслеживание';
}

quickForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeTab?.url) return;
  const value = Number.parseInt(targetPrice.value, 10);
  if (!Number.isInteger(value) || value < 1) {
    setFieldInvalid(targetPrice, true);
    setFeedback('Введите целевую цену больше нуля.', 'is-error');
    targetPrice.focus();
    return;
  }
  trackButton.disabled = true;
  setFieldInvalid(targetPrice, false);
  setFeedback('Сохраняю отслеживание…');
  try {
    await upsertTrackedItem({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url: normalizeProductUrl(activeTab.url),
      title: activeTab.title || activeTab.url,
      targetPrice: value,
      priceType: document.querySelector('input[name="priceType"]:checked')?.value || 'bank',
      lastPrice: null,
      addedAt: new Date().toISOString()
    });
    setFeedback('Отслеживание сохранено.', 'is-success');
    await renderContext();
  } catch (error) {
    setFeedback(error.message || 'Не удалось сохранить отслеживание.', 'is-error');
  } finally {
    trackButton.disabled = false;
  }
});

$('dashboardButton').addEventListener('click', () => openDashboard('#/overview'));
$('settingsButton').addEventListener('click', () => openDashboard('#/settings'));

storageGet({ theme: 'light', wbStatus: {}, citilinkStatus: {}, priceCheckStatus: {} }).then((state) => {
  applyTheme(state.theme);
  renderJobs(state);
});
onStorageChange((changes, area) => {
  if (area === 'local' && (changes.theme || changes.trackedItems || changes.wbStatus || changes.citilinkStatus || changes.priceCheckStatus)) {
    if (changes.theme) applyTheme(changes.theme.newValue);
    renderContext();
    storageGet({ wbStatus: {}, citilinkStatus: {}, priceCheckStatus: {} }).then(renderJobs);
  }
});
renderContext().catch(() => setFeedback('Не удалось прочитать текущую вкладку.', 'is-error'));
