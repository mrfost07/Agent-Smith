/**
 * PilotPanel: Step Card Component (Plain Pro UI)
 * Restrained, dense, typographic representation of an agent action.
 * Shows tool name, execution time, result state, and expandable debug data.
 */

import { useState } from 'react';
import { StepCardData } from '../shared/types';

interface StepCardProps {
  card: StepCardData;
}

export function StepCard({ card }: StepCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isSuccess = card.result ? card.result.ok : undefined;
  const statusLabel =
    isSuccess === undefined
      ? 'running'
      : isSuccess
      ? 'ok'
      : 'failed';

  return (
    <div className="border border-border rounded bg-bg-subtle text-xs overflow-hidden my-1.5">
      <div
        className="flex items-center justify-between px-2.5 py-1.5 cursor-pointer hover:bg-bg-muted transition-colors select-none"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono text-txt-subtle uppercase">
            #{card.stepNumber}
          </span>
          <span className="font-mono font-medium text-txt truncate">
            {card.toolName}
          </span>
          <span className="text-txt-muted truncate hidden sm:inline">
            {card.summary}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {card.durationMs !== undefined && (
            <span className="text-[10px] font-mono text-txt-subtle">
              {card.durationMs}ms
            </span>
          )}
          <span
            className={`text-[10px] px-1.5 py-0.2 rounded font-mono uppercase ${
              statusLabel === 'ok'
                ? 'bg-success/10 text-success border border-success/20'
                : statusLabel === 'failed'
                ? 'bg-danger/10 text-danger border border-danger/20'
                : 'bg-warning/10 text-warning border border-warning/20'
            }`}
          >
            {statusLabel}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="p-2.5 border-t border-border bg-bg flex flex-col gap-2 font-mono text-[11px]">
          {card.screenshotThumb && (
            <div>
              <div className="text-txt-subtle text-[10px] mb-1 uppercase tracking-wider">
                Viewport Capture
              </div>
              <img
                src={card.screenshotThumb}
                alt="Captured viewport"
                className="max-h-48 border border-border rounded object-contain bg-bg-muted"
              />
            </div>
          )}

          <div>
            <div className="text-txt-subtle text-[10px] mb-0.5 uppercase tracking-wider">
              Arguments
            </div>
            <pre className="p-1.5 bg-bg-subtle border border-border rounded overflow-x-auto text-txt-muted whitespace-pre-wrap max-h-28 overflow-y-auto">
              {JSON.stringify(card.args, null, 2)}
            </pre>
          </div>

          {card.result && (
            <div>
              <div className="text-txt-subtle text-[10px] mb-0.5 uppercase tracking-wider">
                Result Output
              </div>
              <pre className="p-1.5 bg-bg-subtle border border-border rounded overflow-x-auto text-txt-muted whitespace-pre-wrap max-h-40 overflow-y-auto">
                {card.result.error
                  ? `Error: ${card.result.error}`
                  : typeof card.result.content === 'string'
                  ? card.result.content
                  : JSON.stringify(card.result.content, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
