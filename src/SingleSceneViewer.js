import * as THREE from 'three';
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader }   from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }  from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader }   from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { loadGltfBatch } from './loadGltfBatch.js';
import { CaptureProgress } from './capture-progress.js';
import { limitSourceTextures, clampSourceAtlasEdges } from './source-textures.js';
import { resolveCaptureFrame } from './geographic-markers.js';
import { VoxelExportSession, makeExportGroup, downloadExport } from './voxel-export.js';
import { getPackedBlockResources, getMinecraftBrightnessBias, getBlockPaletteKey } from './assignToBlocksForGLB.js';
import { setPackedVoxelTextures } from './packed-voxel-renderer.js';
import { renderPixelRatio } from './mobile-ui.js';

const LEGACY_SRGB_ENCODING = 3001;

export class SingleSceneViewer {
	constructor() {
		this.exportSession = new VoxelExportSession();
		this.destroyed = false;
		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 100);
		camera.position.z = -0.25; 
		camera.position.y = 0.2;

		// Enable voxel layer (1) so voxel meshes assigned to that layer render in this viewer
		try {
			camera.layers.enable(1);
		} catch (e) { /* ignore if layers unsupported */ }

		const renderer = new THREE.WebGLRenderer({ antialias: true });
				renderer.setSize(window.innerWidth, window.innerHeight);
				// Use sRGB color space so GLTF colors match expected appearance
				if (THREE.SRGBColorSpace !== undefined) {
					renderer.outputColorSpace = THREE.SRGBColorSpace;
				} else if ('outputEncoding' in renderer) {
					renderer.outputEncoding = LEGACY_SRGB_ENCODING;
				}
		document.body.appendChild(renderer.domElement);
		
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.update();
		this.controls = controls;
		controls.minDistance = 0.1;
		controls.maxDistance = 5;

		const directionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
		scene.add(directionalLight);
		const light = new THREE.AmbientLight(0x404040); 
		scene.add(light);
		// Ensure lights illuminate voxel layer as well
		try { directionalLight.layers.enable(1); } catch(e) {}
		try { light.layers.enable(1); } catch(e) {}

		this._resize = this.resizeCanvas.bind(this);
		window.addEventListener('resize', this._resize);
		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
	this.tilesContainer = null;
	this.gltfArray = [];
	this.voxelMeshes = []; // Initialize voxel meshes array
	this._debugTilesOn = false;
	this._debugHelpers = [];
	this.gltfLoader = this._makeGLTFLoader(renderer);

		this.render();
		this.resizeCanvas();
	}

	_makeGLTFLoader(renderer) {
		const THREE_PATH = `https://unpkg.com/three@0.160`;
		const draco = new DRACOLoader().setDecoderPath(`${THREE_PATH}/examples/jsm/libs/draco/gltf/`);
		const ktx2  = new KTX2Loader().setTranscoderPath(`${THREE_PATH}/examples/jsm/libs/basis/`);
		ktx2.detectSupport(renderer);
		const loader = new GLTFLoader();
		loader.setDRACOLoader(draco);
		loader.setKTX2Loader(ktx2);
		loader.setMeshoptDecoder(MeshoptDecoder);
		// HTTP caching remains available. Avoid a second unbounded JS cache of
		// every compressed GLB and decoded ImageBitmap in a large capture.
		THREE.Cache.enabled = false;
		THREE.Cache.clear();
		return loader;
	}

	render() {
		if (this.destroyed) return;
		const { renderer, camera, scene } = this;
		this._animationFrame = requestAnimationFrame(() => this.render());
		if (!document.hidden) renderer.render(scene, camera);
	}

	resizeCanvas() {
		const { camera, renderer } = this;
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize(window.innerWidth, window.innerHeight);
		renderer.setPixelRatio(renderPixelRatio());
	}

	async loadGLTFTiles(urlArray, logFn) {
		const requestedSize = Number(document.querySelector('#single-scene-texture-limit')?.value ?? 128);
		const textureLimit = [0,128,256,512].includes(requestedSize) ? requestedSize : 128;
		const reducedImages = new WeakMap();
		logFn?.(`Source textures: ${textureLimit ? `${textureLimit}px maximum edge (memory saver; reduces texture detail)` : 'original resolution (high memory use)'}. Geometry and voxel spacing unchanged.`);
		const version = this._loadVersion = (this._loadVersion ?? 0) + 1;
		this._voxelController?.terminate();
		this.exportSession.dispose();
		// Resizing/recentering code inspired by by gltf-viewer
		// https://github.com/donmccurdy/three-gltf-viewer/blob/de78a07180e4141b0b87a0ff4572bc4f7aafec56/src/viewer.js#L246
		const { scene, controls, camera } = this;
		// Remove any previous 3D Tiles we were rendering
		if (this.tilesContainer) {
			this.clearContent();
			this.tilesContainer = null;
		}
		const tilesContainer = new THREE.Object3D();
		// Fetch individual glTFs with bounded parallelism instead of serial network waits
		let latest = { loaded: 0, failed: 0 }, lastLog = 0;
		const started = performance.now();
		const progress = new CaptureProgress(started);
		const reportLoad = () => {
			if (this.destroyed || this._loadVersion !== version) return;
			lastLog = performance.now();
			const finished = latest.loaded + latest.failed;
			const eta = progress.estimate(finished, urlArray.length - finished, lastLog);
			logFn?.(`Downloading/decoding models: ${finished}/${urlArray.length} finished, ${latest.failed} failed; ${eta.rate.toFixed(1)} models/s; download/decode ETA ${eta.text}; ${((lastLog - started) / 1000).toFixed(1)}s elapsed`);
		};
		reportLoad();
		const heartbeat = setInterval(reportLoad, 2000);
		let batch;
		try { batch = await loadGltfBatch({
			urls: urlArray,
			concurrency: matchMedia('(pointer: coarse)').matches ? 3 : textureLimit ? 16 : 8,
			loadOne: async (url) => {
				const gltf = await new Promise((res, rej) => this.gltfLoader.load(url, res, undefined, rej));
				clampSourceAtlasEdges(gltf.scene);
				await limitSourceTextures(gltf.scene, textureLimit, reducedImages);
				// The parser retains GLB buffers and intermediate decode caches after
				// loading. Only keep the finished scene/metadata in the capture.
				const { parser, ...loaded } = gltf;
				return loaded;
			},
			onProgress: ({ index, total, loaded, failed, ok, error }) => {
				latest = { loaded, failed };
				if (!ok && failed <= 5) logFn?.(`Skipped glTF ${index + 1}/${total} (${error?.message ?? 'load error'})`);
				if (loaded + failed === total || performance.now() - lastLog >= 750) reportLoad();
			},
		}); } finally { clearInterval(heartbeat); }
		const { gltfs: gltfArray, stats } = batch;
		if (this.destroyed || this._loadVersion !== version) {
			for (const gltf of gltfArray) gltf.scene.traverse(node => {
				node.geometry?.dispose();
				for (const material of [node.material].flat()) if (material) {
					for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
					material.dispose();
				}
			});
			return;
		}
		for (const gltf of gltfArray) {
			// No transient upload of the entire photorealistic scene before the
			// voxel toggle gets a chance to hide it. Source view enables layer 0.
			gltf.scene.visible = false;
			tilesContainer.add(gltf.scene);
		}
		if (!gltfArray.length) {
			this.tilesContainer = null;
			this.gltfArray = [];
			throw new Error(`No tiles could be loaded (${stats.failed} failed). Please try again.`);
		}

		if (logFn) {
			logFn(
				`Normalizing & stitching together ${gltfArray.length} glTFs `
				+ `(${stats.durationMs.toFixed(1)} ms load, ${stats.failed} failed)`
			);
		}


		// Re-center & normalize the *whole* container
		const box = new THREE.Box3().setFromObject(tilesContainer);
		const sizeVec = box.getSize(new THREE.Vector3());
		const diag = sizeVec.length() || 1;
		const center = box.getCenter(new THREE.Vector3());
		this.rawSourceCenter=center.toArray();
		const ecefUp = center.clone().normalize(); // keep before moving
		this.metersPerViewerUnit = diag;
		// move each child by -center (do NOT move the container) so transform order matches the main viewer
		tilesContainer.children.forEach(child => {
			if (child.position) child.position.sub(center);
		});
		scene.add(tilesContainer);

		// Rotate ECEF up → +Y
		// Local east/up/south frame: Minecraft +X east, +Y up, -Z north.
		const east = new THREE.Vector3(-center.y, center.x, 0);
		if (east.lengthSq() < 1e-12) east.set(0, 1, 0);
		east.normalize();
		const north = new THREE.Vector3().crossVectors(ecefUp, east).normalize();
		const frame = new THREE.Matrix4().set(
			east.x, east.y, east.z, 0,
			ecefUp.x, ecefUp.y, ecefUp.z, 0,
			-north.x, -north.y, -north.z, 0,
			0, 0, 0, 1);
		this.ecefCenter = center.toArray();
		this.ecefFrame = frame.toArray();
		tilesContainer.quaternion.setFromRotationMatrix(frame);

		// Normalize scale ~[0,1]
		const newScale = 1 / diag;
		tilesContainer.scale.setScalar(newScale);

		// make sure children have the final matrixWorld after rotation+scale
		tilesContainer.updateMatrixWorld(true);
		
		controls.update();
				// Save the tiles we added to remove them next time we add new tiles
				this.tilesContainer = tilesContainer;
				this.gltfArray = gltfArray;

				// Refresh debug helpers according to current toggle
				if (this._debugTilesOn) this._ensureDebugHelpers();
				else                    this._clearDebugHelpers();

				// Frame the camera on the stitched model so it’s visible immediately
				this._frame(tilesContainer);
	}

	alignGeographicFrame(log) {
		const {latitude,longitude,radiusMeters}=this.captureMetadata??{};
		if(!this.rawSourceCenter||!Number.isFinite(latitude)||!Number.isFinite(longitude))return false;
		const resolved=resolveCaptureFrame(this.rawSourceCenter,latitude,longitude,radiusMeters);
		if(!resolved)return false;
		this.ecefCenter=resolved.center.toArray();this.ecefFrame=resolved.frame.toArray();
		this.tilesContainer.quaternion.setFromRotationMatrix(resolved.sourceToView);
		this.tilesContainer.updateMatrixWorld(true);
		log?.(`Geographic frame: ${resolved.name}; loaded centre ${Math.round(resolved.distance)} m from requested lat/lon.`);
		return true;
	}

	_frame(object3D) {
		const { camera, controls } = this;
		const box = new THREE.Box3().setFromObject(object3D);
		if (box.isEmpty()) return;
		const center = box.getCenter(new THREE.Vector3());
		const size   = box.getSize(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.y, size.z);
		const fov    = THREE.MathUtils.degToRad(camera.fov);
		const dist   = Math.max(0.6, (maxDim * 0.5) / Math.tan(fov * 0.5));
		camera.far = Math.max(100,dist*5+box.getSize(new THREE.Vector3()).length());
		camera.updateProjectionMatrix();
		controls.maxDistance = Math.max(5,dist*4);
		camera.position.copy(center).add(new THREE.Vector3(dist, dist * 0.4, dist));
		controls.target.copy(center);
		controls.update();
	}

	toggleMarkerView() {
		const {camera,controls}=this;
		if(this._markerView) {
			const saved=this._markerView;this._markerView=null;
			camera.position.copy(saved.position);controls.target.copy(saved.target);
			camera.near=saved.near;camera.far=saved.far;
			controls.minDistance=saved.minDistance;controls.maxDistance=saved.maxDistance;
			camera.updateProjectionMatrix();controls.update();
			return false;
		}
		const grid=this.voxelizer?._voxelGrid;
		if(!grid?.editorMarkers?.length)return false;
		const vector=value=>Array.isArray(value)||ArrayBuffer.isView(value)?new THREE.Vector3().fromArray(value):new THREE.Vector3(value.x,value.y,value.z);
		// Grid bounds are already in the rendered worker coordinate frame. Avoid
		// deriving them from instanced children under inverse container transforms.
		const box=new THREE.Box3(vector(grid.bbox.min),vector(grid.bbox.max));
		const center=box.getCenter(new THREE.Vector3()),radius=box.getSize(new THREE.Vector3()).length()/2;
		if(![...center.toArray(),radius].every(Number.isFinite)||radius<=0)return false;
		this._markerView={position:camera.position.clone(),target:controls.target.clone(),near:camera.near,far:camera.far,
			minDistance:controls.minDistance,maxDistance:controls.maxDistance};
		const vertical=THREE.MathUtils.degToRad(camera.fov)/2;
		const horizontal=Math.atan(Math.tan(vertical)*camera.aspect);
		const distance=radius/Math.sin(Math.min(vertical,horizontal))*1.15;
		camera.position.copy(center).addScaledVector(new THREE.Vector3(1,.8,1).normalize(),distance);
		controls.target.copy(center);
		camera.near=Math.max(1e-6,radius/10000);camera.far=Math.max(100,distance+radius*4);
		controls.minDistance=Math.min(.1,radius/100);controls.maxDistance=Math.max(5,distance*4);
		camera.updateProjectionMatrix();controls.update();
		return true;
	}

	async generateCombineGltf() {
		const bytes = await this.exportGlb();
		downloadExport(bytes, 'combined_3d_tiles.glb');
	}

	async exportGlb() {
		if (this.voxelSettingsCurrent === false) throw new Error('Wait for the current scale and rotation preview to finish before exporting.');
		const mesh = this.voxelMeshes?.[0];
		let input = this.tilesContainer, temporary;
		try {
			if (mesh?.visible && this.voxelizer?._voxelGrid) {
				const surface = await this.exportSession.run(this.voxelizer._voxelGrid,
					mesh.userData.__mcApplied ? 'surface-blocks' : 'surface-color');
				temporary = await makeExportGroup(surface);
				mesh.updateWorldMatrix(true, false);
				temporary.applyMatrix4(mesh.matrixWorld);
				input = temporary;
			}
			if (!input) throw new Error('No scene to export');
			return await new GLTFExporter().parseAsync(input, { binary: true, onlyVisible: true, maxTextureSize: 4096 });
		} finally { temporary?.userData.disposeExport?.(); }
	}

	async setMinecraftEnabled(enabled) {
		const bias = getMinecraftBrightnessBias();
		this._mcEnabled = enabled;
		if (enabled && (this._blockResources?.bias !== bias || this._blockResources?.paletteKey !== getBlockPaletteKey())) {
			const request = this._blockRequest = {};
			const resources = await getPackedBlockResources(bias);
			if (this.destroyed || this._blockRequest !== request) { resources.lookup.dispose(); return; }
			const previous = this._blockResources;
			this._blockResources = resources;
			for (const mesh of this.voxelMeshes) setPackedVoxelTextures(mesh, resources, this._mcEnabled);
			previous?.lookup.dispose();
		}
		for (const mesh of this.voxelMeshes) setPackedVoxelTextures(mesh, this._blockResources, this._mcEnabled);
	}

	clearContent() {
		this._markerView=null;
		const materials = new Set(), textures = new Set();
		this.tilesContainer?.traverse(node => {
			node.geometry?.dispose();
			for (const material of [node.material].flat()) if (material) materials.add(material);
		});
		for (const material of materials) {
			for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
			material.dispose();
		}
		for (const texture of textures) texture.dispose();
		this.tilesContainer?.removeFromParent(); this.tilesContainer = null;
		this.voxelMeshes = []; this.voxelizer = null; this.gltfArray = [];
	}

	destroy() {
		this.destroyed = true;
		cancelAnimationFrame(this._animationFrame);
		window.removeEventListener('resize', this._resize);
		this.controls.dispose(); this._voxelController?.terminate();
		this.exportSession.dispose(); this._clearDebugHelpers();
		this.clearContent(); this._blockResources?.lookup.dispose();
		this.gltfLoader.dracoLoader?.dispose(); this.gltfLoader.ktx2Loader?.dispose();
		if (this.renderer.domElement.parentNode) {
			this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
		}
		this.renderer.dispose();
	}

	// ───────────────────── Debug Tiles helpers ─────────────────────
	setDebugTiles(on) {
		this._debugTilesOn = !!on;
		if (this._debugTilesOn) this._ensureDebugHelpers();
		else                    this._clearDebugHelpers();
	}

	_ensureDebugHelpers() {
		if (!this.tilesContainer) return;
		this._clearDebugHelpers();
		const addHelperFor = (obj) => {
			const box = new THREE.Box3().setFromObject(obj);
			if (box.isEmpty()) return;
			const helper = new THREE.Box3Helper(box, 0xffff00);
			try { helper.layers.enable(1); } catch(e) {}
			this.scene.add(helper);
			this._debugHelpers.push(helper);
		};
		for (const child of this.tilesContainer.children) addHelperFor(child);
	}

	_clearDebugHelpers() {
		if (!this._debugHelpers?.length) return;
		for (const h of this._debugHelpers) {
			this.scene.remove(h);
			try { h.geometry?.dispose?.(); } catch {}
			try { h.material?.dispose?.(); } catch {}
		}
		this._debugHelpers.length = 0;
	}
}
