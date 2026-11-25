import { inventoryApi } from "../lib/api";
import { ago, esc } from "../lib/format";
import type { ConnectionTest, InventoryDevice, MethodInput, Protocol } from "../types";

const DEFAULT_PORTS: Record<Protocol, number> = { restconf: 443, ssh: 22 };
const PLATFORMS = ["cisco_xe", "cisco_ios", "cisco_nxos", "cisco_xr", "arista_eos", "juniper_junos"];
const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

type TestState = ConnectionTest[] | "running" | string;

const protocolName = (p: Protocol) => (p === "restconf" ? "RESTCONF" : "SSH (CLI)");

/** Same rule as valid_host in backend/app/store.py: an IP address or a DNS name. */
export function hostError(value: string): string | null {
  const host = value.trim();
  if (!host) return "Enter an IP address or a DNS name.";
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split(".");
    const ok = parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
    return ok ? null : "Not a valid IPv4 address.";
  }
  if (host.includes(":")) {
    try {
      new URL(`http://[${host}]/`);
      return null;
    } catch {
      return "Not a valid IPv6 address.";
    }
  }
  return HOSTNAME.test(host) ? null : "Not a valid IP address or DNS name.";
}

/** Devices to poll and how to reach them. Opens over the canvas. */
export class InventoryView {
  private devices: InventoryDevice[] = [];
  private tests = new Map<number, TestState>();
  private draftMethods: MethodInput[] = [];
  private filter = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly dialog: HTMLDialogElement,
    private readonly toast: (message: string) => void,
    private readonly onToggle: (open: boolean) => void = () => {},
  ) {
    root.addEventListener("click", (e) => void this.onClick(e));
    root.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name !== "inv-search") return;
      this.filter = input.value;
      this.renderList();
    });
    dialog.addEventListener("click", (e) => this.onDialogClick(e));
    dialog.addEventListener("change", (e) => this.onDialogChange(e));
    dialog.addEventListener("input", (e) => this.onDialogInput(e));
    dialog.addEventListener("submit", (e) => void this.onSubmit(e));
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(): Promise<void> {
    this.root.hidden = false;
    this.onToggle(true);
    this.render();
    await this.reload();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
    this.root.hidden = true;
    this.onToggle(false);
  }

  /** Called after each discovery run, so names and last poll results stay current. */
  async refresh(): Promise<void> {
    if (this.isOpen && !this.dialog.open) await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.devices = await inventoryApi.devices();
    } catch (error) {
      this.toast(`Could not load the inventory: ${(error as Error).message}`);
    }
    this.render();
  }

  // Page

  /** The page shell is built once, so the search box keeps focus while the list refreshes. */
  private render(): void {
    if (!this.root.querySelector(".inv")) {
      this.root.innerHTML = `
        <div class="inv">
          <header class="inv-head">
            <div>
              <h1>Devices <span class="count" data-count></span></h1>
              <p data-intro></p>
            </div>
            <div class="inv-head-actions"></div>
          </header>
          <div class="inv-toolbar">
            <label class="search inv-search">
              ${SEARCH}
              <input name="inv-search" placeholder="Search by host or name" autocomplete="off" aria-label="Search devices">
            </label>
          </div>
          <div data-list></div>
        </div>`;
    }
    this.renderList();
  }

  private renderList(): void {
    const has = this.devices.length > 0;
    this.root.querySelector<HTMLElement>("[data-intro]")!.textContent =
      "This section shows the devices the app can log in to. Enter the connection details for each device. " +
      "You can add more than one connection method: they are used in priority order, and the next method is " +
      "tried only when the previous one fails. Devices that are seen as neighbors but are not in this list show " +
      "on the topology as unregistered neighbors, with a dashed border.";
    this.root.querySelector<HTMLElement>("[data-count]")!.textContent = String(this.devices.length);
    this.root.querySelector<HTMLElement>(".inv-head-actions")!.innerHTML = has ? ADD_BUTTON : "";
    this.root.querySelector<HTMLElement>(".inv-toolbar")!.hidden = !has;
    this.root.querySelector<HTMLElement>("[data-list]")!.innerHTML = this.devicesHtml();
  }

  private devicesHtml(): string {
    if (!this.devices.length) {
      return `
        <div class="inv-empty">
          <p>No devices yet.</p>
          <p class="hint">Add a device with its IP address and how to connect to it.</p>
          ${ADD_BUTTON}
        </div>`;
    }
    const q = this.filter.trim().toLowerCase();
    const shown = q
      ? this.devices.filter((d) => d.host.toLowerCase().includes(q) || (d.last_hostname ?? "").toLowerCase().includes(q))
      : this.devices;
    if (!shown.length) {
      return `<div class="inv-empty"><p>No device matches "${esc(this.filter.trim())}".</p></div>`;
    }
    const rows = shown.map((d) => this.deviceRow(d)).join("");
    return `
      <table class="inv-table">
        <thead><tr><th>Host</th><th>Discovered name</th><th>Connection, in order</th><th>Last poll</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  private deviceRow(d: InventoryDevice): string {
    // Methods are tried in order until one works, so the last poll tells the state of each:
    // the ones above the method that worked failed, the ones below were not tried.
    // When the poll failed, every method was tried and failed.
    const usedAt = d.methods.findIndex((m) => m.id === d.last_method_id);
    const failedPoll = Boolean(d.last_error) && usedAt < 0;
    const methods = d.methods
      .map((m, i) => {
        let used = "";
        if (failedPoll || (usedAt >= 0 && i < usedAt)) used = ' class="failed" title="Failed on the last poll"';
        else if (i === usedAt) used = ' class="used" title="Worked on the last poll"';
        else if (usedAt >= 0) used = ' title="Not tried on the last poll: a method above worked"';
        const port = m.port ?? DEFAULT_PORTS[m.protocol];
        return `<li${used}><span class="n">${i + 1}</span>${protocolName(m.protocol)} <code>${port}</code> <span class="muted">${esc(m.username)}</span>${m.platform ? ` <span class="tag">${esc(m.platform)}</span>` : ""}</li>`;
      })
      .join("");
    let status: string;
    if (!d.enabled) status = `<span class="tag">Disabled</span>`;
    else if (d.last_error) status = `<span class="tag bad">Error</span> <span class="muted">${ago(d.last_polled_at!)}</span><div class="inv-error">${esc(d.last_error)}</div>`;
    else if (d.last_seen_at) status = `<span class="tag ok">OK</span> <span class="muted">${ago(d.last_seen_at)}</span>`;
    else status = `<span class="tag">Not polled yet</span>`;
    const test = this.tests.get(d.id);
    return `
      <tr class="${d.enabled ? "" : "off"}">
        <td><code>${esc(d.host)}</code></td>
        <td>${d.last_hostname ? `<strong>${esc(d.last_hostname)}</strong>` : '<span class="muted">Unknown yet</span>'}</td>
        <td><ol class="methods">${methods}</ol></td>
        <td>${status}</td>
        <td class="actions"><div class="row-actions">
          <button class="btn" data-action="test" data-id="${d.id}" ${test === "running" ? "disabled" : ""}>Test</button>
          <button class="btn" data-action="edit-device" data-id="${d.id}">Edit</button>
          <button class="btn icon danger" data-action="delete-device" data-id="${d.id}" aria-label="Delete ${esc(d.host)}" data-tip="Delete">${TRASH}</button>
        </div></td>
      </tr>
      ${test ? `<tr class="inv-test"><td colspan="5">${this.testHtml(d, test)}</td></tr>` : ""}`;
  }

  private testHtml(d: InventoryDevice, test: TestState): string {
    if (test === "running") return `<span class="muted">Testing ${d.methods.length} connection method(s)...</span>`;
    if (typeof test === "string") return `<span class="bad">${esc(test)}</span>`;
    const lines = test
      .map((t) => {
        const result = t.ok
          ? `<span>answers as <strong>${esc(t.hostname)}</strong>, ${t.neighbors} LLDP neighbor(s)</span>`
          : `<span class="bad">${esc(t.error ?? "failed")}</span>`;
        return `<li><span class="led ${t.ok ? "" : "down"}"></span>${protocolName(t.protocol)} <code>${t.port}</code> ${result} <span class="muted">${t.duration_ms} ms</span></li>`;
      })
      .join("");
    return `<ul class="test-list">${lines}</ul>`;
  }

  private async onClick(e: Event): Promise<void> {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const id = Number(target.dataset.id);
    switch (target.dataset.action) {
      case "add-device":
        this.openDeviceForm(null);
        break;
      case "edit-device":
        this.openDeviceForm(this.devices.find((d) => d.id === id) ?? null);
        break;
      case "delete-device": {
        const device = this.devices.find((d) => d.id === id);
        if (device && (await this.confirmDelete(device))) {
          try {
            await inventoryApi.deleteDevice(id);
            this.toast(`${device.host} deleted`);
            await this.reload();
          } catch (error) {
            this.toast((error as Error).message);
          }
        }
        break;
      }
      case "test":
        await this.test(id);
        break;
    }
  }

  private async test(id: number): Promise<void> {
    this.tests.set(id, "running");
    this.render();
    try {
      this.tests.set(id, await inventoryApi.testDevice(id));
    } catch (error) {
      this.tests.set(id, (error as Error).message);
    }
    this.render();
  }

  /** In-app confirmation. Resolves true when the user clicks Delete. */
  private confirmDelete(device: InventoryDevice): Promise<boolean> {
    const name = device.last_hostname ? `${esc(device.last_hostname)} (${esc(device.host)})` : esc(device.host);
    this.dialog.dataset.id = "";
    this.dialog.innerHTML = `
      <form method="dialog" class="form confirm">
        <header class="form-head"><h2>Delete ${name}?</h2></header>
        <div class="form-body">
          <p>It stops being polled and its connection data, passwords included, is removed. It leaves the topology right away.</p>
        </div>
        <footer class="form-actions">
          <button type="button" class="btn" data-confirm="no">Cancel</button>
          <button type="button" class="btn danger-solid" data-confirm="yes">Delete</button>
        </footer>
      </form>`;
    return new Promise((resolve) => {
      const done = (answer: boolean) => {
        this.dialog.removeEventListener("click", onClick);
        this.dialog.removeEventListener("close", onClose);
        if (this.dialog.open) this.dialog.close();
        resolve(answer);
      };
      const onClick = (e: Event) => {
        const choice = (e.target as HTMLElement).closest<HTMLElement>("[data-confirm]")?.dataset.confirm;
        if (choice) done(choice === "yes");
      };
      const onClose = () => done(false); // Escape
      this.dialog.addEventListener("click", onClick);
      this.dialog.addEventListener("close", onClose);
      this.dialog.showModal();
      this.dialog.querySelector<HTMLElement>('[data-confirm="no"]')!.focus();
    });
  }

  // Form

  /** Opens the add form from outside the page, for example for an LLDP neighbor. */
  openAddForm(host = ""): void {
    this.openDeviceForm(null);
    if (host) this.dialog.querySelector<HTMLInputElement>('input[name="host"]')!.value = host;
    this.dialog.querySelector<HTMLInputElement>(host ? 'input[name="username"]' : 'input[name="host"]')?.focus();
  }

  private openDeviceForm(device: InventoryDevice | null): void {
    this.draftMethods = [];
    this.draftMethods = device ? device.methods.map((m) => ({ ...m, password: null })) : [this.newMethod()];
    this.dialog.dataset.id = device ? String(device.id) : "";
    this.dialog.innerHTML = `
      <form method="dialog" class="form" novalidate>
        <header class="form-head">
          <h2>${device ? `Edit ${esc(device.host)}` : "Add device"}</h2>
          <button type="button" class="btn icon" data-dialog="cancel" aria-label="Close">${CLOSE}</button>
        </header>
        <div class="form-body">
          <div class="field-row host-row">
            <label class="grow">Host
              <input name="host" required value="${esc(device?.host ?? "")}" placeholder="192.168.1.50 or r1.example.com" autocomplete="off">
              <span class="field-error" data-error="host" hidden></span>
            </label>
            <label class="check"><input name="enabled" type="checkbox" ${device?.enabled === false ? "" : "checked"}> Poll this device</label>
          </div>
          <div class="methods-head">
            <h3>Connection methods</h3>
            <p class="muted">Listed in priority order. If a method fails, the next one is used as a fallback.</p>
          </div>
          <div id="method-rows"></div>
          <button type="button" class="btn add-method" data-dialog="add-method">${PLUS} Add another method</button>
        </div>
        <footer class="form-actions">
          <p class="form-error" hidden></p>
          <button type="button" class="btn" data-dialog="cancel">Cancel</button>
          <button class="btn primary">${device ? "Save changes" : "Add device"}</button>
        </footer>
      </form>`;
    this.renderMethods();
    this.dialog.showModal();
  }

  /** A new method copies the username of the previous one, the usual case for a fallback. */
  private newMethod(): MethodInput {
    const previous = this.draftMethods.at(-1);
    return {
      protocol: previous?.protocol === "restconf" ? "ssh" : "restconf",
      username: previous?.username ?? "",
      password: null,
      port: null,
      platform: null,
      verify_tls: false,
      timeout: 10,
    };
  }

  private renderMethods(): void {
    const box = this.dialog.querySelector<HTMLElement>("#method-rows")!;
    const count = this.draftMethods.length;
    // Two or more methods sit side by side, in priority order from left to right.
    const multi = count > 1;
    this.dialog.classList.toggle("multi", multi);
    this.dialog.style.setProperty("--methods", String(count));
    const [back, forward] = multi ? ["←", "→"] : ["↑", "↓"];
    const [backLabel, forwardLabel] = multi ? ["Try earlier", "Try later"] : ["Move up", "Move down"];
    box.innerHTML = this.draftMethods
      .map((m, i) => {
        const ssh = m.protocol === "ssh";
        const platforms = PLATFORMS.map((p) => `<option ${p === m.platform ? "selected" : ""}>${p}</option>`).join("");
        const passwordHint = m.id ? 'placeholder="Leave empty to keep the current one"' : "";
        return `
          <fieldset class="method" data-index="${i}">
            <div class="method-head">
              <span class="method-title"><span class="n">${i + 1}</span>${count > 1 ? (i === 0 ? "Tried first" : "Fallback") : "Method"}</span>
              <span class="method-actions">
                <button type="button" class="btn icon" data-dialog="up" aria-label="${backLabel}" title="${backLabel}" ${i === 0 ? "disabled" : ""}>${back}</button>
                <button type="button" class="btn icon" data-dialog="down" aria-label="${forwardLabel}" title="${forwardLabel}" ${i === count - 1 ? "disabled" : ""}>${forward}</button>
                <button type="button" class="btn icon danger" data-dialog="remove" aria-label="Remove method" ${count === 1 ? "disabled" : ""}>${TRASH}</button>
              </span>
            </div>
            <label>Protocol
              <select name="protocol">
                <option value="restconf" ${ssh ? "" : "selected"}>RESTCONF</option>
                <option value="ssh" ${ssh ? "selected" : ""}>SSH (CLI)</option>
              </select>
              <span class="field-note">${ssh ? "CLI commands over SSH, with Netmiko." : "Works with Cisco IOS XE for now."}</span>
            </label>
            <div class="field-row">
              <label>Port <input name="port" type="number" min="1" max="65535" value="${m.port ?? ""}" placeholder="${DEFAULT_PORTS[m.protocol]} (default)"></label>
              <label>Timeout (s) <input name="timeout" type="number" min="1" max="120" step="1" value="${m.timeout}"></label>
            </div>
            <label>Username <input name="username" autocomplete="off" value="${esc(m.username)}"></label>
            <label>Password <input name="password" type="password" autocomplete="new-password" value="${esc(m.password ?? "")}" ${passwordHint}></label>
            ${
              ssh
                ? `<label>Platform <select name="platform"><option value="">Detect automatically</option>${platforms}</select></label>`
                : ""
            }
            ${ssh ? "" : `<label class="check"><input name="verify_tls" type="checkbox" ${m.verify_tls ? "checked" : ""}> Verify the TLS certificate</label>`}
          </fieldset>`;
      })
      .join("");
  }

  /** Copy the method inputs back into the draft before it is re-rendered or saved. */
  private readMethods(): void {
    this.dialog.querySelectorAll<HTMLFieldSetElement>("fieldset.method").forEach((fs) => {
      const m = this.draftMethods[Number(fs.dataset.index)];
      const field = (name: string) => fs.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
      const value = (name: string) => field(name)?.value ?? "";
      m.protocol = value("protocol") as Protocol;
      m.port = value("port") ? Number(value("port")) : null;
      m.username = value("username").trim();
      m.password = value("password") || null;
      m.platform = m.protocol === "ssh" ? value("platform") || null : null;
      m.timeout = Number(value("timeout")) || 10;
      m.verify_tls = m.protocol === "restconf" && Boolean((field("verify_tls") as HTMLInputElement | null)?.checked);
    });
  }

  private showHostError(): boolean {
    const input = this.dialog.querySelector<HTMLInputElement>('input[name="host"]')!;
    const message = hostError(input.value);
    const box = this.dialog.querySelector<HTMLElement>('[data-error="host"]')!;
    box.textContent = message ?? "";
    box.hidden = !message;
    input.classList.toggle("invalid", Boolean(message));
    return !message;
  }

  private onDialogInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    // Only clear the message while typing; it shows again on blur or save.
    if (input.name === "host" && input.classList.contains("invalid")) this.showHostError();
  }

  private onDialogChange(e: Event): void {
    const name = (e.target as HTMLElement).getAttribute("name");
    if (name === "host") this.showHostError();
    if (name === "protocol") {
      this.readMethods();
      this.renderMethods();
    }
  }

  private onDialogClick(e: Event): void {
    const button = (e.target as HTMLElement).closest<HTMLElement>("[data-dialog]");
    if (!button) return;
    const action = button.dataset.dialog;
    if (action === "cancel") {
      this.dialog.close();
      return;
    }
    this.readMethods();
    const index = Number(button.closest<HTMLElement>("fieldset.method")?.dataset.index);
    const methods = this.draftMethods;
    if (action === "add-method") methods.push(this.newMethod());
    if (action === "remove") methods.splice(index, 1);
    if (action === "up") [methods[index - 1], methods[index]] = [methods[index], methods[index - 1]];
    if (action === "down") [methods[index + 1], methods[index]] = [methods[index], methods[index + 1]];
    this.renderMethods();
    if (action === "add-method") {
      // Bring the new method into view and start on its first empty field.
      const box = this.dialog.querySelector<HTMLElement>("#method-rows")!;
      box.scrollLeft = box.scrollWidth;
      const last = this.dialog.querySelector<HTMLElement>(`fieldset[data-index="${methods.length - 1}"]`)!;
      last.querySelector<HTMLInputElement>(last.querySelector<HTMLInputElement>('[name="username"]')!.value ? '[name="password"]' : '[name="username"]')?.focus();
    }
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const id = Number(this.dialog.dataset.id) || null;
    const error = form.querySelector<HTMLElement>(".form-error")!;
    this.readMethods();
    if (!this.showHostError()) return;
    const missing = this.draftMethods.findIndex((m) => !m.username || (!m.id && !m.password));
    if (missing >= 0) {
      error.textContent = `Method ${missing + 1}: enter the username and the password.`;
      error.hidden = false;
      return;
    }
    const host = (form.elements.namedItem("host") as HTMLInputElement).value.trim();
    const enabled = (form.elements.namedItem("enabled") as HTMLInputElement).checked;
    const data = { host, enabled, methods: this.draftMethods };
    try {
      await (id ? inventoryApi.updateDevice(id, data) : inventoryApi.createDevice(data));
      if (id) this.tests.delete(id);
      this.toast(`${host} saved. Polling it now.`);
      this.dialog.close();
      await this.reload();
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    }
  }
}

const PLUS =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const CLOSE =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const TRASH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const SEARCH =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ADD_BUTTON = `<button class="btn add-device" data-action="add-device">${PLUS} Add device</button>`;
