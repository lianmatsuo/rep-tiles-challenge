"""Smoke tests for the FastAPI endpoints."""

import pytest
from httpx import ASGITransport, AsyncClient

import rep_tiles.shapes  # register predefined shapes


@pytest.fixture
def transport():
    from rep_tiles.api import app
    return ASGITransport(app=app)


@pytest.mark.anyio
async def test_get_shapes_returns_200(transport) -> None:
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/shapes")
    assert resp.status_code == 200
    data = resp.json()
    names = {s["name"] for s in data["shapes"]}
    assert "right-isoceles-triangle" in names
    assert "l-tromino" in names
    assert "l-tetromino" in names
    assert "sphinx-hexiamond" in names
    assert data["frame"] == "right-isoceles-triangle"


@pytest.mark.anyio
async def test_validate_empty_placements(transport) -> None:
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/api/validate",
            json={
                "frame": "right-isoceles-triangle",
                "scale": 2.0,
                "placements": [],
            },
        )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["fully_tiled"] is False
    assert data["coverage"] == 0.0
