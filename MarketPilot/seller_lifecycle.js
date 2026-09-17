// Shared SPA route watcher for Ozon Seller content features.
(function exposeSellerLifecycle(global) {
    function createRouteWatcher({ routeForUrl, onRouteChange, intervalMs = 1000 }) {
        if (typeof routeForUrl !== 'function' || typeof onRouteChange !== 'function') {
            throw new TypeError('Seller route watcher requires routeForUrl and onRouteChange.');
        }

        let lastUrl = '';
        let timerId = null;

        const check = () => {
            const currentUrl = window.location.href;
            if (currentUrl === lastUrl) return;
            lastUrl = currentUrl;
            onRouteChange(routeForUrl(currentUrl), currentUrl);
        };

        const watcher = {
            start() {
                check();
                if (timerId === null) timerId = window.setInterval(check, intervalMs);
                return watcher;
            },
            stop() {
                if (timerId !== null) {
                    window.clearInterval(timerId);
                    timerId = null;
                }
            }
        };
        return watcher;
    }

    global.MarketPilotSellerLifecycle = Object.freeze({ createRouteWatcher });
})(globalThis);
