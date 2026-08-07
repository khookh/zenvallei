"""Native-grid area statistics with complete Statbel area denominators."""

from __future__ import annotations

import numpy as np


# Deprecated TCD support is retained only to read or validate old local caches.
# It is no longer reachable from the active CLI, catalogue or map registry.
TCD_DENSITY_RANGES = ((1, 20), (21, 40), (41, 60), (61, 80), (81, 100))


def _percentage(area: float, complete_area: float) -> float:
    return 0.0 if complete_area <= 0 else area / complete_area * 100.0


def categorical_statistics(values, valid_codes, pixel_area_ha: float, complete_area_ha: float, nodata) -> dict:
    array = np.ma.asarray(values)
    data = np.asarray(array.filled(nodata))
    usable = ~np.ma.getmaskarray(array) & np.isin(data, valid_codes)
    classes = []
    classified_area = 0.0
    for code in valid_codes:
        area = float(np.count_nonzero(usable & (data == code)) * pixel_area_ha)
        classified_area += area
        classes.append({"code": int(code), "areaHa": area, "percentage": _percentage(area, complete_area_ha)})
    no_data = max(0.0, complete_area_ha - classified_area)
    return {
        "completeAreaHa": complete_area_ha,
        "validAreaHa": classified_area,
        "validPercentage": _percentage(classified_area, complete_area_ha),
        "noDataAreaHa": no_data,
        "noDataPercentage": _percentage(no_data, complete_area_ha),
        "classes": classes,
    }


def jaarbak_statistics(values, pixel_area_ha: float, complete_area_ha: float) -> dict:
    result = categorical_statistics(values, (0, 1), pixel_area_ha, complete_area_ha, 255)
    classes = {item["code"]: item for item in result.pop("classes")}
    return {
        **result,
        "unsealedAreaHa": classes[0]["areaHa"],
        "unsealedPercentage": classes[0]["percentage"],
        "sealedAreaHa": classes[1]["areaHa"],
        "sealedPercentage": classes[1]["percentage"],
    }


def tcd_statistics(values, pixel_area_ha: float, complete_area_ha: float, area_weights_ha=None) -> dict:
    """Summarise TCD on its native grid using fractional boundary areas.

    Tree presence counts complete valid pixels whose density is above zero.
    Mean density where present excludes zero-valued pixels. Crown-equivalent
    area sums pixel area multiplied by its density fraction.
    """
    array = np.ma.asarray(values)
    data = np.asarray(array.filled(255), dtype=np.float64)
    usable = ~np.ma.getmaskarray(array) & (data >= 0) & (data <= 100)
    if area_weights_ha is None:
        weights = np.full(data.shape, pixel_area_ha, dtype=np.float64)
        valid_weights = weights[usable]
    else:
        weights = np.asarray(area_weights_ha, dtype=np.float64)
        usable &= weights > 0
        valid_weights = weights[usable]
    valid = data[usable]
    valid_area = float(np.sum(valid_weights))
    no_data = max(0.0, complete_area_ha - valid_area)
    if not valid.size:
        mean = median = None
        crown_area = 0.0
        tree_presence_area = 0.0
        mean_where_present = None
    else:
        mean = float(np.average(valid, weights=valid_weights))
        if area_weights_ha is None:
            median = float(np.median(valid))
        else:
            order = np.argsort(valid)
            sorted_values = valid[order]
            sorted_weights = valid_weights[order]
            midpoint = np.sum(sorted_weights) / 2.0
            median = float(sorted_values[np.searchsorted(np.cumsum(sorted_weights), midpoint, side="left")])
        crown_area = float(np.sum(valid / 100.0 * valid_weights))
        present = valid > 0
        tree_presence_area = float(np.sum(valid_weights[present]))
        mean_where_present = (
            float(np.average(valid[present], weights=valid_weights[present]))
            if tree_presence_area > 0 else None
        )
    zero_density_area = max(0.0, valid_area - tree_presence_area)
    density_classes = []
    for minimum, maximum in TCD_DENSITY_RANGES:
        in_class = (valid >= minimum) & (valid <= maximum)
        area = float(np.sum(valid_weights[in_class]))
        density_classes.append({
            "minimum": minimum,
            "maximum": maximum,
            "areaHa": area,
            "sectorPercentage": _percentage(area, complete_area_ha),
            "treePresencePercentage": _percentage(area, tree_presence_area),
        })
    return {
        "completeAreaHa": complete_area_ha,
        "validAreaHa": valid_area,
        "validPercentage": _percentage(valid_area, complete_area_ha),
        "noDataAreaHa": no_data,
        "noDataPercentage": _percentage(no_data, complete_area_ha),
        "meanDensity": mean,
        "medianDensity": median,
        "zeroDensityAreaHa": zero_density_area,
        "zeroDensityPercentage": _percentage(zero_density_area, complete_area_ha),
        "treePresenceAreaHa": tree_presence_area,
        "treePresencePercentage": _percentage(tree_presence_area, complete_area_ha),
        "meanDensityWherePresent": mean_where_present,
        "densityClasses": density_classes,
        "crownEquivalentAreaHa": crown_area,
    }
