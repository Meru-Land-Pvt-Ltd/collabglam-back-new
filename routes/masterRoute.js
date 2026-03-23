const express = require("express");
const multer = require("multer");
const router = express.Router();

const adminController = require("../controllers/masterController");
const { adminAuth } = require("../middlewares/adminAuth");
const { superOrRevenueHead } = require("../middlewares/adminRoleGuard");

const upload = multer({ storage: multer.memoryStorage() });

router.post("/login", adminController.adminLogin);
router.post("/invite", adminAuth, superOrRevenueHead, adminController.inviteAdmin);
router.post("/accept-invite", adminController.acceptInviteSetPassword);
router.get("/list", adminAuth, adminController.listAdmins);
router.put("/update-status", adminAuth, adminController.updateStatus);
router.get("/me", adminAuth, adminController.adminMe);
router.post("/campaign/lite",adminController.getAllCampaignsLite);

router.post(
  "/send-bulk-csv",
  adminAuth,
  upload.single("file"),
  adminController.sendBulkEmailCsv
);

module.exports = router;