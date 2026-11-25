"""Name normalization: interfaces, device ids and canonical link ids."""

import ipaddress
import re

from app.models import Role

# Interface types. Every vendor spelling of a type maps to one canonical name
# (Cisco long form), so links and ids look the same whatever the vendor.
# canonical name: (short form for canvas labels, aliases in lower case)
_IF_TYPES = {
    "GigabitEthernet": ("Gi", ["gi", "gig", "gige", "gigabitethernet", "ge"]),
    "TwoGigabitEthernet": ("Tw", ["tw", "twogigabitethernet"]),
    "FiveGigabitEthernet": ("Fi", ["fi", "fivegigabitethernet"]),
    "TenGigabitEthernet": ("Te", ["te", "ten", "tengig", "tengige", "tengigabitethernet", "xe", "xge", "10ge"]),
    "TwentyFiveGigE": ("Twe", ["twe", "twentyfivegige", "twentyfivegigabitethernet", "25ge"]),
    "FortyGigabitEthernet": ("Fo", ["fo", "fortygige", "fortygigabitethernet", "40ge"]),
    "HundredGigE": ("Hu", ["hu", "hundredgige", "hundredgigabitethernet", "100ge"]),
    "TwoHundredGigE": ("TH", ["th", "twohundredgige", "200ge"]),
    "FourHundredGigE": ("FH", ["fh", "fourhundredgige", "400ge"]),
    "FastEthernet": ("Fa", ["fa", "fastethernet", "fe"]),
    "Ethernet": ("Eth", ["e", "et", "eth", "ethernet"]),
    "AppGigabitEthernet": ("Ap", ["ap", "appgigabitethernet"]),
    "Management": ("Mgmt", ["mgmt", "management", "ma", "mgmteth", "meth", "em", "fxp", "me"]),
    "Port-channel": ("Po", ["po", "port-channel", "portchannel", "ae", "be", "bundle-ether", "eth-trunk"]),
    "Loopback": ("Lo", ["lo", "loopback"]),
    "Vlan": ("Vl", ["vl", "vlan", "vlanif"]),
    "Tunnel": ("Tu", ["tu", "tunnel"]),
    "Serial": ("Se", ["se", "serial"]),
    "BDI": ("BDI", ["bdi"]),
}

_IF_ALIASES = {alias: canonical for canonical, (_, aliases) in _IF_TYPES.items() for alias in aliases}

# Type, then an optional dash (Juniper ge-0/0/1), then the numbering. Huawei types may
# start with digits (10GE1/0/1). The numbering is kept as reported.
_IF_PATTERN = re.compile(r"^(\d*[A-Za-z][A-Za-z-]*?)-?\s*(\d.*)$")


def _split_if(name: str) -> tuple[str | None, str]:
    """Canonical type and numbering, or (None, name) if the type is not known."""
    name = (name or "").strip()
    match = _IF_PATTERN.match(name)
    if not match:
        return None, name
    canonical = _IF_ALIASES.get(match.group(1).lower())
    if not canonical:
        return None, name
    return canonical, match.group(2).replace(" ", "")


def long_if(name: str) -> str:
    """Canonical interface name for any vendor (GigabitEthernet0/1, Ethernet1/1, Port-channel10).

    Unknown names come back unchanged, without surrounding spaces.
    """
    canonical, number = _split_if(name)
    return f"{canonical}{number}" if canonical else number


def short_if(name: str) -> str:
    """Abbreviated interface name used on canvas labels (Gi0/1)."""
    canonical, number = _split_if(name)
    return f"{_IF_TYPES[canonical][0]}{number}" if canonical else number


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def display_name(name: str) -> str:
    """Hostname without domain suffix, keeping the original case."""
    name = (name or "").strip()
    return name if _is_ip(name) else name.split(".")[0]


def device_id(name: str) -> str:
    """Stable device id: hostname without domain, upper case."""
    return display_name(name).upper()


def link_id(a_device: str, a_if: str, b_device: str, b_if: str) -> str:
    """Canonical link id from both endpoints, full interface names, sorted."""
    ends = sorted([f"{a_device}:{long_if(a_if)}", f"{b_device}:{long_if(b_if)}"])
    return "|".join(ends)


def os_label(banner: str, version: str | None) -> str | None:
    """Software family and version from a version banner: "IOS XE 17.18.2", "NX-OS 10.3(2)".
    The same label whatever protocol read it, so a change of protocol is not a change of OS."""
    if not version:
        return None
    if any(tag in banner for tag in ("IOS XE", "IOS-XE", "IOSXE")):
        return f"IOS XE {version}"
    if "NX-OS" in banner:
        return f"NX-OS {version}"
    if "IOS XR" in banner:
        return f"IOS XR {version}"
    if "Cisco IOS Software" in banner:
        return f"IOS {version}"
    return version


def role_from_capabilities(capabilities: list[str]) -> Role:
    """LLDP system capabilities to a role. Bridge wins over router (L3 switches report both)."""
    caps = {c.lower() for c in capabilities}
    if any("bridge" in c for c in caps):
        return "switch"
    if "router" in caps:
        return "router"
    return "unknown"


# Platform names (hardware model or LLDP system description) that tell the role when
# no neighbor reported LLDP capabilities for the device. Checked in this order.
_PLATFORM_ROLES: list[tuple[re.Pattern, Role]] = [
    (re.compile(r"C9[2-6]\d\d|WS-C|IE-\d|Catalyst|IOSvL2|L2 switch|N[3579]K|Nexus|DCS-|Arista|EX\d|QFX|CE\d{4}", re.I),
     "switch"),
    (re.compile(r"C8\d{3}|C8000|CSR|ISR|ASR|NCS|XRv|IOS XR|MX\d|SRX|vMX|NE\d|AR\d", re.I), "router"),
]


def role_from_platform(platform: str | None) -> Role:
    """Best guess of the role from a platform or system description, or unknown."""
    for pattern, role in _PLATFORM_ROLES:
        if platform and pattern.search(platform):
            return role
    return "unknown"
