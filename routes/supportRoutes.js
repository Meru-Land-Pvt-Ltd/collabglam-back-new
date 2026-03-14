const express = require("express");
const router = express.Router();
const multer = require("multer");

const supportController = require("../controllers/supportController");

// ---- Multer config for support attachments ----
const MAX_SUPPORT_ATTACHMENTS = Number(
  process.env.SUPPORT_MAX_ATTACHMENTS ||
    "10"
);

const MAX_ATTACHMENT_SIZE_MB = Number(
  process.env.SUPPORT_MAX_ATTACHMENT_MB ||
    "10"
);

const ATTACHMENT_FIELD = "attachments";

// Base Multer instance (memory storage for GridFS)
const baseUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_SIZE_MB * 1024 * 1024,
    files: MAX_SUPPORT_ATTACHMENTS,
  },
});

/**
 * Middleware that runs Multer and converts MulterError to clean JSON.
 * Field name: "attachments"
 */
const uploadAttachments = (req, res, next) => {
  baseUpload.array(ATTACHMENT_FIELD, MAX_SUPPORT_ATTACHMENTS)(
    req,
    res,
    (err) => {
      if (!err) return next();

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            message: `Each attachment must be ≤ ${MAX_ATTACHMENT_SIZE_MB}MB`,
            code: "LIMIT_FILE_SIZE",
          });
        }

        if (err.code === "LIMIT_FILE_COUNT") {
          return res.status(413).json({
            message: `You can upload at most ${MAX_SUPPORT_ATTACHMENTS} attachments`,
            code: "LIMIT_FILE_COUNT",
          });
        }

        return res.status(400).json({
          message: `Upload error: ${err.code}`,
          code: err.code,
        });
      }

      return next(err);
    }
  );
};

// -------- Brand endpoints --------
router.post(
  "/brand/create",
  uploadAttachments,
  supportController.brandCreate
);

router.post(
  "/brand/list",
  supportController.brandList
);

router.get(
  "/brand/:ticketId",
  supportController.brandGetOne
);

router.post(
  "/brand/:ticketId/reply",
  uploadAttachments,
  supportController.brandReply
);

// -------- Influencer endpoints --------
router.post(
  "/influencer/create",
  uploadAttachments,
  supportController.influencerCreate
);

router.post(
  "/influencer/list",
  supportController.influencerList
);

router.get(
  "/influencer/:ticketId",
  supportController.influencerGetOne
);

router.post(
  "/influencer/:ticketId/reply",
  uploadAttachments,
  supportController.influencerReply
);

// -------- Admin / support team endpoints --------
// Keep these as-is unless you also have admin auth middleware ready.
router.post("/admin/list", supportController.adminList);
router.get("/admin/:ticketId", supportController.adminGetOne);

router.post(
  "/admin/:ticketId/reply",
  uploadAttachments,
  supportController.adminReply
);

router.post(
  "/admin/:ticketId/status",
  supportController.adminUpdateStatus
);

module.exports = router;