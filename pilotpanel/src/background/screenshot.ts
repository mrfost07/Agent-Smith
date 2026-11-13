/**
 * PilotPanel: Screenshot Capture & Viewport Normalization
 * Captures visible tab, hides/restores page overlay, and downscales to max 1568px.
 * Computes DPR and coordinate scale metadata.
 */

import { ViewportScale, ToolResult } from '../shared/types';
import { logger } from '../shared/logger';

const MAX_LONGEST_EDGE = 1568;

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let chunkStr = '';
    for (let j = 0; j < chunk.length; j++) {
      chunkStr += String.fromCharCode(chunk[j]);
    }
    binary += chunkStr;
  }
  return btoa(binary);
}

export interface ScreenshotResult {
  base64: string;
  mimeType: 'image/jpeg';
  scale: ViewportScale;
}

export async function captureTabScreenshot(tabId: number): Promise<ToolResult<ScreenshotResult>> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) {
      return { ok: false, content: null as unknown as ScreenshotResult, error: 'Tab windowId not found.' };
    }

    // 1. Query tab viewport dimensions and DPR
    let viewportWidth = 1280;
    let viewportHeight = 800;
    let dpr = 1;

    try {
      const dimResp = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_DIMENSIONS' });
      if (dimResp && dimResp.ok && dimResp.content) {
        viewportWidth = dimResp.content.innerWidth;
        viewportHeight = dimResp.content.innerHeight;
        dpr = dimResp.content.devicePixelRatio || 1;
      }
    } catch {
      logger.debug('Screenshot', 'Unable to query dimensions from content script, using fallback defaults.');
    }

    // 2. Hide overlay prior to capture
    await chrome.tabs.sendMessage(tabId, { type: 'SET_OVERLAY_VISIBLE', visible: false }).catch(() => {});
    await new Promise((r) => setTimeout(r, 60));

    // 3. Capture visible tab
    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    } finally {
      // 4. Restore overlay immediately
      await chrome.tabs.sendMessage(tabId, { type: 'SET_OVERLAY_VISIBLE', visible: true }).catch(() => {});
    }

    // 5. Decode and downscale if max dimension exceeds 1568px
    const rawBlob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(rawBlob);

    const origWidth = bitmap.width;
    const origHeight = bitmap.height;
    const longestEdge = Math.max(origWidth, origHeight);

    let scaledWidth = origWidth;
    let scaledHeight = origHeight;
    let base64Output = '';

    if (longestEdge > MAX_LONGEST_EDGE) {
      const ratio = MAX_LONGEST_EDGE / longestEdge;
      scaledWidth = Math.round(origWidth * ratio);
      scaledHeight = Math.round(origHeight * ratio);

      const canvas = new OffscreenCanvas(scaledWidth, scaledHeight);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, scaledWidth, scaledHeight);
      }
      bitmap.close();

      const downscaledBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      base64Output = await blobToBase64(downscaledBlob);
    } else {
      bitmap.close();
      const commaIdx = dataUrl.indexOf(',');
      base64Output = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
    }

    const scale: ViewportScale = {
      viewportWidth,
      viewportHeight,
      scaledWidth,
      scaledHeight,
      dpr,
    };

    return {
      ok: true,
      content: {
        base64: base64Output,
        mimeType: 'image/jpeg',
        scale,
      },
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Screenshot', 'Failed to capture screenshot', errorMsg);
    return {
      ok: false,
      content: null as unknown as ScreenshotResult,
      error: `Screenshot failed: ${errorMsg}`,
    };
  }
}
