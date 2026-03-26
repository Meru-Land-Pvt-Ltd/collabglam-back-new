const { AdminModel, ROLES } = require("../models/master");
const { toObjectIdStrict } = require("./emailThread.util");

const SUPPORTED_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.REVENUE_HEAD,
  ROLES.IME,
  ROLES.BME,
];

function normalizeAdminId(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  return input.adminId || input._id || input.id || null;
}

async function getActorAdmin(actorOrId) {
  const rawId = normalizeAdminId(actorOrId);
  const adminId = toObjectIdStrict(rawId, "actorAdminId");

  const actor = await AdminModel.findById(adminId)
    .select("_id name email proxyEmail proxyemail role status parentAdmin rootAdmin")
    .lean();

  if (!actor) throw new Error("Admin not found");
  if (!SUPPORTED_ROLES.includes(actor.role)) throw new Error("Unsupported admin role");
  if (String(actor.status || "").toLowerCase() !== "active") {
    throw new Error("Admin account is not active");
  }

  return actor;
}

async function getActorScope(actorOrId) {
  const actor = await getActorAdmin(actorOrId);

  if (actor.role === ROLES.SUPER_ADMIN) {
    return {
      actor,
      type: "ALL",
      adminIds: null,
      canCompose: true,
      canReply: true,
      canEditThread: true,
    };
  }

  if (actor.role === ROLES.REVENUE_HEAD) {
    const children = await AdminModel.find({
      status: "active",
      role: { $in: [ROLES.IME, ROLES.BME] },
      $or: [{ parentAdmin: actor._id }, { rootAdmin: actor._id }],
    })
      .select("_id")
      .lean();

    const dedupMap = new Map();
    [actor._id, ...children.map((x) => x._id)].forEach((id) => {
      dedupMap.set(String(id), id);
    });

    return {
      actor,
      type: "TREE",
      adminIds: Array.from(dedupMap.values()),
      canCompose: true,
      canReply: true,
      canEditThread: true,
    };
  }

  return {
    actor,
    type: "SELF",
    adminIds: [actor._id],
    canCompose: true,
    canReply: true,
    canEditThread: true,
  };
}

function buildThreadScopeFilter(scope, extra = {}) {
  if (scope.adminIds === null) return { ...extra };
  return {
    ...extra,
    executiveId: { $in: scope.adminIds },
  };
}

function extractComparableAdminId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value._id || value.adminId || value.id || null;
  }
  return null;
}

function isAdminIdInScope(scope, adminId) {
  if (scope.adminIds === null) return true;

  const targetId = extractComparableAdminId(adminId);
  if (!targetId) return false;

  return scope.adminIds.some((id) => String(id) === String(targetId));
}

async function assertThreadScope(thread, actorOrId) {
  const scope = await getActorScope(actorOrId);

  if (!thread?.executiveId) {
    throw new Error("Thread executiveId is missing");
  }

  if (!isAdminIdInScope(scope, thread.executiveId)) {
    throw new Error("You are not allowed to access this thread");
  }

  return scope;
}

async function assertOwnerAssignable(actorOrId, ownerAdminId) {
  const scope = await getActorScope(actorOrId);
  const ownerId = toObjectIdStrict(ownerAdminId, "ownerAdminId");

  if (!isAdminIdInScope(scope, ownerId)) {
    throw new Error("You are not allowed to assign or send for this admin");
  }

  return ownerId;
}

module.exports = {
  SUPPORTED_ROLES,
  getActorAdmin,
  getActorScope,
  buildThreadScopeFilter,
  isAdminIdInScope,
  assertThreadScope,
  assertOwnerAssignable,
};