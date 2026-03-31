const cron = require("node-cron");
const subscriptionController = require("../controllers/subscriptionController");

function mockRes(label) {
  return {
    status(code) {
      return {
        json(payload) {
          console.log(`[${label}]`, code, payload);
        },
      };
    },
    json(payload) {
      console.log(`[${label}]`, 200, payload);
    },
  };
}

function mockReq(body = {}) {
  return { body };
}

function startSubscriptionEmailJobs() {
  // every hour -> warn about expiring in next 48 hours
  cron.schedule("0 * * * *", async () => {
    await subscriptionController.sendExpiringSoonEmails(
      mockReq({ withinHours: 48 }),
      mockRes("sendExpiringSoonEmails")
    );
  });

  // every hour -> send expired emails
  cron.schedule("10 * * * *", async () => {
    await subscriptionController.sendExpiredSubscriptionEmails(
      mockReq({}),
      mockRes("sendExpiredSubscriptionEmails")
    );
  });
}

module.exports = { startSubscriptionEmailJobs };