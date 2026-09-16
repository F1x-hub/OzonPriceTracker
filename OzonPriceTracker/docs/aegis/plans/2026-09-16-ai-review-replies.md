# Goal

Добавить в расширение генерацию ответов на отзывы через DeepSeek и отдельное поле промпта в AI-настройках popup, чтобы сохранённый промпт можно было выбрать как режим ответа в таблице отзывов.

# Architecture

- `popup.html` и `popup.js` владеют редактированием и сохранением пользовательского промпта `deepseekReviewPrompt`.
- `background.js` владеет чтением ключа/настроек, подготовкой контекста и вызовом DeepSeek через существующий `requestDeepSeekCompletion`.
- `seller_content.js` владеет выбором режима для строки/массового выбора, открытием формы Ozon Seller и вставкой/отправкой ответа.
- Существующие текстовые шаблоны `ozonReplyTemplates` и AI-ответы на вопросы не меняют контракт.

# Tech Stack

Chrome MV3 extension, vanilla ES6 JavaScript, `chrome.storage.local`, service worker, DeepSeek Chat Completions API.

# Baseline / Authority Refs

- `.agents/rules/agent.md`: изменения только внутри `OzonPriceTracker`, MV3, существующие владельцы popup/background/content.
- `OzonPriceTracker/popup.html`: текущая AI-вкладка и поле промпта вопросов.
- `OzonPriceTracker/popup.js`: текущая загрузка/автосохранение AI-настроек и prompt chips.
- `OzonPriceTracker/background.js`: текущий DeepSeek gateway и общий учёт статистики.
- `OzonPriceTracker/seller_content.js`: текущий выбор шаблонов отзывов, отправка отзывов и аналогичный AI-режим вопросов.

# Compatibility Boundary

- Сохранённые `ozonReplyTemplates` продолжают работать без миграции.
- Старое поле `deepseekPrompt` остаётся промптом вопросов.
- При отсутствии `deepseekReviewPrompt` используется встроенный безопасный промпт отзывов.
- Новый режим имеет стабильный id `deepseek_ai`; другие значения остаются id шаблонов.
- Не добавлять автоматическую отправку без явного запуска существующей кнопкой «Отправить ответы».

# TDD Route

- Mode: off
- Decision: skipped
- Strict authority: not applicable; пользователь не просил strict TDD, в проекте нет тестового каркаса.
- Strict signals: новый UI/storage/API/content contract требует проверки, но не меняет решение в off-режиме.
- Light eligibility: не применяется, так как затронуты несколько владельцев.
- TDD-fit exception: нет исполняемого test harness.
- Test posture: post-change regression и статическая проверка контрактов.
- Reason: минимальная проверка должна покрыть popup → storage → service worker → seller content без добавления отдельной тестовой инфраструктуры.
- Verification: `node --check` для изменённых JS, JSON parse manifest, `git diff --check`, targeted `rg` contract checks.

# Files

- Modify `OzonPriceTracker/popup.html`: добавить отдельную textarea промпта отзывов, reset и chips `{product}`, `{review}`, `{date}`.
- Modify `OzonPriceTracker/popup.js`: объявить дефолт, загрузку, autosave, reset и сохранение `deepseekReviewPrompt`.
- Modify `OzonPriceTracker/background.js`: добавить message action `deepseek_generate_review_answer` и handler с заменой плейсхолдеров.
- Modify `OzonPriceTracker/seller_content.js`: добавить AI option в review dropdowns и вызвать новый handler перед заполнением формы.
- Do not overwrite pre-existing unrelated changes in `background.js`, `manifest.json`, `popup.css`, `popup.html`, `popup.js`, `citilink_content.js`; apply only the scoped additions in the listed files.

# Change Necessity

- User-visible need: продавцу нужен AI-ответ на отзыв с настраиваемым стилем.
- No-change / non-code option: одного существующего текстового шаблона недостаточно — он не вызывает AI и не хранит отдельный review prompt.
- Why code change is necessary: нужно связать новое поле storage с UI выбора отзыва и DeepSeek gateway.
- Minimum change boundary: существующие `popup.html`, `popup.js`, `background.js`, `seller_content.js`; без новых runtime owners и зависимостей.
- Decision: code-change.

# Existence / Architecture Integrity

- Proposed new surface: новый режим выбора и новый storage/message key.
- Existing reuse candidate: текущие prompt settings, `requestDeepSeekCompletion`, `ozonReplyTemplates`, `sendSingleReply` и question AI mode.
- Creation proof: отдельный review prompt нужен для независимой инструкции и не должен переиспользовать prompt вопросов или текстовый шаблон.
- Verdict: reuse existing owners; add only the new key/action and local branches.
- Retirement: нет старого review-AI пути; если он появится, `deepseekReviewPrompt` и `deepseek_generate_review_answer` остаются canonical owner.

# Verification

1. `node --check OzonPriceTracker/background.js`, `node --check OzonPriceTracker/popup.js`, `node --check OzonPriceTracker/seller_content.js`.
2. Parse `OzonPriceTracker/manifest.json` and ensure the existing DeepSeek host permission remains present.
3. `git diff --check` and read back the final diff.
4. Contract search confirms `deepseekReviewPrompt` is loaded, saved and read by background; `deepseek_generate_review_answer` is sent by seller content and handled by background; `deepseek_ai` is offered by row and bulk review selectors.
5. Live Ozon Seller/DeepSeek behavior remains unverified until the unpacked extension is reloaded and a real review is selected; no live sale/reply is performed in this turn.

# Risks / Retirement

- Ozon Seller DOM selectors can change; the feature reuses the existing review form selectors and inherits that known risk.
- DeepSeek API key, quota, network and generated text quality are runtime risks; errors keep the current row failed and do not silently send an empty response.
- The existing dirty worktree is preserved; no commit, reload, external POST or deployment is authorized by this request.
