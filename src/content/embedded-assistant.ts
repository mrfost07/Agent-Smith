export const EMBEDDED_ASSISTANT_BLOCK = 'This control belongs to an embedded AI composer. Use the application controls to build and verify the requested result directly.';

/** Identify an embedded AI composer by its nearby UI, without matching a site or URL. */
export function isEmbeddedAssistantControl(element?: Element | null): boolean {
  if (element === undefined) {
    element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  }
  if (!element?.matches) return false;
  const fieldSelector = 'textarea, [contenteditable], [role="textbox"], input:not([type="hidden"])';
  let region: Element | null = element;
  for (let depth = 0; region && depth < 7; depth++, region = region.parentElement) {
    if (region.matches('body, html, main, [role="main"]')) break;
    const field: Element | null = region.matches(fieldSelector) ? region : region.querySelector(fieldSelector);
    if (!field?.getClientRects().length) continue;
    for (let panel: Element | null = field; panel; panel = panel.parentElement) {
      const metadata = [panel.getAttribute('aria-label'), panel.getAttribute('title')].filter(Boolean).join(' ');
      const text = panel === field ? '' : panel.textContent?.trim() || '';
      const description = metadata + (text.length <= 650 ? ' ' + text.replace(field.textContent || '', '') : '');
      if (/\b(?:(?:chat(?:ting)?|generat\w*) with ai|ai (?:[\w-]+ ){0,2}(?:assistant|copilot|prompt|builder|generator))\b/i.test(description)) {
        if (panel.contains(element)) return true;
        if (panel !== field) return false;
        if (field.closest('form')?.contains(element)) return true;
      }
      if (panel === region) break;
    }
  }
  return false;
}
