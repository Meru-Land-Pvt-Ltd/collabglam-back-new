const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const region = process.env.AWS_REGION || "us-east-1";
const ses = new SESClient({ region });
const s3 = new S3Client({ region });

const cleanStr = (value) => String(value ?? "").trim();
const cleanEmail = (value) => cleanStr(value).toLowerCase();

const EMAIL_ATTACHMENT_BUCKET =
  process.env.EMAIL_ATTACHMENT_BUCKET || "collabglam";

const EMAIL_ATTACHMENT_PREFIX =
  process.env.EMAIL_ATTACHMENT_PREFIX || "admin-email-attachments";

function normalizeEmailList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(cleanEmail).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map(cleanEmail)
    .filter(Boolean);
}

function escapeHeader(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function chunkBase64(base64) {
  return String(base64).match(/.{1,76}/g)?.join("\r\n") || "";
}

function sanitizeFilename(name, fallback = "attachment") {
  const clean = String(name || fallback)
    .replace(/[^\w.\-() ]/g, "_")
    .trim();
  return clean || fallback;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function uploadOutboundAttachmentsToS3({
  attachments = [],
  threadId = "no-thread",
}) {
  if (!Array.isArray(attachments) || !attachments.length) return [];

  const uploaded = [];

  for (let i = 0; i < attachments.length; i++) {
    const file = attachments[i];
    if (!file?.contentBase64) continue;

    const filename = sanitizeFilename(file.filename, `attachment-${i + 1}`);
    const key = `${EMAIL_ATTACHMENT_PREFIX}/outbound/${threadId}/${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${filename}`;

    const buffer = Buffer.from(String(file.contentBase64), "base64");

    await s3.send(
      new PutObjectCommand({
        Bucket: EMAIL_ATTACHMENT_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: file.contentType || "application/octet-stream",
      })
    );

    uploaded.push({
      filename,
      contentType: file.contentType || "application/octet-stream",
      size: Number(file.size || buffer.length || 0),
      s3Bucket: EMAIL_ATTACHMENT_BUCKET,
      s3Key: key,
    });
  }

  return uploaded;
}

async function getAttachmentBuffersFromS3(items = []) {
  const results = [];

  for (const item of items) {
    if (!item?.s3Bucket || !item?.s3Key) continue;

    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: item.s3Bucket,
        Key: item.s3Key,
      })
    );

    const fileBuffer = await streamToBuffer(obj.Body);

    results.push({
      filename: item.filename || "attachment",
      contentType: item.contentType || "application/octet-stream",
      content: fileBuffer,
    });
  }

  return results;
}

function buildMixedMimeMessage({
  from,
  to = [],
  cc = [],
  bcc = [],
  replyTo = [],
  subject,
  text,
  html,
  attachments = [],
  inReplyTo = null,
  references = [],
  configurationSetName = null,
  emailTags = [],
}) {
  const mixedBoundary = `mixed_${crypto.randomBytes(12).toString("hex")}`;
  const altBoundary = `alt_${crypto.randomBytes(12).toString("hex")}`;

  const headers = [];

  headers.push(`From: ${escapeHeader(from)}`);
  headers.push(`To: ${to.map(escapeHeader).join(", ")}`);
  if (cc.length) headers.push(`Cc: ${cc.map(escapeHeader).join(", ")}`);
  if (replyTo.length) headers.push(`Reply-To: ${replyTo.map(escapeHeader).join(", ")}`);
  headers.push(`Subject: ${escapeHeader(subject)}`);
  headers.push(`MIME-Version: 1.0`);

  if (inReplyTo) headers.push(`In-Reply-To: ${escapeHeader(inReplyTo)}`);
  if (references?.length) {
    headers.push(`References: ${references.map(escapeHeader).join(" ")}`);
  }

  if (configurationSetName) {
    headers.push(`X-SES-CONFIGURATION-SET: ${escapeHeader(configurationSetName)}`);
  }

  if (Array.isArray(emailTags)) {
    for (const tag of emailTags) {
      if (tag?.Name && tag?.Value) {
        headers.push(`X-SES-MESSAGE-TAGS: ${escapeHeader(tag.Name)}=${escapeHeader(tag.Value)}`);
      }
    }
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

  const parts = [];

  parts.push(`--${mixedBoundary}`);
  parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  parts.push("");

  if (text) {
    parts.push(`--${altBoundary}`);
    parts.push(`Content-Type: text/plain; charset="UTF-8"`);
    parts.push(`Content-Transfer-Encoding: 7bit`);
    parts.push("");
    parts.push(String(text));
    parts.push("");
  }

  if (html) {
    parts.push(`--${altBoundary}`);
    parts.push(`Content-Type: text/html; charset="UTF-8"`);
    parts.push(`Content-Transfer-Encoding: 7bit`);
    parts.push("");
    parts.push(String(html));
    parts.push("");
  }

  parts.push(`--${altBoundary}--`);
  parts.push("");

  for (const attachment of attachments) {
    const filename = escapeHeader(attachment.filename || "attachment");
    const contentType = escapeHeader(
      attachment.contentType || "application/octet-stream"
    );

    const base64 = chunkBase64(
      Buffer.isBuffer(attachment.content)
        ? attachment.content.toString("base64")
        : Buffer.from(attachment.content).toString("base64")
    );

    parts.push(`--${mixedBoundary}`);
    parts.push(`Content-Type: ${contentType}; name="${filename}"`);
    parts.push(`Content-Description: ${filename}`);
    parts.push(`Content-Disposition: attachment; filename="${filename}"`);
    parts.push(`Content-Transfer-Encoding: base64`);
    parts.push("");
    parts.push(base64);
    parts.push("");
  }

  parts.push(`--${mixedBoundary}--`);
  parts.push("");

  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

async function sendEmail({
  to,
  subject,
  text,
  html,
  from,
  cc = [],
  bcc = [],
  replyTo = [],
  attachments = [],
  inReplyTo = null,
  references = [],
  configurationSetName,
  emailTags = [],
}) {
  const fixedFrom = cleanEmail(
    from || process.env.SES_FROM_EMAIL || "confirm@collabglam.com"
  );

  const toAddresses = normalizeEmailList(to);
  const ccAddresses = normalizeEmailList(cc);
  const bccAddresses = normalizeEmailList(bcc);
  const replyToAddresses = normalizeEmailList(replyTo);
  const finalSubject = cleanStr(subject);

  if (!fixedFrom) throw new Error("Sender email missing");
  if (!toAddresses.length) throw new Error("Recipient email (to) is required");
  if (!finalSubject) throw new Error("Email subject is required");
  if (!text && !html) throw new Error("Either text or html body is required");

  const rawMessage = buildMixedMimeMessage({
    from: fixedFrom,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    replyTo: replyToAddresses,
    subject: finalSubject,
    text,
    html,
    attachments,
    inReplyTo,
    references,
    configurationSetName,
    emailTags,
  });

  const command = new SendRawEmailCommand({
    RawMessage: {
      Data: Buffer.from(rawMessage),
    },
    Source: fixedFrom,
    Destinations: [...toAddresses, ...ccAddresses, ...bccAddresses],
  });

  const resp = await ses.send(command);

  return {
    messageId: resp.MessageId || null,
    from: fixedFrom,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    replyTo: replyToAddresses,
  };
}

async function uploadEmailRecordToS3(record) {
  const Bucket = process.env.EMAIL_ARCHIVE_BUCKET;
  if (!Bucket) throw new Error("EMAIL_ARCHIVE_BUCKET missing");

  const id =
    record?.emailMessageId ||
    (crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex"));

  const date = new Date().toISOString().slice(0, 10);
  const Key = `collabglam-email-archive/outbound/marketing/${date}/${id}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key,
      Body: JSON.stringify(record, null, 2),
      ContentType: "application/json",
    })
  );

  return Key;
}

async function readEmailFromS3(bucket, key) {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  const raw = await streamToBuffer(obj.Body);
  return JSON.parse(raw.toString("utf-8"));
}

module.exports = {
  sendEmail,
  uploadEmailRecordToS3,
  readEmailFromS3,
  getAttachmentBuffersFromS3,
  uploadOutboundAttachmentsToS3,
};