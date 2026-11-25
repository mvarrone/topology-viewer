"""Discovery service: runs, scheduler, run history and live updates for WebSocket clients."""

import asyncio
import contextlib
import logging
import time
from collections import deque
from datetime import UTC, datetime, timedelta

from app.collectors.base import Collector, DeviceReport
from app.config import Settings
from app.discovery.builder import build_topology, find_renames, rename_devices
from app.discovery.diff import diff_topologies
from app.history import HistoryStore
from app.normalize import device_id
from app.positions import prune_positions
from app.inventory import DeviceEntry, DeviceTarget, InventoryStore
from app.models import ConnectionTest, DiscoveryRun, DiscoveryStatus, Topology, Trigger

log = logging.getLogger(__name__)

RUN_HISTORY = 200
SUBSCRIBER_QUEUE = 100


def _explain_unreachable(run: DiscoveryRun, topology: Topology) -> None:
    """Put the reason in the "is unreachable" event, so the run shows one line instead of two."""
    if not run.diff:
        return
    ips = {d.id: d.mgmt_ip for d in topology.nodes}
    for change in run.diff.changes:
        if change.kind != "device_unreachable" or not change.summary.endswith(" is unreachable"):
            continue
        error = run.errors.get(ips.get(change.target or "") or "")
        if not error:
            continue
        name = change.summary.removesuffix(" is unreachable")
        # A device that answers but refuses the login is not unreachable.
        change.summary = f"{name} is {error}" if error.startswith("unreachable") else f"{name} could not be polled: {error}"


def utcnow() -> datetime:
    return datetime.now(UTC)


class RunInProgressError(Exception):
    def __init__(self, running: DiscoveryRun):
        super().__init__(f"{running.trigger} run {running.id} is in progress")
        self.running = running


class DiscoveryService:
    def __init__(
        self,
        settings: Settings,
        collectors: dict[str, Collector],
        inventory: InventoryStore,
        history: HistoryStore | None = None,
    ):
        self.settings = settings
        self.collectors = collectors  # one per protocol, the key is DeviceTarget.protocol
        self.inventory = inventory
        self.history = history
        # Start from what the last run left, so a restart is not reported as a new network.
        self.topology = (history.load_topology() if history else None) or Topology()
        self.runs: deque[DiscoveryRun] = deque(history.load_runs(RUN_HISTORY) if history else [], maxlen=RUN_HISTORY)
        self.current: DiscoveryRun | None = None
        self.next_scheduled_at: datetime | None = None
        self._seq = history.last_run_id() if history else 0
        self._rerun = False
        # Hosts the user added to or removed from the inventory, until a run reflects it.
        self._added_hosts: set[str] = set()
        self._removed_hosts: set[str] = set()
        self._tasks: dict[int, asyncio.Task] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._scheduler: asyncio.Task | None = None

    # Status and history

    def status(self) -> DiscoveryStatus:
        last = next((r for r in self.runs if r.status in ("completed", "failed")), None)
        return DiscoveryStatus(
            running=self.current,
            last_run=last,
            next_scheduled_at=self.next_scheduled_at,
            interval_seconds=self.settings.discovery_interval_seconds,
            source=", ".join(self.collectors),
        )

    # Live updates

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def _publish(self, message_type: str, run: DiscoveryRun) -> None:
        message = {"type": message_type, "run": run.model_dump(mode="json")}
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                log.warning("Dropping a slow WebSocket subscriber")
                self._subscribers.discard(queue)

    # Runs

    def _next_id(self) -> int:
        self._seq += 1
        return self._seq

    def start_run(self, trigger: Trigger) -> DiscoveryRun:
        """Start a run in the background. Raises RunInProgressError and records a skipped run."""
        if self.current:
            now = utcnow()
            skipped = DiscoveryRun(
                id=self._next_id(),
                trigger=trigger,
                status="skipped",
                started_at=now,
                finished_at=now,
                duration_ms=0,
                errors={"run": f"{self.current.trigger.capitalize()} run {self.current.id} in progress"},
            )
            self.runs.appendleft(skipped)
            self._save(skipped)
            self._publish("run_skipped", skipped)
            raise RunInProgressError(self.current)

        run = DiscoveryRun(id=self._next_id(), trigger=trigger, status="running", started_at=utcnow())
        self.current = run
        self._publish("run_started", run)
        task = asyncio.create_task(self._execute(run))
        self._tasks[run.id] = task
        task.add_done_callback(lambda _: self._tasks.pop(run.id, None))
        return run

    def request_run(self, added: str | None = None, removed: str | None = None) -> None:
        """Run soon after the inventory changed: now, or right after the run in progress.

        added and removed are hosts changed by the user, so the events can say so.
        """
        if added:
            self._added_hosts.add(added)
            self._removed_hosts.discard(added)
        if removed:
            self._removed_hosts.add(removed)
            self._added_hosts.discard(removed)
        if self.current:
            self._rerun = True
        else:
            self.start_run("manual")

    def _save(self, run: DiscoveryRun) -> None:
        if not self.history:
            return
        try:
            self.history.save_run(run)
            if run.status == "completed":
                self.history.save_topology(self.topology)
        except Exception:  # History is a convenience; discovery goes on without it.
            log.exception("Could not save run %s", run.id)

    async def run_now(self, trigger: Trigger) -> DiscoveryRun:
        """Start a run and wait for it to finish."""
        run = self.start_run(trigger)
        return await self._tasks[run.id]

    async def _try_method(self, target: DeviceTarget) -> DeviceReport:
        collector = self.collectors.get(target.protocol)
        if not collector:
            return DeviceReport(host=target.host, ok=False, error=f"no collector for protocol {target.protocol}")
        try:
            return await collector.collect(target)
        except Exception as exc:  # A buggy collector must not fail the whole run.
            log.exception("Collector failed on %s", target.host)
            return DeviceReport(host=target.host, ok=False, error=repr(exc))

    async def _collect(self, entry: DeviceEntry, limit: asyncio.Semaphore) -> tuple[DeviceReport, int | None]:
        """Try the connection methods in order until one works. Returns the report and the method used."""
        errors = []
        async with limit:
            for target in entry.ordered_methods():
                report = await self._try_method(target)
                if report.ok:
                    report.polled_via = target.protocol
                    return report, target.method_id
                if report.unreachable:
                    errors.append(f"unreachable over {target.label} ({report.error})")
                else:
                    errors.append(f"{target.label}: {report.error}")
        return DeviceReport(host=entry.host, ok=False, error="; ".join(errors)), None

    async def test_device(self, entry: DeviceEntry) -> list[ConnectionTest]:
        """Try every connection method of a device, without changing the topology."""
        results = []
        for target in entry.methods:
            started = time.monotonic()
            report = await self._try_method(target)
            results.append(
                ConnectionTest(
                    method_id=target.method_id,
                    protocol=target.protocol,
                    port=target.effective_port,
                    ok=report.ok,
                    hostname=report.facts.hostname if report.facts else None,
                    neighbors=len(report.neighbors),
                    error=report.error,
                    duration_ms=round((time.monotonic() - started) * 1000),
                )
            )
        return results

    async def _execute(self, run: DiscoveryRun) -> DiscoveryRun:
        started = time.monotonic()
        try:
            entries = self.inventory.load()
            for collector in self.collectors.values():
                await collector.before_run()
            limit = asyncio.Semaphore(self.settings.discovery_max_concurrency)
            results = await asyncio.gather(*(self._collect(e, limit) for e in entries))
            reports = [report for report, _ in results]
            polled_at = utcnow()
            for entry, (report, method_id) in zip(entries, results, strict=True):
                self.inventory.record_result(
                    entry.id,
                    polled_at,
                    method_id,
                    report.facts.hostname if report.ok and report.facts else None,
                    None if report.ok else report.error or "unknown error",
                    report.detected_platform,
                )
            hosts = [e.host for e in entries]
            by_host = {r.host: r for r in reports}
            renames = find_renames(self.topology, hosts, by_host)
            new = build_topology(
                previous=rename_devices(self.topology, renames),
                hosts=hosts,
                reports=by_host,
                now=utcnow(),
                retention_runs=self.settings.link_down_retention_runs,
            )
            run.diff = diff_topologies(
                self.topology, new, frozenset(self._added_hosts), frozenset(self._removed_hosts), renames
            )
            run.errors = {r.host: r.error or "unknown error" for r in reports if not r.ok}
            _explain_unreachable(run, new)
            registered_ips = {d.mgmt_ip for d in new.nodes if d.registered}
            self._added_hosts -= registered_ips  # shown as added once they appear
            self._removed_hosts &= registered_ips  # shown as removed once they are gone
            run.status = "completed"
            self.topology = new
            # Saved positions of devices that left the canvas (or were renamed) go away too.
            prune_positions(
                self.settings.positions_file,
                {d.id for d in new.nodes},
                {old: device_id(name) for old, name in renames.items()},
            )
        except Exception as exc:  # Keep the scheduler alive; the error is reported on the run.
            log.exception("Discovery run %s failed", run.id)
            run.status = "failed"
            run.errors = {"run": repr(exc)}
        finally:
            run.finished_at = utcnow()
            run.duration_ms = round((time.monotonic() - started) * 1000)
            run.devices = len(self.topology.nodes)
            run.links = len(self.topology.links)
            self.runs.appendleft(run)
            self.current = None
            self._save(run)
            self._publish("run_finished", run)
            log.info("Run %s (%s) %s: %s", run.id, run.trigger, run.status, run.diff.summary if run.diff else "")
            if self._rerun:
                self._rerun = False
                self.start_run("manual")
        return run

    # Scheduler

    async def _scheduler_loop(self) -> None:
        interval = self.settings.discovery_interval_seconds
        while True:
            started = time.monotonic()
            self.next_scheduled_at = utcnow() + timedelta(seconds=interval)
            with contextlib.suppress(RunInProgressError):
                await self.run_now("scheduled")
            await asyncio.sleep(max(0.0, interval - (time.monotonic() - started)))

    def start(self) -> None:
        """Start the scheduler. The first scheduled run starts immediately."""
        if not self._scheduler:
            self._scheduler = asyncio.create_task(self._scheduler_loop())

    async def stop(self) -> None:
        if self._scheduler:
            self._scheduler.cancel()
            await asyncio.gather(self._scheduler, return_exceptions=True)
            self._scheduler = None
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        for collector in self.collectors.values():
            await collector.close()
