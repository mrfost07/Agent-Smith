/**
 * PilotPanel: Accessible Element Tree Builder
 * Performs recursive DOM traversal (light DOM, open shadow roots, same-origin iframes).
 * Allocates stable ref_N identifiers stored in a WeakRef registry.
 */

export class PageRefRegistry {
  private static refMap = new Map<string, WeakRef<Element>>();
  private static elementMap = new WeakMap<Element, string>();
  private static counter = 1;

  static getOrCreateRef(el: Element): string {
    const existing = this.elementMap.get(el);
    if (existing && this.refMap.has(existing)) {
      const derefed = this.refMap.get(existing)?.deref();
      if (derefed && derefed.isConnected) {
        return existing;
      }
    }
    const ref = `ref_${this.counter++}`;
    this.elementMap.set(el, ref);
    this.refMap.set(ref, new WeakRef(el));
    return ref;
  }

  static getElement(ref: string): Element | null {
    const weak = this.refMap.get(ref);
    if (!weak) return null;
    const el = weak.deref();
    if (!el || !el.isConnected) {
      this.refMap.delete(ref);
      return null;
    }
    return el;
  }

  static clear(): void {
    this.refMap.clear();
    this.counter = 1;
  }
}

export type TreeFilter = 'interactive' | 'all';

export interface TreeOptions {
  filter?: TreeFilter;
  refId?: string;
  maxDepth?: number;
  maxChars?: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'textbox',
  'searchbox',
  'menuitem',
  'tab',
  'switch',
  'option',
  'slider',
  'spinbutton',
]);

const INTERACTIVE_TAGS = new Set([
  'BUTTON',
  'SELECT',
  'TEXTAREA',
  'INPUT',
  'SUMMARY',
]);

/**
 * Determines whether an element is inherently interactive or focusable.
 */
function isInteractive(el: Element): boolean {
  const tag = el.tagName;
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === 'A' && el.hasAttribute('href')) return true;

  const role = el.getAttribute('role')?.toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  if (el.hasAttribute('onclick')) return true;

  const tabIndex = el.getAttribute('tabindex');
  if (tabIndex !== null && tabIndex !== '-1') return true;

  if ((el as HTMLElement).isContentEditable) return true;

  try {
    const win = el.ownerDocument.defaultView;
    if (win) {
      const style = win.getComputedStyle(el);
      if (style.cursor === 'pointer') return true;
    }
  } catch {
    // getComputedStyle may fail in detached elements
  }

  return false;
}

/**
 * Checks if an element is visible in the viewport or layout.
 */
function isVisible(el: Element): boolean {
  if (el instanceof HTMLElement) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && !el.getClientRects().length) {
      return false;
    }
  } else if (el instanceof SVGElement) {
    if (!el.getClientRects().length) {
      return false;
    }
  } else {
    return false;
  }
  try {
    const win = el.ownerDocument.defaultView;
    if (win) {
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
    }
  } catch {
    // Ignore style read issues
  }
  return true;
}

/**
 * Derives accessible role from standard tags and ARIA.
 */
function deriveRole(el: Element): string {
  const explicitRole = el.getAttribute('role')?.trim().toLowerCase();
  if (explicitRole) return explicitRole;

  const tag = el.tagName.toUpperCase();
  switch (tag) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'BUTTON':
      return 'button';
    case 'INPUT': {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'fileinput';
      return 'textbox';
    }
    case 'TEXTAREA':
      return 'textbox';
    case 'SELECT':
      return 'combobox';
    case 'OPTION':
      return 'option';
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading';
    case 'IMG':
      return 'image';
    case 'NAV':
      return 'navigation';
    case 'MAIN':
      return 'main';
    case 'HEADER':
      return 'banner';
    case 'FOOTER':
      return 'contentinfo';
    case 'ARTICLE':
      return 'article';
    case 'SECTION':
      return 'region';
    case 'DIALOG':
      return 'dialog';
    case 'FORM':
      return 'form';
    case 'UL':
    case 'OL':
      return 'list';
    case 'LI':
      return 'listitem';
    case 'TABLE':
      return 'table';
    case 'TH':
      return 'columnheader';
    case 'TR':
      return 'row';
    case 'TD':
      return 'cell';
    case 'SUMMARY':
      return 'button';
    case 'P':
      return 'paragraph';
    default:
      return 'generic';
  }
}

/**
 * Computes accessible name according to priority:
 * 1. aria-label
 * 2. aria-labelledby
 * 3. placeholder
 * 4. title
 * 5. alt
 * 6. associated <label>
 * 7. trimmed visible text
 */
function deriveAccessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return cleanText(ariaLabel);

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const names = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() || '')
      .filter(Boolean);
    if (names.length > 0) return cleanText(names.join(' '));
  }

  const placeholder = el.getAttribute('placeholder')?.trim();
  if (placeholder) return cleanText(placeholder);

  const title = el.getAttribute('title')?.trim();
  if (title) return cleanText(title);

  const alt = el.getAttribute('alt')?.trim();
  if (alt) return cleanText(alt);

  // Associated label check
  if (el.id) {
    const labelEl = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (labelEl && labelEl.textContent) {
      return cleanText(labelEl.textContent);
    }
  }
  const parentLabel = el.closest('label');
  if (parentLabel && parentLabel !== el) {
    const cloned = parentLabel.cloneNode(true) as HTMLElement;
    cloned.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
    const labelText = cloned.textContent?.trim();
    if (labelText) return cleanText(labelText);
  }

  // Text content for buttons, links, headings, options
  const tag = el.tagName.toUpperCase();
  if (['BUTTON', 'A', 'OPTION', 'SUMMARY', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) {
    const text = el.textContent?.trim();
    if (text) return cleanText(text);
  }

  return '';
}

function cleanText(str: string): string {
  const normalized = str.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

/**
 * Builds key=value attribute string for a DOM node.
 */
function buildAttributes(el: Element, role: string): string {
  const parts: string[] = [];

  if (role === 'link') {
    const href = el.getAttribute('href');
    if (href) parts.push(`href="${href}"`);
  }

  if (role === 'heading') {
    const match = el.tagName.match(/^H([1-6])$/i);
    if (match) parts.push(`level=${match[1]}`);
  }

  if (el instanceof HTMLInputElement) {
    if (['checkbox', 'radio'].includes(el.type)) {
      parts.push(`checked=${el.checked}`);
    } else if (el.value) {
      parts.push(`value="${cleanText(el.value)}"`);
    }
    if (el.disabled) parts.push('disabled=true');
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value) parts.push(`value="${cleanText(el.value)}"`);
    if (el.disabled) parts.push('disabled=true');
  } else if (el instanceof HTMLSelectElement) {
    parts.push(`value="${el.value}"`);
    if (el.disabled) parts.push('disabled=true');
    // List options
    const options = Array.from(el.options)
      .slice(0, 15)
      .map((opt) => `[value="${opt.value}", text="${cleanText(opt.text)}"]`);
    if (options.length > 0) {
      parts.push(`options=[${options.join(', ')}]`);
    }
  } else if (el instanceof HTMLButtonElement && el.disabled) {
    parts.push('disabled=true');
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Recursively walks a DOM subtree to produce the structured element tree.
 */
export function buildElementTree(options: TreeOptions = {}): string {
  const filter = options.filter || 'interactive';
  const maxDepth = Math.min(options.maxDepth || 15, 15);
  const maxChars = options.maxChars || 50000;

  let rootElement: Element | null = document.body;
  if (options.refId) {
    rootElement = PageRefRegistry.getElement(options.refId);
    if (!rootElement) {
      throw new Error(`Ref "${options.refId}" not found or element is no longer attached.`);
    }
  }

  if (!rootElement) {
    return 'Empty document';
  }

  const lines: string[] = [];
  let accumulatedChars = 0;

  function traverse(node: Element, depth: number): void {
    if (depth > maxDepth) return;
    if (!isVisible(node)) return;

    // Check character budget
    if (accumulatedChars > maxChars) {
      throw new Error(
        `Element tree exceeded ${maxChars} characters (accumulated: ${accumulatedChars}). ` +
          `Try passing ref_id to inspect a specific subtree, set filter="interactive", or reduce max_depth.`
      );
    }

    const interactiveNode = isInteractive(node);
    const role = deriveRole(node);
    const name = deriveAccessibleName(node);

    const shouldInclude =
      filter === 'all'
        ? role !== 'generic' || name.length > 0 || interactiveNode
        : interactiveNode;

    if (shouldInclude) {
      const ref = PageRefRegistry.getOrCreateRef(node);
      const indent = '  '.repeat(depth);
      const namePart = name ? ` "${name}"` : '';
      const attrPart = buildAttributes(node, role);
      const line = `${indent}${role}${namePart} [${ref}]${attrPart}`;
      lines.push(line);
      accumulatedChars += line.length + 1;
    }

    // Traverse shadow root if present and open
    if (node.shadowRoot) {
      const shadowChildren = Array.from(node.shadowRoot.children);
      for (const child of shadowChildren) {
        traverse(child, depth + 1);
      }
    }

    // Traverse same-origin iframes
    if (node instanceof HTMLIFrameElement) {
      try {
        const frameDoc = node.contentDocument;
        if (frameDoc && frameDoc.body) {
          traverse(frameDoc.body, depth + 1);
        }
      } catch {
        // Cross-origin iframe inaccessible
        const indent = '  '.repeat(depth + 1);
        lines.push(`${indent}[cross-origin iframe: ${node.src || 'unspecified'}]`);
      }
    }

    // Traverse light DOM child elements
    const children = Array.from(node.children);
    for (const child of children) {
      // Skip pilotpanel injected overlay
      if (child.id === '__pilotpanel_overlay_root__') continue;
      traverse(child, shouldInclude ? depth + 1 : depth);
    }
  }

  traverse(rootElement, 0);

  if (lines.length === 0) {
    return '(No interactive elements found)';
  }

  return lines.join('\n');
}
