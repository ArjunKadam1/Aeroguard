export class Spawner {
  private readonly pending: { id: string; spawn_time: number }[];
  private readonly onSpawn: (id: string) => void;

  constructor(
    scenario: { threats: Array<{ id: string; spawn_time: number }> },
    onSpawn: (id: string) => void,
  ) {
    this.onSpawn = onSpawn;
    this.pending = scenario.threats.map((t) => ({ id: t.id, spawn_time: t.spawn_time }));
  }

  update(elapsedSec: number): void {
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (elapsedSec >= this.pending[i].spawn_time) {
        const [ready] = this.pending.splice(i, 1);
        this.onSpawn(ready.id);
      }
    }
  }
}
