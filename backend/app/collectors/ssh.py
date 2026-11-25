"""SSH collector with Netmiko: device facts and LLDP neighbors from CLI commands.

Each platform has a profile with the commands to run. Outputs are parsed with the
TextFSM templates of ntc-templates, so a new vendor usually needs one profile line.
The hostname comes from the CLI prompt (R1# gives R1).
"""

import asyncio
import re
from dataclasses import dataclass

from netmiko import ConnectHandler, NetmikoAuthenticationException, NetmikoTimeoutException, SSHDetect
from ntc_templates.parse import parse_output

from app.collectors.base import Collector, DeviceFacts, DeviceReport, LldpNeighbor
from app.models import InterfaceState
from app.inventory import DeviceTarget
from app.normalize import long_if, os_label


@dataclass(frozen=True)
class SshProfile:
    templates: str  # ntc-templates platform used to parse the outputs
    lldp: str = "show lldp neighbors detail"
    version: str = "show version"
    interfaces: str = "show interfaces"


# Key: Netmiko device_type, as written in devices.yaml or found by autodetect.
PROFILES: dict[str, SshProfile] = {
    "cisco_xe": SshProfile("cisco_ios"),
    "cisco_ios": SshProfile("cisco_ios"),
    "cisco_nxos": SshProfile("cisco_nxos"),
    "cisco_xr": SshProfile("cisco_xr"),
    "arista_eos": SshProfile("arista_eos"),
    "juniper_junos": SshProfile("juniper_junos", lldp="show lldp neighbors"),
}

# LLDP capability codes (IEEE 802.1AB) to the names used by normalize.role_from_capabilities.
_CAPABILITY_CODES = {
    "B": "bridge",
    "R": "router",
    "W": "wlan-access-point",
    "T": "telephone",
    "C": "docsis-cable-device",
    "S": "station-only",
    "P": "repeater",
    "O": "other",
}

_PROMPT_END = re.compile(r"[#>$%]\s*$")


def hostname_from_prompt(prompt: str) -> str | None:
    """R1# -> R1, R1(config)# -> R1, admin@MX1> -> MX1, [admin@host ~]$ -> host."""
    name = _PROMPT_END.sub("", prompt.strip())
    name = name.strip("[]").split("(")[0]
    if "@" in name:
        name = name.split("@", 1)[1]
    name = name.split()[0] if name.split() else ""
    return name or None


def parse_capabilities(value: str | list | None) -> list[str]:
    """'B,R', 'Bridge, Router' or ['B', 'R'] to ['bridge', 'router']."""
    items = value if isinstance(value, list) else re.split(r"[,\s]+", value or "")
    names = []
    for item in items:
        item = item.strip()
        if not item:
            continue
        names.append(_CAPABILITY_CODES.get(item.upper(), item.lower()) if len(item) == 1 else item.lower())
    return names


def _first(row: dict, *keys: str) -> str | None:
    """First non empty value among the keys. TextFSM lists give their first item."""
    for key in keys:
        value = row.get(key)
        if isinstance(value, list):
            value = value[0] if value else None
        if value and str(value).strip():
            return str(value).strip()
    return None


def _interfaces(templates: str, command: str, output: str) -> list[InterfaceState]:
    """Interface states are extra information: a missing template must not fail the poll."""
    try:
        return parse_interfaces(parse_output(platform=templates, command=command, data=output))
    except Exception:  # TextFSM raises its own types when a template is missing or does not match
        return []


def parse_interfaces(rows: list[dict]) -> list[InterfaceState]:
    """Rows of a "show interfaces" template. IOS: link_status is "up", "down" or
    "administratively down"; protocol_status is the line protocol; bandwidth is "1000000 Kbit"."""
    result = []
    for row in rows:
        name = _first(row, "interface")
        if not name:
            continue
        link = (_first(row, "link_status", "admin_state") or "").lower()
        protocol = (_first(row, "protocol_status", "oper_state") or link).lower()
        bandwidth = re.match(r"(\d+)", _first(row, "bandwidth") or "")
        result.append(
            InterfaceState(
                name=long_if(name),
                admin="down" if "administratively" in link or link == "disabled" else "up" if link else None,
                oper="up" if protocol.startswith("up") else "down" if protocol else None,
                speed_mbps=int(bandwidth.group(1)) // 1000 if bandwidth else None,  # Kbit
                description=_first(row, "description"),
            )
        )
    return result


def parse_neighbors(rows: list[dict]) -> list[LldpNeighbor]:
    """Rows from any LLDP template to neighbors. Field names differ between vendors."""
    neighbors = []
    for row in rows:
        local_if = _first(row, "local_interface")
        remote_name = _first(row, "neighbor_name", "neighbor", "system_name")
        remote_if = _first(row, "neighbor_port_id", "neighbor_interface", "port_id")
        if not (local_if and remote_name and remote_if):
            continue
        neighbors.append(
            LldpNeighbor(
                local_if=local_if,
                remote_name=remote_name,
                remote_if=remote_if,
                remote_mgmt_ip=_first(row, "mgmt_address", "management_ip"),
                remote_platform=_first(row, "platform", "neighbor_description", "system_description"),
                capabilities=parse_capabilities(row.get("capabilities")),
            )
        )
    return neighbors


def parse_version(rows: list[dict]) -> DeviceFacts:
    row = rows[0] if rows else {}
    return DeviceFacts(
        platform=_first(row, "hardware", "platform", "model"),
        os_version=_first(row, "version", "os", "image", "junos_version"),
        serial=_first(row, "serial", "serial_number"),
    )


class SshCollector(Collector):
    name = "ssh"

    def __init__(self) -> None:
        self._detected: dict[str, str] = {}  # host -> platform found by autodetect

    @staticmethod
    def _params(target: DeviceTarget, device_type: str) -> dict:
        return {
            "device_type": device_type,
            "host": target.host,
            "port": target.effective_port,
            "username": target.username,
            "password": target.password.get_secret_value(),
            "conn_timeout": target.timeout,
            "auth_timeout": target.timeout,
            "fast_cli": False,
        }

    def _platform(self, target: DeviceTarget) -> str:
        if target.platform:
            return target.platform
        if target.host not in self._detected:
            found = SSHDetect(**self._params(target, "autodetect")).autodetect()
            if not found:
                raise ValueError("could not detect the platform; set it on the connection method")
            self._detected[target.host] = found
        return self._detected[target.host]

    def _collect_sync(self, target: DeviceTarget) -> DeviceReport:
        platform = self._platform(target)
        detected = None if target.platform else platform
        profile = PROFILES.get(platform)
        if not profile:
            return DeviceReport(host=target.host, ok=False, error=f"no SSH profile for platform {platform}")
        with ConnectHandler(**self._params(target, platform)) as conn:
            prompt = conn.find_prompt()
            version = conn.send_command(profile.version)
            lldp = conn.send_command(profile.lldp)
            interfaces = conn.send_command(profile.interfaces)

        name = hostname_from_prompt(prompt)
        if not name:
            return DeviceReport(host=target.host, ok=False, error=f"hostname not found in prompt {prompt!r}")
        facts = parse_version(parse_output(platform=profile.templates, command=profile.version, data=version))
        facts.hostname = name
        facts.os_version = os_label(version, facts.os_version)
        neighbors = parse_neighbors(parse_output(platform=profile.templates, command=profile.lldp, data=lldp))
        return DeviceReport(
            host=target.host,
            ok=True,
            facts=facts,
            neighbors=neighbors,
            interfaces=_interfaces(profile.templates, profile.interfaces, interfaces),
            detected_platform=detected,
        )

    async def collect(self, target: DeviceTarget) -> DeviceReport:
        try:
            return await asyncio.to_thread(self._collect_sync, target)
        except NetmikoAuthenticationException:
            return DeviceReport(host=target.host, ok=False, error="login failed, wrong username or password")
        except NetmikoTimeoutException:
            return DeviceReport(host=target.host, ok=False, unreachable=True, error="connection timed out")
        except Exception as exc:  # Netmiko, Paramiko and TextFSM raise many types; report them on the device.
            first_line = str(exc).strip().splitlines()[0] if str(exc).strip() else ""
            error = f"{type(exc).__name__}: {first_line}" if first_line else type(exc).__name__
            return DeviceReport(host=target.host, ok=False, error=error)
