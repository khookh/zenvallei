import { t } from "./i18n.js";

/**
 * Stable public names for the organisations behind the source data. Preparation
 * manifests retain exact upstream identifiers, while UI modules use these keys
 * so the same producer is never presented under several English names.
 */
export const SOURCE_AUTHORITIES = Object.freeze({
  governmentFlanders: { labelKey: "authority.governmentFlanders" },
  departmentCare: { labelKey: "authority.departmentCare" },
  departmentEnvironment: { labelKey: "authority.departmentEnvironment" },
  natureForests: { labelKey: "authority.natureForests" },
  digitalFlanders: { labelKey: "authority.digitalFlanders" },
  agricultureFisheries: { labelKey: "authority.agricultureFisheries" },
  statbel: { labelKey: "authority.statbel" },
  copernicusClms: { labelKey: "authority.copernicusClms" },
  landsat: { labelKey: "authority.landsat" },
  meteorologicalInstitute: { labelKey: "authority.meteorologicalInstitute" },
});

export function authorityName(authorityId) {
  const authority = SOURCE_AUTHORITIES[authorityId];
  if (!authority) throw new TypeError(`Unknown source authority '${authorityId}'.`);
  return t(authority.labelKey);
}

export function authorityLink(authorityId, url) {
  return { authorityId, label: authorityName(authorityId), url };
}
