"""Runtime connection profile + secret storage.

:class:`ConnectionProfile` is the lightweight, non-persisted shape the pool
needs to open a connection. Persistence of profiles lives in :mod:`backend.store`;
passwords live in the system keychain keyed by the profile id.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

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
    # Client certificate login: paths to the certificate and its key, and the
    # server's CA (or self-signed certificate) to verify against. "" = unused.
    ssl_cert: str = ""
    ssl_key: str = ""
    ssl_root_cert: str = ""

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


@dataclass(frozen=True)
class CertFiles:
    """A profile's certificate paths, resolved; ``None`` where unused."""

    cert: str | None
    key: str | None
    root_cert: str | None


def cert_files(profile: ConnectionProfile) -> CertFiles:
    """Resolve the profile's certificate paths, failing early on a missing file.

    A missing file would otherwise surface as an opaque TLS or authentication
    error from the server, far from its cause.
    """

    def resolve(raw: str) -> str | None:
        if not raw:
            return None
        path = os.path.expanduser(raw)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Certificate file not found: {path}")
        return path

    return CertFiles(
        cert=resolve(profile.ssl_cert),
        key=resolve(profile.ssl_key),
        root_cert=resolve(profile.ssl_root_cert),
    )


def explain_connect_error(exc: Exception) -> Exception:
    """Put the likely cause first when a client certificate has expired.

    Short-lived certificates expire mid-day; the server reports it as a TLS
    alert that reads like a network fault.
    """
    first_line = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
    if "certificate expired" in str(exc).lower():
        return ConnectionError(
            f"The client certificate has expired. Renew it and connect again. ({first_line})"
        )
    return exc
