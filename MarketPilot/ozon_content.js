(() => {
    'use strict';

    const HOST_ID = 'ozon-price-tracker-host';
    const WIDGET_CSS_URL = chrome.runtime.getURL('ozon_widget.css');
    const MARKETPILOT_MARK_URL = chrome.runtime.getURL('assets/marketpilot-mark.svg');
    const DEFAULT_PRICE_TYPE = 'bank';

    let host = null;
    let shadowRoot = null;
    let lastUrl = window.location.href;
    let updateTimer = null;
    let mountTimer = null;

    function isVisiblePage() {
        return document.visibilityState === 'visible';
    }

    function isProductPage() {
        try {
            const url = new URL(window.location.href);
            return ['www.ozon.ru', 'ozon.ru', 'www.ozon.com', 'ozon.com'].includes(url.hostname)
                && url.pathname.startsWith('/product/');
        } catch {
            return false;
        }
    }

    function normalizeProductUrl(url) {
        try {
            const parsed = new URL(url);
            return `${parsed.origin}${parsed.pathname}`;
        } catch {
            return url;
        }
    }

    function parsePrice(text) {
        const source = String(text || '');
        if (!/[₽]/.test(source)) return null;
        const normalized = source.replace(/\s/g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
        const value = Number.parseFloat(normalized);
        return Number.isFinite(value) ? Math.round(value) : null;
    }

    function readProductData(priceType) {
        const priceWidget = document.querySelector('[data-widget="webPrice"]');
        if (!priceWidget) return null;

        const selector = priceType === 'nobank'
            ? '.tsHeadline500Medium'
            : '.tsHeadline600Large';
        const priceElement = priceWidget.querySelector(selector)
            || priceWidget.querySelector('[class*="Headline"]');
        const titleElement = document.querySelector('[data-widget="webProductHeading"] h1');

        return {
            url: normalizeProductUrl(window.location.href),
            title: titleElement?.innerText.trim() || '',
            price: parsePrice(priceElement?.innerText)
        };
    }

    function createHost(priceWidget) {
        if (host?.isConnected) return;

        host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'all: initial; display: block; width: 100%;';

        shadowRoot = host.attachShadow({ mode: 'open' });
        shadowRoot.innerHTML = `
            <link rel="stylesheet" href="${WIDGET_CSS_URL}">
            <section class="tracker-widget" aria-labelledby="tracker-title">
                <div class="tracker-brand">
                    <img class="tracker-logo" src="${MARKETPILOT_MARK_URL}" alt="" aria-hidden="true">
                    <div class="tracker-eyebrow">MarketPilot</div>
                </div>
                <div class="tracker-heading" id="tracker-title">Следить за ценой</div>
                <div class="tracker-product" data-role="title"></div>

                <div class="tracker-price-row">
                    <span class="tracker-label">Текущая цена</span>
                    <strong class="tracker-price" data-role="price">—</strong>
                </div>

                <label class="tracker-field">
                    <span>Целевая цена</span>
                    <span class="tracker-input-wrap">
                        <input data-role="target" type="number" min="1" step="1" inputmode="numeric" placeholder="Например, 2 000">
                        <span aria-hidden="true">₽</span>
                    </span>
                </label>

                <fieldset class="tracker-options">
                    <legend>Цена Ozon</legend>
                    <label><input data-role="price-type" type="radio" name="ozon-tracker-price-type" value="bank" checked> С Ozon Банком</label>
                    <label><input data-role="price-type" type="radio" name="ozon-tracker-price-type" value="nobank"> Без Ozon Банка</label>
                </fieldset>

                <button class="tracker-action" data-role="action" type="button">Добавить в отслеживание</button>
                <p class="tracker-status" data-role="status" role="status" aria-live="polite"></p>
            </section>
        `;

        const parent = priceWidget.parentElement;
        if (!parent) return;
        parent.insertBefore(host, priceWidget.nextSibling);
        bindEvents();
    }

    function getRole(role) {
        return shadowRoot?.querySelector(`[data-role="${role}"]`);
    }

    function setStatus(message, kind = '') {
        const status = getRole('status');
        if (!status) return;
        status.textContent = message;
        status.className = `tracker-status ${kind}`.trim();
    }

    function getSelectedPriceType() {
        return shadowRoot?.querySelector('[data-role="price-type"]:checked')?.value
            || DEFAULT_PRICE_TYPE;
    }

    function setSelectedPriceType(priceType) {
        const input = shadowRoot?.querySelector(`[data-role="price-type"][value="${priceType}"]`);
        if (input) input.checked = true;
    }

    function getCurrentItem(items, url) {
        const normalizedUrl = normalizeProductUrl(url);
        return items.find((item) => normalizeProductUrl(item.url) === normalizedUrl) || null;
    }

    function renderProductData(data) {
        const title = getRole('title');
        const price = getRole('price');
        if (!title || !price || !data) return;

        title.textContent = data.title || 'Товар Ozon';
        price.textContent = data.price === null
            ? 'Цена не найдена'
            : `${data.price.toLocaleString('ru-RU')} ₽`;
    }

    function renderTrackingState(items, data) {
        const item = getCurrentItem(items, data.url);
        const targetInput = getRole('target');
        const action = getRole('action');
        if (!targetInput || !action) return;

        if (item) {
            targetInput.value = item.targetPrice || '';
            setSelectedPriceType(item.priceType || DEFAULT_PRICE_TYPE);
            renderProductData(readProductData(item.priceType || DEFAULT_PRICE_TYPE) || data);
            action.textContent = 'Сохранить отслеживание';
            action.dataset.tracked = 'true';
            setStatus('Товар уже отслеживается из расширения.', 'is-neutral');
        } else {
            action.textContent = 'Добавить в отслеживание';
            action.dataset.tracked = 'false';
            setStatus('Уведомим, когда цена достигнет цели.');
        }
    }

    function refreshWidget() {
        if (!isVisiblePage() || !isProductPage()) return;

        const priceType = getSelectedPriceType();
        const data = readProductData(priceType);
        if (!data) return;

        scheduleMount(data);
    }

    function scheduleMount(data) {
        if (mountTimer) return;
        mountTimer = window.setTimeout(() => {
            mountTimer = null;
            const priceWidget = document.querySelector('[data-widget="webPrice"]');
            if (!priceWidget) return;

            createHost(priceWidget);
            renderProductData(data);
            chrome.storage.local.get({ trackedItems: [] }, (result) => {
                renderTrackingState(result.trackedItems, data);
            });
        }, 0);
    }

    function saveTracking() {
        const data = readProductData(getSelectedPriceType());
        const targetInput = getRole('target');
        const targetPrice = Number.parseInt(targetInput?.value || '', 10);

        if (!data || data.price === null) {
            setStatus('Не удалось получить текущую цену товара.', 'is-error');
            return;
        }
        if (!Number.isInteger(targetPrice) || targetPrice < 1) {
            setStatus('Укажите целевую цену больше нуля.', 'is-error');
            targetInput?.focus();
            return;
        }

        chrome.storage.local.get({ trackedItems: [] }, (result) => {
            const items = [...result.trackedItems];
            const existingIndex = items.findIndex((item) => (
                normalizeProductUrl(item.url) === normalizeProductUrl(data.url)
            ));
            const existingItem = existingIndex >= 0 ? items[existingIndex] : null;
            const nextItem = {
                id: existingItem?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                url: existingItem?.url || data.url,
                title: data.title || existingItem?.title || data.url,
                targetPrice,
                priceType: getSelectedPriceType(),
                lastPrice: data.price,
                addedAt: existingItem?.addedAt || new Date().toISOString()
            };

            if (existingIndex >= 0) {
                items[existingIndex] = nextItem;
            } else {
                items.push(nextItem);
            }

            chrome.runtime.sendMessage({ action: 'tracking_upsert', item: nextItem }, (response) => {
                if (chrome.runtime.lastError || response?.success === false || response?.status === 'error') {
                    setStatus('Не удалось сохранить отслеживание.', 'is-error');
                    return;
                }
                renderTrackingState(items, data);
                setStatus('Отслеживание сохранено в расширении.', 'is-success');
            });
        });
    }

    function bindEvents() {
        getRole('action')?.addEventListener('click', saveTracking);
        shadowRoot?.querySelectorAll('[data-role="price-type"]').forEach((input) => {
            input.addEventListener('change', () => {
                const data = readProductData(input.value);
                if (data) renderProductData(data);
            });
        });
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.action !== 'get_current_product') return;
        const priceType = message.priceType === 'nobank' ? 'nobank' : DEFAULT_PRICE_TYPE;
        sendResponse(readProductData(priceType));
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local' || !changes.trackedItems || !shadowRoot) return;
        const priceType = getSelectedPriceType();
        const data = readProductData(priceType);
        if (!data) return;
        renderTrackingState(changes.trackedItems.newValue || [], data);
    });

    function handleUrlChange() {
        if (window.location.href === lastUrl) return;
        lastUrl = window.location.href;
        host?.remove();
        host = null;
        shadowRoot = null;
        refreshWidget();
    }

    function observePage() {
        const observer = new MutationObserver(() => {
            if (updateTimer) return;
            updateTimer = window.setTimeout(() => {
                updateTimer = null;
                handleUrlChange();
                refreshWidget();
            }, 250);
        });

        observer.observe(document.body, { childList: true, subtree: true });
        window.setInterval(handleUrlChange, 1000);
    }

    function initialize() {
        if (!isVisiblePage() || !isProductPage()) return;
        observePage();
        refreshWidget();
    }

    if (isVisiblePage()) {
        initialize();
    } else {
        document.addEventListener('visibilitychange', initialize, { once: true });
    }
})();
