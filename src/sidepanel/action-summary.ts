export interface ActionOutcome {
  type: string;
  url?: string;
  success: boolean;
}

const actionLabels: Record<string, string> = {
  search_web: 'searched the web',
  click: 'clicked a page control',
  drag: 'dragged an element',
  type: 'entered text',
  select: 'selected an option',
  scroll: 'scrolled the page',
  hover: 'hovered over an element',
  press_key: 'used a keyboard shortcut',
  upload_file: 'attached a file',
  tailor_resume: 'prepared a tailored resume',
  wait: 'waited for the page',
};

const list = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

export function summarizeActions(actions: ActionOutcome[]): string {
  const descriptions = new Set<string>();
  const sites = new Set<string>();
  let failures = 0;

  for (const action of actions) {
    if (action.type === 'complete' || action.type === 'ask_user') continue;
    if (!action.success) {
      failures++;
    } else if (action.type === 'navigate') {
      try {
        const host = new URL(action.url ?? '').hostname;
        if (host) sites.add(host);
        else descriptions.add('opened a page');
      } catch {
        descriptions.add('opened a page');
      }
    } else {
      descriptions.add(Object.hasOwn(actionLabels, action.type) ? actionLabels[action.type] : 'interacted with the page');
    }
  }

  if (sites.size) {
    const names = [...sites];
    descriptions.add('opened ' + list.format(names.slice(0, 3)) + (names.length > 3 ? ' and other sites' : ''));
  }
  const progress = descriptions.size ? 'I ' + list.format([...descriptions]) + '.' : '';
  const incomplete = failures ? (failures === 1 ? 'One action could not be completed.' : failures + ' actions could not be completed.') : '';
  return [progress, incomplete].filter(Boolean).join(' ');
}
