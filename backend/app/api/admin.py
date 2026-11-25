"""Inventory administration: devices and their connection methods.

Passwords are accepted on create and update and never returned.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.api.routes import Service
from app.models import ConnectionTest
from app.store import ConflictError, InventoryDeviceIn, InventoryDeviceOut, NotFoundError, SqliteInventory

router = APIRouter(prefix="/api")


def get_store(request: Request) -> SqliteInventory:
    return request.app.state.store


Store = Annotated[SqliteInventory, Depends(get_store)]


def _call(fn, *args):
    """Run a store call and turn its errors into HTTP errors."""
    try:
        return fn(*args)
    except NotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
    except ConflictError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc


@router.get("/inventory")
async def list_inventory(store: Store) -> list[InventoryDeviceOut]:
    return store.list_devices()


@router.post("/inventory", status_code=status.HTTP_201_CREATED)
async def create_inventory_device(data: InventoryDeviceIn, store: Store, service: Service) -> InventoryDeviceOut:
    device = _call(store.create_device, data)
    service.request_run(added=device.host)
    return device


@router.get("/inventory/{device_id}")
async def get_inventory_device(device_id: int, store: Store) -> InventoryDeviceOut:
    return _call(store.get_device, device_id)


@router.put("/inventory/{device_id}")
async def update_inventory_device(
    device_id: int, data: InventoryDeviceIn, store: Store, service: Service
) -> InventoryDeviceOut:
    old_host = _call(store.get_device, device_id).host
    device = _call(store.update_device, device_id, data)
    if old_host != device.host:
        service.request_run(added=device.host, removed=old_host)
    else:
        service.request_run()
    return device


@router.delete("/inventory/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_inventory_device(device_id: int, store: Store, service: Service) -> Response:
    host = _call(store.get_device, device_id).host
    _call(store.delete_device, device_id)
    service.request_run(removed=host)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/inventory/{device_id}/test")
async def test_inventory_device(device_id: int, store: Store, service: Service) -> list[ConnectionTest]:
    """Try every connection method of the device now. The topology does not change."""
    entry = _call(store.entry, device_id)
    return await service.test_device(entry)
