// emails/invitationController.js
const nodemailer = require('nodemailer');
const Influencer = require('../models/influencer');
const Brand = require('../models/brand');
const ChatRoom = require('../models/chat');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function sortParticipants(a, b) {
  return a.userId.localeCompare(b.userId);
}

exports.sendInvitation = async (req, res) => {
  const {
    email,
    brandId,          // ✅ only brandId + email from body
  } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email required' });
  }

  if (!brandId) {
    return res.status(400).json({ message: 'brandId is required' });
  }

  try {
    // 1) Load brand & influencer from DB
    const [brand, influencer] = await Promise.all([
      Brand.findOne({ brandId }, 'name email'),
      Influencer.findOne({ email }, 'influencerId name email')
    ]);

    if (!brand) {
      return res.status(404).json({ message: 'Brand not found' });
    }

    const brandName = brand.name || 'CollabGlam';
    const contactName = brandName; // ✅ contact name auto from brand

    // ======================================================
    // CASE 1: Influencer EXISTS -> Create / reuse chat room
    // ======================================================
    if (influencer) {
      const influencerId = influencer.influencerId;
      const influencerName = influencer.name || 'creator';

      // Find existing 1:1 room between brand & influencer
      let room = await ChatRoom.findOne({
        'participants.userId': { $all: [brandId, influencerId] },
        'participants.2': { $exists: false }, // make sure it’s just them two
      });

      let message;
      if (!room) {
        const participants = [
          { userId: brandId, name: brandName, role: 'brand' },
          { userId: influencerId, name: influencerName, role: 'influencer' },
        ].sort(sortParticipants);

        room = new ChatRoom({ participants });
        await room.save();
        message = 'Chat room created';
      } else {
        message = 'Chat room already exists';
      }

      // Frontend can now open /brand/messages/:roomId (or /influencer/messages/:roomId)
      return res.json({
        message,
        isExistingInfluencer: true,
        influencerId,
        influencerName,
        brandName,
        roomId: room.roomId,
      });
    }

    // ======================================================
    // CASE 2: Influencer DOES NOT EXIST -> Send email invite
    // ======================================================
    const signupUrl = `https://collabglam.com/`; // ✅ no inviteCode

    await transporter.sendMail({
      from: `"${brandName}" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `A brand wants to collaborate with you on CollabGlam ✨`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: 0 auto;">
          <p>Hi <strong>creator</strong>,</p>
          
          <p>Hope you're doing well! We're reaching out from <strong>${brandName}</strong>, and we've been following your content closely. We believe your style and audience align well with our upcoming campaign.</p>
          
          <p>We'd love to invite you to collaborate with us on a paid campaign through <strong>CollabGlam</strong>, a trusted platform for brand–influencer partnerships.</p>
          
          <h3 style="color: #ff7236; margin-top: 24px;">✅ Why you should join this campaign</h3>
          <ul style="margin: 12px 0; padding-left: 20px;">
            <li>Paid collaboration with a clear Scope of Work</li>
            <li>Secure milestone payments</li>
            <li>Easy contract & approval workflow</li>
            <li>No negotiation confusion — everything tracked in one place</li>
          </ul>
          
          <p style="margin-top: 24px;">
            A brand wants to connect with you through CollabGlam. To move ahead, please create your account using the button below:
          </p>
          
          <p style="margin: 24px 0;">
            <a href="${signupUrl}" style="background: linear-gradient(to right, #FFA135, #FF7236); color: #fff; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; font-weight: 600;">
              👉 Create your CollabGlam account
            </a>
          </p>
          
          <p style="font-size: 13px; color: #666;">If the button doesn't work, copy and paste this link: <a href="${signupUrl}" style="color: #ff7236;">${signupUrl}</a></p>
          
          <p style="margin-top: 24px;">Once you register, you'll see the campaign invitation directly in your CollabGlam dashboard.</p>
          
          <p>If you have any questions, feel free to reply — we’re happy to help.</p>
          
          <p style="margin-top: 32px;">
            Warm regards,<br/>
            <strong>${contactName}</strong><br/>
            ${brandName}
          </p>
        </div>
      `,
      text: `
Hi creator,

Hope you're doing well! We're reaching out from ${brandName}, and we've been following your content closely. We believe your style and audience align well with our upcoming campaign.

We'd love to invite you to collaborate with us on a paid campaign through CollabGlam, a trusted platform for brand–influencer partnerships.

✅ Why you should join this campaign
- Paid collaboration with a clear Scope of Work
- Secure milestone payments
- Easy contract & approval workflow
- No negotiation confusion — everything tracked in one place

A brand wants to connect with you through CollabGlam. To move ahead, please create your account using the link below:

👉 Create your account: ${signupUrl}

Once you register, you'll see the campaign invitation directly in your CollabGlam dashboard.

If you have any questions, feel free to reply — happy to help.

Warm regards,
${contactName}
${brandName}
      `,
    });

    return res.json({
      message: 'Invitation sent successfully',
      isExistingInfluencer: false,
      brandName,
      signupUrl, // frontend: show "Create account" button and redirect to this
    });
  } catch (err) {
    console.error('Invitation flow failed:', err);
    return res.status(500).json({ message: 'Unable to process invitation' });
  }
};
