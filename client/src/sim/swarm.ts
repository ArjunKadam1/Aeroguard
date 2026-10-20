// Scenario-declared swarms: a group of separately scored contacts that fly
// together. Membership arrives in the public scenario (swarm_id/swarm_index),
// so the client never invents grouping -- the backend decides, and the same
// seed reconstructs it for the debrief.
//
// This module is composition only. Every member keeps its own id, track,
// classification, response, and score; only the flown geometry is shared, and
// `sim/threats.ts` derives wing positions from the lead's plan. That keeps the
// whole group a pure function of the public scenario (replay-safe).

import type { PublicThreat } from "../api/types";

export interface SwarmContext {
  /** The group's lead profile (swarm_index 0). */
  lead: PublicThreat;
  /** This contact's position in the formation; 0 is the lead. */
  index: number;
  /** Number of members in the group. */
  count: number;
}

export type SwarmIndex = ReadonlyMap<string, SwarmContext>;

/**
 * Deterministic membership index from the public scenario.
 *
 * Members are ordered by swarm_index (never by array order), so the formation
 * geometry is stable even if a scenario serializes threats out of order. A
 * malformed one-member group is ignored here; the backend validator rejects it
 * before release.
 */
export function buildSwarmIndex(threats: readonly PublicThreat[]): SwarmIndex {
  const groups = new Map<string, PublicThreat[]>();
  for (const threat of threats) {
    const swarmId = threat.swarm_id;
    if (!swarmId) continue;
    const members = groups.get(swarmId);
    if (members) members.push(threat);
    else groups.set(swarmId, [threat]);
  }

  const index = new Map<string, SwarmContext>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort(
      (a, b) => (a.swarm_index ?? 0) - (b.swarm_index ?? 0),
    );
    const lead = ordered[0];
    for (const member of ordered) {
      index.set(member.id, {
        lead,
        index: member.swarm_index ?? 0,
        count: ordered.length,
      });
    }
  }
  return index;
}
