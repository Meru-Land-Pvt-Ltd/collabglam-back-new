// services/awsEmail.service.js
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const region = process.env.AWS_REGION || "us-east-1";

const ses = new SESClient({ region });
const s3 = new S3Client({ region });

/**
 * @param {{to:string, subject:string, text?:string, html?:string, from?:string}} input
 */
async function sendEmail({ to, subject, text, html, from }) {
  const fixedFrom = from || process.env.SES_FROM_EMAIL || "confirm@collabglam.com";

  if (!fixedFrom) throw new Error("Sender email missing");
  if (!to) throw new Error("Recipient email (to) is required");
  if (!subject) throw new Error("Email subject is required");
  if (!text && !html) throw new Error("Either text or html body is required");

  const command = new SendEmailCommand({
    Source: fixedFrom,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: "UTF-8" },
      Body: {
        ...(text ? { Text: { Data: text, Charset: "UTF-8" } } : {}),
        ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
      },
    },
  });

  const resp = await ses.send(command);
  return { messageId: resp.MessageId || null, from: fixedFrom };
}

/**
 * @param {any} record
 */
async function uploadEmailRecordToS3(record) {
  const Bucket = process.env.EMAIL_ARCHIVE_BUCKET;
  if (!Bucket) throw new Error("EMAIL_ARCHIVE_BUCKET missing");

  // crypto.randomUUID exists in modern Node; fallback if needed
  const id = record?.emailMessageId || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
  const date = new Date().toISOString().slice(0, 10);

  // MUST be outbound/*
  const Key = `outbound/marketing/${date}/${id}.json`;

  console.log("Uploading S3:", { Bucket, Key });

  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key,
      Body: JSON.stringify(record, null, 2),
      ContentType: "application/json",
      // DO NOT set ACL / Tagging / SSE-KMS unless configured
    })
  );

  return Key;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

async function readEmailFromS3(bucket, key) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const raw = await streamToString(obj.Body);
  return JSON.parse(raw);
}

module.exports = {
  sendEmail,
  uploadEmailRecordToS3,
  readEmailFromS3,
};