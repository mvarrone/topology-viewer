import { glyphSvg } from "../graph/glyphs";
import { ago, esc } from "../lib/format";
import type { Device, InterfaceState, Link } from "../types";

/** Interface state of one end of a link, from the device that owns it (registered devices only). */
export type InterfaceLookup = (deviceId: string, name: string) => { state?: InterfaceState; device?: Device };

function speedText(mbps: number | null): string {
  if (!mbps) return "";
  return mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
}

/** "Admin up · Oper up · 1 Gbps", colored by the worst of the two states. */
function stateHtml(state: InterfaceState | undefined, device?: Device): string {
  if (device?.reachable === false) {
    // The stored state is from the last poll that worked: shown below, as the last known state.
    const last = state
      ? `<span class="ifstate last">Last state known: Admin ${state.admin ?? "unknown"} · Oper ${state.oper ?? "unknown"}${state.speed_mbps ? ` · ${speedText(state.speed_mbps)}` : ""}</span>`
      : "";
    return `<span class="ifstate muted">Admin unknown · Oper unknown · Speed unknown</span>${last}`;
  }
  if (!state) return '<span class="ifstate muted">State unknown (device not polled)</span>';
  const cls = state.admin === "down" ? "off" : state.oper === "down" ? "bad" : state.oper === "up" ? "ok" : "";
  const parts = [`Admin ${state.admin ?? "?"}`, `Oper ${state.oper ?? "?"}`, speedText(state.speed_mbps)].filter(Boolean);
  const title = state.description ? ` title="${esc(state.description)}"` : "";
  return `<span class="ifstate ${cls}"${title}>${parts.join(" · ")}</span>`;
}

export function emptyHtml(): string {
  return `
    <div class="empty">
      <p>Select a device or a link.</p>
      <p class="hint">Hover a device to isolate its neighbors. Double click to zoom in.</p>
    </div>`;
}

/** isAnswering: whether a device is registered and answered on the last poll. The dots show the
 * state of this device's ports, so they are gray when this registered device does not answer, or
 * when no end of the link answers. */
export function deviceHtml(device: Device, links: Link[], isAnswering: (id: string) => boolean = () => true): string {
  const states = new Map((device.interfaces ?? []).map((i) => [i.name, i]));
  const ringClass =
    !device.registered || device.role === "unknown" ? "unregistered" : device.reachable === false ? "unreachable" : device.role;
  const roleText = device.role === "unknown" ? "Unknown role" : device.role === "router" ? "Router" : "Switch";
  const layerText = device.layer ? `, ${esc(device.layer)} layer` : "";
  const roleSource =
    device.role_source === "lldp"
      ? "from neighbors' LLDP"
      : device.role_source === "platform"
        ? `from the model name${device.platform ? ` ${esc(device.platform)}` : ""}`
        : "";
  const polled = device.polled_via === "restconf" ? "RESTCONF" : device.polled_via === "ssh" ? "SSH (CLI)" : device.polled_via;

  const silent = device.registered && !isAnswering(device.id);
  const rows = links
    .map((l) => {
      const local = l.source === device.id;
      return {
        id: l.id,
        status: !silent && (isAnswering(l.source) || isAnswering(l.target)) ? l.status : "unknown",
        localIf: local ? l.source_if : l.target_if,
        peer: local ? l.target : l.source,
        peerIf: local ? l.target_if : l.source_if,
      };
    })
    .sort((a, b) => a.localIf.localeCompare(b.localIf, undefined, { numeric: true }));

  const tags = [
    device.platform && `<span class="tag">${esc(device.platform)}</span>`,
    device.os && `<span class="tag">${esc(device.os)}</span>`,
    device.registered
      ? polled && `<span class="tag ok">Polled over ${esc(polled)}</span>`
      : '<span class="tag warn">Unregistered neighbor</span>',
    device.reachable === false && '<span class="tag bad">Unreachable</span>',
  ]
    .filter(Boolean)
    .join("");

  const mgmt = device.mgmt_ip
    ? `<code>${esc(device.mgmt_ip)}</code><button class="copy" data-copy="${esc(device.mgmt_ip)}">Copy</button>`
    : '<span class="muted">Unknown</span>';

  return `
    <div class="d-head">
      <div class="d-icon ${ringClass}">${glyphSvg(device.role, "currentColor", 26)}</div>
      <div><h2>${esc(device.hostname)}</h2><p>${roleText}${layerText}${roleSource ? ` <span class="role-source">${roleSource}</span>` : ""}</p></div>
    </div>
    <div class="tags">${tags}</div>
    ${device.registered ? "" : addToDevicesHtml(device, [...new Set(rows.map((r) => r.peer))].sort())}
    <dl class="kv">
      <dt>Management IP</dt><dd>${mgmt}</dd>
      <dt>Serial number</dt><dd>${device.serial ? `<code>${esc(device.serial)}</code>` : '<span class="muted">Unknown</span>'}</dd>
      <dt>Neighbors</dt><dd>${new Set(rows.map((r) => r.peer)).size}</dd>
    </dl>
    <h3>Interfaces <span>${rows.length}</span></h3>
    ${
      rows.length
        ? `<ul class="ports">${rows
            .map(
              (r) => `
          <li data-select="${esc(r.id)}" data-edge="${esc(r.id)}" title="Open link">
            <span class="led ${r.status}"></span>
            <span class="if">
              <code>${esc(r.localIf)}</code>
              ${device.registered ? stateHtml(states.get(r.localIf), device) : ""}
              <span class="peer">
                <button class="linklike" data-select="${esc(r.peer)}">${esc(r.peer)}</button>
                <code>${esc(r.peerIf)}</code>
              </span>
            </span>
          </li>`,
            )
            .join("")}</ul>`
        : '<p class="muted">No LLDP neighbors.</p>'
    }`;
}

function seenText(link: Link): string {
  if (link.confirmed) return "Seen from both ends";
  if (link.status === "down") return "Not seen by any end";
  const seen = link.seen_by ?? [];
  return seen.length === 1 ? `Seen only from ${esc(seen[0])}` : "Seen from one end";
}

function endStateHtml(end: { state?: InterfaceState; device?: Device }): string {
  return stateHtml(end.state, end.device);
}

/** True when a registered device answered on the last poll, so it can report on its links. */
function answering(device: Device | undefined): boolean {
  return Boolean(device?.registered && device.reachable !== false);
}

export function linkHtml(link: Link, stateOf: InterfaceLookup): string {
  const source = stateOf(link.source, link.source_if);
  const target = stateOf(link.target, link.target_if);
  // No end answered on the last poll: the stored state is old, so the link state is unknown.
  if (!answering(source.device) && !answering(target.device)) return unknownLinkHtml(link, source, target);
  const up = link.status === "up";
  return `
    <div class="d-head">
      <div class="d-icon link">${glyphSvg("link", "currentColor", 26)}</div>
      <div><h2>Link</h2><p>${esc(link.source)} and ${esc(link.target)}</p></div>
    </div>
    <div class="tags">
      <span class="tag ${up ? "ok" : "bad"}">${up ? "Up" : "Down"}</span>
      <span class="tag">${seenText(link)}</span>
      <span class="tag">Discovered by LLDP</span>
    </div>
    <div class="ends">
      <button class="end" data-select="${esc(link.source)}"><strong>${esc(link.source)}</strong><code>${esc(link.source_if)}</code>${endStateHtml(source)}</button>
      <div class="wire ${link.status}"><span>${up ? "Connected" : "No LLDP adjacency"}</span></div>
      <button class="end" data-select="${esc(link.target)}"><strong>${esc(link.target)}</strong><code>${esc(link.target_if)}</code>${endStateHtml(target)}</button>
    </div>
    <dl class="kv">
      <dt>First seen</dt><dd>${ago(link.first_seen)}</dd>
      <dt>Last seen</dt><dd>${ago(link.last_seen)}</dd>
      ${up ? "" : `<dt>Missed runs</dt><dd>${link.missed_runs}</dd>`}
      <dt>Link ID</dt><dd><code>${esc(link.id)}</code></dd>
    </dl>`;
}

type End = { state?: InterfaceState; device?: Device };

function unknownLinkHtml(link: Link, source: End, target: End): string {
  const last = link.status === "up" ? (link.confirmed ? "up, seen from both ends" : "up, seen from one end") : "down";
  return `
    <div class="d-head">
      <div class="d-icon link">${glyphSvg("link", "currentColor", 26)}</div>
      <div><h2>Link</h2><p>${esc(link.source)} and ${esc(link.target)}</p></div>
    </div>
    <div class="tags">
      <span class="tag">State unknown</span>
      <span class="tag">Last state known: ${last}</span>
      <span class="tag">Discovered by LLDP</span>
    </div>
    <div class="ends">
      <button class="end" data-select="${esc(link.source)}"><strong>${esc(link.source)}</strong><code>${esc(link.source_if)}</code>${endStateHtml(source)}</button>
      <div class="wire unknown"><span>Unknown: neither end answers</span></div>
      <button class="end" data-select="${esc(link.target)}"><strong>${esc(link.target)}</strong><code>${esc(link.target_if)}</code>${endStateHtml(target)}</button>
    </div>
    <dl class="kv">
      <dt>First seen</dt><dd>${ago(link.first_seen)}</dd>
      <dt>Last seen</dt><dd>${ago(link.last_seen)}</dd>
      <dt>Link ID</dt><dd><code>${esc(link.id)}</code></dd>
    </dl>`;
}

/** Unregistered neighbors can be added to the inventory, with the management address LLDP reported. */
function addToDevicesHtml(device: Device, peers: string[]): string {
  const names = peers.map(esc);
  const seenBy = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const source = seenBy ? `Device seen through the LLDP information of ${seenBy}.` : "Device seen through LLDP.";
  const note = device.mgmt_ip
    ? `LLDP reported its management address, <code>${esc(device.mgmt_ip)}</code>.`
    : "LLDP did not report a management address; enter it in the form.";
  return `
    <div class="add-neighbor">
      <p>${source} This device is not added in Devices, so the app is not able to log in to it. Add it to read its own neighbors and details. ${note}</p>
      <button class="btn add-device" data-add-host="${esc(device.mgmt_ip ?? "")}">${PLUS} Add to Devices</button>
    </div>`;
}

const PLUS =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
