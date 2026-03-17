const { ROLES } = require("../models/master");

exports.allowRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!roles.includes(req.admin.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    next();
  };
};

exports.onlySuperAdmin = exports.allowRoles(ROLES.SUPER_ADMIN);
exports.superOrRevenueHead = exports.allowRoles(
  ROLES.SUPER_ADMIN,
  ROLES.REVENUE_HEAD
);