"""FastAPI application."""

import logging
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from app.api import admin, routes, ws
from app.collectors.restconf import RestconfCollector
from app.collectors.ssh import SshCollector
from app.config import Settings
from app.discovery.service import DiscoveryService
from app.history import HistoryStore
from app.store import SqliteInventory, load_key

log = logging.getLogger(__name__)


def build_store(settings: Settings) -> SqliteInventory:
    """Open the inventory database. A devices.yaml is imported once, while the database is empty."""
    secret = settings.secret_key.get_secret_value() if settings.secret_key else None
    key = load_key(secret, settings.database_file.parent / "secret.key")
    store = SqliteInventory(settings.database_file, key)
    if store.is_empty() and settings.devices_file.exists():
        count = store.import_yaml(settings.devices_file)
        log.info("Imported %s device(s) from %s", count, settings.devices_file)
    return store


def build_service(settings: Settings, store: SqliteInventory) -> DiscoveryService:
    collectors = {"restconf": RestconfCollector(), "ssh": SshCollector()}
    return DiscoveryService(settings, collectors, store, HistoryStore(settings.database_file))


def create_app(settings: Settings | None = None, start_scheduler: bool = True) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = build_store(settings)
        service = build_service(settings, store)
        app.state.store = store
        app.state.discovery = service
        if start_scheduler:
            service.start()
        yield
        await service.stop()

    app = FastAPI(title="Topology Viewer", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(routes.router)
    app.include_router(admin.router)
    app.include_router(ws.router)

    @app.get("/")
    async def root() -> dict:
        return {"message": "up and running", "datetime": datetime.now().astimezone().isoformat(timespec="seconds")}

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> Response:
        return Response(status_code=204)

    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()
