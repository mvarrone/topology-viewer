"""WebSocket: one snapshot on connect, then run_started, run_finished and run_skipped messages."""

import asyncio
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.discovery.service import DiscoveryService

router = APIRouter()


@router.websocket("/ws/topology")
async def topology_updates(websocket: WebSocket) -> None:
    service: DiscoveryService = websocket.app.state.discovery
    await websocket.accept()
    queue = service.subscribe()

    async def forward() -> None:
        while True:
            await websocket.send_json(await queue.get())

    await websocket.send_json(
        {
            "type": "snapshot",
            "topology": service.topology.model_dump(mode="json"),
            "status": service.status().model_dump(mode="json"),
        }
    )
    sender = asyncio.create_task(forward())
    try:
        while True:
            await websocket.receive_text()  # Client messages are ignored; this detects disconnects.
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await sender
        service.unsubscribe(queue)
