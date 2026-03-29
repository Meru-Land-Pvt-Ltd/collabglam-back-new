const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
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

function normalizeEmailList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(cleanEmail).filter(Boolean);
  }
  return [cleanEmail(value)].filter(Boolean);
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
  if (!toAddresses.length) {
    throw new Error("Recipient email (to) is required");
  }
  if (!finalSubject) throw new Error("Email subject is required");
  if (!text && !html) {
    throw new Error("Either text or html body is required");
  }

  const commandInput = {
    Source: fixedFrom,
    Destination: {
      ToAddresses: toAddresses,
      ...(ccAddresses.length ? { CcAddresses: ccAddresses } : {}),
      ...(bccAddresses.length ? { BccAddresses: bccAddresses } : {}),
    },
    Message: {
      Subject: { Data: finalSubject, Charset: "UTF-8" },
      Body: {
        ...(text ? { Text: { Data: text, Charset: "UTF-8" } } : {}),
        ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
      },
    },
    ...(replyToAddresses.length
      ? { ReplyToAddresses: replyToAddresses }
      : {}),
    ...(configurationSetName
      ? { ConfigurationSetName: configurationSetName }
      : {}),
    ...(Array.isArray(emailTags) && emailTags.length
      ? {
        Tags: emailTags
          .filter(
            (tag) =>
              tag &&
              cleanStr(tag.Name) &&
              cleanStr(tag.Value)
          )
          .map((tag) => ({
            Name: cleanStr(tag.Name),
            Value: cleanStr(tag.Value),
          })),
      }
      : {}),
  };

  const command = new SendEmailCommand(commandInput);
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

/**
 * @param {any} record
 */
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

  console.log("Uploading S3:", { Bucket, Key });

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

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readEmailFromS3(bucket, key) {
  const obj = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );

  const raw = await streamToString(obj.Body);
  return JSON.parse(raw);
}

module.exports = {
  sendEmail,
  uploadEmailRecordToS3,
  readEmailFromS3,
};