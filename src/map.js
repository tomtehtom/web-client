/* ====================================================================
 * map.js – Google Photorealistic 3D-tiles ⇄ on-demand voxel / MC view
 * ===================================================================*/

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebGPURenderer } from 'three/webgpu';

import { TilesRenderer } from '3d-tiles-renderer';
import {
  TileCompressionPlugin,
  TilesFadePlugin,
  GLTFExtensionsPlugin
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

import { voxelizeModel, WEBGPU_WORKER_POOL_SIZE, invalidateSerializedModel } from './voxelize-model.js';
import { VoxelLodCache, selectVoxelLod, projectedVoxelDemand } from './voxel-lod.js';
import { setPackedVoxelTextures } from './packed-voxel-renderer.js';
import { fetchEarthResource } from './earth-fetch.js';
import { downloadExport } from './voxel-export.js';
import { initializeMobileUI, mobileDevice, renderPixelRatio } from './mobile-ui.js';
import './mobile.css';
import {
  initBlockData,
  assignVoxelsToBlocks,
  applyAtlasToExistingVoxelMesh,
  restoreVoxelOriginalMaterial,
  setMinecraftBrightnessBias,
  getMinecraftBrightnessBias,
  getPackedBlockResources
} from './assignToBlocksForGLB.js';
import { SingleSceneViewer } from './SingleSceneViewer.js';
import { SingleSceneFetcher } from './SingleSceneFetcher.js';
import { getActiveServerUrl, isLocalServer, resolveEarthTileUrl } from './config.js';

const LEGACY_SRGB_ENCODING = 3001;
const SESSION_MAX_AGE_MS = 2.5 * 60 * 60 * 1000;
let __tilesSessionId = null;
let __tilesSessionTs = 0;
if (typeof window !== 'undefined' && window.__photorealSession?.id) {
  __tilesSessionId = window.__photorealSession.id;
  __tilesSessionTs = window.__photorealSession.ts || Date.now();
}

(function installPhotorealFetchGuard() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (window.fetch.__photorealGuardInstalled) return;

  const realFetch = window.fetch.bind(window);

  const isTiles = (input) => {
    try {
      const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (!raw) return false;
      const url = new URL(raw, window.location.origin);
      // Google 3D Tiles host
      if (url.hostname === 'tile.googleapis.com' && url.pathname.startsWith('/v1/3dtiles/')) return true;
      // Configured local or custom server check
      if (isLocalServer()) {
        const activeUrl = new URL(getActiveServerUrl(''), window.location.origin);
        if (url.hostname === activeUrl.hostname && url.port === activeUrl.port) return true;
      }
      // Heuristic for other servers
      if (url.pathname.includes('/v1/3dtiles/')) return true;
      return false;
    } catch {
      return false;
    }
  };

  const clearRootCache = async () => {
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_ROOT_CACHE' });
    } catch { }
  };

  window.fetch = async (input, opts = {}) => {
    if (!isTiles(input)) return realFetch(input, opts);

    let response = await fetchEarthResource(input, opts, realFetch);
    if (response && (response.status === 400 || response.status === 401 || response.status === 403)) {
      try {
        const raw = typeof input === 'string' ? input : (input?.url ?? String(input));
        const url = new URL(raw, window.location.origin);
        if (url.searchParams.has('session')) {
          __tilesSessionId = null;
          __tilesSessionTs = 0;
          window.__photorealSession = null;
          await clearRootCache();
          url.searchParams.delete('session');
          url.searchParams.set('_', String(Date.now()));
          const retryOpts = { ...opts, cache: 'reload' };
          response = await realFetch(url.toString(), retryOpts);
        }
      } catch { }
    }
    return response;
  };

  window.fetch.__photorealGuardInstalled = true;
})();

// ---- Minecraft atlas bootstrap (idempotent) ----
let __mcInit;
async function ensureMinecraftReady() {
  if (!__mcInit) {
    __mcInit = (async () => {
      try { await initBlockData?.(); } catch { }
    })();
  }
  return __mcInit;
}

/* ─────────────────────────── ChatGPT-style HUD ───────────────────────── */
class HUD {
  constructor() {
    // Debug: check what elements we can find
    console.log('DOM ready state:', document.readyState);
    console.log('Body children:', document.body?.children?.length);

    // Settings menu popup
    const menu = document.querySelector('#settings-menu');
    const composerPlus = document.querySelector('#composer-plus');
    const closeMenu = document.querySelector('#menu-close');

    // Voxelization methods menu
    const voxelMethodsMenu = document.querySelector('#voxel-methods-menu');
    const voxelMethodsBtn = document.querySelector('#voxel-methods-btn');
    const voxelMethodsBack = document.querySelector('#voxel-methods-back');
    const voxelMethodsClose = document.querySelector('#voxel-methods-close');

    console.log('Elements found:', {
      menu: !!menu, composerPlus: !!composerPlus, closeMenu: !!closeMenu,
      voxelMethodsMenu: !!voxelMethodsMenu, voxelMethodsBtn: !!voxelMethodsBtn, voxelMethodsBack: !!voxelMethodsBack, voxelMethodsClose: !!voxelMethodsClose
    });

    // Single Scene mini-map handles (populated in _initializeSingleSceneMap)
    this._singleMap = null;
    this._singleMapMarker = null;

    if (!menu || !composerPlus || !closeMenu) {
      console.error('Missing menu elements:', { menu, composerPlus, closeMenu });
      // Let's try to continue without menu functionality
      this._initializeBasicElements();
      return;
    }

    const openMenu = () => {
      console.log('Opening menu');
      menu.classList.remove('hidden');
      voxelMethodsMenu?.classList.add('hidden');
    };
    const hideMenu = () => {
      console.log('Closing menu');
      menu.classList.add('hidden');
      voxelMethodsMenu?.classList.add('hidden');
    };
    const openVoxelMethods = () => {
      console.log('Opening voxel methods menu');
      menu?.classList.add('hidden');
      voxelMethodsMenu?.classList.remove('hidden');
    };
    const closeVoxelMethods = () => {
      console.log('Closing voxel methods menu');
      voxelMethodsMenu?.classList.add('hidden');
    };
    const backToSettings = () => {
      console.log('Going back to settings menu');
      voxelMethodsMenu?.classList.add('hidden');
      menu?.classList.remove('hidden');
    };

    // Add event listeners with proper event handling
    composerPlus.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Plus button clicked');
      if (menu.classList.contains('hidden')) {
        openMenu();
      } else {
        hideMenu();
      }
    });

    document.querySelector('#single-scene-options')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu();
    });

    closeMenu.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideMenu();
    });

    // Voxelization methods navigation
    if (voxelMethodsBtn) {
      voxelMethodsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openVoxelMethods();
      });
    }

    if (voxelMethodsBack) {
      voxelMethodsBack.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        backToSettings();
      });
    }

    if (voxelMethodsClose) {
      voxelMethodsClose.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeVoxelMethods();
      });
    }

    // Close menus when clicking outside
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) &&
        !voxelMethodsMenu?.contains(e.target) &&
        e.target !== composerPlus &&
        !composerPlus.contains(e.target)) {
        hideMenu();
      }
    });

    // Prevent menus from closing when interacting with form elements inside
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    if (voxelMethodsMenu) {
      voxelMethodsMenu.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    this._initializeBasicElements();
    this._initializeModelPicker();
  }

  getSingleSceneRes() {
    const numInput = document.querySelector('#single-scene-res-input');
    const resFine = document.querySelector('#single-scene-res-fine');
    const raw = numInput?.value || resFine?.value || '64';
    const val = parseInt(raw, 10);
    if (!Number.isFinite(val)) return 64;
    return Math.max(8, Math.min(1024, val));
  }

  /** Texture switches share packed geometry; only density/rotation rebuild it. */
  async syncSingleSceneToGlobalVoxState(forceRebuild = false) {
    const viewer = window.singleSceneViewer;
    const container = viewer?.tilesContainer;
    if (!viewer || !container) return;

    // Visibility mirrors global vox toggle
    this._setSingleSceneVisibility(!!state.vox);

    const vox = container.getObjectByName('singleSceneVoxels');
    const res = this.getSingleSceneRes();

    if (state.vox && (!vox || forceRebuild)) await this._rebuildSingleSceneVoxels(res);
    await viewer.setMinecraftEnabled(state.mc);
  }

  _initializeModelPicker() {
    const modelPickerBtn = document.querySelector('#model-picker-btn');
    const modelPickerMenu = document.querySelector('#model-picker-menu');
    const modelPickerArrow = document.querySelector('#model-picker-arrow');
    const modelOptions = document.querySelectorAll('.model-option');
    const singleScenePanel = document.querySelector('#single-scene-panel');

    if (!modelPickerBtn || !modelPickerMenu) return;

    // Toggle dropdown
    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = modelPickerMenu.classList.contains('hidden');

      if (isHidden) {
        modelPickerMenu.classList.remove('hidden');
        modelPickerArrow.style.transform = 'rotate(180deg)';
      } else {
        modelPickerMenu.classList.add('hidden');
        modelPickerArrow.style.transform = 'rotate(0deg)';
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!modelPickerMenu.contains(e.target) && e.target !== modelPickerBtn) {
        modelPickerMenu.classList.add('hidden');
        modelPickerArrow.style.transform = 'rotate(0deg)';
      }
    });

    // Handle model selection
    modelOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        e.preventDefault();
        const selectedModel = option.dataset.model;

        // Update UI selection state
        modelOptions.forEach(opt => opt.classList.remove('selected'));
        option.classList.add('selected');

        // Close dropdown
        modelPickerMenu.classList.add('hidden');
        modelPickerArrow.style.transform = 'rotate(0deg)';

        // Handle model switch
        this.switchToModel(selectedModel);
      });
    });

    this._initializeSingleScene();
  }

  switchToModel(modelType) {
    const singleScenePanel = document.querySelector('#single-scene-panel');
    const modelPickerBtn = document.querySelector('#model-picker-btn');

    if (modelType === 'single-scene') {
      // Hide the main 3D tiles and show single scene interface
      this.setStatus('Single Scene Mode - Ready');
      singleScenePanel.classList.remove('hidden');
      document.body.classList.add('single-scene-active');
      this._scheduleMiniMapInvalidate?.();

      // Update model picker button text
      if (modelPickerBtn) {
        const titleEl = modelPickerBtn.querySelector('.text-sm.font-medium');
        const subtitleEl = modelPickerBtn.querySelector('.text-xs.opacity-60');
        if (titleEl) titleEl.textContent = 'Single Scene';
        if (subtitleEl) subtitleEl.textContent = 'export specific area';
      }

      // Clean up existing tiles if any
      if (window.tiles) {
        for (const tile of [...window.tiles.group.children]) cleanupTileVoxels(tile);
        voxelLodCache.clear();
        scene.remove(window.tiles.group);
        window.tiles.dispose();
        window.tiles = null;
        tiles = null;
      }

      // Initialize single scene viewer with empty scene immediately
      this.initializeSingleSceneViewer();
      // Mirror global Vox/MC state on entry (set initial vis/materials)
      this.syncSingleSceneToGlobalVoxState(false);

    } else {
      // Switch back to voxel earth mode
      singleScenePanel.classList.add('hidden');
      document.body.classList.remove('single-scene-active');
      this.setStatus('Voxel Earth Mode');

      // Update model picker button text
      if (modelPickerBtn) {
        const titleEl = modelPickerBtn.querySelector('.text-sm.font-medium');
        const subtitleEl = modelPickerBtn.querySelector('.text-xs.opacity-60');
        if (titleEl) titleEl.textContent = 'Voxel Earth 1.0';
        if (subtitleEl) subtitleEl.textContent = 'with Google Earth tiles';
      }

      // Clean up single scene viewer if exists
      if (window.singleSceneViewer) {
        window.singleSceneViewer.destroy();
        window.singleSceneViewer = null;
      }

      // Reinitialize main tiles (uses Google if key is set, otherwise fallback server)
      const key = this.getKey();
      const serverUrl = getActiveServerUrl(key);
      this.setStatus('Loading tiles...');
      ensureTiles(serverUrl, key);
      const [lat, lon] = this.getLatLon();
      retargetTiles(lat, lon);
    }
  }

  initializeSingleSceneViewer() {
    // Create a basic SingleSceneViewer instance for the empty scene
    if (!window.singleSceneViewer) {
      window.singleSceneViewer = new SingleSceneViewer();
      // Reflect initial debug tiles state if toggle exists
      document.querySelector('#single-scene-debug-tiles')?.dispatchEvent(new Event('change'));
    }
  }

  _initializeSingleScene() {
    this._initializeSingleSceneControls();
    this._initializeSingleSceneMap();
  }

  _initializeSingleSceneControls() {
    const fetchBtn = document.querySelector('#single-scene-fetch');
    const downloadBtn = document.querySelector('#single-scene-download');
    const debugTilesToggle = document.querySelector('#single-scene-debug-tiles');
    const radiusSlider = document.querySelector('#single-scene-radius');
    const rotSlider = document.querySelector('#single-scene-rot');
    const tileSlider = document.querySelector('#single-scene-tile-slider');
    const resPills = document.querySelectorAll('.single-scene-res-pill');
    const resFine = document.querySelector('#single-scene-res-fine');
    const resInput = document.querySelector('#single-scene-res-input');
    const sseSlider = document.querySelector('#single-scene-sse');
    const sseValue = document.querySelector('#single-scene-sse-value');
    const radiusValue = document.querySelector('#single-scene-radius-value');
    const rotValue = document.querySelector('#single-scene-rot-value');

    // Unhide rows if present (SSE + Debug)
    document.querySelector('#single-scene-sse-row')?.classList.remove('hidden');
    document.querySelector('#single-scene-debug-row')?.classList.remove('hidden');
    // SSE slider update
    const bindSliderToNumericInput = (slider, input, opts = {}) => {
      if (!slider || !input) return;
      const minVal = Number.isFinite(+opts.min) ? +opts.min : Number.isFinite(+slider.min) ? +slider.min : undefined;
      const maxVal = Number.isFinite(+opts.max) ? +opts.max : Number.isFinite(+slider.max) ? +slider.max : undefined;
      const clamp = (raw) => {
        if (typeof opts.valueClamp === 'function') return opts.valueClamp(raw);
        let num = parseFloat(raw);
        if (!Number.isFinite(num)) num = minVal !== undefined ? minVal : 0;
        if (minVal !== undefined) num = Math.max(minVal, num);
        if (maxVal !== undefined) num = Math.min(maxVal, num);
        return num;
      };
      const syncFromSlider = () => {
        if (slider.__suppressInputSync) return;
        const val = clamp(slider.value);
        input.value = val;
      };
      const syncFromInput = () => {
        const val = clamp(input.value);
        input.value = val;
        const sliderMin = Number.isFinite(+slider.min) ? +slider.min : undefined;
        const sliderMax = Number.isFinite(+slider.max) ? +slider.max : undefined;
        let sliderVal = val;
        if (sliderMin !== undefined) sliderVal = Math.max(sliderMin, sliderVal);
        if (sliderMax !== undefined) sliderVal = Math.min(sliderMax, sliderVal);
        slider.__suppressInputSync = true;
        slider.value = String(sliderVal);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        queueMicrotask(() => { slider.__suppressInputSync = false; });
      };
      slider.addEventListener('input', syncFromSlider);
      input.addEventListener('change', syncFromInput);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          syncFromInput();
        }
      });
      syncFromSlider();
    };

    // Slider filled track updater
    const _setSliderFill = (el) => {
      if (!el) return;
      const min = +el.min || 0, max = +el.max || 100, val = +el.value || 0;
      const p = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
      el.style.setProperty('--p', p + '%');
    };
    [sseSlider, radiusSlider, resFine, rotSlider, tileSlider].forEach(el => {
      if (!el) return;
      _setSliderFill(el);
      el.addEventListener('input', () => _setSliderFill(el));
    });

    const clampRadiusValue = (raw) => {
      const num = parseFloat(raw);
      if (!Number.isFinite(num)) return 0;
      return Math.max(0, Math.min(3000, num));
    };

    bindSliderToNumericInput(sseSlider, sseValue, { min: 2, max: 64 });
    bindSliderToNumericInput(radiusSlider, radiusValue, { valueClamp: clampRadiusValue });
    bindSliderToNumericInput(rotSlider, rotValue, { min: 0, max: 360 });

    const presetResValues = [32, 64, 128, 256];
    const clampResolution = (val) => {
      const num = parseInt(val, 10);
      if (!Number.isFinite(num)) return 64;
      return Math.max(8, Math.min(1024, num));
    };
    const nearestPreset = (val) => presetResValues.reduce((prev, curr) => Math.abs(curr - val) < Math.abs(prev - val) ? curr : prev);
    const highlightResPill = (val) => {
      resPills.forEach(pill => pill.classList.remove('active'));
      const active = document.querySelector(`.single-scene-res-pill[data-res="${val}"]`);
      if (active) active.classList.add('active');
    };
    const updateResolutionUI = (value) => {
      const res = clampResolution(value);
      if (resFine) {
        resFine.value = res;
        _setSliderFill(resFine);
      }
      if (resInput && document.activeElement !== resInput) {
        resInput.value = res;
      }
      highlightResPill(nearestPreset(res));
      return res;
    };
    const applyResolutionChange = async (value, { rebuild = true } = {}) => {
      const res = updateResolutionUI(value);
      if (rebuild && state.vox && window.singleSceneViewer?.tilesContainer) {
        await this._rebuildSingleSceneVoxels(res);
      }
      return res;
    };
    updateResolutionUI(resInput?.value || resFine?.value || 64);

    // Rotation slider updates (number inputs dispatch events through slider binding)
    if (rotSlider) {
      rotSlider.addEventListener('input', async () => {
        if (state.vox && window.singleSceneViewer?.tilesContainer) {
          await this._rebuildSingleSceneVoxels(this.getSingleSceneRes());
        }
      });
    }

    // Resolution pills
    resPills.forEach(pill => {
      pill.addEventListener('click', async () => {
        const res = parseInt(pill.dataset.res, 10);
        await applyResolutionChange(res);
      });
    });

    if (resFine) {
      const debouncedRebuild = ((fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; })(async res => {
        if (state.vox && window.singleSceneViewer?.tilesContainer) {
          await this._rebuildSingleSceneVoxels(res);
        }
      }, 200);

      resFine.addEventListener('input', e => {
        const res = updateResolutionUI(e.target.value);
        debouncedRebuild(res);
      });
    }

    if (resInput) {
      const commit = async () => {
        await applyResolutionChange(resInput.value);
      };
      resInput.addEventListener('change', commit);
      resInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      });
    }

    // No local vox toggle; Single Scene mirrors global state

    // Fetch tiles button
    if (fetchBtn) {
      fetchBtn.addEventListener('click', async () => {
        const apiKey = this.getKey();
        const coordsInput = document.querySelector('#single-scene-coords');
        // Use the new SSE slider for single scene
        const sseInput = document.querySelector('#single-scene-sse');

        // Get coordinates from single scene panel or fall back to main coords
        let lat, lon;
        if (coordsInput && coordsInput.value.trim()) {
          const coords = coordsInput.value.trim().split(',');
          lat = parseFloat(coords[0]);
          lon = parseFloat(coords[1]);
        } else {
          [lat, lon] = this.getLatLon();
        }

        // Get SSE from the slider (default 20)
        const sse = sseInput ? parseInt(sseInput.value) || 20 : 20;

        // Radius in meters (controls how large an area to fetch)
        const radiusM = radiusSlider ? clampRadiusValue(radiusSlider.value) : 500;

        // If no API key, we'll use the fallback server from config

        if (isNaN(lat) || isNaN(lon)) {
          this._showSingleSceneLog();
          this._logSingleScene('❌ Invalid coordinates. Please select a location on the map.');
          return;
        }

        try {
          fetchBtn.disabled = true;
          fetchBtn.textContent = 'Fetching...';
          this._showSingleSceneLog();
          this._logSingleScene('Fetching tiles...');

          if (!this._singleSceneFetcher) this._singleSceneFetcher = new SingleSceneFetcher();
          const serverUrl = getActiveServerUrl(apiKey);
          // zoom auto-computed from radius; pass null for zoom and provide radiusM
          const urls = await this._singleSceneFetcher.fetch3DTiles(lat, lon, null, sse, apiKey, this._logSingleScene.bind(this), radiusM, serverUrl);

          if (urls.length === 0) {
            this._logSingleScene('No tiles found for this location');
            return;
          }

          // Load the tiles into the existing viewer
          if (window.singleSceneViewer) {
            await window.singleSceneViewer.loadGLTFTiles(urls, this._logSingleScene.bind(this));
          }

          // Mirror global Vox/MC state into Single Scene and pre-bake if needed
          await this.syncSingleSceneToGlobalVoxState(true);

          // Show tile controls and enable voxels toggle
          document.querySelector('#single-scene-tile-controls')?.classList.remove('hidden');
          document.querySelector('#single-scene-tile-count').textContent = urls.length;

          // Apply debug state to viewer if present
          if (debugTilesToggle && window.singleSceneViewer?.setDebugTiles) {
            window.singleSceneViewer.setDebugTiles(!!debugTilesToggle.checked);
          }

          this._logSingleScene(`Loaded ${window.singleSceneViewer?.gltfArray.length ?? 0} of ${urls.length} tiles`);

        } catch (error) {
          this._logSingleScene(`Error: ${error.message}`);
        } finally {
          fetchBtn.disabled = false;
          fetchBtn.textContent = 'Fetch Tiles';
        }
      });
    }

    // Debug Tiles toggle (per-tile bounding boxes)
    if (debugTilesToggle) {
      debugTilesToggle.addEventListener('change', () => {
        window.singleSceneViewer?.setDebugTiles?.(!!debugTilesToggle.checked);
      });
    }

    // Tile visibility slider
    if (tileSlider) {
      tileSlider.addEventListener('input', () => {
        const value = parseInt(tileSlider.value);
        if (window.singleSceneViewer && window.singleSceneViewer.gltfArray) {
          window.singleSceneViewer.gltfArray.forEach((gltf, index) => {
            if (gltf && gltf.scene) {
              gltf.scene.visible = index <= value;
            }
          });
        }
      });
    }

    // No local voxelize toggle; rebuilding is driven by global state + controls

    // Download button (Single Scene panel)
    if (downloadBtn) {
      downloadBtn.addEventListener('click', () => {
        if (window.singleSceneViewer) {
          window.singleSceneViewer.generateCombineGltf();
          this._logSingleScene('Export started...');
        }
      });
    }

    // Global Export GLB button (exports whatever is currently visible)
    const exportGlbBtn = document.getElementById('export-glb-btn');
    if (exportGlbBtn) {
      exportGlbBtn.addEventListener('click', async () => {
        if (exportGlbBtn.disabled) {
          this._logSingleScene?.('Confirm the export requirements first.');
          return;
        }
        // Prefer Single Scene if active, else main viewer
        if (window.singleSceneViewer && window.singleSceneViewer.scene) {
          exportGlbBtn.disabled = true;
          exportGlbBtn.textContent = 'Preparing GLB…';
          try {
            await window.singleSceneViewer.generateCombineGltf();
            this._logSingleScene?.('GLB exported');
          } catch (error) { this._logSingleScene?.(`Export failed: ${error.message}`); }
          finally { exportGlbBtn.textContent = 'Export Current Scene as GLB'; applyComplianceState(); }
        } else if (window.viewer && window.viewer.scene) {
          // If you have a main viewer, call its export method here
          window.viewer.generateCombineGltf?.();
          // Optionally log to main status
          this.setStatus?.('Export started (Main Viewer)...');
        } else {
          alert('No active scene to export.');
        }
      });
    }

    // Single-Scene now mirrors global MC/vox; remove local MC toggle and handlers

    // ── Export row (format select + button)
    let exportRow = document.querySelector('#single-scene-export-row');
    if (!exportRow) {
      const panel = document.querySelector('#single-scene-panel') || document.body;
      exportRow = document.createElement('div');
      exportRow.id = 'single-scene-export-row';
      exportRow.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin:.5rem 0;';
      exportRow.innerHTML = `
      <select id="single-scene-export-format" style="padding:.25rem;">
        <option value="mcfunction">mcfunction (vanilla)</option>
        <option value="palette.json">palette JSON (.schem-ready)</option>
        <option value="nbt">Structure (.nbt)</option>
        <option value="schem">WorldEdit v2 (.schem)</option>
        <option value="schematic">MCEdit legacy (.schematic)</option>
      </select>
      <button id="single-scene-export-btn" style="padding:.35rem .6rem;">Export</button>
    `;
      panel.appendChild(exportRow);
    }
    const exportBtn = exportRow.querySelector('#single-scene-export-btn');
    const exportFmt = exportRow.querySelector('#single-scene-export-format');

    const downloadText = (filename, text) => {
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 250);
    };

    const complianceChecks = Array.from(document.querySelectorAll('[data-single-scene-compliance]'));
    const applyComplianceState = () => {
      const ready = complianceChecks.every(cb => cb.checked);
      [exportBtn, exportGlbBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = !ready;
      });
    };
    complianceChecks.forEach(cb => cb.addEventListener('change', applyComplianceState));
    applyComplianceState();

    exportBtn.addEventListener('click', async () => {
      if (exportBtn.disabled) {
        this._logSingleScene?.('Confirm the export requirements first.');
        return;
      }
      const viewer = window.singleSceneViewer;
      const vgrid = viewer?.voxelizer?._voxelGrid;
      if (!viewer || !vgrid) { this._logSingleScene('❌ No voxel grid to export'); return; }

      try {
        exportBtn.disabled = true;
        exportBtn.textContent = 'Preparing…';
        const fmt = exportFmt.value;
        const bytes = await viewer.exportSession.run(vgrid, fmt, text => this._logSingleScene(text));
        downloadExport(bytes, `structure.${fmt}`);
        this._logSingleScene(`Exported .${fmt}`);
      } catch (e) {
        console.error(e);
        this._logSingleScene('❌ Export failed');
      } finally { exportBtn.textContent = 'Export'; applyComplianceState(); }
    });

    // No duplicate toggle handler — visibility logic handled by the single toggle above
  }

  _initializeSingleSceneMap() {
    const mapContainer = document.querySelector('#single-scene-map');
    if (!mapContainer || typeof L === 'undefined') return;
    try {
      const [lat, lon] = this.getLatLon();
      const map = L.map('single-scene-map').setView([lat || 40.6891, lon || -74.0446], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
      }).addTo(map);

      let marker = L.marker([lat || 40.6891, lon || -74.0446]).addTo(map);
      map.whenReady(() => this._scheduleMiniMapInvalidate());

      map.on('click', (e) => {
        const { lat, lng } = e.latlng;
        marker.setLatLng([lat, lng]);
        // Persist into the shared coords so the Fetch button uses these.
        this.setLatLon([lat, lng]);
      });

      // When the mini-map view changes (pan/zoom), update marker + coords
      map.on('moveend', () => {
        const c = map.getCenter();
        marker.setLatLng([c.lat, c.lng]);
        this.setLatLon([c.lat, c.lng]);
        const coordsInput = document.querySelector('#single-scene-coords');
        if (coordsInput) coordsInput.value = `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`;
      });

      // Save handles for later sync
      this._singleMap = map;
      this._singleMapMarker = marker;
      // Observers for size/visibility changes
      this._installMiniMapObservers(map, document.querySelector('#single-scene-panel'), mapContainer);
    } catch (error) {
      console.error('Failed to initialize single scene map:', error);
    }
  }

  // Debounced (RAF) Leaflet invalidate
  _scheduleMiniMapInvalidate() {
    if (!this._singleMap) return;
    cancelAnimationFrame(this._miniMapInvalidateRAF);
    this._miniMapInvalidateRAF = requestAnimationFrame(() => {
      try { this._singleMap.invalidateSize(true); } catch { }
    });
  }

  // Install observers to react to panel visibility and size changes
  _installMiniMapObservers(map, panelEl, containerEl) {
    // ResizeObserver
    try {
      this._miniMapResizeObs?.disconnect?.();
      this._miniMapResizeObs = new ResizeObserver(() => this._scheduleMiniMapInvalidate());
      if (panelEl) this._miniMapResizeObs.observe(panelEl);
      if (containerEl) this._miniMapResizeObs.observe(containerEl);
    } catch { }

    // MutationObserver for class changes (.hidden toggle)
    if (panelEl) {
      this._miniMapMutationObs?.disconnect?.();
      this._miniMapMutationObs = new MutationObserver(muts => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            if (!panelEl.classList.contains('hidden')) this._scheduleMiniMapInvalidate();
          }
        }
      });
      this._miniMapMutationObs.observe(panelEl, { attributes: true, attributeFilter: ['class'] });
      panelEl.addEventListener('transitionend', () => this._scheduleMiniMapInvalidate(), { passive: true });
    }

    // Window resize handler (light debounce via RAF)
    this._miniMapWindowResizeHandler && window.removeEventListener('resize', this._miniMapWindowResizeHandler);
    this._miniMapWindowResizeHandler = () => this._scheduleMiniMapInvalidate();
    window.addEventListener('resize', this._miniMapWindowResizeHandler, { passive: true });
  }

  // Sync mini-map + single scene coords input with current position
  _syncSingleSceneMiniMap(lat, lon) {
    if (this._singleMap) {
      this._singleMap.setView([lat, lon]);
      this._singleMapMarker?.setLatLng([lat, lon]);
    }
    const coordsInput = document.querySelector('#single-scene-coords');
    if (coordsInput) coordsInput.value = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  _showSingleSceneLog() {
    const log = document.querySelector('#single-scene-log');
    if (log) log.classList.remove('hidden');
  }

  _logSingleScene(message) {
    const log = document.querySelector('#single-scene-log');
    if (log) {
      log.textContent += message + '\n';
      log.scrollTop = log.scrollHeight;
    }
    console.log('[Single Scene]', message);
  }

  /* Single-Scene helpers */
  _setSingleSceneVisibility(showVoxels) {
    const viewer = window.singleSceneViewer;
    const container = viewer?.tilesContainer;
    if (!viewer || !container) return;

    const vox = container.getObjectByName('singleSceneVoxels');
    container.children.forEach(ch => {
      if (vox && ch === vox) ch.visible = !!showVoxels;
      else ch.visible = !showVoxels || !vox;
    });
  }

  async _rebuildSingleSceneVoxels(resolution) {
    const viewer = window.singleSceneViewer;
    const container = viewer?.tilesContainer;
    if (!viewer || !container) { this._logSingleScene('? No tiles loaded'); return; }
    const rotDeg = parseInt(document.querySelector('#single-scene-rot')?.value || '0', 10) || 0; // degrees to sample at

    this._ssVoxVersion = (this._ssVoxVersion ?? 0) + 1;
    const myVersion = this._ssVoxVersion;

    viewer._voxelController?.terminate();
    // Keep the previous preview until the replacement is ready. Serialize only
    // original sources, never the packed preview attached alongside them.
    const old = container.getObjectByName('singleSceneVoxels');
    container.updateMatrixWorld(true);
    const source = new THREE.Group();
    source.matrix.copy(container.matrixWorld); source.matrixAutoUpdate = false;
    for (const child of container.children) if (child !== old) source.add(child.clone(true));
    source.updateMatrixWorld(true);
    const containerBox = new THREE.Box3().setFromObject(source);
    const containerSize = containerBox.getSize(new THREE.Vector3());
    const maxDim = Math.max(containerSize.x, containerSize.y, containerSize.z, 1);

    const childDiags = [];
    for (const child of source.children) {
      if (!child || child.name === 'singleSceneVoxels') continue;
      const box = new THREE.Box3().setFromObject(child);
      if (box.isEmpty()) continue;
      const diag = box.getSize(new THREE.Vector3()).length();
      if (Number.isFinite(diag) && diag > 0) childDiags.push(diag);
    }
    childDiags.sort((a, b) => a - b);
    const medianDiag = childDiags.length ? childDiags[Math.floor(childDiags.length / 2)] : maxDim;
    const tileDiag = Math.max(medianDiag, 1e-3);
    const densitySetting = Math.max(1, Number(resolution) || 64);
    const tilesAcross = Math.max(1, maxDim / tileDiag);
    const computedResolution = Math.max(8, Math.round(densitySetting * tilesAcross));
    const approxVoxelMeters = tileDiag / densitySetting;
    this._logSingleScene(`?? (Re)voxelizing @ ${computedResolution} (~${approxVoxelMeters.toFixed(2)} m voxels per tile).`);

    let vox;
    try {
      vox = await voxelizeModel({
        model: source,
        renderer: viewer.renderer,
        scene: viewer.scene,
        resolution: computedResolution,
        needGrid: true,
        renderMode: 'packed',
        method: getActiveVoxelMethod(),
        onStart: controller => { viewer._voxelController = controller; },
        preRotateYDeg: rotDeg
      });
    } catch (e) {
      this._logSingleScene(`? Voxelization error: ${e?.message || e}`);
      return;
    }

    if (vox?.stats?.fallbackReason) {
      this._logSingleScene(`? ${vox.stats.fallbackReason}`);
    }
    if (vox?.stats?.dispatchReason) {
      this._logSingleScene(vox.stats.dispatchReason);
    }

    if (myVersion !== this._ssVoxVersion || viewer.destroyed || viewer.tilesContainer !== container) {
      // stale
      vox?.voxelMesh?.traverse(n => {
        if (n.isMesh) { n.geometry?.dispose(); (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => m?.dispose?.()); }
      });
      return;
    }

    if (!vox || !vox.voxelMesh) {
      this._logSingleScene('? Voxelizer returned no geometry');
      return;
    }
    const voxelMesh = vox.voxelMesh;
    const rawGrid = vox._voxelGrid; // original grid in the mesh’s creation frame

    // Preserve original vertex-color material BEFORE any MC swap
    voxelMesh.traverse(n => { if (n.isMesh && !n.userData.origMat) n.userData.origMat = n.material; });

    // Prepare counter-rotation so only sampling orientation changes
    const pivot = containerBox.getCenter(new THREE.Vector3());
    const Tneg = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const RyInv = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-rotDeg));
    const Tpos = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
    const counterM = new THREE.Matrix4().multiplyMatrices(Tpos, new THREE.Matrix4().multiplyMatrices(RyInv, Tneg));

    // world -> container-local + attach (after counter-rotation)
    const inv = new THREE.Matrix4().copy(container.matrixWorld).invert();
    // Combined matrix that we apply to geometry; use same to rebase voxelGrid
    const Mreb = new THREE.Matrix4().multiplyMatrices(inv, counterM);
    voxelMesh.applyMatrix4(Mreb);
    voxelMesh.traverse(node => node.layers.set(1));

    voxelMesh.matrixAutoUpdate = false;
    voxelMesh.name = 'singleSceneVoxels';
    voxelMesh.userData.resolution = resolution;
    container.add(voxelMesh);
    if (old) dispose(old);
    viewer.exportSession.dispose();
    // Ensure transforms are up-to-date before any material/shader compilation
    try { container.updateMatrixWorld(true); } catch { }
    try { voxelMesh.updateMatrixWorld(true); } catch { }
    viewer.voxelMeshes = [voxelMesh];
    viewer.voxelizer = vox;

    await viewer.setMinecraftEnabled(state.mc);

    // Materials already set earlier; no additional MC swap here

    // Respect global voxel visibility
    this._setSingleSceneVisibility(!!state.vox);

    this._logSingleScene(`✅ Voxels ready (${vox.voxelCount ?? '—'}) @ ${resolution}`);
  }

  _initializeBasicElements() {
    // Elements
    this.keyInput = document.querySelector('#google-api-key');
    if (this.keyInput) {
      const saved = (localStorage.getItem('token') || '').trim();
      if (saved) this.keyInput.value = saved; // keep HTML default otherwise
    }
    const saveBtn = document.querySelector('#save-settings');
    if (saveBtn) {
      saveBtn.onclick = () => {
        if (this.keyInput) {
          localStorage.setItem('token', this.keyInput.value.trim());
          toast('Saved API key');
          // Refresh tiles when API key changes
          this.refreshTiles();
        }
      };
    }

    this.coordsEl = document.querySelector('#lat-lng');
    this.sseEl = document.querySelector('#sse');
    this.status = document.querySelector('#status-chip');
    this.footerHint = document.querySelector('#composer-hint');

    // Composer
    this.search = document.querySelector('#place-search');
    this.sendBtn = document.querySelector('#composer-send');

    // Suggestions + search results  
    this.suggestions = document.querySelector('#suggestions .composer');
    this.resultsWrap = document.querySelector('#search-results');
    this.resultsList = this.resultsWrap?.firstElementChild;

    // Vox controls (in drawer)
    this.toggleVox = document.querySelector('#toggle-vox');
    this.toggleMC = document.querySelector('#toggle-mc');
    this.debugImageryRow = document.querySelector('#debug-imagery-row');
    this.toggleDebugImagery = document.querySelector('#toggle-debug-imagery');
    this.resPills = [...document.querySelectorAll('.res-pill')];
    this.resFine = document.querySelector('#res-fine');

    // Voxelization method controls
    this.voxelMethodRadios = [...document.querySelectorAll('input[name="voxel-method"]')];

    // Load saved voxelization method (default to 2.5d-scan)
    const savedMethod = localStorage.getItem('voxelMethod') || '2.5d-scan';
    this.voxelMethodRadios.forEach(radio => {
      radio.checked = radio.value === savedMethod;
    });

    // Load saved coords
    const saved = localStorage.getItem('coords');
    if (saved && this.coordsEl) this.coordsEl.value = saved;

    // Wire up UI (only if elements exist)
    if (this.suggestions) this._renderSuggestions();
    if (this.search && this.sendBtn) this._wireComposer();
    if (this.search) this._wireSearch();
    if (this.toggleVox) this._wireVoxUI();
    if (this.voxelMethodRadios.length) this._wireVoxelMethods();
    this._wireCameraControls();

    this.setStatus('Ready');
  }

  getKey() {
    if (this.keyInput && this.keyInput.value.trim()) {
      return this.keyInput.value.trim();
    }
    // Fallback to localStorage if input field is empty
    return localStorage.getItem('token') || '';
  }
  getSSE() { return this.sseEl ? +this.sseEl.value : 20; }
  getLatLon() {
    return this.coordsEl ? this.coordsEl.value.split(',').map(Number) : [37.7749, -122.4194];
  }
  log() { }
  setLatLon([lat, lon]) {
    if (this.coordsEl) {
      this.coordsEl.value = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      localStorage.setItem('coords', this.coordsEl.value);
    }
    // Reflect into Single Scene mini-map & input
    try { this._syncSingleSceneMiniMap(lat, lon); } catch { }
  }
  setStatus(t) {
    if (this.status) this.status.textContent = t;

    // Update footer citation based on status
    if (this.footerHint) {
      if (t.includes('Loading') || t.includes('Streaming')) {
        this.footerHint.textContent = '© Google Earth imagery';
      } else if (t.includes('API key')) {
        this.footerHint.textContent = 'Using free geocoder (Open-Meteo, fallback Nominatim)';
      } else {
        this.footerHint.textContent = '© Google Earth imagery';
      }
    }
  }
  onFetch = null;

  /* ─── Voxels panel ───────────────────────────────────────────── */
  _wireVoxUI() {
    const highlightResPill = (val) => {
      document.querySelectorAll('.res-pill').forEach(b => {
        b.classList.remove('bg-white', 'text-neutral-900');
        b.classList.add('opacity-80');
      });
      const active = document.querySelector(`.res-pill[data-res="${val}"]`);
      if (active) {
        active.classList.remove('opacity-80');
        active.classList.add('bg-white', 'text-neutral-900');
      }
    };

    // Set initial state - voxels ON by default
    state.vox = true;
    if (this.toggleVox) {
      this.toggleVox.checked = true;
    }
    if (this.toggleMC) {
      this.toggleMC.disabled = false;
    }
    highlightResPill(state.resolution);

    if (this.toggleVox) {
      this.toggleVox.addEventListener('change', e => {
        state.vox = e.target.checked;
        if (this.toggleMC) {
          this.toggleMC.disabled = !state.vox;
          if (!state.vox) {
            this.toggleMC.checked = false;
            state.mc = false;
          }
        }
        // Show/Hide Debug imagery row when voxel mode changes
        if (this.debugImageryRow) {
          this.debugImageryRow.style.display = state.vox ? '' : 'none';
        }
        if (!state.vox) {
          // Reset debugImagery when voxels are off
          state.debugImagery = false;
          if (this.toggleDebugImagery) this.toggleDebugImagery.checked = false;
        }
        updateVis();                          // main viewer
        this.syncSingleSceneToGlobalVoxState(false);
      });
    }

    if (this.toggleMC) {
      this.toggleMC.addEventListener('change', e => {
        state.mc = e.target.checked;
        updateVis();                          // main viewer
        this.syncSingleSceneToGlobalVoxState(false);
      });
    }

    if (this.toggleDebugImagery) {
      this.toggleDebugImagery.addEventListener('change', e => {
        state.debugImagery = e.target.checked;
        updateVis();
      });
    }

    this.resPills.forEach(btn => {
      btn.addEventListener('click', () => {
        const r = parseInt(btn.dataset.res, 10);
        state.resolution = r;
        if (this.resFine) this.resFine.value = r;
        highlightResPill(r);
        rebuildAll();
      });
    });

    if (this.resFine) {
      this.resFine.addEventListener('change', e => {
        const r = parseInt(e.target.value, 10);
        state.resolution = r;
        highlightResPill(r);
        rebuildAll();
      });
    }
  }

  /* ─── Voxelization Methods panel ─────────────────────────────── */
  _wireVoxelMethods() {
    this.voxelMethodRadios.forEach(radio => {
      radio.addEventListener('change', e => {
        if (e.target.checked) {
          localStorage.setItem('voxelMethod', e.target.value);
          console.log('Voxelization method changed to:', e.target.value);
          // Always trigger rebuild when method changes (user wants to see the difference)
          if (state.vox) {
            rebuildAll();
          }
        }
      });
    });
  }

  getVoxelizationMethod() {
    const selected = this.voxelMethodRadios.find(r => r.checked);
    return selected ? selected.value : '2.5d-scan'; // default fallback
  }

  refreshTiles() {
    if (tiles && tiles.layer) {
      // Force refresh of the Google Earth tiles layer
      tiles.layer.refresh();
    }
  }

  /* ─── Suggestions (chips above composer) ─────────────────────── */
  _renderSuggestions() {
    const PICKS = [
      { label: 'Paris', lat: 48.85837, lon: 2.29448, view: { height: 360, tilt: 45, heading: 220 } },
      { label: 'New York', lat: 40.75800, lon: -73.98550, view: { height: 360, tilt: 48, heading: 30 } },
      { label: 'Tokyo', lat: 35.65858, lon: 139.74543, view: { height: 340, tilt: 47, heading: -20 } },
      { label: 'Sydney', lat: -33.85678, lon: 151.21530, view: { height: 360, tilt: 43, heading: 120 } },
      { label: 'Cairo', lat: 29.97923, lon: 31.13420, view: { height: 420, tilt: 38, heading: -140 } },
      { label: 'Rio de Janeiro', lat: -22.95192, lon: -43.21049, view: { height: 2840, tilt: 43, heading: -20 } },
      { label: 'San Francisco', lat: 37.81993, lon: -122.47825, view: { height: 420, tilt: 41, heading: 0 } },
      { label: 'London', lat: 51.50073, lon: -0.12463, view: { height: 340, tilt: 46, heading: 90 } },
    ];
    this.suggestions.innerHTML = '';
    for (const p of PICKS) {
      const b = document.createElement('button');
      b.className = 'flex-shrink-0 rounded-lg bg-white/5 hover:bg-white/10 px-2 py-1 text-xs text-nowrap transition-all';
      b.textContent = p.label;
      b.onclick = () => {
        // Update the search input field with the selected location
        if (this.search) {
          this.search.value = p.label;
        }
        this._goTo(p.lat, p.lon, p.view);
      };
      this.suggestions.appendChild(b);
    }
  }

  /* ─── Bottom composer behavior ───────────────────────────────── */
  _wireComposer() {
    const tryLatLon = (s) => {
      const m = s.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
    };

    // Update send button state based on input text
    const updateSendButton = () => {
      const hasText = this.search.value.trim().length > 0;
      if (hasText) {
        this.sendBtn.disabled = false;
        this.sendBtn.className = 'w-9 h-9 rounded-full flex items-center justify-center bg-white text-black hover:bg-white/90 transition-all cursor-pointer';
        this.sendBtn.querySelector('span').className = 'material-symbols-rounded material-bold text-lg';
      } else {
        this.sendBtn.disabled = true;
        this.sendBtn.className = 'w-9 h-9 rounded-full flex items-center justify-center bg-white/5 text-white/40 cursor-not-allowed transition-all';
        this.sendBtn.querySelector('span').className = 'material-symbols-rounded material-bold text-lg';
      }
    };

    // Initial state
    updateSendButton();

    // Update button state as user types
    this.search.addEventListener('input', updateSendButton);

    this.sendBtn.addEventListener('click', (e) => {
      if (this.sendBtn.disabled) {
        e.preventDefault();
        return;
      }

      const text = this.search.value.trim();
      if (!text) return;

      const maybe = tryLatLon(text);
      if (maybe) {
        this._goTo(maybe[0], maybe[1]);
      } else {
        // trigger geocode flow
        this._geocode(text, true);
      }
    });

    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !this.sendBtn.disabled) {
        this.sendBtn.click();
      }
    });
  }

  /* ─── Geocoder + results popup ───────────────────────────────── */
  _wireSearch() {
    const outsideClick = (e) => {
      const wrap = this.resultsWrap;
      if (!wrap.classList.contains('hidden') && !wrap.contains(e.target) && e.target !== this.search) {
        this._showResults(false);
      }
    };
    document.addEventListener('click', outsideClick);

    const deb = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    this.search.addEventListener('input', deb(() => {
      const q = this.search.value.trim();
      if (q.length < 3) return this._showResults(false);
      this._geocode(q, false);
    }, 250));
  }

  async _geocode(q, autoGo) {
    const render = (items) => {
      const list = this.resultsList;
      list.innerHTML = '';
      if (!items || !items.length) return this._showResults(false);
      for (const it of items) {
        const el = document.createElement('button');
        el.className = 'w-full text-left px-3 py-2 hover:bg-white/5 text-sm break-words';
        el.innerHTML = `<div class="font-medium truncate pr-2">${it.name}</div>
                        <div class="text-xs opacity-70 truncate pr-2">${it.addr}</div>`;
        el.onclick = () => {
          // Update the search input field with the selected location name
          if (this.search) {
            this.search.value = it.name;
          }
          this._goTo(it.lat, it.lon);
          this._showResults(false);
        };
        list.appendChild(el);
      }
      this._showResults(true);
      if (autoGo) list.firstElementChild?.click();
    };

    // 1) Open-Meteo (free)
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
      if (r.ok) {
        const j = await r.json();
        if (j?.results?.length) {
          return render(j.results.map(f => ({
            name: f.name, addr: [f.admin1, f.country].filter(Boolean).join(', '),
            lat: f.latitude, lon: f.longitude
          })));
        }
      }
    } catch { }

    // 2) OSM Nominatim (fallback)
    try {
      const r2 = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1`);
      if (r2.ok) {
        const j2 = await r2.json();
        return render(j2.map(f => ({
          name: f.display_name.split(',')[0],
          addr: f.display_name,
          lat: parseFloat(f.lat),
          lon: parseFloat(f.lon)
        })));
      }
    } catch { }

    render([]);
  }

  _showResults(on) {
    document.querySelector('#search-results').classList.toggle('hidden', !on);
  }

  _goTo(lat, lon, view) {
    this.setLatLon([lat, lon]);
    window.__desiredView = view || null; // add this line
    this.onFetch?.();
  }

  /* ─── Camera Controls ─────────────────────────────────────────── */
  _wireCameraControls() {
    let cameraMode = 'orbit'; // 'orbit' or 'freecam'
    let freecamKeys = { w: false, a: false, s: false, d: false, shift: false, space: false };
    let freecamSpeed = 100; // units per second
    let lastFrameTime = performance.now();

    // Mouse look variables for freecam
    let isMouseLocked = false;
    let mouseSensitivity = 0.002; // radians per pixel
    let yaw = 0; // horizontal rotation
    let pitch = 0; // vertical rotation
    let maxPitch = Math.PI / 2 - 0.1; // prevent gimbal lock

    // Get control elements
    const cameraModeBtn = document.querySelector('#camera-mode-btn');
    const compassBtn = document.querySelector('#compass-btn');
    const compassNeedle = document.querySelector('#compass-needle');
    const zoomInBtn = document.querySelector('#zoom-in-btn');
    const zoomOutBtn = document.querySelector('#zoom-out-btn');
    const tiltUpBtn = document.querySelector('#tilt-up-btn');
    const tiltDownBtn = document.querySelector('#tilt-down-btn');

    // Pointer lock for freecam mouse look
    const canvas = renderer.domElement;

    const requestPointerLock = () => {
      if (cameraMode === 'freecam' && !isMouseLocked) {
        canvas.requestPointerLock();
      }
    };

    const onPointerLockChange = () => {
      isMouseLocked = document.pointerLockElement === canvas;
    };

    const onMouseMove = (e) => {
      if (!isMouseLocked || cameraMode !== 'freecam') return;

      // Update yaw and pitch based on mouse movement
      yaw -= e.movementX * mouseSensitivity;
      pitch -= e.movementY * mouseSensitivity;
      pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));

      // Apply rotation to camera immediately
      if (camera) {
        camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));

        // Update controls target to maintain orbit mode compatibility
        if (controls) {
          const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
          controls.target.copy(camera.position).add(direction.multiplyScalar(100));
        }
      }
    };

    // Add mouse event listeners
    canvas.addEventListener('click', requestPointerLock);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('mousemove', onMouseMove);

    // Exit pointer lock when switching to orbit mode
    const exitPointerLock = () => {
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
    };

    // Freecam keyboard controls
    const handleKeyDown = (e) => {
      if (cameraMode !== 'freecam') return;
      const key = e.key.toLowerCase();
      if (key === 'w') freecamKeys.w = true;
      if (key === 'a') freecamKeys.a = true;
      if (key === 's') freecamKeys.s = true;
      if (key === 'd') freecamKeys.d = true;
      if (key === 'shift') freecamKeys.shift = true;
      if (key === ' ') { freecamKeys.space = true; e.preventDefault(); }
      if (key === 'escape') exitPointerLock();
    };

    const handleKeyUp = (e) => {
      if (cameraMode !== 'freecam') return;
      const key = e.key.toLowerCase();
      if (key === 'w') freecamKeys.w = false;
      if (key === 'a') freecamKeys.a = false;
      if (key === 's') freecamKeys.s = false;
      if (key === 'd') freecamKeys.d = false;
      if (key === 'shift') freecamKeys.shift = false;
      if (key === ' ') freecamKeys.space = false;
    };

    // Add keyboard event listeners
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    // Freecam movement update (runs continuously in render loop)
    const updateFreecam = () => {
      if (cameraMode !== 'freecam' || !camera) return;

      const currentTime = performance.now();
      const deltaTime = (currentTime - lastFrameTime) / 1000;
      lastFrameTime = currentTime;

      // Check if any movement keys are pressed
      const hasMovement = freecamKeys.w || freecamKeys.a || freecamKeys.s || freecamKeys.d || freecamKeys.shift || freecamKeys.space;

      if (hasMovement) {
        const speed = freecamSpeed * deltaTime * (freecamKeys.shift ? 3 : 1);

        // Get camera direction vectors
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0);

        // Calculate movement
        const movement = new THREE.Vector3();
        if (freecamKeys.w) movement.add(forward.clone().multiplyScalar(speed));
        if (freecamKeys.s) movement.add(forward.clone().multiplyScalar(-speed));
        if (freecamKeys.d) movement.add(right.clone().multiplyScalar(speed));
        if (freecamKeys.a) movement.add(right.clone().multiplyScalar(-speed));
        if (freecamKeys.space) movement.add(up.clone().multiplyScalar(speed));
        if (freecamKeys.shift && !freecamKeys.space) movement.add(up.clone().multiplyScalar(-speed / 3));

        // Apply movement
        camera.position.add(movement);

        // Update controls target to maintain orbit mode compatibility
        if (controls) {
          const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
          controls.target.copy(camera.position).add(direction.multiplyScalar(100));
        }
      }
    };

    // Update compass needle rotation based on camera
    const activeOrbit = () => window.singleSceneViewer ?? { camera, controls };
    const updateCompass = () => {
      const { camera } = activeOrbit();
      if (compassNeedle && camera) {
        const forward = new THREE.Vector3(0, 0, -1);
        forward.applyQuaternion(camera.quaternion);
        const angle = Math.atan2(forward.x, forward.z);
        const degrees = THREE.MathUtils.radToDeg(angle);
        compassNeedle.style.transform = `rotate(${-degrees}deg)`;
      }
    };

    // Update compass during camera movement and freecam
    if (controls) {
      controls.addEventListener('change', updateCompass);
    }

    // Add freecam update to render loop
    window.freecamUpdateFn = updateFreecam;

    // Camera Mode Toggle
    if (cameraModeBtn) {
      cameraModeBtn.addEventListener('click', () => {
        if (cameraMode === 'orbit') {
          // Switch to freecam mode
          cameraMode = 'freecam';
          if (controls) {
            controls.enabled = false; // Disable orbit controls
          }

          // Initialize freecam rotation from current camera orientation
          const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
          yaw = euler.y;
          pitch = euler.x;

          cameraModeBtn.querySelector('span').textContent = 'videocam';
          cameraModeBtn.title = 'Switch to Orbit Mode (Click canvas for mouse look)';
        } else {
          // Switch to orbit mode
          cameraMode = 'orbit';
          exitPointerLock(); // Exit pointer lock when switching to orbit

          if (controls) {
            controls.enabled = true;
            controls.enablePan = true;
            controls.screenSpacePanning = false;
            controls.mouseButtons = {
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.PAN
            };
            // Update controls target to current camera look-at point
            const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
            controls.target.copy(camera.position).add(direction.multiplyScalar(100));
          }
          cameraModeBtn.querySelector('span').textContent = '360';
          cameraModeBtn.title = 'Switch to Freecam Mode (WASD + Mouse)';
        }
      });
    }

    // Compass Reset
    if (compassBtn) {
      compassBtn.addEventListener('click', () => {
        const { camera, controls } = activeOrbit();
        if (!camera) return;

        if (cameraMode === 'freecam' && !window.singleSceneViewer) {
          // In freecam, just reset camera rotation to face north
          const currentPos = camera.position.clone();
          camera.position.copy(currentPos);
          camera.lookAt(currentPos.x, currentPos.y, currentPos.z - 100);
        } else if (controls) {
          // In orbit mode, reset to face north from current distance
          const currentPosition = camera.position.clone();
          const target = controls.target.clone();
          const distance = currentPosition.distanceTo(target);

          const newPosition = target.clone();
          newPosition.add(new THREE.Vector3(0, currentPosition.y - target.y, distance));

          // Smooth animation
          const startPos = currentPosition.clone();
          const startTime = performance.now();
          const duration = 500;

          const animate = (time) => {
            const elapsed = time - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);

            camera.position.lerpVectors(startPos, newPosition, eased);
            camera.lookAt(target);
            controls.update();
            updateCompass();

            if (progress < 1) {
              requestAnimationFrame(animate);
            }
          };
          requestAnimationFrame(animate);
        }
      });
    }

    // Zoom Controls
    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => {
        const { camera, controls } = activeOrbit();
        if (cameraMode === 'freecam' && !window.singleSceneViewer) {
          freecamSpeed = Math.min(freecamSpeed * 1.25, 1000);
        } else if (controls) {
          const factor = 0.8;
          const distance = camera.position.distanceTo(controls.target);
          const newDistance = Math.max(distance * factor, controls.minDistance);

          const direction = camera.position.clone().sub(controls.target).normalize();
          camera.position.copy(controls.target).add(direction.multiplyScalar(newDistance));
          controls.update();
        }
      });
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => {
        const { camera, controls } = activeOrbit();
        if (cameraMode === 'freecam' && !window.singleSceneViewer) {
          freecamSpeed = Math.max(freecamSpeed * 0.8, 10);
        } else if (controls) {
          const factor = 1.25;
          const distance = camera.position.distanceTo(controls.target);
          const newDistance = Math.min(distance * factor, controls.maxDistance);

          const direction = camera.position.clone().sub(controls.target).normalize();
          camera.position.copy(controls.target).add(direction.multiplyScalar(newDistance));
          controls.update();
        }
      });
    }

    // Tilt Controls
    if (tiltUpBtn) {
      tiltUpBtn.addEventListener('click', () => {
        const { camera, controls } = activeOrbit();
        if (cameraMode === 'freecam' && !window.singleSceneViewer) {
          camera.rotateX(-0.1);
        } else if (controls && camera) {
          const target = controls.target;
          const position = camera.position.clone();
          const direction = position.sub(target);

          const axis = new THREE.Vector3().crossVectors(direction, camera.up).normalize();
          const angle = -0.2;
          direction.applyAxisAngle(axis, angle);

          camera.position.copy(target).add(direction);
          camera.lookAt(target);
          controls.update();
        }
      });
    }

    if (tiltDownBtn) {
      tiltDownBtn.addEventListener('click', () => {
        const { camera, controls } = activeOrbit();
        if (cameraMode === 'freecam' && !window.singleSceneViewer) {
          camera.rotateX(0.1);
        } else if (controls && camera) {
          const target = controls.target;
          const position = camera.position.clone();
          const direction = position.sub(target);

          const axis = new THREE.Vector3().crossVectors(direction, camera.up).normalize();
          const angle = 0.2;
          direction.applyAxisAngle(axis, angle);

          camera.position.copy(target).add(direction);
          camera.lookAt(target);
          controls.update();
        }
      });
    }

    // Initial compass update
    updateCompass();
  }

  // single-scene map initialized earlier; duplicate removed
}

/* helpers */
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'fixed top-4 right-4 glass elev rounded-xl px-3 py-2 text-sm z-[60]';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1400);
}

// Static attribution; avoid extra root.json fetches that count toward quota
function updateAttributionFromTileset() {
  const hint = document.querySelector('#composer-hint');
  if (hint) {
    hint.innerHTML = `© Google Maps · <a href="https://maps.google.com/help/terms_maps" target="_blank" rel="noopener noreferrer" class="underline opacity-80 hover:opacity-100">Terms</a>`;
  }
}

// Initialize everything when DOM is ready
let ui;
function initializeApp() {
  // Add a small delay to ensure all DOM elements are fully rendered
  setTimeout(() => {
    ui = new HUD();
    initializeMobileUI();

    // Set up UI callbacks after UI is ready
    {
      const [lat, lon] = ui.getLatLon();
      const key = ui.getKey();
      const root = getActiveServerUrl(key);
      if (key) console.log('got key from localStorage; starting Google tiles');
      else console.log('no API key; using fallback server');
      ui.setStatus('Loading tiles...');
      updateAttributionFromTileset();
      ensureTiles(root, key);
      retargetTiles(lat, lon);
    }

    if (ui) {
      ui.onFetch = () => {
        const key = ui.getKey();
        const [lat, lon] = ui.getLatLon();
        const root = getActiveServerUrl(key);

        ui.setStatus(`Streaming ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        updateAttributionFromTileset();        // no network call
        ensureTiles(root, key);
        retargetTiles(lat, lon);
      };
    }
  }, 100);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}

/* ───────────────────────────────  Three.js set-up ─────────────────── */
let scene, camera, controls, renderer, tiles = null;
let isInteracting = false;
let lastInteractionAt = 0;
let interactionIdleTimer = null;
let __desiredView = null; // populated by HUD._goTo
let freecamUpdateFn = null; // Will be set by camera controls
let hasFramedOnce = false; // gate initial auto-framing

/* ─────────────────────────────────── GUI & state ──────────────────── */
const LAYER_IMAGERY = 0;   // Google 3D Tiles
const LAYER_VOXELS = 1;   // Our voxel meshes / MC

const state = { resolution: 64, vox: true, mc: false, debugImagery: false };
let lastVoxelUpdateTime = 0;
const INTERACTION_SETTLE_MS = 180;

function noteInteraction() {
  lastInteractionAt = performance.now();
  isInteracting = true;
  if (interactionIdleTimer) clearTimeout(interactionIdleTimer);
  interactionIdleTimer = setTimeout(() => {
    if (performance.now() - lastInteractionAt >= INTERACTION_SETTLE_MS - 4) {
      isInteracting = false;
      flushPendingVoxelAttachments();
    }
  }, INTERACTION_SETTLE_MS);
}

function isInteractionBusy() {
  return isInteracting || (performance.now() - lastInteractionAt) < INTERACTION_SETTLE_MS;
}

(() => {
  // Stable, zero-stutter baseline: WebGL. Re-enable WebGPU later if desired.
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance'
  });
  if (THREE.SRGBColorSpace !== undefined) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  } else if ('outputEncoding' in renderer) {
    renderer.outputEncoding = LEGACY_SRGB_ENCODING;
  }
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x151c1f);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x202020, 1);
  scene.add(hemi);
  // Lights affect both layers
  hemi.layers.enable(LAYER_IMAGERY);
  hemi.layers.enable(LAYER_VOXELS);

  camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_600_000);
  // Camera can render both layers; we'll toggle them later
  camera.layers.enable(LAYER_IMAGERY);
  camera.layers.enable(LAYER_VOXELS);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxDistance = 3e4;

  controls.addEventListener('start', noteInteraction);
  controls.addEventListener('change', noteInteraction);
  controls.addEventListener('end', noteInteraction);

  window.addEventListener('resize', resize); resize();

  requestAnimationFrame(loop);
})();

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(renderPixelRatio());
  tiles?.setResolutionFromRenderer(camera, renderer);
}

/* ───────────────────────────── TilesRenderer factory ──────────────── */
function frameToView(view = { height: 360, tilt: 60, heading: 0 }) {
  const tilt = THREE.MathUtils.degToRad(view.tilt ?? 60);
  const heading = THREE.MathUtils.degToRad(view.heading ?? 0);
  const r = view.height ?? 360;
  const horiz = Math.cos(tilt) * r;
  const up = Math.sin(tilt) * r;
  const x = Math.cos(heading) * horiz;
  const z = Math.sin(heading) * horiz;

  controls.target.set(0, 0, 0);
  camera.position.set(x, up, z);
  controls.minDistance = 10;
  controls.maxDistance = 30000;
  controls.update();
}

function ensureTiles(root, key) {
  if (tiles) {
    // If the root has changed, we must dispose of the old renderer and start fresh
    if (tiles._rootUrl === root) return;
    for (const tile of [...tiles.group.children]) cleanupTileVoxels(tile);
    voxelLodCache.clear();
    pendingVoxelAttachments.clear();
    scene.remove(tiles.group);
    tiles.dispose();
    tiles = null;
  }

  tiles = new TilesRenderer(root);
  tiles._rootUrl = root; // track the current root
  tiles.registerPlugin(new TileCompressionPlugin());
  // tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(new GLTFExtensionsPlugin({
    dracoLoader: new DRACOLoader()
      .setDecoderPath('https://unpkg.com/three@0.160/examples/jsm/libs/draco/gltf/')
  }));

  // Prefer browser HTTP cache (honors server Cache-Control/ETag)
  tiles.fetchOptions = { cache: 'force-cache' };

  // keep single session id and key everywhere
  tiles.preprocessURL = (u) => {
    if (u.startsWith('blob:') || u.startsWith('data:')) return u;

    // Use the tileset's root URL as the base for relative URLs (important for local/custom servers)
    const url = resolveEarthTileUrl(u, root);
    if (url.pathname.endsWith('/root.json')) {
      url.searchParams.delete('session');
      if (url.hostname === 'tile.googleapis.com' && key) url.searchParams.set('key', key);
      return url.toString();
    }

    if (typeof window !== 'undefined' && window.__photorealSession?.id) {
      const shared = window.__photorealSession;
      if (!__tilesSessionId || shared.id !== __tilesSessionId) {
        __tilesSessionId = shared.id;
        __tilesSessionTs = shared.ts || Date.now();
      }
    }

    if (url.searchParams.has('session')) {
      const s = url.searchParams.get('session');
      if (s && s !== __tilesSessionId) {
        __tilesSessionId = s;
        __tilesSessionTs = Date.now();
        window.__photorealSession = { id: __tilesSessionId, ts: __tilesSessionTs };
      }
    }

    if (__tilesSessionId && Date.now() - __tilesSessionTs > SESSION_MAX_AGE_MS) {
      __tilesSessionId = null;
      window.__photorealSession = null;
    }

    if (__tilesSessionId) {
      url.searchParams.set('session', __tilesSessionId);
      window.__photorealSession = { id: __tilesSessionId, ts: __tilesSessionTs };
    } else {
      url.searchParams.delete('session');
      window.__photorealSession = null;
    }

    // Only append key to Google Earth host
    if (url.hostname === 'tile.googleapis.com' && !url.searchParams.has('key')) {
      url.searchParams.set('key', key);
    }
    return url.toString();
  };

  tiles.errorTarget = ui ? ui.getSSE() : 20;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);

  // Events (no auto-framing here; 'load-tile-set' fires multiple times for nested sets)
  tiles.addEventListener('load-model', onTileLoad);
  tiles.addEventListener('dispose-model', onTileDispose);
  tiles.addEventListener('tile-visibility-change', ({ scene: tileGroup, visible }) => {
    if (!tileGroup) return;
    tileGroup.userData.rendererVisible = visible;
    voxelLodCache.setVisible(tileGroup, visible && state.vox);
    if (!visible) {
      cancelTileVoxelBuild(tileGroup);
      if (tileGroup._voxMesh) tileGroup._voxMesh.visible = false;
    } else if (state.vox) {
      scheduleTileVoxel(tileGroup);
    }
    applyVis(tileGroup);
  });

  scene.add(tiles.group);
  window.tiles = tiles;
}

function retargetTiles(latDeg, lonDeg) {
  if (!tiles) return;
  // Hidden source tiles are detached from tiles.group but may have cached LODs
  // and serialized world transforms. Retarget must invalidate those, too.
  for (const tile of new Set([...tiles.group.children, ...voxelLodCache.tiles.keys()])) cleanupTileVoxels(tile);
  tiles.setLatLonToYUp(
    latDeg * THREE.MathUtils.DEG2RAD,
    lonDeg * THREE.MathUtils.DEG2RAD
  );
  // Frame only when explicitly requested (search/geocode) or first ever.
  const requested = (window.__desiredView || __desiredView) || null;
  if (requested) {
    frameToView(requested);
    window.__desiredView = __desiredView = null;
    hasFramedOnce = true;
  } else if (!hasFramedOnce) {
    frameToView();
    hasFramedOnce = true;
  }
  // Keep Single Scene mini-map centered with main map moves
  try { ui?._syncSingleSceneMiniMap?.(latDeg, lonDeg); } catch { }
}

// Back-compat wrapper for any remaining call sites
function spawnTiles(root, key, latDeg, lonDeg) {
  ensureTiles(root, key);
  retargetTiles(latDeg, lonDeg);
}

// (tile-visibility-change listener now registered inside ensureTiles())

/* ───────────────────── helper to dispose THREE objects ───────────── */
function dispose(o) {
  if (!o) return;
  if (o.userData && o.userData.sourceTile) {
    const tile = o.userData.sourceTile;
    if (tile._voxMesh === o) {
      delete tile._voxMesh;
      delete tile._voxelizer;
      delete tile._voxResolution;
    }
    if (tile._mcMesh === o) delete tile._mcMesh;
    delete o.userData.sourceTile;
  }

  const materials = new Set();
  if (o.traverse && typeof o.traverse === 'function') {
    o.traverse(n => {
      if (n.isMesh) {
        n.geometry?.dispose();
        for (const material of [n.material, n.userData?.origMat, n.userData?.mcMat].flat()) {
          if (material) materials.add(material);
        }
      }
    });
  } else if (o.isMesh) {
    o.geometry?.dispose();
    for (const material of [o.material].flat()) if (material) materials.add(material);
  }
  // Minecraft materials borrow the shared atlas. Packed materials dispose their
  // own private atlas through a dispose listener; do not free borrowed maps.
  for (const material of materials) material.dispose();
  o.parent?.remove(o);
}

/* ───────────────────── per-tile voxel / MC logic ──────────────────── */

const voxelizingTiles = new Set();
const disposingTiles = new Set();
const pendingVoxelAttachments = new Map();
const scheduledVoxelTiles = new Set();
let pendingVoxelFlushScheduled = false;
let voxelQueueScheduled = false;

const CPU = (navigator.hardwareConcurrency || 4);
const MAX_CONCURRENT_VOXELIZERS = Math.max(1, Math.min(mobileDevice() ? 2 : 4, Math.floor(CPU / 2)));
const WEBGPU_CONCURRENT_VOXELIZERS = WEBGPU_WORKER_POOL_SIZE;
const TARGET_PX_PER_VOXEL = 3;
const sourceBoundsCache = new WeakMap();
const worldVoxelSphere = new THREE.Sphere();
let voxelSettingsRevision = 0;
let packedMinecraftResources = null;
let pendingMinecraftResources = null;
const voxelLodCache = new VoxelLodCache({
  maxBytes: (mobileDevice() ? 48 : 128) * 1024 * 1024,
  maxLevelsPerTile: 3,
  onDispose: vox => dispose(vox.voxelMesh),
  onActivate: (tile, entry, previous) => {
    const mesh = entry.result.voxelMesh;
    mesh.userData.sourceTile = tile;
    mesh.matrixAutoUpdate = false;
    mesh.traverse(node => {
      node.layers.set(LAYER_VOXELS);
      if (node.isMesh && !node.userData.origMat) node.userData.origMat = node.material;
    });
    scene.add(mesh);
    tile._voxMesh = mesh;
    tile._voxelizer = entry.result;
    tile._voxQuality = 'final';
    tile._voxResolution = entry.resolution;
    tile._mcApplied = !!mesh.userData.__mcApplied;
    // Detach the old representation only after the replacement is attached.
    if (previous && previous !== entry) previous.result.voxelMesh.removeFromParent();
    delete tile._voxError;
    applyVis(tile);
  },
});
window.getVoxelLodStats = () => ({ ...voxelLodCache.stats(), sharedTextureBytes: (packedMinecraftResources?.lookup.image.data.byteLength ?? 0) + (packedMinecraftResources?.atlas.image.width ?? 0) * (packedMinecraftResources?.atlas.image.height ?? 0) * 4 });
window.getVoxelRenderStats = () => ({ ...renderer.info.render, memory: { ...renderer.info.memory }, width: renderer.domElement.width, height: renderer.domElement.height });
window.getVoxelCoverageStats = () => {
  const visible = (tiles?.group.children ?? []).filter(tile => tile.userData.rendererVisible !== false);
  const voxels = visible.filter(tile => tile._voxMesh?.visible && tile._voxMesh.children.length);
  const fallback = visible.filter(tile => tile.visible && camera.layers.isEnabled(LAYER_IMAGERY));
  return { visible: visible.length, voxels: voxels.length, fallback: fallback.length,
    uncovered: visible.filter(tile => !voxels.includes(tile) && !fallback.includes(tile)).length,
    queued: scheduledVoxelTiles.size, running: voxelizingTiles.size };
};

function voxelSignature() {
  return JSON.stringify([voxelSettingsRevision, getActiveVoxelMethod()]);
}

function sourceBoundsFor(tile) {
  let bounds = sourceBoundsCache.get(tile);
  if (!bounds) {
    tile.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(tile);
    box.applyMatrix4(new THREE.Matrix4().copy(tile.matrixWorld).invert());
    const size = box.getSize(new THREE.Vector3());
    bounds = { sphere: box.getBoundingSphere(new THREE.Sphere()), span: Math.max(size.x, size.y, size.z) };
    sourceBoundsCache.set(tile, bounds);
  }
  tile.updateWorldMatrix(true, false);
  worldVoxelSphere.copy(bounds.sphere).applyMatrix4(tile.matrixWorld);
  return { sphere: worldVoxelSphere, span: bounds.span * tile.matrixWorld.getMaxScaleOnAxis() };
}

function screenRadiusForObject(tile) {
  const { sphere } = sourceBoundsFor(tile);
  return projectedVoxelDemand(sphere.radius, camera.position.distanceTo(sphere.center),
    renderer.domElement.height, camera.fov, 1);
}

function resolutionForTile(tile) {
  const { sphere, span } = sourceBoundsFor(tile);
  const demand = projectedVoxelDemand(span, camera.position.distanceTo(sphere.center),
    renderer.domElement.height, camera.fov, TARGET_PX_PER_VOXEL);
  const current = voxelLodCache.current(tile);
  const pending = voxelLodCache.pending(tile);
  return selectVoxelLod(demand, state.resolution, pending?.resolution ?? current?.resolution);
}

function isWorthVoxelizing(tile) { return screenRadiusForObject(tile) > 2; }

function needsVoxelUpdate(tile) {
  const resolution = resolutionForTile(tile), signature = voxelSignature();
  const pending = voxelLodCache.pending(tile);
  if (pending?.resolution === resolution && pending.signature === signature) return false;
  const current = voxelLodCache.current(tile);
  return !current || current.resolution !== resolution || current.signature !== signature;
}

function cancelTileVoxelBuild(tile) {
  scheduledVoxelTiles.delete(tile);
  voxelLodCache.cancel(tile);
  pendingVoxelAttachments.delete(tile);
  voxelizingTiles.delete(tile);
  delete tile._voxBuildToken;
  delete tile._voxWorker;
}

function getActiveVoxelMethod() {
  try {
    return ui?.getVoxelizationMethod?.() ?? '2.5d-scan';
  } catch {
    return '2.5d-scan';
  }
}

function getVoxelizerBudget() {
  const method = getActiveVoxelMethod();
  const maxConcurrent = method === 'webgpu'
    ? WEBGPU_CONCURRENT_VOXELIZERS
    : MAX_CONCURRENT_VOXELIZERS;
  return Math.max(0, maxConcurrent - voxelizingTiles.size);
}

function scheduleTileVoxel(tile) {
  scheduledVoxelTiles.add(tile);
  scheduleVoxelQueue();
}

function scheduleVoxelQueue() {
  if (voxelQueueScheduled || !scheduledVoxelTiles.size) return;
  voxelQueueScheduled = true;
  requestAnimationFrame(() => {
    voxelQueueScheduled = false;
    const deadline = performance.now() + (isInteractionBusy() ? 2 : 4);
    // Fill missing coverage first, then improve existing meshes; nearer tiles win.
    const candidates = [...scheduledVoxelTiles].filter(tile => {
      if (!state.vox || tile.parent !== tiles?.group || tile.userData.rendererVisible === false || disposingTiles.has(tile)) {
        scheduledVoxelTiles.delete(tile); return false;
      }
      return true;
    }).map(tile => ({ tile, ready: !!tile._voxMesh, distance: sourceBoundsFor(tile).sphere.center.distanceToSquared(camera.position) }))
      .sort((a, b) => Number(a.ready) - Number(b.ready) || a.distance - b.distance);
    for (const { tile } of candidates) {
      const resolution = resolutionForTile(tile), signature = voxelSignature();
      const cached = voxelLodCache.tiles.get(tile)?.levels.has(JSON.stringify([signature, resolution]));
      if (!getVoxelizerBudget() && !cached) continue;
      scheduledVoxelTiles.delete(tile);
      void buildVoxelFor(tile);
      if (performance.now() >= deadline) break;
    }
    // A completed worker wakes a saturated queue; don't spin while all are busy.
    if (getVoxelizerBudget()) scheduleVoxelQueue();
  });
}

function schedulePendingVoxelFlush() {
  if (pendingVoxelFlushScheduled) return;
  pendingVoxelFlushScheduled = true;
  setTimeout(() => {
    pendingVoxelFlushScheduled = false;
    flushPendingVoxelAttachments();
  }, 0);
}

function flushPendingVoxelAttachments() {
  const deadline = performance.now() + 4;
  for (const [tile, token] of pendingVoxelAttachments) {
    pendingVoxelAttachments.delete(tile);
    // A tile can become hidden or change settings while the result waits.
    if (tile.parent !== tiles?.group || !state.vox || tile.userData.rendererVisible === false
      || voxelSignature() !== token.signature || resolutionForTile(tile) !== token.resolution) {
      if (voxelLodCache.pending(tile) === token) cancelTileVoxelBuild(tile);
      continue;
    }
    voxelLodCache.commit(token);
    if (performance.now() >= deadline) { schedulePendingVoxelFlush(); break; }
  }
}

async function buildVoxelFor(tile) {
  if (!tile || !state.vox || tile.parent !== tiles?.group || tile.userData.rendererVisible === false
    || disposingTiles.has(tile) || !isWorthVoxelizing(tile)) return;
  const resolution = resolutionForTile(tile), signature = voxelSignature();
  if (tile._voxError?.key === JSON.stringify([signature, resolution]) && performance.now() < tile._voxError.retryAt) return;
  // Superseded jobs must release their concurrency slot before a replacement starts.
  const pending = voxelLodCache.pending(tile);
  if (pending && (pending.resolution !== resolution || pending.signature !== signature)) cancelTileVoxelBuild(tile);
  voxelLodCache.setVisible(tile, true);
  const request = voxelLodCache.request(tile, resolution, signature, { allowBuild: getVoxelizerBudget() > 0 });
  if (request.status !== 'build') return;
  const token = request.token;
  tile._voxBuildToken = token;
  voxelizingTiles.add(tile);
  let vox = null;
  try {
    vox = await voxelizeModel({
      model: tile, renderer, resolution, needGrid: false,
      method: getActiveVoxelMethod(), renderMode: 'packed',
      onStart: controller => {
        voxelLodCache.setController(token, controller);
        if (voxelLodCache.isCurrent(token)) tile._voxWorker = controller;
      },
      // Packed reconstruction already yields every 4 ms. Do not stall it for an
      // entire drag: finished geometry can replace source coverage while moving.
    });
    if (vox.stats?.fallbackReason) console.warn(vox.stats.fallbackReason);
    if (!voxelLodCache.isCurrent(token) || tile.parent !== tiles?.group || signature !== voxelSignature()) {
      dispose(vox.voxelMesh); vox = null;
      voxelLodCache.fail(token);
      return;
    }
    const accepted = voxelLodCache.stage(token, vox);
    vox = null; // Cache owns the result (or has already disposed stale output).
    if (accepted) {
      pendingVoxelAttachments.set(tile, token);
      flushPendingVoxelAttachments();
      if (pendingVoxelAttachments.size) schedulePendingVoxelFlush();
    }
  } catch (error) {
    if (vox) dispose(vox.voxelMesh);
    if (voxelLodCache.isCurrent(token) && error?.message !== 'Voxelization cancelled') {
      tile._voxError = { key: token.key, retryAt: performance.now() + 5000 };
      console.warn('Voxel LOD build failed; retaining previous mesh:', error);
    }
    voxelLodCache.fail(token);
  } finally {
    if (tile._voxBuildToken === token) {
      delete tile._voxBuildToken;
      delete tile._voxWorker;
      voxelizingTiles.delete(tile);
    }
    scheduleVoxelQueue();
  }
}

// The 'scene' from the event is the THREE.Group for the tile.
function onTileLoad({ scene: tile }) {
  if (!tile || tile.parent !== tiles?.group || tile.type !== 'Group') return;
  tile.updateMatrixWorld(true);
  tile.traverse(node => node.layers.set(LAYER_IMAGERY));
  if (tile.userData.rendererVisible === undefined) tile.userData.rendererVisible = true;
  voxelLodCache.setVisible(tile, state.vox && tile.userData.rendererVisible !== false);
  applyVis(tile);
  if (state.vox) scheduleTileVoxel(tile);
}

function onTileDispose({ scene: tile }) { if (tile) cleanupTileVoxels(tile); }

function cleanupTileVoxels(tile) {
  if (!tile) return;
  disposingTiles.add(tile);
  try {
    cancelTileVoxelBuild(tile);
    voxelLodCache.remove(tile);
    dispose(tile._voxMesh);
    dispose(tile._tempContainer);
    sourceBoundsCache.delete(tile);
    invalidateSerializedModel(tile);
    for (const key of ['_voxMesh', '_voxQuality', '_voxResolution', '_voxelizer', '_tempContainer', '_voxError', '_mcApplied']) delete tile[key];
  } finally { disposingTiles.delete(tile); }
}

function applyVis(tile) {
  if (!tile || !tile.parent || tile.parent !== tiles.group || typeof tile.type !== 'string') return;

  // Source tiles provide coverage until their individual voxel mesh is ready.
  // Hiding the entire imagery layer creates holes during streaming/refinement.
  camera.layers.enable(LAYER_IMAGERY);
  if (state.vox) camera.layers.enable(LAYER_VOXELS); else camera.layers.disable(LAYER_VOXELS);
  const hasVoxels = !!tile._voxMesh?.children.length;
  tile.visible = tile.userData.rendererVisible !== false && (!state.vox || state.debugImagery || !hasVoxels);

  const visible = state.vox && tile.userData.rendererVisible !== false;
  if (tile._voxMesh) {
    tile._voxMesh.visible = visible;
    setPackedVoxelTextures(tile._voxMesh, packedMinecraftResources, state.mc);
    tile._mcApplied = !!tile._voxMesh.userData.__mcApplied;
  }
}

// Brightness replaces the shared block lookup without rebuilding voxel geometry.
async function rebakeMinecraftUVsForVisibleTiles(bias = 0) {
  setMinecraftBrightnessBias(bias);
  updateVis();
  await window.singleSceneViewer?.setMinecraftEnabled(state.mc);
}
window.MC_setBrightness = b => rebakeMinecraftUVsForVisibleTiles(b);

function preparePackedMinecraft() {
  const bias = getMinecraftBrightnessBias();
  if (packedMinecraftResources?.bias === bias) {
    // Returning to the active bias supersedes any unfinished replacement.
    pendingMinecraftResources = null;
    return;
  }
  if (pendingMinecraftResources?.bias === bias) return;
  const request = { bias };
  pendingMinecraftResources = request;
  getPackedBlockResources(bias).then(resources => {
    if (pendingMinecraftResources !== request) { resources.lookup.dispose(); return; }
    const previous = packedMinecraftResources;
    packedMinecraftResources = resources;
    pendingMinecraftResources = null;
    // Update every cached variant before disposing the previous shared lookup.
    for (const tileState of voxelLodCache.tiles.values()) {
      for (const entry of tileState.levels.values()) setPackedVoxelTextures(entry.result.voxelMesh, resources, state.mc);
    }
    previous?.lookup.dispose();
    updateVis();
  }).catch(error => {
    if (pendingMinecraftResources === request) pendingMinecraftResources = null;
    console.warn('Minecraft preview textures could not be prepared:', error);
  });
}

function updateVis() {
  if (state.mc) preparePackedMinecraft();
  if (!tiles?.group) return;
  for (const tile of tiles.group.children) {
    if (tile?.type !== 'Group') continue;
    const visible = state.vox && tile.userData.rendererVisible !== false;
    voxelLodCache.setVisible(tile, visible);
    if (!visible) cancelTileVoxelBuild(tile);
    applyVis(tile);
    if (visible) scheduleTileVoxel(tile);
  }
}

function rebuildAll() {
  if (!tiles?.group) return;
  voxelSettingsRevision++;
  for (const tile of tiles.group.children) {
    cancelTileVoxelBuild(tile);
    voxelLodCache.invalidate(tile);
    delete tile._voxError;
  }
  updateVis();
}

/* ───────────────────────── render loop ───────────────────────────── */
const VOXEL_UPDATE_INTERVAL = 300;

function loop() {
  requestAnimationFrame(loop);

  // Update freecam if enabled
  if (window.freecamUpdateFn) {
    window.freecamUpdateFn();
  }

  controls.update();

  if (tiles) {
    camera.updateMatrixWorld();
    tiles.update();
    flushPendingVoxelAttachments();

    // This periodic check is a good fallback to catch any visible tiles
    // that slipped through the event-based voxelization.
    const now = performance.now();
    if (state.vox && !isInteractionBusy() && now - lastVoxelUpdateTime > VOXEL_UPDATE_INTERVAL) {
      lastVoxelUpdateTime = now;

      if (tiles.group && tiles.group.children) {
        const tilesToVoxelize = [];
        tiles.group.children.forEach(tile => {
          const rendererVisible = tile?.userData?.rendererVisible;
          const needsVoxel = tile?.type === 'Group' && needsVoxelUpdate(tile);
          if (tile && tile.type === 'Group'
            && rendererVisible !== false
            && isWorthVoxelizing(tile)
            && needsVoxel && !disposingTiles.has(tile)) {
            tilesToVoxelize.push({ tile, distance: sourceBoundsFor(tile).sphere.center.distanceToSquared(camera.position) });
          }
        });

        if (tilesToVoxelize.length > 0) {
          tilesToVoxelize.sort((a, b) => a.distance - b.distance);
          tilesToVoxelize.forEach(({ tile }) => scheduleTileVoxel(tile));
        }
      }
    }
  }

  if (!window.singleSceneViewer && !document.hidden) renderer.render(scene, camera);
}

// Rebase a voxelGrid's bbox+unit by a 4x4 transform M (the SAME matrices applied to the voxel geometry).
function rebaseVoxelGrid(voxelGrid, M) {
  if (!voxelGrid || !voxelGrid.bbox || !voxelGrid.unit) return voxelGrid;

  const from = voxelGrid.bbox;
  const corners = [
    new THREE.Vector3(from.min.x, from.min.y, from.min.z),
    new THREE.Vector3(from.max.x, from.min.y, from.min.z),
    new THREE.Vector3(from.min.x, from.max.y, from.min.z),
    new THREE.Vector3(from.min.x, from.min.y, from.max.z),
    new THREE.Vector3(from.max.x, from.max.y, from.min.z),
    new THREE.Vector3(from.max.x, from.min.y, from.max.z),
    new THREE.Vector3(from.min.x, from.max.y, from.max.z),
    new THREE.Vector3(from.max.x, from.max.y, from.max.z),
  ];
  const outBox = new THREE.Box3();
  for (const c of corners) outBox.expandByPoint(c.clone().applyMatrix4(M));

  // derive per-axis scale from M (assume mostly orthonormal after our counter-rotation)
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(M);
  const ex = new THREE.Vector3(1, 0, 0).applyMatrix4(M).sub(origin).length();
  const ey = new THREE.Vector3(0, 1, 0).applyMatrix4(M).sub(origin).length();
  const ez = new THREE.Vector3(0, 0, 1).applyMatrix4(M).sub(origin).length();

  // shallow clone (keep big arrays by reference)
  return {
    ...voxelGrid,
    bbox: outBox,
    unit: { x: voxelGrid.unit.x * ex, y: voxelGrid.unit.y * ey, z: voxelGrid.unit.z * ez }
  };
}



