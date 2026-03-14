const { uploadToGridFS } = require("./gridfs");

function parseAttachmentsFromBody(attachmentsFromBody = []) {
  if (Array.isArray(attachmentsFromBody)) return attachmentsFromBody;

  if (typeof attachmentsFromBody === "string") {
    const trimmed = attachmentsFromBody.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  if (
    attachmentsFromBody &&
    typeof attachmentsFromBody === "object" &&
    !Array.isArray(attachmentsFromBody)
  ) {
    return [attachmentsFromBody];
  }

  return [];
}

function sanitizeAttachments(list = []) {
  if (!Array.isArray(list)) return [];

  return list
    .map((item) => ({
      url: item?.url || null,
      originalName: item?.originalName || null,
      mimeType: item?.mimeType || null,
      size:
        typeof item?.size === "number"
          ? item.size
          : item?.size
          ? Number(item.size)
          : null,
    }))
    .filter((item) => item.url);
}

async function buildAttachmentsFromReq(req, attachmentsFromBody = [], options = {}) {
  // 1) Existing attachments from body
  const parsed = parseAttachmentsFromBody(attachmentsFromBody);
  const existing = sanitizeAttachments(parsed);

  // 2) New multipart files
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return existing;

  const uploaded = await uploadToGridFS(files, {
    req,
    prefix: options.prefix || "support",
    metadata: {
      source: options.source || "support",
      path: req.originalUrl,
      uploadedByRole: req.user?.role || null,
      uploadedById: req.user?.id || null,
      ...(options.metadata || {}),
    },
  });

  const newOnes = uploaded.map((file) => ({
    url: file.url,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
  }));

  return [...existing, ...newOnes];
}

module.exports = {
  parseAttachmentsFromBody,
  sanitizeAttachments,
  buildAttachmentsFromReq,
};