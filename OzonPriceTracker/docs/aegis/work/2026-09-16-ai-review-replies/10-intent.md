# Task Intent Draft

Requested outcome: add AI-generated replies for Ozon Seller reviews and let the user configure a dedicated review prompt in the AI settings and select AI mode in reviews.

Scope: popup AI settings, DeepSeek service-worker handler, review row/bulk selectors, review generation and existing review form submission.

Non-goals: changing existing text templates, changing question answering behavior, changing Ozon API endpoints, enabling unattended auto-send, or touching unrelated dirty-worktree features.

BaselineReadSetHint: `.agents/rules/agent.md`, `popup.html`, `popup.js`, `background.js`, `seller_content.js`, `manifest.json`.

BaselineUsageDraft:
- Required baseline refs: project rules and the five implementation files listed above.
- Acknowledged before plan refs: `.agents/rules/agent.md`, `popup.html`, `popup.js`, `background.js`, `seller_content.js`.
- Cited in plan refs: all required refs are cited in the plan's Baseline / Authority Refs section.
- Missing refs: no package/test configuration exists in the project root.
- Decision: continue.

ImpactStatementDraft: adds one local storage setting, one runtime message action, and one explicit review-selection mode; preserves current template and question paths.

Execution Readiness View:
- Intent Lock: AI review replies use a separately editable saved prompt.
- Scope Fence: only popup, background gateway and seller review code inside `OzonPriceTracker`.
- Baseline Lock: existing dirty changes stay untouched; existing DeepSeek completion helper is canonical.
- Approved Behavior: select `✨ DeepSeek AI`, generate a reply from product/review/date context, insert it, then use the existing explicit send flow.
- Owner / Contract Constraints: popup owns storage UI; background owns DeepSeek; seller content owns Ozon DOM interaction.
- Compatibility Boundary: old prompt/template/question modes continue working.
- Retirement Boundary: no old review-AI path exists; no fallback beyond built-in default prompt.
- Test Obligations: JS syntax, manifest parse, diff whitespace and message/storage contract checks.
- Review Gates: read final diff and report live Ozon verification separately.
- Drift / Rewind Rules: if current dirty edits overlap a target branch, preserve them and narrow the patch.
- Evidence Required Before Completion: fresh command outputs plus final diff readback.
- Advisory Boundary: this is an execution guide, not an authoritative runtime gate.

Current todo:
1. Add and persist the dedicated review prompt in popup.
2. Add the DeepSeek review-generation action in background.
3. Add AI selection and generation to the reviews flow.
4. Run focused static/contract verification and inspect the diff.

Active slice: popup settings and shared prompt contract.
Completed todos: baseline and task-start snapshot.
Blocked-on: none.
Next step: patch popup markup and settings logic.
