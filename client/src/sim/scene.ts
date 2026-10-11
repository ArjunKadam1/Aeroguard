import * as THREE from "three";
import type { Scenario } from "../api/types";
import { buildWorld, type World } from "./world";

export interface SimScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  world: World;
  render(): void;
  dispose(): void;
}

export function createSimScene(container: HTMLElement, scenario: Scenario): SimScene {
  const scene = new THREE.Scene();

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // Cap the device pixel ratio: a fullscreen canvas at DPR 2 with MSAA is the
  // fill-rate ceiling, far more than this scene's triangle count.
  const pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  renderer.setPixelRatio(pixelRatio);
  // Without tone mapping, a 2.6-intensity sun clips daylight to flat white.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // buildWorld needs the renderer to bake the sky into an environment map.
  const world = buildWorld(scene, scenario, renderer);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 20000);
  camera.position.set(0, 40, 120);
  camera.lookAt(0, 0, 0);

  function resize(): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height);
    if (height > 0) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }
  resize();
  window.addEventListener("resize", resize);

  return {
    scene,
    camera,
    renderer,
    world,
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      window.removeEventListener("resize", resize);
      world.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else if (material) material.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}