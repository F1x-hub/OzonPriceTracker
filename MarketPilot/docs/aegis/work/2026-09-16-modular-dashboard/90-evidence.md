# Evidence

Slice status: target static evidence finalized; live browser evidence remains open.

- `node --check` passed for `background.js`, `ozon_content.js`, `popup_compact.js`, `dashboard.js`, `core/marketplaces.js`, `core/storage.js`.
- Manifest JSON parsed and `action.default_popup` equals `popup_compact.html`.
- Required new files exist: compact popup, dashboard, marketplace registry and storage bridge.
- Dashboard includes background collection controls for existing WB and Citilink commands; Ozon widget writes through the tracking command bridge.
- Background price checks merge observations into the latest `trackedItems` snapshot by ID, preserving concurrent UI deletion/upsert.
- Marketplace contract smoke check passed for Ozon product and Wildberries detail URLs.
- WB and Citilink collection status now persists a job id, normalized input articles, phase, start/update timestamps and error text; empty input is recorded as an idle status and a missing Citilink AI key is recorded as an error status.
- Dashboard job cards render phase, update time, job id and error text; a running status older than 90 seconds is labelled `Нет свежего сигнала` without mutating storage.
- Dashboard maps persisted internal phases to Russian labels; entrypoint and Seller contract smoke checks passed after the latest edits.
- Marketplace registry contract smoke passed with collection actions and capabilities; dashboard filters and collection choices are populated from that registry.
- Storage bridge has a safe no-`chrome` read-only fallback for local UI preview; command writes still fail clearly outside the extension runtime.
- VM smoke contract passed: stale running WB and price-check jobs are reconciled to `interrupted`, a fresh Citilink job is preserved, and no retry is scheduled.
- `seller_content.js` now routes by a stable route key, disconnects the reviews/questions/Rich reposition observers and removes owned panels on SPA route changes; a run token prevents an old question batch from updating the new route.
- Question bulk actions no longer increment success on `submitBtn.click()`: clicks are reported as `неизвестный исход`, missing controls and generation errors as failures, and confirmed-by-site remains zero until a site acknowledgement contract exists.
- `git diff --check` passed; only line-ending normalization warnings were reported.
- Local static browser render inspected for dashboard products/collection and compact popup. Layout, labels, focusable controls and responsive structure rendered; browser APIs were unavailable on the HTTP preview, so this is visual-only evidence.
- Fresh-origin HTTP preview rendered the `#/jobs` route with Russian heading, WB/Citilink job cards and registry-populated marketplace controls; this remains visual/static evidence, not extension API execution.
- Citilink optional-AI VM smoke passed: `generateDescription:false` completes collection without an API key and records `descriptionStatus: not_requested`; the legacy omitted flag still requires DeepSeek.
- Fresh-origin dashboard preview rendered the collection form state for both WB and Citilink: the AI checkbox is disabled/hidden for WB, visible and enabled for Citilink, and the input label changes to `Коды Citilink`.
- Citilink job status persists the selected AI mode; the jobs view renders `AI` or `без AI` alongside the phase when that field is present.
- Collection launch contract has an in-worker lock plus a persisted fresh-status check; VM smoke passed for concurrent duplicate messages and for a duplicate against an existing running job. The dashboard reports that the existing job was reused instead of claiming a new launch.
- Monitoring now persists `priceCheckStatus` with job id, progress, phase, timestamps and error/partial state; VM smoke passed for manual/alarm duplicate protection, completion and persisted running-job protection.
- Fresh-origin monitoring preview rendered interval controls, empty last-check state and the manual `Проверить сейчас` action.
- The legacy popup now routes tracking add/remove through background commands; static search found no direct `trackedItems` writes there. A serialized background tracking-write queue passed VM concurrency smoke for parallel upserts and remove+upsert.
- Dashboard and legacy popup now route history clear/item-removal through background commands; monitoring appends history through the same serialized history-write queue. Static search found no direct `notificationHistory` writes in UI/content files, and VM smoke passed append, item removal and clear ordering.
- Post-audit P1/P2 pass: `sendCommand` rejects structured `status:error`; dashboard collection inputs remain intact on error/already-running; `null` prices render as `Ожидание`; repeated URLs preserve item identity and observation fields in VM smoke.
- Post-audit layout pass: dashboard body width equals the viewport at 390, 768, 1024 and 1440 px; product-table overflow remains inside `.table-wrap`; settings `hidden` state is not visible; the collection route exposes WB/Citilink forms and result tables.
- Post-audit monitor pass: Ozon/WB checks use their content-message adapters, missing prices increment failed state, stale/deleted records are skipped before alerts, and price/stat writes use serialized owners. Non-ruble Ozon text is rejected until currency support exists.
- Post-audit legacy pass: tracked-item title/URL rendering in `popup.js` uses DOM text/attributes; command error checks include structured status errors; `openDashboard` updates an existing tab to the requested hash.
- DeepSeek usage pass: settings render the persisted `deepseekLastBalance`/`deepseekBalanceLastChecked` and `deepseekStats`; the balance button calls `deepseek_check_balance`, reset calls `deepseek_reset_stats`, and the browser harness verified `12,34 USD`, 7 requests, 2 000 tokens, `¥0.123`, success feedback, and a 390 px single-column layout without document overflow.
- DeepSeek model pass: schema migration maps legacy `deepseek-chat`/`deepseek-reasoner` to `deepseek-flash`; VM smoke verifies a `deepseek-v4-pro` request sends `thinking: enabled`, `reasoning_effort: max`, omits unsupported `temperature`, and records the current CNY estimate.
- Dashboard jobs now exposes clear WB/Citilink actions alongside lazy XLSX export; the existing background guard rejects clearing a running job.

Covered: syntax, manifest wiring, pure marketplace helpers, file references and diff whitespace.

- Local schema migration is idempotent at version 2: malformed shared arrays/statuses and invalid intervals are normalized, while valid user data is preserved; legacy DeepSeek model aliases migrate to `deepseek-flash` with an explicit thinking mode. settings_update and collection_clear are allowlisted background commands; clearing a running collection is rejected.
- npm test passes manifest/file-reference/syntax/CSS/marketplace/export-row contracts plus the background VM smoke. npm run build passes and creates the generated dist/ unpacked-extension copy.
- Seller shared DOM primitives now live in seller_dom.js; SPA URL polling lives in seller_lifecycle.js, both loaded before seller_content.js. Seller feature no longer defines those helper functions locally.
- Citilink export preserves image URLs and image count; WB/Citilink row builders have pure contract coverage. No transition-all declarations remain in runtime CSS or Seller inline styles.
- Dashboard settings now own the three long AI prompts, and the products table can update a target price through the tracking command; both paths keep validation in the background owner.
- Dashboard products now has a direct Ozon URL/target-price tracking form; the old `Добавить через popup` header action is removed.
- Dashboard collection inputs are separate cards for Wildberries articles and Citilink codes, with Citilink-only optional AI description toggle.
- Popup keeps the contextual quick action only for an active Ozon product and shows registry-driven module actions on unrelated or non-product pages; explicit `[hidden]` display rules keep the quick form and action launcher mutually exclusive.
- Live Chrome read-only check: `seller.ozon.ru/app/reviews` loaded real review rows and mounted `Ассистент отзывов` with a disabled zero-selection send control.
- Live Chrome read-only check: `seller.ozon.ru/app/reviews/questions` loaded real question rows and mounted `AI Ответы на вопросы` with a DeepSeek selector and disabled zero-selection action after the SPA settled.
- Live Chrome read-only check: a Wildberries detail route loaded a real product (article `165354014`, prices `592/605 ₽`); the content script is transport-only, so no visual widget is expected on that page.
- Live Chrome limitation: Ozon product navigation redirected `www.ozon.ru` to `ozon.com`; host support is now in source/manifest, but the unpacked extension could not be reloaded through the CUA policy and no fresh Ozon widget proof was claimed.
- Live Chrome limitation: Citilink navigation was blocked by the browser with `net::ERR_BLOCKED_BY_CLIENT`; dashboard `chrome-extension://` inspection and `chrome://extensions` reload were also blocked by the browser control policy.
Uncovered: a fresh unpacked-extension reload, live service-worker lifecycle/automatic resume, Ozon widget after the new `.com` host match, Citilink DOM, actual Seller acknowledgement/submit behavior, AI calls and export files.

Confidence: C. This is a source slice, not a complete project migration.

The Aegis workspace bundle/check helper was not present in the current plugin cache or PATH; work-record structure was read back manually. This is a structural-check gap, not a semantic pass.
