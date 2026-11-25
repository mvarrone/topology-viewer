"""Turn device reports into a topology, reconciled against the previous one.

Rules:
- Both LLDP reports of a link merge into one link; confirmed when both ends reported it.
- A known link that a successfully polled endpoint no longer reports goes down, and is
  removed after `retention_runs` consecutive misses.
- If no endpoint of a known link was polled successfully, the link is kept as it was:
  an unreachable device is not evidence that its links are gone.
- Devices seen only as LLDP neighbors (registered=False) live as long as one of their links does.
- A device from the devices file appears only after it answers once. If it stops answering
  later, it stays on the canvas as unreachable.
- Names come from the device (hostname over RESTCONF, CLI prompt over SSH). Roles come from the
  LLDP capabilities that neighbors report, then from the platform name.
"""

from collections import defaultdict
from datetime import datetime

from app.collectors.base import DeviceReport
from app.models import Device, Link, Role, Topology
from app.normalize import device_id, display_name, link_id, long_if, role_from_capabilities, role_from_platform


def _registered_device(
    host: str, report: DeviceReport | None, previous: Device | None, now: datetime
) -> Device | None:
    if report and report.ok and report.facts and report.facts.hostname:
        facts = report.facts
        role = role_from_platform(facts.platform)
        return Device(
            id=device_id(facts.hostname),
            hostname=display_name(facts.hostname),
            role=role,
            role_source="platform" if role != "unknown" else None,
            polled_via=report.polled_via,
            platform=facts.platform,
            os=facts.os_version,
            serial=facts.serial,
            mgmt_ip=host,
            registered=True,
            reachable=True,
            interfaces=report.interfaces,
        )
    if previous:
        since = previous.unreachable_since or now
        return previous.model_copy(update={"registered": True, "reachable": False, "unreachable_since": since})
    return None


def find_renames(previous: Topology, hosts: list[str], reports: dict[str, DeviceReport]) -> dict[str, str]:
    """Registered devices that answered from the same management address with another hostname.

    Returns old device id -> new hostname. A new name that belongs to another registered device is
    not a rename, unless that device is renamed away in the same run (two devices swapping names).
    """
    prev_by_ip = {d.mgmt_ip: d for d in previous.nodes if d.registered and d.mgmt_ip}
    renames: dict[str, str] = {}
    for host in hosts:
        old, report = prev_by_ip.get(host), reports.get(host)
        if not (old and report and report.ok and report.facts and report.facts.hostname):
            continue
        if device_id(report.facts.hostname) != old.id:
            renames[old.id] = display_name(report.facts.hostname)
    taken = {d.id for d in previous.nodes if d.registered}
    return {old: name for old, name in renames.items() if device_id(name) not in taken or device_id(name) in renames}


def rename_devices(topology: Topology, renames: dict[str, str]) -> Topology:
    """The topology with renamed devices under their new id, links included, so a rename keeps
    the history of the device and its links instead of looking like one device gone and a new one."""
    if not renames:
        return topology
    ids = {old: device_id(name) for old, name in renames.items()}
    nodes = [
        d.model_copy(update={"id": ids[d.id], "hostname": renames[d.id]}) if d.id in ids else d
        for d in topology.nodes
        # A device already known under the new name (for example as a neighbor) is replaced.
        if d.id in ids or d.id not in ids.values()
    ]
    links: dict[str, Link] = {}
    for link in topology.links:
        ends = sorted([(ids.get(link.source, link.source), link.source_if), (ids.get(link.target, link.target), link.target_if)])
        (source, source_if), (target, target_if) = ends
        lid = link_id(source, source_if, target, target_if)
        moved = link.model_copy(
            update={
                "id": lid,
                "source": source,
                "source_if": source_if,
                "target": target,
                "target_if": target_if,
                "seen_by": sorted(ids.get(end, end) for end in link.seen_by),
            }
        )
        # Two links can end up with the same id: the old copy of a renamed device's link (down)
        # and the current one. Keep the current state and the earliest first_seen.
        if lid in links:
            kept, other = (moved, links[lid]) if moved.status == "up" else (links[lid], moved)
            moved = kept.model_copy(update={"first_seen": min(kept.first_seen, other.first_seen)})
        links[lid] = moved
    return Topology(
        collected_at=topology.collected_at,
        nodes=sorted(nodes, key=lambda d: d.id),
        links=sorted(links.values(), key=lambda link: link.id),
    )


def _role_source(lldp_role: Role, platform: str | None) -> str | None:
    if lldp_role != "unknown":
        return "lldp"
    return "platform" if role_from_platform(platform) != "unknown" else None


def build_topology(
    previous: Topology,
    hosts: list[str],
    reports: dict[str, DeviceReport],
    now: datetime,
    retention_runs: int,
) -> Topology:
    prev_nodes = {d.id: d for d in previous.nodes}
    prev_by_ip = {d.mgmt_ip: d for d in previous.nodes if d.registered and d.mgmt_ip}
    prev_links = {link.id: link for link in previous.links}

    nodes: dict[str, Device] = {}
    polled: set[str] = set()
    observed_roles: dict[str, Role] = {}
    local_ids: dict[str, str] = {}  # host -> device id

    for host in hosts:
        report = reports.get(host)
        device = _registered_device(host, report, prev_by_ip.get(host), now)
        if device is None:
            continue
        nodes[device.id] = device
        if device.reachable:
            polled.add(device.id)
            local_ids[host] = device.id

    links: dict[str, Link] = {}
    sides: dict[str, set[str]] = defaultdict(set)

    for host in hosts:
        report = reports.get(host)
        local = local_ids.get(host)
        if not (report and local):
            continue
        # A device keeps LLDP entries on an interface it shut down until they age out (up to
        # 120 s); a neighbor on an interface that is down is not a working link.
        down_ifs = {i.name for i in nodes[local].interfaces if i.admin == "down" or i.oper == "down"}
        for nb in report.neighbors:
            if long_if(nb.local_if) in down_ifs:
                continue
            remote = device_id(nb.remote_name)
            # A neighbor whose management address is a registered device is that device, even if
            # LLDP still carries an old hostname (for example right after a rename).
            if nb.remote_mgmt_ip in local_ids:
                remote = local_ids[nb.remote_mgmt_ip]
            if not remote or remote == local:
                continue
            role = role_from_capabilities(nb.capabilities)
            if role != "unknown":
                observed_roles.setdefault(remote, role)

            if remote not in nodes:
                old = prev_nodes.get(remote)
                if old:
                    # Known device, now only seen as a neighbor (for example removed from the inventory).
                    update = {"registered": False, "reachable": None, "polled_via": None, "interfaces": []}
                    if nb.remote_mgmt_ip:
                        update["mgmt_ip"] = nb.remote_mgmt_ip
                    nodes[remote] = old.model_copy(update=update)
                else:
                    nodes[remote] = Device(
                        id=remote,
                        hostname=display_name(nb.remote_name),
                        role=role if role != "unknown" else role_from_platform(nb.remote_platform),
                        role_source=_role_source(role, nb.remote_platform),
                        platform=nb.remote_platform,
                        mgmt_ip=nb.remote_mgmt_ip,
                        registered=False,
                    )

            local_if, remote_if = long_if(nb.local_if), long_if(nb.remote_if)
            lid = link_id(local, local_if, remote, remote_if)
            sides[lid].add(local)
            if lid in links:
                continue
            (source, source_if), (target, target_if) = sorted([(local, local_if), (remote, remote_if)])
            old_link = prev_links.get(lid)
            links[lid] = Link(
                id=lid,
                source=source,
                source_if=source_if,
                target=target,
                target_if=target_if,
                status="up",
                first_seen=old_link.first_seen if old_link else now,
                last_seen=now,
            )

    for lid, link in links.items():
        link.confirmed = {link.source, link.target} <= sides[lid]
        link.seen_by = sorted(sides[lid])

    for lid, old in prev_links.items():
        if lid in links:
            continue
        if old.source not in polled and old.target not in polled:
            # Nobody reported on this link in this run. Keep it only while one end is still in the
            # inventory (unreachable for now); a link of devices removed from the inventory goes away.
            if any(end in nodes and nodes[end].registered for end in (old.source, old.target)):
                links[lid] = old
            continue
        missed = old.missed_runs + 1
        if missed > retention_runs:
            continue
        links[lid] = old.model_copy(update={"status": "down", "missed_runs": missed, "confirmed": False, "seen_by": []})

    for link in links.values():
        for end in (link.source, link.target):
            if end not in nodes and end in prev_nodes:
                prev = prev_nodes[end]
                if prev.registered:  # no longer in the inventory, only kept as the far end of a link
                    prev = prev.model_copy(
                        update={"registered": False, "reachable": None, "polled_via": None, "interfaces": []}
                    )
                nodes[end] = prev

    # What neighbors report over LLDP beats the guess from the platform name.
    for dev_id, role in observed_roles.items():
        if dev_id in nodes:
            nodes[dev_id].role = role
            nodes[dev_id].role_source = "lldp"

    return Topology(
        collected_at=now,
        nodes=sorted(nodes.values(), key=lambda d: d.id),
        links=sorted(links.values(), key=lambda link: link.id),
    )
