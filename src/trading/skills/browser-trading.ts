// Adapted for the visible chart's timeframe from the technical-analyst skill
// in tradermonty/claude-trading-skills.
export const browserTradingSkill = {
  tools: [
    'Trading skill for the active browser tab:',
    'Choose by the requested outcome and evidence source. Use analyze_chart when the user wants a reading, forecast, or trade plan based on the page they have open. Use analyze_market for candle-based calculations from a named market or saved analysis, paper trading calculations, or a backtest. Use ordinary browser tools for navigation and unrelated page tasks. A general question about trading can be answered directly.',
    'Use prepare_trade only when the user requests an actual order, including a follow-up referring to a prior chart. This prepares one demo order for review or explains why no order was prepared. For a user-specified direction use action.direction up or down. Set analyzeChart to false only when the user directly specifies the direction and requests an order without chart analysis.',
    'Use the latest chart and the requested horizon, or the duration selected on the trading page when the user leaves the horizon open. Decide the direction if delegated. Reserve confirmation for a concrete order with its asset, direction, amount, and expiry.',
    'Continue a prior task from its last recorded outcome. A completed or possibly submitted order must never be replayed by a generic continuation. Never use a generic browser click to submit a trade in place of prepare_trade.',
  ].join('\n'),
  method: [
    'Technical analysis skill: Identify the visible chart timeframe and classify structure from recent swing highs and lows. Note where price is relative to the visible moving averages and whether their slopes agree. Use volume only if visible.',
    'Mark the closest meaningful support and resistance from prior reactions, then check for a confirmed breakout, a rejection, or unresolved range. State the condition that would invalidate the bias. Use the requested horizon when given, otherwise use the selected order duration if available.',
    'For a trade plan or suggestion, give the direction, horizon, entry trigger, target area and invalidation supported by the chart. If there is no setup yet, state the trigger to wait for. Use the visible chart interval as context if the user and page supply no horizon. A favorable trend alone is insufficient if price has already reached the next barrier. Avoid uncalibrated probabilities.',
  ].join('\n'),
};
