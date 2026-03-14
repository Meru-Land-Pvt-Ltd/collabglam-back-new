function buildSupportTicketCreatedUserTemplate({
  ticketId,
  userName,
  role,
  category,
  relatedCampaignName,
}) {
  const subject = `We received your support request • ${ticketId}`;

  const text = [
    `Hi ${userName || role},`,
    ``,
    `Your support request has been received successfully.`,
    `Ticket ID: ${ticketId}`,
    `Category: ${category}`,
    relatedCampaignName ? `Campaign: ${relatedCampaignName}` : null,
    ``,
    `Our support team will review it and get back to you soon.`,
    ``,
    `— CollabGlam Support`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>${subject}</title>
    </head>
    <body style="margin:0;padding:0;background:#f5f7fb;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:32px 12px;">
        <tr>
          <td align="center">
            <table role="presentation" width="620" cellspacing="0" cellpadding="0"
              style="width:620px;max-width:100%;background:#ffffff;border:1px solid #e9edf5;border-radius:14px;overflow:hidden;">
              <tr>
                <td style="padding:18px 22px 10px 22px;font-family:Arial,Helvetica,sans-serif;">
                  <div style="font-size:16px;font-weight:700;color:#111827;">CollabGlam</div>
                </td>
              </tr>
              <tr>
                <td style="height:4px;background:#2563eb;"></td>
              </tr>
              <tr>
                <td style="padding:22px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
                  <div style="font-size:26px;font-weight:800;margin:0 0 10px 0;">Support request received</div>
                  <div style="font-size:14px;line-height:22px;color:#4b5563;">
                    Hi ${userName || role},<br/><br/>
                    Your support request has been received successfully.
                  </div>

                  <div style="margin-top:18px;padding:16px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;">
                    <div style="font-size:14px;line-height:22px;color:#111827;"><b>Ticket ID:</b> ${ticketId}</div>
                    <div style="font-size:14px;line-height:22px;color:#111827;"><b>Category:</b> ${category}</div>
                    ${
                      relatedCampaignName
                        ? `<div style="font-size:14px;line-height:22px;color:#111827;"><b>Campaign:</b> ${relatedCampaignName}</div>`
                        : ""
                    }
                  </div>

                  <div style="font-size:14px;line-height:22px;color:#4b5563;margin-top:18px;">
                    Our support team will review it and get back to you soon.
                  </div>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #eef2f7;padding:16px 22px;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                  This is an automated confirmation email from CollabGlam Support.
                </td>
              </tr>
            </table>
            <div style="font-family:Arial,Helvetica,sans-serif;color:#9ca3af;font-size:11px;margin-top:12px;">
              © ${new Date().getFullYear()} CollabGlam
            </div>
          </td>
        </tr>
      </table>
    </body>
  </html>
  `;

  return { subject, text, html };
}

function buildSupportTicketCreatedTeamTemplate({
  ticketId,
  requesterRole,
  requesterName,
  requesterEmail,
  category,
  relatedCampaignName,
  description,
}) {
  const subject = `New support request • ${ticketId} • ${requesterRole}`;

  const text = [
    `A new support request has been created.`,
    ``,
    `Ticket ID: ${ticketId}`,
    `Requester Role: ${requesterRole}`,
    `Requester Name: ${requesterName || "-"}`,
    `Requester Email: ${requesterEmail || "-"}`,
    `Category: ${category}`,
    relatedCampaignName ? `Campaign: ${relatedCampaignName}` : null,
    ``,
    `Description:`,
    description || "-",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
  <!doctype html>
  <html>
    <body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:700px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
        <div style="padding:18px 22px;background:#111827;color:#fff;font-size:18px;font-weight:700;">
          New support request
        </div>
        <div style="padding:22px;color:#111827;">
          <p><b>Ticket ID:</b> ${ticketId}</p>
          <p><b>Requester Role:</b> ${requesterRole}</p>
          <p><b>Requester Name:</b> ${requesterName || "-"}</p>
          <p><b>Requester Email:</b> ${requesterEmail || "-"}</p>
          <p><b>Category:</b> ${category}</p>
          ${
            relatedCampaignName
              ? `<p><b>Campaign:</b> ${relatedCampaignName}</p>`
              : ""
          }
          <div style="margin-top:18px;">
            <div style="font-weight:700;margin-bottom:8px;">Description</div>
            <div style="padding:14px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;white-space:pre-wrap;">${
              description || "-"
            }</div>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;

  return { subject, text, html };
}

function buildSupportReplyTemplate({
  ticketId,
  userName,
  authorRole,
  textBody,
  status,
}) {
  const subject = `New update on your support request • ${ticketId}`;

  const text = [
    `Hi ${userName || "there"},`,
    ``,
    `There is a new reply on your support request.`,
    `Ticket ID: ${ticketId}`,
    `Replied by: ${authorRole}`,
    status ? `Status: ${status}` : null,
    ``,
    `Message:`,
    textBody || "-",
    ``,
    `— CollabGlam Support`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
  <!doctype html>
  <html>
    <body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:700px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
        <div style="padding:18px 22px;background:#2563eb;color:#fff;font-size:18px;font-weight:700;">
          Support request updated
        </div>
        <div style="padding:22px;color:#111827;">
          <p>Hi ${userName || "there"},</p>
          <p>There is a new reply on your support request.</p>
          <p><b>Ticket ID:</b> ${ticketId}</p>
          <p><b>Replied by:</b> ${authorRole}</p>
          ${status ? `<p><b>Status:</b> ${status}</p>` : ""}
          <div style="margin-top:18px;">
            <div style="font-weight:700;margin-bottom:8px;">Message</div>
            <div style="padding:14px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;white-space:pre-wrap;">${
              textBody || "-"
            }</div>
          </div>
        </div>
      </div>
    </body>
  </html>
  `;

  return { subject, text, html };
}

function buildSupportStatusUpdatedTemplate({
  ticketId,
  userName,
  status,
}) {
  const subject = `Support request status updated • ${ticketId}`;

  const text = [
    `Hi ${userName || "there"},`,
    ``,
    `The status of your support request has been updated.`,
    `Ticket ID: ${ticketId}`,
    `New Status: ${status}`,
    ``,
    `— CollabGlam Support`,
  ].join("\n");

  const html = `
  <!doctype html>
  <html>
    <body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:700px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
        <div style="padding:18px 22px;background:#111827;color:#fff;font-size:18px;font-weight:700;">
          Support request status updated
        </div>
        <div style="padding:22px;color:#111827;">
          <p>Hi ${userName || "there"},</p>
          <p>The status of your support request has been updated.</p>
          <p><b>Ticket ID:</b> ${ticketId}</p>
          <p><b>New Status:</b> ${status}</p>
        </div>
      </div>
    </body>
  </html>
  `;

  return { subject, text, html };
}

module.exports = {
  buildSupportTicketCreatedUserTemplate,
  buildSupportTicketCreatedTeamTemplate,
  buildSupportReplyTemplate,
  buildSupportStatusUpdatedTemplate,
};