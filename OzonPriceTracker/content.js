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

// In Manifest V3, content scripts execute and their last evaluated statement 
// is returned to chrome.scripting.executeScript.
// We'll read `window.ozonPriceTargetType` which the background script injects first.
extractData(window.ozonPriceTargetType || 'bank');
