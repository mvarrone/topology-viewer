"""REST endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.discovery.service import DiscoveryService, RunInProgressError
from app.models import Device, DeviceDetail, DiscoveryRun, DiscoveryStatus, Link, NodePosition, Topology
from app.positions import load_positions, save_positions

router = APIRouter(prefix="/api")


def get_service(request: Request) -> DiscoveryService:
    return request.app.state.discovery


Service = Annotated[DiscoveryService, Depends(get_service)]


@router.get("/health")
async def health(service: Service) -> dict:
    return {"status": "ok", "source": ", ".join(service.collectors)}


@router.get("/topology")
async def topology(service: Service) -> Topology:
    return service.topology


@router.get("/devices")
async def devices(service: Service) -> list[Device]:
    return service.topology.nodes


@router.get("/devices/{device_id}")
async def device(device_id: str, service: Service) -> DeviceDetail:
    wanted = device_id.upper()
    found = next((d for d in service.topology.nodes if d.id == wanted), None)
    if not found:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Device {device_id} not found")
    links = [link for link in service.topology.links if wanted in (link.source, link.target)]
    return DeviceDetail(device=found, links=links)


@router.get("/links")
async def links(service: Service) -> list[Link]:
    return service.topology.links


@router.get("/discovery/status")
async def discovery_status(service: Service) -> DiscoveryStatus:
    return service.status()


@router.get("/discovery/runs")
async def discovery_runs(
    service: Service,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    notable: Annotated[int, Query(ge=0, le=1000)] = 200,
    include_diff: bool = False,
) -> list[DiscoveryRun]:
    """The newest `limit` runs, plus older runs with changes or failures (up to `notable`)."""
    by_id = {r.id: r for r in list(service.runs)[:limit]}
    if notable and service.history:
        for run in service.history.load_notable_runs(notable):
            by_id.setdefault(run.id, run)
    runs = sorted(by_id.values(), key=lambda r: r.id, reverse=True)
    return runs if include_diff else [r.model_copy(update={"diff": None}) for r in runs]


@router.post("/discovery/run", status_code=status.HTTP_202_ACCEPTED)
async def start_manual_run(service: Service) -> DiscoveryRun:
    try:
        return service.start_run("manual")
    except RunInProgressError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {"message": str(exc), "running_run_id": exc.running.id},
        ) from exc


@router.get("/positions")
async def get_positions(service: Service) -> dict[str, NodePosition]:
    return load_positions(service.settings.positions_file)


@router.put("/positions")
async def put_positions(positions: dict[str, NodePosition], service: Service) -> dict[str, NodePosition]:
    return save_positions(service.settings.positions_file, positions)
