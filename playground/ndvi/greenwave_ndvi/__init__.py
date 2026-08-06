"""Public Python API for Sentinel-2 NDVI research and map exports."""

from .analysis import (
    MASKED_SCL_CLASSES,
    compute_ndvi,
    crop_to_bounds,
    load_sectors,
    municipality_bounds,
    open_ndvi_stack,
)
from .export import export_categorical_layer, export_continuous_layer

from .loader import (
    build_zennevallei_mask,
    discover_observations,
    open_observation,
    open_stack,
)
from .source import (
    CdseCredentials,
    download_raw_observation,
    open_raw_observation,
    prompt_cdse_credentials,
)

__all__ = [
    "build_zennevallei_mask",
    "CdseCredentials",
    "MASKED_SCL_CLASSES",
    "compute_ndvi",
    "crop_to_bounds",
    "discover_observations",
    "download_raw_observation",
    "export_categorical_layer",
    "export_continuous_layer",
    "load_sectors",
    "municipality_bounds",
    "open_ndvi_stack",
    "open_observation",
    "open_raw_observation",
    "open_stack",
    "prompt_cdse_credentials",
]
