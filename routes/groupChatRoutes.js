// routes/groupChatRoutes.js
const express = require("express");
const router = express.Router();
const groupChat = require("../controllers/groupChatController");

router.post("/create", groupChat.createGroup);
router.post("/update", groupChat.updateGroup);

router.post("/groups", groupChat.getMyGroups);
router.post("/messages", groupChat.getMessages);

router.post("/send", groupChat.postMessage);
router.post("/send-file", groupChat.postFileMessage);

router.patch("/edit", groupChat.editMessage);
router.delete("/message", groupChat.deleteMessage);

router.post("/mark-seen", groupChat.markAsSeen);
router.post("/unseen-count", groupChat.getUnseenCount);

router.get("/attachment/:groupId/:attachmentId", groupChat.streamAttachment);
router.get("/file/:filename", groupChat.streamGridFsFile);
router.post("/eligible-revenue-heads", groupChat.getEligibleRevenueHeads);
router.post("/eligible-members", groupChat.getEligibleMembers);
router.post("/group-manage-meta", groupChat.getGroupManageMeta);

module.exports = router;