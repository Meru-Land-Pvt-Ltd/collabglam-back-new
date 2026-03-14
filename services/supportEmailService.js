require("dotenv").config();
const nodemailer = require("nodemailer");
const {
  buildSupportTicketCreatedUserTemplate,
  buildSupportTicketCreatedTeamTemplate,
  buildSupportReplyTemplate,
  buildSupportStatusUpdatedTemplate,
} = require("../template/buildSupportEmailTemplates");

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "CollabGlam";
const SUPPORT_TEAM_EMAIL = process.env.SUPPORT_TEAM_EMAIL;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

async function sendMail({ to, subject, text, html }) {
  if (!to) return;

  await transporter.sendMail({
    from: `"${MAIL_FROM_NAME}" <${SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  });
}

async function handleSendSupportCreatedToUser({
  email,
  userName,
  role,
  ticketId,
  category,
  relatedCampaignName,
}) {
  if (!email) return;

  const { subject, text, html } = buildSupportTicketCreatedUserTemplate({
    ticketId,
    userName,
    role,
    category,
    relatedCampaignName,
  });

  await sendMail({ to: email, subject, text, html });
}

async function handleSendSupportCreatedToTeam({
  ticketId,
  requesterRole,
  requesterName,
  requesterEmail,
  category,
  relatedCampaignName,
  description,
}) {
  if (!SUPPORT_TEAM_EMAIL) return;

  const { subject, text, html } = buildSupportTicketCreatedTeamTemplate({
    ticketId,
    requesterRole,
    requesterName,
    requesterEmail,
    category,
    relatedCampaignName,
    description,
  });

  await sendMail({ to: SUPPORT_TEAM_EMAIL, subject, text, html });
}

async function handleSendSupportReplyToUser({
  email,
  userName,
  ticketId,
  authorRole,
  textBody,
  status,
}) {
  if (!email) return;

  const { subject, text, html } = buildSupportReplyTemplate({
    ticketId,
    userName,
    authorRole,
    textBody,
    status,
  });

  await sendMail({ to: email, subject, text, html });
}

async function handleSendSupportReplyToTeam({
  ticketId,
  requesterRole,
  authorRole,
  requesterName,
  requesterEmail,
  textBody,
  status,
}) {
  if (!SUPPORT_TEAM_EMAIL) return;

  const subject = `New requester reply • ${ticketId}`;
  const text = [
    `A new reply was posted on support ticket ${ticketId}.`,
    `Requester Role: ${requesterRole}`,
    `Reply Author: ${authorRole}`,
    `Requester Name: ${requesterName || "-"}`,
    `Requester Email: ${requesterEmail || "-"}`,
    status ? `Status: ${status}` : null,
    ``,
    `Message:`,
    textBody || "-",
  ]
    .filter(Boolean)
    .join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;padding:24px;background:#f5f7fb;">
    <div style="max-width:700px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px;">
      <h2 style="margin:0 0 16px 0;">New requester reply</h2>
      <p><b>Ticket ID:</b> ${ticketId}</p>
      <p><b>Requester Role:</b> ${requesterRole}</p>
      <p><b>Reply Author:</b> ${authorRole}</p>
      <p><b>Requester Name:</b> ${requesterName || "-"}</p>
      <p><b>Requester Email:</b> ${requesterEmail || "-"}</p>
      ${status ? `<p><b>Status:</b> ${status}</p>` : ""}
      <div style="margin-top:16px;padding:14px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;white-space:pre-wrap;">${
        textBody || "-"
      }</div>
    </div>
  </div>
  `;

  await sendMail({ to: SUPPORT_TEAM_EMAIL, subject, text, html });
}

async function handleSendSupportStatusUpdatedToUser({
  email,
  userName,
  ticketId,
  status,
}) {
  if (!email) return;

  const { subject, text, html } = buildSupportStatusUpdatedTemplate({
    ticketId,
    userName,
    status,
  });

  await sendMail({ to: email, subject, text, html });
}

module.exports = {
  sendMail,
  handleSendSupportCreatedToUser,
  handleSendSupportCreatedToTeam,
  handleSendSupportReplyToUser,
  handleSendSupportReplyToTeam,
  handleSendSupportStatusUpdatedToUser,
};