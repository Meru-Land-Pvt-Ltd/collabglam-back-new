const mongoose = require("mongoose");
const { AdminModel, ROLES } = require("../models/master");

function getActorId(actor) {
  return actor?._id || actor?.adminId || null;
}

async function getDescendantAdminIds(adminId) {
  const startId = String(adminId);
  const visited = new Set();
  const result = [];
  let queue = [startId];

  while (queue.length) {
    const parentIds = queue.map((id) => new mongoose.Types.ObjectId(id));

    const children = await AdminModel.find({
      parentAdmin: { $in: parentIds },
    }).select("_id");

    queue = [];

    for (const child of children) {
      const id = String(child._id);
      if (!visited.has(id)) {
        visited.add(id);
        result.push(id);
        queue.push(id);
      }
    }
  }

  return result;
}

async function buildAdminVisibilityFilter(actor) {
  const actorId = getActorId(actor);

  if (!actorId) {
    return { _id: null };
  }

  if (String(actor.role || "").toLowerCase() === ROLES.SUPER_ADMIN) {
    return {};
  }

  if (String(actor.role || "").toLowerCase() === ROLES.REVENUE_HEAD) {
    const descendants = await getDescendantAdminIds(actorId);
    return {
      _id: {
        $in: [actorId, ...descendants],
      },
    };
  }

  return { _id: actorId };
}

async function canManageTarget(actor, targetAdminId) {
  const actorId = getActorId(actor);

  if (!actorId || !targetAdminId) return false;

  if (String(actorId) === String(targetAdminId)) return true;

  if (String(actor.role || "").toLowerCase() === ROLES.SUPER_ADMIN) {
    return true;
  }

  if (String(actor.role || "").toLowerCase() === ROLES.REVENUE_HEAD) {
    const descendants = await getDescendantAdminIds(actorId);
    return descendants.includes(String(targetAdminId));
  }

  return false;
}

function canInviteRole(inviterRole, targetRole) {
  const inviter = String(inviterRole || "").toLowerCase();
  const target = String(targetRole || "").toLowerCase();

  if (inviter === ROLES.SUPER_ADMIN) {
    return [
      ROLES.SUPER_ADMIN,
      ROLES.REVENUE_HEAD,
      ROLES.IME,
      ROLES.BME,
    ].includes(target);
  }

  if (inviter === ROLES.REVENUE_HEAD) {
    return [ROLES.IME, ROLES.BME].includes(target);
  }

  return false;
}

module.exports = {
  canInviteRole,
  buildAdminVisibilityFilter,
  canManageTarget,
  getDescendantAdminIds,
};