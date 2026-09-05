export const mobileDevice = () => matchMedia('(pointer: coarse)').matches;
export const renderPixelRatio = () => Math.min(devicePixelRatio || 1, mobileDevice() ? 1 : 1.25);

// OrbitControls and Leaflet already support touch. Keep panel gestures separate.
export function initializeMobileUI() {
  const panel = document.querySelector('#single-scene-panel');
  const toggle = document.querySelector('#single-scene-panel-toggle');
  toggle?.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? 'Show controls' : 'Hide controls';
    window.dispatchEvent(new Event('resize'));
  });
  for (const element of document.querySelectorAll('#single-scene-panel, #settings-menu, #voxel-methods-menu, #model-picker-menu')) {
    element.addEventListener('pointerdown', event => event.stopPropagation());
  }
}
