"""Authenticated downloads, WCS extraction and source validation."""

from __future__ import annotations

import csv
import hashlib
import os
import re
import time
import zipfile
from pathlib import Path

import requests

from .constants import CDSE_DOWNLOAD, TCD_CATALOGUE


def file_hash(path: Path, algorithm: str = "sha256") -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def extract_tiff_payload(content: bytes, content_type: str = "") -> bytes:
    """Extract TIFF bytes from direct or multipart WCS responses."""
    if content[:4] in (b"II*\x00", b"MM\x00*"):
        return content
    boundary_match = re.search(r"boundary=\"?([^\";]+)", content_type, re.I)
    if boundary_match:
        boundary = ("--" + boundary_match.group(1)).encode()
        for part in content.split(boundary):
            split = part.find(b"\r\n\r\n")
            payload = part[split + 4 :].rstrip(b"\r\n") if split >= 0 else b""
            if payload[:4] in (b"II*\x00", b"MM\x00*"):
                return payload
    offsets = [offset for magic in (b"II*\x00", b"MM\x00*") if (offset := content.find(magic)) >= 0]
    if offsets:
        return content[min(offsets):].rstrip(b"\r\n-")
    detail = ""
    if "xml" in content_type.lower() or content.lstrip().startswith(b"<"):
        text = content.decode("utf-8", errors="replace")
        detail = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text)).strip()[:500]
    suffix = f" Service response: {detail}" if detail else ""
    raise ValueError(f"The WCS response did not contain a GeoTIFF.{suffix}")


def request_wcs_tiff(url: str, coverage: str, bbox, width: int, height: int) -> bytes:
    parameters = {
        "service": "WCS", "version": "1.0.0", "request": "GetCoverage",
        "coverage": coverage, "crs": "EPSG:31370", "response_crs": "EPSG:31370",
        "bbox": ",".join(str(value) for value in bbox), "width": width, "height": height,
        "format": "GeoTIFF",
    }
    failure = None
    for attempt in range(1, 4):
        try:
            response = requests.get(url, params=parameters, timeout=(30, 300))
            response.raise_for_status()
            return extract_tiff_payload(response.content, response.headers.get("content-type", ""))
        except (requests.RequestException, ValueError) as error:
            failure = error
            if attempt < 3:
                time.sleep(attempt * 2)
    raise RuntimeError(f"WCS coverage {coverage} failed after three attempts: {failure}") from failure


def download_file(url: str, destination: Path, headers=None) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    with requests.get(url, headers=headers, stream=True, timeout=300) as response:
        response.raise_for_status()
        # requests transparently decodes gzip/br transfer encodings, while
        # Content-Length still describes the encoded payload on the wire.
        expected = 0 if response.headers.get("content-encoding") else int(response.headers.get("content-length", 0))
        received = 0
        last_report = 0
        with temporary.open("wb") as stream:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    stream.write(chunk)
                    received += len(chunk)
                    if received - last_report >= 64 * 1024 * 1024:
                        if expected:
                            print(f"  downloaded {received / 1024**2:.0f}/{expected / 1024**2:.0f} MiB", flush=True)
                        else:
                            print(f"  downloaded {received / 1024**2:.0f} MiB", flush=True)
                        last_report = received
        if expected and received != expected:
            temporary.unlink(missing_ok=True)
            raise ValueError(f"Download was incomplete: expected {expected} bytes, received {received}.")
    temporary.replace(destination)
    return destination


def read_tcd_catalogue(cache_path: Path) -> dict[int, dict[str, str]]:
    if not cache_path.exists():
        download_file(TCD_CATALOGUE, cache_path)
    with cache_path.open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream, delimiter=";"))
    selected = {}
    for row in rows:
        match = re.search(r"TCD_S(20\d{2})_R10m_E39N30_", row.get("name", ""))
        if match:
            selected[int(match.group(1))] = row
    return selected


def download_tcd_product(row: dict[str, str], destination: Path) -> Path:
    expected_size = int(row["content_length"])
    expected_md5 = row["checksum_value"].lower()
    if destination.exists() and destination.stat().st_size == expected_size and file_hash(destination, "md5") == expected_md5:
        return destination
    token = os.environ.get("CDSE_ACCESS_TOKEN", "").strip()
    if not token:
        raise RuntimeError("CDSE_ACCESS_TOKEN is required to download TCD, or provide --source YEAR=path.")
    headers = {"Authorization": token if token.startswith("Bearer ") else f"Bearer {token}"}
    download_file(f"{CDSE_DOWNLOAD}({row['id']})/$value", destination, headers)
    if destination.stat().st_size != expected_size or file_hash(destination, "md5") != expected_md5:
        destination.unlink(missing_ok=True)
        raise ValueError(f"TCD {row['name']} failed size or MD5 validation.")
    return destination


def locate_geotiff(source: Path, extraction_root: Path) -> Path:
    if source.is_dir():
        candidates = sorted((*source.rglob("*.tif"), *source.rglob("*.tiff")))
        if not candidates:
            raise FileNotFoundError(f"No GeoTIFF found below {source}.")
        return candidates[0]
    if zipfile.is_zipfile(source):
        extraction_root.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(source) as archive:
            safe = [name for name in archive.namelist() if not name.startswith(("/", "\\")) and ".." not in Path(name).parts]
            archive.extractall(extraction_root, members=safe)
        return locate_geotiff(extraction_root, extraction_root)
    return source


def parse_tcd_palette(script: str) -> list[str]:
    entries = re.findall(r"\[(\d+),\s*\[(\d+),\s*(\d+),\s*(\d+)\]\]", script)
    palette = {int(value): f"#{int(red):02x}{int(green):02x}{int(blue):02x}" for value, red, green, blue in entries}
    if set(palette) != set(range(1, 101)):
        raise ValueError("The official TCD style does not contain exactly values 1 through 100.")
    return ["#edf0ec", *(palette[value] for value in range(1, 101))]
