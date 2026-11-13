/**
 * Zero Sloppy Surfaces Audit Script
 * Verifies that assistant stream elements (.message-agent, .gemini-response-body, .action-summary)
 * do not contain messy boxed card panels or raw number borders.
 * (User message is right-aligned with bubble border per user preference).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cssPath = path.join(__dirname, '../src/sidepanel/sidepanel.css');

const cssContent = fs.readFileSync(cssPath, 'utf8');

function extractRule(content, selector) {
  const idx = content.indexOf(selector);
  if (idx === -1) return null;
  const start = content.indexOf('{', idx);
  if (start === -1) return null;
  const end = content.indexOf('}', start);
  if (end === -1) return null;
  return content.slice(start + 1, end);
}

const streamSelectors = [
  '.message-agent',
  '.action-summary',
  '.gemini-response-body',
];

let failed = false;

for (const selector of streamSelectors) {
  const rule = extractRule(cssContent, selector);
  if (!rule) continue;

  if (rule.includes('background:') && !rule.includes('background: transparent')) {
    console.error(`[No-Surfaces Violation] ${selector} has non-transparent background: ${rule.trim()}`);
    failed = true;
  }
  if (rule.includes('border:') && !rule.includes('border: none')) {
    console.error(`[No-Surfaces Violation] ${selector} has border: ${rule.trim()}`);
    failed = true;
  }
  if (rule.includes('box-shadow:')) {
    console.error(`[No-Surfaces Violation] ${selector} has box-shadow: ${rule.trim()}`);
    failed = true;
  }
}

if (failed) {
  console.error('[Audit FAILED] Stream surface violations detected.');
  process.exit(1);
} else {
  console.log('[Audit PASSED] Message stream is completely borderless with zero card boxes.');
}
