"use strict";

const SITE_URL = "https://collabglam.com";

// ✅ Add these
const SUPPORT_EMAIL = "help@collabglam.com";
const COMPANY_ADDRESS = `8825 PERIMETER PARK BLVD STE 501
JACKSONVILLE, FL 32216-1123
USA`;

const absUrl = (pathPlaceholder) =>
  `${SITE_URL}/${String(pathPlaceholder).replace(/^\/+/, "")}`;

const THEME = {
  brand: {
    ctaClass: "bg-gradient-to-r from-[#FFA135] to-[#FF7236] text-white",
    ctaBg: "linear-gradient(90deg,#FFA135,#FF7236)",
    ctaText: "#ffffff",
  },
  influencer: {
    ctaClass: "bg-gradient-to-r from-[#FFBF00] to-[#FFDB58] text-gray-800",
    ctaBg: "linear-gradient(90deg,#FFBF00,#FFDB58)",
    ctaText: "#1F2937",
  },
};

// ✅ Updated footer (unsubscribe removed)
const baseFooterText = `
Need help? Contact us at ${SUPPORT_EMAIL}.

${COMPANY_ADDRESS}
`.trim();

// ✅ Updated footer HTML (unsubscribe removed + address fixed)
const baseFooterHtml = `
<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#555;">
  Need help? Contact us at <a href="mailto:${SUPPORT_EMAIL}" style="color:#111;">${SUPPORT_EMAIL}</a>.
</p>
<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:#777;">
  8825 PERIMETER PARK BLVD STE 501<br/>
  JACKSONVILLE, FL 32216-1123<br/>
  USA<br/>
</p>
`.trim();

function wrapHtml({
  theme = "brand",
  preheader,
  title,
  intro,
  bullets = [],
  ctaLabel,
}) {
  const t = THEME[theme] || THEME.brand;

  const bulletHtml = bullets.length
    ? `<ul style="margin:12px 0 0;padding-left:18px;color:#111;font-size:14px;line-height:1.6;">
        ${bullets.map((b) => `<li style="margin:6px 0;">${b}</li>`).join("")}
      </ul>`
    : "";

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    ${preheader || ""}
  </div>

  <div style="max-width:560px;margin:0 auto;padding:18px 12px;">
    <div style="background:#fff;border:1px solid #e7e9ee;border-radius:14px;padding:18px;">
      <h1 style="margin:0 0 10px;font-size:18px;line-height:1.3;color:#111;">${title}</h1>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#111;">${intro}</p>

      ${bulletHtml}

      <div style="margin-top:16px;">
        <a
          href="${absUrl("{CTAUrl}")}"
          class="${t.ctaClass}"
          style="display:inline-block;background:${t.ctaBg};color:${t.ctaText};text-decoration:none;padding:12px 14px;border-radius:10px;font-weight:600;font-size:14px;"
        >
          ${ctaLabel}
        </a>
      </div>

      <p style="margin:12px 0 0;font-size:13px;line-height:1.6;color:#555;">
        If the button doesn’t work, open this link: <br/>
        <a href="${absUrl("{PlatformLink}")}" style="color:#111;word-break:break-all;">${absUrl("{PlatformLink}")}</a>
      </p>

      ${baseFooterHtml}
    </div>

    <p style="margin:10px 0 0;text-align:center;font-size:12px;color:#999;">
      Contract ID: {ContractId} • Version: {VersionNumber}
    </p>
  </div>
</body>
</html>
`.trim();
}

module.exports = {
  // 1) Brand sends first contract draft → Influencer gets “New Contract Received”
  contract_new_received_influencer: {
    event: "contract.new_received",
    recipients: ["influencer"],
    subject: "New contract from {BrandName} to review",
    subject_alt: [
      "{BrandName} sent a contract for review",
      "Contract ready for your review: {ContractName}",
    ],
    preheader: "{UserName}, review and respond to keep the collaboration moving.",
    preheader_alt: "Open the contract, suggest edits, or accept the terms.",
    cta_label: "Review contract",
    body_text: `
Hi {UserName},

We’ve sent you a new contract from {BrandName} for {ContractName} (v{VersionNumber}).

What to do next:
- Open the contract
- Add edits or comments if needed
- Accept the terms when you’re ready

Review here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "influencer",
      preheader: "{UserName}, review and respond to keep the collaboration moving.",
      title: "New contract to review",
      intro:
        "We’ve sent you a new contract from <strong>{BrandName}</strong> for <strong>{ContractName}</strong> (v{VersionNumber}).",
      bullets: [
        "Open the contract to review the latest terms",
        "Add edits/comments if needed (unlimited rounds)",
        "Accept when everything looks right",
      ],
      ctaLabel: "Review contract",
    }),
  },

  // 2) Influencer inactive after 30 minutes → Influencer gets reminder
  contract_action_reminder_influencer: {
    event: "contract.reminder",
    recipients: ["influencer"],
    subject: "Reminder: contract needs your review",
    subject_alt: [
      "Still pending: your contract review",
      "Action needed: {ContractName} (v{VersionNumber})",
    ],
    preheader: "Open the latest version to edit or accept when ready.",
    preheader_alt: "This is a quick reminder to keep things moving.",
    cta_label: "Open contract",
    body_text: `
Hi {UserName},

Quick reminder — {ContractName} (v{VersionNumber}) is waiting on your review.

Open the latest version here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "influencer",
      preheader: "Open the latest version to edit or accept when ready.",
      title: "Reminder: action needed",
      intro:
        "<strong>{ContractName}</strong> (v{VersionNumber}) is still waiting on your review.",
      bullets: ["Open the latest version", "Add edits or accept the terms"],
      ctaLabel: "Open contract",
    }),
  },

  // 3) Influencer submits comments/edits → Brand notified
  contract_updated_by_influencer_brand_notify: {
    event: "contract.updated_by_influencer",
    recipients: ["brand"],
    subject: "{InfluencerName} updated the contract",
    subject_alt: [
      "Contract edits from {InfluencerName}",
      "Review changes: {ContractName} (v{VersionNumber})",
    ],
    preheader: "Review the latest version and accept when ready.",
    preheader_alt: "Open to see what changed in this version.",
    cta_label: "Review updates",
    body_text: `
Hi {UserName},

{InfluencerName} submitted updates to {ContractName} (v{VersionNumber}).

Next steps:
- Review the latest version
- Accept the terms if everything looks good (this will lock edits once both accept)

Open here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "brand",
      preheader: "Review the latest version and accept when ready.",
      title: "Contract updated by influencer",
      intro:
        "<strong>{InfluencerName}</strong> submitted updates to <strong>{ContractName}</strong> (v{VersionNumber}).",
      bullets: [
        "Review the latest version",
        "Accept the terms when ready",
        "Once both sides accept, editing is locked and signing can begin",
      ],
      ctaLabel: "Review updates",
    }),
  },

  // (symmetry) Brand submits edits → Influencer notified (needed for your actual backend)
  contract_updated_by_brand_influencer_notify: {
    event: "contract.updated_by_brand",
    recipients: ["influencer"],
    subject: "{BrandName} updated the contract",
    subject_alt: [
      "New edits from {BrandName}",
      "Please review: {ContractName} (v{VersionNumber})",
    ],
    preheader: "Open the latest version to review and accept again.",
    preheader_alt: "A new version is ready for your review.",
    cta_label: "Review updates",
    body_text: `
Hi {UserName},

{BrandName} updated {ContractName} (v{VersionNumber}).

Next steps:
- Review the latest version
- Add edits if needed
- Accept the terms again when you’re ready

Open here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "influencer",
      preheader: "Open the latest version to review and accept again.",
      title: "Contract updated by brand",
      intro:
        "<strong>{BrandName}</strong> updated <strong>{ContractName}</strong> (v{VersionNumber}).",
      bullets: [
        "Review the latest version",
        "Add edits/comments if needed",
        "Accept again when ready",
      ],
      ctaLabel: "Review updates",
    }),
  },

  // 4) Brand inactive after 30 minutes → Brand gets reminder
  contract_action_reminder_brand: {
    event: "contract.reminder",
    recipients: ["brand"],
    subject: "Reminder: contract needs your action",
    subject_alt: [
      "Pending: your contract review",
      "Action needed: {ContractName} (v{VersionNumber})",
    ],
    preheader: "Review the latest version and accept when ready.",
    preheader_alt: "Open the contract to continue.",
    cta_label: "Open contract",
    body_text: `
Hi {UserName},

Quick reminder — {ContractName} (v{VersionNumber}) is waiting on your action.

Open here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "brand",
      preheader: "Review the latest version and accept when ready.",
      title: "Reminder: action needed",
      intro:
        "<strong>{ContractName}</strong> (v{VersionNumber}) is still waiting on your action.",
      bullets: ["Open the latest version", "Review and accept if ready"],
      ctaLabel: "Open contract",
    }),
  },

  // 5) Brand accepts (notify influencer)
  contract_accepted_by_brand_influencer_notify: {
    event: "contract.accepted_by_brand",
    recipients: ["influencer"],
    subject: "{BrandName} accepted the latest terms",
    subject_alt: [
      "Brand accepted: {ContractName} (v{VersionNumber})",
      "Update: brand approved this version",
    ],
    preheader: "If you’ve accepted too, signing will be available next.",
    preheader_alt: "Open to confirm the current version.",
    cta_label: "View contract",
    body_text: `
Hi {UserName},

{BrandName} accepted {ContractName} (v{VersionNumber}).

If you’ve accepted this version too, editing is locked and signing is next.

Open here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "influencer",
      preheader: "If you’ve accepted too, signing will be available next.",
      title: "Brand accepted the latest version",
      intro:
        "<strong>{BrandName}</strong> accepted <strong>{ContractName}</strong> (v{VersionNumber}).",
      bullets: [
        "If you’ve accepted this version too, editing will be locked",
        "Signing becomes available once both sides accept",
      ],
      ctaLabel: "View contract",
    }),
  },

  // 6) Influencer accepts → Brand notified
  contract_accepted_by_influencer_brand_notify: {
    event: "contract.accepted_by_influencer",
    recipients: ["brand"],
    subject: "{InfluencerName} accepted the contract terms",
    subject_alt: [
      "Influencer accepted: {ContractName} (v{VersionNumber})",
      "Next step: your acceptance to proceed",
    ],
    preheader: "Accept this version to lock edits and move to signing.",
    preheader_alt: "Open the latest version and confirm acceptance.",
    cta_label: "Review & accept",
    body_text: `
Hi {UserName},

{InfluencerName} accepted {ContractName} (v{VersionNumber}).

Next step: review this version and accept when ready. Once both accept, editing is locked and signing can begin.

Open here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "brand",
      preheader: "Accept this version to lock edits and move to signing.",
      title: "Influencer accepted the terms",
      intro:
        "<strong>{InfluencerName}</strong> accepted <strong>{ContractName}</strong> (v{VersionNumber}).",
      bullets: [
        "Review this version",
        "Accept when ready",
        "Once both accept, editing is locked and signing can begin",
      ],
      ctaLabel: "Review & accept",
    }),
  },

  // 7) Both accept → Ready to Sign (editing locked)
  contract_ready_to_sign_both: {
    event: "contract.ready_to_sign",
    recipients: ["both"],
    subject: "Contract ready for signing (edits locked)",
    subject_alt: [
      "Ready to sign: {ContractName}",
      "Next step: signatures for {ContractName}",
    ],
    preheader: "Both sides accepted the latest version. Add signatures next.",
    preheader_alt: "Open the contract to sign.",
    cta_label: "Sign contract",
    body_text: `
Hi {UserName},

Both sides accepted {ContractName} (v{VersionNumber}). Editing is now locked.

Next step: add signatures to complete the contract.

Sign here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      // NOTE: if you want brand/influencer-specific gradients here too,
      // send this template twice (once per role) OR split into two templates.
      theme: "brand",
      preheader: "Both sides accepted the latest version. Add signatures next.",
      title: "Ready for signing",
      intro:
        "Both sides accepted <strong>{ContractName}</strong> (v{VersionNumber}). Editing is now locked.",
      bullets: [
        "Open the contract to add your signature",
        "Once all required signatures are complete, we’ll confirm",
      ],
      ctaLabel: "Sign contract",
    }),
  },

  // 7.5) Brand signed but contract not fully signed yet → notify influencer to sign
  contract_signed_by_brand_influencer_notify: {
    event: "contract.signed_by_brand",
    recipients: ["influencer"],
    subject: "{BrandName} signed the contract — your signature is next",
    subject_alt: [
      "Signature needed: complete {ContractName}",
      "{BrandName} signed — please sign to finish",
    ],
    preheader: "Add your signature to complete the contract.",
    preheader_alt: "Open the contract and sign to finalize.",
    cta_label: "Sign now",
    body_text: `
Hi {UserName},

Good news — {BrandName} has signed {ContractName} (v{VersionNumber}).

Next step: please add your signature to complete the contract.

Sign here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "influencer",
      preheader: "Add your signature to complete the contract.",
      title: "Brand signed — your signature is next",
      intro:
        "<strong>{BrandName}</strong> has signed <strong>{ContractName}</strong> (v{VersionNumber}).",
      bullets: [
        "Open the contract to review the final version",
        "Add your signature to complete the agreement",
      ],
      ctaLabel: "Sign now",
    }),
  },

  // 7.6) Influencer signed but contract not fully signed yet → notify brand to sign
  contract_signed_by_influencer_brand_notify: {
    event: "contract.signed_by_influencer",
    recipients: ["brand"],
    subject: "{InfluencerName} signed — please sign to complete the contract",
    subject_alt: [
      "Signature needed: complete {ContractName}",
      "{InfluencerName} signed — your signature is next",
    ],
    preheader: "Add your signature to complete the contract.",
    preheader_alt: "Open the contract and sign to finalize.",
    cta_label: "Sign now",
    body_text: `
Hi {UserName},

{InfluencerName} has signed {ContractName} (v{VersionNumber}).

Next step: please add your signature to complete the contract.

Sign here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "brand",
      preheader: "Add your signature to complete the contract.",
      title: "Influencer signed — your signature is next",
      intro:
        "<strong>{InfluencerName}</strong> has signed <strong>{ContractName}</strong> (v{VersionNumber}).",
      bullets: [
        "Open the contract to review the final version",
        "Add your signature to complete the agreement",
      ],
      ctaLabel: "Sign now",
    }),
  },

  // 8) Contract fully signed → success email to both
  contract_fully_signed_both: {
    event: "contract.fully_signed",
    recipients: ["both"],
    subject: "Contract fully signed ✅",
    subject_alt: [
      "Signed and complete: {ContractName}",
      "Success: all signatures received",
    ],
    preheader: "Your contract is complete and locked for changes.",
    preheader_alt: "Open to view the final signed contract.",
    cta_label: "View signed contract",
    body_text: `
Hi {UserName},

All required signatures are complete for {ContractName}. Your contract is now signed and locked.

View it here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "brand",
      preheader: "Your contract is complete and locked for changes.",
      title: "Contract fully signed",
      intro:
        "All required signatures are complete for <strong>{ContractName}</strong>. Your contract is now signed and locked.",
      bullets: ["Open anytime to view the signed version", "Next: milestones (if applicable)"],
      ctaLabel: "View signed contract",
    }),
  },

  // 9) Milestones created after signing → notify both
  contract_milestones_created_both: {
    event: "contract.milestones_created",
    recipients: ["both"],
    subject: "Milestones created for your contract",
    subject_alt: [
      "Milestones are set: {ContractName}",
      "Next steps: milestones added",
    ],
    preheader: "Open the contract to review milestones and due dates.",
    preheader_alt: "Milestones are now available in CollabGlam.",
    cta_label: "View milestones",
    body_text: `
Hi {UserName},

Milestones were created for {ContractName}. You can review the milestone list and timelines in CollabGlam.

Open here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "brand",
      preheader: "Open the contract to review milestones and due dates.",
      title: "Milestones created",
      intro:
        "Milestones were created for <strong>{ContractName}</strong>. You can review the list and timelines in CollabGlam.",
      bullets: ["Open the contract to see milestones", "Track progress as you deliver"],
      ctaLabel: "View milestones",
    }),
  },

  // 10) Contract rejected/declined → notify both
  contract_declined_both: {
    event: "contract.declined",
    recipients: ["both"],
    subject: "Contract was declined",
    subject_alt: ["Update: contract declined", "{ContractName} status update"],
    preheader: "Open CollabGlam to review details and next steps.",
    preheader_alt: "You can resend or revise the contract if needed.",
    cta_label: "View contract",
    body_text: `
Hi {UserName},

{ContractName} was declined. You can open CollabGlam to review details and decide next steps.

Open here: ${absUrl("{PlatformLink}")}

${baseFooterText}
`.trim(),
    body_html: wrapHtml({
      theme: "brand",
      preheader: "Open CollabGlam to review details and next steps.",
      title: "Contract declined",
      intro:
        "<strong>{ContractName}</strong> was declined. You can open CollabGlam to review details and decide next steps.",
      bullets: ["Open the contract for details", "If needed, revise and resend"],
      ctaLabel: "View contract",
    }),
  },
};
