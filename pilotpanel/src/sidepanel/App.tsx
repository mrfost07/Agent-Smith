import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { useStore } from './store';
import { AgentMode } from '../shared/types';
import { BackgroundToSidepanelMessage } from '../shared/messages';
import { StepCard } from './StepCard';

export default function App() {
  const {
    messages,
    status,
    mode,
    setMode,
    setStatus,
    addMessage,
    appendStreamContent,
    addStepCard,
    updateStepCard,
    clearMessages,
    setSettings,
  } = useStore();

  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Initial state retrieval
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
      if (res?.ok) {
        if (res.settings) setSettings(res.settings);
        if (res.status) setStatus(res.status);
        if (res.messages && Array.isArray(res.messages)) {
          clearMessages();
          for (const m of res.messages) {
            addMessage(m);
          }
        }
      }
    });

    // Listen to background broadcast stream
    const messageListener = (msg: BackgroundToSidepanelMessage) => {
      switch (msg.type) {
        case 'CHAT_MESSAGE_ADDED':
          addMessage(msg.message);
          break;

        case 'CHAT_MESSAGE_STREAM':
          appendStreamContent(msg.messageId, msg.delta);
          break;

        case 'STEP_CARD_ADDED':
          addStepCard(msg.messageId, msg.step);
          break;

        case 'STEP_CARD_UPDATED':
          updateStepCard(msg.stepId, msg.update);
          break;

        case 'STATE_UPDATE':
          setStatus(msg.status);
          if (msg.mode) setMode(msg.mode);
          break;

        case 'AGENT_ERROR':
          setStatus('error');
          break;
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [addMessage, appendStreamContent, addStepCard, updateStepCard, clearMessages, setMode, setSettings, setStatus]);

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed || status === 'thinking' || status === 'acting') return;

    chrome.runtime.sendMessage({
      type: 'START_GOAL',
      goal: trimmed,
      mode: mode,
    });
    setInputText('');
  };

  const handleStop = () => {
    chrome.runtime.sendMessage({ type: 'STOP_GOAL' });
  };

  const handleNewChat = () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, () => {
      clearMessages();
    });
  };

  const handleOpenSettings = () => {
    chrome.runtime.openOptionsPage();
  };

  const suggestions = [
    'Read this page and list the main interactive buttons',
    'Extract the primary readable text from this article',
    'Find the search input box on this page',
    'Take a screenshot of the visible viewport',
  ];

  return (
    <div className="flex flex-col h-screen w-full bg-bg text-txt select-none text-[13px]">
      {/* Header */}
      <header className="flex items-center justify-between px-3 h-10 border-b border-border bg-bg-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold tracking-tight text-txt">PilotPanel</span>
          <span className="text-[11px] text-txt-subtle font-mono">v1.0</span>
          {status !== 'idle' && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                status === 'thinking'
                  ? 'bg-warning/10 text-warning border border-warning/20'
                  : status === 'acting'
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : status === 'completed'
                  ? 'bg-success/10 text-success border border-success/20'
                  : status === 'stopped'
                  ? 'bg-bg-muted text-txt-muted border border-border'
                  : 'bg-danger/10 text-danger border border-danger/20'
              }`}
            >
              {status}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleNewChat}
            className="h-7 px-2 border border-border-strong rounded text-[12px] font-medium hover:bg-bg-muted transition-colors"
          >
            New chat
          </button>
          <button
            onClick={handleOpenSettings}
            className="h-7 px-2 border border-border-strong rounded text-[12px] font-medium hover:bg-bg-muted transition-colors"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Main Conversation Thread */}
      <main className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {messages.length === 0 ? (
          <div className="my-auto flex flex-col gap-3 text-left">
            <div>
              <h2 className="text-base font-semibold text-txt">Autonomous Browser Agent</h2>
              <p className="text-txt-muted text-xs mt-1">
                State your goal. PilotPanel will observe, plan, and execute actions on the active page.
              </p>
            </div>

            <div className="flex flex-col gap-1.5 mt-2">
              <span className="text-[11px] font-medium text-txt-subtle uppercase tracking-wider">
                Perception tasks
              </span>
              {suggestions.map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => setInputText(prompt)}
                  className="text-left p-2 border border-border rounded bg-bg-subtle hover:bg-bg-muted text-xs text-txt transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`p-3 rounded border text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-bg-muted border-border-strong self-end max-w-[85%]'
                    : 'bg-bg-subtle border-border self-start max-w-full w-full'
                }`}
              >
                <div className="text-[10px] font-mono text-txt-subtle mb-1 capitalize">
                  {msg.role}
                </div>

                {/* Step Cards for tools invoked during this turn */}
                {msg.stepCards && msg.stepCards.length > 0 && (
                  <div className="mb-2 flex flex-col gap-1">
                    {msg.stepCards.map((card) => (
                      <StepCard key={card.id} card={card} />
                    ))}
                  </div>
                )}

                {msg.content && (
                  <div className="prose prose-sm dark:prose-invert max-w-none break-words">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      {/* Input Bar */}
      <footer className="p-3 border-t border-border bg-bg-subtle flex flex-col gap-2 shrink-0">
        <textarea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={2}
          placeholder="Describe what you want to see or do on this page..."
          className="w-full p-2 text-xs bg-bg border border-border-strong rounded focus:outline-none focus:border-txt resize-none"
        />

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-txt-subtle">Mode:</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as AgentMode)}
              className="h-7 px-1.5 text-xs bg-bg border border-border rounded focus:outline-none text-txt"
            >
              <option value="ask">Ask</option>
              <option value="plan">Plan</option>
              <option value="auto">Auto</option>
            </select>
          </div>

          {status === 'thinking' || status === 'acting' ? (
            <button
              onClick={handleStop}
              className="h-8 px-3 border border-danger text-danger font-medium text-xs rounded hover:bg-bg-muted transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!inputText.trim()}
              className="h-8 px-4 bg-txt text-bg font-medium text-xs rounded hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              Send
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
