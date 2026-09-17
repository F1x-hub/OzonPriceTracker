# Intent

Goal: execute first vertical slice of `docs/aegis/plans/2026-09-16-modular-dashboard-redesign.md`.

Scope: add modular marketplace metadata and storage command boundary; replace manifest popup with a compact context surface; add a dashboard extension page for tracking, jobs, history, target-price editing, long AI prompts and settings; add schema migration and a repeatable static toolchain.

Non-goals: remove legacy popup logic, migrate all Seller features, add new marketplace permissions, publish, commit, or run live marketplace mutations.

Baseline refs: `MarketPilot/docs/aegis/plans/2026-09-16-modular-dashboard-redesign.md`, `MarketPilot/manifest.json`, existing popup/content/background files, `.agents/rules/agent.md`.

Change Necessity: existing popup cannot provide a compact context action while also containing six feature areas; a new entrypoint and dashboard are required. Minimum boundary: new extension UI modules, marketplace registry, storage command handlers, manifest action target.

Compatibility: retain all legacy files and storage keys. New UI reads existing `trackedItems`, `wbStatus`, `citilinkStatus`, `notificationHistory`, `deepseek*` keys plus the additive `priceCheckStatus` job snapshot. Legacy content scripts remain active.

TDD Route: Mode off; Decision skipped. Verification uses npm check/test/build, node syntax checks, manifest parse, diff check and targeted VM contracts; live Chrome/marketplace tests remain deferred.

Execution Readiness View: present in parent plan; this slice matches intent, scope fence, compatibility boundary and first vertical-slice gate. Full browser and live-site checks remain open.
