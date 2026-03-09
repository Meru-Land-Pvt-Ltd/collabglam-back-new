const jwt = require("jsonwebtoken");

const influencerAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Authorization token missing" });
    }

    const token = authHeader.split(" ")[1]?.trim();

    if (!token) {
      return res.status(401).json({ message: "Authorization token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded || !decoded.influencerId) {
      return res.status(401).json({ message: "Invalid token payload" });
    }

    if (decoded.role !== "influencer") {
      return res.status(403).json({ message: "Invalid role" });
    }

    req.user = {
      influencerId: decoded.influencerId,
      role: decoded.role,
      email: decoded.email || null,
      iat: decoded.iat,
      exp: decoded.exp,
    };

    next();
  } catch (error) {
    console.error("influencerAuth error:", error);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token" });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = { influencerAuth };