const express = require("express");
const router = express.Router();

const emailController = require("../controllers/emailController");
const emailInboundController = require("../controllers/emailInboundController");
const welcomeEmailController = require("../emails/wellcomeEmailController");

// Templates
router.get("/templates/:key", emailController.getTemplateByKey);

// Threads
router.post("/threads", emailController.createThread);
router.get("/threads/brand/:brandId", emailController.getThreadsForBrand);
router.get("/threads/influencer/:influencerId", emailController.getThreadsForInfluencer);
router.get("/messages/:threadId", emailController.getMessagesForThread);

// Sending
router.post("/brand-to-influencer", emailController.sendBrandToInfluencer);
router.post("/influencer-to-brand", emailController.sendInfluencerToBrand);

// Campaign invitation
router.post("/campaign-invitation", emailController.sendCampaignInvitation);
router.post("/campaign-invitation/preview", emailController.getCampaignInvitationPreview);

// Brand sidebar + inbox
router.get("/brand/contacts", emailController.getBrandContacts);
router.post("/brand/inbox", emailController.getBrandInbox);

// Invitation flow
router.post("/invitation", emailController.handleEmailInvitation);

// Inbound webhook (only if you still keep this route for non-SES testing)
router.post("/inbound", emailInboundController.handleInboundEmail);

// Influencer app conversations
router.get("/conversations", emailController.getConversationsForCurrentInfluencer);
router.get("/conversations/:id", emailController.getConversationForCurrentInfluencer);

// Welcome email
router.post("/send-welcome", welcomeEmailController.sendWelcomeEmail);

module.exports = router;