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
router.get("/fully-managed-brand-list", adminAuth, adminController.fullyManagedBrandList);
router.post("/assign-brand", adminAuth, superOrRevenueHead, adminController.assignBrand);
router.put("/update-status", adminAuth, superOrRevenueHead, adminController.updateBrandAssignment);
router.put("/update-rhId", adminAuth, superOrRevenueHead, adminController.updateBrandAssignmentStatusAndRH);
router.get("/get-executive-list", adminAuth, adminController.listExecutiveAdmin);
router.get("/get-rm-list", adminAuth, adminController.rmlist);
router.get("/get-brand-list", adminAuth, adminController.allocateBrand);
router.get('/campaign/list', adminAuth, adminController.listCampaignsForAdmin);

router.post(
  "/send-bulk-csv",
  adminAuth,
  upload.single("file"),
  adminController.sendBulkEmailCsv
);

module.exports = router;