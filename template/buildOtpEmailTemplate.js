function buildOtpEmailTemplate(opts) {
    const expiry = opts.expiryMinutes ?? 10;
  
    // format OTP like: 7 6 6 5 9 0
    const otpSpaced = String(opts.otp).split("").join(" ");
  
    const subject = "Verify your email";
    const text = `Use this verification code to continue signing up as a ${opts.role}: ${opts.otp}. This code expires in ${expiry} minutes.`;
  
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
                  <td style="height:4px;background:#ff7a00;"></td>
                </tr>
  
                <tr>
                  <td style="padding:22px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
                    <div style="font-size:26px;font-weight:800;margin:0 0 10px 0;">Verify your email</div>
                    <div style="font-size:14px;line-height:20px;color:#4b5563;margin:0 0 18px 0;">
                      Use this verification code to continue signing up as a <b>${opts.role}</b>.
                    </div>
  
                    <div style="
                      display:inline-block;
                      padding:14px 18px;
                      border-radius:12px;
                      background:#fff4e6;
                      border:1px solid #ffd8a8;
                      font-size:28px;
                      font-weight:800;
                      letter-spacing:2px;
                      color:#111827;
                    ">
                      ${otpSpaced}
                    </div>
  
                    <div style="font-size:13px;color:#6b7280;margin-top:10px;">
                      This code expires in ${expiry} minutes.
                    </div>
                  </td>
                </tr>
  
                <tr>
                  <td style="border-top:1px solid #eef2f7;padding:16px 22px;font-family:Arial,Helvetica,sans-serif;color:#6b7280;font-size:12px;line-height:18px;">
                    If you didn’t request this, you can safely ignore this email.
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
  
  module.exports = { buildOtpEmailTemplate };