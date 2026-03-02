"use strict";

const cron = require("node-cron");
const { runReminderSweep } = require("./contractReminderWorker");

function startReminderCron() {
  // Every minute
  cron.schedule("* * * * *", async () => {
    try {
      await runReminderSweep();
    } catch (e) {
      console.error("[ReminderCron] sweep failed:", e);
    }
  });
}

module.exports = { startReminderCron };
