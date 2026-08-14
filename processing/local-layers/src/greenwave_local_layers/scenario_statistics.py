"""Pure summaries for method-specific scenario delta rasters."""

from __future__ import annotations

import math

import numpy as np


AFFECTED_THRESHOLD_C = 0.01


def delta_statistics(values):
    """Return extrema and a symmetric complete histogram of affected centres."""
    values = np.asarray(values, dtype=np.float64)
    if not values.size:
        return {"affectedCellCount": 0, "medianDeltaC": None, "p10DeltaC": None,
                "p90DeltaC": None, "minimumDeltaC": None, "maximumDeltaC": None,
                "strongestCoolingC": None, "strongestWarmingC": None,
                "deltaDistribution": {
                    "affectedThresholdC": AFFECTED_THRESHOLD_C,
                    "affectedCellCount": 0, "domainC": [0.0, 0.0],
                    "binWidthC": None, "bins": [],
                }}
    cooling = values[values < 0]
    warming = values[values > 0]
    maximum = float(np.max(np.abs(values)))
    raw_width = max(2 * maximum / 30, np.finfo(np.float64).eps)
    exponent = math.floor(math.log10(raw_width))
    base = 10.0 ** exponent
    width = next(
        multiplier * base for multiplier in (1.0, 2.0, 5.0, 10.0)
        if multiplier * base >= raw_width
    )
    domain = math.ceil(maximum / width - 1e-12) * width
    edges = np.arange(-domain, domain + width * 0.5, width, dtype=np.float64)
    counts, edges = np.histogram(values, bins=edges)
    distribution = {
        "affectedThresholdC": AFFECTED_THRESHOLD_C,
        "affectedCellCount": int(values.size),
        "domainC": [round(float(edges[0]), 6), round(float(edges[-1]), 6)],
        "binWidthC": round(float(width), 6),
        "bins": [
            {
                "lowerC": round(float(lower), 6),
                "upperC": round(float(upper), 6),
                "count": int(count),
                "sharePct": round(float(count / values.size * 100), 4),
            }
            for lower, upper, count in zip(edges[:-1], edges[1:], counts)
        ],
    }
    return {
        "affectedCellCount": int(values.size),
        "medianDeltaC": round(float(np.median(values)), 4),
        "p10DeltaC": round(float(np.percentile(values, 10)), 4),
        "p90DeltaC": round(float(np.percentile(values, 90)), 4),
        "minimumDeltaC": round(float(np.min(values)), 4),
        "maximumDeltaC": round(float(np.max(values)), 4),
        "strongestCoolingC": round(float(np.min(cooling)), 4) if cooling.size else None,
        "strongestWarmingC": round(float(np.max(warming)), 4) if warming.size else None,
        "deltaDistribution": distribution,
    }
