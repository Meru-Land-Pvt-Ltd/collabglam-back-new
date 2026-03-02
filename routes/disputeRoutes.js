// routes/disputeRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');

const { verifyToken } = require('../controllers/dashboardController');
const {
  // brand
  brandCreateDispute,
  brandList,
  brandGetById,
  brandAddComment,
  // influencer
  influencerCreateDispute,
  influencerList,
  influencerGetById,
  influencerAddComment,
  influencerCampaignsForDispute,
  // admin
  adminList,
  adminGetById,
  adminAddComment,
  adminUpdateStatus,
  adminAssign,
} = require('../controllers/disputeController');

// ---- Multer config for dispute attachments ----
const MAX_DISPUTE_ATTACHMENTS = Number(process.env.DISPUTE_MAX_ATTACHMENTS || '10'); // per request
const MAX_ATTACHMENT_SIZE_MB = Number(process.env.DISPUTE_MAX_ATTACHMENT_MB || '10'); // per file
const ATTACHMENT_FIELD = 'attachments';

// Base Multer instance (memory storage for GridFS)
const baseUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTACHMENT_SIZE_MB * 1024 * 1024, // per file
    files: MAX_DISPUTE_ATTACHMENTS,
  },
});

/**
 * Middleware that runs Multer and converts MulterError to clean JSON.
 * Field name: "attachments"
 */
const uploadAttachments = (req, res, next) => {
  baseUpload.array(ATTACHMENT_FIELD, MAX_DISPUTE_ATTACHMENTS)(
    req,
    res,
    (err) => {
      if (!err) return next();

      // Handle Multer errors explicitly
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            message: `Each attachment must be ≤ ${MAX_ATTACHMENT_SIZE_MB}MB`,
            code: 'LIMIT_FILE_SIZE',
          });
        }

        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(413).json({
            message: `You can upload at most ${MAX_DISPUTE_ATTACHMENTS} attachments`,
            code: 'LIMIT_FILE_COUNT',
          });
        }

        return res.status(400).json({
          message: `Upload error: ${err.code}`,
          code: err.code,
        });
      }

      // Non-Multer error → pass to global error handler
      return next(err);
    }
  );
};

// -------- Brand endpoints (require brand auth) --------
router.post(
  '/brand/create',
  verifyToken,
  uploadAttachments,
  brandCreateDispute
);
router.post('/brand/list', verifyToken, brandList);
router.get('/brand/:id', verifyToken, brandGetById);
router.post(
  '/brand/:id/comment',
  verifyToken,
  uploadAttachments,
  brandAddComment
);

// -------- Influencer endpoints (require influencer auth) --------
router.post(
  '/influencer/create',
  verifyToken,
  uploadAttachments,
  influencerCreateDispute
);
router.post('/influencer/list', verifyToken, influencerList);
router.get('/influencer/:id', verifyToken, influencerGetById);
router.post(
  '/influencer/:id/comment',
  verifyToken,
  uploadAttachments,
  influencerAddComment
);
router.post('/influencer/applied', verifyToken, influencerCampaignsForDispute);

// -------- Admin endpoints (relaxed auth, but comments can also have files) --------
router.post('/admin/list', adminList);
router.get('/admin/:id', adminGetById);
router.post(
  '/admin/:id/comment',
  uploadAttachments,
  adminAddComment
);
router.post('/admin/update-status', adminUpdateStatus);
router.post('/admin/assign', adminAssign);

module.exports = router;
