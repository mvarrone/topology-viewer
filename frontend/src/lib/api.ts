import type {
  ConnectionState,
  ConnectionTest,
  DiscoveryRun,
  DiscoveryStatus,
  InventoryDevice,
  InventoryDeviceInput,
  WsMessage,
} from "../types";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} on ${url}`);
  return (await response.json()) as T;
}

export const getRuns = (limit = 50) =>
  getJson<DiscoveryRun[]>(`/api/discovery/runs?limit=${limit}&include_diff=true`);

export const getStatus = () => getJson<DiscoveryStatus>("/api/discovery/status");

export type Positions = Record<string, { x: number; y: number }>;

export const getPositions = () => getJson<Positions>("/api/positions");

export async function savePositions(positions: Positions): Promise<void> {
  await fetch("/api/positions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(positions),
  });
}

export type ManualRunResult = { ok: true; run: DiscoveryRun } | { ok: false; message: string };

export async function startManualRun(): Promise<ManualRunResult> {
  try {
    const response = await fetch("/api/discovery/run", { method: "POST" });
    if (response.status === 202) return { ok: true, run: (await response.json()) as DiscoveryRun };
    const body = await response.json().catch(() => ({}));
    return { ok: false, message: body?.detail?.message ?? `Request failed (${response.status})` };
  } catch {
    return { ok: false, message: "Backend not reachable" };
  }
}

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

/** Live updates with automatic reconnect. Returns a function that closes the connection. */
export function connectUpdates(
  onMessage: (msg: WsMessage) => void,
  onState: (state: ConnectionState) => void,
): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let timer: number | undefined;

  const open = () => {
    onState("connecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${scheme}://${location.host}/ws/topology`);
    socket.onopen = () => {
      attempt = 0;
      onState("open");
    };
    socket.onmessage = (event) => onMessage(JSON.parse(event.data) as WsMessage);
    socket.onclose = () => {
      onState("closed");
      if (stopped) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      timer = window.setTimeout(open, delay);
    };
  };

  open();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    socket?.close();
  };
}

// Inventory administration

/** FastAPI errors: a string, or a list of validation errors. */
function errorMessage(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown })?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: (string | number)[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".")}: ${d.msg}`)
      .join("; ");
  }
  return fallback;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(errorMessage(data, `${response.status} ${response.statusText}`));
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export const inventoryApi = {
  devices: () => request<InventoryDevice[]>("GET", "/api/inventory"),
  createDevice: (data: InventoryDeviceInput) => request<InventoryDevice>("POST", "/api/inventory", data),
  updateDevice: (id: number, data: InventoryDeviceInput) => request<InventoryDevice>("PUT", `/api/inventory/${id}`, data),
  deleteDevice: (id: number) => request<void>("DELETE", `/api/inventory/${id}`),
  testDevice: (id: number) => request<ConnectionTest[]>("POST", `/api/inventory/${id}/test`),
};
