import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = join(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'docs' || entry.name === 'scripts' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const files = await walk(root);
const fileSet = new Set(files.map((file) => relative(root, file).replaceAll('\\', '/')));
const requireFile = (path) => assert(fileSet.has(path), 'Missing extension file: ' + path);

assert.equal(manifest.manifest_version, 3);
assert.ok(manifest.host_permissions.includes('https://platform.deepseek.com/*'), 'DeepSeek platform usage permission is required');
requireFile(manifest.background.service_worker);
requireFile(manifest.action.default_popup);
for (const icon of Object.values(manifest.icons || {})) requireFile(icon);
for (const icon of Object.values(manifest.action.default_icon || {})) requireFile(icon);
for (const script of manifest.content_scripts.flatMap((entry) => entry.js || [])) requireFile(script);
for (const resource of manifest.web_accessible_resources.flatMap((entry) => entry.resources || [])) requireFile(resource);

const sellerScript = manifest.content_scripts.find((entry) => entry.matches?.some((match) => match.includes('seller.ozon.ru')));
assert.deepEqual(sellerScript?.js?.slice(0, 3), ['seller_dom.js', 'seller_lifecycle.js', 'seller_content.js']);

for (const path of files.filter((file) => file.endsWith('.js') && !file.endsWith('xlsx.full.min.js'))) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'Syntax check failed for ' + relative(root, path) + ':\n' + (result.stderr || result.stdout));
}

const htmlFiles = files.filter((file) => file.endsWith('.html'));
for (const path of htmlFiles) {
  const html = await readFile(path, 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    assert.match(match[1], /\bsrc\s*=/i, 'Inline script is forbidden in ' + relative(root, path));
  }
}
for (const filename of ['popup.html', 'popup_compact.html', 'dashboard.html']) {
  const html = await readFile(join(root, filename), 'utf8');
  assert.match(html, /assets\/marketpilot-mark\.svg/);
}
const dashboardHtml = await readFile(join(root, 'dashboard.html'), 'utf8');
for (const id of ['deepseekPrompt', 'deepseekReviewPrompt', 'deepseekCitilinkPrompt']) {
  assert.match(dashboardHtml, new RegExp('id="' + id + '"'));
}
for (const id of ['checkDeepseekBalance', 'deepseekBalanceValue', 'deepseekStatRequests', 'deepseekStatTokens', 'deepseekStatCost', 'deepseekDailyChart', 'deepseekDailyTotal', 'deepseekDailyEmpty', 'resetDeepseekStats']) {
  assert.match(dashboardHtml, new RegExp('id="' + id + '"'));
}
for (const id of ['deepseekThinking', 'deepseekReasoningEffort']) {
  assert.match(dashboardHtml, new RegExp('id="' + id + '"'));
}
for (const id of ['wbConcurrency', 'citilinkConcurrency', 'saveCollectionSettings']) {
  assert.match(dashboardHtml, new RegExp('id="' + id + '"'));
}
for (const theme of ['light', 'dark']) {
  assert.match(dashboardHtml, new RegExp('data-theme-card="' + theme + '"'));
  assert.match(dashboardHtml, new RegExp('value="' + theme + '"'));
}
assert.match(dashboardHtml, /value="deepseek-flash"/);
assert.match(dashboardHtml, /value="deepseek-v4-pro"/);
assert.match(dashboardHtml, /data-panel="overview"[\s\S]*id="trackedCount"/);
assert.match(dashboardHtml, /data-panel="stores"[\s\S]*id="productsTable"/);
assert.match(dashboardHtml, /data-panel="history"[\s\S]*История действий/);
assert.match(dashboardHtml, /id="storeOverviewGrid"/);
assert.match(dashboardHtml, /id="storeTabs"/);
assert.match(dashboardHtml, /seller\.ozon\.ru\/app\/reviews/);
assert.match(dashboardHtml, /seller\.ozon\.ru\/app\/reviews\/questions/);
assert.doesNotMatch(dashboardHtml, /data-route="(?:replies|content|products|monitoring|collection)"/);
for (const id of ['wbResultsTable', 'citilinkResultsTable', 'clearWb', 'clearCitilink']) {
  assert.match(dashboardHtml, new RegExp('id="' + id + '"'));
}
for (const id of ['trackForm', 'trackUrl', 'trackTargetPrice', 'wbCollectionForm', 'wbCollectionInput', 'citilinkCollectionForm', 'citilinkCollectionInput']) {
  assert.match(dashboardHtml, new RegExp('id="' + id + '"'));
}
assert.doesNotMatch(dashboardHtml, /id="headerAction"/);
const dashboardJs = await readFile(join(root, 'dashboard.js'), 'utf8');
assert.match(dashboardJs, /applyTheme/);
assert.match(dashboardJs, /updateSettings\(\{ theme:/);
const dashboardCss = await readFile(join(root, 'dashboard.css'), 'utf8');
assert.match(dashboardCss, /\.theme-option input \{[^}]*min-height:\s*16px[^}]*padding:\s*0/);
assert.match(dashboardCss, /\.theme-option:has\(input:focus-visible\)/);
assert.match(dashboardCss, /html\[data-theme="dark"\] \.brand-mark \{[^}]*filter:\s*brightness\(0\) invert\(1\)/);
const popupCss = await readFile(join(root, 'popup_compact.css'), 'utf8');
assert.match(popupCss, /html\[data-theme="dark"\] \.brand-mark \{[^}]*filter:\s*brightness\(0\) invert\(1\)/);
assert.match(dashboardJs, /data-remove-id/);
assert.match(dashboardJs, /bindCollectionForm/);
assert.match(dashboardJs, /routeAliases/);
assert.match(dashboardJs, /data-marketplace-tab/);
const storageJs = await readFile(join(root, 'core', 'storage.js'), 'utf8');
assert.match(storageJs, /openDashboard\(hash = '#\/overview'\)/);
const popupHtml = await readFile(join(root, 'popup.html'), 'utf8');
assert.match(popupHtml, /value="deepseek-flash"/);
assert.match(popupHtml, /value="deepseek-v4-pro"/);

const cssFiles = files.filter((file) => file.endsWith('.css'));
for (const path of cssFiles) {
  const css = await readFile(path, 'utf8');
  assert.doesNotMatch(css, /transition\s*:\s*all\b/i, 'Use explicit transition properties in ' + relative(root, path));
}

const registry = await import(new URL('../core/marketplaces.js', import.meta.url));
assert.deepEqual(registry.MARKETPLACES.map((marketplace) => marketplace.id), ['ozon', 'wildberries', 'citilink']);
assert.deepEqual(registry.MARKETPLACES.map((marketplace) => marketplace.dashboard?.defaultModule), ['tracking', 'collection', 'collection']);
assert.ok(registry.MARKETPLACES.every((marketplace) => marketplace.dashboard?.modules?.length));
assert.ok(registry.MARKETPLACES.flatMap((marketplace) => marketplace.popupActions || []).every((action) => action.module && action.title && action.description && action.buttonLabel));
assert.ok(registry.MARKETPLACES.every((marketplace) => (marketplace.popupActions || []).every((action) => marketplace.dashboard.modules.includes(action.module))));
assert.equal(registry.identifyMarketplace('https://www.wildberries.ru/catalog/123/detail.aspx').id, 'wildberries');
assert.equal(registry.identifyMarketplace('https://www.citilink.ru/product/123/').id, 'citilink');
assert.equal(registry.identifyMarketplace('https://www.ozon.ru/product/test-123/').id, 'ozon');
assert.equal(registry.identifyMarketplace('https://ozon.com/product/test-123/').id, 'ozon');
assert.equal(registry.isProductUrl('https://ozon.com/product/test-123/', 'ozon'), true);

const exportFeature = await import(new URL('../features/export.js', import.meta.url));
assert.deepEqual(exportFeature.buildWbRows({ '123': { wallet: 100, total: 120 } }), [['123', '100', '120', '']]);
assert.deepEqual(exportFeature.buildCitilinkRows({
  '456': { brand: 'Brand', name: 'Item', description: 'Text', imageUrls: ['https://img/1'], imageCount: 1, status: 'done' }
}), [['456', 'Brand', 'Item', 'Text', 'https://img/1', '1', 'done', '']]);

const sellerContent = await readFile(join(root, 'seller_content.js'), 'utf8');
assert.doesNotMatch(sellerContent, /\bfunction\s+(sleep|makeFloatingPanelDraggable|cleanRichContentText|setNativeValue|realDblClick)\b/);
const sellerDom = await readFile(join(root, 'seller_dom.js'), 'utf8');
for (const helper of ['sleep', 'makeFloatingPanelDraggable', 'cleanRichContentText', 'setNativeValue', 'realDblClick']) {
  assert.match(sellerDom, new RegExp('\\b' + helper + '\\b'));
}

console.log('check ok: ' + files.length + ' files, manifest and contracts valid');
