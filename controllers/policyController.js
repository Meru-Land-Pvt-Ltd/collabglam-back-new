// controllers/policyController.js

const Policy = require('../models/policy');

/**
 * Create a new policy
 * POST /api/policy/create
 * Body: { policyType, effectiveDate, content }
 */
exports.createPolicy = async (req, res) => {
  try {
    const { policyType, effectiveDate, content } = req.body;
    const existing = await Policy.findOne({ policyType });
    if (existing) {
      return res.status(400).json({ error: 'Policy type already exists' });
    }
    const policy = new Policy({ policyType, effectiveDate, content });
    await policy.save();
    return res.status(201).json(policy);
  } catch (err) {
    console.error('createPolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Update an existing policy
 * POST /api/policy/update
 * Body: { policyType, effectiveDate?, content? }
 */
exports.updatePolicy = async (req, res) => {
  try {
    const { policyType, effectiveDate, content } = req.body;
    const update = {};
    if (effectiveDate) update.effectiveDate = effectiveDate;
    if (content) update.content = content;
    const policy = await Policy.findOneAndUpdate(
      { policyType },
      { $set: update },
      { new: true }
    );
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    return res.json(policy);
  } catch (err) {
    console.error('updatePolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Delete a policy
 * POST /api/policy/delete
 * Body: { policyType }
 */
exports.deletePolicy = async (req, res) => {
  try {
    const { policyType } = req.body;
    const result = await Policy.findOneAndDelete({ policyType });
    if (!result) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    return res.json({ message: 'Policy deleted' });
  } catch (err) {
    console.error('deletePolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Retrieve a policy
 * POST /api/policy/get
 * Body: { policyType }
 */
exports.getPolicy = async (req, res) => {
  try {
    const { policyType } = req.body;
    const policy = await Policy.findOne({ policyType });
    if (!policy) {
      return res.status(404).json({ error: 'Policy not found' });
    }
    return res.json(policy);
  } catch (err) {
    console.error('getPolicy error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
