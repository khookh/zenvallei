"""Shared land-cover state and exclusive analytical upper surface.

The editor retains the ground below High vegetation so removing a canopy can
reveal the baseline surface.  Radoux and XGBoost never use that latent overlap
as two simultaneous predictors: both consume one exclusive upper surface.
Keeping that priority rule here prevents training and scenario inference from
resolving the same source cell differently.
"""

from __future__ import annotations

import numpy as np


GROUND_LOCKED = np.uint8(0)
GROUND_LOW = np.uint8(1)
GROUND_SEALED = np.uint8(2)
GROUND_AGRICULTURE = np.uint8(3)
GROUND_WATER = np.uint8(4)
GROUND_BARE = np.uint8(5)

GROUND_NAME_BY_CODE = {
    int(GROUND_LOCKED): "locked",
    int(GROUND_LOW): "low",
    int(GROUND_SEALED): "sealed",
    int(GROUND_AGRICULTURE): "agriculture",
    int(GROUND_WATER): "water",
    int(GROUND_BARE): "bare",
}


def baseline_land_cover(green, sealing, water=None, inside=None):
    """Return latent ground, High-canopy and editable masks.

    Green Map values are High=1, Low=2, Agriculture=3 and Non-green=4.
    Soil-sealing values are Unsealed=0 and Sealed=1.  Water and agriculture
    are deliberately locked because the Radoux scenario has no defensible
    agricultural transition coefficient and water is not editable.
    """
    green = np.asarray(green)
    sealing = np.asarray(sealing)
    if green.shape != sealing.shape:
        raise ValueError("Green Map and Soil sealing windows must align.")
    valid = np.isin(green, (1, 2, 3, 4)) & np.isin(sealing, (0, 1))
    in_scope = np.ones(green.shape, dtype=bool) if inside is None else np.asarray(inside, dtype=bool)
    water_mask = np.zeros(green.shape, dtype=bool) if water is None else np.asarray(water, dtype=bool)

    ground = np.full(green.shape, GROUND_LOCKED, dtype=np.uint8)
    ground[valid & in_scope & (green == 3)] = GROUND_AGRICULTURE
    supported = valid & in_scope & ~water_mask & (green != 3)
    ground[supported & (sealing == 1)] = GROUND_SEALED
    ground[supported & (sealing == 0) & np.isin(green, (1, 2))] = GROUND_LOW
    ground[supported & (sealing == 0) & (green == 4)] = GROUND_BARE
    ground[valid & in_scope & water_mask] = GROUND_WATER

    high_canopy = valid & in_scope & ~water_mask & (green == 1)
    editable = np.isin(ground, (GROUND_LOW, GROUND_SEALED, GROUND_BARE))
    return ground, high_canopy, editable


def upper_surface_masks(ground, high_canopy):
    """Resolve latent ground/canopy state to one class per valid cell.

    Priority is water, agriculture, High vegetation, sealed surface, Low
    vegetation, then other unsealed ground.  The returned masks are therefore
    mutually exclusive even where High vegetation covers sealed or Low ground.
    """
    ground = np.asarray(ground, dtype=np.uint8)
    high_canopy = np.asarray(high_canopy, dtype=bool)
    if ground.shape != high_canopy.shape:
        raise ValueError("Scenario canopy must align with the ground grid.")

    water = ground == GROUND_WATER
    agriculture = (ground == GROUND_AGRICULTURE) & ~water
    supported_ground = np.isin(ground, (GROUND_LOW, GROUND_SEALED, GROUND_BARE))
    high = high_canopy & supported_ground & ~water & ~agriculture
    sealed = (ground == GROUND_SEALED) & ~high & ~water & ~agriculture
    low = (ground == GROUND_LOW) & ~high & ~water & ~agriculture
    bare = (ground == GROUND_BARE) & ~high & ~water & ~agriculture
    locked = ~(water | agriculture | high | sealed | low | bare)
    return {
        "water": water,
        "agriculture": agriculture,
        "high": high,
        "sealed": sealed,
        "low": low,
        "bare": bare,
        "locked": locked,
    }


def xgboost_channels_from_state(ground, high_canopy):
    """Return exclusive Sealed, High, Low, Agriculture and Water channels."""
    surface = upper_surface_masks(ground, high_canopy)
    channels = np.stack([
        surface["sealed"], surface["high"], surface["low"],
        surface["agriculture"], surface["water"],
    ]).astype(np.float32)
    if np.any(channels.sum(axis=0) > 1):
        raise AssertionError("XGBoost upper-surface channels must not overlap.")
    return channels


def xgboost_land_cover_channels(green, sealing, water=None, inside=None):
    """Return five mutually exclusive upper-surface XGBoost channels."""
    ground, high_canopy, _ = baseline_land_cover(green, sealing, water, inside)
    return xgboost_channels_from_state(ground, high_canopy)


def apply_land_cover_operations(
        baseline_ground, baseline_canopy, editable, masks_and_operations):
    """Apply ordered polygon operations to one ground plane and one canopy."""
    baseline_ground = np.asarray(baseline_ground, dtype=np.uint8)
    baseline_canopy = np.asarray(baseline_canopy, dtype=bool)
    editable = np.asarray(editable, dtype=bool)
    if not (baseline_ground.shape == baseline_canopy.shape == editable.shape):
        raise ValueError("Scenario state grids must align.")
    ground = baseline_ground.copy()
    canopy = baseline_canopy.copy()
    touched = np.zeros(editable.shape, dtype=bool)

    for mask, operation in masks_and_operations:
        selected = np.asarray(mask, dtype=bool)
        touched |= selected
        action = operation["action"]
        if action == "restore":
            ground[selected] = baseline_ground[selected]
            canopy[selected] = baseline_canopy[selected]
            continue
        if action == "convert-to-low":
            converted = selected & editable & np.isin(ground, (GROUND_SEALED, GROUND_BARE))
            ground[converted] = GROUND_LOW
            continue
        if action == "remove-high":
            canopy[selected & editable] = False
            continue
        target = operation.get("target")
        if target == "sealed":
            converted = selected & editable & np.isin(ground, (GROUND_LOW, GROUND_BARE))
            ground[converted] = GROUND_SEALED
        elif target == "high":
            converted = selected & editable
            canopy[converted] = True
        else:
            raise ValueError(f"Unsupported scenario target: {target}")

    return ground, canopy, touched


def validate_ground_state(ground, canopy=None):
    """Reject unknown ground values and malformed canopy state."""
    values = np.asarray(ground)
    if not np.isin(values, tuple(GROUND_NAME_BY_CODE)).all():
        raise ValueError("Scenario ground contains an unknown category.")
    if canopy is not None and np.asarray(canopy).shape != values.shape:
        raise ValueError("Scenario canopy must align with the ground grid.")
    return True
