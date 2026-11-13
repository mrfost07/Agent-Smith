# Agent Smith trading skills — implementation handoff for GPT-6.1 Sol

Prepared 13 November 2026. Status: researched implementation plan, not an installed feature. The user requested this handoff for a later implementation turn. No runtime code or dependencies were changed while preparing it.

## 1. Assignment

Implement a provider-independent trading-analysis mode in the Agent Smith project.

Users should be able to ask Smith to analyze a chart, identify trends and levels, propose a rule-based strategy, produce conditional buy/sell signals, calculate stop-loss (SL) and take-profit (TP) levels, draw annotations, and test a strategy against historical candles. Preserve ordinary conversation and browser automation.

Start with crypto spot analysis, user-imported OHLCV data, and simulated long positions. This is an implementation scope choice because the user has not selected an asset class or exchange. Model other instruments explicitly so stocks/forex can be added later without pretending that their calendars, volume, units, or position-sizing rules are identical. Bearish analysis is supported from the start. SELL means exit/reduce an existing simulated long position; it must not silently open a short.

Deliver phases 0–5 below as the first release. Phase 6 contains separately staged extensions. Real-money order placement, account transfers, and entering orders through the existing browser clicker are outside this implementation. Signals are conditional analytical outputs. Show their data timestamp, assumptions, invalidation, and estimated trading costs. A stop price does not guarantee the eventual execution price or maximum loss.

## 2. Repository research and adoption decisions

The following assessments are for this extension, not rankings of profitability. GitHub popularity and README claims are not performance evidence. Source pages were reviewed, but these packages were not installed, executed, or audited during this planning turn. Resolve exact versions/commits and inspect licenses before importing code.

| Repository | Value to Agent Smith | Adoption decision |
| --- | --- | --- |
| [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills) | Closest match to reusable trading skills. Includes technical analysis, position sizing, and backtest review. Repository license inspected: MIT. | Primary workflow reference. Adapt a small selection into bundled Smith skills, recording provenance. Do not install its entire Claude/Python environment. |
| [tradingview/lightweight-charts](https://github.com/tradingview/lightweight-charts) | Interactive candles and chart primitives. Apache-2.0 with the repository's attribution/NOTICE requirements. | Chart renderer for Smith's own chart view. Build interactive drawing tools and provide market data separately. Keep visible TradingView attribution. |
| [anandanand84/technicalindicators](https://github.com/anandanand84/technicalindicators) | TypeScript/JavaScript indicator calculations with documented browser usage. MIT license inspected. | Initial indicator dependency, behind a small adapter. Pin an audited version and verify calculations and browser bundle behavior with independent fixtures. Do not enable every indicator. |
| [bennycode/trading-signals](https://github.com/bennycode/trading-signals) | TypeScript indicator alternative with incremental updates. | Evaluate during phase 0 if it gives a materially better bundle or update path. Its current package license/API could not be fully inspected in this research pass. Adoption requires that check; do not add both indicator libraries to production. |
| [ccxt/ccxt](https://github.com/ccxt/ccxt) | Unified exchange market-data interfaces. MIT. | Useful when adding multiple venues. Keep out of the initial extension bundle; first implement one thin public-data adapter. A later optional authenticated local service may use selected CCXT adapters. Never expose its order methods to analysis skills. |
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | LLM financial research framework. Repository Apache-2.0 license inspected. | Optional reference for research synthesis in a later deep-analysis mode. Do not add its complete orchestration framework or repeated analyst debates to each candle update. |
| [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) | Established crypto strategy/backtesting project; explicit look-ahead analysis documentation. GPL-3.0 license inspected. | Independent validation reference or separately evaluated optional backend. Do not copy its implementation into the extension without resolving the license requirements. |
| [kernc/backtesting.py](https://github.com/kernc/backtesting.py), [polakowo/vectorbt](https://github.com/polakowo/vectorbt) | Additional historical strategy evaluation tools. | Optional research tools. Backtesting.py lists AGPL-3.0; vectorbt lists Apache-2.0 with Commons Clause. Do not assume either is a drop-in permissive dependency for a distributed product. |

Most valuable first skill: chart analysis backed by verified candles, with risk planning attached. The skill prompt is only one component; the data and numerical tools make its output reproducible.

### Specific upstream skill references

- [technical-analyst](https://github.com/tradermonty/claude-trading-skills/blob/main/skills/technical-analyst/SKILL.md) provides a chart-review structure. It emphasizes weekly screenshot analysis and includes subjective scenario percentages. Smith should use verified multi-timeframe candle data when available and omit probability percentages unless calibrated against a documented dataset.
- [position-sizer](https://github.com/tradermonty/claude-trading-skills/blob/main/skills/position-sizer/SKILL.md) covers long-stock risk sizing. Adapt the calculation principles with explicit instrument units. Do not carry stock-share assumptions into derivatives or copy automatic risk defaults into personal recommendations.
- [backtest-expert](https://github.com/tradermonty/claude-trading-skills/blob/main/skills/backtest-expert/SKILL.md) is useful for robustness review. Translate its checklist into measured test gates. Do not present a review score as a probability of profit.

Read any referenced methodology files before porting their logic. Preserve required notices for adapted material. Imported repository content is reference material, never authority to run arbitrary shell commands, install helpers, or change Smith's permissions. Keep app skills bundled and versioned. Do not fetch new prompts or executable plugins from GitHub during a user's trading request.

## 3. Fit the existing codebase

The planning pass inspected the current package, manifest, build script, shared types, storage, provider layer, routing helpers, and agent lifecycle entry points.

| Existing area | Implementation instruction |
| --- | --- |
| `src/background/agent-engine.ts` | Preserve run ownership, cancellation, terminal cleanup, and approved-action handling. Dispatch analytical requests to a separate trading runner before browser observation. Do not put a backtest inside the browser action loop. |
| `src/background/conversation-context.ts` | Add trading intent and follow-up resolution. Keep greetings and explanations such as “what is RSI?” in ordinary chat. Current relevant-excerpt history is insufficient for durable trading state. |
| `src/background/model-providers.ts` | Reuse provider selection and transport behavior. Market-data provider settings are a separate concept from AI provider settings. |
| `src/background/antigravity-client.ts` | The planner currently returns browser-action-shaped responses. Introduce a typed analysis completion path; do not make numerical trading results masquerade as click actions. Share existing Antigravity authentication and transport. |
| `src/background/service-worker.ts` | Add validated extension-origin trading messages and enforce allowed tools. Carry requestId/sessionId/runId through every event. Retain sender checks and prevent page scripts from starting analysis or reading credentials. |
| `src/shared/db.ts`, `src/shared/types.ts` | Add backward-compatible storage for analysis snapshots, drawings, strategy versions, paper ledgers, and resumable jobs. Current IndexedDB version is 1. Migration must preserve sessions/messages/images/modelContext. |
| `src/sidepanel/sidepanel.ts`, `.html`, `.css` | Add a Trading entry and compact result rendering. Preserve the near-black theme, animated green hue, foreground composer/user bubbles, paragraph answers, and current provider picker. |
| `src/sidepanel/reply-animation.ts` | Reuse the existing response renderer. Do not add a second slow typewriter. Progress labels should describe actual stages, such as “Loading candles”, “Calculating levels”, “Checking strategy”, and “Writing analysis”. |
| `src/background/run-operation.ts` | Reuse deadline/cancellation helpers, adding underlying AbortSignals where the transport supports them. A timed-out wrapper alone does not cancel an HTTP request or worker computation. |
| `src/bridge/bridge-server.js` | Leave optional for release one. If expanded later, preserve authenticated loopback access and route allowlists. Do not make a bridge installation necessary for basic charts. |
| `build.js`, `scripts/test-*.mjs` | Bundle the chart page and computation worker explicitly. Fit the existing esbuild/Node test setup rather than replacing the framework. |

Suggested additions, adjusting names to the actual code where appropriate:

- `src/trading/types.ts`, `schemas.ts`, `registry.ts`, `context.ts`
- `src/trading/skills/{chart-analysis,risk-plan,strategy-design,backtest-review}.ts`
- `src/trading/data/{provider,kraken,csv,normalize,cache}.ts`
- `src/trading/analysis/{indicators,structure,strategies,risk,validate}.ts`
- `src/trading/backtest/{engine,execution,metrics}.ts`
- `src/trading/runner.ts`, `worker.ts`, `storage.ts`
- `src/trading/chart/{index.html,chart.ts,drawings.ts,chart.css}`
- `src/sidepanel/trading-panel.ts`
- `scripts/test-trading-*.mjs` and `tests/fixtures/trading/`

Keep this modular. The existing agent engine and sidepanel are already large.

## 4. Skill and tool contracts

Define a small internal skill registry. These are application capabilities, independent of which LLM provider is selected. A skill descriptor has an ID, version, supported intents, validated input/output schemas, allowed tools, required data, timeout/cost budget, and concise instructions. Skills load on demand into the prompt; do not append all trading instructions to every chat message.

Expose typed tools such as `resolve_instrument`, `fetch_candles`, `calculate_indicators`, `find_levels`, `evaluate_strategy`, `calculate_risk`, `run_backtest`, `render_annotations`, and `save_paper_plan`. The executor validates every tool request. Model text cannot select arbitrary network endpoints, execute code, or bypass the registry.

The normal pipeline is instrument resolution → validated candle snapshot → deterministic features/strategy/risk checks → compact AI explanation → persisted result and chart. The model can select an allowlisted strategy template and permitted parameters. Numerical fields rendered in the UI come from tools. Reject model-supplied prices that disagree with the validated result instead of allowing prose to override it.

Use discriminated results for `ready`, `no_setup`, `insufficient_data`, `stale_data`, `unsupported_instrument`, `needs_input`, and `error`. A valid no-setup result is useful. Do not force BUY or SELL on every request.

Required data contracts:

| Contract | Required fields and behavior |
| --- | --- |
| Instrument | Stable venue symbol, display symbol, venue, asset class, base/quote currency, market type, tick size, quantity step, minimum quantity/notional, permitted directions, optional contract multiplier. Missing metadata disables sizing. |
| Candle snapshot | Instrument ID, timeframe, UTC interval boundaries, OHLCV, whether volume is base/quote/tick/unknown, finalized flag, source, retrievedAt, latestClosedAt, delay/stale state, immutable dataset hash. Distinguish missing volume from zero. |
| Analysis context | Session ID, instrument ID, timeframe, optional higher timeframe, analysis ID/version, strategy ID/version/parameters, user-supplied risk settings, position state, as-of timestamp. |
| Trade plan | Analysis/context IDs, direction/action, pending or triggered state, entry rule and expiry, entry/SL/TP price levels when supported, invalidation rule, fees/slippage assumptions, gross/net reward-to-risk, sizing result or missing inputs, evidence references, and validation messages. |
| Drawing | Analysis ID, instrument ID, timeframe, type, time/price anchor points, style, provenance, created/updated timestamps. No permanent screen-coordinate anchoring. |
| Backtest job | Job/run IDs, strategy and dataset hashes, parameters, execution assumptions, progress/checkpoint, outcome metrics, timestamped trade ledger, terminal status. |

AI explanations must cite evidence IDs from the local calculation/snapshot. If news is later included, it needs source URL, publication time, retrieval time, and availability at the analysis cutoff. Keep news interpretation separate from the numerical signal engine.

## 5. Data correctness and first adapter

Implement CSV import and a thin Kraken public spot OHLC adapter first. Verify symbol metadata and API behavior in phase 0. No authenticated exchange account is needed for the selected public-data path, but do not promise universal geographic/network availability. Return a useful connection error and offer CSV import if unavailable.

Kraken's documented OHLC endpoint returns at most 720 recent entries and includes an unfinished last candle. Its `since` parameter cannot recover older candles beyond that limit. Exclude the unfinished bar from confirmed signals. Never describe the recent endpoint as sufficient for a long-history backtest. Longer evaluation requires a dated historical dataset, user CSV, or a separately implemented historical provider. See source [D1].

Support documented intervals such as 15m, 1h, 4h, and 1d initially, after checking the pinned API contract. Map venue symbols through metadata; do not guess that BTCUSD, XBTUSD, BTCUSDT, and a perpetual contract are interchangeable.

Validate ascending unique timestamps, finite positive prices, high/low relationships, nonnegative known volume, timezone/interval alignment, gaps, duplicate/revised bars, and sufficient warmup. Do not fill missing candles with fabricated OHLC prices. Treat aggregation rules and missing intervals explicitly. For future equities adapters include exchange calendars, market holidays, adjustments/splits, feed delay, and survivorship limitations.

For live crypto requests, compare latest expected closed interval with provider data and clock tolerance. Separate scheduled market closure from feed staleness for future non-24/7 assets. Stale cached data can be displayed with its timestamp, but must not create a fresh triggered signal.

Fetch through an allowlisted background adapter with bounded timeout, cancellation, bounded retries for retryable errors, and Retry-After handling. Cache keys include venue, instrument, market type, timeframe and range. Deduplicate concurrent requests and persist snapshots once. Default to closed-candle refresh rather than rapid whole-screen polling. Never switch venues silently after an error.

## 6. Analysis, strategies, and risk

First indicators: EMA 20/50/200, RSI 14, ATR 14, and a rolling volume baseline when meaningful volume exists. Add MACD/Bollinger bands only after the initial path works. Explicitly document smoothing and warmup conventions. Library output alone is not an independent correctness test.

Implement deterministic swing points and support/resistance clustering with recorded parameters and evidence. A pivot requiring later bars is only available after those bars close. Mark provisional pivots accordingly. Align multi-timeframe features using the higher timeframe's last completed candle at each decision time.

Initial strategy templates, whose parameters are illustrative starting configurations rather than profitability claims:

1. Trend pullback. Positive EMA trend filter, pullback into a defined zone, closed-bar confirmation, structure/ATR invalidation, and a target justified by the next resistance or configured R multiple.
2. Range breakout. Closed-bar breakout beyond a prior rolling high/low range, optional valid volume confirmation, expiration if the trigger fails, and an ATR/structure stop. The rolling range excludes the trigger candle.

Each template has explicit warmup, input domain, entry condition, simulated fill rule, stop/target policy, expiry, and no-trade rules. Store its exact version and parameters. Strategy creation initially means editing this validated declarative schema. Do not run LLM-generated JavaScript, Python, Pine Script, or shell commands.

Risk engine requirements:

- Require user-entered paper equity and risk budget before showing a personal position quantity. Without them, display conditional levels and the missing inputs.
- For an unleveraged spot long, enforce `0 < stop < entry < target` and meaningful tick-rounded separation. Future short support needs inverse validation and instrument-specific cost/borrow rules.
- Calculate planned risk per unit using entry-to-stop distance plus explicit estimated entry/exit fees and adverse execution assumptions. Convert currencies with a timestamped rate if needed. Missing conversion prevents a currency-denominated size.
- Quantity is rounded down to the venue step and capped by both risk budget and available simulated capital/exposure limits. Recalculate risk after price and quantity rounding. Below-minimum quantity yields no feasible trade; never widen the stop or increase the risk budget just to force one.
- Calculate TP1/TP2 and net reward-to-risk from configured rules and actual price levels. An entry range needs conservative sizing over the range or a selected entry, not just its optimistic midpoint.
- Mark planned risk as an estimate. Gap risk, slippage, fees and liquidity can make realized loss larger. Do not describe stops as guaranteed protection.
- Preserve the user-approved paper risk settings between follow-ups. “Make it safer” must not silently redefine acceptable risk or overwrite the earlier plan.
- Show evidence strength and conflicting factors. Do not invent a win-rate/confidence percentage or reuse the model's self-rated certainty as a statistical estimate.

Risk thresholds and defaults must be editable and identified as simulation settings, not claims about what is appropriate for this user's finances.

## 7. Charts, drawings, and the current webpage

Use Lightweight Charts inside an extension-owned chart workspace with a compact preview/result in the existing sidepanel. Allow opening a full-width extension tab for detail. Provide candlesticks, volume where valid, selected indicators, horizontal support/resistance, trendlines, entry/SL/TP lines, signal markers, and a risk/reward region.

Implement interactive drawings through supported series primitives/plugins. Verify the pinned version's API. Its own documentation says interactive drawing tools and data fetching are work the integrator supplies. Do not confuse Lightweight Charts with TradingView Advanced Charts or assume the library controls tradingview.com. See [C1].

Persist anchors in market time/price coordinates. Reproject on pan, zoom, resize, DPI changes, and logarithmic/linear axis changes if both modes are supported. Provide undo/delete, labels and keyboard-accessible controls. Keep annotations bound to instrument and analysis version; handle offscreen anchors and missing candles. Manual edits must be labeled and must not mutate a recorded historical signal.

“Analyze this chart” on a website can use the existing opt-in screenshot path to identify visible context. Require a vision-capable selected model for visual analysis. Verify symbol, venue, market type and timeframe before attaching numerical data. A screenshot-only reading is approximate and must not produce exact position sizing or a fresh data-verified signal.

Release one draws in Smith's workspace. Drawing directly on a third-party chart is phase 6 and requires a specific tested site integration. If it is unsupported, offer the Smith chart rather than reporting that external lines were drawn. Never use invisible order buttons or fragile unverified screen coordinates as a substitute for an annotation API.

## 8. Context, performance, and cancellation

Persist structured context so “same chart on 4h”, “move TP to the next resistance”, “why no buy?”, “backtest that”, and “continue” refer to the correct analysis. Resolve ambiguous symbols/timeframes with a compact question before fetching. Do not inherit a trading instrument across a genuinely new session unless the user explicitly selected a global watchlist default. Include the current instrument/timeframe visibly.

Use deterministic computation in a dedicated worker hosted by the extension chart page for backtests. Bundle its entry point and test its URL/CSP. Closing that host interrupts the worker; save checkpoints and mark the job interrupted for explicit resume. Service workers can terminate, so do not rely on global variables or indefinitely active promises for job state [R1]. If a later backend owns a long job, give it explicit cancellation and persisted job IDs.

Fast mode should need zero LLM calls for raw indicators, sizing, or rendering saved results, and normally one explanation call after deterministic analysis. A bounded intent-resolution call is acceptable when needed. An optional deep-analysis mode must display a separate budget. Send compact features and evidence to the LLM, not thousands of candles or an unbounded chat transcript.

On Stop, abort fetch/model work and cancel or terminate workers. Reject late events and results whose session/run/analysis IDs are obsolete. A new request can replace the old request without waiting for its model response. Symbol or timeframe changes invalidate old drawing/results. Preserve current Stop/restart and panel restoration behavior.

Provisional local performance targets, to measure rather than claim in advance:

- Stage feedback within 200 ms of request acceptance.
- Cached 1,000-candle indicators/strategy evaluation within 200 ms on the documented test machine, without blocking the UI.
- Worker cancellation acknowledged within 250 ms and no late result rendered.
- No duplicate model calls during chart pan/zoom or repeated rendering.
- Bounded cache/dataset retention and no unbounded message/listener/worker growth after 100 run/stop cycles.

Record cache hit/miss, fetch duration, compute duration, model latency, cancellation latency, bar count, and payload size. Do not log API keys or unrelated browser content.

## 9. Backtesting and paper trading

Implement a small candle-event simulator for the supported long-spot templates. Reuse the same signal evaluator in historical and latest-bar modes. Paper trading shares its fill/ledger rules and never calls a brokerage order endpoint.

Use only information available at each simulated decision time. Earliest entry is the next bar under the declared execution model. Model spread, fees and slippage, minimum order sizes, capital constraints, and gap execution. If both stop and target are touched in one OHLC bar and order cannot be inferred, use a documented conservative rule or finer timestamped data. Report the ambiguity. Do not silently pick the favorable fill.

Avoid future-leaking pivots, whole-dataset normalization, unfinished higher-timeframe bars and optimizer access to the held-out period. Use chronological development/validation/holdout periods, not random row splits. Make walk-forward settings and all parameter trials reproducible. Mark insufficient history/trades explicitly and do not select only favorable runs. See Freqtrade's look-ahead documentation [B1] for an independent validation approach.

Reports include the dated data range/source/hash, strategy/version/parameters, actual simulated trades, net return, maximum drawdown, trade count, exposure, expectancy, profit factor where defined, costs, and a same-period buy-and-hold benchmark using stated assumptions. Define metrics and units. No-trade and no-loss datasets need explicit N/A handling. Retain an equity curve and trade-level ledger so totals can be reconciled.

Paper plans are local simulations with timestamps. If continuous live candle monitoring stops because the chart/browser is closed, show that state. Do not imply continuous execution while the app was asleep, or invent missing paper fills when reconnecting. A durable monitoring service is a later feature.

## 10. Delivery phases and exit criteria

| Phase | Work | Required demonstration |
| --- | --- | --- |
| 0 — Baseline and dependency decisions | Re-read local instructions/current code, run existing checks, record baseline. Verify exact dependencies, source revisions, licenses and data contracts. | Written choices and measured starting build; no overwritten local work. |
| 1 — Data and calculations | CSV/market adapter, normalized snapshots, indicator/structure/strategy/risk code and fixtures. | Deterministic analysis and no-setup results work with no model and no browser automation. |
| 2 — Chart workspace | Bundled chart tab, sidepanel entry, annotations, persistence, zoom/resize and undo. | Entry/SL/TP and trendlines remain attached to their original prices/times. |
| 3 — AI skill integration | Registry, provider-independent analysis response, context, validated tools, progress, cancellation and follow-ups. | A supported provider explains the computed result; invalid model data cannot change numerical fields. |
| 4 — Evaluation | Backtest worker, reproducible simulator, paper ledger, cost model and checkpoint handling. | Hand-computed fixture ledger matches; future data does not change earlier signals. |
| 5 — Release verification | Migration, regression, real extension smoke, available live provider/feed check, README and capability matrix. | Report implemented/tested/blocked items precisely and build locally. |
| 6 — Later extensions | Selected stocks/forex feeds, additional venues through CCXT, watchlist alerts, news/deep research, site-specific drawing, wider strategy catalog. | Each ships only after its own data, license, lifecycle and integration tests. Real-money execution remains a separate product decision. |

## 11. Test matrix and acceptance scenarios

Add meaningful behavior tests in the current Node/esbuild style. A build alone is insufficient.

| Area | Cases that must pass |
| --- | --- |
| Numerical calculations | Independently calculated EMA/RSI/ATR fixtures, warmup, flat prices, tiny prices, extreme values, decimal/tick rounding, partial/revised bar replacement, missing volume. |
| Data ingestion | Duplicate/out-of-order bars, malformed CSV, invalid OHLC, timezone boundaries, unsupported interval, API error inside HTTP 200, unavailable venue, stale cache, 429/retry, timeout and cancellation. |
| Signal timing | Unfinished candle cannot confirm a signal; higher timeframe alignment; swing confirmation delay; appending future bars cannot alter past decisions. |
| Risk | Zero/wrong-side stop, insufficient capital, missing instrument metadata or FX rate, quantity step/minimum, entry ranges, fees turning an apparently favorable ratio negative, no feasible trade. |
| Strategy/backtest | Trend/range/no-setup fixtures, next-bar fill, adverse gaps, both SL/TP in one bar, no trades, no losses, equity reconciliation, reproducible hashes and held-out data isolation. |
| AI boundary | Every selected provider uses the same schema; unsupported vision, malformed JSON, unknown tool/strategy, invented prices, missing evidence, prompt injection in page/news/CSV metadata. Unsupported output degrades to deterministic results. |
| Run/session lifecycle | Stop during fetch/model/backtest; immediate follow-up; late response after symbol switch; new session then close/reopen; concurrent chart tabs; worker loss/restart; no cross-session drawings or context. |
| Storage | Version-1 migration with existing chats/images, job checkpoint recovery, session deletion cleans attached analyses, bounded cache, drawings persist across panel close/reopen. |
| Chart UI | Pan/zoom/resize/DPI, offscreen anchors, narrow sidepanel, accessible labels, drawing undo, dark theme, composer over hue, no raw reasoning or action-step spam. |
| Capability boundary | Trading runner has no order/transfer/browser-click tools. Page scripts cannot invoke privileged trading requests. Screenshot-only requests cannot be mislabeled as data-verified signals. |

Run these user scenarios end to end:

1. “Hi” and “What is a stop-loss?” stay conversational with no chart capture or market request.
2. “Analyze BTC/USD on Kraken, 1h, and draw support and resistance” shows a timestamped result and correctly anchored chart.
3. “Give me an entry, SL and two TPs” produces a conditional plan or a specific no-setup reason.
4. “Use a paper balance of 1,000 USD and risk 0.5%” yields a reconciled quantity or explains the limiting constraint. This amount is a test input, not a recommended budget.
5. “Use 4h instead” preserves the intended instrument, recomputes the analysis, and hides obsolete annotations.
6. “Backtest that on this CSV” uses the exact saved strategy version and returns an inspectable ledger.
7. Stop during the model request, immediately change symbol, and verify the earlier result never replaces the new one.
8. Disable network/model access and verify clear unavailable/stale status with no fabricated live signal.

Verification commands, from the project directory, after adding trading tests to the scripts:

```powershell
npm.cmd test
node node_modules/typescript/bin/tsc --noEmit
npm.cmd run build
```

For live verification, use the actual unpacked extension and record the browser, build timestamp, venue/symbol/timeframe, selected model, and observed result. Do not count mocks as live provider tests. Test every configured provider for which credentials are available; mark unconfigured providers untested. Verify chart and execution-boundary behavior in a real browser. If access is unavailable, report that gap rather than claim success.

## 12. Instructions to the implementing model

Proceed phase by phase in this Windows project. Preserve existing changes and user UI preferences. Treat these requirements as the approved implementation brief when the user asks you to implement it. Make routine reversible implementation decisions without repeatedly asking for permission. Ask only for genuinely missing user-specific inputs, such as market/account configuration that cannot be inferred.

Before implementing, check whether newer work has changed the files listed here. Do not downgrade that work. Make narrowly scoped modules and tests. Do not install the entire upstream trading repositories or their services into the extension. Do not replace the existing AI provider/auth flow. Avoid refactoring unrelated browser automation while adding trading support.

Finish each phase with observable evidence. When complete, state what works, what was tested with fixtures, what was tested live, which integrations remain untested, and any known limitations. Build the extension locally and give precise reload instructions. Do not provide another ZIP as the primary workflow when this Windows project is writable.

## 13. Primary sources and verification limits

Sources reviewed on 13 November 2026. Branch URLs are discovery links, not dependency pins. Capture exact commits/package versions during phase 0.

- [S1 — Trading skill repository](https://github.com/tradermonty/claude-trading-skills), [MIT license](https://github.com/tradermonty/claude-trading-skills/blob/main/LICENSE), and the three individual skill files linked above.
- [C1 — Lightweight Charts product/API boundaries](https://tradingview.github.io/lightweight-charts/docs/product-comparison), [README attribution](https://github.com/tradingview/lightweight-charts/blob/master/README.md), [NOTICE](https://github.com/tradingview/lightweight-charts/blob/master/NOTICE).
- [I1 — TechnicalIndicators browser/indicator documentation](https://github.com/anandanand84/technicalindicators/blob/master/README.md), [license](https://github.com/anandanand84/technicalindicators/blob/master/LICENSE).
- [I2 — Trading Signals](https://github.com/bennycode/trading-signals). Package-level license/version suitability remains to be verified before adoption.
- [D1 — Kraken OHLC endpoint and historical limit](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).
- [D2 — CCXT manual, candle finality and timestamps](https://github.com/ccxt/ccxt/wiki/manual), [repository](https://github.com/ccxt/ccxt).
- [A1 — TradingAgents](https://github.com/TauricResearch/TradingAgents), [license](https://github.com/TauricResearch/TradingAgents/blob/main/LICENSE).
- [B1 — Freqtrade look-ahead analysis](https://www.freqtrade.io/en/stable/lookahead-analysis/), [license](https://github.com/freqtrade/freqtrade/blob/develop/LICENSE).
- [B2 — Backtesting.py repository/license](https://github.com/kernc/backtesting.py), [vectorbt repository/license description](https://github.com/polakowo/vectorbt).
- [R1 — Chrome extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

This handoff makes architectural recommendations. It does not establish that any strategy is profitable, that the external packages are defect-free, or that Agent Smith already has trading capabilities.
