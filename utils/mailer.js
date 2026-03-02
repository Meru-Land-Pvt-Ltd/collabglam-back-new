// utils/mailer.js
"use strict";

const nodemailer = require("nodemailer");

let transporter = null;

function createTransporter() {
  // 1) Prefer SMTP_URL (provider style)
  // Example: smtps://user:pass@smtp.gmail.com:465
  const smtpUrl = process.env.SMTP_URL;
  if (smtpUrl) {
    return nodemailer.createTransport(smtpUrl);
  }

  // 2) Fallback: host/port/user/pass style
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      "Email config missing. Set SMTP_URL or (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)."
    );
  }

  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

function getTransporter() {
  if (!transporter) transporter = createTransporter();
  return transporter;
}

async function sendEmail({ to, subject, text, html, headers = {} }) {
  if (!to) throw new Error("Recipient email (to) is required");

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

  return { providerId: info?.messageId ? String(info.messageId) : "" };
}

// Backward-compatible alias (so older code that imports sendMail still works)
async function sendMail({ to, subject, text, html }) {
  return sendEmail({ to, subject, text, html });
}

module.exports = { sendEmail, sendMail, getTransporter };
