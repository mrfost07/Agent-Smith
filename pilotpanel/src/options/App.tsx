import { useState, useEffect } from 'react';
import { PilotPanelSettings, AgentMode } from '../shared/types';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../shared/constants';

export default function App() {
  const [settings, setSettings] = useState<PilotPanelSettings>(DEFAULT_SETTINGS);
  const [saveStatus, setSaveStatus] = useState<string>('');

  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (data) => {
      if (data[STORAGE_KEYS.SETTINGS]) {
        setSettings(data[STORAGE_KEYS.SETTINGS]);
      }
    });
  }, []);

  const handleSave = async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    setSaveStatus('Settings saved successfully.');
    setTimeout(() => setSaveStatus(''), 2500);
  };

  return (
    <div className="max-w-2xl mx-auto py-10 px-6 text-txt font-sans text-sm">
      <div className="border-b border-border pb-4 mb-6">
        <h1 className="text-xl font-semibold text-txt">PilotPanel Settings</h1>
        <p className="text-xs text-txt-muted mt-1">Configure model provider, step bounds, and execution policies.</p>
      </div>

      <div className="flex flex-col gap-6">
        {/* Model Provider Section */}
        <section className="flex flex-col gap-4 border-b border-border pb-6">
          <h2 className="text-sm font-semibold text-txt">Model Provider</h2>

          <div className="grid grid-cols-3 gap-4 items-center">
            <div>
              <label className="text-xs font-medium text-txt">Gemini API key</label>
              <p className="text-[11px] text-txt-muted">Google AI Studio key for Gemini models.</p>
            </div>
            <div className="col-span-2">
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                placeholder="AIzaSy..."
                className="w-full h-8 px-2.5 text-xs bg-bg border border-border-strong rounded focus:outline-none focus:border-txt"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 items-center">
            <div>
              <label className="text-xs font-medium text-txt">Model ID</label>
              <p className="text-[11px] text-txt-muted">Exact Gemini model identifier (free-text).</p>
            </div>
            <div className="col-span-2">
              <input
                type="text"
                value={settings.modelId}
                onChange={(e) => setSettings({ ...settings, modelId: e.target.value })}
                placeholder="gemini-2.5-flash"
                className="w-full h-8 px-2.5 text-xs bg-bg border border-border-strong rounded focus:outline-none focus:border-txt font-mono"
              />
            </div>
          </div>
        </section>

        {/* Execution Bounds Section */}
        <section className="flex flex-col gap-4 border-b border-border pb-6">
          <h2 className="text-sm font-semibold text-txt">Execution Policy</h2>

          <div className="grid grid-cols-3 gap-4 items-center">
            <div>
              <label className="text-xs font-medium text-txt">Default mode</label>
              <p className="text-[11px] text-txt-muted">Permission gating behavior on new domains.</p>
            </div>
            <div className="col-span-2">
              <select
                value={settings.defaultMode}
                onChange={(e) => setSettings({ ...settings, defaultMode: e.target.value as AgentMode })}
                className="h-8 px-2 text-xs bg-bg border border-border-strong rounded focus:outline-none text-txt"
              >
                <option value="ask">Ask (confirm on first action per domain)</option>
                <option value="plan">Plan (require plan review before running)</option>
                <option value="auto">Auto (pre-authorize with safety checks)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 items-center">
            <div>
              <label className="text-xs font-medium text-txt">Max step limit</label>
              <p className="text-[11px] text-txt-muted">Hard cap on actions per goal (default 40).</p>
            </div>
            <div className="col-span-2">
              <input
                type="number"
                min={5}
                max={100}
                value={settings.maxSteps}
                onChange={(e) => setSettings({ ...settings, maxSteps: parseInt(e.target.value, 10) || 40 })}
                className="w-24 h-8 px-2.5 text-xs bg-bg border border-border-strong rounded focus:outline-none focus:border-txt font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4 items-center">
            <div>
              <label className="text-xs font-medium text-txt">JavaScript execution</label>
              <p className="text-[11px] text-txt-muted">Allow javascript_exec tool in pages (off by default).</p>
            </div>
            <div className="col-span-2">
              <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.javascriptAllowed}
                  onChange={(e) => setSettings({ ...settings, javascriptAllowed: e.target.checked })}
                  className="rounded border-border-strong"
                />
                <span>Enable JavaScript tool</span>
              </label>
            </div>
          </div>
        </section>

        {/* Save Bar */}
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-success">{saveStatus}</span>
          <button
            onClick={handleSave}
            className="h-8 px-4 bg-txt text-bg font-medium text-xs rounded hover:opacity-90 transition-opacity"
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
