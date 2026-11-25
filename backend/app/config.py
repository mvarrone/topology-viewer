"""Application settings, read from environment variables and .env.

Devices and their credentials live in the database (DATABASE_FILE), managed from the UI or the API.
"""

from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    discovery_interval_seconds: int = 60
    discovery_max_concurrency: int = 10
    link_down_retention_runs: int = 10
    database_file: Path = Path("data/topology.db")
    # Fernet key that encrypts device passwords. Without it, data/secret.key is created.
    secret_key: SecretStr | None = None
    # Imported once, when the database has no devices yet.
    devices_file: Path = Path("devices.yaml")
    positions_file: Path = Path("data/positions.json")

    cors_origins: list[str] = ["http://localhost:5173"]
