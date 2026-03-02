const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const GridFSBucket = mongoose.mongo.GridFSBucket;
const { Types } = mongoose;
const http = require('http');
const path = require('path');
const { startReminderCron } = require("./services/reminderCron");

// routes
const influencerRoutes = require('./routes/influencerRoutes');
const countryRoutes = require('./routes/countryRoutes');
const brandRoutes = require('./routes/brandRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const audienceRoutes = require('./routes/audienceRoutes');
const applyCampaingRoutes = require('./routes/applyCampaingRoutes');
const contractRoutes = require('./routes/contractRoutes');
const milestoneRoutes = require('./routes/milestoneRoutes');
const subscriptionRoutes = require('./routes/subscriptionRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const chatRoutes = require('./routes/chatRoutes');
const adminRoutes = require('./routes/adminRoutes');
const policyRoutes = require('./routes/policyRoutes');
const contactRoutes = require('./routes/contactRoutes');
const faqsRoutes = require('./routes/faqsRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const platformRoutes = require('./routes/platformRoutes');
const audienceRangeRoutes = require('./routes/audiencerangeRoutes');
// const invitationRoutes = require('./routes/invitationRoutes');
const filtersRoutes = require('./routes/filterRoutes');
const mediaKitRoutes = require('./routes/mediaKitRoutes');
const modashRoutes = require('./routes/modashRoutes');
const languageRoutes = require('./routes/languageRoutes');
const businessRoutes = require('./routes/businessRoutes');
const unsubscribeRoutes = require('./routes/unsubscribeRoutes');
const disputeRoutes = require('./routes/disputeRoutes');
const notificationsRoutes = require('./routes/notificationsRoutes');
const emailRoutes = require('./routes/emailRoutes');
const Invitationsroutes = require('./routes/Invitationsroutes');
const unseenMessageNotifier = require('./jobs/unseenMessageNotifier');
const youtubeRoutes = require('./routes/youtubeRoutes');
const campaignInvitationRoutes = require('./routes/campaignInvitationRoutes');
 const delieverableRoutes = require('./routes/delieverableRoute')
// sockets (Socket.IO + native WS)
const sockets = require('./sockets');

const app = express();
const server = http.createServer(app);

// ====== Realtime setup (Socket.IO + native WS on /ws) ======
const io = sockets.init(server); // sets up socket.io AND ws://.../ws
app.set('io', io);
app.set('emitToBrand', sockets.emitToBrand);
app.set('emitToInfluencer', sockets.emitToInfluencer);
// This is what controllers call; it now broadcasts to BOTH transports.
app.set('broadcastToRoom', sockets.legacyBroadcastToRoom);

// ====== Express middleware ======
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || ['https://collabglam.com','http://localhost:3000','http://localhost:3001','https://mhd.sharemitra.com'],
  credentials: true
}));

const JSON_LIMIT = process.env.JSON_LIMIT || '30mb';
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_LIMIT, parameterLimit: 100000 }));

// Legacy static: serve any historical disk uploads if present
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ====== REST routes ======
app.use('/influencer', influencerRoutes);
app.use('/country', countryRoutes);
app.use('/brand', brandRoutes);
app.use('/campaign', campaignRoutes);
app.use('/category', categoryRoutes);
app.use('/audience', audienceRoutes);
app.use('/apply', applyCampaingRoutes);
app.use('/contract', contractRoutes);
app.use('/milestone', milestoneRoutes);
app.use('/subscription', subscriptionRoutes);
app.use('/chat', chatRoutes);
app.use('/payment', paymentRoutes);
app.use('/admin', adminRoutes);
app.use('/policy', policyRoutes);
app.use('/contact', contactRoutes);
app.use('/faqs', faqsRoutes);
app.use('/dash', dashboardRoutes);
app.use('/platform', platformRoutes);
app.use('/audienceRange', audienceRangeRoutes);
// app.use('/invitation', invitationRoutes);
app.use('/filters', filtersRoutes);
app.use('/media-kit', mediaKitRoutes);
app.use('/modash', modashRoutes);
app.use('/languages', languageRoutes);
app.use('/business', businessRoutes);
app.use('/unsubscribe', unsubscribeRoutes);
app.use('/dispute', disputeRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/emails', emailRoutes);
app.use('/newinvitations', Invitationsroutes);
app.use('/youtube', youtubeRoutes);
app.use('/admin-invitations', campaignInvitationRoutes);
app.use('/deliverable', delieverableRoutes);

// Friendly 413 response (must be after body parsers)
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ message: 'Payload too large. Reduce size or increase JSON_LIMIT.' });
  }
  return next(err);
});

/* Mongo & start */
const PORT = process.env.PORT || 5000;
startReminderCron();

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');

    // Init GridFS
    const bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    app.set('gridfsBucket', bucket);

    // Serve files from GridFS by filename
    app.get('/file/:filename', async (req, res) => {
      try {
        const filename = req.params.filename;
        const files = await bucket.find({ filename }).toArray();
        if (!files || files.length === 0) {
          return res.status(404).json({ message: 'File not found.' });
        }
        const doc = files[0];
        const contentType = doc.contentType || doc.metadata?.mimeType || 'application/octet-stream';

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');

        if (!/^image\//.test(contentType)) {
          const safe = encodeURIComponent(doc.metadata?.originalName || doc.filename);
          res.set('Content-Disposition', `attachment; filename*=UTF-8''${safe}`);
        } else {
          res.set('Content-Disposition', 'inline');
        }

        const stream = bucket.openDownloadStreamByName(filename);
        stream.on('error', (err) => {
          console.error('Error streaming file from GridFS:', err);
          return res.status(404).json({ message: 'File not found.' });
        });
        stream.pipe(res);
      } catch (err) {
        console.error('Error handling /file/:filename:', err);
        return res.status(500).json({ message: 'Internal server error' });
      }
    });

    // Serve files by ObjectId
    app.get('/file/id/:id', async (req, res) => {
      try {
        const id = req.params.id;
        let _id;
        try {
          _id = new Types.ObjectId(id);   // or: new mongoose.Types.ObjectId(id)
        } catch {
          return res.status(400).json({ message: 'Invalid file id.' });
        }
        const files = await bucket.find({ _id }).toArray();
        if (!files || files.length === 0) {
          return res.status(404).json({ message: 'File not found.' });
        }
        const doc = files[0];
        const contentType = doc.contentType || doc.metadata?.mimeType || 'application/octet-stream';

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');

        if (!/^image\//.test(contentType)) {
          const safe = encodeURIComponent(doc.metadata?.originalName || doc.filename);
          res.set('Content-Disposition', `attachment; filename*=UTF-8''${safe}`);
        } else {
          res.set('Content-Disposition', 'inline');
        }

        const stream = bucket.openDownloadStream(_id);
        stream.on('error', (err) => {
          console.error('Error streaming file from GridFS:', err);
          return res.status(404).json({ message: 'File not found.' });
        });
        stream.pipe(res);
      } catch (err) {
        console.error('Error handling /file/id/:id:', err);
        return res.status(500).json({ message: 'Internal server error' });
      }
    });

    // Start the unseen message notifier job
    unseenMessageNotifier.start();
    console.log('✅ Started unseen message notifier job');

    server.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  });

module.exports = app;
