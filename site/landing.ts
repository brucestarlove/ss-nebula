/**
 * The landing's deck (site/index.html): five slides that snap side by side in
 * wide windows, and a page read top to bottom in narrow ones. The arrows, the
 * dots, the keyboard and a mouse wheel step between slides; a trackpad or a
 * touch screen scrolls the deck itself, and it snaps. The address follows the
 * slide (#files, #sessions…) so a slide can be linked.
 */
import { startStarscape } from '@starlove/ui/starscape';

// Nebula 1.x's and 2.0's board links that land on the landing page (a
// bookmark of /?board=… or /#/b/…) belong to the app, which reads them.
const boardLink = /^#\/(?:b|board|c|canvas)(?:\/|$)/.test(location.hash) || /[?&](?:board|canvas)=/.test(location.search);

// Nebula installed as an app opens the app, never this page. Installs made
// before the landing page (the previews' manifest started at /) take the new
// start_url in their browser's own time, and Help asks people to install it.
const installed =
  ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'].some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches) ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

if (boardLink) location.replace(`/app${location.search}${location.hash}`);
else if (installed) location.replace('/app');

startStarscape();

const deck = document.querySelector<HTMLElement>('[data-deck]')!;
const slides = Array.from(document.querySelectorAll<HTMLElement>('[data-slide]'));
const dots = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-dot]'));
const prev = document.querySelector<HTMLButtonElement>('[data-prev]')!;
const next = document.querySelector<HTMLButtonElement>('[data-next]')!;
const announce = document.querySelector<HTMLElement>('[data-announce]')!;
const wide = window.matchMedia('(min-width: 981px)');
const still = window.matchMedia('(prefers-reduced-motion: reduce)');
const last = slides.length - 1;

let index = 0;

function clamp(value: number): number {
  return Math.max(0, Math.min(last, value));
}

/** The slide on screen, read from where the deck has scrolled to. */
function slideInView(): number {
  if (wide.matches) return clamp(Math.round(deck.scrollLeft / Math.max(1, deck.clientWidth)));
  const middle = window.innerHeight / 3;
  let found = 0;
  slides.forEach((slide, n) => {
    if (slide.getBoundingClientRect().top <= middle) found = n;
  });
  return found;
}

/** Dots, arrows, address and the screen reader's line follow the slide. */
function settle(n: number, { announceIt = true } = {}): void {
  const changed = n !== index;
  index = n;
  dots.forEach((dot, i) => {
    if (i === n) dot.setAttribute('aria-current', 'step');
    else dot.removeAttribute('aria-current');
  });
  prev.disabled = n === 0;
  next.disabled = n === last;
  const hash = n === 0 ? '' : `#${slides[n].id}`;
  if (location.hash !== hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`);
  if (changed && announceIt) announce.textContent = `Slide ${n + 1} of ${slides.length}: ${slides[n].dataset.title ?? ''}`;
}

function go(target: number, { instant = false } = {}): void {
  const n = clamp(target);
  const behavior: ScrollBehavior = instant || still.matches ? 'auto' : 'smooth';
  if (wide.matches) deck.scrollTo({ left: n * deck.clientWidth, behavior });
  else slides[n].scrollIntoView({ behavior, block: 'start' });
  settle(n);
}

// Scrolling (by snap, trackpad, touch or a Tab into the next slide) settles
// once it stops.
let scrollTimer = 0;
const onScroll = () => {
  window.clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => settle(slideInView()), 90);
};
deck.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('scroll', onScroll, { passive: true });

prev.addEventListener('click', () => go(index - 1));
next.addEventListener('click', () => go(index + 1));
dots.forEach((dot) => dot.addEventListener('click', () => go(Number(dot.dataset.dot))));

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('[data-next-slide]')) {
    event.preventDefault();
    go(index + 1);
  } else if (target?.closest('[data-first-slide]')) {
    event.preventDefault();
    go(0);
  }
});

// A mouse wheel steps one slide per turn; a trackpad's sideways swipe is left
// to the deck, which scrolls and snaps by itself.
let lastStep = 0;
let lastWheel = 0;
/** Whether a slide taller than the window can still scroll this way. */
function slideScrolls(target: EventTarget | null, down: boolean): boolean {
  const slide = target instanceof Element ? target.closest<HTMLElement>('[data-slide]') : null;
  if (!slide || slide.scrollHeight <= slide.clientHeight + 2) return false;
  return down ? slide.scrollTop + slide.clientHeight < slide.scrollHeight - 2 : slide.scrollTop > 2;
}

window.addEventListener(
  'wheel',
  (event) => {
    if (!wide.matches) return;
    if (slideScrolls(event.target, event.deltaY > 0)) return;
    const now = performance.now();
    const fresh = now - lastWheel > 220;
    lastWheel = now;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (Math.abs(event.deltaY) < 6) return;
    if (now - lastStep < 650 || (!fresh && Math.abs(event.deltaY) < 40)) return;
    lastStep = now;
    go(index + (event.deltaY > 0 ? 1 : -1));
  },
  { passive: true },
);

window.addEventListener('keydown', (event) => {
  if (!wide.matches || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
  const step = { ArrowRight: 1, PageDown: 1, ArrowLeft: -1, PageUp: -1 }[event.key];
  if (step) {
    event.preventDefault();
    go(index + step);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    go(event.key === 'Home' ? 0 : last);
  }
});

// The deck keeps its slide when the window changes size or crosses into the
// narrow layout.
window.addEventListener('resize', () => {
  if (wide.matches) deck.scrollTo({ left: index * deck.clientWidth, behavior: 'auto' });
});

// Night or Day: one choice for every picture of the app.
const shotButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-shot-theme]'));
shotButtons.forEach((button) =>
  button.addEventListener('click', () => {
    const theme = button.dataset.shotTheme === 'day' ? 'day' : 'night';
    document.documentElement.dataset.shots = theme;
    shotButtons.forEach((other) => other.setAttribute('aria-pressed', String(other.dataset.shotTheme === theme)));
  }),
);

// A link to a slide (/#sessions) opens on it.
const linked = slides.findIndex((slide) => `#${slide.id}` === location.hash);
if (linked > 0) requestAnimationFrame(() => go(linked, { instant: true }));
settle(linked > 0 ? linked : 0, { announceIt: false });
