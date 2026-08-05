export const PALETTE = Object.freeze({
  "no-data": "#EAE2DE",
  "score-0": "#97D8E5",
  "score-1": "#6EC3ED",
  "score-2": "#6AA7F0",
  "score-3": "#8E85E2",
  "score-4": "#B657BA",
  "score-5": "#CC017A",
  "score-6": "#B10064",
  "score-7": "#96004E",
  "score-8": "#7C003A",
  "score-9": "#610027",
  "score-10": "#000000",
  "institution-present-no-score": "#F1CE63",
});

export const VULNERABILITY_COMPONENTS = Object.freeze([
  { key: "populationDensity", sourceColumn: "Inwonersdichtheid", label: "Inwonersdichtheid", group: "Bevolking", groupKey: "population", weight: 1 },
  { key: "age0To9", sourceColumn: "0-9 jaar", label: "0- tot 9-jarigen", group: "Bevolking", groupKey: "population", weight: 1 },
  { key: "age65Plus", sourceColumn: ">65 jaar", label: "65-plussers", group: "Bevolking", groupKey: "population", weight: 1 },
  { key: "primaryEducation", sourceColumn: "Basisonderwijs", label: "Basisonderwijs", group: "Kwetsbare voorzieningen", groupKey: "facilities", weight: 0.5 },
  { key: "childcare", sourceColumn: "Kinderopvang", label: "Kinderopvang", group: "Kwetsbare voorzieningen", groupKey: "facilities", weight: 0.5 },
  { key: "residentialElderlyCare", sourceColumn: "Residentiële ouderenzorg", label: "Residentiële ouderenzorg", group: "Kwetsbare voorzieningen", groupKey: "facilities", weight: 0.5 },
  { key: "hospitals", sourceColumn: "Ziekenhuizen", label: "Ziekenhuizen", group: "Kwetsbare voorzieningen", groupKey: "facilities", weight: 0.5 },
  { key: "sesIndex", sourceColumn: "SES index", label: "SES-index", group: "Sociaal-economisch", groupKey: "socioeconomic", weight: 2 },
  { key: "trees50m", sourceColumn: "Bomen 50m", label: "Bomen binnen 50 m", group: "Groen", groupKey: "green", weight: 0.5 },
  { key: "neighborhoodGreen", sourceColumn: "Buurtgroen", label: "Buurtgroen", group: "Groen", groupKey: "green", weight: 0.5 },
]);

export const SES_COMPONENTS = Object.freeze([
  { key: "singleParentFamilies", sourceColumn: "Eenoudergezinnen", label: "Eenoudergezinnen" },
  { key: "rentalHousing", sourceColumn: "Huurwoningen", label: "Huurwoningen" },
  { key: "income", sourceColumn: "Inkomen", label: "Inkomen" },
  { key: "lowEducation", sourceColumn: "Laaggeschoolden", label: "Laag opleidingsniveau" },
  { key: "nonEuCitizen", sourceColumn: "Niet EU-burger", label: "Niet-EU-burgers" },
  { key: "jobSeekers", sourceColumn: "Werkzoekenden", label: "Werkzoekenden" },
  { key: "pre1945Housing", sourceColumn: "Woningen voor 1945", label: "Woningen van vóór 1945" },
  { key: "livingArea", sourceColumn: "Woonoppervlakte", label: "Woonoppervlakte" },
]);

export const EXPECTED_MUNICIPALITY_COUNTS = Object.freeze({
  Beersel: 39,
  Drogenbos: 7,
  Halle: 41,
  Linkebeek: 7,
  Pepingen: 15,
  "Sint-Genesius-Rode": 22,
  "Sint-Pieters-Leeuw": 23,
});

export const SOURCES = Object.freeze({
  scores: {
    label: "Vlaamse overheid, Departement Zorg: Cijfers hittekwetsbaarheid 2026",
    pageUrl: "https://www.departementzorg.be/nl/hittekwetsbaarheidskaart-vlaanderen",
    downloadUrl: "https://cld.webplatform.departementzorg.be/raw/upload/v1785223345/Cijfers_hittekwetsbaarheid_2026_jvhnl1.xlsx",
    filename: "Cijfers_hittekwetsbaarheid_2026_jvhnl1.xlsx",
    expectedSha256: "43a2be5942f7739310eeeeeed9961a03f3fb213c8acf777643a6270d5b6a8bba",
  },
  manual: {
    label: "Vlaamse overheid, Departement Zorg: Handleiding hittekwetsbaarheid 2026",
    downloadUrl: "https://cld.webplatform.departementzorg.be/raw/upload/v1778503586/Handleiding_hittekwetsbaarheidstool_2026_nyhdbz.docx",
  },
  geometry: {
    label: "Statbel: Statistische sectoren 2024",
    pageUrl: "https://statbel.fgov.be/en/open-data/statistical-sectors-2024",
    downloadUrl: "https://statbel.fgov.be/sites/default/files/files/opendata/Statistische%20sectoren/sh_statbel_statistical_sectors_3812_20240101.geojson.zip",
    filename: "sh_statbel_statistical_sectors_3812_20240101.geojson.zip",
    expectedSha256: "90d5d995e75f586d24fddc416f9aa3baafef794de8c2883af0054a03f958c6f8",
    snapshotDate: "2024-01-01",
    sourceCrs: "EPSG:3812",
    accuracy: "1:10.000",
  },
  osm: {
    label: "© OpenStreetMap contributors",
    copyrightUrl: "https://www.openstreetmap.org/copyright",
    tilePolicyUrl: "https://operations.osmfoundation.org/policies/tiles/",
  },
});
