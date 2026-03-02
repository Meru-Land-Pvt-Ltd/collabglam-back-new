const nodemailer = require('nodemailer');
require('dotenv').config();

/**
 * Combined file containing:
 * - disputeCreatedTemplate
 * - disputeResolvedTemplate
 * - disputeAgainstYouTemplate
 * - transporter setup
 * - controller functions
 */

// -------------------------
// Templates
// -------------------------
function disputeCreatedTemplate({ userName, ticketId, category }) {
  return {
    subject: `We’ve received your dispute (#${ticketId})`,
    html: `
     <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
      <!-- Header -->
      <div style="padding: 20px; text-align: center;">
        <h2 style="margin: 0; font-size: 24px;">CollabGlam</h2>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);"></div>

      <div style="padding: 20px;">
        <p>Hi ${userName},</p>
        <p>Thank you for reaching out. Your dispute has been successfully submitted.</p>
        <p>Our support team will review it and get back to you shortly.</p>

        <p><strong>Ticket ID:</strong> ${ticketId}</p>
        <p><strong>Subject:</strong> ${category}</p>

        <p>You can track your dispute anytime from your dashboard under <b>“My Disputes.”</b></p>
        <br>
        <p>— The CollabGlam Support Team</p>
      </div>
     </div>
    `,
  };
}

function disputeResolvedTemplate({ userName, ticketId, resolutionSummary }) {
  return {
    subject: `Your dispute (#${ticketId}) has been resolved`,
    html: `
     <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 16px; overflow: hidden; background-color: #ffffff;">
      <!-- Header -->
      <div style="padding: 20px; text-align: center;">
        <h2 style="margin: 0; font-size: 24px;">CollabGlam</h2>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);"></div>

      <div style="padding: 20px;">
        <p>Hi ${userName},</p>
        <p>We’re happy to let you know that your dispute (Ticket #${ticketId}) has been resolved.</p>

        <p><strong>Resolution Summary:</strong></p>
        <p>${resolutionSummary}</p>

        <p>If you believe this issue needs further review, you can reply within 7 days to reopen the case.</p>
        <p>Thank you for your patience and cooperation.</p>

        <br>
        <p>— CollabGlam Support</p>
      </div>
     </div>
    `,
  };
}

function disputeAgainstYouTemplate({
  userName,
  ticketId,
  category,
  raisedBy,
  raisedByRole,
  campaignName
}) {
  const roleLabel = raisedByRole === 'Brand' ? 'brand' : 'influencer';

  return {
    subject: `A dispute has been raised against you (#${ticketId})`,
    html: `
      <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
        <!-- Header -->
        <div style="padding: 20px; text-align: center;">
          <h2 style="margin: 0; font-size: 24px;">CollabGlam</h2>
        </div>
        <div style="height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);"></div>

        <div style="padding: 20px;">
          <p>Hi ${userName},</p>
          <p>${raisedBy || 'A user'} (${roleLabel}) has raised a dispute involving you.</p>

          ${
            campaignName
              ? `<p><strong>Campaign:</strong> ${campaignName}</p>`
              : ''
          }

          <p><strong>Ticket ID:</strong> ${ticketId}</p>
          <p><strong>Subject:</strong> ${category}</p>

          <p>
            Please review the dispute details and respond from your dashboard under
            <b>"Disputes"</b>.
          </p>

          <br />
          <p>— CollabGlam Support</p>
        </div>
      </div>
    `,
  };
}

// -------------------------
// Nodemailer transporter
// -------------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Transporter check (optional)
transporter.verify((err, success) => {
  if (err) {
    console.warn('SMTP verification failed:', err.message);
  } else {
    console.log('SMTP transporter ready');
  }
});

// -------------------------
// Core Email Logic
// -------------------------
async function handleSendDisputeCreated({ email, userName, ticketId, category }) {
  if (!email || !userName || !ticketId) {
    throw new Error('email, userName, and ticketId are required');
  }
  const template = disputeCreatedTemplate({ userName, ticketId, category });
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: template.subject,
    html: template.html,
  });
}

async function handleSendDisputeResolved({ email, userName, ticketId, resolutionSummary }) {
  if (!email || !userName || !ticketId || !resolutionSummary) {
    throw new Error('email, userName, ticketId, and resolutionSummary are required');
  }
  const template = disputeResolvedTemplate({ userName, ticketId, resolutionSummary });
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: template.subject,
    html: template.html,
  });
}

async function handleSendDisputeAgainstYou({
  email,
  userName,
  ticketId,
  category,
  raisedBy,
  raisedByRole,
  campaignName
}) {
  if (!email || !userName || !ticketId) {
    throw new Error('email, userName, and ticketId are required');
  }

  const template = disputeAgainstYouTemplate({
    userName,
    ticketId,
    category,
    raisedBy,
    raisedByRole,
    campaignName
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: template.subject,
    html: template.html
  });
}

// -------------------------
// Controller functions (for routes)
// -------------------------
async function sendDisputeCreated(req, res) {
  try {
    await handleSendDisputeCreated(req.body);
    res.json({ success: true, message: 'Dispute created email sent' });
  } catch (err) {
    console.error('sendDisputeCreated Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function sendDisputeResolved(req, res) {
  try {
    await handleSendDisputeResolved(req.body);
    res.json({ success: true, message: 'Dispute resolved email sent' });
  } catch (err) {
    console.error('sendDisputeResolved Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  sendDisputeCreated,
  sendDisputeResolved,
  handleSendDisputeCreated,
  handleSendDisputeResolved,
  handleSendDisputeAgainstYou,
};
