"""Collector interface. Each protocol (RESTCONF, SSH, later NETCONF or SNMP) is one collector."""

from abc import ABC, abstractmethod

from pydantic import BaseModel, Field

from app.inventory import DeviceTarget
from app.models import InterfaceState


class DeviceFacts(BaseModel):
    hostname: str | None = None
    platform: str | None = None
    os_version: str | None = None
    serial: str | None = None


class LldpNeighbor(BaseModel):
    local_if: str
    remote_name: str
    remote_if: str
    remote_mgmt_ip: str | None = None
    remote_platform: str | None = None
    capabilities: list[str] = Field(default_factory=list)


class DeviceReport(BaseModel):
    """Raw result of polling one device, before normalization into the topology."""

    host: str
    ok: bool
    facts: DeviceFacts | None = None
    neighbors: list[LldpNeighbor] = Field(default_factory=list)
    interfaces: list[InterfaceState] = Field(default_factory=list)
    error: str | None = None
    # The device did not answer at all (timeout, refused, no route), as opposed to answering
    # with an error such as a failed login.
    unreachable: bool = False
    detected_platform: str | None = None  # set when the collector found the platform itself
    polled_via: str | None = None  # protocol that answered, set by the discovery service


class Collector(ABC):
    name: str = "collector"

    async def before_run(self) -> None:
        """Hook called once at the start of each discovery run."""

    @abstractmethod
    async def collect(self, target: DeviceTarget) -> DeviceReport:
        """Poll one device. Must not raise: failures go into DeviceReport.error."""

    async def close(self) -> None:
        """Release resources when the app stops."""
