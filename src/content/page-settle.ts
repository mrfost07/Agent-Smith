/** Wait briefly for visible DOM changes, with a hard limit for animated pages. */
export function waitForPageSettle(action?: string): Promise<void> {
  return new Promise(resolve => {
    const minimumMs = action === 'type' || action === 'select' ? 120 :
      action === 'drag' || action === 'scroll' ? 280 : 180;
    const started = performance.now();
    let lastChange = started;
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        const element = record.target instanceof Element ? record.target : record.target.parentElement;
        return !element?.closest('antigravity-overlay-host');
      })) lastChange = performance.now();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const finish = () => {
      observer.disconnect();
      clearInterval(poll);
      clearTimeout(deadline);
      resolve();
    };
    // Leave time for a canvas move/scroll even when it produces no DOM mutations.
    const poll = setInterval(() => {
      const now = performance.now();
      if (now - started >= minimumMs && now - lastChange >= 80) finish();
    }, 20);
    const deadline = setTimeout(finish, 500);
  });
}
