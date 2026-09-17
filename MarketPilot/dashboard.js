import { MARKETPLACES, identifyMarketplace, isProductUrl, normalizeProductUrl } from './core/marketplaces.js';
import { appendActivityHistory, clearCollectionResults, clearNotificationHistory, onStorageChange, removeTrackedItem, sendCommand, storageGet, updateSettings, upsertTrackedItem } from './core/storage.js';
import { applyTheme, normalizeTheme } from './core/theme.js';
import { exportCitilinkResults, exportWbResults } from './features/export.js';

const $ = (id) => document.getElementById(id);
const panels = [...document.querySelectorAll('.route-panel[data-panel]')];
const navLinks = [...document.querySelectorAll('[data-route]')];
const themeInputs = [...document.querySelectorAll('[data-theme-option]')];
const themeNote = $('themeNote');
const pageMeta = {
  overview: ['Обзор', 'Центр управления магазинами и заданиями.'],
  stores: ['Магазины', 'Функции сгруппированы по каждому маркетплейсу.'],
  jobs: ['Задания', 'Прогресс фоновых операций.'],
  history: ['История', 'Все действия, фоновые задания и уведомления.'],
  settings: ['AI и настройки', 'Параметры расширения, модели и использование DeepSeek.']
};
const routeAliases = {
  products: { marketplace: 'ozon', module: 'tracking' },
  monitoring: { marketplace: 'ozon', module: 'monitoring' },
  collection: { marketplace: 'wildberries', module: 'collection' },
  replies: { marketplace: 'ozon', module: 'reviews' },
  content: { marketplace: 'ozon', module: 'content' }
};
const storeMeta = Object.fromEntries(MARKETPLACES.map((marketplace) => [marketplace.id, {
  name: marketplace.name,
  description: marketplace.dashboard?.description || 'Инструменты магазина.',
  overview: marketplace.dashboard?.overview || marketplace.dashboard?.description || 'Инструменты магазина.',
  defaultModule: marketplace.dashboard?.defaultModule || marketplace.dashboard?.modules?.[0] || '',
  modules: marketplace.dashboard?.modules || []
}]));
const DEEPSEEK_MODEL_ALIASES = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash'
};
const DEFAULT_COLLECTION_CONCURRENCY = '1';
const phaseLabels = {
  idle: 'ожидание',
  starting: 'подготовка',
  searching: 'поиск',
  checking: 'проверка',
  processing: 'обработка',
  done: 'готово',
  partial: 'частично',
  error: 'ошибка',
  interrupted: 'прервано'
};
let state = {};
let intervalDraftDirty = false;
let collectionConcurrencyDraftDirty = false;
const DEEPSEEK_DAILY_DAYS = 30;

function renderTheme(theme) {
  const normalizedTheme = applyTheme(theme);
  themeInputs.forEach((input) => {
    const isActive = input.value === normalizedTheme;
    input.checked = isActive;
    input.closest('[data-theme-card]')?.toggleAttribute('data-active', isActive);
  });
  return normalizedTheme;
}

function setThemeNote(message = '') {
  if (themeNote) themeNote.textContent = message;
}

function populateMarketplaceControls() {
  $('marketplaceFilter').innerHTML = '<option value="all">Все магазины</option>'
    + MARKETPLACES.map((marketplace) => `<option value="${marketplace.id}">${marketplace.name}</option>`).join('');
}

function populateStoreNavigation() {
  const overview = $('storeOverviewGrid');
  const tabs = $('storeTabs');
  if (!overview || !tabs) return;
  overview.innerHTML = MARKETPLACES.map((marketplace) => {
    const meta = storeMeta[marketplace.id];
    const shortMark = marketplace.id === 'wildberries' ? 'WB' : marketplace.name.slice(0, 1);
    return `<a class="store-overview-card" href="#/stores?marketplace=${encodeURIComponent(marketplace.id)}&module=${encodeURIComponent(meta.defaultModule)}"><span class="store-overview-mark store-overview-mark-${escapeHtml(marketplace.id)}">${escapeHtml(shortMark)}</span><span><strong>${escapeHtml(meta.name)}</strong><small>${escapeHtml(meta.overview)}</small></span><span class="store-overview-arrow">→</span></a>`;
  }).join('');
  tabs.innerHTML = MARKETPLACES.map((marketplace) => `<a href="#/stores?marketplace=${encodeURIComponent(marketplace.id)}" data-marketplace-tab="${escapeHtml(marketplace.id)}">${escapeHtml(marketplace.name)}</a>`).join('');
}

function routeState() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [rawRoute, query = ''] = hash.split('?');
  const requestedRoute = String(rawRoute || 'overview').toLowerCase();
  const params = new URLSearchParams(query);
  if (requestedRoute === 'stores') {
    const marketplace = storeMeta[params.get('marketplace')] ? params.get('marketplace') : 'ozon';
    return { route: 'stores', marketplace, module: params.get('module') || '' };
  }
  if (routeAliases[requestedRoute]) {
    const alias = routeAliases[requestedRoute];
    const marketplace = storeMeta[params.get('marketplace')] ? params.get('marketplace') : alias.marketplace;
    return { route: 'stores', marketplace, module: params.get('module') || alias.module };
  }
  return { route: pageMeta[requestedRoute] ? requestedRoute : 'overview', marketplace: '', module: '' };
}

function routeName() {
  return routeState().route;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatDate(value) {
  if (!value) return 'Нет данных';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Нет данных' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function formatCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.round(count).toLocaleString('ru-RU') : '0';
}

function getUsageCost(value) {
  return Number(value?.cost ?? value?.totalCost ?? value?.estimatedCostUSD ?? value?.estimatedCostCNY) || 0;
}

function getUsageCurrency(stats = {}) {
  const currency = String(stats?.currency || 'USD').trim().toUpperCase();
  return currency || 'USD';
}

function formatUsageCost(value, currency = 'USD') {
  const cost = Number(value) || 0;
  const normalizedCurrency = String(currency || 'USD').trim().toUpperCase();
  const symbol = normalizedCurrency === 'USD' ? '$' : (normalizedCurrency === 'CNY' ? '¥' : `${normalizedCurrency} `);
  return `${symbol}${cost.toFixed(2)}`;
}

function dayKeyToDate(dayKey) {
  const [year, month, day] = String(dayKey).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getRecentDayKeys(days = DEEPSEEK_DAILY_DAYS) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (days - index - 1));
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  });
}

function formatDayLabel(dayKey, options = {}) {
  const date = dayKeyToDate(dayKey);
  if (!date) return dayKey;
  return date.toLocaleDateString('ru-RU', options.short ? { day: 'numeric', month: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderDeepSeekDailyUsage(stats = {}) {
  const chart = $('deepseekDailyChart');
  const empty = $('deepseekDailyEmpty');
  const total = $('deepseekDailyTotal');
  if (!chart || !empty || !total) return;
  const currency = getUsageCurrency(stats);
  if ($('deepseekDailyTitle')) $('deepseekDailyTitle').textContent = `Расход MarketPilot по дням · ${currency}`;
  if ($('deepseekDailySubtitle')) $('deepseekDailySubtitle').textContent = 'Локальный расход MarketPilot по успешным ответам · последние 30 дней.';
  chart.setAttribute('aria-label', `Расход DeepSeek в ${currency} по дням`);
  const daily = stats && typeof stats.daily === 'object' && !Array.isArray(stats.daily) ? stats.daily : {};
  const days = getRecentDayKeys();
  const entries = days.map((dayKey) => ({ dayKey, stats: daily[dayKey] || {} }));
  const activeEntries = entries.filter(({ stats: dayStats }) => getUsageCost(dayStats) > 0 || Number(dayStats.requests) > 0);
  const maxCost = Math.max(...entries.map(({ stats: dayStats }) => getUsageCost(dayStats)), 0);
  const visibleTotal = entries.reduce((sum, { stats: dayStats }) => sum + getUsageCost(dayStats), 0);
  total.textContent = formatUsageCost(visibleTotal, currency);
  empty.hidden = activeEntries.length > 0;
  chart.hidden = activeEntries.length === 0;
  if (!activeEntries.length) {
    chart.innerHTML = '';
    return;
  }
  chart.innerHTML = entries.map(({ dayKey, stats: dayStats }, index) => {
    const cost = getUsageCost(dayStats);
    const requests = Number(dayStats.requests) || 0;
    const barHeight = cost > 0 && maxCost > 0 ? Math.max(8, Math.round((cost / maxCost) * 100)) : 0;
    const modelRows = Object.entries(dayStats.models || {})
      .filter(([, modelStats]) => modelStats && typeof modelStats === 'object')
      .sort(([, left], [, right]) => getUsageCost(right) - getUsageCost(left))
      .map(([model, modelStats]) => `<span><i aria-hidden="true"></i>${escapeHtml(model)}<strong>${formatUsageCost(getUsageCost(modelStats), currency)}</strong></span>`)
      .join('');
    const tooltipRows = modelRows || `<span><i aria-hidden="true"></i>Все модели<strong>${formatUsageCost(cost, currency)}</strong></span>`;
    const ariaLabel = `${formatDayLabel(dayKey)}: ${formatUsageCost(cost, currency)}, ${formatCount(requests)} ${requests === 1 ? 'запрос' : 'запросов'}`;
    const showLabel = index === 0 || index % 5 === 0 || index === entries.length - 1;
    return `<div class="usage-chart-column" role="listitem" tabindex="0" aria-label="${escapeHtml(ariaLabel)}"><div class="usage-chart-bar-area"><div class="usage-chart-tooltip"><strong>${escapeHtml(formatDayLabel(dayKey))}</strong><b>${escapeHtml(formatUsageCost(cost, currency))}</b><small>${formatCount(requests)} ${requests === 1 ? 'запрос' : 'запросов'}</small>${tooltipRows}</div><div class="usage-chart-bar" style="height: ${barHeight}%"></div></div><span class="usage-chart-label">${showLabel ? escapeHtml(formatDayLabel(dayKey, { short: true })) : ''}</span></div>`;
  }).join('');
}

function formatBalance(balance) {
  const infos = Array.isArray(balance?.balance_infos) ? balance.balance_infos : [];
  if (!infos.length) return 'Нет данных';
  return infos.map((info) => {
    const currency = String(info?.currency || '').trim().toUpperCase();
    const rawAmount = info?.total_balance;
    const amount = Number(rawAmount);
    if (rawAmount === null || rawAmount === undefined || String(rawAmount).trim() === '' || !Number.isFinite(amount)) {
      return currency ? `${currency} —` : '—';
    }
    return `${amount.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${currency}`.trim();
  }).join(' · ');
}

function renderDeepSeekUsage(values = state) {
  const localStats = values.deepseekStats || {};
  const officialStats = values.deepseekOfficialUsage?.source === 'platform' ? values.deepseekOfficialUsage : null;
  const stats = localStats;
  const currency = getUsageCurrency(localStats);
  const balance = values.deepseekLastBalance;
  const checkedAt = values.deepseekBalanceLastChecked;
  const balanceValue = $('deepseekBalanceValue');
  const balanceMeta = $('deepseekBalanceMeta');
  const balanceNote = $('deepseekBalanceNote');
  const usageDescription = document.querySelector('.deepseek-usage-card .settings-card-heading .field-note');
  const costLabel = $('deepseekStatCost')?.closest('.usage-metric')?.querySelector('span');
  if (usageDescription) usageDescription.textContent = 'Основной расход — локальная статистика запросов MarketPilot. Официальный usage аккаунта можно обновить отдельно для сравнения.';
  if (costLabel) costLabel.textContent = 'Расход MarketPilot';
  if ($('resetDeepseekStats')) $('resetDeepseekStats').textContent = 'Сбросить локальную статистику';
  if (balanceValue) balanceValue.textContent = balance ? formatBalance(balance) : '—';
  if (balanceMeta) balanceMeta.textContent = checkedAt
    ? `${balance?.is_available === false ? 'API сообщает: недоступен · ' : ''}Проверено ${formatDate(checkedAt)}`
    : (balance ? 'Ответ получен без времени проверки.' : 'Нажмите «Обновить баланс».');
  if (balanceNote && !balanceNote.textContent) balanceNote.textContent = '';
  if ($('deepseekStatRequests')) $('deepseekStatRequests').textContent = formatCount(stats.totalRequests);
  if ($('deepseekStatTokens')) $('deepseekStatTokens').textContent = formatCount(stats.totalTokens);
  if ($('deepseekStatTokensMeta')) $('deepseekStatTokensMeta').textContent = `Вход ${formatCount(stats.totalPromptTokens)} · выход ${formatCount(stats.totalCompletionTokens)}`;
  if ($('deepseekStatCost')) $('deepseekStatCost').textContent = formatUsageCost(getUsageCost(stats), currency);
  if ($('deepseekStatMeta')) $('deepseekStatMeta').textContent = stats.lastUsedAt
    ? `Локальный расход · последний запрос ${formatDate(stats.lastUsedAt)}`
    : 'Локальный расход · данных пока нет';
  if (balanceNote && officialStats && !balanceNote.textContent) {
    balanceNote.textContent = `Для сравнения: официальный usage аккаунта ${formatUsageCost(officialStats.totalCost, getUsageCurrency(officialStats))} · обновлено ${formatDate(officialStats.fetchedAt)}.`;
  }
  renderDeepSeekDailyUsage(stats);
}

function showNotice(message, kind = 'success') {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = false;
  notice.dataset.kind = kind;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { notice.hidden = true; }, 3600);
}

function setFieldInvalid(input, invalid) {
  if (!input) return;
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function setStoreView(marketplace, module = '') {
  const selectedMarketplace = storeMeta[marketplace] ? marketplace : 'ozon';
  const meta = storeMeta[selectedMarketplace];
  $('storeTitle').textContent = meta.name;
  $('storeDescription').textContent = meta.description;
  document.querySelectorAll('[data-marketplace-tab]').forEach((tab) => {
    const active = tab.dataset.marketplaceTab === selectedMarketplace;
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-store-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.storePanel !== selectedMarketplace;
  });
  if (module) {
    const target = [...document.querySelectorAll('[data-store-module]')]
      .find((entry) => entry.dataset.storeModule === `${selectedMarketplace}-${module}`);
    if (target) {
      target.classList.add('is-focused');
      window.requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      window.setTimeout(() => target.classList.remove('is-focused'), 1400);
    }
  }
}

function setRoute(routeValue) {
  const current = typeof routeValue === 'string' ? { route: routeValue, marketplace: '', module: '' } : routeValue;
  const route = pageMeta[current.route] ? current.route : 'overview';
  const [title, description] = pageMeta[route];
  $('pageTitle').textContent = title;
  $('pageDescription').textContent = description;
  navLinks.forEach((link) => {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== route; });
  if (route === 'stores') setStoreView(current.marketplace, current.module);
  if (route === 'settings') loadSettings();
}

function renderProducts() {
  const search = $('productSearch').value.trim().toLowerCase();
  const marketplace = $('marketplaceFilter').value;
  const items = (Array.isArray(state.trackedItems) ? state.trackedItems : [])
    .filter((item) => !search || `${item.title} ${item.url}`.toLowerCase().includes(search))
    .filter((item) => marketplace === 'all' || identifyMarketplace(item.url)?.id === marketplace);
  $('trackedCount').textContent = state.trackedItems?.length || 0;
  $('runningCount').textContent = Number(Boolean(state.wbStatus?.running)) + Number(Boolean(state.citilinkStatus?.running)) + Number(Boolean(state.priceCheckStatus?.running));
  $('historyCount').textContent = state.notificationHistory?.length || 0;
  $('tableMeta').textContent = items.length ? `${items.length} ${items.length === 1 ? 'товар' : 'товаров'}` : '';
  $('productsEmpty').hidden = items.length > 0;
  $('productsTable').innerHTML = items.map((item) => {
    const marketplaceInfo = identifyMarketplace(item.url);
    const hasCurrentPrice = item.lastPrice !== null && item.lastPrice !== undefined && item.lastPrice !== '' && Number.isFinite(Number(item.lastPrice));
    const currentPrice = hasCurrentPrice ? `${Number(item.lastPrice).toLocaleString('ru-RU')} ₽` : 'Ожидание';
    return `<tr><td><div class="product-cell"><strong title="${escapeHtml(item.title || item.url)}">${escapeHtml(item.title || 'Товар без названия')}</strong><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Открыть карточку ↗</a></div></td><td><span class="marketplace-pill">${escapeHtml(marketplaceInfo?.name || 'Магазин')}</span></td><td><div class="price-cell"><strong>${currentPrice}</strong><div class="target-editor"><span class="sr-only">Целевая цена</span><input data-target-id="${escapeHtml(item.id)}" aria-label="Целевая цена" type="number" min="1" max="1000000000" step="1" value="${escapeHtml(item.targetPrice)}"><span aria-hidden="true">₽</span><button class="row-action" type="button" data-save-target="${escapeHtml(item.id)}">Сохранить</button></div></div></td><td><time datetime="${escapeHtml(item.updatedAt || item.addedAt || '')}">${escapeHtml(formatDate(item.updatedAt || item.addedAt))}</time></td><td><button class="row-action" type="button" data-remove-id="${escapeHtml(item.id)}">Удалить</button></td></tr>`;
  }).join('');
  document.querySelectorAll('[data-remove-id]').forEach((button) => button.addEventListener('click', () => removeItem(button.dataset.removeId)));
  document.querySelectorAll('[data-save-target]').forEach((button) => button.addEventListener('click', () => updateTarget(button)));
}

async function updateTarget(button) {
  const item = state.trackedItems?.find((entry) => String(entry.id) === String(button.dataset.saveTarget));
  const input = button.closest('.target-editor')?.querySelector('input');
  const targetPrice = Number.parseInt(input?.value || '', 10);
  if (!item || !Number.isInteger(targetPrice) || targetPrice < 1) {
    showNotice('Целевая цена должна быть целым числом больше нуля.', 'error');
    input?.focus();
    return;
  }

  button.disabled = true;
  try {
    await upsertTrackedItem({ ...item, targetPrice });
    showNotice('Целевая цена обновлена.');
    await refresh();
  } catch (error) {
    showNotice(error.message || 'Не удалось обновить цель.', 'error');
  } finally {
    button.disabled = false;
  }
}

async function removeItem(id) {
  if (!id || !window.confirm('Удалить отслеживание этого товара?')) return;
  try {
    await removeTrackedItem(id);
    showNotice('Отслеживание удалено.');
    await refresh();
  } catch (error) {
    showNotice(error.message || 'Не удалось удалить товар.', 'error');
  }
}

function jobCard(name, status) {
  const total = Number(status?.total || 0);
  const done = Math.min(Number(status?.done || 0), total || 0);
  const percent = total ? Math.round(done / total * 100) : 0;
  const updatedAt = status?.updatedAt ? Date.parse(status.updatedAt) : NaN;
  const stale = Boolean(status?.running && Number.isFinite(updatedAt) && Date.now() - updatedAt > 90_000);
  const label = status?.running
    ? (stale ? 'Нет свежего сигнала' : 'В работе')
    : status?.phase === 'error'
      ? 'Ошибка'
      : total && done >= total
        ? 'Завершено'
        : 'Нет задания';
  const phase = phaseLabels[status?.phase] && status.phase !== 'processing' ? ` · ${phaseLabels[status.phase]}` : '';
  const aiMode = typeof status?.generateDescription === 'boolean'
    ? ` · ${status.generateDescription ? 'AI' : 'без AI'}`
    : '';
  const error = status?.error ? `<span class="job-error">${escapeHtml(status.error)}</span>` : '';
  const updated = status?.updatedAt ? `Обновлено: ${escapeHtml(formatDate(status.updatedAt))}` : 'Время не записано';
  const jobId = status?.jobId ? ` · ${escapeHtml(status.jobId)}` : '';
  return `<article class="job-row"><div><strong>${escapeHtml(name)}</strong><p>${label}${phase}${aiMode} · ${done} из ${total || 0}</p><small>${updated}${jobId}</small>${error}</div><div class="progress" aria-label="${percent}%"><i style="width:${percent}%"></i></div></article>`;
}

function renderJobs() {
  $('jobsList').innerHTML = `${jobCard('Wildberries — сбор цен', state.wbStatus)}${jobCard('Citilink — сбор карточек', state.citilinkStatus)}${jobCard('Мониторинг Ozon — проверка цен', state.priceCheckStatus)}`;
  const running = Number(Boolean(state.wbStatus?.running)) + Number(Boolean(state.citilinkStatus?.running)) + Number(Boolean(state.priceCheckStatus?.running));
  $('jobsBadge').hidden = running === 0;
  $('jobsBadge').textContent = running;
  $('exportWb').disabled = !Object.keys(state.wbLastResults || {}).length;
  $('exportCitilink').disabled = !Object.keys(state.citilinkLastResults || {}).length;
  $('clearWb').disabled = Boolean(state.wbStatus?.running) || !Object.keys(state.wbLastResults || {}).length;
  $('clearCitilink').disabled = Boolean(state.citilinkStatus?.running) || !Object.keys(state.citilinkLastResults || {}).length;
}

function resultStatus(item) {
  if (item?.error || item?.status === 'error') return 'Ошибка';
  if (item?.status === 'searching' || item?.status === 'processing') return 'В работе';
  return 'Готово';
}

function formatResultPrice(value) {
  const number = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number)
    ? '—'
    : `${number.toLocaleString('ru-RU')} ₽`;
}

function renderCollectionResults() {
  const wbEntries = Object.entries(state.wbLastResults || {});
  $('wbResultsMeta').textContent = wbEntries.length ? `${wbEntries.length} поз.` : '';
  $('wbResultsEmpty').hidden = wbEntries.length > 0;
  $('wbResultsTable').innerHTML = wbEntries.map(([article, item]) => `<tr><td>${escapeHtml(article)}</td><td>${escapeHtml(formatResultPrice(item?.wallet))}</td><td>${escapeHtml(formatResultPrice(item?.total))}</td><td><span class="result-status${item?.error ? ' is-error' : ''}">${escapeHtml(resultStatus(item))}</span></td></tr>`).join('');

  const citilinkEntries = Object.entries(state.citilinkLastResults || {});
  $('citilinkResultsMeta').textContent = citilinkEntries.length ? `${citilinkEntries.length} поз.` : '';
  $('citilinkResultsEmpty').hidden = citilinkEntries.length > 0;
  $('citilinkResultsTable').innerHTML = citilinkEntries.map(([article, item]) => `<tr><td>${escapeHtml(article)}</td><td>${escapeHtml(item?.brand || '—')}</td><td title="${escapeHtml(item?.name || '')}">${escapeHtml(item?.name || '—')}</td><td><span class="result-status${item?.error ? ' is-error' : ''}">${escapeHtml(resultStatus(item))}</span></td></tr>`).join('');
}

function renderMonitoring() {
  const status = state.priceCheckStatus || {};
  const updatedAt = status.updatedAt ? Date.parse(status.updatedAt) : NaN;
  const stale = Boolean(status.running && Number.isFinite(updatedAt) && Date.now() - updatedAt > 90_000);
  const stateLabel = status.running
    ? (stale ? 'Нет свежего сигнала' : 'В работе')
    : phaseLabels[status.phase] || 'Нет данных';
  const total = Number(status.total || 0);
  const done = Math.min(Number(status.done || 0), total || 0);
  $('priceCheckState').textContent = stateLabel;
  $('priceCheckMeta').textContent = status.updatedAt
    ? `${done} из ${total} товаров · обновлено ${formatDate(status.updatedAt)}${status.error ? ` · ${status.error}` : ''}`
    : 'Проверка ещё не запускалась.';
  $('runPriceCheck').disabled = Boolean(status.running && !stale);
}

function historyStatus(entry) {
  const labels = { started: 'Запущено', success: 'Успешно', completed: 'Завершено', partial: 'Частично', error: 'Ошибка', noop: 'Без изменений' };
  return labels[entry?.status] || (entry?.type === 'price_alert' ? 'Уведомление' : 'Событие');
}

function historyStatusClass(entry) {
  if (entry?.status === 'error') return 'is-error';
  if (entry?.status === 'partial') return 'is-warning';
  if (entry?.status === 'started') return 'is-info';
  return 'is-success';
}

function historyPlatform(entry) {
  return ({ ozon: 'Ozon', wildberries: 'WB', citilink: 'Citilink' })[entry?.platform] || '';
}

function historyMessage(entry) {
  if (entry?.message) return entry.message;
  if (Number.isFinite(Number(entry?.price))) {
    return `Цена ${Number(entry.price).toLocaleString('ru-RU')} ₽ · цель ${Number(entry.targetPrice || 0).toLocaleString('ru-RU')} ₽`;
  }
  return 'Событие без дополнительного описания.';
}

function renderHistory() {
  const history = Array.isArray(state.notificationHistory) ? [...state.notificationHistory].reverse() : [];
  $('historyList').innerHTML = history.length ? history.map((entry) => {
    const platform = historyPlatform(entry);
    const link = entry.url ? ` <a class="history-entry-link" href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">Открыть</a>` : '';
    return `<article class="history-row"><div class="history-entry-content"><div class="history-entry-heading"><strong>${escapeHtml(entry.title || 'Изменение цены')}</strong><span class="history-status ${historyStatusClass(entry)}">${historyStatus(entry)}</span></div><p>${escapeHtml(historyMessage(entry))}${platform ? ` · ${escapeHtml(platform)}` : ''}${link}</p></div><time datetime="${escapeHtml(entry.timestamp || '')}">${escapeHtml(formatDate(entry.timestamp))}</time></article>`;
  }).join('') : '<div class="empty-state"><strong>История пуста</strong><p>Здесь появятся действия, фоновые задания и уведомления MarketPilot.</p></div>';
}

async function loadSettings() {
  const values = await storageGet({
    theme: 'light',
    deepseekApiKey: '',
    deepseekModel: 'deepseek-flash',
    deepseekThinking: 'disabled',
    deepseekReasoningEffort: 'high',
    deepseekPrompt: '',
    deepseekReviewPrompt: '',
    deepseekCitilinkPrompt: '',
    deepseekStats: {},
    deepseekOfficialUsage: null,
    deepseekLastBalance: null,
    deepseekBalanceLastChecked: null,
    checkInterval: 120,
    wbConcurrency: 1,
    citilinkConcurrency: 1
  });
  renderTheme(values.theme);
  $('deepseekApiKey').value = values.deepseekApiKey || '';
  $('deepseekPrompt').value = values.deepseekPrompt || '';
  $('deepseekReviewPrompt').value = values.deepseekReviewPrompt || '';
  $('deepseekCitilinkPrompt').value = values.deepseekCitilinkPrompt || '';
  const rawModel = String(values.deepseekModel || '').trim().toLowerCase();
  const storedModel = DEEPSEEK_MODEL_ALIASES[rawModel] || rawModel || 'deepseek-flash';
  const standard = ['deepseek-flash', 'deepseek-v4-pro'];
  if (standard.includes(storedModel)) {
    $('deepseekModel').value = storedModel;
    $('customModelRow').hidden = true;
  } else {
    $('deepseekModel').value = 'custom';
    $('customModelRow').hidden = false;
    $('customModel').value = storedModel;
  }
  const legacyReasoner = rawModel === 'deepseek-reasoner';
  $('deepseekThinking').value = values.deepseekThinking === 'enabled' || (!values.deepseekThinking && legacyReasoner) ? 'enabled' : 'disabled';
  $('deepseekReasoningEffort').value = ['low', 'high', 'max'].includes(values.deepseekReasoningEffort) ? values.deepseekReasoningEffort : 'high';
  $('deepseekReasoningEffort').disabled = $('deepseekThinking').value !== 'enabled';
  $('checkInterval').value = values.checkInterval || 120;
  $('wbConcurrency').value = ['1', '2', '3', '4', '5'].includes(String(values.wbConcurrency))
    ? String(values.wbConcurrency)
    : DEFAULT_COLLECTION_CONCURRENCY;
  $('citilinkConcurrency').value = ['1', '2', '3', '4', '5'].includes(String(values.citilinkConcurrency))
    ? String(values.citilinkConcurrency)
    : DEFAULT_COLLECTION_CONCURRENCY;
  renderDeepSeekUsage(values);
  intervalDraftDirty = false;
  collectionConcurrencyDraftDirty = false;
}

async function refresh() {
  state = await storageGet({ theme: 'light', trackedItems: [], wbStatus: {}, citilinkStatus: {}, priceCheckStatus: {}, wbLastResults: {}, citilinkLastResults: {}, notificationHistory: [], deepseekStats: {}, deepseekOfficialUsage: null, deepseekLastBalance: null, deepseekBalanceLastChecked: null, checkInterval: 120, wbConcurrency: 1, citilinkConcurrency: 1 });
  renderTheme(state.theme);
  renderProducts();
  renderJobs();
  renderCollectionResults();
  renderMonitoring();
  renderHistory();
  renderDeepSeekUsage(state);
  if (!intervalDraftDirty && document.activeElement !== $('checkInterval')) {
    $('checkInterval').value = state.checkInterval || 120;
  }
  if (!collectionConcurrencyDraftDirty) {
    if (document.activeElement !== $('wbConcurrency')) $('wbConcurrency').value = ['1', '2', '3', '4', '5'].includes(String(state.wbConcurrency)) ? String(state.wbConcurrency) : DEFAULT_COLLECTION_CONCURRENCY;
    if (document.activeElement !== $('citilinkConcurrency')) $('citilinkConcurrency').value = ['1', '2', '3', '4', '5'].includes(String(state.citilinkConcurrency)) ? String(state.citilinkConcurrency) : DEFAULT_COLLECTION_CONCURRENCY;
  }
}

function parseArticleList(value) {
  return [...new Set(String(value || '').split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function bindCollectionForm({ formId, inputId, buttonId, noteId, marketplaceId, generateId }) {
  $(formId).addEventListener('submit', async (event) => {
    event.preventDefault();
    const articles = parseArticleList($(inputId).value);
    const button = $(buttonId);
    const note = $(noteId);
    if (!articles.length) {
      note.textContent = 'Добавьте хотя бы один артикул.';
      setFieldInvalid($(inputId), true);
      $(inputId).focus();
      return;
    }
    button.disabled = true;
    setFieldInvalid($(inputId), false);
    note.textContent = 'Задание запускается…';
    try {
      const response = await sendCommand(MARKETPLACES.find((entry) => entry.id === marketplaceId)?.collectionAction, {
        articles,
        ...(generateId ? { generateDescription: $(generateId).checked } : {})
      });
      if (response?.status === 'already_running') {
        note.textContent = 'Такое задание уже выполняется. Новый запуск не создан.';
        showNotice('Задание уже выполняется.', 'error');
      } else if (response?.status === 'started') {
        $(inputId).value = '';
        note.textContent = `Задание запущено: ${articles.length} ${articles.length === 1 ? 'позиция' : 'позиций'}.`;
        showNotice('Сбор запущен. Прогресс доступен в разделе «Задания».');
      } else {
        throw new Error('Получен неизвестный ответ запуска задания. Ввод сохранён.');
      }
      await refresh();
    } catch (error) {
      note.textContent = error.message || 'Не удалось запустить сбор.';
      showNotice(error.message || 'Не удалось запустить сбор.', 'error');
    } finally {
      button.disabled = false;
    }
  });
}

$('productSearch').addEventListener('input', renderProducts);
$('marketplaceFilter').addEventListener('change', renderProducts);
function saveTrackingFromDashboard(event) {
  event.preventDefault();
  const url = $('trackUrl').value.trim();
  const targetPrice = Number.parseInt($('trackTargetPrice').value, 10);
  if (!isProductUrl(url, 'ozon')) {
    $('trackNote').textContent = 'Нужна ссылка на карточку товара Ozon.';
    setFieldInvalid($('trackUrl'), true);
    $('trackUrl').focus();
    return;
  }
  if (!Number.isInteger(targetPrice) || targetPrice < 1) {
    $('trackNote').textContent = 'Введите целевую цену больше нуля.';
    setFieldInvalid($('trackTargetPrice'), true);
    $('trackTargetPrice').focus();
    return;
  }
  $('saveTracking').disabled = true;
  setFieldInvalid($('trackUrl'), false);
  setFieldInvalid($('trackTargetPrice'), false);
  $('trackNote').textContent = 'Сохраняю отслеживание…';
  upsertTrackedItem({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: normalizeProductUrl(url),
    title: url,
    targetPrice,
    priceType: document.querySelector('input[name="trackPriceType"]:checked')?.value || 'bank',
    lastPrice: null,
    addedAt: new Date().toISOString()
  }).then(() => {
    $('trackForm').reset();
    $('trackNote').textContent = 'Отслеживание сохранено.';
    showNotice('Товар добавлен в мониторинг.');
    return refresh();
  }).catch((error) => {
    $('trackNote').textContent = error.message || 'Не удалось сохранить отслеживание.';
    showNotice(error.message || 'Не удалось сохранить отслеживание.', 'error');
  }).finally(() => {
    $('saveTracking').disabled = false;
  });
}

$('trackForm').addEventListener('submit', saveTrackingFromDashboard);
bindCollectionForm({ formId: 'wbCollectionForm', inputId: 'wbCollectionInput', buttonId: 'startWbCollection', noteId: 'wbCollectionNote', marketplaceId: 'wildberries' });
bindCollectionForm({ formId: 'citilinkCollectionForm', inputId: 'citilinkCollectionInput', buttonId: 'startCitilinkCollection', noteId: 'citilinkCollectionNote', marketplaceId: 'citilink', generateId: 'citilinkGenerateDescription' });
$('wbConcurrency').addEventListener('change', () => { collectionConcurrencyDraftDirty = true; });
$('citilinkConcurrency').addEventListener('change', () => { collectionConcurrencyDraftDirty = true; });
$('clearHistory').addEventListener('click', async () => {
  if (!window.confirm('Очистить историю уведомлений?')) return;
  try {
    await clearNotificationHistory();
    showNotice('История очищена.');
    refresh();
  } catch (error) {
    showNotice(error.message || 'Не удалось очистить историю.', 'error');
  }
});
$('exportWb').addEventListener('click', async () => {
  $('exportWb').disabled = true;
  try {
    await exportWbResults(state.wbLastResults);
    void appendActivityHistory({
      action: 'wb_export',
      title: 'Wildberries: экспорт создан',
      message: `Позиций: ${Object.keys(state.wbLastResults || {}).length}.`,
      platform: 'wildberries'
    }).catch(() => {});
    showNotice('Экспорт Wildberries создан.');
  } catch (error) {
    showNotice(error.message || 'Не удалось создать экспорт WB.', 'error');
  } finally {
    $('exportWb').disabled = !Object.keys(state.wbLastResults || {}).length;
  }
});
$('exportCitilink').addEventListener('click', async () => {
  $('exportCitilink').disabled = true;
  try {
    await exportCitilinkResults(state.citilinkLastResults);
    void appendActivityHistory({
      action: 'citilink_export',
      title: 'Citilink: экспорт создан',
      message: `Позиций: ${Object.keys(state.citilinkLastResults || {}).length}.`,
      platform: 'citilink'
    }).catch(() => {});
    showNotice('Экспорт Citilink создан.');
  } catch (error) {
    showNotice(error.message || 'Не удалось создать экспорт Citilink.', 'error');
  } finally {
    $('exportCitilink').disabled = !Object.keys(state.citilinkLastResults || {}).length;
  }
});
$('clearWb').addEventListener('click', async () => {
  $('clearWb').disabled = true;
  try {
    await clearCollectionResults('wb');
    showNotice('Результаты WB очищены.');
    await refresh();
  } catch (error) {
    showNotice(error.message || 'Не удалось очистить результаты WB.', 'error');
    renderJobs();
  }
});
$('clearCitilink').addEventListener('click', async () => {
  $('clearCitilink').disabled = true;
  try {
    await clearCollectionResults('citilink');
    showNotice('Результаты Citilink очищены.');
    await refresh();
  } catch (error) {
    showNotice(error.message || 'Не удалось очистить результаты Citilink.', 'error');
    renderJobs();
  }
});
populateMarketplaceControls();
$('checkInterval').addEventListener('input', () => { intervalDraftDirty = true; });
$('saveInterval').addEventListener('click', async () => {
  const interval = Number.parseInt($('checkInterval').value, 10);
  if (!Number.isInteger(interval) || interval < 1) { $('intervalNote').textContent = 'Введите целое число от 1 минуты.'; return; }
  try {
    await updateSettings({ checkInterval: interval });
  } catch (error) {
    $('intervalNote').textContent = error.message || 'Не удалось сохранить интервал.';
    showNotice(error.message || 'Не удалось сохранить интервал.', 'error');
    return;
  }
  $('intervalNote').textContent = `Сохранено: каждые ${interval} минут.`;
  intervalDraftDirty = false;
  showNotice('Интервал проверки обновлён.');
});
$('saveCollectionSettings').addEventListener('click', async () => {
  const wbConcurrency = Number.parseInt($('wbConcurrency').value, 10);
  const citilinkConcurrency = Number.parseInt($('citilinkConcurrency').value, 10);
  const valid = (value) => Number.isInteger(value) && value >= 1 && value <= 5;
  if (!valid(wbConcurrency) || !valid(citilinkConcurrency)) {
    $('collectionSettingsNote').textContent = 'Выберите значение от 1 до 5.';
    return;
  }
  try {
    await updateSettings({ wbConcurrency, citilinkConcurrency });
  } catch (error) {
    $('collectionSettingsNote').textContent = error.message || 'Не удалось сохранить настройки сбора.';
    showNotice(error.message || 'Не удалось сохранить настройки сбора.', 'error');
    return;
  }
  collectionConcurrencyDraftDirty = false;
  $('collectionSettingsNote').textContent = 'Настройки сбора сохранены.';
  showNotice('Настройки одновременной обработки сохранены.');
});
themeInputs.forEach((input) => {
  input.addEventListener('change', async () => {
    const previousTheme = normalizeTheme(state.theme);
    const nextTheme = normalizeTheme(input.value);
    renderTheme(nextTheme);
    setThemeNote('Сохраняю…');
    try {
      await updateSettings({ theme: nextTheme });
      state.theme = nextTheme;
      setThemeNote('Сохранено');
    } catch (error) {
      renderTheme(previousTheme);
      setThemeNote('Не удалось сохранить');
      showNotice(error.message || 'Не удалось сохранить тему.', 'error');
    }
  });
});
$('runPriceCheck').addEventListener('click', async () => {
  $('runPriceCheck').disabled = true;
  try {
    const response = await sendCommand('checkPricesNow');
    if (response?.status === 'already_running') showNotice('Проверка уже выполняется.', 'error');
    else showNotice('Проверка цен запущена.');
    await refresh();
  } catch (error) {
    showNotice(error.message || 'Не удалось запустить проверку.', 'error');
    $('runPriceCheck').disabled = false;
  }
});
$('deepseekModel').addEventListener('change', () => { $('customModelRow').hidden = $('deepseekModel').value !== 'custom'; });
$('deepseekThinking').addEventListener('change', () => {
  $('deepseekReasoningEffort').disabled = $('deepseekThinking').value !== 'enabled';
});
$('checkDeepseekBalance').addEventListener('click', async () => {
  const button = $('checkDeepseekBalance');
  const note = $('deepseekBalanceNote');
  button.disabled = true;
  note.textContent = 'Проверяю баланс DeepSeek…';
  try {
    const response = await sendCommand('deepseek_check_balance', { apiKey: $('deepseekApiKey').value.trim(), includeUsage: true });
    state = {
      ...state,
      deepseekOfficialUsage: response.officialUsage || state.deepseekOfficialUsage || null,
      deepseekLastBalance: response.balanceInfo || null,
      deepseekBalanceLastChecked: Date.now()
    };
    renderDeepSeekUsage(state);
    if (response.officialUsage) {
      note.textContent = response.balanceInfo?.is_available === false
        ? `Баланс найден, но API пометил его недоступным. Локальный расход оставлен основным; usage аккаунта ${formatUsageCost(response.officialUsage.totalCost, getUsageCurrency(response.officialUsage))}.`
        : `Баланс обновлён. Локальный расход оставлен основным; usage аккаунта для сравнения ${formatUsageCost(response.officialUsage.totalCost, getUsageCurrency(response.officialUsage))}.`;
      showNotice('Баланс DeepSeek обновлён.');
    } else {
      note.textContent = response.usageError
        ? `Баланс обновлён. ${response.usageError} Показана локальная оценка.`
        : (response.balanceInfo?.is_available === false ? 'Баланс найден, но API пометил его недоступным.' : 'Баланс обновлён.');
      showNotice('Баланс DeepSeek обновлён.');
    }
  } catch (error) {
    note.textContent = error.message || 'Не удалось проверить баланс DeepSeek.';
    showNotice(note.textContent, 'error');
  } finally {
    button.disabled = false;
  }
});
$('resetDeepseekStats').addEventListener('click', async () => {
  if (!window.confirm('Сбросить статистику использования DeepSeek?')) return;
  const button = $('resetDeepseekStats');
  button.disabled = true;
  try {
    const response = await sendCommand('deepseek_reset_stats');
    state = { ...state, deepseekStats: response.stats || {} };
    renderDeepSeekUsage(state);
    $('deepseekBalanceNote').textContent = 'Статистика сброшена.';
    showNotice('Статистика DeepSeek сброшена.');
  } catch (error) {
    showNotice(error.message || 'Не удалось сбросить статистику.', 'error');
  } finally {
    button.disabled = false;
  }
});
$('saveAiSettings').addEventListener('click', async () => {
  const model = $('deepseekModel').value === 'custom' ? $('customModel').value.trim() : $('deepseekModel').value;
  if (!model) { $('aiNote').textContent = 'Укажите идентификатор модели.'; return; }
  try {
    await updateSettings({
      deepseekApiKey: $('deepseekApiKey').value.trim(),
      deepseekModel: model,
      deepseekThinking: $('deepseekThinking').value,
      deepseekReasoningEffort: $('deepseekReasoningEffort').value,
      deepseekPrompt: $('deepseekPrompt').value.trim(),
      deepseekReviewPrompt: $('deepseekReviewPrompt').value.trim(),
      deepseekCitilinkPrompt: $('deepseekCitilinkPrompt').value.trim()
    });
  } catch (error) {
    $('aiNote').textContent = error.message || 'Не удалось сохранить настройки.';
    showNotice(error.message || 'Не удалось сохранить настройки.', 'error');
    return;
  }
  $('aiNote').textContent = 'Настройки сохранены.';
  showNotice('Настройки AI сохранены.');
});
populateStoreNavigation();
window.addEventListener('hashchange', () => setRoute(routeState()));
onStorageChange((changes, area) => { if (area === 'local' && (changes.theme || changes.trackedItems || changes.wbStatus || changes.citilinkStatus || changes.priceCheckStatus || changes.wbLastResults || changes.citilinkLastResults || changes.notificationHistory || changes.deepseekStats || changes.deepseekOfficialUsage || changes.deepseekLastBalance || changes.deepseekBalanceLastChecked || changes.checkInterval || changes.wbConcurrency || changes.citilinkConcurrency)) refresh(); });

setRoute(routeState());
refresh().catch((error) => showNotice(error.message || 'Не удалось загрузить данные.', 'error'));
