/* @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  ARTIFICIAL_CODES,
  GREEN_CODES,
  URBAN_ATLAS_CLASSES,
  buildClassManifest,
  buildSectorStatistics,
  indexMultiPolygonRings,
  indexedMultiPolygonBounds,
  parseUrbanAtlasStyle,
  subsetIndexedMultiPolygon,
  validateOfficialStyle,
} from "../scripts/lib/urban-atlas-core.mjs";
import {
  URBAN_ATLAS_SOURCE,
  URBAN_ATLAS_ARTIFACTS,
  assertAccessTokenIsFresh,
  fetchCdseDownload,
  readAccessTokenClaims,
} from "../scripts/prepare-urban-atlas.mjs";

function jwt(claims) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

function officialSldFixture() {
  return `<StyledLayerDescriptor xmlns:se="http://www.opengis.net/se" xmlns:ogc="http://www.opengis.net/ogc">
    ${URBAN_ATLAS_CLASSES.map((entry) => `<se:Rule>
      <se:Name>${entry.code}: Label ${entry.code}</se:Name>
      <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>code_2021</ogc:PropertyName><ogc:Literal>${entry.code}</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
      <se:PolygonSymbolizer><se:Fill><se:SvgParameter name="fill">${entry.color}</se:SvgParameter></se:Fill></se:PolygonSymbolizer>
    </se:Rule>`).join("\n")}
  </StyledLayerDescriptor>`;
}

describe("Urban Atlas preparation contract", () => {
  it("pins the exact official BE001L3 source", () => {
    expect(URBAN_ATLAS_SOURCE).toMatchObject({
      dataset: "clms_ua_land-cover-land-use_europe_V025ha_3yearly_v1",
      fuaCode: "BE001L3",
      year: 2021,
      productName: "CLMS_UA_LCU_S2021_V025ha_BE001L3_BRUXELLES_BRUSSEL_LEUVEN_03035_V01_R01_20250730",
      productId: "cb6a69ee-dbd7-41ec-bc35-d705d5d71b33",
      expectedBytes: 178900771,
      expectedMd5: "eae385ced547b8fab079e33fa81e03fd",
      productModificationDate: "2026-07-22T21:48:38.905590Z",
      crs: "EPSG:3035",
    });
    expect(URBAN_ATLAS_SOURCE.doi).toContain("05ae1ee1-e550-4e66-b74d-4926322d981a");
    expect(URBAN_ATLAS_ARTIFACTS).toEqual(expect.arrayContaining([
      expect.objectContaining({ byteLength: 178900771, md5: "eae385ced547b8fab079e33fa81e03fd" }),
      expect.objectContaining({ byteLength: 178900904, md5: "88ad99ffdf56d86755519771501fb059" }),
    ]));
  });

  it("parses and verifies every exact official SLD colour", () => {
    const parsed = parseUrbanAtlasStyle(officialSldFixture());
    expect(parsed).toHaveLength(URBAN_ATLAS_CLASSES.length);
    expect(validateOfficialStyle(parsed)).toBe(true);
    expect(Object.fromEntries(parsed.map(({ code, color }) => [code, color])))
      .toEqual(Object.fromEntries(URBAN_ATLAS_CLASSES.map(({ code, color }) => [code, color])));
    const manifest = buildClassManifest(parsed, new Set(["11100", "14110", "32000"]));
    expect(manifest.filter(({ present }) => present).map(({ code }) => code)).toEqual(["11100", "14110", "32000"]);
  });

  it("uses exactly the requested green and artificialisation classes", () => {
    expect(GREEN_CODES).toEqual(["14110", "14120", "14130", "23000", "31000", "32000"]);
    expect(ARTIFICIAL_CODES).toEqual([
      "11100", "11210", "11220", "11230", "11240", "11300", "12100",
      "12210", "12220", "12230", "12300", "12400", "13100", "13300", "13400",
    ]);
    expect(GREEN_CODES.some((code) => ARTIFICIAL_CODES.includes(code))).toBe(false);
  });

  it("includes pastures and herbaceous vegetation while excluding arable land and sport", () => {
    const sectorAreas = new Map([["sector", 1_000_000]]);
    const classAreas = new Map([["sector", new Map([
      ["32000", 200_000],
      ["31000", 100_000],
      ["14110", 50_000],
      ["23000", 150_000],
      ["21000", 100_000],
      ["14200", 100_000],
      ["11100", 300_000],
    ])]]);
    const stats = buildSectorStatistics(sectorAreas, classAreas).sector;
    expect(stats.green.areaHa).toBe(50);
    expect(stats.green.percentage).toBe(50);
    expect(stats.green.classes.find(({ code }) => code === "32000").areaHa).toBe(20);
    expect(stats.green.classes.find(({ code }) => code === "23000").areaHa).toBe(15);
    expect(stats.artificial.areaHa).toBe(30);
    expect(stats.otherClasses.map(({ code }) => code).sort()).toEqual(["14200", "21000"]);
    expect(stats.green.classes).toHaveLength(6);
  });

  it("excludes no-data classes from the denominator and retains explicit zero green rows", () => {
    const stats = buildSectorStatistics(
      new Map([["sector", 1_000_000]]),
      new Map([["sector", new Map([["91000", 100_000], ["11100", 800_000]])]]),
    ).sector;
    expect(stats.validAreaHa).toBe(80);
    expect(stats.noDataAreaHa).toBe(20);
    expect(stats.artificial.percentage).toBe(100);
    expect(stats.green.classes.map(({ areaHa }) => areaHa)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects an expired access token before starting a large download", () => {
    const token = jwt({ exp: 1_700_000_000, azp: "cdse-public" });
    expect(readAccessTokenClaims(token)).toMatchObject({ exp: 1_700_000_000, azp: "cdse-public" });
    expect(() => assertAccessTokenIsFresh(token, 1_700_000_001_000)).toThrow(/verlopen/);
  });

  it("preserves authorization across trusted CDSE redirects", async () => {
    const token = jwt({ exp: 4_000_000_000, azp: "cdse-public" });
    const requests = [];
    const mockedFetch = async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://catalogue.dataspace.copernicus.eu/download/file" },
        });
      }
      return new Response("product", { status: 200 });
    };
    const response = await fetchCdseDownload("https://download.dataspace.copernicus.eu/product", token, mockedFetch);
    expect(response.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests.every(({ options }) => options.headers.Authorization === `Bearer ${token}`)).toBe(true);
    expect(requests.every(({ options }) => options.redirect === "manual")).toBe(true);
  });

  it("spatially excludes irrelevant holes without changing relevant vertices", () => {
    const exterior = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
    const relevantHole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
    const irrelevantHole = [[15, 15], [17, 15], [17, 17], [15, 17], [15, 15]];
    const indexed = indexMultiPolygonRings([[exterior, relevantHole, irrelevantHole]]);
    expect(indexedMultiPolygonBounds(indexed)).toEqual([0, 0, 20, 20]);
    const subset = subsetIndexedMultiPolygon(indexed, [1, 1, 5, 5]);
    expect(subset).toEqual([[exterior, relevantHole]]);
    expect(subset[0][0]).toBe(exterior);
    expect(subset[0][1]).toBe(relevantHole);
  });
});
