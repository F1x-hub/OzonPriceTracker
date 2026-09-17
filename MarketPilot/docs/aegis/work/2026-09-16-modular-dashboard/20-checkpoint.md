# Checkpoint

Current todo: reload the unpacked extension in a normal Chrome session, then run the remaining Ozon/Citilink/service-worker/AI/export checks.

Completed: baseline readback and target inventory; marketplace registry and storage bridge; compact popup and dashboard UI; direct Ozon URL tracking form; separate WB/Citilink article forms; dedicated dashboard «Сбор» route with result tables; manifest wiring; persisted WB/Citilink job metadata in the existing status contract; durable price-check status and manual/alarm duplicate guard; serialized tracking/history writes, DeepSeek stats and legacy popup command migration; stale job reconciliation on browser startup; duplicate collection launch guard; Seller route cleanup and explicit unknown submission state for question bulk actions; Seller DOM/lifecycle helper split; Citilink collection separated from optional description generation with a dashboard toggle; lazy XLSX export with Avito image URLs; schema migration, settings allowlist and collection-clear ownership; target-price editing and long prompts in dashboard; responsive/hidden/ARIA fixes; Ozon/WB message adapters with no-price failures; legacy tracked-item DOM rendering; repeatable npm check/test/build.

Active slice: static implementation closeout with legacy compatibility; the available live read-only pass is recorded below.

Evidence refs: parent plan sections 3, 4, 6, 8.1–8.4; current manifest and popup/background sources.

Blocked on: live Chrome extension reload and current marketplace DOM behavior; automatic resume is intentionally not implemented.

Next: reload the generated unpacked extension and perform the remaining popup/dashboard/marketplace/Seller/export checks.

Drift check: continue. Ozon `.com` host support was added after observing a live `.ru` redirect. Seller reviews/questions mounted in live Chrome; Citilink and extension-internal reload/inspection were blocked by browser policy. No write, send, AI, or export action was triggered. Evidence: 90-evidence.md.
