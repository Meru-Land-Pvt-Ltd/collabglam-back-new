// Load .env if dotenv is installed.
// If you start Node with --env-file, this fallback is harmless.
try {
  require("dotenv").config();
} catch (_) {}

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const path = require("path");

const { startReminderCron } = require("./services/reminderCron");
const unseenMessageNotifier = require("./jobs/unseenMessageNotifier");

// sockets
const sockets = require("./sockets");

// routes
const influencerRoutes = require("./routes/influencerRoutes");
const countryRoutes = require("./routes/countryRoutes");
const brandRoutes = require("./routes/brandRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const audienceRoutes = require("./routes/audienceRoutes");
const applyCampaingRoutes = require("./routes/applyCampaingRoutes");
const contractRoutes = require("./routes/contractRoutes");
const milestoneRoutes = require("./routes/milestoneRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const chatRoutes = require("./routes/chatRoutes");
const adminRoutes = require("./routes/adminRoutes");
const policyRoutes = require("./routes/policyRoutes");
const contactRoutes = require("./routes/contactRoutes");
const faqsRoutes = require("./routes/faqsRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const platformRoutes = require("./routes/platformRoutes");
const audienceRangeRoutes = require("./routes/audiencerangeRoutes");
const filtersRoutes = require("./routes/filterRoutes");
const mediaKitRoutes = require("./routes/mediaKitRoutes");
const modashRoutes = require("./routes/modashRoutes");
const languageRoutes = require("./routes/languageRoutes");
const businessRoutes = require("./routes/businessRoutes");
const unsubscribeRoutes = require("./routes/unsubscribeRoutes");
const disputeRoutes = require("./routes/disputeRoutes");
const notificationsRoutes = require("./routes/notificationsRoutes");
const emailRoutes = require("./routes/emailRoutes");
const Invitationsroutes = require("./routes/Invitationsroutes");
const youtubeRoutes = require("./routes/youtubeRoutes");
const campaignInvitationRoutes = require("./routes/campaignInvitationRoutes");
const delieverableRoutes = require("./routes/delieverableRoute");
const listRoutes = require("./routes/listRoutes");
const brandWalletRoutes = require("./routes/brandWalletRoutes");
const masterRoutes = require("./routes/masterRoute");
const supportRoutes = require("./routes/supportRoutes");
const timezoneRoutes = require("./routes/timezoneRoutes");
const adminEmailRoutes = require("./routes/adminEmailRoute");
const groupChatRoutes = require("./routes/groupChatRoutes");
const pipelineRoutes = require("./routes/influencerPipeline");
const brandOuteachRoutes = require("./routes/brandOutreachRoutes");
const brandNetworkRoutes = require("./routes/brandNetworkRoutes");

const app = express();
const server = http.createServer(app);

const GridFSBucket = mongoose.mongo.GridFSBucket;
const { Types } = mongoose;

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PROD = NODE_ENV === "production";

const PORT = Number(process.env.PORT || 8000);
const JSON_LIMIT = process.env.JSON_LIMIT || "30mb";
const GRIDFS_BUCKET_NAME = process.env.GRIDFS_BUCKET || "uploads";
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is missing.");
  process.exit(1);
}

function parseAllowedOrigins(value) {
  if (!value) {
    return [
      "https://collabglam.cloud",
      "https://www.collabglam.cloud",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://192.168.1.17:3000",
      "https://mhd.sharemitra.com",
    ];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins(process.env.FRONTEND_ORIGIN);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients like curl/Postman/server-to-server requests
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

/* =========================================================
   REALTIME SETUP
========================================================= */
const io = sockets.init(server);

app.set("trust proxy", 1);
app.set("io", io);
app.set("emitToBrand", sockets.emitToBrand);
app.set("emitToInfluencer", sockets.emitToInfluencer);
app.set("emitToAdmin", sockets.emitToAdmin);
app.set("broadcastToRoom", sockets.legacyBroadcastToRoom);
app.set("broadcastToGroupChatRoom", sockets.broadcastToGroupChatRoom);

/* =========================================================
   MIDDLEWARE
========================================================= */
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: JSON_LIMIT }));
app.use(
  express.urlencoded({
    extended: true,
    limit: JSON_LIMIT,
    parameterLimit: 100000,
  })
);

// serve legacy local uploads if any old files still exist
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// basic health route
app.get("/health", async (req, res) => {
  const readyState = mongoose.connection.readyState;

  return res.status(readyState === 1 ? 200 : 503).json({
    ok: readyState === 1,
    env: NODE_ENV,
    mongoState: readyState, // 0=disconnected,1=connected,2=connecting,3=disconnecting
    uptime: process.uptime(),
  });
});

/* =========================================================
   GRIDFS HELPERS
========================================================= */
function getGridFsBucket() {
  if (!mongoose.connection?.db) {
    throw new Error("MongoDB connection not ready");
  }

  return new GridFSBucket(mongoose.connection.db, {
    bucketName: GRIDFS_BUCKET_NAME,
  });
}

function setFileHeaders(res, doc) {
  const contentType =
    doc.contentType || doc.metadata?.mimeType || "application/octet-stream";

  res.set("Content-Type", contentType);
  res.set("Cache-Control", "public, max-age=31536000, immutable");

  if (!/^image\//.test(contentType)) {
    const safe = encodeURIComponent(doc.metadata?.originalName || doc.filename);
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${safe}`);
  } else {
    res.set("Content-Disposition", "inline");
  }
}

async function streamGridFsFileByFilename(req, res) {
  try {
    const { filename } = req.params;
    const bucket = getGridFsBucket();

    const files = await bucket.find({ filename }).limit(1).toArray();
    if (!files.length) {
      return res.status(404).json({ message: "File not found." });
    }

    const doc = files[0];
    setFileHeaders(res, doc);

    const stream = bucket.openDownloadStreamByName(filename);

    stream.on("error", (err) => {
      console.error("Error streaming file by filename:", err);
      if (!res.headersSent) {
        return res.status(404).json({ message: "File not found." });
      }
      res.end();
    });

    return stream.pipe(res);
  } catch (err) {
    console.error("Error handling /file/:filename:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function streamGridFsFileById(req, res) {
  try {
    const { id } = req.params;
    const bucket = getGridFsBucket();

    let _id;
    try {
      _id = new Types.ObjectId(id);
    } catch (_) {
      return res.status(400).json({ message: "Invalid file id." });
    }

    const files = await bucket.find({ _id }).limit(1).toArray();
    if (!files.length) {
      return res.status(404).json({ message: "File not found." });
    }

    const doc = files[0];
    setFileHeaders(res, doc);

    const stream = bucket.openDownloadStream(_id);

    stream.on("error", (err) => {
      console.error("Error streaming file by id:", err);
      if (!res.headersSent) {
        return res.status(404).json({ message: "File not found." });
      }
      res.end();
    });

    return stream.pipe(res);
  } catch (err) {
    console.error("Error handling /file/id/:id:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

/* =========================================================
   FILE ROUTES
========================================================= */
app.get("/file/:filename", streamGridFsFileByFilename);
app.get("/file/id/:id", streamGridFsFileById);

/* =========================================================
   API ROUTES
========================================================= */
[
  ["/influencer", influencerRoutes],
  ["/country", countryRoutes],
  ["/brand", brandRoutes],
  ["/campaign", campaignRoutes],
  ["/category", categoryRoutes],
  ["/audience", audienceRoutes],
  ["/apply", applyCampaingRoutes],
  ["/contract", contractRoutes],
  ["/milestone", milestoneRoutes],
  ["/subscription", subscriptionRoutes],
  ["/chat", chatRoutes],
  ["/payment", paymentRoutes],
  ["/admin", adminRoutes],
  ["/policy", policyRoutes],
  ["/contact", contactRoutes],
  ["/faqs", faqsRoutes],
  ["/dash", dashboardRoutes],
  ["/platform", platformRoutes],
  ["/audienceRange", audienceRangeRoutes],
  ["/filters", filtersRoutes],
  ["/media-kit", mediaKitRoutes],
  ["/modash", modashRoutes],
  ["/languages", languageRoutes],
  ["/business", businessRoutes],
  ["/unsubscribe", unsubscribeRoutes],
  ["/dispute", disputeRoutes],
  ["/notifications", notificationsRoutes],
  ["/emails", emailRoutes],
  ["/newinvitations", Invitationsroutes],
  ["/youtube", youtubeRoutes],
  ["/campaign-invitation", campaignInvitationRoutes],
  ["/deliverable", delieverableRoutes],
  ["/list", listRoutes],
  ["/wallet", brandWalletRoutes],
  ["/admins", masterRoutes],
  ["/support", supportRoutes],
  ["/timezone", timezoneRoutes],
  ["/admin-email", adminEmailRoutes],
  ["/group-chat", groupChatRoutes],
  ["/pipeline", pipelineRoutes],
  ["/brand-network", brandNetworkRoutes],
  ["/brand-outreach", brandOuteachRoutes],
].forEach(([route, handler]) => app.use(route, handler));

/* =========================================================
   NOT FOUND
========================================================= */
app.use((req, res) => {
  return res.status(404).json({
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

/* =========================================================
   ERROR HANDLERS
========================================================= */
app.use((err, req, res, next) => {
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({
      message: "Payload too large. Reduce size or increase JSON_LIMIT.",
    });
  }

  return next(err);
});

app.use((err, req, res, next) => {
  console.error("Unhandled application error:", err);

  if (res.headersSent) {
    return next(err);
  }

  if (err?.message?.startsWith("Not allowed by CORS")) {
    return res.status(403).json({ message: err.message });
  }

  return res.status(err.status || 500).json({
    message: err.message || "Internal server error",
  });
});

/* =========================================================
   STARTUP / SHUTDOWN
========================================================= */
async function bootstrap() {
  try {
    mongoose.connection.on("connected", () => {
      console.log("✅ MongoDB connected");
    });

    mongoose.connection.on("error", (error) => {
      console.error("❌ MongoDB runtime error:", error);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected");
    });

    await mongoose.connect(MONGODB_URI, {
      autoIndex: !IS_PROD,
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
      minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 5),
      serverSelectionTimeoutMS: Number(
        process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10000
      ),
      socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
    });

    const bucket = getGridFsBucket();
    app.set("gridfsBucket", bucket);

    startReminderCron();
    unseenMessageNotifier.start();

    server.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
      console.log(`🌍 Allowed origins: ${allowedOrigins.join(", ")}`);
    });
  } catch (err) {
    console.error("❌ Startup error:", err);
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  try {
    await mongoose.connection.close();
    server.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });

    setTimeout(() => {
      console.error("❌ Forced shutdown after timeout");
      process.exit(1);
    }, 10000).unref();
  } catch (err) {
    console.error("❌ Error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

bootstrap();

module.exports = app;