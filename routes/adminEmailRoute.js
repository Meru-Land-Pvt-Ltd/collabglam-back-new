const express = require("express");
const multer = require("multer");
const {
  sendBulkCsv,
  getThreads,
  getMessages,
  reply,
  getPipelineRecipientsForCompose,
  sendSelectedPipelineEmailsController,
  getBrandOutreachRecipientsForCompose,
  sendSelectedBrandOutreachEmailsController,
  getMailboxScope,
  composeEmail,
  updateThread
} = require("../controllers/adminEmailController");
const { adminAuth } = require("../middlewares/adminAuth");
const {
  getTemplates,
  createTemplate,
  updateTemplate,
  removeTemplate,
} = require("../controllers/adminEmailTemplate");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.get("/me", adminAuth, getMailboxScope);
router.post("/bulk/csv", adminAuth, upload.single("file"), sendBulkCsv);
router.post("/compose", adminAuth, composeEmail);
router.get("/threads", adminAuth, getThreads);
router.get("/threads/:threadId/messages", adminAuth, getMessages);
router.post("/threads/:threadId/reply", adminAuth, reply);
router.post("/threads/:threadId", adminAuth, updateThread);
router.post("/pipeline/recipients", adminAuth, getPipelineRecipientsForCompose);
router.post("/pipeline/send-selected", adminAuth, sendSelectedPipelineEmailsController);

router.get("/templates", adminAuth, getTemplates);
router.post("/templates", adminAuth, createTemplate);
router.post("/templates/:templateId/update", adminAuth, updateTemplate);
router.post("/templates/:templateId/delete", adminAuth, removeTemplate);

router.post("/brand-outreach/recipients", adminAuth, getBrandOutreachRecipientsForCompose);
router.post("/brand-outreach/send-selected", adminAuth, sendSelectedBrandOutreachEmailsController);
module.exports = router;