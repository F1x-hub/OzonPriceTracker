# Initial Baseline — 2026-09-16

- Project: Chrome MV3 extension in `OzonPriceTracker`.
- AI gateway: DeepSeek requests are owned by `background.js` and share token/cost statistics.
- AI settings: `popup.html`/`popup.js` already store question and Citilink prompts.
- Review flow: `seller_content.js` already selects text templates and sends replies through `#AnswerCommentForm`.
- Existing worktree state before this task: unrelated dirty changes in `background.js`, `manifest.json`, `popup.css`, `popup.html`, `popup.js`, and untracked `citilink_content.js`; preserved.
- Test harness: no package/test configuration discovered; verification uses Node syntax checks, mock service-worker smoke, contract assertions and diff checks.
