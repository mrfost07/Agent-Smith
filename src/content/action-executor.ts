import { DOMObserver } from './dom-observer';
import { ElementAnnotator } from './element-annotator';
import { EMBEDDED_ASSISTANT_BLOCK, isEmbeddedAssistantControl } from './embedded-assistant';

interface Point {
  x: number;
  y: number;
}

export interface ActionExecutionResult {
  success: boolean;
  message: string;
  coords?: Point;
  failure?: 'stale_observation' | 'stale_target' | 'disabled_target' | 'unreachable_target' | 'embedded_assistant';
}

interface PageAction {
  type: string;
  targetIndex?: number;
  selector?: string;
  x?: number;
  y?: number;
  text?: string;
  value?: string;
  direction?: 'up' | 'down';
  amount?: number;
  showCursor?: boolean;
  key?: string;
}

export class ActionExecutor {
  private static clickTarget: Element | null = null;
  private static clickTargetIndex?: number;
  private static coordinateClick = false;

  private static assistantBlocked(): ActionExecutionResult {
    return { success: false, failure: 'embedded_assistant',
      message: EMBEDDED_ASSISTANT_BLOCK };
  }

  static isActionTargetReady(action: PageAction, observationId?: string): boolean {
    if (!DOMObserver.isCurrentObservation(observationId)) return false;
    const target = this.resolveTarget(action);
    if (target) {
      return this.canInteract(target) && (action.type === 'press_key' || Boolean(this.findHitPoint(target)));
    }
    return action.targetIndex === undefined && !action.selector && Boolean(this.resolvePointer(action, null));
  }

  static async execute(action: PageAction, observationId?: string, allowEmbeddedAssistant = false): Promise<ActionExecutionResult> {
    if (!DOMObserver.isCurrentObservation(observationId)) {
      return { success: false, failure: 'stale_observation', message: 'The page changed. Observe it again before acting.' };
    }

    const hasTarget = action.targetIndex !== undefined || Boolean(action.selector);
    const target = this.resolveTarget(action);
    if (hasTarget && !target) {
      return { success: false, failure: 'stale_target', message: 'The target is no longer available. Find its current control in a new observation.' };
    }
    if (target && !this.canInteract(target)) {
      return { success: false, failure: 'disabled_target', message: 'The target is disabled or inside an inactive region.' };
    }

    switch (action.type) {
      case 'click':
      case 'hover': {
        const coords = this.resolvePointer(action, target);
        if (!coords) return this.pointerFailure(target, action);
        if (action.type === 'click') {
          const hit = this.hitAt(coords);
          if (!allowEmbeddedAssistant && isEmbeddedAssistantControl(hit)) return this.assistantBlocked();
          this.clickTarget = target ?? hit;
          this.clickTargetIndex = action.targetIndex;
          this.coordinateClick = target === null;
        }
        if (action.showCursor !== false) ElementAnnotator.moveVisualCursorTo(coords.x, coords.y);
        return { success: true, message: 'Pointer target resolved.', coords };
      }
      case 'type': {
        if (!target || !DOMObserver.acceptsText(target) || typeof action.text !== 'string') {
          return { success: false, message: 'No editable text target.' };
        }
        if (!allowEmbeddedAssistant && isEmbeddedAssistantControl(target)) return this.assistantBlocked();
        const coords = this.resolvePointer(action, target);
        if (!coords) return this.pointerFailure(target);
        if (action.showCursor !== false) ElementAnnotator.moveVisualCursorTo(coords.x, coords.y);
        return this.replaceText(target, action.text);
      }
      case 'press_key': {
        if (!allowEmbeddedAssistant && isEmbeddedAssistantControl(target ?? document.activeElement)) return this.assistantBlocked();
        if (!target) return { success: true, message: 'Using the current keyboard focus.' };
        target.focus();
        const root = target.getRootNode() as Document | ShadowRoot;
        const focused = root.activeElement === target || Boolean(root.activeElement && target.contains(root.activeElement));
        return { success: focused, message: focused ? 'Keyboard target focused.' : 'The target could not be focused.' };
      }
      case 'select': {
        if (!(target instanceof HTMLSelectElement)) {
          return { success: false, message: 'No enabled native dropdown found.' };
        }
        const coords = this.resolvePointer(action, target);
        if (!coords) return this.pointerFailure(target);
        if (action.showCursor !== false) ElementAnnotator.moveVisualCursorTo(coords.x, coords.y);
        return this.selectOption(target, action.value ?? action.text ?? '');
      }
      case 'scroll': {
        const point = this.resolvePointer(action, target);
        if (target && !point) return this.pointerFailure(target);
        if ((action.x !== undefined || action.y !== undefined) && !point) {
          return { success: false, message: 'Scroll coordinates are outside the observed viewport.' };
        }
        return {
          success: true,
          message: 'Scroll target resolved.',
          coords: point ?? { x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) },
        };
      }
      case 'wait': {
        await new Promise(resolve => setTimeout(resolve, action.amount ?? 1500));
        return { success: true, message: 'Wait finished.' };
      }
      default:
        return { success: false, message: 'Unknown action: ' + action.type };
    }
  }

  private static pointerFailure(target: HTMLElement | null, action?: PageAction): ActionExecutionResult {
    const failure = { success: false, failure: 'unreachable_target' as const };
    if (!target) {
      if (!DOMObserver.isObservedViewport()) {
        return { success: false, failure: 'stale_observation',
          message: 'The viewport moved or resized after the page was observed. Take a fresh observation before using coordinates.' };
      }
      if (!this.isViewportPoint(action?.x, action?.y)) {
        return { ...failure, message: `The action has missing or out-of-bounds coordinates for the ${window.innerWidth} × ${window.innerHeight} viewport. Choose a current control.` };
      }
      return { ...failure, message: 'The point has no actionable target. Use a control from the latest observation.' };
    }

    const rect = target.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) {
      return { ...failure, message: 'The target is outside the viewport after scrolling it into view.' };
    }
    const hit = this.hitAt({ x: (left + right) / 2, y: (top + bottom) / 2 });
    const surface = hit?.closest('dialog, [role="dialog"], [role="alertdialog"]') ?? hit;
    const label = hit !== target && !target.contains(hit) &&
      (surface?.getAttribute('aria-label') || surface?.getAttribute('role') || surface?.localName);
    return { ...failure, message: 'No visible, unobstructed point for this target.' +
      (label ? ' Its center is hit-tested on ' + label.slice(0, 100) + '.' : '') };
  }

  static validateClickPoint(point: Point, observationId?: string, allowEmbeddedAssistant = false): boolean {
    const target = this.clickTarget;
    if (this.clickTargetIndex !== undefined && DOMObserver.getObservedElement(this.clickTargetIndex) !== target) return false;
    if (this.coordinateClick && !DOMObserver.isObservedViewport()) return false;
    return DOMObserver.isCurrentObservation(observationId) && Boolean(target && this.canInteract(target)
      && this.isViewportPoint(point.x, point.y) && this.hitsTarget(point, target)
      && (allowEmbeddedAssistant || !isEmbeddedAssistantControl(this.hitAt(point))));
  }

  static isViewportPoint(x: unknown, y: unknown): boolean {
    return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
      && x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
  }

  private static resolveTarget(action: PageAction): HTMLElement | null {
    if (action.targetIndex !== undefined) return DOMObserver.getObservedElement(action.targetIndex);
    if (!action.selector) return null;
    try {
      const matches = document.querySelectorAll(action.selector);
      return matches.length === 1 && matches[0] instanceof HTMLElement ? matches[0] : null;
    } catch {
      return null;
    }
  }

  private static resolvePointer(action: PageAction, target: HTMLElement | null): Point | undefined {
    if (!target) {
      const { x, y } = action;
      if (x === undefined || y === undefined || !this.isViewportPoint(x, y) || !DOMObserver.isObservedViewport()) return;
      const hit = this.hitAt({ x, y });
      return hit && this.canInteract(hit) && hit.localName !== 'antigravity-overlay-host' ? { x, y } : undefined;
    }
    if (!this.canInteract(target)) return;

    const currentPoint = this.findHitPoint(target);
    if (currentPoint) return currentPoint;

    const bounds = target.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    return this.findHitPoint(target);
  }

  private static canInteract(element: Element): boolean {
    return element.isConnected && !element.closest(':disabled, [inert], [aria-disabled="true"]');
  }

  private static findHitPoint(target: HTMLElement): Point | undefined {
    for (const rect of Array.from(target.getClientRects())) {
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      if (right <= left || bottom <= top) continue;
      const offsets = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
      for (const [dx, dy] of offsets) {
        const point = { x: left + (right - left) * dx, y: top + (bottom - top) * dy };
        if (this.hitsTarget(point, target)) return point;
      }
    }
  }

  private static hitsTarget(point: Point, target: Element): boolean {
    let hit = this.hitAt(point);
    while (hit) {
      if (hit === target) return true;
      const root = hit.getRootNode();
      hit = hit.assignedSlot ?? hit.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    return false;
  }

  private static hitAt(point: Point): Element | null {
    let hit = document.elementFromPoint(point.x, point.y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  private static replaceText(target: HTMLElement, text: string): ActionExecutionResult {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.focus();
      const prototype = target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(target, text);
    } else {
      target.focus();
      target.textContent = text;
    }

    target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    const value = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : target.textContent;
    return value === text
      ? { success: true, message: 'Text entered and checked.' }
      : { success: false, message: 'The field did not retain the requested text.' };
  }

  private static selectOption(target: HTMLSelectElement, value: string): ActionExecutionResult {
    const label = value.trim().toLowerCase();
    const options = Array.from(target.options).filter(option => !option.disabled && !option.closest('optgroup[disabled]'));
    const matches = options.filter(option => option.value === value);
    const candidates = matches.length ? matches : options.filter(option => option.text.trim().toLowerCase() === label);
    if (candidates.length !== 1) return { success: false, message: 'No unique enabled option matches.' };

    target.selectedIndex = candidates[0].index;
    target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return target.selectedIndex === candidates[0].index
      ? { success: true, message: 'Dropdown selection verified.' }
      : { success: false, message: 'The dropdown did not retain the selection.' };
  }
}
