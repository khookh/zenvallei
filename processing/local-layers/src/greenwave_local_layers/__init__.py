"""Prepare local-only official raster layers for the Greenwave map."""

from .statistics import categorical_statistics, tcd_statistics

__all__ = ["categorical_statistics", "tcd_statistics"]
