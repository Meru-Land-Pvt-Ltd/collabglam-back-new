const jwt = require("jsonwebtoken");

// Accepts either Brand token or Admin token (same Authorization header)
exports.verifyBrandOrAdmin = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(403).json({ message: "Token required" });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(403).json({ message: "Token required" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: "Invalid or expired token" });

    // Decide role by payload keys (based on your login payloads)
    if (decoded.adminId) {
      req.admin = decoded;
      req.authRole = "admin";
      return next();
    }

    if (decoded.brandId) {
      req.brand = decoded;
      req.authRole = "brand";
      return next();
    }

    return res.status(403).json({ message: "Invalid token role" });
  });
};