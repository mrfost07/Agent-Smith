import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Minimal DOM and controlled frames exercise the actual renderer deterministically.
class Element {
  constructor(tag = 'div') { this.tag = tag; this.childNodes = []; this.attributes = new Map(); }
  appendChild(node) { node.remove(); this.childNodes.push(node); node.parent = this; return node; }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parent = null;
    this.childNodes = [];
    for (const node of nodes) {
      if (node.tag === 'fragment') for (const child of [...node.childNodes]) this.appendChild(child);
      else this.appendChild(node);
    }
  }
  remove() { if (this.parent) { const siblings = this.parent.childNodes; siblings.splice(siblings.indexOf(this), 1); this.parent = null; } }
  after(node) { node.remove(); const siblings = this.parent.childNodes; siblings.splice(siblings.indexOf(this) + 1, 0, node); node.parent = this.parent; }
  cloneNode() { return new Element(this.tag); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
}
class TextNode extends Element {
  constructor(data) { super('#text'); this.data = data; }
  get length() { return this.data.length; }
  get textContent() { return this.data; }
  appendData(text) { this.data += text; }
}
class Template extends Element {
  constructor() { super('template'); this.content = new Element('fragment'); }
  set innerHTML(html) {
    const stack = [this.content];
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith('</')) stack.pop();
      else if (token.startsWith('<')) { const el = new Element(token.slice(1, -1)); stack.at(-1).appendChild(el); stack.push(el); }
      else stack.at(-1).appendChild(new TextNode(token));
    }
  }
}
globalThis.Text = TextNode;
globalThis.document = { createElement: tag => tag === 'template' ? new Template() : new Element(tag), createTextNode: text => new TextNode(text) };
// Windows reduced motion must not switch response delivery to an instant dump.
globalThis.matchMedia = () => ({ matches: true });
let sequence = 0;
const frames = new Map();
globalThis.requestAnimationFrame = cb => { frames.set(++sequence, cb); return sequence; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
function frame(time) { const pending = [...frames.values()]; frames.clear(); for (const cb of pending) cb(time); }
const { outputFiles } = await build({ entryPoints: ['src/sidepanel/reply-animation.ts'], bundle: true, format: 'esm', write: false });
const { animateReply } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const body = new Element();
const scroll = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
let completed = 0;
const full = 'Hello world. This response appears gradually with formatting.';
const finish = animateReply(body, '<p>Hello <strong>world.</strong> This response appears gradually with formatting.</p>', scroll, () => completed++);
assert.equal(body.textContent, '');
assert.equal(body.attributes.get('aria-busy'), 'true');
frame(0); frame(32);
assert.ok(body.textContent.length > 0 && body.textContent.length < full.length);
const beforePause = body.textContent.length;
frame(60000);
assert.ok(body.textContent.length - beforePause <= beforePause * 2 + 2, 'A delayed frame must not dump the reply');
assert.equal(completed, 0);
for (let time = 60016; frames.size && time < 65000; time += 16) frame(time);
assert.equal(body.textContent, full);
assert.equal(body.childNodes[0].childNodes[1].tag, 'strong');
assert.equal(completed, 1);
assert.equal(body.attributes.has('aria-busy'), false);
finish(); assert.equal(completed, 1);
const cancel = animateReply(body, '<p>A second response</p>', scroll, () => completed++);
frame(70000); frame(70032); cancel();
assert.equal(body.textContent, 'A second response');
assert.equal(frames.size, 0);
assert.equal(completed, 2);
animateReply(body, '', scroll, () => completed++);
assert.equal(completed, 3);
const longReply = 'A longer answer that should still appear quickly. '.repeat(60);
animateReply(body, '<p>' + longReply + '</p>', scroll);
frame(80000); frame(80016);
assert.ok(body.textContent.length > 0 && body.textContent.length < longReply.length);
for (let time = 80032; frames.size && time <= 82240; time += 16) frame(time);
assert.equal(body.textContent, longReply, 'A long reply should finish in about 2.2 seconds');
assert.equal(frames.size, 0);
console.log('Reply animation tests passed: gradual output, delayed frames, formatting, completion, cancellation.');
