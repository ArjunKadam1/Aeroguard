import { describe, expect, it } from "vitest";
import * as THREE from "three";

// Rooftop plant used to re-roll its own positions, which scattered units at
// unrelated points in mid-air. This guards the invariant that every rooftop
// instance sits on top of a building it was derived from.
interface PlacedBuilding {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  rot: number;
}

function roofUnitFor(b: PlacedBuilding, unitH: number, ox: number, oz: number) {
  const rs = new THREE.Vector3(b.w * 0.3, unitH, b.d * 0.3);
  const cos = Math.cos(b.rot);
  const sin = Math.sin(b.rot);
  const rp = new THREE.Vector3(
    b.x + ox * cos - oz * sin,
    b.y + b.h / 2 + unitH / 2,
    b.z + ox * sin + oz * cos,
  );
  return { position: rp, scale: rs, rot: b.rot };
}

describe("rooftop units sit on their building", () => {
  const building: PlacedBuilding = {
    x: 180, y: 20, z: -90, w: 24, h: 40, d: 30, rot: 0.7,
  };

  it("bases the unit exactly on the roof plate", () => {
    const unitH = 4;
    const unit = roofUnitFor(building, unitH, 0, 0);
    // Bottom of the unit == top of the building.
    expect(unit.position.y - unit.scale.y / 2).toBeCloseTo(building.y + building.h / 2, 6);
  });

  it("never sinks into or floats above the roof", () => {
    for (const unitH of [2, 4, 7]) {
      const unit = roofUnitFor(building, unitH, 3, -2);
      expect(unit.position.y - unit.scale.y / 2).toBeGreaterThanOrEqual(building.y + building.h / 2 - 1e-6);
      expect(unit.position.y - unit.scale.y / 2).toBeLessThan(building.y + building.h / 2 + 1e-6);
    }
  });

  it("keeps the offset inside the roof footprint at any rotation", () => {
    // Offsets are applied in the building's rotated frame, so the unit must
    // stay within the plate regardless of heading.
    for (let rot = 0; rot < Math.PI * 2; rot += 0.3) {
      const b = { ...building, rot };
      const ox = b.w * 0.4;
      const oz = b.d * 0.4;
      const unit = roofUnitFor(b, 3, ox, oz);
      const dx = unit.position.x - b.x;
      const dz = unit.position.z - b.z;
      const radius = Math.sqrt(dx * dx + dz * dz);
      const halfDiagonal = Math.sqrt((b.w / 2) ** 2 + (b.d / 2) ** 2);
      expect(radius).toBeLessThanOrEqual(halfDiagonal + 1e-6);
    }
  });

  it("matches the building rotation so units read as aligned", () => {
    expect(roofUnitFor(building, 3, 0, 0).rot).toBe(building.rot);
  });
});

describe("collapsed instances", () => {
  it("zero scale hides an instance without changing the count", () => {
    const hidden = new THREE.Vector3(0, 0, 0);
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial(),
      3,
    );
    mesh.setMatrixAt(1, new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion(), hidden));
    expect(mesh.count).toBe(3);
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(1, m);
    expect(m.determinant()).toBe(0);
  });
});