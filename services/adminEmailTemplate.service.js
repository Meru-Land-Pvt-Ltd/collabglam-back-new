const mongoose = require("mongoose");
const AdminEmailTemplateModel = require("../models/adminEmailTemplate");
const { ROLES } = require("../models/master");
const { getActorAdmin } = require("../utils/adminEmailAccess");
const { cleanStr, toObjectIdStrict } = require("../utils/emailThread.util");

function resolveTreeAdminId(actor) {
  if (actor.role === ROLES.REVENUE_HEAD) return actor._id;
  if ([ROLES.IME, ROLES.BME].includes(actor.role)) {
    return actor.parentAdmin || actor.rootAdmin || null;
  }
  return null;
}

function getCreateVisibility(actor) {
  if (actor.role === ROLES.SUPER_ADMIN) return "GLOBAL";
  if (actor.role === ROLES.REVENUE_HEAD) return "TREE";
  if ([ROLES.IME, ROLES.BME].includes(actor.role)) return "PERSONAL";
  throw new Error("Unsupported admin role");
}

function getListFilter(actor) {
  if (actor.role === ROLES.SUPER_ADMIN) {
    return { status: "ACTIVE" };
  }

  if (actor.role === ROLES.REVENUE_HEAD) {
    return {
      status: "ACTIVE",
      $or: [
        { visibility: "GLOBAL" },
        { visibility: "TREE", treeAdminId: actor._id },
        { visibility: "PERSONAL", ownerAdminId: actor._id },
      ],
    };
  }

  if ([ROLES.IME, ROLES.BME].includes(actor.role)) {
    const treeAdminId = resolveTreeAdminId(actor);

    return {
      status: "ACTIVE",
      $or: [
        { visibility: "GLOBAL" },
        ...(treeAdminId
          ? [{ visibility: "TREE", treeAdminId }]
          : []),
        { visibility: "PERSONAL", ownerAdminId: actor._id },
      ],
    };
  }

  throw new Error("Unsupported admin role");
}

function canManageTemplate(actor, template) {
  if (actor.role === ROLES.SUPER_ADMIN) {
    return true;
  }

  if (actor.role === ROLES.REVENUE_HEAD) {
    return (
      template.visibility === "TREE" &&
      String(template.treeAdminId || "") === String(actor._id)
    );
  }

  if ([ROLES.IME, ROLES.BME].includes(actor.role)) {
    return (
      template.visibility === "PERSONAL" &&
      String(template.ownerAdminId || "") === String(actor._id)
    );
  }

  return false;
}

function sortTemplates(items) {
  const rank = {
    GLOBAL: 1,
    TREE: 2,
    PERSONAL: 3,
  };

  return [...items].sort((a, b) => {
    const visibilityDiff = (rank[a.visibility] || 99) - (rank[b.visibility] || 99);
    if (visibilityDiff !== 0) return visibilityDiff;
    return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
  });
}

async function listEmailTemplates({ actorAdminId }) {
  const actor = await getActorAdmin(actorAdminId);

  const items = await AdminEmailTemplateModel.find(getListFilter(actor))
    .populate("createdByAdminId", "name email role")
    .lean();

  return sortTemplates(items);
}

async function createEmailTemplate({ actorAdminId, name, subject, body }) {
  const actor = await getActorAdmin(actorAdminId);

  const visibility = getCreateVisibility(actor);

  const payload = {
    name: cleanStr(name),
    subject: cleanStr(subject),
    body: body || "",
    visibility,
    createdByAdminId: actor._id,
    updatedByAdminId: actor._id,
    createdByRole: actor.role,
  };

  if (!payload.name) {
    throw new Error("Template name is required");
  }

  if (visibility === "GLOBAL") {
    payload.ownerAdminId = actor._id;
    payload.treeAdminId = null;
  }

  if (visibility === "TREE") {
    payload.ownerAdminId = actor._id;
    payload.treeAdminId = actor._id;
  }

  if (visibility === "PERSONAL") {
    payload.ownerAdminId = actor._id;
    payload.treeAdminId = resolveTreeAdminId(actor);
  }

  const template = await AdminEmailTemplateModel.create(payload);

  return AdminEmailTemplateModel.findById(template._id)
    .populate("createdByAdminId", "name email role")
    .lean();
}

async function updateEmailTemplate({
  actorAdminId,
  templateId,
  name,
  subject,
  body,
}) {
  const actor = await getActorAdmin(actorAdminId);
  const tid = toObjectIdStrict(templateId, "templateId");

  const template = await AdminEmailTemplateModel.findById(tid);
  if (!template || template.status !== "ACTIVE") {
    throw new Error("Template not found");
  }

  if (!canManageTemplate(actor, template)) {
    throw new Error("You are not allowed to update this template");
  }

  if (name != null) template.name = cleanStr(name);
  if (subject != null) template.subject = cleanStr(subject);
  if (body != null) template.body = body;
  template.updatedByAdminId = actor._id;

  if (!template.name) {
    throw new Error("Template name is required");
  }

  await template.save();

  return AdminEmailTemplateModel.findById(template._id)
    .populate("createdByAdminId", "name email role")
    .lean();
}

async function deleteEmailTemplate({ actorAdminId, templateId }) {
  const actor = await getActorAdmin(actorAdminId);
  const tid = toObjectIdStrict(templateId, "templateId");

  const template = await AdminEmailTemplateModel.findById(tid);
  if (!template || template.status !== "ACTIVE") {
    throw new Error("Template not found");
  }

  if (!canManageTemplate(actor, template)) {
    throw new Error("You are not allowed to delete this template");
  }

  template.status = "ARCHIVED";
  template.updatedByAdminId = actor._id;
  await template.save();

  return {
    deleted: true,
    templateId: String(template._id),
  };
}

module.exports = {
  listEmailTemplates,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
};