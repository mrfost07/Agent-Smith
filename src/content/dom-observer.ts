/**
 * DOM Observer & State Extractor
 * Inspects the webpage and returns clean, structured interactive elements.
 * Pierces Shadow DOM trees and extracts rich context for job portals & forms.
 */

export interface InteractiveElementData {
  index: number;
  tag: string;
  role?: string;
  type?: string;
  text: string;
  selector: string;
  name?: string;
  placeholder?: string;
  value?: string;
  ariaLabel?: string;
  href?: string;
  controlState?: string;
  dialog?: string;
  editable?: boolean;
  isVisible: boolean;
  rect: { top: number; left: number; width: number; height: number };
}

export class DOMObserver {
  private static readonly documentKey = Math.random().toString(36).slice(2);
  private static observation = 0;
  private static observedUrl = '';
  private static observedViewport = this.viewportSignature();
  private static observedElements: HTMLElement[] = [];
  private static observedIdentities: string[] = [];

  private static viewportSignature(): string {
    return [window.innerWidth, window.innerHeight, window.scrollX, window.scrollY, window.devicePixelRatio,
      window.visualViewport?.offsetLeft, window.visualViewport?.offsetTop, window.visualViewport?.scale].join();
  }

  static isCurrentObservation(id?: string): boolean {
    return id === undefined || (id === this.documentKey + ':' + this.observation && window.location.href === this.observedUrl);
  }

  static isObservedViewport(): boolean {
    return this.observedViewport === this.viewportSignature();
  }

  static getObservedElement(index: number): HTMLElement | null {
    const element = this.observedElements[index];
    return element?.isConnected && this.identity(element) === this.observedIdentities[index] ? element : null;
  }

  private static identity(element: HTMLElement): string {
    return JSON.stringify([
      element.getAttribute('type'), element.getAttribute('aria-label'), element.getAttribute('title'),
      element.getAttribute('href'), element.getAttribute('name'), this.getElementText(element),
    ]);
  }
  private static INTERACTIVE_SELECTORS = [
    'button',
    'input',
    'textarea',
    'select',
    'a[href]',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="listbox"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[tabindex]:not([tabindex="-1"])',
    'canvas',
    'svg',
    '[data-square]',
    '[data-piece]',
    '.piece',
    '.square',
    'chess-board',
    'wc-chess-board',
    '[role="gridcell"]',
    'label',
    '.btn',
    '.button',
    '[data-action]',
  ];

  static extractPageState(): {
    url: string;
    title: string;
    interactiveElements: InteractiveElementData[];
    visibleTextSummary: string;
    observationId: string;
    viewport: { width: number; height: number };
  } {
    this.observation++;
    this.observedUrl = window.location.href;
    this.observedViewport = this.viewportSignature();
    this.observedElements = [];
    this.observedIdentities = [];
    const interactiveElements: InteractiveElementData[] = [];
    const dialogs = new Map<Element, string>();
    let counter = 0;

    const offscreen: HTMLElement[] = [];
    const onscreen: HTMLElement[] = [];
    for (const htmlEl of this.interactiveElements()) {
      if (!this.isElementVisible(htmlEl)) continue;
      const rect = htmlEl.getBoundingClientRect();
      if (rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight) {
        onscreen.push(htmlEl);
        if (onscreen.length === 120) break;
      } else if (offscreen.length < 120) {
        offscreen.push(htmlEl);
      }
    }

    for (const htmlEl of [...onscreen, ...offscreen].slice(0, 120)) {
      const rect = htmlEl.getBoundingClientRect();
      const text = this.getElementText(htmlEl);
      const tag = htmlEl.tagName.toLowerCase();
      const type = (htmlEl as HTMLInputElement).type || undefined;
      const name = (htmlEl as HTMLInputElement).name || undefined;
      const placeholder = (htmlEl as HTMLInputElement).placeholder || undefined;
      const associatedLabels = (htmlEl as HTMLInputElement).labels;
      const labelledBy = htmlEl.getAttribute('aria-labelledby')?.trim().split(/\s+/).map(id => {
        const label = (htmlEl.getRootNode() as Document | ShadowRoot).getElementById(id);
        return label?.textContent?.trim();
      }).filter(Boolean).join(' ');
      const ariaLabel = htmlEl.getAttribute('aria-label') ||
        labelledBy ||
        (associatedLabels && Array.from(associatedLabels, label => this.getElementText(label)).join(' ')) ||
        htmlEl.getAttribute('title') || undefined;
      const href = htmlEl instanceof HTMLAnchorElement ? htmlEl.href : undefined;
      const controlState = htmlEl.closest(':disabled, [inert], [aria-disabled="true"]') ? 'disabled' :
        htmlEl instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio') ?
          (htmlEl.checked ? 'checked' : 'unchecked') :
        htmlEl instanceof HTMLSelectElement ?
          Array.from(htmlEl.selectedOptions, option => this.getElementText(option)).join(', ').slice(0, 120) :
          htmlEl.getAttribute('aria-selected') === 'true' ? 'selected' :
          htmlEl.getAttribute('aria-checked') === 'true' ? 'checked' :
          htmlEl.getAttribute('aria-expanded') === 'true' ? 'expanded' : undefined;
      const dialog = htmlEl.closest('dialog, [role="dialog"], [role="alertdialog"]');
      if (dialog && !dialogs.has(dialog)) {
        const heading = dialog.querySelector('h1, h2, h3, [role="heading"]');
        dialogs.set(dialog, (dialog.getAttribute('aria-label') || heading?.textContent?.trim() || 'Dialog').slice(0, 100));
      }

      this.observedElements.push(htmlEl);
      this.observedIdentities.push(this.identity(htmlEl));

      interactiveElements.push({
        index: counter,
        tag,
        role: htmlEl.getAttribute('role') || undefined,
        type,
        text,
        selector: this.generateUniqueSelector(htmlEl),
        name,
        placeholder,
        ariaLabel,
        href,
        controlState,
        editable: controlState !== 'disabled' && this.acceptsText(htmlEl) || undefined,
        dialog: dialog ? dialogs.get(dialog) : undefined,
        isVisible: true,
        rect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });

      counter++;
    }

    return {
      url: window.location.href,
      title: document.title,
      interactiveElements,
      visibleTextSummary: this.getCleanVisibleText(),
      observationId: this.documentKey + ':' + this.observation,
      viewport: {
        width: window.innerWidth || document.documentElement.clientWidth || 1280,
        height: window.innerHeight || document.documentElement.clientHeight || 800,
      },
    };
  }

  static acceptsText(element: HTMLElement): boolean {
    if (element instanceof HTMLTextAreaElement) return !element.readOnly;
    if (element instanceof HTMLInputElement) {
      return !element.readOnly && ['text', 'search', 'email', 'tel', 'url', 'number', 'password', 'date', 'time', 'datetime-local', 'month', 'week'].includes(element.type);
    }
    return element.isContentEditable && element.matches('[contenteditable]');
  }

  private static *interactiveElements(): Generator<HTMLElement> {
    const selector = this.INTERACTIVE_SELECTORS.join(', ');
    const walkers = [document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)];
    for (let visited = 0; walkers.length && visited < 12_000;) {
      const element = walkers.at(-1)!.nextNode();
      if (!element) {
        walkers.pop();
        continue;
      }
      visited++;
      if (!(element instanceof HTMLElement)) continue;
      if (element.matches(selector)) yield element;
      if (element.shadowRoot) {
        walkers.push(document.createTreeWalker(element.shadowRoot, NodeFilter.SHOW_ELEMENT));
      }
    }
  }

  private static isElementVisible(el: HTMLElement): boolean {
    if (!el.offsetParent && el.tagName.toLowerCase() !== 'body') {
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return true;
  }

  private static getElementText(el: HTMLElement): string {
    const text = el.innerText || el.textContent || '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 100);
  }

  private static generateUniqueSelector(el: HTMLElement): string {
    if (el.getRootNode() !== document) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.getAttribute('name')) return `[name="${CSS.escape(el.getAttribute('name')!)}"]`;

    return '';
  }

  private static getCleanVisibleText(): string {
    const main = document.querySelector<HTMLElement>('main, [role="main"], article');
    const dialog = document.querySelector<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]');
    const clean = (value: string) => value.replace(/[^\S\n]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    const primary = clean(main?.innerText || '');
    const modal = clean(dialog?.innerText || '').slice(0, 1100);
    const body = primary.length >= 100 ? primary : clean(document.body.innerText || '');
    return [modal && !body.startsWith(modal) ? modal : '', body].filter(Boolean).join('\n').slice(0, 6200);
  }
}
