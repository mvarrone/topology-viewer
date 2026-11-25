import { TopologyGraph, type LayoutName, type LegendFilter, type Selection } from "./graph/graph";
import { Minimap, syncGrid } from "./graph/minimap";
import { connectUpdates, getPositions, getRuns, getStatus, savePositions, startManualRun } from "./lib/api";
import { ago, capitalize, clock, esc, until } from "./lib/format";
import { initTheme, readTheme, toggleTheme } from "./lib/theme";
import { applyDiff } from "./lib/topology";
import type { ConnectionState, Device, DiscoveryRun, DiscoveryStatus, Topology, WsMessage } from "./types";
import { deviceHtml, emptyHtml, linkHtml } from "./ui/details";
import { eventsHtml, setHostnameLookup } from "./ui/events";
import { InventoryView } from "./ui/inventory";

const MAX_QUIET_RUNS = 200;
const MAX_NOTABLE_RUNS = 200;
const SAVE_DELAY_MS = 400;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;

// State

let topology: Topology = { collected_at: null, nodes: [], links: [] };
let status: DiscoveryStatus | null = null;
let runs: DiscoveryRun[] = [];
let connection: ConnectionState = "connecting";
let selection: Selection = null;
let unread = 0;
let runsLoaded = false;
let snapshotLoaded = false;

const busy = () => Boolean(status?.running);

// Graph

initTheme();
let saveTimer: number | undefined;
const graph = new TopologyGraph(
  $("#cy"),
  readTheme(),
  (next) => {
    selection = next;
    renderDetails();
    if (next) {
      setTab("details");
      // A click on a node or link opens a hidden panel, so its details are visible.
      if (!panelOpen()) setPanel(true);
    }
  },
  (positions) => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      savePositions(positions).catch((error) => console.error("Could not save positions", error));
    }, SAVE_DELAY_MS);
  },
);
// Exposed in development only, for debugging and browser tests.
if (import.meta.env.DEV) (window as unknown as { topologyGraph: TopologyGraph }).topologyGraph = graph;
const minimap = new Minimap($<HTMLCanvasElement>("#minimap"), graph);
syncGrid($("#stage"), graph);
document.fonts?.ready.then(() => graph.cy.style().update());

// Rendering

const paneDetails = $("#pane-details");
const paneEvents = $("#pane-events");
const eventsList = $("#events-list");
const eventsSearch = $<HTMLInputElement>("#events-search");
const eventsSearchClear = $<HTMLButtonElement>("#events-search-clear");
// Expanded groups of quiet runs survive the re-render after each run.
const openGroups = new Set<number>();

function renderDetails(): void {
  if (!selection) {
    paneDetails.innerHTML = emptyHtml();
    return;
  }
  const id = selection.kind === "device" ? selection.device.id : selection.link.id;
  if (!graph.has(id)) {
    selection = null;
    paneDetails.innerHTML = emptyHtml();
    return;
  }
  const raw = graph.cy.getElementById(id).data("raw");
  paneDetails.innerHTML =
    selection.kind === "device"
      ? deviceHtml(raw, graph.linksOf(id), (dev) => {
          const d = topology.nodes.find((n) => n.id === dev);
          return Boolean(d?.registered && d.reachable !== false);
        })
      : linkHtml(raw, (dev, name) => {
          const device = topology.nodes.find((d) => d.id === dev);
          return { device, state: device?.interfaces?.find((i) => i.name === name) };
        });
}

function renderEvents(): void {
  setHostnameLookup((host) => topology.nodes.find((d) => d.mgmt_ip === host)?.hostname);
  eventsList.innerHTML = eventsHtml(runs, (id) => graph.has(id), openGroups, eventsSearch.value);
  tick();
}

function renderStats(): void {
  const down = topology.links.filter((l) => l.status === "down").length;
  const unregistered = topology.nodes.filter((d) => !d.registered).length;
  // Shown only after the backend sent a topology, so it does not flash while connecting.
  $("#canvas-empty").hidden = !snapshotLoaded || topology.nodes.length > 0;
  // Cytoscape returns an empty image for an empty graph, so there is nothing to export.
  $("#export").toggleAttribute("disabled", topology.nodes.length === 0);
  $("#stats").innerHTML = `
    <span><b>${topology.nodes.length}</b>${topology.nodes.length === 1 ? "device" : "devices"} on canvas</span>
    <span><b>${topology.links.length}</b>${topology.links.length === 1 ? "link" : "links"}</span>
    <span class="${down ? "warn" : ""}"><b>${down}</b>${down === 1 ? "link" : "links"} down</span>
    <span><b>${unregistered}</b>unregistered</span>`;
}

function renderStatusBar(): void {
  const dot = $("#state-dot");
  const label = $("#state-label");
  const offline = connection !== "open";
  dot.classList.toggle("busy", !offline && busy());
  dot.classList.toggle("offline", offline);
  $("#btn-run").toggleAttribute("disabled", offline || busy());
  $("#btn-run").classList.toggle("busy", !offline && busy());
  if (status) {
    $("#btn-run").dataset.tip = `Start a run now. Scheduled runs happen every ${status.interval_seconds} seconds`;
  }
  if (offline) {
    label.textContent = connection === "connecting" ? "Connecting to backend" : "Backend offline, reconnecting";
  } else if (busy()) {
    label.textContent = `${capitalize(status!.running!.trigger)} run in progress`;
  } else {
    label.textContent = "Last discovery";
  }
  $("#run-detail").hidden = offline;
  tick();
}

/** Relative times refresh every second. */
function tick(): void {
  const last = runs.find((r) => r.status === "completed" || r.status === "failed");
  const lastAt = last ? (last.finished_at ?? last.started_at) : null;
  $("#bar-time").textContent = lastAt ? clock(lastAt) : "none yet";
  $("#bar-ago").textContent = last && lastAt ? `${last.trigger}, ${ago(lastAt)}` : "";
  const next = status?.next_scheduled_at ? until(status.next_scheduled_at) : "";
  $("#bar-next").textContent = next ? `Next scheduled ${next}` : "";
  const changes = last?.diff?.changes.length ?? 0;
  $("#bar-status").hidden = !last;
  const result = $("#bar-changes");
  result.textContent = changes ? `Changes (${changes})` : "No changes";
  result.className = changes ? "changed" : "ok";
}
setInterval(tick, 1000);

let toastTimer: number | undefined;
function toast(message: string): void {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3500);
}

// Data from the backend

function upsertRun(run: DiscoveryRun): void {
  // Runs with changes or failures stay even when many quiet runs come after them.
  let quiet = 0;
  let notable = 0;
  runs = [run, ...runs.filter((r) => r.id !== run.id)]
    .sort((a, b) => b.id - a.id)
    .filter((r) =>
      r.status === "failed" || (r.diff?.changes.length ?? 0) > 0
        ? notable++ < MAX_NOTABLE_RUNS
        : quiet++ < MAX_QUIET_RUNS,
    );
}

function refreshTopology(markFresh: boolean): void {
  graph.sync(topology, markFresh);
  renderStats();
  renderDetails();
  minimap.queue();
}

async function loadRuns(): Promise<void> {
  try {
    const history = await getRuns();
    history.forEach(upsertRun);
    runsLoaded = true;
    renderEvents();
    renderStatusBar();
  } catch (error) {
    console.error("Could not load run history", error);
  }
}

async function refreshStatus(): Promise<void> {
  try {
    status = await getStatus();
    renderStatusBar();
  } catch (error) {
    console.error("Could not load discovery status", error);
  }
}

function handleMessage(msg: WsMessage): void {
  switch (msg.type) {
    case "snapshot":
      topology = msg.topology;
      status = msg.status;
      snapshotLoaded = true;
      refreshTopology(false);
      if (!runsLoaded) void loadRuns();
      break;
    case "run_started":
      if (status) status.running = msg.run;
      break;
    case "run_finished": {
      const { run } = msg;
      if (run.diff) {
        topology = applyDiff(topology, run.diff, run.finished_at);
        refreshTopology(true);
      }
      upsertRun(run);
      void inventory.refresh();
      if (status) status.running = null;
      const changes = run.diff?.changes.length ?? 0;
      if (changes && paneEvents.hidden && runs.length > 1) {
        unread += changes;
        $("#badge").textContent = String(unread);
        $("#badge").hidden = false;
      }
      void refreshStatus();
      break;
    }
    case "run_skipped":
      upsertRun(msg.run);
      break;
  }
  renderEvents();
  renderStatusBar();
}

// Saved positions load before the first snapshot, so the canvas opens as the user left it.
void getPositions()
  .catch((error) => {
    console.error("Could not load saved positions", error);
    return {};
  })
  .then((saved) => {
    graph.setSavedPositions(saved);
    connectUpdates(handleMessage, (state) => {
      connection = state;
      renderStatusBar();
    });
  });

// Side panel

function setTab(name: "details" | "events"): void {
  const details = name === "details";
  $("#tab-details").setAttribute("aria-selected", String(details));
  $("#tab-events").setAttribute("aria-selected", String(!details));
  paneDetails.hidden = !details;
  paneEvents.hidden = details;
  if (!details) {
    unread = 0;
    $("#badge").hidden = true;
  }
}
$("#tab-details").addEventListener("click", () => setTab("details"));
$("#tab-events").addEventListener("click", () => setTab("events"));

paneDetails.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const add = target.closest<HTMLElement>("[data-add-host]");
  if (add) return void inventory.openAddForm(add.dataset.addHost);
  const copy = target.closest<HTMLElement>("[data-copy]");
  if (copy) {
    void navigator.clipboard?.writeText(copy.dataset.copy!);
    copy.textContent = "Copied";
    return;
  }
  const pick = target.closest<HTMLElement>("[data-select]");
  if (pick) graph.select(pick.dataset.select!);
});
paneDetails.addEventListener("mouseover", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-edge]");
  if (row) graph.highlightLink(row.dataset.edge!, true);
});
paneDetails.addEventListener("mouseout", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-edge]");
  if (row && !row.contains(e.relatedTarget as Node)) graph.highlightLink(row.dataset.edge!, false);
});

paneEvents.addEventListener(
  "toggle",
  (e) => {
    const group = Number((e.target as HTMLElement).dataset.group);
    if (!group) return;
    if ((e.target as HTMLDetailsElement).open) openGroups.add(group);
    else openGroups.delete(group);
  },
  true,
);
eventsSearch.addEventListener("input", () => {
  eventsSearchClear.hidden = eventsSearch.value === "";
  renderEvents();
});
eventsSearch.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && eventsSearch.value) {
    e.stopPropagation();
    eventsSearch.value = "";
    eventsSearchClear.hidden = true;
    renderEvents();
  }
});
eventsSearchClear.addEventListener("click", () => {
  eventsSearch.value = "";
  eventsSearchClear.hidden = true;
  renderEvents();
  eventsSearch.focus();
});
paneEvents.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const pick = target.closest<HTMLElement>("[data-select]");
  if (pick) graph.select(pick.dataset.select!);
});

// Legend: click a kind to show only those devices or links; click it again (or Escape) to show all.
const LEGEND_NAMES: Record<LegendFilter, [string, string]> = {
  router: ["router", "routers"],
  switch: ["switch", "switches"],
  unregistered: ["unregistered device", "unregistered devices"],
  onesided: ["one-sided link", "one-sided links"],
  down: ["link down", "links down"],
};

function setLegendFilter(filter: LegendFilter | null): void {
  const count = graph.setFilter(filter);
  document.querySelectorAll<HTMLButtonElement>("#legend [data-filter]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.filter === filter));
  });
  if (filter) {
    const [one, many] = LEGEND_NAMES[filter];
    toast(count ? `Showing ${count} ${count === 1 ? one : many}` : `No ${many} right now`);
  }
}

$("#legend").addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
  if (!button) return;
  const filter = button.dataset.filter as LegendFilter;
  setLegendFilter(graph.activeFilter === filter ? null : filter);
});

// Toolbar and canvas controls

async function runManual(): Promise<void> {
  const result = await startManualRun();
  if (!result.ok) toast(result.message);
}

$("#btn-run").addEventListener("click", () => void runManual());

const inventory = new InventoryView(
  $("#inventory"),
  $<HTMLDialogElement>("#inv-dialog"),
  toast,
  (open) => $("#btn-inventory").setAttribute("aria-pressed", String(open)),
);
$("#btn-inventory").addEventListener("click", () => {
  if (inventory.isOpen) inventory.close();
  else void inventory.open();
});
$("#stats").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest('[data-open="inventory"]')) void inventory.open();
});
$<HTMLSelectElement>("#layout").addEventListener("change", (e) =>
  graph.runLayout((e.target as HTMLSelectElement).value as LayoutName),
);
$("#btn-ports").addEventListener("click", (e) => {
  const button = e.currentTarget as HTMLElement;
  const on = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(on));
  graph.setPorts(on);
  try {
    localStorage.setItem("ports", String(on));
  } catch {
    /* storage not available */
  }
});
// Interface names are shown by default; the Ports button hides them and the choice is kept.
if (localStorage.getItem("ports") === "false") {
  $("#btn-ports").setAttribute("aria-pressed", "false");
  graph.setPorts(false);
}
$("#btn-theme").addEventListener("click", () => {
  toggleTheme();
  graph.setTheme(readTheme());
  minimap.queue();
});
/** Show or hide the side panel. The choice is remembered in this browser. */
function setPanel(open: boolean): void {
  $("#main").classList.toggle("panel-closed", !open);
  try {
    localStorage.setItem("panel-open", String(open));
  } catch {
    // Storage can be blocked; the panel still works for this visit.
  }
  requestAnimationFrame(() => {
    graph.cy.resize();
    minimap.queue();
  });
}
const panelOpen = () => !$("#main").classList.contains("panel-closed");
$("#panel-open").addEventListener("click", () => setPanel(true));
$("#panel-close").addEventListener("click", () => setPanel(false));
try {
  if (localStorage.getItem("panel-open") === "false") setPanel(false);
} catch {
  // Ignore: open by default.
}
$("#zoom-in").addEventListener("click", () => graph.zoomBy(1.25));
$("#zoom-out").addEventListener("click", () => graph.zoomBy(0.8));
$("#fit").addEventListener("click", () => graph.fit());
$("#export").addEventListener("click", async () => {
  if (graph.cy.nodes().empty()) return;
  const a = document.createElement("a");
  a.href = await graph.exportPng();
  a.download = `topology-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
  a.click();
});

// Device search with a suggestion list aligned under the search box.
const search = $<HTMLInputElement>("#search");
const results = $<HTMLUListElement>("#search-results");
const clearSearch = $<HTMLButtonElement>("#search-clear");
const MAX_RESULTS = 50;
let matches: Device[] = [];
let active = -1;

/** The x shows whenever the box has text, typed or set by picking a device. */
function syncClear(): void {
  clearSearch.hidden = search.value === "";
}

function closeResults(): void {
  results.hidden = true;
  search.setAttribute("aria-expanded", "false");
  active = -1;
}

function renderResults(): void {
  const q = search.value.trim().toLowerCase();
  // With an empty box every device is listed, by name; typing filters by name or IP.
  const byName = (a: Device, b: Device) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true });
  matches = (
    q
      ? topology.nodes
          .filter((d) => d.hostname.toLowerCase().includes(q) || (d.mgmt_ip ?? "").includes(q))
          .sort(
            (a, b) =>
              Number(!a.hostname.toLowerCase().startsWith(q)) - Number(!b.hostname.toLowerCase().startsWith(q)) ||
              byName(a, b),
          )
      : [...topology.nodes].sort(byName)
  ).slice(0, MAX_RESULTS);
  if (!matches.length) return closeResults();
  active = Math.min(Math.max(active, 0), matches.length - 1);
  results.innerHTML = matches
    .map(
      (d, i) => `<li role="option" data-index="${i}" aria-selected="${i === active}">
        <strong>${esc(d.hostname)}</strong><span>${esc(d.mgmt_ip ?? (d.registered ? "" : "unregistered"))}</span></li>`,
    )
    .join("");
  results.hidden = false;
  search.setAttribute("aria-expanded", "true");
}

function pick(device: Device | undefined): void {
  if (device) {
    search.value = device.hostname;
    syncClear();
    graph.select(device.id, 1.4);
    search.blur();
  } else if (search.value.trim()) {
    toast(`No device matches "${search.value.trim()}"`);
  }
  closeResults();
}

search.addEventListener("input", () => {
  syncClear();
  active = 0;
  renderResults();
});
search.addEventListener("focus", renderResults);
search.addEventListener("click", () => results.hidden && renderResults());
search.addEventListener("blur", closeResults);
search.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (results.hidden) return renderResults();
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
    renderResults();
    results.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    pick(matches[active] ?? topology.nodes.find((d) => d.id === graph.findDevice(search.value)));
  } else if (e.key === "Escape") {
    closeResults();
  }
});
// mousedown keeps the focus where it is, so clearing does not open the suggestion list.
clearSearch.addEventListener("mousedown", (e) => e.preventDefault());
clearSearch.addEventListener("click", () => {
  search.value = "";
  syncClear();
  closeResults();
  graph.select(null);
  graph.fit();
  setTab("events");
});
// mousedown keeps the focus in the input, so the click lands before the list closes.
results.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const item = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
  if (item) pick(matches[Number(item.dataset.index)]);
});

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "SELECT", "TEXTAREA"].includes((document.activeElement as HTMLElement)?.tagName);
  if (e.key === "Escape" && inventory.isOpen && !$<HTMLDialogElement>("#inv-dialog").open) {
    inventory.close();
    return;
  }
  if (e.key === "Escape") {
    graph.select(null);
    search.blur();
    if (graph.activeFilter) setLegendFilter(null);
  }
  if (typing) return;
  if (e.key === "/") {
    e.preventDefault();
    search.focus();
  }
  if (e.key === "f" || e.key === "F") graph.fit();
  if ((e.key === "p" || e.key === "P") && !inventory.isOpen) setPanel(!panelOpen());
});

// Events is the tab shown first; selecting a device or a link switches to Details.
setTab("events");
renderDetails();
renderEvents();
renderStats();
renderStatusBar();
