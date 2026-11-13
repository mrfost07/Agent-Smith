/**
 * Zero Emoji Audit Script
 * Fails the build if any emoji or decorative dingbat is found in src/sidepanel.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetDir = path.join(__dirname, '../src/sidepanel');

const emojiRegex = /[\p{Extended_Pictographic}\u2600-\u27BF]/u;

let hasViolations = false;

function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath);
    } else if (file.endsWith('.ts') || file.endsWith('.html') || file.endsWith('.css') || file.endsWith('.tsx')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, index) => {
        // Skip comments or test strings if any
        if (emojiRegex.test(line)) {
          // Allow regex definitions
          if (line.includes('Extended_Pictographic') || line.includes('stripEmoji')) return;
          console.error(`[No-Emoji Violation] ${path.relative(__dirname, fullPath)}:${index + 1}: ${line.trim()}`);
          hasViolations = true;
        }
      });
    }
  }
}

console.log('[Audit] Scanning src/sidepanel for emoji violations...');
scanDir(targetDir);

if (hasViolations) {
  console.error('[Audit FAILED] Emoji characters detected in side panel sources.');
  process.exit(1);
} else {
  console.log('[Audit PASSED] Zero emojis found in side panel sources.');
}
