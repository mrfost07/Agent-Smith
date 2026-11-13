/**
 * PilotPanel: In-Page Overlay & Floating Stop Pill
 * Injects a non-intrusive active boundary and stop control during execution.
 * Hidden automatically prior to screenshot capture and restored after.
 */

const OVERLAY_ID = '__pilotpanel_overlay_root__';

export class PageOverlay {
  private static root: HTMLDivElement | null = null;
  private static stopPill: HTMLButtonElement | null = null;
  private static glowBorder: HTMLDivElement | null = null;

  static init(): void {
    if (this.root || document.getElementById(OVERLAY_ID)) return;

    this.root = document.createElement('div');
    this.root.id = OVERLAY_ID;
    this.root.style.position = 'fixed';
    this.root.style.inset = '0';
    this.root.style.pointerEvents = 'none';
    this.root.style.zIndex = '2147483645';
    this.root.style.display = 'none';

    // Soft glowing border
    this.glowBorder = document.createElement('div');
    this.glowBorder.style.position = 'absolute';
    this.glowBorder.style.inset = '0';
    this.glowBorder.style.boxSizing = 'border-box';
    this.glowBorder.style.border = '2px solid rgba(59, 130, 246, 0.6)';
    this.glowBorder.style.boxShadow = 'inset 0 0 12px rgba(59, 130, 246, 0.25)';
    this.glowBorder.style.pointerEvents = 'none';
    this.root.appendChild(this.glowBorder);

    // Floating Stop pill
    this.stopPill = document.createElement('button');
    this.stopPill.textContent = 'Stop Agent';
    this.stopPill.style.position = 'fixed';
    this.stopPill.style.bottom = '20px';
    this.stopPill.style.right = '20px';
    this.stopPill.style.height = '32px';
    this.stopPill.style.padding = '0 12px';
    this.stopPill.style.background = '#18181b';
    this.stopPill.style.color = '#fafafa';
    this.stopPill.style.border = '1px solid #3f3f46';
    this.stopPill.style.borderRadius = '6px';
    this.stopPill.style.font = '500 13px/1 Inter, system-ui, sans-serif';
    this.stopPill.style.cursor = 'pointer';
    this.stopPill.style.pointerEvents = 'auto';
    this.stopPill.style.zIndex = '2147483647';
    this.stopPill.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';

    this.stopPill.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_CLICKED_IN_PAGE' }).catch(() => {});
    });

    this.root.appendChild(this.stopPill);
    document.documentElement.appendChild(this.root);
  }

  static setVisible(visible: boolean): void {
    if (!this.root) this.init();
    if (this.root) {
      this.root.style.display = visible ? 'block' : 'none';
    }
  }

  static remove(): void {
    if (this.root) {
      this.root.remove();
      this.root = null;
      this.stopPill = null;
      this.glowBorder = null;
    }
  }
}
