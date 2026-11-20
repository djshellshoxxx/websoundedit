/** Named workbench palettes. Theme changes never modify project audio. */
export const THEME_INFO = Object.freeze(Object.fromEntries(Object.entries({
  studio: { title: 'Studio', tone: 'dark', background: '#0e1116', accent: '#e8532a', wave: '#5ed8e6', description: 'Charcoal and orange' },
  daylight: { title: 'Daylight', tone: 'light', background: '#eceff2', accent: '#b73b1d', wave: '#087b92', description: 'Cool, bright workspace' },
  midnight: { title: 'Midnight', tone: 'dark', background: '#0a1422', accent: '#489ee1', wave: '#5bbaf4', description: 'Deep blue studio' },
  terminal: { title: 'Terminal', tone: 'dark', background: '#101713', accent: '#85bd72', wave: '#a4df86', description: 'Green with monospace type' },
  graphite: { title: 'Graphite', tone: 'dark', background: '#131416', accent: '#d9dde3', wave: '#b5d7ef', description: 'Quiet neutral grays' },
  ocean: { title: 'Ocean', tone: 'dark', background: '#071b20', accent: '#63d6c8', wave: '#70e0ed', description: 'Teal and sea glass' },
  aurora: { title: 'Aurora', tone: 'dark', background: '#181223', accent: '#c4a2ff', wave: '#9edbef', description: 'Violet with icy blue' },
  ember: { title: 'Ember', tone: 'dark', background: '#21140e', accent: '#ffb273', wave: '#f5c88c', description: 'Warm copper and amber' },
  paper: { title: 'Paper', tone: 'light', background: '#f4efe4', accent: '#8f4225', wave: '#216b78', description: 'Warm light, ink details' },
  contrast: { title: 'High contrast', tone: 'dark', background: '#000000', accent: '#ffe800', wave: '#5df4ff', description: 'Black, white and clear edges' },
}).map(([id, value]) => [id, Object.freeze(value)])));

export const THEMES = Object.freeze(Object.fromEntries(Object.entries(THEME_INFO).map(([id, value]) => [id, value.title])));

export function applyTheme(theme) {
  const selected = Object.hasOwn(THEMES, theme) ? theme : 'studio';
  const info = THEME_INFO[selected], root = document.documentElement;
  root.dataset.theme = selected;
  root.dataset.themeTone = info.tone;
  root.style.colorScheme = info.tone;
  for (const id of ['theme-select', 'options-theme']) {
    const picker = document.getElementById(id);
    if (picker) picker.value = selected;
  }
  for (const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === selected));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', info.background);
  return selected;
}
