// Shared DOM primitives for Ozon Seller feature scripts.
(function exposeSellerDom(global) {
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function makeFloatingPanelDraggable(panel, handle, storageKey) {
        if (!panel || !handle || handle.dataset.optExtDraggable === 'true') return;

        handle.dataset.optExtDraggable = 'true';
        handle.classList.add('opt-ext-draggable-handle');
        handle.title = 'Перетащите панель за заголовок';

        let dragState = null;
        let hasUserMovedPanel = false;

        const setPanelPosition = (left, top) => {
            const rect = panel.getBoundingClientRect();
            const margin = 8;
            const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
            const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
            const nextLeft = Math.min(Math.max(left, margin), maxLeft);
            const nextTop = Math.min(Math.max(top, margin), maxTop);

            panel.style.setProperty('left', `${nextLeft}px`, 'important');
            panel.style.setProperty('top', `${nextTop}px`, 'important');
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
        };

        const savePanelPosition = () => {
            if (!storageKey || !chrome.storage?.local) return;

            const rect = panel.getBoundingClientRect();
            chrome.storage.local.set({
                [storageKey]: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top)
                }
            });
        };

        const restorePanelPosition = () => {
            if (!storageKey || !chrome.storage?.local) return;

            chrome.storage.local.get([storageKey], (result) => {
                if (hasUserMovedPanel) return;

                const savedPosition = result?.[storageKey];
                if (!savedPosition
                    || !Number.isFinite(savedPosition.left)
                    || !Number.isFinite(savedPosition.top)) {
                    return;
                }

                setPanelPosition(savedPosition.left, savedPosition.top);
            });
        };

        const stopDragging = (event) => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;

            if (handle.hasPointerCapture?.(event.pointerId)) {
                handle.releasePointerCapture(event.pointerId);
            }
            if (dragState.moved) {
                savePanelPosition();
            }
            handle.classList.remove('is-dragging');
            dragState = null;
        };

        handle.addEventListener('pointerdown', (event) => {
            if (!event.isPrimary || (event.button !== undefined && event.button !== 0)) return;
            if (event.target.closest('button, input, select, textarea, a')) return;

            const rect = panel.getBoundingClientRect();
            dragState = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top,
                moved: false
            };

            handle.setPointerCapture?.(event.pointerId);
            handle.classList.add('is-dragging');
            event.preventDefault();
        });

        handle.addEventListener('pointermove', (event) => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;

            const rect = panel.getBoundingClientRect();
            const nextLeft = event.clientX - dragState.offsetX;
            const nextTop = event.clientY - dragState.offsetY;
            dragState.moved = dragState.moved
                || Math.abs(nextLeft - rect.left) > 2
                || Math.abs(nextTop - rect.top) > 2;

            if (dragState.moved) {
                hasUserMovedPanel = true;
                setPanelPosition(nextLeft, nextTop);
                event.preventDefault();
            }
        });

        handle.addEventListener('pointerup', stopDragging);
        handle.addEventListener('pointercancel', stopDragging);

        restorePanelPosition();
    }

    function cleanRichContentText(text) {
        if (!text) return '';
        let result = text;
        result = result.replace(/(&lt;|<)br\s*\/?>?(&gt;|>)/gi, '\n');
        result = result.replace(/(&lt;|<)\/(p|div|li|tr|h[1-6])(&gt;|>)/gi, '\n');
        result = result.replace(/&nbsp;/gi, ' ')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;|&#39;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&');
        result = result.replace(/<[^>]+>/g, '');
        result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        result = result.replace(/\n{3,}/g, '\n\n');
        return result.split('\n').map(line => line.trim()).join('\n').trim();
    }

    function setNativeValue(element, value) {
        const proto = Object.getPrototypeOf(element);
        const setter = Object.getOwnPropertyDescriptor(element, 'value')?.set
            || Object.getOwnPropertyDescriptor(proto, 'value')?.set
            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function realDblClick(el) {
        const rect1 = el.getBoundingClientRect();
        const opts1 = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect1.left + rect1.width / 2,
            clientY: rect1.top + rect1.height / 2,
            detail: 1
        };

        el.dispatchEvent(new MouseEvent('mousedown', opts1));
        el.dispatchEvent(new MouseEvent('mouseup', opts1));
        el.dispatchEvent(new MouseEvent('click', opts1));
        await sleep(200);

        const rect2 = el.getBoundingClientRect();
        const opts2 = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect2.left + rect2.width / 2,
            clientY: rect2.top + rect2.height / 2,
            detail: 2
        };

        el.dispatchEvent(new MouseEvent('mousedown', opts2));
        el.dispatchEvent(new MouseEvent('mouseup', opts2));
        el.dispatchEvent(new MouseEvent('click', opts2));
        el.dispatchEvent(new MouseEvent('dblclick', opts2));
    }

    global.MarketPilotSellerDom = Object.freeze({
        sleep,
        makeFloatingPanelDraggable,
        cleanRichContentText,
        setNativeValue,
        realDblClick
    });
})(globalThis);
