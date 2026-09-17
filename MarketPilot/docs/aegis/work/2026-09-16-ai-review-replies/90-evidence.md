# Evidence Bundle Draft

## Fresh checks

- `node --check MarketPilot/background.js` — passed.
- `node --check MarketPilot/popup.js` — passed.
- `node --check MarketPilot/seller_content.js` — passed.
- Node manifest parse with DeepSeek host assertion — passed (`manifest ok`).
- Static contract assertions — passed (`contract checks ok`).
- Mock service-worker smoke — passed (`review handler smoke ok`); custom prompt replacement and empty-review no-request behavior were verified without network access.
- `git diff --check` — passed; only line-ending normalization warnings for pre-existing files were reported.

## Covered scope

- Popup field id, storage key, default/reset/autosave/save/load wiring.
- Background message action, review prompt lookup/replacement, context message and existing completion helper.
- Seller row and bulk AI selectors plus review generation call before form submission.
- Existing DeepSeek host permission retained.

## Uncovered scope

- No real DeepSeek API request was made.
- No unpacked Chrome extension reload was performed.
- No live Ozon Seller review was opened, generated, submitted or visually checked.
- Existing Ozon DOM selector fragility remains a runtime risk.

Confidence: B for the implemented contract and static/mock behavior; live UI confidence is not claimed.
