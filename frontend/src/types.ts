// Mirrors backend/app/models.py. Keep both in sync.

export type Role = "router" | "switch" | "unknown";
export type LinkStatus = "up" | "down";
export type Trigger = "scheduled" | "manual";
export type RunStatus = "running" | "completed" | "failed" | "skipped";
export type ChangeKind =
  | "device_added"
  | "device_removed"
  | "device_updated"
  | "device_renamed"
  | "device_unreachable"
  | "device_reachable"
  | "interface_down"
  | "interface_up"
  | "interface_updated"
  | "link_added"
  | "link_removed"
  | "link_up"
  | "link_down"
  | "link_updated";

export interface Device {
  id: string;
  hostname: string;
  role: Role;
  layer: string | null;
  platform: string | null;
  os: string | null;
  serial: string | null;
  mgmt_ip: string | null;
  registered: boolean;
  reachable: boolean | null;
  role_source: "lldp" | "platform" | null; // where the role came from
  polled_via: string | null; // protocol that answered on the last successful poll
  unreachable_since?: string | null;
  interfaces?: InterfaceState[]; // registered devices only
}

export interface InterfaceState {
  name: string;
  admin: "up" | "down" | null;
  oper: "up" | "down" | null;
  speed_mbps: number | null;
  description: string | null;
}

export interface Link {
  id: string;
  source: string;
  source_if: string;
  target: string;
  target_if: string;
  status: LinkStatus;
  confirmed: boolean;
  /** Devices that reported the link over LLDP in the last run. */
  seen_by?: string[];
  first_seen: string;
  last_seen: string;
  missed_runs: number;
}

export interface Topology {
  collected_at: string | null;
  nodes: Device[];
  links: Link[];
}

export interface Change {
  kind: ChangeKind;
  summary: string;
  target: string | null;
  manual: boolean; // caused by the user in the inventory
}

export interface TopologyDiff {
  summary: string;
  changes: Change[];
  nodes_added: Device[];
  nodes_removed: Device[];
  nodes_updated: Device[];
  links_added: Link[];
  links_removed: Link[];
  links_updated: Link[];
}

export interface DiscoveryRun {
  id: number;
  trigger: Trigger;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  devices: number | null;
  links: number | null;
  errors: Record<string, string>;
  diff: TopologyDiff | null;
}

export interface DiscoveryStatus {
  running: DiscoveryRun | null;
  last_run: DiscoveryRun | null;
  next_scheduled_at: string | null;
  interval_seconds: number;
  source: string;
}

export type WsMessage =
  | { type: "snapshot"; topology: Topology; status: DiscoveryStatus }
  | { type: "run_started"; run: DiscoveryRun }
  | { type: "run_finished"; run: DiscoveryRun }
  | { type: "run_skipped"; run: DiscoveryRun };

export type ConnectionState = "connecting" | "open" | "closed";

// Inventory administration (backend/app/store.py). Passwords are never returned.

export type Protocol = "restconf" | "ssh";

export interface MethodInput {
  id?: number; // set when editing an existing method
  protocol: Protocol;
  username: string;
  password: string | null; // required for a new method; empty keeps the stored one
  port: number | null;
  platform: string | null;
  verify_tls: boolean;
  timeout: number;
}

export interface Method {
  id: number;
  protocol: Protocol;
  username: string;
  port: number | null;
  platform: string | null;
  verify_tls: boolean;
  timeout: number;
}

export interface InventoryDeviceInput {
  host: string;
  enabled: boolean;
  methods: MethodInput[];
}

export interface InventoryDevice {
  id: number;
  host: string;
  enabled: boolean;
  methods: Method[];
  last_method_id: number | null;
  last_polled_at: string | null;
  last_seen_at: string | null;
  last_hostname: string | null;
  last_error: string | null;
}

export interface ConnectionTest {
  method_id: number | null;
  protocol: Protocol;
  port: number;
  ok: boolean;
  hostname: string | null;
  neighbors: number;
  error: string | null;
  duration_ms: number;
}
