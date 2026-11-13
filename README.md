<p align="center">
  <img src="icons/icon128.png" width="112" height="112" alt="Agent Smith icon with green glasses">
</p>
<h1 align="center">Agent Smith</h1>
<p align="center">An AI side panel for reading, researching, and acting in your browser.</p>
<p align="center"><strong>Chromium extension</strong> · TypeScript · Bring your own model</p>

---

Agent Smith can read the active tab, answer questions, and carry out multi-step browser tasks. You can enable screenshots for a vision-capable model. Review mode pauses before page input, while Turbo runs routine actions automatically and still asks about recognized submissions.

## Get started

1. Clone this repository and open the project folder.
2. Run `npm ci`, then `npm run build`. This generates the `dist/` folder used by the extension.
3. Open `chrome://extensions`, `edge://extensions`, or `brave://extensions` and enable **Developer mode**.
4. Click **Load unpacked** and choose the project root, where `manifest.json` lives.
5. Open Agent Smith and choose a provider and model in Settings.

Run `npm test` to check browser planning, providers, sessions, and trading flows with local fixtures.

## Optional local configuration

Create `.smith.local.json` in the project root if you use Google Antigravity OAuth or the resume bridge. Include the sections you need. Git ignores this file.

```json
{
  "oauth": {
    "clientId": "YOUR_CLIENT_ID",
    "clientSecret": "YOUR_CLIENT_SECRET"
  },
  "resume": {
    "source": "./resume.txt",
    "output": "./tailored",
    "email": "",
    "phone": ""
  }
}
```

For Antigravity, use an OAuth client configured for `http://localhost:51121/oauth-callback`, then rebuild. A build made with local OAuth credentials contains those values in its bundles, so keep that build local.

To run the optional resume bridge, set `SMITH_BRIDGE_TOKEN` to a randomly generated value of at least 32 characters, run `npm run start:bridge`, and enter the same token in Agent Smith Settings. The bridge uses a sample resume template and supports generating PDFs with a local Chrome installation on Windows.

## AI providers

In the side panel, open **Settings**, choose an **AI provider**, enter its credentials, and select **Save and load models**. Choose the model in Settings or search the same catalog in the composer. OpenRouter marks free variants and lists its free router alongside individual models. A custom OpenAI-compatible API uses its base URL, for example https://example.com/v1. If it does not publish a catalog, enter the model ID manually. Turn on screenshots for a model only if it accepts image input.

### OpenCode V1

Run opencode auth login to connect an account in OpenCode. In PowerShell, start a password-protected local server from a dedicated folder:

    $env:OPENCODE_SERVER_PASSWORD = 'your-password'
    $env:OPENCODE_CONFIG_CONTENT = '{"agent":{"agent-smith":{"description":"Browser planner","mode":"primary","permission":"deny"}}}'
    opencode serve --hostname 127.0.0.1 --port 4096

Select **OpenCode** in Agent Smith, enter the server password, and load its connected models. Agent Smith checks the tool-disabled planner profile before sending a prompt.

## Analyze an active chart

Open TradingView or another browser-based financial chart and leave the chart visible. In Agent Smith Settings, enable **Send page screenshots to the selected AI model** and choose a model with image support. Click the chart icon or type **Analyze this chart**. Smith reads the visible chart and returns its observations and approximate price levels in the side panel. On a multi-chart layout, specify which pane or symbol to analyze.

Ask **Pan back on this chart and analyze the older candles** to send a horizontal drag over an unobstructed chart canvas before analysis. Requests for the earliest candles try up to four drags and report the visible result. A platform's available history and whether it handles the drag depend on its chart.

### ExpertOption demo order test

Open the ExpertOption terminal, select **Demo**, and set the asset, amount, and expiry in the terminal. Ask **Place one demo Up trade with the current amount and expiry** or use **Down**. The extension reads the order details and shows an **Allow once** review. It checks the same tab, selected demo control, fields, and button again immediately before the click. Check the demo trade history to confirm that the platform accepted the order.

You can also ask Smith to read the chart and prepare a position in one turn. For example, **Use the browser, give me the next-minute outlook, and prepare one position.** Smith reads a fresh screenshot and can show a proposed demo position for review if it verifies that Demo is selected, the chart asset matches the order asset, and the reading supports one direction. The requested forecast horizon is separate from the expiry selected in the terminal.

Natural-language trade requests can select the planner's `prepare_trade` tool, including follow-ups delegating direction. The tool checks the active platform rather than assuming the previous chart's host. For a verified Demo account, the chart model returns a proposed direction or an explicit no-trade reason; it does not ask the user to choose a direction they already delegated. Ordinary chart analysis uses `analyze_chart` and does not stage an order. Order preparation currently has an ExpertOption adapter; other platforms can be read but do not have an order integration.

The ExpertOption adapter supports accessible selected controls and the observed account-header segment marker, custom BUY/SELL controls with payout labels, and adjacent investment/auto-close fields. It reads the visible direction because the observed site's buy/sell test IDs are reversed. Ambiguous markers, Real mode, obstructed controls, changed fields, and mismatched assets stop preparation or validation. On 2026-11-13 a read-only probe of the live terminal verified Demo, asset, amount, expiry, and both order targets. Automated tests cover the observed DOM structure and conversational routing. Platform acceptance after a click remains unverified; no order was submitted during that probe.

For computed indicators based on closed exchange candles, ask for a pair and timeframe, such as **Analyze BTC/USD on Kraken, 1h**. To run historical backtests, import a CSV, or use paper replay, select **Backtests and CSV** in the side panel menu.

| Capability | Current behavior |
| --- | --- |
| Market data | Kraken spot at 15m, 1h, 4h, or 1d. Historical CSV supports up to 20,000 ascending closed bars. |
| CSV format | Use `time,open,high,low,close,volume` with UTC candle-open timestamps in ISO 8601, Unix seconds, or Unix milliseconds. Volume is optional and its units remain unknown. Enter the pair and interval before importing. |
| Strategy | Range breakout or EMA pullback, editable lookback, ATR stop, and reward multiple. EMA 20/50/200, Wilder RSI and ATR, and confirmed swing levels. Higher timeframe context uses fully aggregated bars. |
| Risk | Entry, stop, targets and cost-adjusted reward/risk for qualifying setups. Sizing needs paper equity, risk percentage and instrument metadata. For CSV, enter simulated tick size, quantity step, minimum quantity and minimum notional. |
| Drawings | Select **Price line** or **Trendline** and click the chart. The drawing coordinates form supports keyboard entry. Drawings persist with the market and timeframe within the selected conversation. |
| Backtest | Set a paper balance and risk budget, then select **Run backtest**. The worker simulates next-open fills and exits at TP1, stop, or the strategy's exit. When stop and target touch in the same bar, stop takes precedence. Export the full ledger and equity series as JSON. **Final 20% only** evaluates a fixed configuration on that chronological window. |
| Paper setup | Save an eligible Kraken setup and select **Evaluate paper setup** after later candles close. The ledger is a manual closed-candle replay. Entry is eligible only at a bar open after the setup was saved. |
| AI explanation | Uses the selected provider when available. Ask **Review the backtest results** after completing a backtest in the conversation workspace. Chart and numerical analysis also work without a model. |

Kraken may return up to 720 recent rows, including the current unfinished candle. Smith excludes the unfinished candle. Use a contiguous historical CSV for longer backtests. Support/resistance uses confirmed two-bar swings with ATR-based grouping. Costs are editable assumptions and stop fills can be worse after gaps. Signals and paper fills stay within the Trading workspace.

Implementation uses a local Canvas chart and TypeScript calculations with no added runtime dependencies. Workflow references and the phased design are in [the trading handoff](docs/TRADING_SKILLS_SOL_HANDOFF.md).
