// The backend sends canonical interface names (backend/app/normalize.py). Keep this table in sync with _IF_TYPES there.
const IF_SHORT: Record<string, string> = {
  GigabitEthernet: "Gi",
  TwoGigabitEthernet: "Tw",
  FiveGigabitEthernet: "Fi",
  TenGigabitEthernet: "Te",
  TwentyFiveGigE: "Twe",
  FortyGigabitEthernet: "Fo",
  HundredGigE: "Hu",
  TwoHundredGigE: "TH",
  FourHundredGigE: "FH",
  FastEthernet: "Fa",
  Ethernet: "Eth",
  AppGigabitEthernet: "Ap",
  Management: "Mgmt",
  "Port-channel": "Po",
  Loopback: "Lo",
  Vlan: "Vl",
  Tunnel: "Tu",
  Serial: "Se",
  BDI: "BDI",
};

/** Abbreviated interface name, used only on canvas labels. */
export function shortIf(name: string): string {
  const match = /^([A-Za-z][A-Za-z-]*?)(\d.*)$/.exec(name);
  const short = match ? IF_SHORT[match[1]] : undefined;
  return short ? short + match![2] : name;
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

export function clock(iso: string | Date): string {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

export function ago(iso: string | Date): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function until(iso: string): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  return s === 0 ? "now" : `in ${s} s`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
