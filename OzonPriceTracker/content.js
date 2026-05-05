function extractData(priceType) {
    try {
        let priceElement;
        
        if (priceType === 'bank') {
            priceElement = document.querySelector('[data-widget="webPrice"] .tsHeadline600Large');
        } else if (priceType === 'nobank') {
            priceElement = document.querySelector('[data-widget="webPrice"] .tsHeadline500Medium');
        }

        let priceValue = null;
        if (priceElement) {
            const priceText = priceElement.innerText || "";
            // Remove all spaces (incl non-breaking) and '₽'
            const cleanedText = priceText.replace(/\s/g, '').replace(/₽/g, '');
            priceValue = parseInt(cleanedText, 10);
            if (isNaN(priceValue)) {
                priceValue = null;
            }
        }
        
        let titleValue = null;
        const titleElement = document.querySelector('div[data-widget="webProductHeading"] h1');
        if (titleElement) {
            titleValue = titleElement.innerText.trim();
        }

        return { price: priceValue, title: titleValue };
    } catch (e) {
        console.error("Error extracting Ozon data:", e);
        return { price: null, title: null };
    }
}

// --- Wildberries logic ---

function parsePrice(el) {
  if (!el) return null;
  return parseInt(el.textContent.replace(/[^\d]/g, ''), 10);
}

function waitForPrices() {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const walletEl = document.querySelector('[class*="priceBlockWalletPrice"] h2');
      const totalEl  = document.querySelector('ins[class*="priceBlockFinalPrice"]');
      if (walletEl || totalEl) {
        clearInterval(interval);
        resolve({
          wallet: parsePrice(walletEl),
          total:  parsePrice(totalEl)
        });
      }
    }, 300);

    // таймаут 10 секунд если страница не загрузилась
    setTimeout(() => {
      clearInterval(interval);
      resolve({ wallet: null, total: null });
    }, 10000);
  });
}

// Only add listener if not already added (to avoid errors on re-injection)
if (!window.wbListenerAdded) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'getPrices') {
        waitForPrices().then(sendResponse);
        return true; // держим канал открытым
      }
    });
    window.wbListenerAdded = true;
}

// --- Entry point for Ozon injection ---
// In Manifest V3, content scripts execute and their last evaluated statement 
// is returned to chrome.scripting.executeScript.
extractData(window.ozonPriceTargetType || 'bank');
