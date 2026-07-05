"""Cross-platform config_dir resolution (macOS / Windows / Linux)."""

from __future__ import annotations

from pathlib import Path

import pytest

import backend.config as config


@pytest.mark.parametrize(
    "platform, expected_tail",
    [
        ("darwin", Path("Library") / "Application Support" / "Surus"),
        ("linux", Path(".local") / "share" / "Surus"),
        ("win32", Path("AppData") / "Local" / "Surus"),
    ],
)
def test_config_dir_is_platform_native(monkeypatch, tmp_path, platform, expected_tail):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(config.sys, "platform", platform)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    # Isolate the env overrides so the home-relative defaults are exercised.
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)

    result = config.config_dir()
    assert result == home / expected_tail
    assert result.is_dir()  # created on demand


def test_config_dir_honors_xdg_data_home(monkeypatch, tmp_path):
    monkeypatch.setattr(config.sys, "platform", "linux")
    xdg = tmp_path / "xdg"
    monkeypatch.setenv("XDG_DATA_HOME", str(xdg))
    assert config.config_dir() == xdg / "Surus"


def test_config_dir_honors_localappdata(monkeypatch, tmp_path):
    monkeypatch.setattr(config.sys, "platform", "win32")
    local = tmp_path / "AppData" / "Local"
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    assert config.config_dir() == local / "Surus"
