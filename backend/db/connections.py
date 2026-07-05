"""Runtime connection profile + secret storage.

:class:`ConnectionProfile` is the lightweight, non-persisted shape the pool
needs to open a connection. Persistence of profiles lives in :mod:`backend.store`;
passwords live in the system keychain keyed by the profile id.
"""

from __future__ import annotations

import keyring
from pydantic import BaseModel

from backend.config import KEYRING_SERVICE


class ConnectionProfile(BaseModel):
    id: str
    name: str = "Connection"
    kind: str = "postgres"  # selects the engine dialect; see backend.db.dialects
    host: str = "localhost"
    port: int = 5432
    dbname: str = "postgres"
    user: str = "postgres"
    sslmode: str = "prefer"

    def keyring_username(self) -> str:
        return f"conn:{self.id}"


def get_password(profile: ConnectionProfile) -> str | None:
    return keyring.get_password(KEYRING_SERVICE, profile.keyring_username())


def set_password(profile: ConnectionProfile, password: str) -> None:
    keyring.set_password(KEYRING_SERVICE, profile.keyring_username(), password)


def delete_password(profile: ConnectionProfile) -> None:
    try:
        keyring.delete_password(KEYRING_SERVICE, profile.keyring_username())
    except keyring.errors.PasswordDeleteError:
        pass
