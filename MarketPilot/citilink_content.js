(() => {
    const PRODUCT_IMAGE_MARKER = '/product-images/';
    const MAIN_GALLERY_SELECTOR = '[data-meta-name="ImageGallery__main"]';
    const THUMBS_GALLERY_SELECTOR = '[data-meta-name="ImageGallery__thumbs"]';
    const SLIDE_IMAGE_SELECTOR = '[class*="Slide--StyledSlide"] img, [class*="Slide--StyledSlide"] source';
    const THUMB_SELECTOR = '[class*="Thumb--StyledThumb"]';
    const GALLERY_WAIT_TIMEOUT_MS = 10000;
    const GALLERY_STEP_DELAY_MS = 100;

    let carouselImageUrlsPromise = null;

    function cleanText(value) {
        return String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanLines(value) {
        const lines = String(value || '')
            .split(/\r?\n/)
            .map(cleanText)
            .filter(Boolean);

        return lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
    }

    function toAbsoluteUrl(value) {
        if (!value) return '';

        try {
            return new URL(value, window.location.href).href;
        } catch (_) {
            return '';
        }
    }

    function extractSrcSetUrls(value) {
        return String(value || '')
            .split(',')
            .map(part => part.trim().split(/\s+/)[0])
            .map(toAbsoluteUrl)
            .filter(Boolean);
    }

    function imageKey(url) {
        const match = url.match(/\/product-images\/([^/?#]+)/i);
        return match ? match[1] : url;
    }

    function imageWidth(url) {
        const match = url.match(/\/width:(\d+)\//i);
        return match ? Number(match[1]) : 0;
    }

    function addImageCandidate(bestByImage, url) {
        if (!url || !url.includes(PRODUCT_IMAGE_MARKER)) return;

        const key = imageKey(url);
        const previous = bestByImage.get(key);
        if (!previous || imageWidth(url) >= imageWidth(previous)) {
            bestByImage.set(key, url);
        }
    }

    function addElementImageCandidates(bestByImage, element) {
        ['src', 'data-src', 'data-original', 'srcset', 'data-srcset'].forEach(attribute => {
            const value = element.getAttribute(attribute);
            if (!value) return;

            const urls = attribute.includes('srcset')
                ? extractSrcSetUrls(value)
                : [toAbsoluteUrl(value)];
            urls.forEach(url => addImageCandidate(bestByImage, url));
        });
    }

    function collectImageUrlsFromScope(scope, selector = 'img, source') {
        const bestByImage = new Map();
        if (!scope) return [];

        scope.querySelectorAll(selector).forEach(element => {
            addElementImageCandidates(bestByImage, element);
        });

        return Array.from(bestByImage.values());
    }

    function collectPageImageUrls() {
        const bestByImage = new Map();

        document.querySelectorAll('img, source').forEach(element => {
            addElementImageCandidates(bestByImage, element);
        });

        document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach(element => {
            addImageCandidate(bestByImage, toAbsoluteUrl(element.getAttribute('content')));
        });

        document.querySelectorAll('[style*="product-images"]').forEach(element => {
            const matches = element.getAttribute('style').match(/url\((['"]?)(.*?)\1\)/gi) || [];
            matches.forEach(match => {
                const value = match.replace(/^url\((['"]?)/i, '').replace(/(['"]?)\)$/i, '');
                addImageCandidate(bestByImage, toAbsoluteUrl(value));
            });
        });

        return Array.from(bestByImage.values());
    }

    function collectEmbeddedImageUrls(allowedKeys = null) {
        const bestByImage = new Map();
        const imageUrlPattern = /https?:[^"'\\\s]+\/product-images\/[^"'\\\s]+/g;

        document.querySelectorAll('script').forEach(script => {
            const matches = script.textContent?.match(imageUrlPattern) || [];
            matches.forEach(url => {
                if (allowedKeys && !allowedKeys.has(imageKey(url))) return;
                addImageCandidate(bestByImage, url);
            });
        });

        return Array.from(bestByImage.values());
    }

    function getImageUrl(element) {
        return toAbsoluteUrl(element?.currentSrc || element?.src || element?.getAttribute('src'));
    }

    function getImageKeyFromElement(element) {
        return imageKey(getImageUrl(element));
    }

    function getActiveThumbImageKey() {
        const activeThumb = document.querySelector(
            '[data-meta-name="ImageGallery__thumb_active"] img, ' +
            '[data-meta-name="ImageGallery__thumb_active"] source'
        );
        return getImageKeyFromElement(activeThumb);
    }

    async function waitForThumbActivation(expectedKey) {
        const deadline = Date.now() + 800;

        while (Date.now() < deadline) {
            if (expectedKey && getActiveThumbImageKey() === expectedKey) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    async function waitForMainGallery() {
        const deadline = Date.now() + GALLERY_WAIT_TIMEOUT_MS;

        while (Date.now() < deadline) {
            const mainGallery = document.querySelector(MAIN_GALLERY_SELECTOR);
            if (mainGallery?.querySelector('img, source')) return mainGallery;
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        return document.querySelector(MAIN_GALLERY_SELECTOR);
    }

    async function collectCarouselImageUrls() {
        const mainGallery = await waitForMainGallery();
        if (!mainGallery) return collectPageImageUrls();

        const bestByImage = new Map();
        const mainImageSelector = mainGallery.querySelector(SLIDE_IMAGE_SELECTOR)
            ? SLIDE_IMAGE_SELECTOR
            : 'img, source';
        const galleryImageKeys = new Set(
            Array.from(mainGallery.querySelectorAll('img, source'))
                .map(getImageUrl)
                .filter(Boolean)
                .map(imageKey)
        );
        const addScopeImages = () => {
            collectImageUrlsFromScope(mainGallery, mainImageSelector)
                .forEach(url => addImageCandidate(bestByImage, url));
        };

        collectEmbeddedImageUrls(galleryImageKeys)
            .forEach(url => addImageCandidate(bestByImage, url));
        addScopeImages();

        const thumbsGallery = document.querySelector(THUMBS_GALLERY_SELECTOR);
        const thumbs = Array.from(
            thumbsGallery?.querySelectorAll(THUMB_SELECTOR) ||
            document.querySelectorAll(THUMB_SELECTOR)
        );

        for (const thumb of thumbs) {
            const thumbImage = thumb.querySelector('img, source');
            const expectedKey = getImageKeyFromElement(thumbImage);
            try {
                thumb.click();
            } catch (_) {
                // A single malformed thumbnail must not abort the whole product.
            }
            if (!bestByImage.has(expectedKey)) {
                await waitForThumbActivation(expectedKey);
            } else {
                await new Promise(resolve => setTimeout(resolve, GALLERY_STEP_DELAY_MS));
            }
            addScopeImages();
        }

        collectImageUrlsFromScope(thumbsGallery, 'img, source')
            .forEach(url => addImageCandidate(bestByImage, url));

        return Array.from(bestByImage.values());
    }

    function collectImageUrls() {
        if (!carouselImageUrlsPromise) {
            carouselImageUrlsPromise = collectCarouselImageUrls();
        }

        return carouselImageUrlsPromise;
    }

    function findProductJsonLd() {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));

        for (const script of scripts) {
            try {
                const parsed = JSON.parse(script.textContent || '');
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                const product = entries.find(entry => {
                    const type = entry && entry['@type'];
                    return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
                });
                if (product) return product;
            } catch (_) {
                // Some pages contain JSON-LD fragments that are not valid JSON.
            }
        }

        return null;
    }

    function findSectionRoot(heading, nextHeading) {
        let root = heading.parentElement || heading;
        let best = root;

        for (let index = 0; index < 6 && root.parentElement; index += 1) {
            const candidate = root.parentElement;
            const headings = Array.from(candidate.querySelectorAll('h4'));
            if (nextHeading && headings.includes(nextHeading)) break;
            best = candidate;
            root = candidate;
        }

        return best;
    }

    function collectCharacteristics() {
        const headings = Array.from(document.querySelectorAll('h4'))
            .filter(heading => cleanText(heading.textContent));

        return headings.map((heading, index) => {
            const nextHeading = headings[index + 1];
            const root = findSectionRoot(heading, nextHeading);
            const lines = cleanLines(root.innerText || root.textContent);
            const section = cleanText(heading.textContent);

            return {
                section,
                text: lines.filter(line => line !== section)
            };
        }).filter(item => item.text.length > 0);
    }

    function extractBrand(characteristicsText, jsonLd) {
        if (jsonLd?.brand) {
            return cleanText(typeof jsonLd.brand === 'string' ? jsonLd.brand : jsonLd.brand.name);
        }

        const flatText = cleanText(characteristicsText);
        const match = flatText.match(/\bБренд\b\s*:?\s*(.*?)(?=\s+(?:Серия|Модель|Экран|Диагональ|Тип)\b|$)/i);
        return cleanText(match?.[1] || '');
    }

    function extractArticleId() {
        const bodyText = document.body?.innerText || '';
        const codeMatch = bodyText.match(/Код товара\s*:?\s*(\d{4,})/i);
        if (codeMatch) return codeMatch[1];

        const pathMatch = window.location.pathname.match(/-(\d+)(?:\/properties)?\/?$/i);
        return pathMatch ? pathMatch[1] : '';
    }

    function normalizeProductUrl(url) {
        const absoluteUrl = toAbsoluteUrl(url);
        if (!absoluteUrl) return '';

        return absoluteUrl
            .replace(/\/properties\/?$/i, '/')
            .replace(/\/$/, '') + '/properties/';
    }

    function parseSearchResult(articleId) {
        const normalizedArticle = String(articleId || '').replace(/\D/g, '');
        const links = Array.from(document.querySelectorAll('a[href*="/product/"]'));
        const suffix = `-${normalizedArticle}/`;
        const link = links.find(candidate => {
            const href = candidate.getAttribute('href') || '';
            return href.includes(suffix) || cleanText(candidate.textContent).includes(normalizedArticle);
        });

        if (!link) {
            return { found: false, article: normalizedArticle };
        }

        return {
            found: true,
            article: normalizedArticle,
            url: normalizeProductUrl(link.href),
            name: cleanText(link.textContent)
        };
    }

    async function parseProductData(expectedArticleId) {
        const jsonLd = findProductJsonLd();
        const title = cleanText(document.querySelector('h1')?.textContent) || cleanText(jsonLd?.name);
        const sections = collectCharacteristics();
        const characteristicsText = sections
            .map(item => `${item.section}\n${item.text.join('\n')}`)
            .join('\n\n');
        const description = cleanText(
            jsonLd?.description ||
            document.querySelector('meta[name="description"]')?.getAttribute('content')
        );
        const article = extractArticleId() || String(expectedArticleId || '').replace(/\D/g, '');
        const brand = extractBrand(characteristicsText, jsonLd);

        return {
            found: Boolean(title || characteristicsText),
            article,
            name: title,
            brand,
            description,
            characteristics: sections,
            characteristicsText,
            imageUrls: await collectImageUrls(),
            url: normalizeProductUrl(window.location.href)
        };
    }

    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
        if (request.action === 'getCitilinkSearchResult') {
            sendResponse(parseSearchResult(request.articleId));
            return false;
        }

        if (request.action === 'getCitilinkProductData') {
            parseProductData(request.articleId)
                .then(sendResponse)
                .catch(error => sendResponse({
                    found: false,
                    article: String(request.articleId || '').replace(/\D/g, ''),
                    error: error?.message || 'Не удалось собрать данные товара'
                }));
            return true;
        }

        return false;
    });
})();
