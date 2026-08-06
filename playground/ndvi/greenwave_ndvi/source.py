"""Download and open raw Sentinel-2 L2A bands for Python research.

The Process API requires a small evalscript to select bands. It performs no
scientific calculation: B04, B08, SCL and dataMask are returned unchanged as a
four-band GeoTIFF. NDVI and all masking are implemented in :mod:`analysis`.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import requests
import rasterio
import xarray as xr

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CACHE = PROJECT_ROOT / ".cache" / "vegetation"
DEFAULT_RAW_CACHE = DEFAULT_CACHE / "raw"
DEFAULT_SELECTION = DEFAULT_CACHE / "selection.json"
DEFAULT_SECTORS = PROJECT_ROOT / "public" / "data" / "sectors.geojson"
TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"
CRS_URI = "http://www.opengis.net/def/crs/EPSG/0/32631"
RAW_PATTERN = re.compile(r"sentinel-2-l2a-raw-(\d{4}-\d{2}-\d{2})-epsg32631-10m\.tif$")
EXPECTED_GRID = {"bbox": [575690, 5616040, 600430, 5631360], "width": 2474, "height": 1532}
DEFAULT_SELECTED_DATES = {2020: "2020-06-24", 2021: "2021-06-14"}

EVALSCRIPT = """//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "SCL", "dataMask"],
      units: ["REFLECTANCE", "REFLECTANCE", "DN", "DN"]
    }],
    output: { id: "default", bands: 4, sampleType: "FLOAT32" }
  };
}
function evaluatePixel(sample) {
  return [sample.B04, sample.B08, sample.SCL, sample.dataMask];
}
"""


@dataclass(frozen=True)
class CdseCredentials:
    """OAuth client credentials whose secret is excluded from representations."""

    client_id: str
    client_secret: str = field(repr=False)


def prompt_cdse_credentials() -> CdseCredentials:
    """Read credentials from the environment or prompt without persisting them."""

    client_id = os.environ.get("CDSE_SH_CLIENT_ID", "").strip()
    client_secret = os.environ.get("CDSE_SH_CLIENT_SECRET", "").strip()
    if not client_id:
        client_id = input("Sentinel Hub OAuth client ID: ").strip()
    if not client_secret:
        client_secret = getpass.getpass("Sentinel Hub OAuth client secret: ").strip()
    if not client_id or not client_secret:
        raise ValueError("Both Sentinel Hub OAuth client ID and secret are required.")
    return CdseCredentials(client_id, client_secret)


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def selected_date(year: int, selection_path: str | Path = DEFAULT_SELECTION) -> str:
    """Resolve one of the deterministic annual observation choices."""

    selection_file = Path(selection_path)
    selection = _read_json(selection_file) if selection_file.exists() else {}
    entry = selection.get("years", {}).get(str(int(year)), {})
    date = entry.get("selectedDate") or entry.get("selected", {}).get("date")
    date = date or DEFAULT_SELECTED_DATES.get(int(year))
    if not date:
        raise KeyError(f"No selected Sentinel-2 observation exists for {year}.")
    return str(date)


def _resolve_date(year_or_date: int | str) -> str:
    value = str(year_or_date)
    if re.fullmatch(r"\d{4}", value):
        return selected_date(int(value))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Use a year or an ISO date such as 2021-06-14.")
    return value


def raw_path(year_or_date: int | str, cache_dir: str | Path = DEFAULT_RAW_CACHE) -> Path:
    date = _resolve_date(year_or_date)
    return Path(cache_dir) / f"sentinel-2-l2a-raw-{date}-epsg32631-10m.tif"


def _request_payload(date: str) -> dict[str, Any]:
    return {
        "input": {
            "bounds": {"bbox": EXPECTED_GRID["bbox"], "properties": {"crs": CRS_URI}},
            "data": [{
                "type": "sentinel-2-l2a",
                "dataFilter": {
                    "timeRange": {"from": f"{date}T00:00:00Z", "to": f"{date}T23:59:59Z"},
                    "mosaickingOrder": "leastCC",
                    "maxCloudCoverage": 100,
                },
                "processing": {"harmonizeValues": True, "upsampling": "NEAREST", "downsampling": "NEAREST"},
            }],
        },
        "output": {
            "width": EXPECTED_GRID["width"],
            "height": EXPECTED_GRID["height"],
            "responses": [{"identifier": "default", "format": {"type": "image/tiff"}}],
        },
        "evalscript": EVALSCRIPT,
    }


def _access_token(credentials: CdseCredentials, session: requests.Session) -> str:
    response = session.post(
        TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": credentials.client_id,
            "client_secret": credentials.client_secret,
        },
        timeout=60,
    )
    response.raise_for_status()
    token = response.json().get("access_token")
    if not token:
        raise RuntimeError("Copernicus authentication returned no access token.")
    return str(token)


def validate_raw_raster(path: str | Path) -> None:
    """Reject raw caches that cannot reproduce the current 10 m method."""

    with rasterio.open(path) as source:
        if source.crs is None or source.crs.to_epsg() != 32631:
            raise ValueError(f"Expected EPSG:32631, found {source.crs}.")
        if source.count != 4:
            raise ValueError(f"Expected four bands, found {source.count}.")
        if source.width != EXPECTED_GRID["width"] or source.height != EXPECTED_GRID["height"]:
            raise ValueError(f"Expected {EXPECTED_GRID['width']} x {EXPECTED_GRID['height']} pixels.")
        if not np.isclose(source.transform.a, 10) or not np.isclose(source.transform.e, -10):
            raise ValueError("Expected a north-up 10 m grid.")
        sample = source.read((3, 4), out_shape=(2, 128, 128), resampling=rasterio.enums.Resampling.nearest)
        if not np.isfinite(sample).all():
            raise ValueError("SCL and dataMask contain non-finite values.")
        if np.any((sample[0] < 0) | (sample[0] > 11)):
            raise ValueError("SCL contains values outside 0 through 11.")
        if np.any((sample[1] < 0) | (sample[1] > 1)):
            raise ValueError("dataMask contains values outside 0 through 1.")


def download_raw_observation(
    year_or_date: int | str,
    credentials: CdseCredentials | None = None,
    *,
    cache_dir: str | Path = DEFAULT_RAW_CACHE,
    force: bool = False,
    session: requests.Session | None = None,
) -> Path:
    """Download or reuse raw B04/B08/SCL/dataMask for one selected observation."""

    date = _resolve_date(year_or_date)
    destination = raw_path(date, cache_dir)
    if destination.exists() and not force:
        validate_raw_raster(destination)
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    http = session or requests.Session()
    secret = credentials or prompt_cdse_credentials()
    payload = _request_payload(date)
    token = _access_token(secret, http)
    response = http.post(
        PROCESS_URL,
        json=payload,
        headers={"Authorization": f"Bearer {token}", "Accept": "image/tiff"},
        timeout=300,
    )
    response.raise_for_status()
    temporary = destination.with_suffix(".tif.part")
    temporary.write_bytes(response.content)
    try:
        validate_raw_raster(temporary)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    selection = _read_json(DEFAULT_SELECTION) if DEFAULT_SELECTION.exists() else {}
    selected = selection.get("years", {}).get(date[:4], {}).get("selected", {})
    sidecar = {
        "schemaVersion": 1,
        "date": date,
        "year": int(date[:4]),
        "collection": "sentinel-2-l2a",
        "products": selected.get("products", []),
        "grid": {**EXPECTED_GRID, "crs": "EPSG:32631", "pixelSize": 10},
        "bands": ["B04", "B08", "SCL", "dataMask"],
        "requestSha256": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
        "responseSha256": digest,
        "downloadedAt": datetime.now(timezone.utc).isoformat(),
        "sourceUrl": PROCESS_URL,
    }
    destination.with_suffix(".tif.json").write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    return destination


def _coordinates(source: rasterio.io.DatasetReader) -> tuple[np.ndarray, np.ndarray]:
    x = source.transform.c + (np.arange(source.width) + 0.5) * source.transform.a
    y = source.transform.f + (np.arange(source.height) + 0.5) * source.transform.e
    return x, y


def open_raw_observation(
    year_or_path: int | str | Path,
    *,
    cache_dir: str | Path = DEFAULT_RAW_CACHE,
) -> xr.Dataset:
    """Open a raw four-band observation as a labelled Xarray dataset."""

    if isinstance(year_or_path, int) or str(year_or_path).isdigit() or re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(year_or_path)):
        path = raw_path(str(year_or_path), cache_dir)
    else:
        path = Path(year_or_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Raw Sentinel cache not found: {path}. Run download_raw_observation first.")
    validate_raw_raster(path)
    with rasterio.open(path) as source:
        bands = source.read().astype("float32")
        x, y = _coordinates(source)
        match = RAW_PATTERN.match(path.name)
        date = match.group(1) if match else "unknown"
        return xr.Dataset(
            data_vars={
                "b04": (("y", "x"), bands[0]),
                "b08": (("y", "x"), bands[1]),
                "scl": (("y", "x"), bands[2].astype("uint8")),
                "data_mask": (("y", "x"), bands[3] >= 0.5),
            },
            coords={"x": x, "y": y},
            attrs={
                "crs": str(source.crs),
                "transform": tuple(source.transform)[:6],
                "resolution_meters": 10,
                "date": date,
                "year": int(date[:4]) if date != "unknown" else None,
                "source_path": str(path),
            },
        )
