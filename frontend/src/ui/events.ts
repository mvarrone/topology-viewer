import { capitalize, clock, esc, plural } from "../lib/format";
import type { Change, DiscoveryRun } from "../types";

const MAX_CHANGES = 8;
const SHOWN_WHEN_TRUNCATED = 5;

const KIND_CLASS: Record<string, string> = {
  device_added: "added",
  link_added: "added",
  link_up: "up",
  link_down: "down",
  device_removed: "removed",
  link_removed: "removed",
  device_unreachable: "alert",
  device_reachable: "recovered",
  interface_down: "down",
  interface_up: "up",
};

/** Events saved before reachability had its own kinds were "device_updated". */
function kindClass(change: Change): string {
  if (change.kind === "device_updated") {
    if (change.summary.includes(" is unreachable")) return "alert";
    if (change.summary.includes(" is reachable again")) return "recovered";
  }
  return KIND_CLASS[change.kind] ?? "info";
}

function changeCount(run: DiscoveryRun): number {
  return run.diff?.changes.length ?? 0;
}

function isInitial(run: DiscoveryRun): boolean {
  return Boolean(run.diff?.summary.startsWith("Initial discovery")) && changeCount(run) > 0;
}

function quietLabel(run: DiscoveryRun): string {
  return run.diff?.summary === "No devices" ? "No devices" : "No changes";
}

/** Completed runs without changes and with the same errors are shown as one group. */
function quietKey(run: DiscoveryRun): string | null {
  if (run.status !== "completed" || changeCount(run) > 0) return null;
  return `${quietLabel(run)}|${JSON.stringify(run.errors)}`;
}

// Errors are keyed by management address; main.ts tells which hostname has each address.
let hostnameOf: (host: string) => string | undefined = () => undefined;
export function setHostnameLookup(lookup: (host: string) => string | undefined): void {
  hostnameOf = lookup;
}

function errorRows(run: DiscoveryRun, at: string, query = ""): string {
  const changes = run.diff?.changes ?? [];
  return Object.entries(run.errors)
    .map(([host, error]) => {
      // Already told by the change of this run ("R2 (...) is unreachable over ..."): one line, not two.
      if (changes.some((c) => c.summary.includes(error))) return "";
      const name = hostnameOf(host);
      const who = name ? `${name} (${host})` : host;
      // "R1 (192.168.1.51) is unreachable over RESTCONF port 443 (connection timed out)"
      const text = error.startsWith("unreachable") ? `${who} is ${error}` : `${who}: ${error}`;
      if (query && !matches(text, query)) return "";
      return `<li class="ev down">${esc(text)}<time>${clock(at)}</time></li>`;
    })
    .join("");
}

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query);
}

/** Runs are newest first. A group of quiet runs becomes one row with the time span. */
function timelineRows(runs: DiscoveryRun[], exists: (id: string) => boolean, open: Set<number>): string {
  const rows: string[] = [];
  for (let i = 0; i < runs.length; ) {
    const key = quietKey(runs[i]);
    let j = i + 1;
    while (key && j < runs.length && quietKey(runs[j]) === key) j++;
    if (j - i === 1) {
      rows.push(runRows(runs[i], exists));
    } else {
      const group = runs.slice(i, j);
      const newest = group[0].finished_at ?? group[0].started_at;
      const oldest = group[group.length - 1].finished_at ?? group[group.length - 1].started_at;
      const key = group[group.length - 1].id;
      const items = group
        .map((r) => `<li><span>${capitalize(r.trigger)} run at ${clock(r.finished_at ?? r.started_at)}</span></li>`)
        .join("");
      rows.push(
        `<li class="run-group"><details data-group="${key}" ${open.has(key) ? "open" : ""}>
          <summary class="run quiet"><span>${group.length} runs, ${clock(oldest)} to ${clock(newest)}</span><span>${quietLabel(runs[i])}</span></summary>
          <ul class="group-runs">${items}</ul>
        </details></li>${errorRows(runs[i], newest)}`,
      );
    }
    i = j;
  }
  return rows.join("");
}

function changeRow(change: Change, at: string, exists: (id: string) => boolean): string {
  const target = change.target && exists(change.target) ? ` data-select="${esc(change.target)}"` : "";
  const manual = change.manual ? " manual" : "";
  return `<li class="ev ${kindClass(change)}${manual}"${target}>${esc(change.summary)}<time>${clock(at)}</time></li>`;
}

function runRows(run: DiscoveryRun, exists: (id: string) => boolean, query = ""): string {
  const trigger = capitalize(run.trigger);
  if (run.status === "skipped") {
    const text = `${trigger} run skipped at ${clock(run.started_at)}`;
    if (query && !matches(`${text} ${run.errors.run ?? ""}`, query)) return "";
    return `<li class="run skipped"><span>${text}</span><span>${esc(run.errors.run ?? "")}</span></li>`;
  }
  const at = run.finished_at ?? run.started_at;
  const title = `${trigger} run at ${clock(at)}`;
  if (run.status === "failed") {
    const error = Object.values(run.errors).join("; ");
    if (query && !matches(`${title} ${error}`, query)) return "";
    return `<li class="run ${run.trigger}"><span>${title}</span><span class="bad">Failed</span></li>
      <li class="ev down">${esc(error)}<time>${clock(at)}</time></li>`;
  }
  const changes = run.diff?.changes ?? [];
  const label = isInitial(run) ? "Initial discovery" : changes.length ? plural(changes.length, "change") : quietLabel(run);
  const head = `<li class="run ${run.trigger}"><span>${title}</span><span>${label}</span></li>`;
  // Newest at the top, like the runs: the first change of the run is the last row.
  const ordered = [...changes].reverse();
  if (query) {
    // Searching: a run whose title matches shows everything; otherwise only the rows that match.
    const all = matches(title, query);
    const errors = errorRows(run, at, all ? "" : query);
    const rows = ordered.filter((c) => all || matches(c.summary, query)).map((c) => changeRow(c, at, exists));
    return errors || rows.length ? head + errors + rows.join("") : "";
  }
  const errors = errorRows(run, at);
  const shown = ordered.length > MAX_CHANGES ? ordered.slice(0, SHOWN_WHEN_TRUNCATED) : ordered;
  const rows = shown.map((c) => changeRow(c, at, exists));
  if (shown.length < changes.length) {
    rows.push(`<li class="ev more">${changes.length - shown.length} more</li>`);
  }
  return head + errors + rows.join("");
}

/** The events list. `open` holds the groups the user expanded, by the id of their oldest run.
 * With a query, quiet runs are not grouped and only matching events are shown. */
export function eventsHtml(
  runs: DiscoveryRun[],
  exists: (id: string) => boolean,
  open: Set<number>,
  query = "",
): string {
  if (!runs.length) return `<div class="empty"><p>No events yet.</p><p class="hint">They appear after the first discovery run.</p></div>`;
  const q = query.trim().toLowerCase();
  if (!q) return `<ol class="timeline">${timelineRows(runs, exists, open)}</ol>`;
  const rows = runs.map((r) => runRows(r, exists, q)).join("");
  return rows
    ? `<ol class="timeline">${rows}</ol>`
    : `<div class="empty"><p>No events match "${esc(query.trim())}".</p></div>`;
}
