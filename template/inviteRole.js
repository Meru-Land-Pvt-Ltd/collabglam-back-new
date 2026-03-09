// src/template/adminInvite.js

/**
 * @param {{ inviteLink: string, invitedEmail: string, role: string, expiryMinutes?: number }} opts
 */
function adminInviteEmailTemplate(opts) {
  const expiry = opts.expiryMinutes ?? 60;

  const subject = "You're invited to CollabGlam Admin";

  const headline = "You're invited";
  const subText = `You have been invited to CollabGlam Admin as <b>${opts.role}</b>. Click the button below to set your password and activate your account.`;

  const text = `You have been invited to CollabGlam Admin as ${opts.role}.
Set your password using this link: ${opts.inviteLink}
This link expires in ${expiry} minutes.`;

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
                  <div style="font-size:26px;font-weight:800;margin:0 0 10px 0;">${headline}</div>

                  <div style="font-size:14px;line-height:20px;color:#4b5563;margin:0 0 18px 0;">
                    ${subText}
                  </div>

                  <!-- CTA button -->
                  <div style="margin: 18px 0 10px 0;">
                    <a href="${opts.inviteLink}"
                      style="
                        display:inline-block;
                        padding:12px 16px;
                        border-radius:12px;
                        background:#111827;
                        color:#ffffff;
                        text-decoration:none;
                        font-size:14px;
                        font-weight:700;
                      ">
                      Set Password
                    </a>
                  </div>

                  <!-- fallback link -->
                  <div style="font-size:12px;line-height:18px;color:#6b7280;margin-top:10px;">
                    If the button doesn't work, copy and paste this link into your browser:
                    <div style="word-break:break-all;margin-top:6px;color:#111827;">
                      ${opts.inviteLink}
                    </div>
                  </div>

                  <div style="font-size:13px;color:#6b7280;margin-top:14px;">
                    This invite expires in ${expiry} minutes.
                  </div>

                  <div style="font-size:12px;color:#9ca3af;margin-top:14px;">
                    Invited email: <b style="color:#111827">${opts.invitedEmail}</b>
                  </div>
                </td>
              </tr>

              <!-- footer -->
              <tr>
                <td style="border-top:1px solid #eef2f7;padding:16px 22px;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                  If you didn’t expect this invite, you can safely ignore this email.
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

module.exports = { adminInviteEmailTemplate };