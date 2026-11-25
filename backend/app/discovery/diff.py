"""Compare two topologies and describe the changes for the UI event log."""

from datetime import datetime

from app.discovery.builder import rename_devices
from app.inventory import PROTOCOL_NAMES
from app.models import Change, Device, InterfaceState, Link, Topology, TopologyDiff
from app.normalize import device_id

# Bookkeeping fields that change every run and are not topology changes.
_LINK_VOLATILE = {"last_seen", "missed_runs", "first_seen"}
# Device fields that are sent to the UI but are not worth an event on their own.
# Interfaces get their own events (_interface_changes), only for interfaces that carry a link.
_DEVICE_QUIET = {"role_source", "interfaces"}


def _speed(mbps: int | None) -> str:
    if not mbps:
        return "unknown speed"
    return f"{mbps / 1000:g} Gbps" if mbps >= 1000 else f"{mbps} Mbps"


def _interface_changes(old: Device, new: Device, linked: set[tuple[str, str]]) -> list[Change]:
    """Admin, oper and speed changes of the interfaces of a device that carry a link."""
    if not old.interfaces:  # no baseline yet (first poll, or data saved before interfaces existed)
        return []
    before = {i.name: i for i in old.interfaces}
    changes = []
    for now in new.interfaces:
        was = before.get(now.name)
        if not was or (new.id, now.name) not in linked:
            continue
        where = f"{_name(new)} {now.name}"
        if was.admin != now.admin and now.admin:
            if now.admin == "down":
                changes.append(Change(kind="interface_down", summary=f"{where} was shut down (administratively down)", target=new.id))
            else:
                state = "operationally up" if now.oper == "up" else "but still operationally down"
                changes.append(Change(kind="interface_up", summary=f"{where} was enabled (administratively up), {state}", target=new.id))
        elif was.oper != now.oper and now.oper:
            if now.oper == "down":
                changes.append(Change(kind="interface_down", summary=f"{where} is operationally down", target=new.id))
            else:
                changes.append(Change(kind="interface_up", summary=f"{where} is operationally up again", target=new.id))
        if was.speed_mbps and now.speed_mbps and was.speed_mbps != now.speed_mbps:
            changes.append(
                Change(
                    kind="interface_updated",
                    summary=f"{where} speed changed from {_speed(was.speed_mbps)} to {_speed(now.speed_mbps)}",
                    target=new.id,
                )
            )
    return changes


def _interface(topology: Topology, dev_id: str, name: str) -> InterfaceState | None:
    """Current state of an interface. None when unknown, including a device that does not
    answer: its stored state is from an earlier poll."""
    dev = next((d for d in topology.nodes if d.id == dev_id), None)
    if not dev or dev.reachable is False:
        return None
    return next((i for i in dev.interfaces if i.name == name), None)


def _down_reason(link: Link, topology: Topology) -> str:
    """Why a link is down: an interface shut down or without line protocol at one end, when known."""
    for dev_id, name in ((link.source, link.source_if), (link.target, link.target_if)):
        state = _interface(topology, dev_id, name)
        if state and state.admin == "down":
            return f", {dev_id} {name} is administratively down"
    for dev_id, name in ((link.source, link.source_if), (link.target, link.target_if)):
        state = _interface(topology, dev_id, name)
        if state and state.oper == "down":
            return f", {dev_id} {name} is operationally down"
    for dev_id in (link.source, link.target):
        dev = next((d for d in topology.nodes if d.id == dev_id), None)
        if dev and dev.reachable is False:
            return f", {dev_id} is unreachable"
    return ", LLDP neighbor missing"


def _link_text(link: Link) -> str:
    return f"The link between {link.source} {link.source_if} and {link.target} {link.target_if}"


def _one_end(link: Link) -> str:
    """ "only by R1" when one end reported the link, empty when that is not known."""
    return f"only by {link.seen_by[0]}" if len(link.seen_by) == 1 else "by one end only"


def _name(dev: Device) -> str:
    """Hostname with the management address, when known: R1 (192.168.1.50)."""
    return f"{dev.hostname} ({dev.mgmt_ip})" if dev.mgmt_ip else dev.hostname


def _clock(moment: datetime) -> str:
    """Local time of the machine running the backend, as HH:MM:SS."""
    return moment.astimezone().strftime("%H:%M:%S")


def _duration(seconds: float) -> str:
    """2 h 5 min 3 s, 4 min 10 s, 45 s."""
    total = max(round(seconds), 0)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    parts = [f"{hours} h" if hours else "", f"{minutes} min" if minutes else "", f"{secs} s" if secs or not total else ""]
    return " ".join(p for p in parts if p)


def _device_change(old: Device, new: Device, now: datetime | None) -> Change:
    if old.reachable and new.reachable is False:
        return Change(kind="device_unreachable", summary=f"{_name(new)} is unreachable", target=new.id)
    if old.reachable is False and new.reachable:
        summary = f"{_name(new)} is reachable again"
        if old.unreachable_since and now:
            summary += (
                f" after {_duration((now - old.unreachable_since).total_seconds())}"
                f" (unreachable from {_clock(old.unreachable_since)} to {_clock(now)})"
            )
        return Change(kind="device_reachable", summary=summary, target=new.id)
    fields = [f for f in Device.model_fields if getattr(old, f) != getattr(new, f) and f not in _DEVICE_QUIET]
    if "polled_via" in fields and new.polled_via:
        via = PROTOCOL_NAMES.get(new.polled_via, new.polled_via)
        before = PROTOCOL_NAMES.get(old.polled_via or "", old.polled_via)
        summary = f"{_name(new)} is now polled over {via}" + (f", previously over {before}" if before else "")
        others = [f for f in fields if f != "polled_via"]
        if others:
            summary += f"; also changed: {', '.join(others)}"
        return Change(kind="device_updated", summary=summary, target=new.id)
    return Change(kind="device_updated", summary=f"{_name(new)} changed: {', '.join(fields)}", target=new.id)


def _seen_by(dev_id: str, topology: Topology) -> str:
    """Registered devices that report dev_id as LLDP neighbor, as "R1's" or "R1's and R3's"."""
    names = {d.id: d.hostname for d in topology.nodes if d.registered}
    peers: set[str] = set()
    for link in topology.links:
        if link.source == dev_id and link.target in names:
            peers.add(names[link.target])
        elif link.target == dev_id and link.source in names:
            peers.add(names[link.source])
    owned = [f"{name}'s" for name in sorted(peers)]
    if len(owned) <= 1:
        return "".join(owned)
    return ", ".join(owned[:-1]) + f" and {owned[-1]}"


def _add_renames(diff: TopologyDiff, original: Topology, new: Topology, renames: dict[str, str]) -> None:
    """One event per renamed device, and the old ids as removed / new ids as added in the lists."""
    if not renames:
        return
    new_nodes = {d.id: d for d in new.nodes}
    new_links = {link.id: link for link in new.links}
    listed_nodes = {d.id for d in diff.nodes_added + diff.nodes_updated}
    listed_links = {link.id for link in diff.links_added + diff.links_updated}
    events = []
    for old_dev in original.nodes:
        if old_dev.id not in renames:
            continue
        new_id = device_id(renames[old_dev.id])
        events.append(
            Change(kind="device_renamed", summary=f"{_name(old_dev)} renamed to {renames[old_dev.id]}", target=new_id)
        )
        diff.nodes_removed.append(old_dev)
        if new_id in new_nodes and new_id not in listed_nodes:
            diff.nodes_added.append(new_nodes[new_id])
    moved = rename_devices(original, renames)
    moved_ids = {link.id for link in moved.links}
    for link in original.links:
        if link.id not in moved_ids and link.id not in new_links:
            diff.links_removed.append(link)
    for lid in moved_ids - {link.id for link in original.links}:
        if lid in new_links and lid not in listed_links:
            diff.links_added.append(new_links[lid])
    diff.changes[:0] = events


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


def diff_topologies(
    old: Topology,
    new: Topology,
    added_hosts: frozenset[str] = frozenset(),
    removed_hosts: frozenset[str] = frozenset(),
    renames: dict[str, str] | None = None,
) -> TopologyDiff:
    """added_hosts and removed_hosts: management addresses the user added to or removed from the
    inventory since the last run, so those changes say they were made by hand.

    renames: old device id -> new hostname. Events compare against the old topology with the
    renames applied, so a rename is one event; the node and link lists still carry the old ids
    as removed and the new ones as added, so a client can apply the diff to what it has.
    """
    renames = renames or {}
    original = old
    old = rename_devices(old, renames)
    old_nodes = {d.id: d for d in old.nodes}
    new_nodes = {d.id: d for d in new.nodes}
    old_links = {link.id: link for link in old.links}
    new_links = {link.id: link for link in new.links}

    diff = TopologyDiff(summary="")
    # Interfaces that carry a link, before or now: only their changes are events.
    linked = {
        (dev, name)
        for link in [*old.links, *new.links]
        for dev, name in ((link.source, link.source_if), (link.target, link.target_if))
    }

    for dev_id, dev in new_nodes.items():
        if dev_id not in old_nodes:
            diff.nodes_added.append(dev)
            manual = dev.registered and dev.mgmt_ip in added_hosts
            if manual:
                summary = f"{_name(dev)} added manually by user"
            else:
                seen_by = _seen_by(dev_id, new)
                if dev.registered:
                    summary = f"{_name(dev)} discovered"
                else:
                    summary = f"{_name(dev)} discovered as {seen_by + ' ' if seen_by else ''}LLDP neighbor"
            diff.changes.append(Change(kind="device_added", summary=summary, target=dev_id, manual=manual))
        elif old_nodes[dev_id] != dev:
            diff.nodes_updated.append(dev)
            old_dev = old_nodes[dev_id]
            diff.changes.extend(_interface_changes(old_dev, dev, linked))
            if old_dev.model_dump(exclude=_DEVICE_QUIET) == dev.model_dump(exclude=_DEVICE_QUIET):
                continue
            if old_dev.registered and not dev.registered:
                manual = old_dev.mgmt_ip in removed_hosts
                how = " removed manually by user" if manual else " is no longer polled"
                seen = any(link.status == "up" and dev_id in (link.source, link.target) for link in new.links)
                where = "still seen as LLDP neighbor" if seen else "kept on the canvas while its links are down"
                summary = f"{_name(dev)}{how}, {where}"
                kind = "device_removed" if manual else "device_updated"
                diff.changes.append(Change(kind=kind, summary=summary, target=dev_id, manual=manual))
            elif not old_dev.registered and dev.registered:
                manual = dev.mgmt_ip in added_hosts
                how = " added manually by user" if manual else ""
                summary = f"{_name(dev)}{how}, now polled" if manual else f"{_name(dev)} is now polled"
                summary += " (previously, it was an unregistered device)"
                kind = "device_added" if manual else "device_updated"
                diff.changes.append(Change(kind=kind, summary=summary, target=dev_id, manual=manual))
            else:
                diff.changes.append(_device_change(old_nodes[dev_id], dev, new.collected_at))
    for dev_id, dev in old_nodes.items():
        if dev_id not in new_nodes:
            diff.nodes_removed.append(dev)
            manual = dev.registered and dev.mgmt_ip in removed_hosts
            how = " manually by user" if manual else ""
            diff.changes.append(
                Change(
                    kind="device_removed", summary=f"{_name(dev)} removed{how}, no LLDP neighbors left", manual=manual
                )
            )

    for lid, link in new_links.items():
        old_link = old_links.get(lid)
        if old_link is None:
            diff.links_added.append(link)
            diff.changes.append(Change(kind="link_added", summary=f"New link found between {link.source} {link.source_if} and {link.target} {link.target_if}", target=lid))
            continue
        if old_link.model_dump(exclude=_LINK_VOLATILE) == link.model_dump(exclude=_LINK_VOLATILE):
            continue
        diff.links_updated.append(link)
        if old_link.status != link.status:
            kind = "link_up" if link.status == "up" else "link_down"
            if link.status == "down":
                reason = _down_reason(link, new)
            else:
                reason = "" if link.confirmed else f", reported {_one_end(link)}"
            diff.changes.append(Change(kind=kind, summary=f"{_link_text(link)} is {link.status}{reason}", target=lid))
        else:
            state = "was confirmed by both ends" if link.confirmed else f"is now reported {_one_end(link)}"
            diff.changes.append(Change(kind="link_updated", summary=f"{_link_text(link)} {state}", target=lid))
    for lid, link in old_links.items():
        if lid not in new_links:
            diff.links_removed.append(link)
            diff.changes.append(Change(kind="link_removed", summary=f"{_link_text(link)} was removed"))

    _add_renames(diff, original, new, renames)

    if not old_nodes and not new_nodes:
        diff.summary = "No devices"
    elif not old_nodes and not old_links:
        diff.summary = f"Initial discovery: {_plural(len(new_nodes), 'device')}, {_plural(len(new_links), 'link')}"
    elif diff.is_empty:
        diff.summary = "No changes"
    else:
        counts: dict[str, int] = {}
        for change in diff.changes:
            counts[change.kind] = counts.get(change.kind, 0) + 1
        diff.summary = ", ".join(f"{_plural(n, kind.split('_')[0])} {kind.split('_')[1]}" for kind, n in counts.items())
    return diff
