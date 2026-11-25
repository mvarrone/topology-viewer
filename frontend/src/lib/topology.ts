import type { Topology, TopologyDiff } from "../types";

/** Apply a run diff to a topology and return the new topology. */
export function applyDiff(topology: Topology, diff: TopologyDiff, collectedAt: string | null): Topology {
  const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
  const links = new Map(topology.links.map((l) => [l.id, l]));
  diff.nodes_removed.forEach((n) => nodes.delete(n.id));
  diff.links_removed.forEach((l) => links.delete(l.id));
  [...diff.nodes_added, ...diff.nodes_updated].forEach((n) => nodes.set(n.id, n));
  [...diff.links_added, ...diff.links_updated].forEach((l) => links.set(l.id, l));
  return {
    collected_at: collectedAt ?? topology.collected_at,
    nodes: [...nodes.values()],
    links: [...links.values()],
  };
}
