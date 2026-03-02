// jobs/unseenMessageNotifier.js
require('dotenv').config();
const nodemailer = require('nodemailer');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const ChatRoom = require('../models/chat');

// ---------------- ENV & Transport ----------------
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FRONTEND_URL = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

// minutes before we notify (default 30)
const UNSEEN_EMAIL_THRESHOLD_MINUTES = parseInt(
  process.env.UNSEEN_EMAIL_THRESHOLD_MINUTES || '30',
  10
);

// how often the job runs (default 5 minutes)
const UNSEEN_CHECK_INTERVAL_MS = parseInt(
  process.env.UNSEEN_CHECK_INTERVAL_MS || String(5 * 60 * 1000),
  10
);

// quick on/off for verbose logs
const DEBUG_UNSEEN_NOTIFIER = (process.env.DEBUG_UNSEEN_NOTIFIER || '0') === '1';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
  // , logger: true, debug: true // uncomment to let nodemailer print detailed logs
});

function logDebug(...args) {
  if (DEBUG_UNSEEN_NOTIFIER) console.log('[unseen-notifier]', ...args);
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildLatestMessageTeaser(message) {
  if (!message) return null;

  if (typeof message.text === 'string') {
    const trimmed = message.text.trim();
    if (trimmed) return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 137)}...`;
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attachment = message.attachments[0];
    if (attachment?.originalName) return `Attachment: ${attachment.originalName}`;
    if (attachment?.mimeType) return `Attachment: ${attachment.mimeType}`;
    return 'Attachment: New file';
  }
  return null;
}

// ---------------- Theming ----------------
const THEMES = {
  influencer: {
    headerBg: 'linear-gradient(to right, #FFBF00, #FFDB58)', // bg-gradient-to-r from-[#FFBF00] to-[#FFDB58]
    headerText: '#111827', // text-gray-900
    accent: '#FFBF00',
    btnBg: '#111827',
    btnText: '#FFFFFF'
  },
  brand: {
    headerBg: 'linear-gradient(to right, #FFA135, #FF7236)', // bg-gradient-to-r from-[#FFA135] to-[#FF7236]
    headerText: '#FFFFFF', // text-white
    accent: '#FF7236',
    btnBg: '#FF7236',
    btnText: '#FFFFFF'
  }
};

function getTheme(rolePath) {
  return rolePath === 'brand' ? THEMES.brand : THEMES.influencer;
}

// ---------------- Mailer ----------------
function buildEmailHTML({ userName, unseenCount, teaserText, messageUrl, rolePath }) {
  const t = getTheme(rolePath);
  const uname = escapeHtml(userName || 'there');
  const preheader = `You have ${unseenCount} unread message${unseenCount > 1 ? 's' : ''} on Collabglam.`;

  const teaserSection = teaserText
    ? `
      <tr>
        <td style="padding:0 24px 16px 24px;">
          <div style="margin:0; padding:12px 16px; background-color:#f7f7f7; border-left:4px solid ${t.accent}; border-radius:6px;">
            <p style="margin:0; font-size:14px; line-height:20px; color:#374151; font-weight:700;">Latest message preview</p>
            <p style="margin:8px 0 0 0; font-size:14px; line-height:20px; color:#4B5563;">${escapeHtml(teaserText)}</p>
          </div>
        </td>
      </tr>
    `
    : '';

  return `
  <!doctype html>
  <html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>Collabglam Notification</title>
    <style>
      /* Basic mobile tweaks */
      @media only screen and (max-width: 620px) {
        .container { width: 100% !important; }
        .content { padding: 16px !important; }
        .btn { width: 100% !important; text-align:center !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background-color:#F3F4F6;">
    <!-- Preheader (hidden) -->
    <span style="display:none; font-size:0; line-height:0; max-height:0; max-width:0; opacity:0; overflow:hidden; visibility:hidden;">
      ${escapeHtml(preheader)}
    </span>

    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
      <tr>
        <td align="center" style="padding:24px;">
          <table role="presentation" class="container" width="600" style="width:600px; max-width:600px; background:#FFFFFF; border-radius:12px; overflow:hidden; box-shadow:0 8px 24px rgba(0,0,0,0.06);">
            <tr>
              <td style="background:${t.headerBg}; padding:20px 24px;">
                <table width="100%" role="presentation">
                  <tr>
                    <td align="left" style="font-family:Arial, sans-serif; color:${t.headerText}; font-weight:700; font-size:18px;">
                      Collabglam
                    </td>
                    <td align="right" style="font-family:Arial, sans-serif; color:${t.headerText};">
                      <span style="display:inline-block; font-size:12px; padding:6px 10px; border-radius:9999px; background:rgba(0,0,0,0.15); color:${t.headerText}; font-weight:700;">
                        ${unseenCount} unread
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td class="content" style="padding:24px; font-family:Arial, sans-serif;">
                <h2 style="margin:0 0 8px 0; color:#111827; font-size:20px; line-height:28px;">Hello ${uname},</h2>
                <p style="margin:0; color:#374151; font-size:14px; line-height:22px;">
                  You have ${unseenCount} unread message${unseenCount > 1 ? 's' : ''} waiting in your chat.
                </p>
              </td>
            </tr>

            ${teaserSection}

            <tr>
              <td style="padding:0 24px 8px 24px;">
                <a href="${messageUrl}" class="btn"
                   style="display:inline-block; background:${t.btnBg}; color:${t.btnText}; text-decoration:none; padding:12px 18px; border-radius:8px; font-family:Arial, sans-serif; font-size:14px; font-weight:700;">
                  View Message
                </a>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 24px 24px 24px; font-family:Arial, sans-serif;">
                <p style="margin:12px 0 0 0; color:#6B7280; font-size:12px; line-height:18px;">
                  Or paste this into your browser:<br />
                  <a href="${messageUrl}" style="color:${t.accent}; text-decoration:underline; word-break:break-all;">${messageUrl}</a>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:16px 24px 24px 24px; font-family:Arial, sans-serif; border-top:1px solid #E5E7EB;">
                <p style="margin:0; color:#9CA3AF; font-size:11px; line-height:16px;">
                  This is an automated message. Please do not reply to this email.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

async function sendUnseenMessageNotification({
  email,
  userName,
  rolePath,           // "brand" | "influencer"
  roomId,
  latestMessageId,
  unseenCount,
  teaserText
}) {
  try {
    const messageUrl = `${FRONTEND_URL}/${encodeURIComponent(rolePath)}/messages/${encodeURIComponent(
      roomId
    )}?mid=${encodeURIComponent(latestMessageId)}`;

    const html = buildEmailHTML({
      userName,
      unseenCount,
      teaserText,
      messageUrl,
      rolePath
    });

    const text = [
      `Hello ${userName || 'there'},`,
      `You have ${unseenCount} unread message${unseenCount > 1 ? 's' : ''} on Collabglam.`,
      teaserText ? `Latest: ${teaserText}` : null,
      `Open: ${messageUrl}`,
      '',
      `This is an automated message. Please do not reply to this email.`
    ].filter(Boolean).join('\n');

    const mailOptions = {
      from: `"Collabglam Notifications" <${SMTP_USER}>`,
      to: email,
      subject: `You have ${unseenCount} unread message${unseenCount > 1 ? 's' : ''} on Collabglam`,
      html,
      text
      // You could also set headers like List-Unsubscribe if you add a settings URL later.
    };

    await transporter.sendMail(mailOptions);
    logDebug(`Mail sent to ${email} for room ${roomId}, mid ${latestMessageId}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send email to ${email}:`, error.message);
    return false;
  }
}

// ---------------- Data helpers ----------------
async function getUserDetails(userId, userType) {
  const projection = 'email name isUnsubscribed';
  if (userType === 'brand') {
    return await Brand.findOne({ brandId: userId, isUnsubscribed: { $ne: true } }).select(projection);
  }
  if (userType === 'influencer') {
    return await Influencer.findOne({ influencerId: userId, isUnsubscribed: { $ne: true } }).select(projection);
  }
  return null;
}

// ---------------- Core ----------------
async function checkAndNotifyUnseenMessages() {
  try {
    const rooms = await ChatRoom.find();
    const THRESHOLD_MS = UNSEEN_EMAIL_THRESHOLD_MINUTES * 60 * 1000;
    const now = Date.now();

    for (const room of rooms) {
      for (const participant of room.participants) {
        const userId = participant.userId;
        const rolePath = participant.role === 'brand' ? 'brand' : 'influencer'; // default to influencer for unknown

        const candidates = room.messages.filter(msg =>
          msg.senderId !== userId &&
          Array.isArray(msg.seenBy) &&
          !msg.seenBy.includes(userId) &&
          (now - new Date(msg.timestamp).getTime()) >= THRESHOLD_MS &&
          (!Array.isArray(msg.emailNotified) || !msg.emailNotified.includes(userId))
        );

        if (candidates.length === 0) {
          logDebug(`No candidates for ${userId} in room ${room.roomId}`);
          continue;
        }

        const latestUnseen = candidates[candidates.length - 1];
        const messageTeaser = buildLatestMessageTeaser(latestUnseen);

        const userDoc = await getUserDetails(userId, participant.role);
        if (!userDoc || !userDoc.email) {
          logDebug(`Skip user ${userId}: not found or unsubscribed`);
          continue;
        }

        const sent = await sendUnseenMessageNotification({
          email: userDoc.email,
          userName: userDoc.name || participant.name || 'User',
          rolePath,
          roomId: room.roomId,
          latestMessageId: latestUnseen.messageId,
          unseenCount: candidates.length,
          teaserText: messageTeaser
        });

        if (sent) {
          const when = new Date();
          for (const msg of candidates) {
            if (!Array.isArray(msg.emailNotified)) msg.emailNotified = [];
            if (!msg.emailNotified.includes(userId)) msg.emailNotified.push(userId);
            // Keep Map if your schema defines it; otherwise consider using a plain object
            if (!msg.emailNotifiedAt) msg.emailNotifiedAt = new Map();
            msg.emailNotifiedAt.set(userId, when);
          }
          room.markModified('messages');
          await room.save();
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in checkAndNotifyUnseenMessages:', error);
  }
}

// ---------------- Scheduler ----------------
let notificationInterval;

module.exports = {
  start: async () => {
    // Verify SMTP first (helpful if nothing arrives)
    try {
      await transporter.verify();
      console.log('SMTP connection verified ✅');
    } catch (e) {
      console.error('SMTP verification failed ❌:', e.message);
    }

    // Run immediately at boot
    await checkAndNotifyUnseenMessages();

    notificationInterval = setInterval(checkAndNotifyUnseenMessages, UNSEEN_CHECK_INTERVAL_MS);
    console.log(
      `Unseen message notifier started - Checking every ${Math.round(UNSEEN_CHECK_INTERVAL_MS / 1000)}s; threshold=${UNSEEN_EMAIL_THRESHOLD_MINUTES}m`
    );
  },

  stop: () => {
    if (notificationInterval) {
      clearInterval(notificationInterval);
      console.log('Unseen message notifier stopped');
    }
  }
};
