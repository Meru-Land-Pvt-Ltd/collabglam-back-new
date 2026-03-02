"use strict";

const nodemailer = require("nodemailer");

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const smtpUrl = process.env.SMTP_URL; // e.g. smtps://user:pass@host:465
  if (!smtpUrl) {
    throw new Error("SMTP_URL is missing. Set SMTP_URL to enable email sending.");
  }

  transporter = nodemailer.createTransport(smtpUrl);
  return transporter;
}

async function sendEmail({ to, subject, text, html, headers = {} }) {
  const from = process.env.MAIL_FROM || "CollabGlam <no-reply@collabglam.com>";
  const t = getTransporter();

  const info = await t.sendMail({
    from,
    to,
    subject,
    text,
    html,
    headers,
  });

  return { providerId: info && info.messageId ? String(info.messageId) : "" };
}

module.exports = { sendEmail };
