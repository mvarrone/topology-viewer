"""Normalized, vendor neutral models shared by the API and the frontend."""

from datetime import datetime
from typing import Literal

from pydantic import AliasChoices, BaseModel, Field

Role = Literal["router", "switch", "unknown"]
LinkStatus = Literal["up", "down"]
Trigger = Literal["scheduled", "manual"]
RunStatus = Literal["running", "completed", "failed", "skipped"]
ChangeKind = Literal[
    "device_added",
    "device_removed",
    "device_updated",
    "device_renamed",
    "device_unreachable",
    "device_reachable",
    "interface_down",
    "interface_up",
    "interface_updated",
    "link_added",
    "link_removed",
    "link_up",
    "link_down",
    "link_updated",
]


class InterfaceState(BaseModel):
    """State of one interface of a registered device, read on the last poll."""

    name: str  # full canonical name, GigabitEthernet2
    admin: Literal["up", "down"] | None = None  # shutdown or not
    oper: Literal["up", "down"] | None = None  # line protocol
    speed_mbps: int | None = None
    description: str | None = None


class Device(BaseModel):
    id: str
    hostname: str
    role: Role = "unknown"
    layer: str | None = None
    platform: str | None = None
    os: str | None = None
    serial: str | None = None
    mgmt_ip: str | None = None
    # In the inventory (Devices) and polled. Data saved before the rename uses "managed".
    registered: bool = Field(validation_alias=AliasChoices("registered", "managed"))
    reachable: bool | None = None
    # Where the role came from: LLDP capabilities reported by neighbors, or the platform name.
    role_source: Literal["lldp", "platform"] | None = None
    # Protocol of the connection method that answered on the last successful poll.
    polled_via: str | None = None
    # When a registered device stopped answering; cleared when it answers again.
    unreachable_since: datetime | None = None
    # Interfaces of a registered device (empty for unregistered ones and before the first poll).
    interfaces: list[InterfaceState] = Field(default_factory=list)


class Link(BaseModel):
    id: str
    source: str
    source_if: str
    target: str
    target_if: str
    status: LinkStatus = "up"
    confirmed: bool = False
    # Devices that reported this link over LLDP in the last run (one or both ends).
    seen_by: list[str] = Field(default_factory=list)
    first_seen: datetime
    last_seen: datetime
    missed_runs: int = 0


class Topology(BaseModel):
    collected_at: datetime | None = None
    nodes: list[Device] = Field(default_factory=list)
    links: list[Link] = Field(default_factory=list)


class Change(BaseModel):
    kind: ChangeKind
    summary: str
    target: str | None = None
    manual: bool = False  # caused by the user in the inventory, not seen on the network


class TopologyDiff(BaseModel):
    summary: str
    changes: list[Change] = Field(default_factory=list)
    nodes_added: list[Device] = Field(default_factory=list)
    nodes_removed: list[Device] = Field(default_factory=list)
    nodes_updated: list[Device] = Field(default_factory=list)
    links_added: list[Link] = Field(default_factory=list)
    links_removed: list[Link] = Field(default_factory=list)
    links_updated: list[Link] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not self.changes


class DiscoveryRun(BaseModel):
    id: int
    trigger: Trigger
    status: RunStatus
    started_at: datetime
    finished_at: datetime | None = None
    duration_ms: int | None = None
    devices: int | None = None
    links: int | None = None
    errors: dict[str, str] = Field(default_factory=dict)
    diff: TopologyDiff | None = None


class DiscoveryStatus(BaseModel):
    running: DiscoveryRun | None
    last_run: DiscoveryRun | None
    next_scheduled_at: datetime | None
    interval_seconds: int
    source: str


class DeviceDetail(BaseModel):
    device: Device
    links: list[Link]


class NodePosition(BaseModel):
    x: float
    y: float


class ConnectionTest(BaseModel):
    method_id: int | None
    protocol: str
    port: int
    ok: bool
    hostname: str | None = None
    neighbors: int = 0
    error: str | None = None
    duration_ms: int
