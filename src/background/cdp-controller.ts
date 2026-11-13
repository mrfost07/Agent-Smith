import { runOperation } from './run-operation';

/** Trusted browser input for the page the agent is controlling. */
export class CDPController {
  private static attachedTabs = new Set<number>();
  private static watchingDetach = false;
  private static attaching = new Map<number, Promise<boolean>>();

  private static detaching = new Map<number, Promise<void>>();

  static async attach(tabId: number): Promise<boolean> {
    if (this.detaching.has(tabId)) return false;
    if (this.attachedTabs.has(tabId)) return true;
    let pending = this.attaching.get(tabId);
    if (!pending) {
      pending = this.attachOnce(tabId).finally(() => this.attaching.delete(tabId));
      this.attaching.set(tabId, pending);
    }
    try {
      return await runOperation(() => pending!, 1500, 'Connecting browser debugger');
    } catch {
      void this.detach(tabId);
      return false;
    }
  }

  private static async attachOnce(tabId: number): Promise<boolean> {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      this.attachedTabs.add(tabId);
      if (!this.watchingDetach) {
        chrome.debugger.onDetach.addListener(({ tabId: detachedTab }) => {
          if (detachedTab !== undefined) this.attachedTabs.delete(detachedTab);
        });
        this.watchingDetach = true;
      }
      return true;
    } catch (error) {
      console.warn('[CDP] Attach failed:', error);
      return false;
    }
  }

  static async detach(tabId: number, recover = false): Promise<void> {
    let pending = this.detaching.get(tabId);
    if (!pending) {
      pending = (async () => {
        await this.attaching.get(tabId);
        if (this.attachedTabs.delete(tabId) || recover) await chrome.debugger.detach({ tabId });
      })().catch(() => {}).finally(() => this.detaching.delete(tabId));
      this.detaching.set(tabId, pending);
    }
    await runOperation(() => pending!, 1500, 'Disconnecting browser debugger').catch(() => {});
  }

  static command(tabId: number, method: string, params?: Record<string, unknown>): Promise<object | undefined> {
    return runOperation(() => chrome.debugger.sendCommand({ tabId }, method, params), 1500, 'Browser input');
  }

  static async click(tabId: number, x: number, y: number, validate: () => Promise<boolean>): Promise<boolean> {
    if (!await this.attach(tabId)) return false;
    let pressed = false;
    try {
      if (!await validate()) return false;
      await this.command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      if (!await validate()) return false;
      pressed = true;
      await this.command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
      });
      await this.command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
      });
      pressed = false;
      return true;
    } finally {
      if (pressed) {
        await this.command(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0,
        }).catch(() => {});
      }
    }
  }

  static async move(tabId: number, x: number, y: number, isCurrent: () => boolean): Promise<boolean> {
    if (!await this.attach(tabId) || !isCurrent()) return false;
    try {
      await this.command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      return true;
    } catch (error) {
      console.warn('[CDP] Move failed:', error);
      return false;
    }
  }

  static async drag(
    tabId: number, startX: number, startY: number, endX: number, endY: number, isCurrent: () => boolean,
    validate: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!await this.attach(tabId) || !isCurrent()) return false;
    let x = startX;
    let y = startY;
    let pressed = false;
    try {
      await this.command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      if (!isCurrent() || !await validate()) return false;
      pressed = true;
      await this.command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
      });
      for (let step = 1; step <= 8; step++) {
        if (!isCurrent()) return false;
        x = startX + (endX - startX) * step / 8;
        y = startY + (endY - startY) * step / 8;
        await this.command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 });
        await this.waitSettled(24);
      }
      if (!isCurrent()) return false;
      await this.command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
      });
      pressed = false;
      return true;
    } finally {
      if (pressed) {
        await this.command(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0,
        }).catch(() => {});
      }
    }
  }

  static async pressKey(tabId: number, key: string, isCurrent: () => boolean): Promise<boolean> {
    const namedKeys: Record<string, number> = {
      Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32,
      PageUp: 33, PageDown: 34, End: 35, Home: 36,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
    };
    if (key === 'Space') key = ' ';
    if (key === 'Esc') key = 'Escape';
    const code = key === ' ' ? 'Space'
      : /^[a-z]$/i.test(key) ? 'Key' + key.toUpperCase()
      : /^\d$/.test(key) ? 'Digit' + key
      : key.length === 1 ? undefined : key;
    const virtualKey = namedKeys[key] ?? (/^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined);
    if (key.length !== 1 && !virtualKey) return false;
    if (!await this.attach(tabId) || !isCurrent()) return false;

    const fields = { key, code, windowsVirtualKeyCode: virtualKey };
    const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
    let pressed = false;
    try {
      pressed = true;
      await this.command(tabId, 'Input.dispatchKeyEvent', {
        ...fields, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text,
      });
      await this.command(tabId, 'Input.dispatchKeyEvent', { ...fields, type: 'keyUp' });
      pressed = false;
      return true;
    } finally {
      if (pressed) await this.command(tabId, 'Input.dispatchKeyEvent', { ...fields, type: 'keyUp' }).catch(() => {});
    }
  }

  static async scroll(tabId: number, deltaY: number, x: number, y: number, isCurrent: () => boolean): Promise<boolean> {
    if (!await this.attach(tabId) || !isCurrent()) return false;
    try {
      await this.command(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: 0, deltaY,
      });
      return true;
    } catch (error) {
      console.warn('[CDP] Scroll failed:', error);
      return false;
    }
  }

  static async waitSettled(ms = 450): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }
}
