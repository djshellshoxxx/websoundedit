export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const clone = value => JSON.parse(JSON.stringify(value));
export function option(value, label, selected) { return `<option value="${escapeHTML(value)}"${value === selected ? ' selected' : ''}>${escapeHTML(label)}</option>`; }
export function bytesLabel(bytes = 0) { return `${(Math.max(0, bytes) / 1048576).toFixed(1)} MiB`; }
export function secondsLabel(seconds = 0) { const total = Math.max(0, Math.floor(seconds)); return `${Math.floor(total / 3600).toString().padStart(2, '0')}:${Math.floor(total % 3600 / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`; }
export function boundedText(value, name, max = 200) { if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be text of at most ${max} characters.`); return value; }
export function plainObject(value, name = 'Value') { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${name} must be an object.`); return value; }

/** A view changes the URL without replacing the running editor or its audio graph. */
export class WorkbenchRoutes {
  constructor({ onError = console.error } = {}) {
    this.views = new Map(); this.onError = onError; this.active = ''; this.returnHash = ''; this.pushed = false; this.serial = 0;
    this.dialog = document.createElement('dialog'); this.dialog.id = 'workbench-view'; this.dialog.className = 'workbench-view';
    this.dialog.innerHTML = '<div class="workspace-view-header"><button data-view-back aria-label="Back to editor">← Editor</button><div><span class="eyebrow">WEBSOUNDEDIT / WORKBENCH</span><h2 id="workbench-view-title"></h2></div><button data-view-close aria-label="Close workbench view">×</button></div><div id="workbench-view-body"></div>';
    document.body.append(this.dialog); this.dialog.setAttribute('aria-labelledby', 'workbench-view-title');
    this.dialog.querySelectorAll('[data-view-back],[data-view-close]').forEach(button => button.onclick = () => this.close());
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.routeListener = () => this.render().catch(this.onError);
    window.addEventListener('hashchange', this.routeListener); window.addEventListener('popstate', this.routeListener);
  }
  register(name, title, render) { this.views.set(name, { title, render }); }
  open(route) {
    const hash = '#' + route.replace(/^#/, '');
    if (!this.dialog.open) { this.returnHash = location.hash; this.pushed = true; }
    if (location.hash !== hash) history.pushState({ websoundeditView: true }, '', hash);
    return this.render();
  }
  close() {
    if (this.dialog.open) this.dialog.close();
    this.active = ''; this.cleanup?.(); this.cleanup = null;
    // Replace the current surface route; Back still visits earlier workbench sections.
    history.replaceState(history.state, '', this.returnHash && !/^#(options|help|macros|performance)(\/|$)/.test(this.returnHash) ? this.returnHash : location.pathname + location.search);
    this.pushed = false;
  }
  async render() {
    const [name, ...parts] = location.hash.replace(/^#/, '').split('/'), view = this.views.get(name);
    if (!view) { this.serial++; this.active = ''; this.cleanup?.(); this.cleanup = null; if (this.dialog.open) this.dialog.close(); return; }
    const key = `${name}/${parts.join('/')}`;
    if (key === this.active && this.dialog.open) return;
    const token = ++this.serial;
    this.cleanup?.(); this.cleanup = null; this.active = key;
    this.dialog.querySelector('#workbench-view-title').textContent = view.title;
    const container = this.dialog.querySelector('#workbench-view-body'); container.replaceChildren();
    if (!this.dialog.open) this.dialog.showModal();
    const cleanup = await view.render(container, parts.join('/'));
    if (token === this.serial) this.cleanup = typeof cleanup === 'function' ? cleanup : null;
    else if (typeof cleanup === 'function') cleanup();
  }
  refresh() { this.active = ''; return this.render(); }
  dispose() { window.removeEventListener('hashchange', this.routeListener); window.removeEventListener('popstate', this.routeListener); this.cleanup?.(); this.dialog.remove(); }
}
