"""Devices to poll. Only connection data: hostname, role and platform details are discovered.

A device has one or more connection methods in priority order (for example RESTCONF, then SSH).
Each method points to a named credential profile. InventoryStore is what the discovery service
uses; app/store.py implements it on SQLite.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, SecretStr

Protocol = Literal["restconf", "ssh"]

DEFAULT_PORTS: dict[str, int] = {"restconf": 443, "ssh": 22}
PROTOCOL_NAMES: dict[str, str] = {"restconf": "RESTCONF", "ssh": "SSH (CLI)"}


class DeviceTarget(BaseModel):
    """One way to reach one device: what a collector needs to poll it."""

    host: str
    protocol: Protocol = "restconf"
    username: str
    password: SecretStr
    port: int | None = None
    # Netmiko style platform name (cisco_xe, cisco_nxos, arista_eos, juniper_junos...).
    # Optional: SSH detects it, RESTCONF supports cisco_xe only for now.
    platform: str | None = None
    verify_tls: bool = False
    timeout: float = 10.0
    method_id: int | None = None

    @property
    def effective_port(self) -> int:
        return self.port or DEFAULT_PORTS[self.protocol]

    @property
    def label(self) -> str:
        """For messages: "RESTCONF port 443", "SSH (CLI) port 22"."""
        return f"{PROTOCOL_NAMES.get(self.protocol, self.protocol)} port {self.effective_port}"


class DeviceEntry(BaseModel):
    """A device to poll with its connection methods, in priority order."""

    id: int
    host: str
    methods: list[DeviceTarget]
    last_method_id: int | None = None

    def ordered_methods(self) -> list[DeviceTarget]:
        """Methods in the priority order of the Devices page. The first one that works is used,
        so a higher method that works again (for example after fixing its password) takes over."""
        return list(self.methods)


class InventoryError(Exception):
    pass


class InventoryStore(ABC):
    @abstractmethod
    def load(self) -> list[DeviceEntry]:
        """Enabled devices to poll. Raises InventoryError when the source is invalid."""

    def record_result(
        self,
        device_id: int,
        polled_at: datetime,
        method_id: int | None,
        hostname: str | None,
        error: str | None,
        detected_platform: str | None = None,
    ) -> None:
        """Remember the result of polling a device. Optional for a store."""
