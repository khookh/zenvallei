"""Strict six-acquisition heatwave-mean target for image regression.

The predictor contract is intentionally inherited from the production 2026
scenario catalog. Only the target changes: every retained 30 m centre must be
clear and finite in all six aligned Landsat acquisitions, and its target is
their unweighted arithmetic mean.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio

from .constants import CACHE_ROOT
from .image_regression import (
    DEFAULT_OBSERVATION_ID,
    LAND_COVER_CHANNEL_NAMES,
    RegressionCatalog,
    _atomic_json,
    _relative_path,
    _resolve_path,
    _source_signature,
    _xgboost_input_contract,
    prepare_regression_catalog,
)
from .sources import file_hash


SCHEMA_VERSION = 1
TARGET_CONTRACT_VERSION = 1
HEATWAVE_MEAN_TARGET_ID = "heatwave-mean-2020-2026"
EXPECTED_SAMPLE_COUNT = 177_672
EXPECTED_SECTOR_COUNT = 154
HEATWAVE_OBSERVATION_IDS = (
    "landsat-2020-08-07",
    "landsat-2022-08-14",
    "landsat-2023-06-13",
    "landsat-2023-09-09",
    "landsat-2025-08-13",
    "landsat-2026-06-22",
)
CATALOG_ROOT = CACHE_ROOT / "image-regression" / HEATWAVE_MEAN_TARGET_ID
MANIFEST_PATH = CATALOG_ROOT / "manifest.json"
SAMPLES_PATH = CATALOG_ROOT / "samples.csv.gz"


def heatwave_raster_paths():
    return tuple(
        CACHE_ROOT / "landsat-temperature" / "analysis" / f"{observation_id}.tif"
        for observation_id in HEATWAVE_OBSERVATION_IDS
    )


def validate_aligned_heatwave_grids(paths):
    """Reject any CRS, affine transform, shape or pixel-size mismatch."""
    paths = tuple(Path(path) for path in paths)
    if len(paths) != len(HEATWAVE_OBSERVATION_IDS):
        raise ValueError(f"Expected exactly {len(HEATWAVE_OBSERVATION_IDS)} heatwave rasters.")
    missing = [path for path in paths if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing heatwave target rasters: {missing}")
    reference = None
    for path in paths:
        with rasterio.open(path) as source:
            contract = {
                "crs": source.crs.to_string() if source.crs else None,
                "transform": tuple(source.transform)[:6],
                "width": int(source.width),
                "height": int(source.height),
            }
        if reference is None:
            reference = contract
        elif contract != reference:
            raise ValueError(
                f"Heatwave target grid mismatch for {path.name}: "
                f"expected {reference}, found {contract}."
            )
    return {
        "crs": reference["crs"],
        "transform": list(reference["transform"]),
        "shape": [reference["height"], reference["width"]],
        "resolutionMeters": [abs(reference["transform"][0]), abs(reference["transform"][4])],
    }


def strict_heatwave_mean(temperatures, clear_masks):
    """Return means and eligibility, requiring all six clear finite values."""
    values = np.asarray(temperatures, dtype=np.float64)
    clear = np.asarray(clear_masks, dtype=bool)
    expected = len(HEATWAVE_OBSERVATION_IDS)
    if values.ndim != 2 or values.shape[0] != expected or clear.shape != values.shape:
        raise ValueError(f"Temperature and clear-mask arrays must have shape ({expected}, n).")
    eligible = np.all(clear & np.isfinite(values), axis=0)
    means = np.full(values.shape[1], np.nan, dtype=np.float64)
    means[eligible] = values[:, eligible].mean(axis=0)
    return means, eligible


def _signature_matches_hash(signature):
    path = _resolve_path(signature["path"])
    if not path.exists():
        return False
    stat = path.stat()
    return stat.st_size == signature["size"] \
        and stat.st_mtime_ns == signature["mtimeNs"] \
        and file_hash(path) == signature["sha256"]


def _column_name(observation_id):
    return f"lst_{observation_id.removeprefix('landsat-').replace('-', '_')}_c"


def _summary(values):
    values = np.asarray(values, dtype=np.float64)
    return {
        "count": int(len(values)),
        "minimumC": float(values.min()),
        "maximumC": float(values.max()),
        "meanC": float(values.mean()),
        "standardDeviationC": float(values.std()),
        "medianC": float(np.median(values)),
    }


def _build_target_samples(base_catalog, paths):
    rows = base_catalog.samples["landsat_row"].to_numpy(dtype=np.int64)
    columns = base_catalog.samples["landsat_col"].to_numpy(dtype=np.int64)
    values = []
    clear = []
    for path in paths:
        with rasterio.open(path) as source:
            temperature = source.read(1)[rows, columns]
            status = source.read(2)[rows, columns]
        values.append(temperature.astype(np.float64, copy=False))
        clear.append(status == 1)
    values = np.asarray(values)
    means, eligible = strict_heatwave_mean(values, clear)
    samples = base_catalog.samples.loc[eligible].copy().reset_index(drop=True)
    retained = values[:, eligible]
    for index, observation_id in enumerate(HEATWAVE_OBSERVATION_IDS):
        samples[_column_name(observation_id)] = retained[index].astype(np.float32)
    samples["lst_c"] = means[eligible].astype(np.float32)
    samples["observation_id"] = HEATWAVE_MEAN_TARGET_ID
    samples["sample_id"] = [
        f"{HEATWAVE_MEAN_TARGET_ID}-{row}-{column}"
        for row, column in zip(samples["landsat_row"], samples["landsat_col"])
    ]
    return samples, values, eligible


def prepare_heatwave_mean_catalog(
        observation_id: str = HEATWAVE_MEAN_TARGET_ID, *, force: bool = False,
        base_catalog_factory=prepare_regression_catalog):
    """Prepare the versioned strict-complete-case mean-target catalog."""
    if observation_id != HEATWAVE_MEAN_TARGET_ID:
        raise ValueError(f"Unsupported heatwave-mean target: {observation_id}")
    if MANIFEST_PATH.exists() and SAMPLES_PATH.exists() and not force:
        try:
            return load_heatwave_mean_catalog(observation_id)
        except (FileNotFoundError, ValueError, OSError, KeyError):
            pass

    paths = heatwave_raster_paths()
    grid = validate_aligned_heatwave_grids(paths)
    base = base_catalog_factory(DEFAULT_OBSERVATION_ID, force=force)
    samples, all_values, eligible = _build_target_samples(base, paths)
    if samples.empty:
        raise ValueError("No locations have clear finite temperatures on all six heatwave dates.")

    CATALOG_ROOT.mkdir(parents=True, exist_ok=True)
    temporary_samples = SAMPLES_PATH.with_suffix(".partial.csv.gz")
    samples.to_csv(temporary_samples, index=False, compression="gzip")
    temporary_samples.replace(SAMPLES_PATH)
    landsat_sources = {
        observation_id: _source_signature(path)
        for observation_id, path in zip(HEATWAVE_OBSERVATION_IDS, paths)
    }
    per_date = {
        observation_id: _summary(all_values[index, eligible])
        for index, observation_id in enumerate(HEATWAVE_OBSERVATION_IDS)
    }
    predictor_sources = {
        name: dict(base.manifest["sources"][name])
        for name in (
            "soilSealing", "greenMap", "sectors", "urbanAtlas", "urbanContext",
            "landUseWater", "waterContext",
        )
    }
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "targetContractVersion": TARGET_CONTRACT_VERSION,
        "observationId": HEATWAVE_MEAN_TARGET_ID,
        "target": {
            "name": "unweighted_mean_heatwave_land_surface_temperature",
            "unit": "°C",
            "observationIds": list(HEATWAVE_OBSERVATION_IDS),
            "observationCount": len(HEATWAVE_OBSERVATION_IDS),
            "aggregation": "arithmetic-mean",
            "completeCaseRule": "all-six-clear-finite-values-required",
            "interpretation": "six-acquisition-composite-not-climatological-normal-or-single-date-temperature",
            "perDateSummaries": per_date,
            "meanSummary": _summary(samples["lst_c"]),
        },
        "targetGrid": grid,
        "predictorContract": {
            "channels": list(LAND_COVER_CHANNEL_NAMES),
            "supportRadiusMeters": 100,
            "soilSealingYear": 2024,
            "greenMapYear": 2021,
            "urbanAtlasYear": 2021,
            "temporalMismatch": (
                "Static 2021/2024 land-cover predictors are associated with temperatures "
                "acquired from 2020 through 2026."
            ),
        },
        "xgboostInput": _xgboost_input_contract(),
        "eligibility": {
            "rule": "strict-six-date-complete-case-on-production-100m-predictor-support",
            "candidateCount": int(len(base.samples)),
            "excludedMissingAnyAcquisitionCount": int((~eligible).sum()),
            "eligibleCount": int(eligible.sum()),
            "completeGroundDiskRequired": True,
        },
        "sampleIndex": _relative_path(SAMPLES_PATH),
        "sampleCount": int(len(samples)),
        "sectorCount": int(samples["sector_id"].nunique()),
        "expectedFrozenSources": {
            "sampleCount": EXPECTED_SAMPLE_COUNT,
            "sectorCount": EXPECTED_SECTOR_COUNT,
        },
        "sources": {
            "landsat": landsat_sources,
            **predictor_sources,
            "baseCatalogManifest": _source_signature(base.cache_dir / "manifest.json"),
        },
    }
    _atomic_json(MANIFEST_PATH, manifest)
    return load_heatwave_mean_catalog(observation_id)


def load_heatwave_mean_catalog(
        observation_id: str = HEATWAVE_MEAN_TARGET_ID) -> RegressionCatalog:
    """Load the mean-target catalog and hash-check all target and predictor sources."""
    if observation_id != HEATWAVE_MEAN_TARGET_ID:
        raise ValueError(f"Unsupported heatwave-mean target: {observation_id}")
    if not MANIFEST_PATH.exists() or not SAMPLES_PATH.exists():
        raise FileNotFoundError(f"Prepare the heatwave-mean catalog first: {CATALOG_ROOT}")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != SCHEMA_VERSION \
            or manifest.get("targetContractVersion") != TARGET_CONTRACT_VERSION \
            or manifest.get("observationId") != observation_id:
        raise ValueError("The heatwave-mean target catalog contract is incompatible.")
    target = manifest.get("target", {})
    if tuple(target.get("observationIds", ())) != HEATWAVE_OBSERVATION_IDS \
            or target.get("completeCaseRule") != "all-six-clear-finite-values-required" \
            or target.get("aggregation") != "arithmetic-mean":
        raise ValueError("The heatwave-mean target definition is incompatible.")
    if manifest.get("xgboostInput") != _xgboost_input_contract():
        raise ValueError("The heatwave-mean predictor contract is incompatible.")
    signatures = [*manifest["sources"]["landsat"].values()]
    signatures.extend(
        signature for name, signature in manifest["sources"].items()
        if name != "landsat"
    )
    if any(not _signature_matches_hash(signature) for signature in signatures):
        raise ValueError("The heatwave-mean catalog has a missing, changed, or hash-invalid source.")
    validate_aligned_heatwave_grids(
        _resolve_path(manifest["sources"]["landsat"][item]["path"])
        for item in HEATWAVE_OBSERVATION_IDS
    )
    samples = pd.read_csv(SAMPLES_PATH, compression="gzip")
    if len(samples) != manifest["sampleCount"] or samples["sample_id"].duplicated().any():
        raise ValueError("The heatwave-mean sample index is incomplete or duplicated.")
    if len(samples) != manifest["eligibility"]["eligibleCount"] \
            or samples["sector_id"].nunique() != manifest["sectorCount"]:
        raise ValueError("The heatwave-mean cohort summary does not match its sample index.")
    date_columns = [_column_name(item) for item in HEATWAVE_OBSERVATION_IDS]
    expected_mean = samples[date_columns].to_numpy(dtype=np.float64).mean(axis=1)
    if not np.allclose(samples["lst_c"], expected_mean, rtol=0, atol=5e-5):
        raise ValueError("The cached heatwave-mean targets are not exact six-date arithmetic means.")
    for column in ("sample_id", "site_id", "observation_id", "sector_id", "municipality"):
        samples[column] = samples[column].astype(str)
    sources = manifest["sources"]
    return RegressionCatalog(
        observation_id=observation_id,
        samples=samples.reset_index(drop=True),
        manifest=manifest,
        cache_dir=CATALOG_ROOT,
        soil_path=_resolve_path(sources["soilSealing"]["path"]),
        green_path=_resolve_path(sources["greenMap"]["path"]),
        urban_context_path=_resolve_path(sources["urbanContext"]["path"]),
        water_context_path=_resolve_path(sources["waterContext"]["path"]),
    )
