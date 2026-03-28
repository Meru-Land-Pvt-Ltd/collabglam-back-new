const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const crypto = require("crypto");
require("dotenv").config();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID1,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY1,
  },
});

const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function isBase64DataUrl(value) {
  return (
    typeof value === "string" &&
    /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(value)
  );
}

function extractBase64Parts(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    throw new Error("Invalid base64 image format");
  }

  const contentType = match[1];
  const base64Data = match[2];

  if (!ALLOWED_TYPES[contentType]) {
    throw new Error(`Unsupported image type: ${contentType}`);
  }

  return {
    contentType,
    base64Data,
    extension: ALLOWED_TYPES[contentType],
  };
}

async function uploadSingleBase64Image(dataUrl, prefix = "campaign-images") {
  const { contentType, base64Data, extension } = extractBase64Parts(dataUrl);
  const buffer = Buffer.from(base64Data, "base64");

  if (!buffer || !buffer.length) {
    throw new Error("Empty image buffer");
  }

  const fileName = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const key = `${prefix}/${fileName}`;

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  });

  await s3.send(command);

  const fileUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

  return {
    dataUrl: fileUrl,
    key,
    contentType,
    size: buffer.length,
  };
}

async function normalizeAndUploadProductImages(productImages) {
  if (!productImages) return [];

  const inputArray = Array.isArray(productImages) ? productImages : [productImages];
  const output = [];

  for (const item of inputArray) {
    if (isBase64DataUrl(item)) {
      const uploaded = await uploadSingleBase64Image(item);
      output.push(uploaded);
      continue;
    }

    if (item && typeof item === "object" && isBase64DataUrl(item.dataUrl)) {
      const uploaded = await uploadSingleBase64Image(item.dataUrl);
      output.push({
        name: item.name || "",
        type: item.type || uploaded.contentType,
        originalSize: item.size || uploaded.size,
        ...uploaded,
      });
      continue;
    }

    if (item && typeof item === "object" && isBase64DataUrl(item.url)) {
      const uploaded = await uploadSingleBase64Image(item.url);
      output.push({
        ...item,
        ...uploaded,
      });
      delete output[output.length - 1].url;
      continue;
    }

    if (typeof item === "string" && /^https?:\/\//i.test(item)) {
      output.push({ dataUrl: item });
      continue;
    }

    if (item && typeof item === "object" && item.url && /^https?:\/\//i.test(item.url)) {
      const cloned = { ...item, dataUrl: item.url };
      delete cloned.url;
      output.push(cloned);
      continue;
    }

    throw new Error("Invalid Product Images item. Must be base64 image or URL.");
  }

  return output;
}

module.exports = {
  normalizeAndUploadProductImages,
};