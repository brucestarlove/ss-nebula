/**
 * Names two of Excalidraw 0.18's own controls, which it leaves unnamed or
 * half-named (axe, on the canvas tab):
 *
 * - the main menu's trigger, a hamburger icon with no name at all
 *   (button-name, critical): it becomes "Canvas menu";
 * - the zoom reset, named "Reset zoom" while it shows the zoom
 *   (label-content-name-mismatch, serious): it becomes "Reset zoom, 100%",
 *   and follows the zoom.
 *
 * Excalidraw draws these after mount and redraws them as it likes, so a
 * MutationObserver keeps the names. React doesn't overwrite them: it only
 * writes an attribute when its own value for it changes. Returns a cleanup.
 */
export function nameExcalidrawControls(root: HTMLElement): () => void {
  const apply = () => {
    const trigger = root.querySelector('.main-menu-trigger');
    if (trigger && !trigger.hasAttribute('aria-label')) trigger.setAttribute('aria-label', 'Canvas menu');

    const zoom = root.querySelector('.reset-zoom-button');
    const shown = zoom?.textContent?.trim();
    if (zoom && shown) {
      const name = `Reset zoom, ${shown}`;
      if (zoom.getAttribute('aria-label') !== name) zoom.setAttribute('aria-label', name);
    }
  };
  apply();
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(apply);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
