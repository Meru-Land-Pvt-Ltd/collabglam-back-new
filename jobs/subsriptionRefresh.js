// jobs/subsriptionRefresh.js

const cron = require('node-cron');
const SubscriptionPlan = require('../models/subscription');
const Brand = require('../models/brand');
const Influencer = require('../models/influencer');
const subscriptionHelper = require('../utils/subscriptionHelper');

async function refreshSubscriptions() {
  const now = new Date();
  console.log(`🔄 subscriptionRefresh running at ${now.toISOString()}`);

  const autoPlans = await SubscriptionPlan.find({ autoRenew: true, status: 'active' })
    .select('planId')
    .lean();
  const autoIds = autoPlans.map(p => p.planId);

  for (const { Model, idField, role } of [
    { Model: Brand, idField: 'brandId', role: 'Brand' },
    { Model: Influencer, idField: 'influencerId', role: 'Influencer' }
  ]) {
    // A) Auto-renew free subscriptions once expired
    const renewUsers = await Model.find({
      'subscription.planId': { $in: autoIds },
      'subscription.expiresAt': { $lte: now }
    });

    for (const user of renewUsers) {
      const plan = await SubscriptionPlan.findOne({ planId: user.subscription.planId }).lean();
      if (!plan) continue;

      const start = now;
      const expire = subscriptionHelper.computeExpiry(plan, start);
      user.subscription.startedAt = start;
      user.subscription.expiresAt = expire;
      user.subscriptionExpired = false;
      await user.save();
      console.log(`🔁 Auto-renewed ${Model.modelName} ${user[idField]} until ${expire.toISOString()}`);
    }

    // B) Expire paid plans → downgrade to free/basic
    const expireUsers = await Model.find({
      'subscription.planId': { $nin: autoIds },
      'subscription.expiresAt': { $lte: now }
    });

    for (const user of expireUsers) {
      const freePlan = await subscriptionHelper.getFreePlan(role);
      if (!freePlan) {
        // If somehow no free plan, mark expired but don't crash
        user.subscriptionExpired = true;
        await user.save();
        console.warn(`⚠️ No free plan found for role ${role}; marked ${user[idField]} as expired`);
        continue;
      }

      const start = now;
      const newExpire = subscriptionHelper.computeExpiry(freePlan, start);

      user.subscription.planId = freePlan.planId;
      user.subscription.planName = freePlan.name;
      user.subscription.startedAt = start;
      user.subscription.expiresAt = newExpire;
      user.subscription.features = (freePlan.features || []).map(f => ({
        key: f.key,
        limit: typeof f.value === 'number' ? f.value : 0,
        used: 0
      }));
      user.subscriptionExpired = false;

      await user.save();
      console.log(`⬇️  Downgraded ${role} ${user[idField]} → free until ${newExpire.toISOString()}`);
    }
  }
}

// Every minute (Asia/Kolkata)
cron.schedule('* * * * *', () => {
  refreshSubscriptions().catch(err => console.error('Subscription refresh error:', err));
}, { timezone: 'Asia/Kolkata' });

module.exports = { refreshSubscriptions };
