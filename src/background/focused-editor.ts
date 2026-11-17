export interface FocusedEditor {
  documentId: string;
  token: string;
  label: string;
}

interface EditorRequest {
  token: string;
  text: string;
}

// Chrome serializes this function into the document's isolated world.
export function inspectFocusedEditor(request?: EditorRequest): { token: string; label: string; written?: boolean } | null {
  if (!document.hasFocus()) return null;
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const editor = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? active : active.closest<HTMLElement>('[contenteditable]');
  if (!editor || !editor.isConnected || !editor.getClientRects().length ||
      editor.closest(':disabled, [inert], [aria-disabled="true"], [aria-readonly="true"]')) return null;
  if (getComputedStyle(editor).visibility !== 'visible') return null;
  if (editor instanceof HTMLInputElement) {
    if (editor.readOnly || !['text', 'search', 'url', 'tel', 'email', 'number'].includes(editor.type)) return null;
  } else if (editor instanceof HTMLTextAreaElement ? editor.readOnly : !editor.isContentEditable) {
    return null;
  }

  const frame = globalThis as typeof globalThis & { __smithFocusedEditor?: { element: HTMLElement; token: string } };
  if (!request && frame.__smithFocusedEditor?.element !== editor) {
    frame.__smithFocusedEditor = { element: editor, token: `${performance.now()}-${Math.random()}` };
  }
  const known = frame.__smithFocusedEditor;
  if (!known || known.element !== editor || (request && known.token !== request.token)) return null;
  const result = { token: known.token, label: (editor.getAttribute('aria-label') ||
    editor.getAttribute('placeholder') || editor.getAttribute('name') || editor.localName).slice(0, 100) };
  if (!request) return result;

  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    const prototype = editor instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(editor, request.text);
  } else {
    editor.textContent = request.text;
  }
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: request.text }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  const value = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent;
  return { ...result, written: editor.isConnected && value === request.text };
}
