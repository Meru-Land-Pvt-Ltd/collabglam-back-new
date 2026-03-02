// lambda/sesRelayHandler.js
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { simpleParser } = require('mailparser');
const mongoose = require('mongoose');

const { EmailThread, EmailMessage } = require('../models/email');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');

const REGION = process.env.AWS_REGION || 'ap-south-1';
const RELAY_DOMAIN = process.env.EMAIL_RELAY_DOMAIN;

// ---------- SES client (SDK v3) ----------
const ses = new SESClient({
  region: REGION,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
      : undefined,
});

// connect to Mongo once per container
let isDbConnected = false;
async function connectDb() {
  if (isDbConnected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isDbConnected = true;
}

/**
 * Local helper to send outbound mail from Lambda (similar to sendViaSES in API).
 */
async function sendViaSES({
  fromAlias,
  fromName,
  toRealEmail,
  subject,
  htmlBody,
  textBody,
  replyTo,
}) {
  const params = {
    Source: `${fromName} <${fromAlias}>`,
    Destination: { ToAddresses: [toRealEmail] },
    Message: {
      Subject: { Charset: 'UTF-8', Data: subject },
      Body: {},
    },
  };

  if (replyTo) {
    params.ReplyToAddresses = [replyTo];
  }

  if (htmlBody) {
    params.Message.Body.Html = { Charset: 'UTF-8', Data: htmlBody };
  }
  if (textBody) {
    params.Message.Body.Text = { Charset: 'UTF-8', Data: textBody };
  }

  const cmd = new SendEmailCommand(params);

  try {
    return await ses.send(cmd);
  } catch (err) {
    console.error('SES send error (relay lambda):', err);

    const sesError = (err && err.Error) || {};
    const code = sesError.Code || err.name;
    const message = sesError.Message || err.message || 'SES send failed';

    if (code === 'MessageRejected' && /not verified/i.test(message)) {
      let failingEmail = '';
      const match = message.match(/: ([^ ]+@[^ ]+)/);
      if (match && match[1]) failingEmail = match[1];

      const friendly = failingEmail
        ? `AWS SES rejected the relay email because "${failingEmail}" is not verified in region ${REGION}. In SES sandbox mode you must verify both the sender and the recipient email addresses before you can send.`
        : `AWS SES rejected the relay email because an address is not verified in region ${REGION}. In SES sandbox mode you must verify both the sender and the recipient email addresses.`;

      console.error(friendly);
      return; // we still keep the message stored in Mongo
    }

    throw err;
  }
}

/**
 * Lambda handler triggered by SES → SNS rule.
 */
exports.handler = async (event) => {
  try {
    if (!RELAY_DOMAIN) {
      console.error(
        'EMAIL_RELAY_DOMAIN is not set in Lambda environment. ' +
        'Cannot match relay addresses.'
      );
      return;
    }

    await connectDb();

    const record = event.Records?.[0];
    if (!record) {
      console.log('No SNS record in event');
      return;
    }

    let sesNotification;

    // SES → SNS → Lambda (standard)
    if (record.Sns && record.Sns.Message) {
      sesNotification = JSON.parse(record.Sns.Message);
    } else if (record.ses) {
      // SES → Lambda directly (no SNS) – usually no full raw content
      sesNotification = record.ses;
    } else {
      console.log('Unsupported event format:', JSON.stringify(record));
      return;
    }

    const mail = sesNotification.mail;
    const receipt = sesNotification.receipt;

    if (!mail || !receipt) {
      console.log('Missing SES mail/receipt in notification');
      return;
    }

    let rawEmail = sesNotification.content;
    if (!rawEmail) {
      console.error(
        'No raw email content in SES notification. ' +
        'Make sure the receipt rule uses SNS action that publishes full message content.'
      );
      return;
    }

    // Detect encoding from the receipt.action (SES sets this for SNS action)
    const encoding =
      (sesNotification.receipt &&
        sesNotification.receipt.action &&
        sesNotification.receipt.action.encoding) ||
      '';

    if (encoding.toUpperCase() === 'BASE64') {
      // content is Base64-encoded full RFC822 message
      rawEmail = Buffer.from(rawEmail, 'base64');
    }

    // 1) Parse using mailparser (Buffer is fine)
    const parsed = await simpleParser(rawEmail);

    // Collect all potential recipients
    const toAddresses = [
      ...(parsed.to?.value || []),
      ...(parsed.cc?.value || []),
      ...(mail.destination || []).map((addr) => ({ address: addr })),
    ];

    console.log(
      'Parsed recipients:',
      toAddresses.map((a) => a.address)
    );

    // Find collabglam recipient (relay@RELAY_DOMAIN)
    const relayAddrObj = toAddresses.find(
      (a) =>
        a.address &&
        a.address.toLowerCase().endsWith(`@${RELAY_DOMAIN}`)
    );

    if (!relayAddrObj) {
      console.log(
        `No relay recipient @${RELAY_DOMAIN} found in recipients; skipping.`
      );
      return;
    }

    const relayEmail = relayAddrObj.address.toLowerCase();
    const fromEmail = (parsed.from?.value?.[0]?.address || '').toLowerCase();

    console.log('Relay email:', relayEmail, 'From:', fromEmail);

    // 2) Find thread by relay email
    let thread = await EmailThread.findOne({
      brandAliasEmail: relayEmail,
    })
      .populate('brand')
      .populate('influencer');

    if (!thread) {
      // Fallback: maybe Gmail replied to the pretty alias instead of the technical relay
      thread = await EmailThread.findOne({
        brandDisplayAlias: relayEmail,
      })
        .populate('brand')
        .populate('influencer');
    }

    if (!thread) {
      console.log('No EmailThread found for relay email:', relayEmail);
      return;
    }

    const brand = thread.brand;
    const influencer = thread.influencer;

    if (!brand || !influencer) {
      console.log('Thread missing brand or influencer refs');
      return;
    }

    // 3) Decide direction
    let direction;
    let toRealEmail;
    let fromAliasEmail;
    let fromName;
    let fromUser;
    let fromUserModel;

    if (fromEmail === (brand.email || '').toLowerCase()) {
      // Brand replying from Gmail
      direction = 'brand_to_influencer';
      toRealEmail = influencer.email;
      fromAliasEmail = thread.brandDisplayAlias || thread.brandAliasEmail;
      fromName = `${brand.name} via ${process.env.PLATFORM_NAME || 'CollabGlam'
        }`;
      fromUser = brand._id;
      fromUserModel = 'Brand';
    } else {
      // Treat as influencer
      direction = 'influencer_to_brand';
      toRealEmail = brand.email;
      fromAliasEmail = thread.influencerAliasEmail; // influencer@collabglam.cloud
      fromName = `${thread.influencerSnapshot.name} via ${process.env.PLATFORM_NAME || 'CollabGlam'
        }`;
      fromUser = influencer._id;
      fromUserModel = 'Influencer';
    }

    const subject = parsed.subject || '(no subject)';
    const textBody = parsed.text || '';
    const htmlBody =
      parsed.html || `<pre>${parsed.textAsHtml || ''}</pre>`;

    // 4) Save message in MongoDB
    const messageDoc = await EmailMessage.create({
      thread: thread._id,
      direction,
      fromUser,
      fromUserModel,
      fromAliasEmail,
      toRealEmail,
      subject,
      htmlBody,
      textBody,
      template: null,
    });

    console.log('Created EmailMessage', messageDoc._id.toString());

    // 5) Forward sanitized email to real recipient via SES, keeping same relay
    await sendViaSES({
      fromAlias: fromAliasEmail,
      fromName,
      toRealEmail,
      subject,
      htmlBody,
      textBody,
      replyTo: thread.brandAliasEmail, // keep same relay
    });

    console.log('Forwarded email to real recipient', toRealEmail);
  } catch (err) {
    console.error('Error in SES relay handler:', err);
    throw err;
  }
};
