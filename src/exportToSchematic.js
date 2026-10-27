// Compatibility wrapper for callers with an already-built dense block grid.
// Keep new block names; an outdated numeric registry silently turns them to air.
import { writeSpongeSchem } from './assignToBlocksForGLB.js';
import { saveAs } from 'file-saver';

export async function exportToSchematic(denseGrid) {
  const bytes = await writeSpongeSchem(denseGrid);
  saveAs(new Blob([bytes]), 'model.schem');
}
