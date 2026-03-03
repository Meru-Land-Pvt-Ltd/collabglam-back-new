// src/template/collabOpportunity.js

const escapeHtml = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * @param {{ influencerName: string, campaignTitle: string, replyToEmail?: string }} opts
 */
function collabOpportunityTemplate(opts) {
  const subject = "Collab Opportunity";

  const name = String(opts.influencerName || "").trim() || "there";
  const campaignTitle = String(opts.campaignTitle || "").trim() || "our campaign";

  const headline = "Collaboration Opportunity";
  const introHtml = `
    Hi <b>${escapeHtml(name)}</b>,<br/><br/>
    We’d love to collaborate with you on <b>${escapeHtml(campaignTitle)}</b>.
    Please reply to this email and we’ll share the next steps.
  `.trim();

  const text = `
Hi ${name},

We’d love to collaborate with you on "${campaignTitle}".
Reply to this email and we’ll share the next steps.
`.trim();

  const html = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>${escapeHtml(subject)}</title>
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
                <td style="height:4px;background:#ff7a00;"></td>
              </tr>

              <tr>
                <td style="padding:22px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
                  <div style="font-size:26px;font-weight:800;margin:0 0 10px 0;">${escapeHtml(headline)}</div>

                  <div style="font-size:14px;line-height:22px;color:#111827;margin-top:10px;">
                    ${introHtml}
                  </div>

                  <div style="font-size:12px;line-height:18px;color:#6b7280;margin-top:16px;">
                    Reply directly to this email to continue the conversation.
                  </div>

                  ${opts.replyToEmail
      ? `<div style="font-size:12px;color:#9ca3af;margin-top:10px;">
                          Reply-to: <b style="color:#111827">${escapeHtml(opts.replyToEmail)}</b>
                        </div>`
      : ""
    }
                </td>
              </tr>

              <tr>
                <td style="border-top:1px solid #eef2f7;padding:16px 22px;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                  If you didn’t expect this email, you can safely ignore it.
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
  `.trim();

  return { subject, text, html };
}

module.exports = { collabOpportunityTemplate };