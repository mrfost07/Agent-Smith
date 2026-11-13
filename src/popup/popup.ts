/**
 * Popup Controller
 * Pure Google Antigravity Provider Interface (Noter.ai parity).
 * Sentence-case microcopy, zero emojis, clean status indicators.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const goalInput = document.getElementById('goal-input') as HTMLTextAreaElement;
  const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
  const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
  const streamSection = document.getElementById('stream-section') as HTMLElement;
  const streamThought = document.getElementById('stream-thought') as HTMLParagraphElement;
  const streamAction = document.getElementById('stream-action') as HTMLDivElement;
  const streamLogs = document.getElementById('stream-logs') as HTMLDivElement;
  const stepCounter = document.getElementById('step-counter') as HTMLSpanElement;
  const confirmBox = document.getElementById('confirm-box') as HTMLDivElement;
  const confirmMsg = document.getElementById('confirm-msg') as HTMLParagraphElement;
  const confirmYes = document.getElementById('confirm-yes') as HTMLButtonElement;
  const confirmNo = document.getElementById('confirm-no') as HTMLButtonElement;
  const openSettings = document.getElementById('open-settings') as HTMLButtonElement;
  const closeSettings = document.getElementById('close-settings') as HTMLButtonElement;
  const settingsView = document.getElementById('settings-view') as HTMLElement;
  const mainView = document.getElementById('main-view') as HTMLElement;
  const saveSettingsBtn = document.getElementById('save-settings-btn') as HTMLButtonElement;

  const toggleVision = document.getElementById('toggle-vision') as HTMLInputElement;
  const toggleSafety = document.getElementById('toggle-safety') as HTMLInputElement;
  const quickModelSelect = document.getElementById('quick-model-select') as HTMLSelectElement;

  const connectSection = document.getElementById('connect-section') as HTMLElement;
  const signinAntigravityBtn = document.getElementById('signin-antigravity-btn') as HTMLButtonElement;

  const settingModel = document.getElementById('setting-model') as HTMLSelectElement;
  const connectionStatus = document.getElementById('connection-status') as HTMLSpanElement;
  const statusDot = document.getElementById('status-dot') as HTMLSpanElement;

  const accountSignedIn = document.getElementById('account-signed-in') as HTMLDivElement;
  const accountSignedOut = document.getElementById('account-signed-out') as HTMLDivElement;
  const accountProjectLabel = document.getElementById('account-project-label') as HTMLSpanElement;
  const signinSettingsBtn = document.getElementById('signin-settings-btn') as HTMLButtonElement;
  const signoutAntigravityBtn = document.getElementById('signout-antigravity-btn') as HTMLButtonElement;

  // Load persisted configuration
  const config = await chrome.storage.local.get([
    'antigravity_token',
    'antigravity_project',
    'antigravity_model',
    'toggle_vision',
    'toggle_safety',
  ]);

  const currentModel = config.antigravity_model || 'gemini-3.8-flash-tiered';
  if (settingModel) settingModel.value = currentModel;
  if (quickModelSelect) quickModelSelect.value = currentModel;

  if (typeof config.toggle_vision === 'boolean' && toggleVision) toggleVision.checked = config.toggle_vision;
  if (typeof config.toggle_safety === 'boolean' && toggleSafety) toggleSafety.checked = config.toggle_safety;

  function updateAccountUI(signedIn: boolean, projectId?: string) {
    if (signedIn) {
      if (accountSignedIn) accountSignedIn.style.display = 'flex';
      if (accountSignedOut) accountSignedOut.style.display = 'none';
      const cleanProject = (!projectId || projectId === 'rising-fact-p41fc' || projectId === 'default-cli-project') ? 'Antigravity Main Brain' : projectId;
      if (accountProjectLabel) accountProjectLabel.textContent = `Connected (${cleanProject})`;
    } else {
      if (accountSignedIn) accountSignedIn.style.display = 'none';
      if (accountSignedOut) accountSignedOut.style.display = 'block';
    }
  }

  // Connectivity check
  async function checkConnectivity(): Promise<boolean> {
    const current = await chrome.storage.local.get([
      'antigravity_token',
      'antigravity_project',
    ]);

    if (current.antigravity_token) {
      let project = current.antigravity_project;
      if (!project || project === 'default-cli-project') {
        project = 'rising-fact-p41fc';
        await chrome.storage.local.set({ antigravity_project: 'rising-fact-p41fc' });
      }
      connectionStatus.textContent = 'Connected (Google Antigravity)';
      statusDot.setAttribute('data-tone', 'success');
      connectSection.style.display = 'none';
      updateAccountUI(true, project);
      return true;
    }

    connectionStatus.textContent = 'Not connected';
    statusDot.setAttribute('data-tone', 'warning');
    connectSection.style.display = 'flex';
    updateAccountUI(false);
    return false;
  }

  await checkConnectivity();

  // Handle Google Antigravity 1-Click Sign-in
  const triggerGoogleSignIn = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    const originalText = btn.textContent || 'Sign in';
    btn.textContent = 'Opening Google sign-in...';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'START_ANTIGRAVITY_LOGIN' });
      if (!res?.success) {
        alert('Could not start Google sign-in: ' + (res?.error || 'Unknown error'));
        btn.disabled = false;
        btn.textContent = originalText;
      }
    } catch (err: any) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };

  signinAntigravityBtn?.addEventListener('click', () => triggerGoogleSignIn(signinAntigravityBtn));
  signinSettingsBtn?.addEventListener('click', () => triggerGoogleSignIn(signinSettingsBtn));

  signoutAntigravityBtn?.addEventListener('click', async () => {
    signoutAntigravityBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: 'ANTIGRAVITY_LOGOUT' });
    signoutAntigravityBtn.disabled = false;
    await checkConnectivity();
  });

  // Listen for background auth changes
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'ANTIGRAVITY_AUTH_CHANGED') {
      checkConnectivity();
    }
  });

  // Model selection sync
  quickModelSelect?.addEventListener('change', async () => {
    await chrome.storage.local.set({ antigravity_model: quickModelSelect.value });
    if (settingModel) settingModel.value = quickModelSelect.value;
  });

  openSettings?.addEventListener('click', () => {
    mainView.style.display = 'none';
    connectSection.style.display = 'none';
    settingsView.style.display = 'flex';
  });

  closeSettings?.addEventListener('click', async () => {
    settingsView.style.display = 'none';
    mainView.style.display = 'flex';
    await checkConnectivity();
  });

  saveSettingsBtn?.addEventListener('click', async () => {
    const model = settingModel.value;

    await chrome.storage.local.set({
      antigravity_model: model,
      antigravity_project: 'rising-fact-p41fc',
      toggle_vision: toggleVision.checked,
      toggle_safety: toggleSafety.checked,
    });

    if (quickModelSelect) quickModelSelect.value = model;
    settingsView.style.display = 'none';
    mainView.style.display = 'flex';
    await checkConnectivity();
  });

  // Task preset chips
  document.querySelectorAll('.preset-btn').forEach((chip) => {
    chip.addEventListener('click', () => {
      goalInput.value = chip.getAttribute('data-prompt') || '';
      goalInput.focus();
    });
  });

  // Run agent execution
  runBtn?.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    if (!goal) return;

    const isReady = await checkConnectivity();
    if (!isReady) {
      connectSection.style.display = 'flex';
      return;
    }

    streamSection.style.display = 'flex';
    streamLogs.innerHTML = '';
    streamThought.textContent = 'Initiating agent...';
    stepCounter.textContent = 'Step 1';
    confirmBox.style.display = 'none';

    chrome.runtime.sendMessage({
      type: 'START_AGENT',
      goal,
      visionEnabled: toggleVision.checked,
      safetyGate: toggleSafety.checked,
    });
  });

  stopBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
  });

  confirmYes?.addEventListener('click', () => {
    confirmBox.style.display = 'none';
    chrome.runtime.sendMessage({ type: 'CONFIRM_ACTION' });
  });

  confirmNo?.addEventListener('click', () => {
    confirmBox.style.display = 'none';
    chrome.runtime.sendMessage({ type: 'STOP_AGENT' });
  });

  // Execution stream receiver
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'AGENT_UPDATE') {
      const data = msg.data;

      if (data.status === 'running') {
        streamSection.style.display = 'flex';
        stepCounter.textContent = `Step ${data.step + 1}`;
        if (data.thought) streamThought.textContent = data.thought;
        if (data.action) {
          streamAction.textContent = `Action: ${data.action.type}${
            data.action.text ? ` (${data.action.text.slice(0, 32)})` : ''
          }`;
        }
      } else if (data.status === 'waiting_confirmation') {
        confirmBox.style.display = 'flex';
        confirmMsg.textContent = `Confirmation required: ${data.action?.type || 'action'} (${
          data.action?.reasoning || data.action?.text || 'Irreversible change'
        })`;
      } else if (data.status === 'completed') {
        streamThought.textContent = data.summary || 'Task completed.';
        streamAction.textContent = 'Status: Complete';
      } else if (data.status === 'error') {
        streamThought.textContent = `Error: ${data.error}`;
        streamAction.textContent = 'Status: Error';
      }

      if (data.logs && data.logs.length > 0) {
        streamLogs.innerHTML = data.logs
          .map(
            (l: any) =>
              `<div class="log-item"><span class="log-step">#${l.step}</span> ${l.action.type}: ${l.result}</div>`
          )
          .join('');
        streamLogs.scrollTop = streamLogs.scrollHeight;
      }
    }
  });

  // Query status on open
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (res?.status?.status === 'running' || res?.status?.status === 'waiting_confirmation') {
      streamSection.style.display = 'flex';
      stepCounter.textContent = `Step ${res.status.stepCount}`;
    }
  });
});
