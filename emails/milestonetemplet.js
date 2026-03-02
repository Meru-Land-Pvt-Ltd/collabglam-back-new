// email/milestoenemailtemp.js
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@example.com';

// ---------- Transport ----------

let transporter = null;

function getTransporter() {
  if (!transporter) {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      console.warn(
        '[milestone-email] SMTP not fully configured. Emails will be skipped.'
      );
      return null;
    }

    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // true for 465, false for others
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
  return transporter;
}

// ---------- Base HTML Template ----------

function baseTemplate({
  preheader,
  title,
  subtitle,
  statusLabel,
  statusColor,
  amountText,
  campaignName,
  brandName,
  milestoneTitle,
  milestoneDescription,
  extraNote,
  ctaUrl,
  ctaLabel,
}) {
  const safe = (v) => (v == null ? '' : String(v));

  return `
  <!doctype html>
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${safe(title)}</title>
      <style>
        /* Basic reset */
        body {
          margin: 0;
          padding: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background-color: #f5f5f5;
          color: #111827;
        }
        a {
          color: inherit;
        }
        .btn:hover {
          filter: brightness(1.05);
        }
        @media (max-width: 600px) {
          .card {
            padding: 20px !important;
          }
          h1 {
            font-size: 20px !important;
          }
        }
      </style>
    </head>
    <body>
      <!-- Preheader (hidden in most clients) -->
      <span style="
        display:none;
        font-size:1px;
        color:#f5f5f5;
        line-height:1px;
        max-height:0;
        max-width:0;
        opacity:0;
        overflow:hidden;
      ">
        ${safe(preheader)}
      </span>

      <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
        <tr>
          <td align="center" style="padding: 32px 16px;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width: 640px;">
              <!-- Header -->
              <tr>
                <td align="center" style="
                  padding: 18px 24px;
                  border-radius: 16px 16px 0 0;
                  background: linear-gradient(90deg, #FFA135, #FF7236);
                  color: #ffffff;
                  font-weight: 600;
                  font-size: 14px;
                  letter-spacing: 0.08em;
                  text-transform: uppercase;
                ">
                  CollabGlam · Milestone Update
                </td>
              </tr>

              <!-- Card -->
              <tr>
                <td class="card" style="
                  background-color: #ffffff;
                  padding: 28px 28px 24px 28px;
                  border-radius: 0 0 16px 16px;
                  box-shadow: 0 15px 40px rgba(15, 23, 42, 0.15);
                  border-top: 1px solid rgba(249, 115, 22, 0.25);
                ">
                  <h1 style="margin: 0 0 8px 0; font-size: 22px; font-weight: 700;">
                    ${safe(title)}
                  </h1>
                  ${
                    subtitle
                      ? `<p style="margin: 0 0 16px 0; font-size: 14px; color: #4b5563;">
                          ${safe(subtitle)}
                        </p>`
                      : ''
                  }

                  <!-- Status pill -->
                  ${
                    statusLabel
                      ? `<div style="margin: 12px 0 18px 0;">
                          <span style="
                            display: inline-block;
                            padding: 6px 12px;
                            border-radius: 999px;
                            font-size: 11px;
                            font-weight: 600;
                            letter-spacing: 0.06em;
                            text-transform: uppercase;
                            color: #111827;
                            background-color: ${safe(statusColor) || '#FEF3C7'};
                          ">
                            ${safe(statusLabel)}
                          </span>
                        </div>`
                      : ''
                  }

                  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="
                    border-collapse: separate;
                    border-spacing: 0 8px;
                    margin-bottom: 12px;
                  ">
                    ${
                      brandName
                        ? `<tr>
                            <td style="font-size: 13px; color: #6b7280; width: 120px;">Brand</td>
                            <td style="font-size: 14px; color: #111827; font-weight: 500;">
                              ${safe(brandName)}
                            </td>
                          </tr>`
                        : ''
                    }
                    ${
                      campaignName
                        ? `<tr>
                            <td style="font-size: 13px; color: #6b7280; width: 120px;">Campaign</td>
                            <td style="font-size: 14px; color: #111827; font-weight: 500;">
                              ${safe(campaignName)}
                            </td>
                          </tr>`
                        : ''
                    }
                    ${
                      milestoneTitle
                        ? `<tr>
                            <td style="font-size: 13px; color: #6b7280;">Milestone</td>
                            <td style="font-size: 14px; color: #111827; font-weight: 500;">
                              ${safe(milestoneTitle)}
                            </td>
                          </tr>`
                        : ''
                    }
                    ${
                      amountText
                        ? `<tr>
                            <td style="font-size: 13px; color: #6b7280;">Amount</td>
                            <td style="font-size: 16px; color: #16a34a; font-weight: 700;">
                              ${safe(amountText)}
                            </td>
                          </tr>`
                        : ''
                    }
                  </table>

                  ${
                    milestoneDescription
                      ? `<div style="
                            margin: 12px 0 18px 0;
                            padding: 12px 14px;
                            border-radius: 12px;
                            background-color: #f9fafb;
                            border: 1px dashed #e5e7eb;
                          ">
                          <div style="font-size: 12px; text-transform: uppercase; font-weight: 600; color: #9ca3af; margin-bottom: 4px;">
                            Milestone Description
                          </div>
                          <div style="font-size: 14px; color: #374151; line-height: 1.5;">
                            ${safe(milestoneDescription)}
                          </div>
                        </div>`
                      : ''
                  }

                  ${
                    extraNote
                      ? `<p style="margin: 0 0 18px 0; font-size: 13px; color: #4b5563;">
                            ${safe(extraNote)}
                         </p>`
                      : ''
                  }

                  ${
                    ctaUrl && ctaLabel
                      ? `<div style="margin: 8px 0 18px 0;">
                          <a
                            href="${safe(ctaUrl)}"
                            target="_blank"
                            class="btn"
                            style="
                              display: inline-block;
                              padding: 10px 18px;
                              font-size: 14px;
                              font-weight: 600;
                              color: #111827;
                              text-decoration: none;
                              border-radius: 999px;
                              background: linear-gradient(90deg, #FFBF00, #FFDB58);
                              box-shadow: 0 8px 20px rgba(245, 158, 11, 0.3);
                            "
                          >
                            ${safe(ctaLabel)}
                          </a>
                        </div>`
                      : ''
                  }

                  <p style="margin: 8px 0 0 0; font-size: 11px; color: #9ca3af; line-height: 1.5;">
                    You can always see the latest status of this milestone from your
                    CollabGlam dashboard.
                  </p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td align="center" style="padding-top: 16px; font-size: 11px; color: #9ca3af;">
                  © ${new Date().getFullYear()} CollabGlam. All rights reserved.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>
`;
}

// ---------- Specific Email Templates ----------

function buildCreatedHtml({
  influencerName,
  brandName,
  campaignName,
  milestoneTitle,
  amount,
  milestoneDescription,
  dashboardUrl,
}) {
  const amountText = `$${Number(amount || 0).toFixed(2)}`;
  const title = `New milestone created for ${campaignName || 'your campaign'}`;
  const subtitle = influencerName
    ? `Hi ${influencerName}, a new milestone has been created for you.`
    : `A new milestone has been created for your collaboration.`;

  return baseTemplate({
    preheader: `New milestone created: ${milestoneTitle} — ${amountText}`,
    title,
    subtitle,
    statusLabel: 'Milestone Created',
    statusColor: '#DBEAFE', // soft blue
    amountText,
    campaignName,
    brandName,
    milestoneTitle,
    milestoneDescription,
    extraNote:
      'Once the brand confirms your work and releases the funds, the payout will be initiated to your selected payment method.',
    ctaUrl: dashboardUrl,
    ctaLabel: 'View milestone in dashboard',
  });
}

function buildReleasedHtml({
  influencerName,
  brandName,
  campaignName,
  milestoneTitle,
  amount,
  milestoneDescription,
  dashboardUrl,
}) {
  const amountText = `$${Number(amount || 0).toFixed(2)}`;
  const title = `Payout initiated for your milestone`;
  const subtitle = influencerName
    ? `Hi ${influencerName}, ${brandName || 'the brand'} has released your milestone funds.`
    : `The brand has released milestone funds for your collaboration.`;

  return baseTemplate({
    preheader: `Payout initiated: ${milestoneTitle} — ${amountText}`,
    title,
    subtitle,
    statusLabel: 'Payout Initiated',
    statusColor: '#FEF3C7', // amber
    amountText,
    campaignName,
    brandName,
    milestoneTitle,
    milestoneDescription,
    extraNote:
      'Our team will now review and process this payout. You should typically receive the amount within 24–48 hours, depending on your payment method.',
    ctaUrl: dashboardUrl,
    ctaLabel: 'Track payout status',
  });
}

function buildPaidHtml({
  influencerName,
  brandName,
  campaignName,
  milestoneTitle,
  amount,
  milestoneDescription,
  dashboardUrl,
}) {
  const amountText = `$${Number(amount || 0).toFixed(2)}`;
  const title = `Payment completed for your milestone`;
  const subtitle = influencerName
    ? `Hi ${influencerName}, your payout has been approved and marked as paid.`
    : `Your milestone payout has been successfully completed.`;

  return baseTemplate({
    preheader: `Payout completed: ${milestoneTitle} — ${amountText}`,
    title,
    subtitle,
    statusLabel: 'Paid',
    statusColor: '#DCFCE7', // green
    amountText,
    campaignName,
    brandName,
    milestoneTitle,
    milestoneDescription,
    extraNote:
      'If you do not see the funds in your account within the next few hours (or per your bank’s processing times), please contact support with this milestone reference.',
    ctaUrl: dashboardUrl,
    ctaLabel: 'View payment receipt',
  });
}

// ---------- Sending helpers (all to influencer) ----------

async function sendEmail({ to, subject, html }) {
  const tx = getTransporter();
  if (!tx) {
    console.warn('[milestone-email] Transporter not configured. Skipping email.');
    return;
  }

  const mailOptions = {
    from: SMTP_FROM,
    to,
    subject,
    html,
  };

  await tx.sendMail(mailOptions);
}

/**
 * 1) New milestone created
 */
async function sendMilestoneCreatedEmail({
  to,
  influencerName,
  brandName,
  campaignName,
  milestoneTitle,
  amount,
  milestoneDescription,
  dashboardUrl,
}) {
  const html = buildCreatedHtml({
    influencerName,
    brandName,
    campaignName,
    milestoneTitle,
    amount,
    milestoneDescription,
    dashboardUrl,
  });
  const subject = `New milestone created: ${milestoneTitle || 'Campaign milestone'}`;
  await sendEmail({ to, subject, html });
}

/**
 * 2) Milestone released by brand → payout initiated
 */
async function sendMilestoneReleasedEmail({
  to,
  influencerName,
  brandName,
  campaignName,
  milestoneTitle,
  amount,
  milestoneDescription,
  dashboardUrl,
}) {
  const html = buildReleasedHtml({
    influencerName,
    brandName,
    campaignName,
    milestoneTitle,
    amount,
    milestoneDescription,
    dashboardUrl,
  });
  const subject = `Payout initiated: ${milestoneTitle || 'Campaign milestone'}`;
  await sendEmail({ to, subject, html });
}

/**
 * 3) Admin updated status → paid
 */
async function sendMilestonePaidEmail({
  to,
  influencerName,
  brandName,
  campaignName,
  milestoneTitle,
  amount,
  milestoneDescription,
  dashboardUrl,
}) {
  const html = buildPaidHtml({
    influencerName,
    brandName,
    campaignName,
    milestoneTitle,
    amount,
    milestoneDescription,
    dashboardUrl,
  });
  const subject = `Payout completed: ${milestoneTitle || 'Campaign milestone'}`;
  await sendEmail({ to, subject, html });
}

module.exports = {
  sendMilestoneCreatedEmail,
  sendMilestoneReleasedEmail,
  sendMilestonePaidEmail,
};
