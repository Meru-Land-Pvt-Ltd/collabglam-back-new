"use strict";

/**
 * Canonical contract statuses (spec-first).
 * NOTE: Legacy statuses are supported for READ during migration only.
 */
const CONTRACT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  BRAND_SENT_DRAFT: "BRAND_SENT_DRAFT",
  BRAND_EDITED: "BRAND_EDITED",
  INFLUENCER_EDITED: "INFLUENCER_EDITED",
  BRAND_ACCEPTED: "BRAND_ACCEPTED",
  INFLUENCER_ACCEPTED: "INFLUENCER_ACCEPTED",
  BRAND_FINAL_UPADTE:"BRAND_FINAL_UPDATE",
  READY_TO_SIGN: "READY_TO_SIGN",
  CONTRACT_SIGNED: "CONTRACT_SIGNED",
  MILESTONES_CREATED: "MILESTONES_CREATED",
  REJECTED: "REJECTED",
  SUPERSEDED: "SUPERSEDED",
});
// "Influencer.LegalName": c?.influencer?.legalName || contract.influencerName || "",
//     "Influencer.ContactName": c?.influencer?.contactName || c?.influencer?.legalName || "",
//     "Influencer.PostingHandleUrl": c?.influencer?.postingHandleUrl || "",
//     "Influencer.ContactEmail": c?.influencer?.email || "",
//     "Influencer.ContactPhone": c?.influencer?.phone || "",
//     "Influencer.Address1": c?.influencer?.addressLine1 || contract.influencerAddress || "",
//     "Influencer.Address2": c?.influencer?.addressLine2 || contract.influencerAddress || "",
//     "Influencer.city": c?.influencer?.city || contract.influencerAddress || "",
//     "Influencer.state": c?.influencer?.state || contract.influencerAddress || "",
//     "Influencer.country": c?.influencer?.country || contract.influencerAddress || "",
//     "Influencer.state": c?.influencer?.state || contract.influencerAddress || "",
/**
 * Legacy statuses (readable during migration).
 * On WRITE, always store canonical.
 */
const LEGACY_STATUS_MAP = Object.freeze({
  draft: CONTRACT_STATUS.DRAFT,
  sent: CONTRACT_STATUS.BRAND_SENT_DRAFT,
  viewed: CONTRACT_STATUS.BRAND_SENT_DRAFT,
  negotiation: CONTRACT_STATUS.BRAND_SENT_DRAFT,
  finalize: CONTRACT_STATUS.READY_TO_SIGN,
  signing: CONTRACT_STATUS.READY_TO_SIGN,
  locked: CONTRACT_STATUS.CONTRACT_SIGNED,
  rejected: CONTRACT_STATUS.REJECTED,
});

const NEGOTIATION_STATUSES = Object.freeze([
  CONTRACT_STATUS.BRAND_SENT_DRAFT,
  CONTRACT_STATUS.BRAND_EDITED,
  CONTRACT_STATUS.INFLUENCER_EDITED,
  CONTRACT_STATUS.BRAND_ACCEPTED,
  CONTRACT_STATUS.INFLUENCER_ACCEPTED,
]);

module.exports = {
  CONTRACT_STATUS,
  LEGACY_STATUS_MAP,
  NEGOTIATION_STATUSES,
};
