const {
  sendBulkEmailToCsv,
  listThreads,
  getThreadMessages,
  replyToThread,
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

async function sendBulkCsv(req, res) {
  try {
    const csvBuffer = req.file?.buffer;
    const adminId = getLoggedInAdminId(req);
    const { subject, text, html } = req.body;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const result = await sendBulkEmailToCsv({
      adminId,
      csvBuffer,
      subject,
      text,
      html,
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

async function getThreads(req, res) {
  try {
    const adminId = getLoggedInAdminId(req);
    const { page, limit } = req.query;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const result = await listThreads({
      executiveId: adminId,
      page,
      limit,
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to fetch threads",
    });
  }
}

async function getMessages(req, res) {
  try {
    const adminId = getLoggedInAdminId(req);
    const { threadId } = req.params;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const result = await getThreadMessages(threadId, adminId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      message: error?.message || "Failed to fetch messages",
    });
  }
}

async function reply(req, res) {
  try {
    const adminId = getLoggedInAdminId(req);
    const { threadId } = req.params;
    const { subject, text, html } = req.body;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const result = await replyToThread({
      threadId,
      executiveId: adminId,
      subject,
      text,
      html,
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

module.exports = {
  sendBulkCsv,
  getThreads,
  getMessages,
  reply,
};