const express = require("express");
const multer = require("multer");
const {
  sendBulkCsv,
  getThreads,
  getMessages,
  reply,
} = require("../controllers/adminEmailController");
const { adminAuth } = require("../middlewares/adminAuth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/bulk/csv", adminAuth, upload.single("file"), sendBulkCsv);
router.get("/threads", adminAuth, getThreads);
router.get("/threads/:threadId/messages", adminAuth, getMessages);
router.post("/threads/:threadId/reply", adminAuth, reply);

module.exports = router;