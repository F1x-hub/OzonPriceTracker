// Setup alarm on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get({ checkInterval: 120 }, (result) => {
        chrome.alarms.create("priceCheck", {
            periodInMinutes: result.checkInterval
        });
    });
    // Trigger initial check on install
    checkPrices();
});

// Listen for alarms
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "priceCheck") {
        checkPrices();
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
        checkPrices();
        sendResponse({status: "started"});
    } else if (request.action === 'fetchWbPrices') {
        fetchAll(request.articles).then(sendResponse);
        return true;
    }
});

async function checkPrices() {
    console.log("Starting price check...");
    
    // Get tracked items
    const data = await chrome.storage.local.get({ trackedItems: [] });
    let items = data.trackedItems;
    
    if (items.length === 0) {
        console.log("No items to check.");
        return;
    }

    let itemsUpdated = false;

    // Check sequentially to avoid overwhelming browser/tab system
    for (let i = 0; i < items.length; i++) {
        let item = items[i];
        try {
            const currentData = await checkSingleItem(item);
            
            if (currentData && currentData.price !== null) {
                const currentPrice = currentData.price;
                const title = currentData.title || item.title || item.url;
                
                // Track item title update
                if (currentData.title && item.title !== currentData.title) {
                    items[i].title = currentData.title;
                    itemsUpdated = true;
                }

                // Check if price dropped below or hit target
                if (currentPrice <= item.targetPrice) {
                    
                    // Create notification
                    chrome.notifications.create({
                        type: "basic",
                        title: "Цена достигла цели на Ozon!",
                        message: `Цена ${currentPrice}₽ (цель: ${item.targetPrice}₽)\n${title}`,
                        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
                        requireInteraction: true
                    });

                    // Save to history
                    const historyData = await chrome.storage.local.get({ notificationHistory: [] });
                    const history = historyData.notificationHistory;
                    
                    history.push({
                        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                        itemId: item.id,
                        url: item.url,
                        title: title,
                        price: currentPrice,
                        targetPrice: item.targetPrice,
                        timestamp: new Date().toISOString()
                    });

                    await chrome.storage.local.set({ notificationHistory: history });
                }
                
                // Update item with new price
                items[i].lastPrice = currentPrice;
                itemsUpdated = true;
            }
        } catch (error) {
            console.error(`Error checking item ${item.url}:`, error);
        }
    }

    // Save updated items back to storage
    if (itemsUpdated) {
        await chrome.storage.local.set({ trackedItems: items });
    }
    
    // Update last check time
    await chrome.storage.local.set({ lastCheckTimestamp: Date.now() });
    console.log("Price check finished.");
}

async function checkSingleItem(item) {
    return new Promise((resolve, reject) => {
        // 1. Open background tab
        chrome.tabs.create({ url: item.url, active: false }, (tab) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }

            const tabId = tab.id;

            // 2. Wait 4000ms
            setTimeout(() => {
                // 3. Inject variables and execute script
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: (type) => { window.ozonPriceTargetType = type; },
                    args: [item.priceType]
                }, () => {
                    chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        files: ['content.js']
                    }, (results) => {
                        // 4. Close the tab immediately
                        chrome.tabs.remove(tabId, () => {
                            if (chrome.runtime.lastError) {
                                console.error("Error closing tab:", chrome.runtime.lastError);
                            }
                        });

                        // 5. Parse result
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                        } else if (results && results[0] && results[0].result !== undefined) {
                            resolve(results[0].result); // returns { price, title } or null if issues occur
                        } else {
                            resolve({ price: null, title: null });
                        }
                    });
                });
            }, 4000); 
        });
    });
}

// Handle notification click to open the URL
chrome.notifications.onClicked.addListener((notificationId) => {
    chrome.tabs.create({ url: "https://www.ozon.ru/cart" });
});

// --- Wildberries Fetch logic ---

async function fetchAll(articles) {
  const results = {};
  for (const id of articles) {
    results[id] = await fetchOne(id);
  }
  return results;
}

async function fetchOne(articleId) {
  return new Promise(async (resolve) => {
    const url = `https://www.wildberries.ru/catalog/${articleId}/detail.aspx`;
    const tab = await chrome.tabs.create({ url, active: false });

    const onUpdated = (tabId, changeInfo) => {
      if (tabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);

      // Give it a small moment for content script to register if needed, 
      // though 'complete' status usually means content scripts have run or are running.
      setTimeout(() => {
          chrome.tabs.sendMessage(tab.id, { action: 'getPrices' }, async (response) => {
            await chrome.tabs.remove(tab.id);
            resolve(response ?? { wallet: null, total: null });
          });
      }, 500); 
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    
    // Safety timeout
    setTimeout(async () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        try { await chrome.tabs.remove(tab.id); } catch(e) {}
        resolve({ wallet: null, total: null });
    }, 15000);
  });
}
