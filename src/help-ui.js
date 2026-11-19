import { HELP_CHAPTERS, HELP_IMAGES } from './help-content.js';
import { escapeHTML } from './ui-utils.js';

export class HelpUI {
  constructor({ routes, getCommands = () => [] }) { this.routes = routes; this.getCommands = getCommands; routes.register('help', 'Workbench guide', (container, chapter) => this.render(container, chapter)); }
  open(chapter = 'navigation') { return this.routes.open(`help/${chapter}`); }
  render(container, chapterId) {
    const chapter = HELP_CHAPTERS.find(item => item.id === chapterId) || HELP_CHAPTERS[0];
    const catalog = this.getCommands();
    container.innerHTML = `<div class="workspace-split help-layout"><aside class="workspace-nav"><label class="help-search-label">Search the guide<input id="help-search" type="search" placeholder="Pedal, export, reverb…"></label><nav aria-label="Help chapters">${HELP_CHAPTERS.map(item => `<a href="#help/${item.id}"${item === chapter ? ' aria-current="page"' : ''} data-help-chapter="${item.id}">${escapeHTML(item.title)}</a>`).join('')}</nav><a class="button-link" href="#options/general">Options & preferences</a></aside><article class="help-article" id="help-article"><div class="eyebrow">GUIDE / ${escapeHTML(chapter.id.toUpperCase())}</div><h3>${escapeHTML(chapter.title)}</h3><p class="help-lead">${escapeHTML(chapter.lead)}</p>${HELP_IMAGES.filter(image => image.chapter === chapter.id).map(image => `<figure class="help-figure"><img src="${escapeHTML(import.meta.env.BASE_URL + image.path)}" width="${image.width}" height="${image.height}" alt="${escapeHTML(image.alt)}" loading="lazy"><figcaption>${escapeHTML(image.caption)}</figcaption></figure>`).join('')}${chapter.sections.map(([title, text]) => `<section><h4>${escapeHTML(title)}</h4><p>${escapeHTML(text)}</p></section>`).join('')}${chapter.code ? `<h4>Example macro</h4><pre><code>${escapeHTML(chapter.code)}</code></pre>` : ''}<h4>Related commands</h4><div class="help-command-list">${chapter.commands.map(method => { const command = catalog.find(item => item.method === method); return `<details><summary><code>${escapeHTML(method)}</code>${command ? ` — ${escapeHTML(command.label || command.description || '')}` : ''}</summary><p>${escapeHTML(command?.description || 'Use command search or the API catalog to inspect this command’s supported parameters.')}</p>${command?.schema ? `<pre><code>${escapeHTML(JSON.stringify(command.schema, null, 2))}</code></pre>` : ''}</details>`; }).join('')}</div><h4>Full command catalog</h4><p>The same registered commands are available to scripts and the API. Browser-specific commands report capability or permission requirements.</p><details><summary>Browse all ${catalog.length} commands by category</summary>${this.catalogHTML(catalog)}</details></article></div>`;
    const search = container.querySelector('#help-search');
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      for (const link of container.querySelectorAll('[data-help-chapter]')) { const item = HELP_CHAPTERS.find(c => c.id === link.dataset.helpChapter); link.hidden = Boolean(query) && ![item.title, item.lead, ...item.sections.flat(), ...item.commands].join(' ').toLowerCase().includes(query); }
      let results = container.querySelector('#help-search-results');
      if (!query) { results?.remove(); container.querySelector('#help-article').hidden = false; return; }
      if (!results) { results = document.createElement('article'); results.id = 'help-search-results'; results.className = 'help-article'; container.querySelector('.workspace-split').append(results); }
      container.querySelector('#help-article').hidden = true;
      const found = HELP_CHAPTERS.flatMap(item => item.sections.filter(([title, text]) => `${item.title} ${title} ${text}`.toLowerCase().includes(query)).map(([title, text]) => ({ item, title, text })));
      results.innerHTML = `<h3>Search results</h3><p>${found.length} matching sections</p>${found.map(({ item, title, text }) => `<section><h4><a href="#help/${item.id}">${escapeHTML(item.title)} / ${escapeHTML(title)}</a></h4><p>${escapeHTML(text)}</p></section>`).join('') || '<p>No sections match. Try a feature name such as MIDI, selection, recording or export.</p>'}`;
    });
  }
  catalogHTML(catalog) {
    const groups = new Map(); for (const command of catalog) { const group = command.category || command.method.split('.')[0]; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(command); }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, commands]) => `<section><h4>${escapeHTML(group)}</h4>${commands.map(command => `<details><summary><code>${escapeHTML(command.method)}</code></summary><p>${escapeHTML(command.description || command.label || '')}</p><pre><code>${escapeHTML(JSON.stringify(command.schema || {}, null, 2))}</code></pre></details>`).join('')}</section>`).join('');
  }
}
