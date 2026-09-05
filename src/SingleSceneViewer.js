import * as THREE from 'three';
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader }   from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader }  from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader }   from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { loadGltfBatch } from './loadGltfBatch.js';
import { VoxelExportSession, makeExportGroup, downloadExport } from './voxel-export.js';
import { getPackedBlockResources, getMinecraftBrightnessBias } from './assignToBlocksForGLB.js';
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
		// Enable three.js in-memory cache to short-circuit duplicate GLB / texture fetches this session
		THREE.Cache.enabled = true;
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
		const { gltfs: gltfArray, stats } = await loadGltfBatch({
			urls: urlArray,
			concurrency: matchMedia('(pointer: coarse)').matches ? 3 : 8,
			loadOne: (url) => new Promise((res, rej) => this.gltfLoader.load(url, res, undefined, rej)),
			onProgress: ({ index, total, loaded, ok, error }) => {
				if (ok) logFn?.(`Fetched glTF ${loaded}/${total} (parallel x${Math.min(8, total)})`);
				else logFn?.(`Skipped glTF ${index + 1}/${total} (${error?.message ?? 'load error'})`);
			},
		});
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
			tilesContainer.add(gltf.scene);
		}
		if (!gltfArray.length) {
			logFn?.('No glTF tiles loaded successfully.');
			this.tilesContainer = null;
			this.gltfArray = [];
			return;
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
		const ecefUp = center.clone().normalize(); // keep before moving
		// move each child by -center (do NOT move the container) so transform order matches the main viewer
		tilesContainer.children.forEach(child => {
			if (child.position) child.position.sub(center);
		});
		scene.add(tilesContainer);

		// Rotate ECEF up → +Y
		const upVector = ecefUp;
		const targetNorthVector = new THREE.Vector3(0, 1, 0);
		const rotationAxis = new THREE.Vector3().crossVectors(upVector, targetNorthVector).normalize();
		const rotationAngle = Math.acos(THREE.MathUtils.clamp(upVector.dot(targetNorthVector), -1, 1));
		const quaternion = new THREE.Quaternion().setFromAxisAngle(rotationAxis, rotationAngle);
		tilesContainer.quaternion.multiply(quaternion);

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

	_frame(object3D) {
		const { camera, controls } = this;
		const box = new THREE.Box3().setFromObject(object3D);
		if (box.isEmpty()) return;
		const center = box.getCenter(new THREE.Vector3());
		const size   = box.getSize(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.y, size.z);
		const fov    = THREE.MathUtils.degToRad(camera.fov);
		const dist   = Math.max(0.6, (maxDim * 0.5) / Math.tan(fov * 0.5));
		camera.position.copy(center).add(new THREE.Vector3(dist, dist * 0.4, dist));
		controls.target.copy(center);
		controls.update();
	}

	async generateCombineGltf() {
		const bytes = await this.exportGlb();
		downloadExport(bytes, 'combined_3d_tiles.glb');
	}

	async exportGlb() {
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
		if (enabled && this._blockResources?.bias !== bias) {
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
