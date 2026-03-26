const {
  listEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
} = require("../services/adminEmailTemplate.service");

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

function assertAdmin(req, res) {
  const adminId = getLoggedInAdminId(req);

  if (!adminId) {
    res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
    return null;
  }

  return adminId;
}

async function getTemplates(req, res) {
  try {
    const adminId = assertAdmin(req, res);
    if (!adminId) return;

    const data = await listEmailTemplates({
      actorAdminId: adminId,
    });

    return res.status(200).json({
      success: true,
      data: {
        items: data,
      },
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to fetch templates",
    });
  }
}

async function createTemplate(req, res) {
  try {
    const adminId = assertAdmin(req, res);
    if (!adminId) return;

    const { name, subject, body } = req.body;

    const data = await createEmailTemplate({
      actorAdminId: adminId,
      name,
      subject,
      body,
    });

    return res.status(200).json({
      success: true,
      message: "Template created successfully",
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to create template",
    });
  }
}

async function updateTemplate(req, res) {
  try {
    const adminId = assertAdmin(req, res);
    if (!adminId) return;

    const { templateId } = req.params;
    const { name, subject, body } = req.body;

    const data = await updateEmailTemplate({
      actorAdminId: adminId,
      templateId,
      name,
      subject,
      body,
    });

    return res.status(200).json({
      success: true,
      message: "Template updated successfully",
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to update template",
    });
  }
}

async function removeTemplate(req, res) {
  try {
    const adminId = assertAdmin(req, res);
    if (!adminId) return;

    const { templateId } = req.params;

    const data = await deleteEmailTemplate({
      actorAdminId: adminId,
      templateId,
    });

    return res.status(200).json({
      success: true,
      message: "Template deleted successfully",
      data,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error?.message || "Failed to delete template",
    });
  }
}

module.exports = {
  getTemplates,
  createTemplate,
  updateTemplate,
  removeTemplate,
};