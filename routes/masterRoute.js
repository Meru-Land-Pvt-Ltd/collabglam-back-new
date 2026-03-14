const express = require("express");
const router = express.Router();
const adminController = require("../controllers/masterController");
const { adminAuth } = require("../middlewares/adminAuth");
router.post("/login", adminController.adminLogin);
router.post("/invite", adminController.inviteAdmin);
router.post("/accept-invite", adminController.acceptInviteSetPassword);
router.get("/list", adminController.listAdmins);
router.put("/update-status", adminController.updateStatus);
router.get("/me",adminAuth, adminController.adminMe);

module.exports = router;