// templates/invitationTemplate.js

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Prevent javascript: links etc.
function safeUrl(url, fallback = '#') {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    return fallback;
  } catch {
    return fallback;
  }
}

function buildInvitationEmail(ctx) {
  const brandName = ctx.brandName || 'Brand';
  const influencerName = ctx.influencerName || 'Creator';
  const campaignTitle = ctx.campaignTitle || 'our campaign';
  const campaignObjective = ctx.campaignObjective || 'N/A';
  const deliverables = ctx.deliverables || 'To be discussed with you.';
  const compensation = ctx.compensation || 'To be discussed based on scope.';
  const timeline = ctx.timeline || 'Flexible / To be discussed';
  const additionalNotes = ctx.additionalNotes || '';

  const campaignLink = safeUrl(ctx.campaignLink, '#'); // ✅ use it
  const subject = `Invitation to Collaborate on "${campaignTitle}" – ${brandName}`;

  const htmlBody = `
  <div style="font-family: Arial, sans-serif; font-size: 14px; color: #111827; line-height: 1.6; background-color:#f9fafb; padding:24px;">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
      <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;">
        <h2 style="margin:0;font-size:20px;color:#111827;">Invitation to Collaborate</h2>
        <p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Powered by CollabGlam</p>
      </div>
      <div style="padding:20px 24px;">
        <p>Dear ${escapeHtml(influencerName)},</p>

        <p>I hope you are doing well.</p>

        <p>
          We are reaching out to formally invite you to collaborate with
          <strong>${escapeHtml(brandName)}</strong> for our upcoming campaign,
          “<strong>${escapeHtml(campaignTitle)}</strong>.”
          Based on your creative work and audience alignment, we believe you would be an excellent fit for this project.
        </p>

        <h3 style="margin-top:24px;margin-bottom:8px;font-size:16px;color:#111827;">Campaign Details</h3>

        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tbody>
            <tr>
              <td style="padding:6px 0;font-weight:bold;width:160px;color:#374151;">Campaign Name:</td>
              <td style="padding:6px 0;color:#111827;">${escapeHtml(campaignTitle)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;color:#374151;">Brand:</td>
              <td style="padding:6px 0;color:#111827;">${escapeHtml(brandName)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;color:#374151;">Objective:</td>
              <td style="padding:6px 0;color:#111827;">${escapeHtml(campaignObjective)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;color:#374151;">Deliverables Required:</td>
              <td style="padding:6px 0;color:#111827;">${escapeHtml(deliverables)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;color:#374151;">Compensation:</td>
              <td style="padding:6px 0;color:#111827;">${escapeHtml(compensation)}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;font-weight:bold;color:#374151;">Campaign Timeline:</td>
              <td style="padding:6px 0;color:#111827;">${escapeHtml(timeline)}</td>
            </tr>
            ${additionalNotes ? `<tr>
              <td style="padding:6px 0;font-weight:bold;color:#374151;">Additional Notes:</td>
              <td style="padding:6px 0;color:#111827;">${escapeHtml(additionalNotes)}</td>
            </tr>` : ''}
          </tbody>
        </table>

        <p style="margin-top:20px;">
          To proceed, please review the full brief using the button below:
        </p>

        <!-- ✅ CTA Button -->
        <div style="margin:16px 0 8px;text-align:center;">
          <a
            href="${escapeHtml(campaignLink)}"
            target="_blank"
            rel="noopener noreferrer"
            style="
              display:inline-block;
              background:#FFBF00;
              color:#111827;
              padding:12px 18px;
              border-radius:10px;
              text-decoration:none;
              font-weight:700;
            "
          >
            View Campaign
          </a>
        </div>

        <!-- ✅ Fallback link -->
        <p style="margin:0 0 14px;font-size:12px;color:#6b7280;text-align:center;word-break:break-word;">
          If the button doesn’t work, copy and paste this link:<br/>
          <a href="${escapeHtml(campaignLink)}" style="color:#2563eb;">${escapeHtml(campaignLink)}</a>
        </p>

        <p>If you have any questions or need further clarification, feel free to contact the brand or reach out to CollabGlam Support.</p>

        <p>
          We look forward to the opportunity of working together and hope to have you onboard for this campaign.
        </p>

        <p style="margin-top:24px;">
          Warm regards,<br/>
          <strong>Team CollabGlam</strong>
        </p>
      </div>
      <div style="padding:12px 24px;border-top:1px solid #e5e7eb;background:#f9fafb;">
        <p style="margin:0;font-size:11px;color:#9ca3af;">
          This invitation was sent via CollabGlam. Your direct contact details are kept private until you choose to share them.
        </p>
      </div>
    </div>
  </div>
  `;

  const textBody = [
    `Subject: Invitation to Collaborate on "${campaignTitle}" – ${brandName}`,
    '',
    `Dear ${influencerName},`,
    '',
    'I hope you are doing well.',
    '',
    `We are reaching out to formally invite you to collaborate with ${brandName} for our upcoming campaign, "${campaignTitle}".`,
    '',
    'Campaign Details',
    `Campaign Name: ${campaignTitle}`,
    `Brand: ${brandName}`,
    `Objective: ${campaignObjective}`,
    `Deliverables Required: ${deliverables}`,
    `Compensation: ${compensation}`,
    `Campaign Timeline: ${timeline}`,
    additionalNotes ? `Additional Notes: ${additionalNotes}` : '',
    '',
    `View Campaign: ${campaignLink}`, // ✅ add link to text email too
    '',
    'Warm regards,',
    'Team CollabGlam',
  ].filter(Boolean).join('\n');

  return { subject, htmlBody, textBody };
}

module.exports = { buildInvitationEmail };
