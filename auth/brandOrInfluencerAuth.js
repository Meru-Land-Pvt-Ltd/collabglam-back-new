const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = function brandOrInfluencerAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(403).json({ message: "Token required" });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded || !decoded.role) {
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    // common
    req.user = decoded;

    // allow both roles
    if (decoded.role === "brand") {
      req.brand = decoded;
      return next();
    }

    if (decoded.role === "influencer") {
      req.influencer = decoded;
      return next();
    }

    return res.status(403).json({ message: "Invalid role" });
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
};