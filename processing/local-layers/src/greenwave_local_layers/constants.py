"""Pinned source identities and display semantics.

Source values remain independent from presentation colours. The colours below
are used only while creating visual PMTiles derivatives.
"""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
CACHE_ROOT = PROJECT_ROOT / ".cache" / "local-layers"
SECTORS_PATH = PROJECT_ROOT / "public" / "data" / "sectors.geojson"

MUNICIPALITIES = (
    "Beersel", "Drogenbos", "Halle", "Linkebeek", "Pepingen",
    "Sint-Genesius-Rode", "Sint-Pieters-Leeuw",
)

JAARBAK_YEARS = tuple(range(2018, 2025))
GROENKAART_YEARS = (2018, 2021)
TCD_YEARS = tuple(range(2018, 2025))
LANDGEBRUIK_YEARS = (2019, 2022, 2025)

MERCATOR_WCS = "https://www.mercator.vlaanderen.be/raadpleegdienstenmercatorpubliek/ows"
ANB_WCS = "https://geo.api.vlaanderen.be/anb/wcs"
ANB_WMS = "https://geo.api.vlaanderen.be/ANB/wms"
AGPA_FEATURES = "https://geoservices.landbouwvlaanderen.be/AGPA/ogc/features/v1"
TCD_CATALOGUE = (
    "https://s3.waw3-1.cloudferro.com/swift/v1/CatalogueCSV/"
    "landcover_landuse/tree_cover_density/"
    "clms_vlcc_tree-cover-density_europe_10m_yearly_v1/"
    "clms_vlcc_tree-cover-density_europe_10m_yearly_v1_cog.csv"
)
CDSE_DOWNLOAD = "https://download.dataspace.copernicus.eu/odata/v1/Products"
TCD_STYLE = (
    "https://raw.githubusercontent.com/eu-cdse/sentinel-hub-custom-scripts/main/"
    "clms/land-cover-and-land-use-mapping/tree-cover-and-forests/tree-cover-density/"
    "tree-cover-density/clms_vlcc_tree-cover-density_europe_10m_yearly_v1/scripts/"
    "tree_cover_density.js"
)

JAARBAK_LAYERS = {
    **{year: f"lc:lc_jaarbak_1m_{year}" for year in range(2018, 2022)},
    2022: "lc_jaarbak_1m_2022",
    2023: "lc_jaarbak_1m_2023",
    2024: "lc_jaarbak_1m_2024",
}
JAARBAK_DOWNLOADS = {
    2022: (
        "https://datasets.omgeving.vlaanderen.be/"
        "be.vlaanderen.omgeving.distribution.geo.a2cabea1-3e28-51f5-8533-047c2ff8a1d2."
        "lc_jaarbak_1m_2022_tiff"
    ),
    **{
        year: (
            "https://dataplatform.omgeving.vlaanderen.be/public/mercatornet/"
            f"lc_jaarbak_1m_{year}/lc_jaarbak_1m_{year}?format=tiff"
        )
        for year in (2023, 2024)
    },
}

JAARBAK_CLASSES = (
    {"value": 0, "label": {"en": "Unsealed", "nl": "Niet afgedekt"}, "color": "#8ecf7c"},
    {"value": 1, "label": {"en": "Sealed", "nl": "Afgedekt"}, "color": "#e8292f"},
)
GROENKAART_CLASSES = (
    {"value": 1, "label": {"en": "High green", "nl": "Hoog groen"}, "color": "#1f7f00"},
    {"value": 2, "label": {"en": "Low green", "nl": "Laag groen"}, "color": "#bfff00"},
    {"value": 3, "label": {"en": "Agriculture", "nl": "Landbouw"}, "color": "#ffff00"},
    {"value": 4, "label": {"en": "Non-green", "nl": "Niet groen"}, "color": "#adadad"},
)

# Landgebruik Vlaanderen is a three-yearly 10 m classification. These values
# and colours are read directly from the official 2019, 2022 and 2025 WMS style.
LANDGEBRUIK_LAYERS = {
    year: f"lu:lu_landgebruik_vlaa_{year}_v3" for year in LANDGEBRUIK_YEARS
}
LANDGEBRUIK_CLASSES = (
    {"value": 1, "sourceLabel": "Huizen en tuinen", "color": "#ff0000", "group": "settlement"},
    {"value": 2, "sourceLabel": "Industrie", "color": "#8400a8", "group": "economic"},
    {"value": 3, "sourceLabel": "Commerciële doeleinden", "color": "#ff00c5", "group": "economic"},
    {"value": 4, "sourceLabel": "Diensten", "color": "#002673", "group": "economic"},
    {"value": 5, "sourceLabel": "Transportinfrastructuur", "color": "#686868", "group": "infrastructure"},
    {"value": 6, "sourceLabel": "Recreatie", "color": "#ffaa00", "group": "recreation"},
    {"value": 7, "sourceLabel": "Landbouwgebouwen en -infrastructuur", "color": "#a87000", "group": "agriculture"},
    {"value": 8, "sourceLabel": "Overige bebouwde terreinen", "color": "#cccccc", "group": "settlement"},
    {"value": 9, "sourceLabel": "Overige onbebouwde terreinen", "color": "#828282", "group": "other"},
    {"value": 10, "sourceLabel": "Actieve groeves", "color": "#dfe6a9", "group": "other"},
    {"value": 11, "sourceLabel": "Luchthavens", "color": "#df73ff", "group": "infrastructure"},
    {"value": 12, "sourceLabel": "Bos", "color": "#267300", "group": "nature"},
    {"value": 13, "sourceLabel": "Akker", "color": "#ffffbe", "group": "agriculture"},
    {"value": 14, "sourceLabel": "Grasland in landbouwgebruik", "color": "#a3ff73", "group": "agriculture"},
    {"value": 15, "sourceLabel": "Struikgewas", "color": "#897044", "group": "nature"},
    {"value": 16, "sourceLabel": "Braakliggend en duinen", "color": "#ffd37f", "group": "nature"},
    {"value": 17, "sourceLabel": "Water", "color": "#005ce6", "group": "water"},
    {"value": 18, "sourceLabel": "Moeras", "color": "#00a884", "group": "nature"},
    {"value": 19, "sourceLabel": "Overige graslanden", "color": "#82ca5b", "group": "nature"},
)

# The source publishes the crop groups in Dutch. Group labels can be translated
# in the UI, while exact crop titles remain unmodified source attributes.
AGPA_CROP_GROUP_COLORS = {
    "Landbouwinfrastructuur": "#CC66CC",
    "Groenten, kruiden en sierplanten": "#FF7FFF",
    "Grasland": "#BFFF7F",
    "Voedergewassen": "#FFFF7F",
    "Aardappelen": "#7F1F00",
    "Suikerbieten": "#7F5F00",
    "Granen, zaden en peulvruchten": "#FFDF7F",
    "Maïs": "#FFFF00",
    "Vlas en hennep": "#7FFFFF",
    "Overige gewassen": "#CCCC66",
    "Fruit en Noten": "#FFBF7F",
    "Houtachtige gewassen": "#7FCC66",
    "Water": "#7FBFFF",
}
