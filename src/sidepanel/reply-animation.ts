function* appendReplyNodes(source: Node, target: Node): Generator<{ node: Text; letters: string[] }> {
  for (const child of source.childNodes) {
    if (child instanceof Text) {
      const node = document.createTextNode('');
      target.appendChild(node);
      if (child.length) yield { node, letters: Array.from(child.data) };
    } else {
      const node = child.cloneNode(false);
      target.appendChild(node);
      yield* appendReplyNodes(child, node);
    }
  }
}

export function animateReply(
  body: HTMLElement,
  html: string,
  scroller: HTMLElement,
  onComplete: () => void = () => {},
): () => void {
  const template = document.createElement('template');
  template.innerHTML = html;
  const length = Array.from(template.content.textContent ?? '').length;
  if (length === 0) {
    body.replaceChildren(template.content);
    onComplete();
    return () => {};
  }

  body.replaceChildren();
  body.setAttribute('aria-busy', 'true');
  const caret = document.createElement('span');
  caret.className = 'reply-typing-caret';
  caret.setAttribute('aria-hidden', 'true');

  const nodes = appendReplyNodes(template.content, body);
  let current = nodes.next();
  let offset = 0;
  let revealed = 0;
  let frame = 0;
  let previousTime: number | undefined;
  let allowance = 0;
  let done = false;
  // Short replies reveal quickly; long replies catch up without a second wait.
  const durationMs = Math.min(2200, Math.max(150, length * 1000 / 180));
  const charactersPerSecond = length * 1000 / durationMs;

  function finish(): void {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    if (!current.done) body.replaceChildren(template.content);
    caret.remove();
    body.removeAttribute('aria-busy');
    onComplete();
  }

  function tick(now: number): void {
    // A delayed frame should reveal a small chunk instead of jumping to the end.
    const elapsed = Math.min(64, Math.max(0, now - (previousTime ?? now)));
    previousTime = now;
    allowance += elapsed * charactersPerSecond / 1000;
    const following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    const count = Math.floor(allowance);
    allowance -= count;
    const target = Math.min(length, revealed + count);
    while (!current.done && revealed < target) {
      const { node, letters } = current.value;
      const end = Math.min(letters.length, offset + target - revealed);
      node.appendData(letters.slice(offset, end).join(''));
      node.after(caret);
      revealed += end - offset;
      offset = end;
      if (offset === letters.length) {
        current = nodes.next();
        offset = 0;
      }
    }

    if (current.done) finish();
    else frame = requestAnimationFrame(tick);
    if (following) scroller.scrollTop = scroller.scrollHeight;
  }

  frame = requestAnimationFrame(tick);
  return finish;
}
