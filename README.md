# Ozon Controller

Мониторинг цен на товары Ozon.ru и Wildberries.

## Changelog

### [1.0.3]

### Features
- Add DeepSeek AI integration for Ozon question answering.
- Add AI Questions tab with API key validation in popup.
- Add balance dashboard with currency conversion and token stats.
- Add system prompt editor with variable placeholders chips.
- Add AI assistant card to Ozon question drawer.
- Add batch answering mode for selected table questions.
- Add response mode selector to question table headers and rows.
- Add auto-save for system prompt on blur and input.

### Fixes
- Fix AI buttons to prevent auto-send on generate click.
- Fix modal drawer parser with exact Ozon Seller selectors.
- Fix plain-text formatting by cleaning Markdown syntax from AI.
- Fix variable replacement for product, brand, SKU and question.
- Fix question selection by disabling answered row checkboxes.
- Fix DeepSeek API requests with abort signal network timeouts.
- Fix cost calculation with distinct rates for DeepSeek R1.
