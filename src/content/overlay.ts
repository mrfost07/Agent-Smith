/** Animated viewport lighting and cursor feedback in an isolated shadow root. */

export type OverlayState = 'idle' | 'thinking' | 'acting' | 'waiting-approval' | 'error' | 'done';

export class OverlayManager {
  private static hostEl: HTMLElement | null = null;
  private static shadow: ShadowRoot | null = null;

  private static frameEl: HTMLElement | null = null;
  private static pillEl: HTMLElement | null = null;
  private static statusLabelEl: HTMLElement | null = null;
  private static cursorEl: HTMLElement | null = null;

  private static currentState: OverlayState = 'idle';
  private static isInitialized = false;

  /**
   * Initializes the Closed Shadow DOM overlay on the page if not already present.
   */
  static init(): void {
    if (this.isInitialized && this.hostEl && document.contains(this.hostEl)) {
      return;
    }

    // Remove any previous instance
    const oldHost = document.querySelector('antigravity-overlay-host');
    if (oldHost) oldHost.remove();

    // Create host element
    const host = document.createElement('antigravity-overlay-host');
    host.style.cssText = `
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      overflow: hidden !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      display: block !important;
    `;

    // Attach CLOSED shadow root
    const shadow = host.attachShadow({ mode: 'closed' });

    // Inject styles and DOM inside shadow root
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          pointer-events: none;
        }

        * {
          box-sizing: border-box;
          user-select: none;
          -webkit-user-select: none;
        }

        @keyframes fogDrift {
          0% { transform: translate3d(-5%, 2%, 0) scale(1.05); }
          48% { transform: translate3d(3%, -3%, 0) scale(1.13, 1.06); }
          100% { transform: translate3d(6%, 4%, 0) scale(1.08, 1.18); }
        }
        @keyframes rippleOut {
          0% {
            transform: scale(0.3);
            opacity: 0.9;
          }
          100% {
            transform: scale(2.6);
            opacity: 0;
          }
        }


        .stitch-screen-frame {
          position: fixed;
          inset: 0;
          pointer-events: none;
          overflow: hidden;
          opacity: 0;
          transition: opacity 260ms ease;
          --fog-green: #27d88d;
          --fog-mint: #66ebac;
          --fog-blue: #4ca7e8;
          --fog-violet: #a185e0;
          --fog-depth: min(130px, 20vmin);
        }

        .stitch-screen-frame.active { opacity: 0.72; }

        .edge-fog {
          position: absolute;
          inset: 0;
          overflow: hidden;
          mask:
            linear-gradient(to right, #000b, #0007 18%, transparent) left / var(--fog-depth) 100% no-repeat,
            linear-gradient(to left, #000b, #0007 18%, transparent) right / var(--fog-depth) 100% no-repeat,
            linear-gradient(to bottom, #000b, #0007 18%, transparent) top / 100% var(--fog-depth) no-repeat,
            linear-gradient(to top, #000d, #0008 18%, transparent) bottom / 100% var(--fog-depth) no-repeat;
        }

        .fog-wisp {
          position: absolute;
          inset: -18%;
          background:
            radial-gradient(ellipse 28% 15% at 23% 16%, var(--fog-mint), transparent 100%),
            radial-gradient(ellipse 33% 22% at 74% 21%, var(--fog-green), transparent 100%),
            radial-gradient(ellipse 16% 31% at 14% 57%, var(--fog-green), transparent 100%),
            radial-gradient(ellipse 20% 27% at 86% 58%, var(--fog-blue), transparent 100%),
            radial-gradient(ellipse 28% 21% at 27% 82%, var(--fog-violet), transparent 100%),
            radial-gradient(ellipse 36% 24% at 69% 84%, var(--fog-green), transparent 100%);
          filter: url(#smith-fog-warp);
          opacity: 0.66;
        }

        .fog-wisp + .fog-wisp {
          opacity: 0.42;
          background:
            radial-gradient(ellipse 17% 30% at 16% 53%, var(--fog-blue), transparent 100%),
            radial-gradient(ellipse 24% 16% at 63% 19%, var(--fog-blue), transparent 100%),
            radial-gradient(ellipse 18% 35% at 82% 55%, var(--fog-mint), transparent 100%),
            radial-gradient(ellipse 42% 19% at 41% 82%, var(--fog-green), transparent 100%);
        }

        .active .fog-wisp { animation: fogDrift 13s ease-in-out infinite alternate; }
        .active .fog-wisp + .fog-wisp { animation: fogDrift 19s -7s ease-in-out infinite alternate-reverse; }
        :host(.state-acting) .stitch-screen-frame.active { opacity: 0.86; }
        :host(.state-waiting-approval) .stitch-screen-frame { --fog-violet: #f1ad60; }
        :host(.state-error) .stitch-screen-frame { --fog-green: #d45867; --fog-mint: #f39990; }
        :host(.state-done) .stitch-screen-frame.active { opacity: 0.26; }
        .floating-pill {
          position: fixed;
          top: 18px;
          max-width: calc(100vw - 24px);
          left: 50%;
          transform: translateX(-50%) translateY(-12px);
          background: rgba(15, 17, 23, 0.86);
          backdrop-filter: blur(20px) saturate(190%);
          -webkit-backdrop-filter: blur(20px) saturate(190%);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 9999px;
          padding: 5px 8px 5px 14px;
          display: flex;
          align-items: center;
          gap: 10px;
          box-shadow: 
            0 14px 35px -5px rgba(0, 0, 0, 0.65),
            0 0 1px 1px rgba(255, 255, 255, 0.1),
            0 0 20px rgba(45, 212, 191, 0.14);
          pointer-events: none;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          font-size: 12.5px;
          color: #f4f4f5;
          opacity: 0;
          transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .floating-pill.visible {
          opacity: 1;
          pointer-events: auto;
          transform: translateX(-50%) translateY(0);
        }

        .pill-logo {
          display: block;
          flex: none;
          width: 27px;
          height: 22px;
          object-fit: contain;
        }
        .pill-text-cluster {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .pill-brand {
          white-space: nowrap;
          font-weight: 600;
          color: #ffffff;
          letter-spacing: -0.2px;
          font-size: 12.5px;
        }

        .pill-slash {
          color: rgba(255, 255, 255, 0.25);
          font-size: 11px;
        }

        .pill-status-text {
          font-weight: 400;
          color: #94a3b8;
          letter-spacing: -0.1px;
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .pill-stop-btn {
          flex: none;
          background: transparent;
          border: 0;
          color: #ffb3b3;
          font-weight: 500;
          font-family: inherit;
          font-size: 12px;
          padding: 6px 8px;
          border-radius: 5px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }

        .pill-stop-btn:hover { color: #fff; background: rgb(255 255 255 / 0.07); }
        .pill-stop-btn:focus-visible { outline: 2px solid #80efbc; outline-offset: 2px; }
        /* 5. Animated Agent Cursor */
        .agent-cursor {
          position: fixed;
          top: 0;
          left: 0;
          pointer-events: none;
          z-index: 1000;
          opacity: 0;
          transition: opacity 0.2s ease, transform 130ms cubic-bezier(0.22, 1, 0.36, 1);
          will-change: transform;
        }

        .agent-cursor.visible {
          opacity: 1;
        }

        .cursor-svg {
          display: block;
          width: 24px;
          height: 24px;
          margin: -3px 0 0 -4px;
          transform-origin: 4px 3px;
          filter: drop-shadow(0 3px 8px rgba(0, 0, 0, 0.6));
          transition: transform 0.15s cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        .agent-cursor.clicking .cursor-svg {
          transform: scale(0.85);
        }


        .click-ripple {
          position: fixed;
          z-index: 1001;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          border: 1px solid #b9f4ff;
          pointer-events: none;
          animation: rippleOut 320ms ease-out forwards;
        }

        @media (prefers-reduced-motion: reduce) {
          .active .fog-wisp, .active .fog-wisp + .fog-wisp,
          .click-ripple { animation: none; }
          .agent-cursor, .cursor-svg, .stitch-screen-frame { transition: none; }
          .click-ripple { display: none; }
        }
      </style>

      <svg width="0" height="0" aria-hidden="true" style="position:absolute">
        <filter id="smith-fog-warp" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency=".008 .013" numOctaves="3" seed="7" result="cloud"/>
          <feDisplacementMap in="SourceGraphic" in2="cloud" scale="95" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </svg>
      <div class="stitch-screen-frame" id="stitch-screen-frame" aria-hidden="true">
        <div class="edge-fog"><div class="fog-wisp"></div><div class="fog-wisp"></div></div>
      </div>

      <div class="floating-pill" id="floating-pill">
        <img class="pill-logo" src="${chrome.runtime.getURL('dist/icons/smithLogo.png')}" alt="">
        <div class="pill-text-cluster">
          <span class="pill-brand">Agent Smith</span>
          <span class="pill-slash">/</span>
          <span class="pill-status-text" id="pill-status-text">Operating</span>
        </div>
        <button class="pill-stop-btn" id="pill-stop-btn" title="Stop execution (Esc)">
          <svg width="7" height="7" viewBox="0 0 24 24" fill="currentColor">
            <rect x="2" y="2" width="20" height="20" rx="3"></rect>
          </svg>
          <span>Stop</span>
        </button>
      </div>

      <div class="agent-cursor" id="agent-cursor">
        <svg class="cursor-svg" viewBox="0 0 24 24" fill="none">
          <defs>
            <linearGradient id="cursorGradStitch" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#2dd4bf"/>
              <stop offset="50%" stop-color="#818cf8"/>
              <stop offset="100%" stop-color="#f472b6"/>
            </linearGradient>
          </defs>
          <path d="M4 3L18 12L11 14L8 21L4 3Z" fill="url(#cursorGradStitch)" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>
      </div>

    `;

    document.documentElement.appendChild(host);

    this.hostEl = host;
    this.shadow = shadow;

    this.frameEl = shadow.getElementById('stitch-screen-frame');
    this.pillEl = shadow.getElementById('floating-pill');
    this.statusLabelEl = shadow.getElementById('pill-status-text');
    this.cursorEl = shadow.getElementById('agent-cursor');

    // Wire up Stop Button
    shadow.getElementById('pill-stop-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.triggerStop();
    });

    // Global Emergency Kill Switch (Escape Key)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.currentState !== 'idle') {
        this.triggerStop();
      }
    });

    this.isInitialized = true;
  }

  /**
   * Sets the viewport fog and status pill.
   */
  static setState(state: OverlayState, statusText?: string): void {
    this.init();
    if (!this.shadow || !this.hostEl) return;

    this.currentState = state;
    if (state !== 'idle') this.setCaptureHidden(false);

    // Reset state classes
    const classes = ['state-thinking', 'state-acting', 'state-waiting-approval', 'state-error', 'state-done'];
    classes.forEach((c) => this.hostEl?.classList.remove(c));

    if (state !== 'idle') {
      this.hostEl.classList.add(`state-${state}`);
      this.frameEl?.classList.add('active');
      this.pillEl?.classList.add('visible');
    } else {
      this.frameEl?.classList.remove('active');
      this.pillEl?.classList.remove('visible');
      if (this.cursorEl) this.cursorEl.classList.remove('visible');
    }

    if (statusText && this.statusLabelEl) {
      this.statusLabelEl.textContent = statusText;
    } else if (this.statusLabelEl) {
      switch (state) {
        case 'thinking':
          this.statusLabelEl.textContent = 'Thinking...';
          break;
        case 'acting':
          this.statusLabelEl.textContent = 'Operating';
          break;
        case 'waiting-approval':
          this.statusLabelEl.textContent = 'Approval Required';
          break;
        case 'error':
          this.statusLabelEl.textContent = 'Error';
          break;
        case 'done':
          this.statusLabelEl.textContent = 'Completed';
          break;
      }
    }
  }


  static moveCursorTo(x: number, y: number): void {
    this.init();
    if (!this.cursorEl) return;
    this.cursorEl.classList.add('visible');
    this.cursorEl.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
  }

  static playClickAnimation(x: number, y: number): void {
    this.moveCursorTo(x, y);
    const cursor = this.cursorEl;
    if (!cursor) return;
    cursor.classList.add('clicking');
    const ripple = document.createElement('div');
    ripple.className = 'click-ripple';
    ripple.style.left = (x - 8) + 'px';
    ripple.style.top = (y - 8) + 'px';
    this.shadow?.appendChild(ripple);
    setTimeout(() => cursor.classList.remove('clicking'), 100);
    setTimeout(() => ripple.remove(), 320);
  }

  static setCaptureHidden(hidden: boolean): void {
    this.hostEl?.style.setProperty('visibility', hidden ? 'hidden' : 'visible', 'important');
  }

  static hide(): void {
    this.setState('idle');
    this.setCaptureHidden(true);
  }

  private static triggerStop(): void {
    chrome.runtime.sendMessage({ type: 'STOP_AGENT' }).catch(() => {});
    this.hide();
  }
}
