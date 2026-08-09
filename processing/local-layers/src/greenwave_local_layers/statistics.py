"""Native-grid area statistics with complete Statbel area denominators."""

from __future__ import annotations

import numpy as np


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
