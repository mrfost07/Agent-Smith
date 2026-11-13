const menu = document.querySelector('.mobile-menu');
const nav = document.querySelector('.primary-nav');
const setMenuOpen = open => {
  menu.setAttribute('aria-expanded', String(open));
  nav.classList.toggle('is-open', open);
};

menu.addEventListener('click', () => setMenuOpen(menu.getAttribute('aria-expanded') !== 'true'));
nav.addEventListener('click', event => {
  if (event.target.closest('a')) setMenuOpen(false);
});
document.addEventListener('click', event => {
  if (!event.target.closest('.site-header')) setMenuOpen(false);
});
matchMedia('(min-width: 721px)').addEventListener('change', () => setMenuOpen(false));

const search = document.querySelector('.search-dialog');
const field = document.querySelector('#site-search');
const status = document.querySelector('.search-status');
const results = document.querySelector('.search-results');
const sections = [...document.querySelectorAll('[data-search-section]')].map(section => ({
  id: section.id,
  title: section.querySelector('h2').innerText,
  text: section.textContent.toLowerCase(),
}));

function renderResults() {
  const words = field.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = sections.filter(section => words.every(word => section.text.includes(word)));
  status.textContent = matches.length ? 'Jump to a section.' : 'No matching sections.';
  results.replaceChildren(...matches.map(section => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '#' + section.id;
    link.textContent = section.title;
    link.addEventListener('click', () => search.close());
    item.append(link);
    return item;
  }));
}

function openSearch() {
  if (!search.open) {
    field.value = '';
    renderResults();
    search.showModal();
  }
  field.focus();
}

document.querySelector('[data-open-search]').addEventListener('click', openSearch);
field.addEventListener('input', renderResults);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && nav.classList.contains('is-open')) {
    setMenuOpen(false);
    menu.focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (!document.querySelector('.image-dialog[open]')) openSearch();
  }
});

const showcase = document.querySelector('.image-dialog');
const showcaseImage = document.querySelector('[data-expand-image] img');
document.querySelector('[data-expand-image]').addEventListener('click', () => {
  showcase.querySelector('.image-scroll').replaceChildren(showcaseImage.cloneNode());
  showcase.showModal();
});
for (const dialog of [search, showcase]) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
}
