"""RESTCONF collector: device facts and LLDP neighbors. Cisco IOS XE (cisco_xe) for now."""

import asyncio
import re
from typing import Any

import httpx

from app.collectors.base import Collector, DeviceFacts, DeviceReport, LldpNeighbor
from app.models import InterfaceState
from app.inventory import DeviceTarget
from app.normalize import long_if, os_label

# YANG paths, relative to /restconf/data. To be confirmed per IOS XE release in the lab.
PATH_HOSTNAME = "Cisco-IOS-XE-native:native/hostname"
PATH_HARDWARE = "Cisco-IOS-XE-device-hardware-oper:device-hardware-data/device-hardware"
PATH_LLDP = "Cisco-IOS-XE-lldp-oper:lldp-entries"
PATH_INTERFACES = "Cisco-IOS-XE-interfaces-oper:interfaces"
# Only the leaves we use: without it the answer carries every counter of every interface.
INTERFACE_FIELDS = "?fields=interface(name;admin-status;oper-status;speed;description)"

ACCEPT = "application/yang-data+json"

# Platforms with known YANG paths. Other vendors get their own paths and parsers here.
SUPPORTED_PLATFORMS = {"cisco_xe"}


def _find(payload: Any, suffix: str) -> Any:
    """Value of the first key equal to suffix or ending in ':suffix' (module prefix optional)."""
    if not isinstance(payload, dict):
        return None
    for key, value in payload.items():
        if key == suffix or key.endswith(f":{suffix}"):
            return value
    return None


def parse_hostname(payload: Any) -> str | None:
    value = _find(payload, "hostname")
    return str(value) if value else None


def parse_hardware(payload: Any) -> DeviceFacts:
    """Platform, serial and software version from device-hardware-oper."""
    hardware = _find(payload, "device-hardware")
    if hardware is None:
        hardware = (_find(payload, "device-hardware-data") or {}).get("device-hardware", {})
    inventory = hardware.get("device-inventory", []) or []
    chassis = next(
        (item for item in inventory if item.get("hw-type") == "hw-type-chassis"),
        inventory[0] if inventory else {},
    )
    software = (hardware.get("device-system-data") or {}).get("software-version", "") or ""
    return DeviceFacts(
        platform=chassis.get("part-number") or None,
        serial=chassis.get("serial-number") or None,
        os_version=_os_version(software),
    )


def _os_version(software: str) -> str | None:
    match = re.search(r"Version\s+([\w.()]+)", software)
    if not match:
        return software or None
    return os_label(software, match.group(1)) if "Cisco" in software or "IOS" in software else match.group(1)


def _capabilities(value: Any) -> list[str]:
    """YANG presence leaves come as {"router": [null]}; lists as ["router"]."""
    if isinstance(value, dict):
        return [key for key in value]
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        return [value]
    return []


def _mgmt_addr(neighbor: dict) -> str | None:
    """First management address of a neighbor. IOS XE 17 sends a mgmt-addrs list, older
    releases a single mgmt-addr leaf."""
    for item in neighbor.get("mgmt-addrs", []) or []:
        if isinstance(item, dict) and item.get("mgmt-addr"):
            return item["mgmt-addr"]
    return neighbor.get("mgmt-addr") or None


def parse_lldp(payload: Any) -> list[LldpNeighbor]:
    """Neighbors from Cisco-IOS-XE-lldp-oper:lldp-entries."""
    root = _find(payload, "lldp-entries") or {}
    # lldp-entry uses short names (Gi2, R2.lab.local as device-id); lldp-intf-details uses
    # long interface names and keeps the neighbor name in system-name.
    details: dict[tuple[str, str], dict] = {}
    for intf in root.get("lldp-intf-details", []) or []:
        for neighbor in intf.get("lldp-neighbor-details", []) or []:
            key = (long_if(intf.get("if-name", "")), neighbor.get("system-name") or neighbor.get("device-id") or "")
            details[key] = neighbor

    neighbors = []
    for entry in root.get("lldp-entry", []) or []:
        local_if = entry.get("local-interface")
        remote_name = entry.get("device-id")
        remote_if = entry.get("connecting-interface") or entry.get("port-id")
        if not (local_if and remote_name and remote_if):
            continue
        extra = details.get((long_if(local_if), remote_name), {})
        neighbors.append(
            LldpNeighbor(
                local_if=local_if,
                remote_name=remote_name,
                remote_if=remote_if,
                remote_mgmt_ip=_mgmt_addr(extra),
                # system-desc is the full multi-line software banner, not a model name.
                remote_platform=None,
                capabilities=_capabilities(entry.get("capabilities") or extra.get("capabilities")),
            )
        )
    return neighbors


def _speed_mbps(value: Any) -> int | None:
    """Speed in bits per second (a number or a string, as uint64 leaves come in JSON) to Mb/s."""
    try:
        bps = int(value)
    except (TypeError, ValueError):
        return None
    return bps // 1_000_000 if bps > 0 else None


def parse_interfaces(payload: Any) -> list[InterfaceState]:
    """Interfaces from Cisco-IOS-XE-interfaces-oper:interfaces."""
    root = _find(payload, "interfaces") or payload or {}
    items = root.get("interface", []) if isinstance(root, dict) else []
    result = []
    for item in items or []:
        name = item.get("name")
        if not name:
            continue
        admin = item.get("admin-status") or ""
        oper = item.get("oper-status") or ""
        result.append(
            InterfaceState(
                name=long_if(name),
                admin="up" if admin.endswith("-up") else "down" if admin.endswith("-down") else None,
                # if-oper-state-ready is up; no-pass, lower-layer-down, not-present and the rest are down.
                oper="up" if oper.endswith("-ready") else "down" if oper else None,
                speed_mbps=_speed_mbps(item.get("speed")),
                description=item.get("description") or None,
            )
        )
    return result


class RestconfError(Exception):
    pass


class RestconfCollector(Collector):
    name = "restconf"

    @staticmethod
    def _client(target: DeviceTarget) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=f"https://{target.host}:{target.effective_port}/restconf/data/",
            auth=(target.username, target.password.get_secret_value()),
            headers={"Accept": ACCEPT},
            verify=target.verify_tls,
            timeout=target.timeout,
        )

    @staticmethod
    async def _get(client: httpx.AsyncClient, path: str) -> Any:
        """GET a YANG path. 404 and 204 mean no data and return None."""
        # The leading slash keeps the module prefix: without it httpx reads "Cisco-IOS-XE-native:" as a URL scheme.
        response = await client.get(f"/{path}")
        if response.status_code in (204, 404):
            return None
        if response.status_code == 401:
            raise RestconfError("login failed, wrong username or password (HTTP 401)")
        response.raise_for_status()
        return response.json() if response.content else None

    async def _interfaces(self, client: httpx.AsyncClient) -> Any:
        """Interface states are extra information: a release without the model or without the
        fields filter must not fail the whole poll."""
        try:
            return await self._get(client, PATH_INTERFACES + INTERFACE_FIELDS)
        except httpx.HTTPStatusError:
            try:
                return await self._get(client, PATH_INTERFACES)
            except httpx.HTTPStatusError:
                return None

    async def collect(self, target: DeviceTarget) -> DeviceReport:
        platform = target.platform or "cisco_xe"
        if platform not in SUPPORTED_PLATFORMS:
            return DeviceReport(host=target.host, ok=False, error=f"RESTCONF does not support platform {platform} yet")
        try:
            async with self._client(target) as client:
                hostname, hardware, lldp, interfaces = await asyncio.gather(
                    self._get(client, PATH_HOSTNAME),
                    self._get(client, PATH_HARDWARE),
                    self._get(client, PATH_LLDP),
                    self._interfaces(client),
                )
        except httpx.TimeoutException:
            return DeviceReport(host=target.host, ok=False, unreachable=True, error="connection timed out")
        except httpx.ConnectError:
            return DeviceReport(host=target.host, ok=False, unreachable=True, error="connection refused or no route")
        except httpx.HTTPStatusError as exc:
            return DeviceReport(host=target.host, ok=False, error=f"HTTP error {exc.response.status_code}")
        except RestconfError as exc:
            return DeviceReport(host=target.host, ok=False, error=str(exc))
        except (httpx.HTTPError, ValueError) as exc:
            detail = str(exc).strip()
            error = f"{type(exc).__name__}: {detail}" if detail else type(exc).__name__
            return DeviceReport(host=target.host, ok=False, error=error)

        name = parse_hostname(hostname)
        if not name:
            return DeviceReport(host=target.host, ok=False, error="hostname not found in the RESTCONF response")
        facts = parse_hardware(hardware) if hardware else DeviceFacts()
        facts.hostname = name
        return DeviceReport(
            host=target.host,
            ok=True,
            facts=facts,
            neighbors=parse_lldp(lldp) if lldp else [],
            interfaces=parse_interfaces(interfaces) if interfaces else [],
        )
