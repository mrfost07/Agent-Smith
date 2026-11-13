# Trade flow investigation — 2026-11-13

Reviewed shared session: https://chatgpt.com/s/cx_6af6d107eb8c81918affa8fe71bc2e3f

The shared snapshot ends during the `prepare_trade` changes, without a completed final verification. Earlier successful tests did not establish that the actual terminal matched the adapter.

## Confirmed causes

- The chart path used regex matches to decide whether to prepare an order. A semantic planner could choose chart analysis but had no dedicated order-preparation action. Phrases such as “use the browser and trade” and a later delegation of direction could lose the order portion of the task.
- Account detection required selected/checked ARIA state. The observed account header has two disabled `role=switch` labels with no checked state, and indicates the active account with a translated background marker.
- The order targets are focusable divs with glyphs and payout percentages. Their internal test IDs are reversed relative to the visible BUY/SELL text.
- Investment and expiry are custom controls with adjacent value/label children. Expiry is labeled “auto close”; the investment includes a left-to-right mark. The old field reader missed them.
- Mock terminal responses bypassed these DOM differences. The old directionless-order test even expected the clarification the user reported as a failure.

## Changes and evidence

- Added `prepare_trade` to both initial routing and browser planning, with a dedicated handoff that checks the currently active platform. Hypothetical questions, explicit exclusions, and generic continuation commands cannot use it to authorize another demo order.
- Kept supported direct requests on the chart/order workflow, while ordinary browser requests on other sites retain general planning.
- Chart-directed demo preparation now asks for a direction or a concrete no-trade reason, with one bounded retry for a missing decision. The chart prompt delegates execution status to the application.
- Added a fallback for the observed account-header marker. It must fit inside exactly one labeled account segment. Missing or intermediate markers remain unknown. Fields and input targets are read again immediately before an approved click.
- Added a DOM fixture using actual observed structural markup and simulated geometry. Tests verify reversed IDs, Demo/Real transitions, ambiguity, missing marker, changed amount, and button obstruction. Linkedom is a development-only dependency.
- Added regressions for the reported phrases, browser-planner handoff, neutral decisions, and explicit no-order instructions. Existing tests still cover duplicate approval, changed expiry, changed asset, unsupported platforms, analysis-only requests, and unrelated browser tasks.
- Full `npm test`, `tsc --noEmit`, and `npm run build` passed.
- A read-only probe ran the updated adapter in the live ExpertOption page and returned Demo, AI Index, $500, 00:00:05, and both direction targets. No click or order submission was included.

## Remaining limits

- The new build's full model-to-proposal interaction has not been verified live. Reload attempts were interrupted twice by detected user input; automatic UI work stopped rather than compete with the user.
- Order acceptance is not verified automatically. The current submission response reports input dispatch and asks the user to inspect demo history; a successful click is not evidence of an accepted order.
- Only ExpertOption has an order adapter. Chart reading is broader. This change does not add other broker integrations or real-money order execution.
- A screenshot-based directional proposal is not a backtest or a proven strategy. Numerical Kraken/CSV analysis is a separate workflow. The terminal's amount and expiry are shown for review, not dynamically rewritten from arbitrary prose.
- Natural-language selection still depends on the chosen model. Regression tests supply model responses; they verify dispatch and constraints, not universal language comprehension. Future terminal markup changes can require adapter updates.
