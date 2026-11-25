"""Probe RESTCONF on lab devices and save the raw responses.

pip install httpx==0.28.1 pyyaml==6.0.3

Usage:
    python scripts/restconf_probe.py --devices backend/devices.yaml

Reads the RESTCONF devices and their credentials from the devices file (same format as the
backend, `defaults` included). Responses are saved under lab/captures/<host>/.
"""

import argparse
import json
import time
from pathlib import Path

import httpx
import yaml


def parse_args():
    """Command line options."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--devices", type=Path, default=Path("backend/devices.yaml"))
    parser.add_argument("--out", type=Path, default=Path("lab/captures"))
    return parser.parse_args()


def load_devices(path):
    """RESTCONF devices from the devices file, with the defaults applied."""
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    defaults = data.get("defaults") or {}
    devices = [defaults | (item or {}) for item in data.get("devices") or []]
    return [d for d in devices if d.get("protocol", "restconf") == "restconf" and d.get("enabled", True)]


def fetch(client, host, port, path):
    """GET one YANG path. Returns status code, parsed JSON or None, and elapsed ms."""
    started = time.perf_counter()
    try:
        response = client.get(f"https://{host}:{port}/restconf/data/{path}")
    except httpx.HTTPError as exc:
        return f"error: {type(exc).__name__}", None, round((time.perf_counter() - started) * 1000)
    elapsed = round((time.perf_counter() - started) * 1000)
    payload = response.json() if response.status_code == 200 and response.content else None
    return response.status_code, payload, elapsed


def save(out_dir, device, name, payload):
    """Write one response as pretty JSON."""
    target = out_dir / device / f"{name}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def lldp_modules(payload):
    """Names of LLDP related YANG modules advertised by the device."""
    if not payload:
        return []
    library = next(iter(payload.values()), {})
    modules = library.get("module", []) if isinstance(library, dict) else []
    return sorted({m.get("name", "") for m in modules if "lldp" in m.get("name", "").lower()})


def print_summary(rows):
    """Table of results per device and path."""
    width = max([len("device")] + [len(r[0]) for r in rows])
    print(f"\n{'device':<{width}}  {'path':<16}  {'status':<22}  ms")
    for device, name, status, ms in rows:
        print(f"{device:<{width}}  {name:<16}  {status!s:<22}  {ms}")


def main():
    paths = {
        "hostname": "Cisco-IOS-XE-native:native/hostname",
        "device_hardware": "Cisco-IOS-XE-device-hardware-oper:device-hardware-data/device-hardware",
        "lldp_entries": "Cisco-IOS-XE-lldp-oper:lldp-entries",
        "openconfig_lldp": "openconfig-lldp:lldp",
        "interfaces_oper": "Cisco-IOS-XE-interfaces-oper:interfaces",
        "yang_library": "ietf-yang-library:modules-state",
    }
    args = parse_args()
    devices = load_devices(args.devices)
    rows = []

    for device in devices:
        host = device["host"]
        with httpx.Client(
            auth=(device["username"], device["password"]),
            headers={"Accept": "application/yang-data+json"},
            verify=device.get("verify_tls", False),
            timeout=device.get("timeout", 15.0),
        ) as client:
            for name, path in paths.items():
                status, payload, ms = fetch(client, host, device.get("port", 443), path)
                if payload is not None:
                    save(args.out, host, name, payload)
                if name == "yang_library":
                    status = f"{status} lldp: {', '.join(lldp_modules(payload)) or 'none'}"
                rows.append((host, name, status, ms))

    print_summary(rows)
    print(f"\nSaved responses under {args.out.resolve()}")


if __name__ == "__main__":
    main()
