// src/template/brandOutreach.js

const escapeHtml = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const textToHtml = (text) => {
  const safe = escapeHtml(text);
  return safe.replace(/\n/g, "<br/>");
};

/**
 * @param {{
 *  subject: string,
 *  toEmail: string,
 *  headline?: string,
 *  introHtml?: string,
 *  bodyText?: string,
 *  bodyHtml?: string,
 *  footerNote?: string
 * }} opts
 */
function brandOutreachEmailTemplate(opts) {
  const subject = opts.subject;

  const headline = opts.headline || "Collaboration Opportunity";
  const introHtml =
    opts.introHtml ||
    `We’d love to collaborate with you. Please reply to this email for next steps.`;

  const textBody = String(opts.bodyText || "").trim();
  const htmlBody =
    (opts.bodyHtml && String(opts.bodyHtml).trim()) ||
    (textBody ? textToHtml(textBody) : "");

  const text = [
    String(introHtml).replace(/<[^>]+>/g, ""), // remove tags
    "",
    textBody || "",
    "",
    `Sent to: ${opts.toEmail}`,
  ]
    .join("\n")
    .trim();

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

              <!-- top brand bar -->
              <tr>
                <td style="padding:18px 22px 10px 22px;font-family:Arial,Helvetica,sans-serif;">
                  <div style="font-size:16px;font-weight:700;color:#111827;">CollabGlam</div>
                </td>
              </tr>
              <tr>
                <td style="height:4px;background:#ff7a00;"></td>
              </tr>

              <!-- content -->
              <tr>
                <td style="padding:22px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
                  <div style="font-size:26px;font-weight:800;margin:0 0 10px 0;">${escapeHtml(headline)}</div>

                  <div style="font-size:14px;line-height:20px;color:#4b5563;margin:0 0 18px 0;">
                    ${introHtml}
                  </div>

                  <div style="font-size:14px;line-height:22px;color:#111827;margin-top:10px;">
                    ${htmlBody}
                  </div>

                  ${opts.footerNote
      ? `<div style="font-size:12px;color:#6b7280;margin-top:16px;">${opts.footerNote}</div>`
      : ""
    }

                  <div style="font-size:12px;color:#9ca3af;margin-top:14px;">
                    Sent to: <b style="color:#111827">${escapeHtml(opts.toEmail)}</b>
                  </div>
                </td>
              </tr>

              <!-- footer -->
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

module.exports = { brandOutreachEmailTemplate };