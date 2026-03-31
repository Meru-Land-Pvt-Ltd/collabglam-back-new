const {
  getMailboxScopeService,
  sendBulkEmailToCsv,
  listThreads,
  getThreadMessages,
  replyToThread,
  updateThreadService,
  composeManualEmailService,
  getPipelineRecipientsForComposeService,
  sendSelectedPipelineEmailsService,
  getBrandOutreachRecipientsForComposeService,
  sendSelectedBrandOutreachEmailsService,
} = require("../services/adminEmail.service");

function getLoggedInAdminId(req) {
  return (
    req.admin?.adminId ||
    req.admin?._id ||
    req.admin?.id ||
    req.user?._id ||
    req.user?.id ||
    null
  );
}

function assertAuth(req, res) {
  const adminId = getLoggedInAdminId(req);
  if (!adminId) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return null;
  }
  return adminId;
}

async function getMailboxScope(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const result = await getMailboxScopeService({ actorAdminId: adminId });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to fetch mailbox scope",
    });
  }
}

async function sendBulkCsv(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const csvBuffer = req.file?.buffer;
    const {
      subject,
      text,
      html,
      ownerAdminId,
      campaignId,
      pipelineIdByEmail,
      attachments,
    } = req.body;

    const result = await sendBulkEmailToCsv({
      adminId,
      csvBuffer,
      subject,
      text,
      html,
      campaignId,
      pipelineIdByEmail,
      ownerAdminId,
      attachments,
    });

    return res.status(200).json({
      success: true,
      message: "Bulk emails sent from CSV",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to send bulk emails from CSV",
    });
  }
}

async function composeEmail(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { ownerAdminId, to, cc, bcc, subject, text, html, attachments } = req.body;

    const result = await composeManualEmailService({
      actorAdminId: adminId,
      ownerAdminId,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      attachments,
    });

    return res.status(200).json({
      success: true,
      message: "Email sent successfully",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to send email",
    });
  }
}

async function getThreads(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const {
      page,
      limit,
      search,
      status,
      ownerAdminId,
      mailboxView,
      teamRole,
      revenueHeadId,
    } = req.query;

    const result = await listThreads({
      actorAdminId: adminId,
      page,
      limit,
      search,
      status,
      ownerAdminId,
      mailboxView,
      teamRole,
      revenueHeadId,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to fetch threads",
    });
  }
}

async function getMessages(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { threadId } = req.params;
    const result = await getThreadMessages({ threadId, actorAdminId: adminId });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error?.message || "Failed to fetch messages",
    });
  }
}

async function reply(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { threadId } = req.params;
    const { subject, text, html, cc, bcc, attachments } = req.body;

    const result = await replyToThread({
      threadId,
      actorAdminId: adminId,
      subject,
      text,
      html,
      cc,
      bcc,
      attachments,
    });

    return res.status(200).json({
      success: true,
      message: "Reply sent successfully",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to send reply",
    });
  }
}

async function updateThread(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { threadId } = req.params;
    const { subject, status, ownerAdminId } = req.body;

    const result = await updateThreadService({
      threadId,
      actorAdminId: adminId,
      subject,
      status,
      ownerAdminId,
    });

    return res.status(200).json({
      success: true,
      message: "Thread updated successfully",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to update thread",
    });
  }
}

async function getPipelineRecipientsForCompose(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { campaignId, pipelineIds } = req.body;

    const result = await getPipelineRecipientsForComposeService({
      actor: req.admin,
      actorAdminId: adminId,
      campaignId,
      pipelineIds,
    });

    return res.status(200).json({
      success: true,
      data: { items: result },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to fetch selected pipeline recipients",
    });
  }
}

async function sendSelectedPipelineEmailsController(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { campaignId, pipelineIds, subject, text, html, ownerAdminId, attachments } = req.body;

    const result = await sendSelectedPipelineEmailsService({
      actor: req.admin,
      actorAdminId: adminId,
      campaignId,
      pipelineIds,
      subject,
      text,
      html,
      ownerAdminId,
      attachments,
    });

    return res.status(200).json({
      success: true,
      message: "Selected pipeline emails sent successfully",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to send selected pipeline emails",
    });
  }
}

async function getBrandOutreachRecipientsForCompose(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { brandOutreachIds } = req.body;

    const result = await getBrandOutreachRecipientsForComposeService({
      actorAdminId: adminId,
      brandOutreachIds,
    });

    return res.status(200).json({
      success: true,
      data: { items: result },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to fetch selected brand outreach recipients",
    });
  }
}

async function sendSelectedBrandOutreachEmailsController(req, res) {
  try {
    const adminId = assertAuth(req, res);
    if (!adminId) return;

    const { brandOutreachIds, subject, text, html, ownerAdminId, attachments } = req.body;

    const result = await sendSelectedBrandOutreachEmailsService({
      actorAdminId: adminId,
      brandOutreachIds,
      subject,
      text,
      html,
      ownerAdminId,
      attachments,
    });

    return res.status(200).json({
      success: true,
      message: "Selected brand outreach emails sent successfully",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to send selected brand outreach emails",
    });
  }
}

module.exports = {
  getMailboxScope,
  sendBulkCsv,
  composeEmail,
  getThreads,
  getMessages,
  reply,
  updateThread,
  getPipelineRecipientsForCompose,
  sendSelectedPipelineEmailsController,
  getBrandOutreachRecipientsForCompose,
  sendSelectedBrandOutreachEmailsController,
};