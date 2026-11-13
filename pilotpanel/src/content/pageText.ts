/**
 * PilotPanel: Main Page Text Extractor
 * Heuristics picking the longest text from article, main, role=main, and content containers.
 * Cleans boilerplate and formats with Title and URL.
 */

const PRIORITY_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#main-content',
  '#content',
  '.main-content',
  '.content',
  '.post-content',
  '.article-body',
  '.entry-content',
];

const IGNORED_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER', 'HEADER', 'ASIDE'];

/**
 * Extracts visible text content while ignoring noisy tags.
 */
function cleanNodeText(root: Element): string {
  const clone = root.cloneNode(true) as Element;

  for (const tag of IGNORED_TAGS) {
    const elements = clone.getElementsByTagName(tag);
    while (elements.length > 0) {
      elements[0].parentNode?.removeChild(elements[0]);
    }
  }

  // Remove our extension overlay if cloned
  const overlay = clone.querySelector('#__pilotpanel_overlay_root__');
  if (overlay) overlay.remove();

  const raw = (clone as HTMLElement).innerText || clone.textContent || '';
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Finds the candidate with the highest concentration of readable text.
 */
export function extractPageText(): string {
  const doc = document;
  const title = doc.title || 'Untitled';
  const url = window.location.href;

  let bestText = '';
  let maxLen = 0;

  for (const selector of PRIORITY_SELECTORS) {
    const candidates = Array.from(doc.querySelectorAll(selector));
    for (const el of candidates) {
      const text = cleanNodeText(el);
      if (text.length > maxLen) {
        maxLen = text.length;
        bestText = text;
      }
    }
  }

  // Fallback to document.body if no priority selector yielded substantial content
  if (maxLen < 120 && doc.body) {
    bestText = cleanNodeText(doc.body);
  }

  // Enforce max 50,000 characters to prevent context window explosion
  const MAX_TEXT_LENGTH = 50000;
  let truncatedNotice = '';
  if (bestText.length > MAX_TEXT_LENGTH) {
    bestText = bestText.slice(0, MAX_TEXT_LENGTH);
    truncatedNotice = '\n\n[Content truncated at 50,000 characters]';
  }

  return `Title: ${title}\nURL: ${url}\n\n${bestText}${truncatedNotice}`;
}
